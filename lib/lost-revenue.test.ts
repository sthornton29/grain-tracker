import { describe, it, expect } from 'vitest'
import {
  buildLostRevenueRows,
  costliestLostGroups,
  settlementLostRevenue,
  type LostRevenueSettlement,
} from '@/lib/lost-revenue'

// Hand-verified normalization: a price-discounting buyer and a
// volume-discounting buyer must land at COMPARABLE ¢/bu — that's the whole
// point of the lost-revenue measure.

const settlement = (over: Partial<LostRevenueSettlement>): LostRevenueSettlement => ({
  id: 's', buyerId: 'B', settlementDate: '2026-10-01', settlementNumber: null,
  settledBu: 0, items: [], loads: [], contractId: null,
  ...over,
})

describe('settlementLostRevenue — normalizing the two mechanisms', () => {
  it('price-discounter: $50 drying off the check on 1,000 bu → 5¢/bu, in moisture/drying', () => {
    const lost = settlementLostRevenue({
      items: [{ category: 'drying', amount: 50, deduction_kind: 'price' }],
      loads: [{ bu: 1000, ourDryBu: 1000, pricePerBu: 4.2 }],
    })
    expect(lost.priceDollars).toBeCloseTo(50, 10)
    expect(lost.volumeDollars).toBeCloseTo(0, 10)
    expect(lost.totalDollars).toBeCloseTo(50, 10)
    expect(lost.byGroup.moistureDrying).toBeCloseTo(50, 10)
    expect(lost.byGroup.weightDeduction).toBeCloseTo(0, 10)
  })

  it('volume-discounter: pay bushels 11.9 under FSA dry at $4.20 → ~$50, comparable ¢/bu', () => {
    const lost = settlementLostRevenue({
      items: [],
      loads: [{ bu: 1000, ourDryBu: 1011.9, pricePerBu: 4.2 }],
    })
    expect(lost.priceDollars).toBe(0)
    expect(lost.volumeDollars).toBeCloseTo(11.9 * 4.2, 10) // $49.98
    // No weight itemization → the whole gap lands in Weight deduction.
    expect(lost.byGroup.weightDeduction).toBeCloseTo(49.98, 10)
    // ~5¢/bu — right beside the price-discounter's 5¢.
    expect((lost.totalDollars / 1000) * 100).toBeCloseTo(4.998, 3)
  })

  it('itemized weight lines CATEGORIZE the gap pro-rata, never add dollars', () => {
    // The statement itemizes its volume deduction: 3/4 moisture shrink lbs,
    // 1/4 dockage weight (by printed amounts $30/$10). The gap is $40 from
    // the reconciliation — NOT $40 + $40.
    const lost = settlementLostRevenue({
      items: [
        { category: 'moisture_shrink', amount: 30, deduction_kind: 'weight' },
        { category: 'dockage', amount: 10, deduction_kind: 'weight' },
      ],
      loads: [{ bu: 990.476, ourDryBu: 1000, pricePerBu: 4.2 }], // 9.524 bu × 4.2 ≈ $40
    })
    expect(lost.priceDollars).toBe(0)
    expect(lost.totalDollars).toBeCloseTo(40, 1)
    expect(lost.byGroup.moistureDrying).toBeCloseTo(lost.volumeDollars * 0.75, 6)
    expect(lost.byGroup.fmDockage).toBeCloseTo(lost.volumeDollars * 0.25, 6)
    expect(lost.byGroup.weightDeduction).toBeCloseTo(0, 10)
  })

  it('weight items with no printed amounts split the gap equally', () => {
    const lost = settlementLostRevenue({
      items: [
        { category: 'moisture_shrink', amount: 0, deduction_kind: 'weight' },
        { category: 'foreign_material', amount: 0, deduction_kind: 'weight' },
      ],
      loads: [{ bu: 990, ourDryBu: 1000, pricePerBu: 4.0 }], // $40 gap
    })
    expect(lost.byGroup.moistureDrying).toBeCloseTo(20, 10)
    expect(lost.byGroup.fmDockage).toBeCloseTo(20, 10)
  })

  it('a buyer paying MORE than FSA-standard runs the gap negative', () => {
    const lost = settlementLostRevenue({
      items: [],
      loads: [{ bu: 1010, ourDryBu: 1000, pricePerBu: 4.0 }],
    })
    expect(lost.volumeDollars).toBeCloseTo(-40, 10)
    expect(lost.byGroup.weightDeduction).toBeCloseTo(-40, 10)
  })
})

