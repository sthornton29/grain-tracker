import { describe, it, expect } from 'vitest'
import {
  buildBuyerActuals,
  buildQualityAdjusted,
  categoryGroup,
  costliestGroups,
  qualityVerdict,
  type ComparisonSettlement,
} from '@/lib/buyer-comparison'

// Hand-verified report math. The quality-adjusted worked example is the one
// from the feature spec: corn with a 15.5% base moisture, a buyer whose sheet
// runs 2.5¢ per half-point over 16.5% — an 18.0% load draws 3 half-points ×
// 2.5¢ = 7.5¢/bu of drying, and dividing that by the load's 2.5 points over
// the CROP base (18.0 − 15.5) gives a per-point rate of 3.0¢.

const settlement = (over: Partial<ComparisonSettlement>): ComparisonSettlement => ({
  id: 's', buyerId: 'B', settlementDate: '2026-10-01', settlementNumber: null,
  settledBu: 0, grossRevenue: 0, discountTotal: 0, netRevenue: 0,
  items: [], loads: [],
  ...over,
})

describe('categoryGroup — the five report columns', () => {
  it('rolls the eleven categories into their groups', () => {
    expect(categoryGroup('moisture_shrink')).toBe('moistureDrying')
    expect(categoryGroup('drying')).toBe('moistureDrying')
    expect(categoryGroup('test_weight')).toBe('testWeight')
    expect(categoryGroup('heat_damage')).toBe('damage')
    expect(categoryGroup('dockage')).toBe('fmDockage')
    expect(categoryGroup('foreign_material')).toBe('fmDockage')
    expect(categoryGroup('sprout')).toBe('other')
    expect(categoryGroup('checkoff')).toBe('other') // unknown → other
  })
})

describe('buildBuyerActuals — per-buyer rollup and ranking', () => {
  // Buyer A: 2,000 bu, $9,000 gross, $200 discounts (10¢/bu), no shrink gap.
  // Buyer B: 1,000 bu, $4,500 gross, $50 discounts (5¢/bu) BUT paid on 20 bu
  //          fewer than our dry figure at $4.45 → $89 = 8.9¢/bu excess shrink.
  // Total cost: A = 10.0¢, B = 13.9¢ → A ranks 1 despite the uglier discounts.
  const rows = buildBuyerActuals([
    settlement({
      id: 'a1', buyerId: 'A', settledBu: 2000, grossRevenue: 9000,
      discountTotal: 200, netRevenue: 8800,
      items: [
        { category: 'drying', amount: 120 },
        { category: 'test_weight', amount: 80 },
      ],
      loads: [{ bu: 2000, moisture: 17, testWeight: 54, ourDryBu: 2000, pricePerBu: 4.4 }],
    }),
    settlement({
      id: 'b1', buyerId: 'B', settledBu: 1000, grossRevenue: 4500,
      discountTotal: 50, netRevenue: 4450,
      items: [{ category: 'drying', amount: 50 }],
      loads: [{ bu: 1000, moisture: 16, testWeight: 55, ourDryBu: 1020, pricePerBu: 4.45 }],
    }),
  ])

  const A = rows.find((r) => r.buyerId === 'A')!
  const B = rows.find((r) => r.buyerId === 'B')!

  it('total discount ¢/bu comes from the authoritative line totals', () => {
    expect(A.discountCentsPerBu).toBeCloseTo(10, 10) // 200/2000×100
    expect(B.discountCentsPerBu).toBeCloseTo(5, 10)
  })
  it('itemized category columns in ¢/bu', () => {
    expect(A.groupCents.moistureDrying).toBeCloseTo(6, 10) // 120/2000×100
    expect(A.groupCents.testWeight).toBeCloseTo(4, 10)
    expect(A.itemizedCoverage).toBeCloseTo(1, 10) // 200 of 200 itemized
  })
  it('excess shrink ¢/bu: 20 bu × $4.45 over 1,000 settled = 8.9¢', () => {
    expect(B.excessShrinkCentsPerBu).toBeCloseTo(8.9, 10)
    expect(A.excessShrinkCentsPerBu).toBeCloseTo(0, 10)
  })
  it('gross → net spread mirrors the discounts', () => {
    expect(A.grossPerBu).toBeCloseTo(4.5, 10)
    expect(A.netPerBu).toBeCloseTo(4.4, 10)
  })
  it('ranking: total cost = discounts + excess shrink, cheapest is rank 1', () => {
    expect(A.totalCostCentsPerBu).toBeCloseTo(10, 10)
    expect(B.totalCostCentsPerBu).toBeCloseTo(13.9, 10)
    expect(A.rank).toBe(1)
    expect(B.rank).toBe(2)
  })
  it('costliestGroups picks the biggest itemized column', () => {
    expect(costliestGroups(A)).toEqual(['moistureDrying'])
  })
})

