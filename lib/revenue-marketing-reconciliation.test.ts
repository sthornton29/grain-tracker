import { describe, it, expect } from 'vitest'
import { computeMarketing, aggregateMarketing, type Planting } from '@/lib/marketing'
import { computeRevenueProjections, type InsuranceProceeds, type GovtProceeds } from '@/lib/revenue-projections'
import type { Crop, Contract, CropAssumption } from '@/lib/types'

// Fix 4 — the Marketing dashboard and Revenue Projections share ONE revenue
// engine (lib/marketing's blendedRevenue). The only thing Revenue Projections
// adds on top is crop-insurance proceeds + government payments, so for every crop
// the two pages must satisfy this identity exactly:
//
//   RevenueProjections.profit − Marketing.totalProfit === insurance + government
//
// These tests feed computeMarketing's real output straight into
// computeRevenueProjections (so both share the identical blendedRevenue) and
// assert the identity per crop and in aggregate, with hand-derived numbers.
//
// Note on the What-If: assumed futures/basis are PERSISTED standing assumptions
// (crop_assumptions), so they flow through computeMarketing into BOTH pages — see
// the second test. Only the marketing dashboard's un-committed live preview is
// session-scoped, and it is computed as an exact delta on the same blendedRevenue
// (lib/marketing page scenarioFor), so it never diverges either.

function crop(id: string, name: string): Crop {
  return { id, name, base_moisture_pct: 15, base_lb_per_bushel: 56, harvest_category: 'fall', double_crop: false }
}
function assumption(over: Partial<CropAssumption> & Pick<CropAssumption, 'crop_id'>): CropAssumption {
  return {
    id: `a-${over.crop_id}`, crop_year: 2026,
    expected_yield: null, expected_yield_irr: null, expected_yield_dry: null,
    expected_yield_dc_irr: null, expected_yield_dc_dry: null, harvest_complete: false,
    assumed_basis: 0, assumed_futures: null, cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null,
    cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null, notes: null,
    created_at: '', updated_at: '', ...over,
  }
}
function contract(over: Partial<Contract> & Pick<Contract, 'crop_id'>): Contract {
  return {
    id: `c-${Math.round(over.contracted_bushels ?? 0)}-${over.contract_type ?? 'forward'}`,
    contract_number: 'CN', buyer_id: null, entity_id: null, crop_year: 2026,
    contracted_bushels: 0, price_per_bushel: null, notes: null,
    delivery_type: 'pickup', delivery_location_id: null, delivery_start_date: null, delivery_end_date: null,
    completed_at: null, created_at: '', contract_month: null, contract_type: 'forward',
    futures_price: null, basis: null, cash_price: null, service_fee: 0,
    futures_set_date: null, basis_set_date: null, pricing_status: 'fully_priced', ...over,
  }
}
const ins = (netPnl: number, totalIndemnity = 0, premium = 0): InsuranceProceeds => ({ netPnl, totalIndemnity, premium })
const govt = (arcPlc = 0, cropSpecificOther = 0, allocatedOther = 0): GovtProceeds => ({ arcPlc, cropSpecificOther, allocatedOther })

const CY = 2026

