import { describe, it, expect } from 'vitest'
import { detectRolls, isSpreadCode, pickOpenLegs, type RollDetectGroup, type RollDetectOpen } from '@/lib/roll-detection'

// Hand-verified from the 9/03 StoneX statement: the DEC 26 corn 14-lot short
// (entered 4.9525) closed @ 5.435 and a MAR 27 14-lot short opened @ 5.585
// the same day, both Confirmation legs carrying the SE spread code.
//   realized on the close = (4.9525 − 5.435) × 14 × 5,000 = −33,775.00
//   roll spread           = 5.585 − 5.435 = +0.15 /bu

const DEC_CLOSE: RollDetectGroup = {
  key: 'g0',
  commodity: 'Corn', contract_month: 'DEC 26', side: 'short',
  close_date: '2026-09-03', close_price: 5.435, close_execution_code: 'SE',
  lots: [{ contracts: 14, open_price: 4.9525, open_date: '2026-04-15', matchedOpenId: 'dec-14', heldContracts: 14, alreadyImported: false, crop_year: 2026 }],
}
const MAR_OPEN: RollDetectOpen = {
  key: 'o0', commodity: 'Corn', contract_month: 'MAR 27', side: 'short',
  num_contracts: 14, trade_date: '2026-09-03', trade_price: 5.585, execution_code: 'SE',
}

describe('isSpreadCode — the statement trade-code vocabulary', () => {
  it('S and SE are spreads; E (electronic) and blanks are not', () => {
    expect(isSpreadCode('S')).toBe(true)
    expect(isSpreadCode('SE')).toBe(true)
    expect(isSpreadCode(' se ')).toBe(true)
    expect(isSpreadCode('E')).toBe(false)
    expect(isSpreadCode('')).toBe(false)
    expect(isSpreadCode(null)).toBe(false)
  })
})

