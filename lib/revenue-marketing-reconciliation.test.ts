import { describe, it, expect } from 'vitest'
import { computeMarketing, aggregateMarketing, type Planting } from '@/lib/marketing'
import { computeRevenueProjections, type InsuranceProceeds, type GovtProceeds } from '@/lib/revenue-projections'
import { buildEntityScope } from '@/lib/entity-scope'
import type { Crop, Contract, CropAssumption } from '@/lib/types'

// Fix 4 — the Marketing dashboard and Revenue Projections share ONE revenue
// engine (lib/marketing's blendedRevenue). The only thing Revenue Projections
// adds on top is crop-insurance proceeds + government payments, so for every crop
// the two pages must satisfy this identity exactly:
//
//   RevenueProjections.profit − Marketing.totalProfit === insurance(Y) + government attributed to Y
//
// "Attributed to Y" (payment-year attribution): the government pool for crop
// year Y is the PROGRAM year Y−1's net ARC/PLC (paid October of Y) plus other
// USDA payments landing in Y — the report builds govtByCrop with
// projectPayments({ cropYear: programYearFor(Y) }) + otherPaymentsInRevenueYear.
// That year-mapping is covered by the boundary suite in
// government-payments.test.ts ("payment-year attribution"); here we assert the
// composition identity itself.
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
    date_sold: null, completed_at: null, created_at: '', contract_month: null, contract_type: 'forward',
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