describe('buildLostRevenueRows — the contracted-bushel lead metric', () => {
  const contracts = new Map([
    ['C1', { id: 'C1', number: '4501', bushels: 5000 }],
    ['C2', { id: 'C2', number: '4502', bushels: 10000 }],
  ])

  it('lead = linked lost $ ÷ contracted bu, weighted across contracts; companion = per settled bu', () => {
    const rows = buildLostRevenueRows([
      // Contract C1 (5,000 bu): one settlement, $50 lost on 1,000 settled bu.
      settlement({
        id: 's1', buyerId: 'A', contractId: 'C1', settledBu: 1000,
        items: [{ category: 'drying', amount: 50, deduction_kind: 'price' }],
        loads: [{ bu: 1000, ourDryBu: 1000, pricePerBu: 4.2 }],
      }),
      // Contract C2 (10,000 bu): $100 lost on 2,000 settled bu.
      settlement({
        id: 's2', buyerId: 'A', contractId: 'C2', settledBu: 2000,
        items: [{ category: 'test_weight', amount: 100, deduction_kind: 'price' }],
        loads: [{ bu: 2000, ourDryBu: 2000, pricePerBu: 4.2 }],
      }),
    ], contracts)
    const A = rows[0]
    // Lead: ($50 + $100) ÷ (5,000 + 10,000) × 100 = 1.0¢/contracted bu.
    expect(A.contractedBu).toBe(15000)
    expect(A.leadCentsPerContractedBu).toBeCloseTo(1.0, 10)
    // Companion: $150 ÷ 3,000 settled × 100 = 5.0¢/settled bu.
    expect(A.centsPerSettledBu).toBeCloseTo(5.0, 10)
    expect(A.spotOnly).toBe(false)
    // Per-contract drill-down: C1 = 1.0¢, C2 = 1.0¢.
    expect(A.contracts.find((c) => c.contractId === 'C1')!.centsPerContractedBu).toBeCloseTo(1.0, 10)
    expect(A.contracts.find((c) => c.contractId === 'C2')!.centsPerContractedBu).toBeCloseTo(1.0, 10)
  })

  it('a contract settled twice counts its bushels ONCE in the denominator', () => {
    const rows = buildLostRevenueRows([
      settlement({ id: 's1', buyerId: 'A', contractId: 'C1', settledBu: 500, items: [{ category: 'other', amount: 25, deduction_kind: 'price' }], loads: [] }),
      settlement({ id: 's2', buyerId: 'A', contractId: 'C1', settledBu: 500, items: [{ category: 'other', amount: 25, deduction_kind: 'price' }], loads: [] }),
    ], contracts)
    // $50 ÷ 5,000 (not 10,000) = 1.0¢.
    expect(rows[0].contractedBu).toBe(5000)
    expect(rows[0].leadCentsPerContractedBu).toBeCloseTo(1.0, 10)
  })

  it('spot/unlinked buyers fall back to the settled-bu figure, labeled', () => {
    const rows = buildLostRevenueRows([
      settlement({ id: 's1', buyerId: 'SPOT', contractId: null, settledBu: 1000, items: [{ category: 'drying', amount: 30, deduction_kind: 'price' }], loads: [] }),
    ], contracts)
    const r = rows[0]
    expect(r.spotOnly).toBe(true)
    expect(r.leadCentsPerContractedBu).toBeNull()
    expect(r.centsPerSettledBu).toBeCloseTo(3.0, 10)
    expect(r.rankCents).toBeCloseTo(3.0, 10) // ranks on the companion
    expect(r.unlinked).toHaveLength(1)
  })

  it('ranking uses the lead metric (cheapest first)', () => {
    const rows = buildLostRevenueRows([
      settlement({ id: 'a', buyerId: 'A', contractId: 'C1', settledBu: 1000, items: [{ category: 'drying', amount: 100, deduction_kind: 'price' }], loads: [] }), // 2¢/contracted
      settlement({ id: 'b', buyerId: 'B', contractId: 'C2', settledBu: 1000, items: [{ category: 'drying', amount: 100, deduction_kind: 'price' }], loads: [] }), // 1¢/contracted
    ], contracts)
    expect(rows.map((r) => [r.buyerId, r.rank])).toEqual([['B', 1], ['A', 2]])
  })

  it('category columns are ¢ per settled bushel; costliest cell highlights', () => {
    const rows = buildLostRevenueRows([
      settlement({
        id: 's1', buyerId: 'A', contractId: null, settledBu: 1000,
        items: [
          { category: 'drying', amount: 60, deduction_kind: 'price' },
          { category: 'test_weight', amount: 20, deduction_kind: 'price' },
        ],
        loads: [{ bu: 1000, ourDryBu: 1005, pricePerBu: 4.0 }], // $20 gap
      }),
    ], contracts)
    const r = rows[0]
    expect(r.groupCents.moistureDrying).toBeCloseTo(6, 10)
    expect(r.groupCents.testWeight).toBeCloseTo(2, 10)
    expect(r.groupCents.weightDeduction).toBeCloseTo(2, 10)
    expect(r.centsPerSettledBu).toBeCloseTo(10, 10) // 6 + 2 + 2
    expect(costliestLostGroups(r)).toEqual(['moistureDrying'])
  })
})