describe('buildQualityAdjusted — the spec worked example', () => {
  // 1,000 bu of corn at 18.0% moisture, crop base 15.5%. The buyer charged
  // $75 of drying (7.5¢/bu, from their 2.5¢/half-point-over-16.5 sheet).
  // Points over the CROP base: 2.5 → rate = 7500¢ / 2500 point-bu = 3.0¢.
  const rows = buildQualityAdjusted(
    [settlement({
      buyerId: 'A', settledBu: 1000, grossRevenue: 4500, discountTotal: 75, netRevenue: 4425,
      items: [{ category: 'drying', amount: 75 }],
      loads: [{ bu: 1000, moisture: 18, testWeight: 54, ourDryBu: null, pricePerBu: null }],
    })],
    { baseMoisturePct: 15.5, baseLbPerBushel: 56 },
  )
  const A = rows[0]

  it('drying+moisture ¢/bu per point over the crop base = 3.0¢', () => {
    expect(A.moistureCentsPerPoint).toBeCloseTo(3.0, 10)
  })
  it('an itemized settlement with NO test-weight line is a genuine 0¢ rate', () => {
    // The statement itemized (drying only) and the grain was 2 lb light, so
    // this buyer demonstrably charged nothing for light grain.
    expect(A.testWeightCentsPerLb).toBeCloseTo(0, 10)
  })
  it('shows the buyer average moisture/TW beside the rates', () => {
    expect(A.avgMoisture).toBeCloseTo(18, 10)
    expect(A.avgTestWeight).toBeCloseTo(54, 10)
  })
})

describe('buildQualityAdjusted — TW rate and un-itemized settlements', () => {
  const rows = buildQualityAdjusted(
    [
      settlement({
        id: 's1', buyerId: 'A', settledBu: 1000, discountTotal: 40, netRevenue: 4460, grossRevenue: 4500,
        items: [{ category: 'test_weight', amount: 40 }],
        // 2 lb light × 1,000 bu = 2,000 lb-bu → 4000¢ / 2000 = 2.0¢/lb.
        loads: [{ bu: 1000, moisture: 15, testWeight: 54, ourDryBu: null, pricePerBu: null }],
      }),
      // Un-itemized settlement: its loads still feed the averages but its
      // dollars can't feed a per-factor rate.
      settlement({
        id: 's2', buyerId: 'A', settledBu: 500, discountTotal: 100, netRevenue: 2150, grossRevenue: 2250,
        items: [],
        loads: [{ bu: 500, moisture: 20, testWeight: 50, ourDryBu: null, pricePerBu: null }],
      }),
    ],
    { baseMoisturePct: 15.5, baseLbPerBushel: 56 },
  )
  const A = rows[0]
  it('TW ¢ per pound light = 2.0¢', () => {
    expect(A.testWeightCentsPerLb).toBeCloseTo(2.0, 10)
  })
  it('averages are bushel-weighted over ALL matched loads', () => {
    // moisture: (15×1000 + 20×500)/1500 = 16.667; TW: (54×1000+50×500)/1500.
    expect(A.avgMoisture).toBeCloseTo(50 / 3, 5)
    expect(A.avgTestWeight).toBeCloseTo(52.6667, 3)
  })
  it('ratedBu counts only the itemized settlements’ loads', () => {
    expect(A.ratedBu).toBe(1000)
  })
})

describe('qualityVerdict — the plain-language comparison line', () => {
  const rows = [
    {
      buyerId: 'A', avgMoisture: 16.8, avgTestWeight: 55, moistureCentsPerPoint: 2.1,
      testWeightCentsPerLb: null, ratedBu: 5000,
    },
    {
      buyerId: 'B', avgMoisture: 17.2, avgTestWeight: 55, moistureCentsPerPoint: 3.4,
      testWeightCentsPerLb: null, ratedBu: 4000,
    },
  ]
  const name = (id: string) => (id === 'A' ? 'Farmers Elevator' : 'River Terminal')
  it('states the per-point rates and "on similar grain" when moisture is within a point', () => {
    expect(qualityVerdict(rows, name, 'moisture')).toBe(
      'Farmers Elevator charged 2.1¢ per point of moisture; River Terminal charged 3.4¢ on similar grain.',
    )
  })
  it('caveats instead when the grain was NOT similar', () => {
    const far = [rows[0], { ...rows[1], avgMoisture: 19.5 }]
    expect(qualityVerdict(far, name, 'moisture')).toContain('note the moisture difference')
  })
  it('returns null rather than a one-buyer "comparison"', () => {
    expect(qualityVerdict([rows[0]], name, 'moisture')).toBeNull()
    expect(qualityVerdict(rows, name, 'testWeight')).toBeNull()
  })
})
