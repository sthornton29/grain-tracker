import { describe, it, expect } from 'vitest'
import {
  expectedDiscountDollars,
  isRejected,
  parseTiers,
  ruleCentsPerBu,
  ruleRawCharge,
  scheduleInForce,
  summarizeRule,
  unitsPastBase,
  varianceVerdict,
  type ScheduleRuleShape,
} from '@/lib/discount-schedules'

// Hand-worked rule applications. The tiered test-weight example is the one
// from the feature spec: a 4¢/8¢/16¢ scale under 54 lb, applied to a 54.2 lb
// load — bracket semantics give the bracket's own rate; cumulative (tier-walk)
// semantics stack every tier the grain has fallen through.

// The spec's worked scale: charges begin under 55 lb — 54.0–54.9 = 4¢,
// 53.0–53.9 = 8¢, 52.0–52.9 = 16¢.
const twTiered: ScheduleRuleShape = {
  factor: 'test_weight',
  basis: 'cents_per_bu',
  base_value: 55, // 55+ lb is clean
  direction: 'below',
  rate_per_unit: null,
  tiers: [
    { from: 54.0, to: 54.9, rate: 4 },
    { from: 53.0, to: 53.9, rate: 8 },
    { from: 52.0, to: 52.9, rate: 16 },
  ],
  cumulative: false,
  rejection_at: 50,
}

describe('tiered test-weight rule — the 4¢/8¢/16¢ scale under 55 lb', () => {
  it('55.4 lb sits above every bracket → no charge', () => {
    expect(ruleRawCharge(twTiered, 55.4)).toBe(0)
  })
  it('54.2 lb falls in the first bracket → 4¢/bu (the spec example)', () => {
    expect(ruleRawCharge(twTiered, 54.2)).toBe(4)
    expect(ruleCentsPerBu(twTiered, 54.2, 4.5)).toBe(4) // ¢/bu basis ignores price
  })
  it('53.5 lb falls in the second bracket → 8¢ (bracket semantics)', () => {
    expect(ruleRawCharge(twTiered, 53.5)).toBe(8)
  })
  it('below every bracket → the deepest printed rate (16¢)', () => {
    expect(ruleRawCharge(twTiered, 51.5)).toBe(16)
  })
  it('cumulative=true is the tier walk: every tier the grain fell through stacks', () => {
    const walk = { ...twTiered, cumulative: true }
    // 54.2: only the first tier entered → 4¢ (same as bracket here).
    expect(ruleRawCharge(walk, 54.2)).toBe(4)
    // 53.5: past the 4¢ tier + inside the 8¢ tier → 12¢.
    expect(ruleRawCharge(walk, 53.5)).toBe(12)
    // 51.5: past all three → 4 + 8 + 16 = 28¢.
    expect(ruleRawCharge(walk, 51.5)).toBe(28)
  })
  it('rejection point: 50 lb and lighter is rejected, 50.5 is not', () => {
    expect(isRejected(twTiered, 50)).toBe(true)
    expect(isRejected(twTiered, 49.2)).toBe(true)
    expect(isRejected(twTiered, 50.5)).toBe(false)
    expect(isRejected(twTiered, null)).toBe(false)
  })
})

// Linear drying rule from the spec's worked example: 2.5¢ per HALF point over
// 16.5% is stored per-POINT (5¢). An 18.0% load is 1.5 points over →
// 3 half-points × 2.5¢ = 1.5 × 5¢ = 7.5¢/bu.
const dryingLinear: ScheduleRuleShape = {
  factor: 'drying',
  basis: 'cents_per_bu',
  base_value: 16.5,
  direction: 'above',
  rate_per_unit: 5, // 2.5¢/half-point, stored per point
  tiers: [],
  cumulative: false,
  rejection_at: null,
}

describe('linear drying rule — 2.5¢/half-point over 16.5%', () => {
  it('18.0% moisture → 7.5¢/bu (1.5 points × 5¢)', () => {
    expect(unitsPastBase(dryingLinear, 18)).toBeCloseTo(1.5, 10)
    expect(ruleRawCharge(dryingLinear, 18)).toBeCloseTo(7.5, 10)
  })
  it('at or under the threshold → 0; missing measurement → null', () => {
    expect(ruleRawCharge(dryingLinear, 16.5)).toBe(0)
    expect(ruleRawCharge(dryingLinear, 15.0)).toBe(0)
    expect(ruleRawCharge(dryingLinear, null)).toBeNull()
  })
})