// The five entity-filtered reports all scope through lib/entity-scope BEFORE
// the shared computeMarketing/aggregateMarketing layer. In this operation the
// MARKETING AGENT entity (entity_role='marketing_agent') holds the
// contracts and the hedge account and markets on behalf of the farming
// entities — the income shifts down. So agent-held (and null-entity) rows
// attribute pro-rata by the entity's acre share of the crop; a row keyed to a
// FARMING entity is own-name marketing and counts wholly toward it. The
// identity must keep holding per entity; '' (All entities) must reproduce the
// unfiltered numbers exactly; and the per-entity views must SUM back to the
// all-entities report (the regression: strict entity_id scoping dropped the
// marketing rows, showing filtered entities with full production and zero
// sales).
describe('reconciliation under an entity filter (shared attribution)', () => {
  // The real shape: TRW is the marketing agent (no farms of its own); TSF and
  // VCF farm. Corn is planted by both (TSF 600 ac / VCF 400 ac); canola ONLY
  // by VCF (800 ac).
  const entities = [
    { id: 'TSF', entity_role: 'farming' }, { id: 'VCF', entity_role: 'farming' },
    { id: 'TRW', entity_role: 'marketing_agent' },
  ]
  const farms = [{ id: 'F-TSF', entity_id: 'TSF' }, { id: 'F-VCF', entity_id: 'VCF' }]
  const fields = [{ id: 'A', farm_id: 'F-TSF' }, { id: 'B', farm_id: 'F-VCF' }, { id: 'C', farm_id: 'F-VCF' }]
  const crops = [crop('corn', 'Corn'), crop('canola', 'Canola')]
  const allPlantings = [
    { field_id: 'A', crop_id: 'corn', season_year: CY, planted_acres: 600 },
    { field_id: 'B', crop_id: 'corn', season_year: CY, planted_acres: 400 },
    { field_id: 'C', crop_id: 'canola', season_year: CY, planted_acres: 800 },
  ]
  // The agent's corn forward + a null-entity canola forward (both flow down —
  // the shapes that used to vanish) + one own-name contract keyed to TSF.
  const allContracts: Contract[] = [
    contract({ crop_id: 'corn', entity_id: 'TRW', contract_type: 'forward', contracted_bushels: 30000, cash_price: 4.9 }),
    contract({ crop_id: 'canola', contract_type: 'forward', contracted_bushels: 12000, cash_price: 11.25 }),
    contract({ crop_id: 'corn', entity_id: 'TSF', contract_type: 'forward', contracted_bushels: 5000, cash_price: 5.1 }),
  ]
  // ONE operation-wide assumption set — applies to every entity's acres.
  const assumptions = [
    assumption({ crop_id: 'corn', expected_yield: 180, cost_per_acre: 600 }),
    assumption({ crop_id: 'canola', expected_yield: 40, cost_per_acre: 400 }),
  ]
  // Canola has no traded future (like the real crop) — corn only.
  const currentFuturesByCrop = new Map([['corn', 4.5]])

  function marketingFor(entityId: string) {
    const scope = buildEntityScope({ entityId, farms, fields, entities })
    const attribution = scope.attribution({ plantings: allPlantings, crops })
    const plantings: Planting[] = scope.plantings(allPlantings)
    const contracts = attribution.contracts(allContracts)
    return {
      contracts,
      rows: computeMarketing({
        cropYear: CY, crops, plantings, contracts, futures: [], options: [],
        assumptions, actualProductionByCrop: new Map(), currentFuturesByCrop,
      }),
    }
  }

  it('a filtered entity KEEPS its sales: VCF canola prices its forward, TSF corn attributes its share', () => {
    // VCF holds ALL canola acres → the 12,000 bu @ 11.25 forward attributes
    // to VCF in full — NOT 0 bu / $0.
    const vcf = marketingFor('VCF').rows
    const vcfCanola = vcf.find((r) => r.cropId === 'canola')!
    expect(vcfCanola.contractedBu).toBeCloseTo(12000, 6)
    expect(vcfCanola.avgCashPrice).toBeCloseTo(11.25, 6)
    expect(vcfCanola.totalAvgPrice).toBeCloseTo(11.25, 6)
    expect(vcfCanola.blendedRevenue).toBeGreaterThan(0)

    // TSF has 60% of corn acres → 60% of the AGENT's 30,000 bu corn forward
    // (18,000) plus its OWN 5,000 bu own-name contract in full.
    const tsfCorn = marketingFor('TSF').rows.find((r) => r.cropId === 'corn')!
    expect(tsfCorn.contractedBu).toBeCloseTo(18000 + 5000, 6)
    // Same per-bushel prices as the all-entities report — nothing repriced.
    // Blended: 18,000×4.90 + 5,000×5.10 + 85,000 unpriced × 4.50 = 496,200.
    expect(tsfCorn.totalProduction).toBeCloseTo(108000, 2)
    expect(tsfCorn.blendedRevenue).toBeCloseTo(18000 * 4.9 + 5000 * 5.1 + 85000 * 4.5, 2)
    // VCF corn: 40% of the agent's forward, none of TSF's own-name contract.
    const vcfCorn = vcf.find((r) => r.cropId === 'corn')!
    expect(vcfCorn.contractedBu).toBeCloseTo(12000, 6)
    // TSF has no canola acres → no canola row (and no canola contract share).
    expect(marketingFor('TSF').rows.some((r) => r.cropId === 'canola')).toBe(false)
    // The agent itself farms nothing — its filtered view is empty (all of its
    // marketing income has been shifted down to the farming entities).
    expect(marketingFor('TRW').rows).toEqual([])
  })

  it('sum of every entity’s aggregate === the all-entities aggregate (acres, contracted bu, production, crop sales)', () => {
    const all = marketingFor('').rows
    const tsf = marketingFor('TSF').rows
    const vcf = marketingFor('VCF').rows
    const aggAll = aggregateMarketing(all)
    const aggTsf = aggregateMarketing(tsf)
    const aggVcf = aggregateMarketing(vcf)
    const contracted = (rows: typeof all) => rows.reduce((s, r) => s + r.contractedBu, 0)
    expect(aggTsf.acres + aggVcf.acres).toBeCloseTo(aggAll.acres, 6)
    expect(contracted(tsf) + contracted(vcf)).toBeCloseTo(contracted(all), 6)
    expect(aggTsf.totalProduction + aggVcf.totalProduction).toBeCloseTo(aggAll.totalProduction, 6)
    expect(aggTsf.blendedRevenue + aggVcf.blendedRevenue).toBeCloseTo(aggAll.blendedRevenue, 6)
    expect(aggTsf.totalCost + aggVcf.totalCost).toBeCloseTo(aggAll.totalCost, 6)
    expect(aggTsf.totalProfit! + aggVcf.totalProfit!).toBeCloseTo(aggAll.totalProfit!, 6)
  })

  it('"All entities" reproduces the unfiltered engines exactly', () => {
    const unfiltered = computeMarketing({
      cropYear: CY, crops, plantings: allPlantings, contracts: allContracts, futures: [], options: [],
      assumptions, actualProductionByCrop: new Map(), currentFuturesByCrop,
    })
    expect(marketingFor('').rows).toEqual(unfiltered)
  })

  it('RevProj profit − Marketing profit === the ENTITY’s insurance + government, under the filter', () => {
    const { rows: tsfRows, contracts: tsfContracts } = marketingFor('TSF')
    const corn = tsfRows.find((r) => r.cropId === 'corn')!
    const insuranceByCrop = new Map<string, InsuranceProceeds>([['corn', ins(12000, 20000, 8000)]])
    const govtByCrop = new Map<string, GovtProceeds>([['corn', govt(9000, 0, 1000)]])
    const { rows, totals } = computeRevenueProjections({
      marketingRows: tsfRows, contracts: tsfContracts, cropYear: CY,
      marketPriceByCrop: new Map(), insuranceByCrop, govtByCrop,
    })
    const rCorn = rows.find((r) => r.cropId === 'corn')!
    expect(rCorn.cropSalesRevenue).toBeCloseTo(corn.blendedRevenue, 6)
    expect(rCorn.profit! - corn.totalProfit!).toBeCloseTo(12000 + 10000, 6)
    expect(totals.profit - aggregateMarketing(tsfRows).totalProfit!).toBeCloseTo(22000, 6)
  })
})