describe('detectRolls — the 9/03 shape', () => {
  it('closed group + same-day same-side same-count new month with SE → high-confidence roll, crop year inherited', () => {
    const [r] = detectRolls([DEC_CLOSE], [MAR_OPEN])
    expect(r).toBeDefined()
    expect(r.fromMonth).toBe('DEC 26')
    expect(r.toMonth).toBe('MAR 27')
    expect(r.date).toBe('2026-09-03')
    expect(r.closedContracts).toBe(14)
    expect(r.openContracts).toBe(14)
    expect(r.closePrice).toBe(5.435)
    expect(r.openPrice).toBe(5.585)
    expect(r.spreadPerUnit).toBeCloseTo(0.15, 6)
    expect(r.spreadCode).toBe(true)
    expect(r.partial).toBe(false)
    expect(r.countMismatch).toBe(false)
    expect(r.confidence).toBe('high')
    expect(r.defaultOn).toBe(true)
    expect(r.inheritedCropYear).toBe(2026) // from the matched DEC position — never re-asked
    expect(r.closedAlreadyRecorded).toBe(false)
    expect(r.openAlreadyRecorded).toBe(false)
  })

  it('the spread code on the CLOSE leg alone is enough', () => {
    const [r] = detectRolls([DEC_CLOSE], [{ ...MAR_OPEN, execution_code: null }])
    expect(r.spreadCode).toBe(true)
    expect(r.confidence).toBe('high')
  })

  it('non-spread roll (separate close and open the same day, no code) → medium, still on by default', () => {
    const [r] = detectRolls([{ ...DEC_CLOSE, close_execution_code: null }], [{ ...MAR_OPEN, execution_code: 'E' }])
    expect(r.spreadCode).toBe(false)
    expect(r.confidence).toBe('medium')
    expect(r.defaultOn).toBe(true)
    expect(r.reasons.join(' ')).toMatch(/no spread code/)
  })

  it('partial roll (14 rolled of 20 held) → medium with the partial flag', () => {
    const group: RollDetectGroup = { ...DEC_CLOSE, lots: [{ ...DEC_CLOSE.lots[0], heldContracts: 20 }] }
    const [r] = detectRolls([group], [MAR_OPEN])
    expect(r.partial).toBe(true)
    expect(r.confidence).toBe('medium')
    expect(r.defaultOn).toBe(true)
    expect(r.reasons).toContain('fewer lots rolled than held')
  })

  it('contract counts that differ (closed 14, opened 10) → low confidence, off by default', () => {
    const [r] = detectRolls([DEC_CLOSE], [{ ...MAR_OPEN, num_contracts: 10 }])
    expect(r.countMismatch).toBe(true)
    expect(r.confidence).toBe('low')
    expect(r.defaultOn).toBe(false)
  })

  it('prefers the exact-count open when several same-day fills exist', () => {
    const twelve: RollDetectOpen = { ...MAR_OPEN, key: 'o12', num_contracts: 12, trade_price: 5.4825, execution_code: 'E' }
    const [r] = detectRolls([DEC_CLOSE], [twelve, MAR_OPEN])
    expect(r.openKey).toBe('o0')
    expect(detectRolls([DEC_CLOSE], [twelve, MAR_OPEN])).toHaveLength(1)
  })

  it('is NOT a roll when the open is a different day, the same month, a different side, or a different commodity', () => {
    expect(detectRolls([DEC_CLOSE], [{ ...MAR_OPEN, trade_date: '2026-09-11' }])).toHaveLength(0)
    expect(detectRolls([DEC_CLOSE], [{ ...MAR_OPEN, contract_month: 'DEC 26' }])).toHaveLength(0)
    expect(detectRolls([DEC_CLOSE], [{ ...MAR_OPEN, side: 'long' }])).toHaveLength(0)
    expect(detectRolls([DEC_CLOSE], [{ ...MAR_OPEN, commodity: 'Soybeans' }])).toHaveLength(0)
  })

  it('date forms normalize: a "9/03/6" statement date pairs with 2026-09-03', () => {
    const [r] = detectRolls([{ ...DEC_CLOSE, close_date: '9/03/6' }], [MAR_OPEN])
    expect(r).toBeDefined()
    expect(r.date).toBe('2026-09-03')
  })

  it('a re-import after the repair: both legs already recorded → link-only flags', () => {
    const group: RollDetectGroup = { ...DEC_CLOSE, lots: [{ ...DEC_CLOSE.lots[0], matchedOpenId: null, alreadyImported: true }] }
    const [r] = detectRolls([group], [{ ...MAR_OPEN, existingId: 'mar-14' }])
    expect(r.closedAlreadyRecorded).toBe(true)
    expect(r.openAlreadyRecorded).toBe(true)
  })

  it('each open pairs with at most one group', () => {
    const g2: RollDetectGroup = { ...DEC_CLOSE, key: 'g1', contract_month: 'SEP 26' }
    const rolls = detectRolls([DEC_CLOSE, g2], [MAR_OPEN])
    expect(rolls).toHaveLength(1)
  })
})

// ---------- 10/12: a roll whose new month is SEVERAL fills ----------
// 23 DEC 26 cotton shorts (10 @ 72.65 + 13 @ 84.40) bought back @ 80.45739
// and MAR 27 sold the same day as 3 @ 83.63, 12 @ 83.64, 3 @ 83.65,
// 3 @ 83.67 and 2 @ 83.68 — every fill SE. The open leg is all five.

const DEC_COTTON: RollDetectGroup = {
  key: 'g0',
  commodity: 'Cotton', contract_month: 'DEC 26', side: 'short',
  close_date: '2026-10-12', close_price: 80.4573913, close_execution_code: 'SE',
  lots: [
    { contracts: 10, open_price: 72.65, open_date: '2026-03-18', matchedOpenId: 'dec-10', heldContracts: 10, alreadyImported: false, crop_year: 2026 },
    { contracts: 13, open_price: 84.4, open_date: '2026-08-10', matchedOpenId: 'dec-13', heldContracts: 13, alreadyImported: false, crop_year: 2026 },
  ],
}
const MAR_FILLS: RollDetectOpen[] = ([[3, 83.63], [12, 83.64], [3, 83.65], [3, 83.67], [2, 83.68]] as const).map(([n, px], i) => ({
  key: `o${i}`, commodity: 'Cotton', contract_month: 'MAR 27', side: 'short', num_contracts: n, trade_date: '2026-10-12', trade_price: px, execution_code: 'SE',
}))