describe('non-¢/bu bases monetize through the price', () => {
  it('weight shrink %: 1.4%/point over 15, at 17% and $4.50 → 2.8% × $4.50 = 12.6¢', () => {
    const rule: ScheduleRuleShape = {
      factor: 'moisture_shrink', basis: 'weight_shrink_pct', base_value: 15,
      direction: 'above', rate_per_unit: 1.4, tiers: [], cumulative: false, rejection_at: null,
    }
    expect(ruleRawCharge(rule, 17)).toBeCloseTo(2.8, 10) // percent of weight
    expect(ruleCentsPerBu(rule, 17, 4.5)).toBeCloseTo(12.6, 10) // 0.028 × 450¢
  })
  it('% of price behaves the same way', () => {
    const rule: ScheduleRuleShape = {
      factor: 'damage', basis: 'pct_of_price', base_value: 5,
      direction: 'above', rate_per_unit: 0.5, tiers: [], cumulative: false, rejection_at: null,
    }
    // 8% damage → 3 points × 0.5% = 1.5% of a $4.00 price = 6¢/bu.
    expect(ruleCentsPerBu(rule, 8, 4)).toBeCloseTo(6, 10)
  })
})

describe('expectedDiscountDollars — schedule applied to settled loads', () => {
  it('sums rule ¢/bu × bushels per factor; unmeasured loads contribute nothing', () => {
    const loads = [
      { bu: 1000, moisture: 18, testWeight: 54.2 }, // drying 7.5¢, TW 4¢
      { bu: 500, moisture: 16.5, testWeight: null }, // drying 0¢, TW unmeasured
    ]
    const out = expectedDiscountDollars([dryingLinear, twTiered], loads, 4.5)
    // drying: 7.5¢ × 1000 + 0 × 500 = $75.
    expect(out.get('drying')).toBeCloseTo(75, 10)
    // test weight: 4¢ × 1000 = $40 (the 500-bu load has no TW reading).
    expect(out.get('test_weight')).toBeCloseTo(40, 10)
  })
})

describe('varianceVerdict — charged above their own published schedule', () => {
  it('flags only a MATERIAL overcharge (>2¢ and >25% of expected)', () => {
    // Expected 7.5¢, charged 12¢: over by 4.5¢ (>2¢) and 60% (>25%) → flag.
    expect(varianceVerdict(7.5, 12)).toEqual({ varianceCents: 4.5, flagged: true })
    // Over by 1.5¢ — under the 2¢ floor → quiet.
    expect(varianceVerdict(7.5, 9).flagged).toBe(false)
    // Big expected charge, small relative drift: 40¢ expected, 44¢ charged —
    // over by 4¢ but only 10% → quiet (the 25% test).
    expect(varianceVerdict(40, 44).flagged).toBe(false)
    // Undercharge never flags.
    expect(varianceVerdict(10, 6).flagged).toBe(false)
  })
})

describe('scheduleInForce — effective dates', () => {
  const schedules = [
    { id: 'a', buyer_id: 'B1', crop_id: 'C1', effective_date: '2026-06-01' },
    { id: 'b', buyer_id: 'B1', crop_id: 'C1', effective_date: '2026-09-15' },
    { id: 'c', buyer_id: 'B2', crop_id: 'C1', effective_date: '2026-01-01' },
  ]
  it('picks the newest schedule dated on/before the settlement', () => {
    expect(scheduleInForce(schedules, 'B1', 'C1', '2026-08-30')?.id).toBe('a')
    expect(scheduleInForce(schedules, 'B1', 'C1', '2026-09-15')?.id).toBe('b')
    expect(scheduleInForce(schedules, 'B1', 'C1', '2026-10-01')?.id).toBe('b')
  })
  it('a schedule dated after the settlement never applies', () => {
    expect(scheduleInForce(schedules, 'B1', 'C1', '2026-05-01')).toBeNull()
  })
  it('scoped to the buyer and crop', () => {
    expect(scheduleInForce(schedules, 'B2', 'C1', '2026-08-30')?.id).toBe('c')
    expect(scheduleInForce(schedules, 'B1', 'C2', '2026-08-30')).toBeNull()
  })
})

describe('parseTiers + summarizeRule', () => {
  it('parseTiers drops malformed brackets', () => {
    expect(parseTiers([{ from: 53, to: 53.9, rate: 4 }, { from: 'x', to: 1, rate: 2 }, null])).toEqual([
      { from: 53, to: 53.9, rate: 4 },
    ])
    expect(parseTiers(null)).toEqual([])
  })
  it('summarizes tiered and linear rules in plain language', () => {
    expect(summarizeRule(twTiered)).toBe('4¢/8¢/16¢ per bracket, under 55 lb · reject at 50 lb')
    expect(summarizeRule(dryingLinear)).toBe('5¢/bu per point over 16.5%')
  })
})
