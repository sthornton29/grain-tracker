import { describe, it, expect } from 'vitest'
import { effectiveEntry, lineageChain, rolledFromLegs, rolledIntoLegs, type LineagePosition } from '@/lib/hedge-lineage'

// The 9/03 roll: DEC 26 short entered 4.9525, closed 5.435 → MAR 27 opened 5.585.
// Effective entry since the original = 4.9525 + (5.585 − 5.435) = 5.1025.
const DEC: LineagePosition = { id: 'dec', contract_month: 'DEC 26', trade_price: 4.9525, trade_date: '2026-04-15', num_contracts: 14, status: 'closed', close_price: 5.435, roll_group_id: 'g1', rolled_from_position_id: null }
const MAR: LineagePosition = { id: 'mar', contract_month: 'MAR 27', trade_price: 5.585, trade_date: '2026-09-03', num_contracts: 14, status: 'open', roll_group_id: 'g1', rolled_from_position_id: 'dec' }

describe('effectiveEntry — original entry ± cumulative roll spreads', () => {
  it('one roll: 4.9525 + (5.585 − 5.435) = 5.1025', () => {
    const e = effectiveEntry(MAR, [DEC, MAR])
    expect(e.effectivePrice).toBeCloseTo(5.1025, 6)
    expect(e.originalEntry).toBeCloseTo(4.9525, 6)
    expect(e.originalMonth).toBe('DEC 26')
    expect(e.originalDate).toBe('2026-04-15')
    expect(e.steps).toHaveLength(1)
    expect(e.steps[0]).toMatchObject({ fromMonth: 'DEC 26', toMonth: 'MAR 27', closePrice: 5.435, openPrice: 5.585, contracts: 14 })
    expect(e.steps[0].spread).toBeCloseTo(0.15, 6)
  })

  it('a position that was never rolled into reads at its own trade price', () => {
    const e = effectiveEntry(DEC, [DEC, MAR])
    expect(e.effectivePrice).toBeCloseTo(4.9525, 6)
    expect(e.steps).toHaveLength(0)
  })

  it('chain of two rolls: DEC → MAR → MAY accumulates both spreads', () => {
    // MAR later closed @ 5.60 into MAY @ 5.70: 5.1025 + (5.70 − 5.60) = 5.2025.
    const marClosed: LineagePosition = { ...MAR, status: 'closed', close_price: 5.6, roll_group_id: 'g2' } // group moves to the roll it closed into
    const MAY: LineagePosition = { id: 'may', contract_month: 'MAY 27', trade_price: 5.7, trade_date: '2027-02-20', num_contracts: 14, status: 'open', roll_group_id: 'g2', rolled_from_position_id: 'mar' }
    const all = [DEC, marClosed, MAY]
    const e = effectiveEntry(MAY, all)
    expect(e.effectivePrice).toBeCloseTo(5.2025, 6)
    expect(e.originalEntry).toBeCloseTo(4.9525, 6)
    expect(e.originalMonth).toBe('DEC 26')
    expect(e.steps.map((s) => `${s.fromMonth}→${s.toMonth}`)).toEqual(['DEC 26→MAR 27', 'MAR 27→MAY 27'])
    expect(lineageChain(DEC, all).map((p) => p.id)).toEqual(['dec', 'mar', 'may'])
    expect(lineageChain(MAY, all).map((p) => p.id)).toEqual(['dec', 'mar', 'may'])
    expect(lineageChain(marClosed, all).map((p) => p.id)).toEqual(['dec', 'mar', 'may'])
  })

  it('two closed lots rolled together weight the entry by contracts', () => {
    // 10 @ 4.90 + 4 @ 5.10 closed @ 5.435 (both) → MAR 14 @ 5.585.
    // Weighted entry = (49.0 + 20.4) / 14 = 4.957142…; effective = + 0.15.
    const a: LineagePosition = { id: 'a', contract_month: 'DEC 26', trade_price: 4.9, trade_date: '2026-04-01', num_contracts: 10, status: 'closed', close_price: 5.435, roll_group_id: 'g1', rolled_from_position_id: null }
    const b: LineagePosition = { id: 'b', contract_month: 'DEC 26', trade_price: 5.1, trade_date: '2026-05-01', num_contracts: 4, status: 'closed', close_price: 5.435, roll_group_id: 'g1', rolled_from_position_id: null }
    const mar: LineagePosition = { ...MAR, rolled_from_position_id: 'a' }
    const legs = rolledFromLegs(mar, [a, b, mar])
    expect(legs.map((l) => l.id).sort()).toEqual(['a', 'b'])
    const e = effectiveEntry(mar, [a, b, mar])
    expect(e.originalEntry).toBeCloseTo(69.4 / 14, 6)
    expect(e.effectivePrice).toBeCloseTo(69.4 / 14 + 0.15, 6)
  })

  it('a rolled-into leg that was later closed by hand is not mistaken for a closed leg of its own roll', () => {
    const marClosedByHand: LineagePosition = { ...MAR, status: 'closed', close_price: 5.2 } // still roll_group g1 (created by it)
    expect(rolledFromLegs(marClosedByHand, [DEC, marClosedByHand]).map((l) => l.id)).toEqual(['dec'])
    expect(rolledIntoLegs(DEC, [DEC, marClosedByHand]).map((l) => l.id)).toEqual(['mar'])
  })

  it('a broken link (rolled-from row deleted) falls back to the leg’s own price', () => {
    const e = effectiveEntry(MAR, [MAR])
    expect(e.effectivePrice).toBeCloseTo(5.585, 6)
    expect(e.steps).toHaveLength(0)
    expect(lineageChain(MAR, [MAR]).map((p) => p.id)).toEqual(['mar'])
  })
})