describe('detectRolls — several fills make up the new month (10/12 cotton)', () => {
  it('the open leg is every MAR fill, summing exactly to the 23 closed; one roll, high confidence', () => {
    const rolls = detectRolls([DEC_COTTON], MAR_FILLS)
    expect(rolls).toHaveLength(1)
    const [r] = rolls
    expect(r.openKeys).toEqual(['o0', 'o1', 'o2', 'o3', 'o4'])
    expect(r.openKey).toBe('o0')
    expect(r.closedContracts).toBe(23)
    expect(r.openContracts).toBe(23)
    expect(r.openPrice).toBeCloseTo(83.6473913, 7)
    expect(r.spreadPerUnit).toBeCloseTo(3.19, 5)
    expect(r.confidence).toBe('high')
    expect(r.countMismatch).toBe(false)
    expect(r.reasons).toContain('5 fills make up the new month')
    expect(r.alreadyRecorded).toBe(false)
  })

  it('an unrelated same-day fill in the new month is left out when the rest sum exactly', () => {
    const extra: RollDetectOpen = { ...MAR_FILLS[0], key: 'o9', num_contracts: 4, trade_price: 83.7, execution_code: 'E' }
    const [r] = detectRolls([DEC_COTTON], [extra, ...MAR_FILLS])
    expect(r.openKeys).toEqual(['o0', 'o1', 'o2', 'o3', 'o4'])
    expect(r.openContracts).toBe(23)
  })

  it('pickOpenLegs: single exact spread fill first, then the spread set, then the whole month, then an exact subset', () => {
    const o = (key: string, n: number, code: string | null): RollDetectOpen => ({ key, commodity: 'Corn', contract_month: 'MAR 27', side: 'short', num_contracts: n, trade_date: '2026-09-03', trade_price: 5.5, execution_code: code })
    expect(pickOpenLegs([o('a', 10, 'E'), o('b', 14, 'SE')], 14)!.map((x) => x.key)).toEqual(['b'])
    expect(pickOpenLegs([o('a', 10, 'SE'), o('b', 4, 'SE'), o('c', 14, 'E')], 14)!.map((x) => x.key)).toEqual(['a', 'b'])
    expect(pickOpenLegs([o('a', 10, 'E'), o('b', 4, 'E')], 14)!.map((x) => x.key)).toEqual(['a', 'b'])
    expect(pickOpenLegs([o('a', 10, 'E'), o('b', 4, 'E'), o('c', 6, 'E')], 10)!.map((x) => x.key)).toEqual(['a'])
    expect(pickOpenLegs([o('a', 3, 'E'), o('b', 8, 'E'), o('c', 6, 'E')], 9)!.map((x) => x.key)).toEqual(['a', 'c'])
    expect(pickOpenLegs([o('a', 3, 'E'), o('b', 8, 'E')], 9)).toBeNull()
  })

  it('a roll already in the app (closed legs recorded, every open leg stored in a roll group) is "already recorded", off by default', () => {
    const recorded: RollDetectGroup = { ...DEC_COTTON, lots: DEC_COTTON.lots.map((l) => ({ ...l, matchedOpenId: null, alreadyImported: true })) }
    const stored = MAR_FILLS.map((f, i) => ({ ...f, existingId: `mar-${i}`, existingRollGroupId: 'rg1' }))
    const [r] = detectRolls([recorded], stored)
    expect(r.alreadyRecorded).toBe(true)
    expect(r.defaultOn).toBe(false)
    expect(r.reasons).toContain('already recorded in Turnrow')
    // Stored but NOT in a roll group (production after the 10/13 import: four
    // plain opens beside the one roll leg) → still a candidate, link-only.
    const halfLinked = stored.map((f, i) => (i === 1 ? f : { ...f, existingRollGroupId: null }))
    const [h] = detectRolls([recorded], halfLinked)
    expect(h.alreadyRecorded).toBe(false)
    expect(h.openAlreadyRecorded).toBe(true)
    expect(h.closedAlreadyRecorded).toBe(true)
    expect(h.defaultOn).toBe(true)
  })
})
