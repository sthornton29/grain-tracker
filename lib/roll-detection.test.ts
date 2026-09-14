import { describe, it, expect } from 'vitest'
import { detectRolls, isSpreadCode, type RollDetectGroup, type RollDetectOpen } from '@/lib/roll-detection'

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