// ---------------------------------------------------------------------------
// 0095: one roll, SEVERAL new-month fills. The 10/12/2026 statement rolled
// 23 DEC 26 cotton shorts (10 @ 72.65, 13 @ 84.40, both closed at the
// 80.45739 average) into MAR 27 as five fills, every fill rolled_from the
// anchor (the 10-lot) and sharing the roll group. Each MAR lot's sources are
// the group's CLOSED legs — never its sibling fills — so each reads at
// weighted DEC entry 79.29130 + (its price − 80.45739), and the
// contract-weighted effective across the five lots is 82.48130 ¢/lb.
// ---------------------------------------------------------------------------
describe('multi-fill roll lineage (cotton, ¢/lb)', () => {
  const DEC10: LineagePosition = { id: 'dec10', contract_month: 'DEC 26', trade_price: 72.65, trade_date: '2026-03-18', num_contracts: 10, status: 'closed', close_price: 80.45739, roll_group_id: 'gc', rolled_from_position_id: null }
  const DEC13: LineagePosition = { id: 'dec13', contract_month: 'DEC 26', trade_price: 84.4, trade_date: '2026-08-10', num_contracts: 13, status: 'closed', close_price: 80.45739, roll_group_id: 'gc', rolled_from_position_id: null }
  const FILLS: LineagePosition[] = ([[3, 83.63], [12, 83.64], [3, 83.65], [3, 83.67], [2, 83.68]] as const).map(([q, p], i) => ({
    id: `mar${i}`, contract_month: 'MAR 27', trade_price: p, trade_date: '2026-10-12', num_contracts: q, status: 'open', roll_group_id: 'gc', rolled_from_position_id: 'dec10',
  }))
  const ALL = [DEC10, DEC13, ...FILLS]
  const WEIGHTED_DEC = (10 * 72.65 + 13 * 84.4) / 23 // 79.291304…

  it('every fill rolled from the group’s closed legs only — sibling fills never leak in', () => {
    for (const fill of FILLS) {
      expect(rolledFromLegs(fill, ALL).map((l) => l.id).sort()).toEqual(['dec10', 'dec13'])
    }
    expect(rolledIntoLegs(DEC10, ALL).map((l) => l.id)).toEqual(FILLS.map((f) => f.id))
  })

  it('each MAR lot = weighted DEC entry 79.29130 + (its price − 80.45739)', () => {
    for (const fill of FILLS) {
      const e = effectiveEntry(fill, ALL)
      expect(e.originalEntry).toBeCloseTo(WEIGHTED_DEC, 5)
      expect(e.originalMonth).toBe('DEC 26')
      expect(e.steps).toHaveLength(1)
      expect(e.steps[0]).toMatchObject({ fromMonth: 'DEC 26', toMonth: 'MAR 27', closePrice: 80.45739, openPrice: Number(fill.trade_price), contracts: 23 })
      expect(e.effectivePrice).toBeCloseTo(WEIGHTED_DEC + (Number(fill.trade_price) - 80.45739), 5)
    }
    expect(effectiveEntry(FILLS[1], ALL).effectivePrice).toBeCloseTo(82.47391, 5)
  })

  it('contract-weighted effective across the five MAR lots = 82.48130', () => {
    const q = FILLS.reduce((s, f) => s + Number(f.num_contracts), 0)
    const weighted = FILLS.reduce((s, f) => s + effectiveEntry(f, ALL).effectivePrice * Number(f.num_contracts), 0) / q
    expect(q).toBe(23)
    expect(weighted).toBeCloseTo(82.4813, 4)
    // = weighted DEC entry + (weighted MAR open 83.647391 − 80.45739) = 79.29130 + 3.19000
    expect(weighted).toBeCloseTo(WEIGHTED_DEC + 3.19, 4)
  })

  it('the lineage chain from a DEC leg follows the largest fill forward', () => {
    expect(lineageChain(DEC10, ALL).map((p) => p.id)).toEqual(['dec10', 'mar1'])
    expect(lineageChain(FILLS[3], ALL).map((p) => p.id)).toEqual(['dec10', 'mar3'])
  })
})