describe('Revenue Projections ↔ Marketing dashboard reconciliation', () => {
  it('RevProj profit − Marketing total profit === insurance + govt, per crop and total', () => {
    const crops = [crop('corn', 'Corn'), crop('soy', 'Soybean')]
    const plantings: Planting[] = [
      { crop_id: 'corn', season_year: CY, planted_acres: 1000 },
      { crop_id: 'soy', season_year: CY, planted_acres: 500 },
    ]
    // CORN: fully unpriced, market futures 4.50, assumed basis 0 →
    //   blended = 180,000 bu × 4.50 = 810,000; cost 600/ac → totalProfit 210,000.
    // SOY:  flat-cash forward 20,000 bu @ 11.00 (locked) + 10,000 unpriced at the
    //   market 10.80 + assumed basis −0.50 = 10.30 →
    //   blended = 20,000×11.00 + 10,000×10.30 = 220,000 + 103,000 = 323,000;
    //   cost 450/ac × 500 = 225,000 → totalProfit 98,000.
    const contracts: Contract[] = [
      contract({ crop_id: 'soy', contract_type: 'forward', contracted_bushels: 20000, cash_price: 11.0 }),
    ]
    const assumptions: CropAssumption[] = [
      assumption({ crop_id: 'corn', expected_yield: 180, cost_per_acre: 600 }),
      assumption({ crop_id: 'soy', expected_yield: 60, assumed_basis: -0.5, cost_per_acre: 450 }),
    ]
    const currentFuturesByCrop = new Map([['corn', 4.5], ['soy', 10.8]])

    const marketingRows = computeMarketing({
      cropYear: CY, crops, plantings, contracts, futures: [], options: [],
      assumptions, actualProductionByCrop: new Map(), currentFuturesByCrop,
    })
    const corn = marketingRows.find((r) => r.cropId === 'corn')!
    const soy = marketingRows.find((r) => r.cropId === 'soy')!
    expect(corn.blendedRevenue).toBeCloseTo(810000, 2)
    expect(corn.totalProfit).toBeCloseTo(210000, 2)
    expect(soy.blendedRevenue).toBeCloseTo(323000, 2)
    expect(soy.totalProfit).toBeCloseTo(98000, 2)

    const insuranceByCrop = new Map<string, InsuranceProceeds>([
      ['corn', ins(25000, 40000, 15000)],
      ['soy', ins(-4000, 0, 4000)],
    ])
    const govtByCrop = new Map<string, GovtProceeds>([
      ['corn', govt(12000, 3000, 1500)],   // 16,500
      ['soy', govt(8000)],                  // 8,000
    ])

    const { rows, totals } = computeRevenueProjections({
      marketingRows, contracts, cropYear: CY,
      marketPriceByCrop: new Map(), insuranceByCrop, govtByCrop,
    })

    // The identity, derived from the engines, per crop.
    for (const r of rows) {
      const mr = marketingRows.find((m) => m.cropId === r.cropId)!
      const insNet = insuranceByCrop.get(r.cropId)!.netPnl
      const g = govtByCrop.get(r.cropId)!
      const govtTotal = g.arcPlc + g.cropSpecificOther + g.allocatedOther
      // Crop sales revenue is literally the marketing blended revenue.
      expect(r.cropSalesRevenue).toBeCloseTo(mr.blendedRevenue, 2)
      expect(r.profit! - mr.totalProfit!).toBeCloseTo(insNet + govtTotal, 2)
    }

    // Explicit worked numbers.
    const rCorn = rows.find((r) => r.cropId === 'corn')!
    expect(rCorn.profit).toBeCloseTo(251500, 2)            // 810,000 + 25,000 + 16,500 − 600,000
    expect(rCorn.profit! - corn.totalProfit!).toBeCloseTo(41500, 2)   // 25,000 + 16,500
    const rSoy = rows.find((r) => r.cropId === 'soy')!
    expect(rSoy.profit).toBeCloseTo(102000, 2)            // 323,000 − 4,000 + 8,000 − 225,000
    expect(rSoy.profit! - soy.totalProfit!).toBeCloseTo(4000, 2)      // −4,000 + 8,000

    // Aggregate identity.
    const marketingTotalProfit = marketingRows.reduce((s, r) => s + (r.totalProfit ?? 0), 0)
    const insTotal = [...insuranceByCrop.values()].reduce((s, i) => s + i.netPnl, 0)
    const govtTotal = [...govtByCrop.values()].reduce((s, g) => s + g.arcPlc + g.cropSpecificOther + g.allocatedOther, 0)
    expect(totals.profit - marketingTotalProfit).toBeCloseTo(insTotal + govtTotal, 2)  // 45,500
  })

  it('a PERSISTED assumed-futures what-if flows to both pages identically', () => {
    // assumed_futures 4.80 is a standing assumption (persisted to crop_assumptions),
    // so it re-prices the unpriced corn on BOTH pages — beating the 4.20 market
    // estimate. blended = 180,000 × (4.80 + 0) = 864,000; cost 600 → profit 264,000.
    const crops = [crop('corn', 'Corn')]
    const plantings: Planting[] = [{ crop_id: 'corn', season_year: CY, planted_acres: 1000 }]
    const assumptions = [assumption({ crop_id: 'corn', expected_yield: 180, assumed_futures: 4.8, cost_per_acre: 600 })]
    const marketingRows = computeMarketing({
      cropYear: CY, crops, plantings, contracts: [], futures: [], options: [],
      assumptions, actualProductionByCrop: new Map(),
      currentFuturesByCrop: new Map([['corn', 4.2]]),   // ignored — assumed_futures wins
    })
    expect(marketingRows[0].blendedRevenue).toBeCloseTo(864000, 2)
    expect(marketingRows[0].totalProfit).toBeCloseTo(264000, 2)

    const { rows } = computeRevenueProjections({
      marketingRows, contracts: [], cropYear: CY,
      marketPriceByCrop: new Map(), insuranceByCrop: new Map([['corn', ins(10000)]]),
    })
    expect(rows[0].cropSalesRevenue).toBeCloseTo(864000, 2)                 // identical to marketing
    expect(rows[0].profit! - marketingRows[0].totalProfit!).toBeCloseTo(10000, 2)  // only insurance differs
  })

  it('shared aggregation reconciles with messy prices/yields — incl. a zero-safety-net crop that matches exactly', () => {
    // Three crops with deliberately un-round acres/yields/prices/costs, so any
    // stage-rounding bug (summing rounded per-crop values, rounding cost*acres
    // separately, etc.) would throw the identity off. The dashboard total comes
    // from aggregateMarketing(); Revenue Projections layers insurance + govt on the
    // SAME aggregate. Wheat carries no insurance or government payments, so its two
    // profits must be bit-for-bit identical.
    const crops = [crop('corn', 'Corn'), crop('soy', 'Soybean'), crop('wheat', 'Wheat')]
    const plantings: Planting[] = [
      { crop_id: 'corn', season_year: CY, planted_acres: 327.4 },
      { crop_id: 'soy', season_year: CY, planted_acres: 210.85 },
      { crop_id: 'wheat', season_year: CY, planted_acres: 96.5 },
    ]
    const assumptions: CropAssumption[] = [
      assumption({ crop_id: 'corn', expected_yield: 188.6, assumed_basis: -0.225, cost_per_acre: 612.47 }),
      assumption({ crop_id: 'soy', expected_yield: 57.3, assumed_basis: -0.41, cost_per_acre: 503.19 }),
      assumption({ crop_id: 'wheat', expected_yield: 71.2, assumed_basis: -0.15, cost_per_acre: 288.4 }),
    ]
    const currentFuturesByCrop = new Map([['corn', 4.835], ['soy', 11.27], ['wheat', 6.42]])

    const marketingRows = computeMarketing({
      cropYear: CY, crops, plantings, contracts: [], futures: [], options: [],
      assumptions, actualProductionByCrop: new Map(), currentFuturesByCrop,
    })
    const dash = aggregateMarketing(marketingRows)   // the dashboard's combined projected profit

    const insuranceByCrop = new Map<string, InsuranceProceeds>([
      ['corn', ins(18234.55, 31000.4, 12765.85)],
      ['soy', ins(-2240.18, 0, 2240.18)],
      // wheat: none
    ])
    const govtByCrop = new Map<string, GovtProceeds>([
      ['corn', govt(7211.33, 1450.2, 980.1)],
      ['soy', govt(4120.55)],
      // wheat: none
    ])

    const { rows, totals } = computeRevenueProjections({
      marketingRows, contracts: [], cropYear: CY,
      marketPriceByCrop: new Map(), insuranceByCrop, govtByCrop,
    })

    // Per-crop identity: RevProj profit − dashboard per-crop profit === ins + govt.
    for (const r of rows) {
      const mr = marketingRows.find((m) => m.cropId === r.cropId)!
      const insNet = insuranceByCrop.get(r.cropId)?.netPnl ?? 0
      const g = govtByCrop.get(r.cropId)
      const govtTotal = g ? g.arcPlc + g.cropSpecificOther + g.allocatedOther : 0
      expect(r.profit! - mr.totalProfit!).toBeCloseTo(insNet + govtTotal, 6)
    }

    // The zero-safety-net crop must match EXACTLY (no insurance, no government).
    const wheatRow = rows.find((r) => r.cropId === 'wheat')!
    const wheatMr = marketingRows.find((m) => m.cropId === 'wheat')!
    expect(wheatRow.cropSalesRevenue).toBe(wheatMr.blendedRevenue)
    expect(wheatRow.profit).toBe(wheatMr.totalProfit)

    // Grand total: RevProj total profit − dashboard total profit === Σ(ins + govt).
    const insTotal = [...insuranceByCrop.values()].reduce((s, i) => s + i.netPnl, 0)
    const govtTotal = [...govtByCrop.values()].reduce((s, g) => s + g.arcPlc + g.cropSpecificOther + g.allocatedOther, 0)
    expect(totals.profit - dash.totalProfit!).toBeCloseTo(insTotal + govtTotal, 6)
  })
})
