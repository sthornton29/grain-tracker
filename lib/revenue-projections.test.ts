import { describe, it, expect } from 'vitest'
import { computeRevenueProjections } from '@/lib/revenue-projections'
import type { InsuranceProceeds, GovtProceeds } from '@/lib/revenue-projections'
import type { MarketingRow } from '@/lib/marketing'
import type { Contract } from '@/lib/types'

// All expected values are hand-derived from the formulas in
// lib/revenue-projections.ts, NOT copied from output. Key formulas:
//
//   cropSalesRevenue = round2(marketingRow.blendedRevenue)   // single source of truth
//   avgSalesPrice    = totalProduction>0 ? blendedRevenue/totalProduction : null
//   salesPriceSource = totalProduction>0 ? 'blended' : null
//   pricedBu/Revenue : summed over contracts with a non-null cash_price (display + marketPrice)
//   marketPrice      = marketPriceByCrop ?? (pricedBu>0 ? pricedRevenue/pricedBu : null)  // breakeven only
//   govtPayments     = round2(arcPlc + cropSpecificOther + allocatedOther)
//   totalRevenue     = round2(cropSalesRevenue + ins.netPnl + govtPayments)
//   totalCost        = round2(costPerAcre * acres)  (0 if costPerAcre null)
//   profit           = round2(totalRevenue - totalCost)  (null if costPerAcre null)
//   breakevenPrice   = round2(costPerAcre / yield)         (null if no cost/yield)
//   breakevenYield   = round2(costPerAcre / totalAvgPrice) (null if no cost/avg price)
//     -- the sales-only marketing breakeven, identical to the Marketing dashboard;
//        the insurance/government safety net is NOT folded in.
//
// Totals: profit = anyCost ? round2(totalRevenue - totalCost) : totalRevenue;
//   costPerAcre = (acres>0 && anyCost) ? round2(totalCost/acres) : null.

function mrow(over: Partial<MarketingRow> & Pick<MarketingRow, 'cropId'>): MarketingRow {
  return {
    cropName: over.cropName ?? over.cropId,
    unit: 'bu', cottonBales: null, cottonPhysical: null, seed: null,
    acres: 0, yield: null, yieldLabel: 'Est.', totalProduction: 0,
    contractedBu: 0, remaining: 0, avgCashPrice: null, excludedAwaitingBu: 0,
    futuresPricedBu: 0, physicalFuturesBu: 0, physicalFuturesAvg: null,
    openHedgeBu: 0, openHedgeAvg: null, rawAvgFutures: null,
    hedgeRealizedPnl: 0, hedgeAdjPerBu: 0, avgFutures: null,
    avgBasis: 0, avgBasisAssumed: true, assumedBasis: 0, assumedFutures: null,
    basisLockedBu: 0, basisLockedAvg: null, basisAssumedBu: 0, basisState: 'assumed',
    totalAvgPrice: null,
    unpricedBu: 0, blendedRevenue: 0, unpricedFuturesPrice: 0,
    costPerAcre: null, costPerBu: null, revenuePerAcre: null, profitPerAcre: null, totalProfit: null,
    openFuturesHedgedBu: 0,
    futuresSources: [], lockedPriceBu: 0, futuresAssumedBu: 0,
    ...over,
  }
}

function contract(over: Partial<Contract> & Pick<Contract, 'crop_id' | 'crop_year'>): Contract {
  return {
    id: 'c-' + Math.random().toString(36).slice(2), contract_number: 'CN', buyer_id: null, entity_id: null,
    contracted_bushels: 0, price_per_bushel: null, notes: null, delivery_type: 'pickup',
    delivery_location_id: null, delivery_start_date: null, delivery_end_date: null, date_sold: null, completed_at: null,
    created_at: '2026-01-01', contract_month: null, contract_type: 'forward', futures_price: null,
    basis: null, cash_price: null, service_fee: 0, futures_set_date: null, basis_set_date: null,
    pricing_status: 'fully_priced', ...over,
  }
}

const ins = (netPnl: number, totalIndemnity = 0, premium = 0): InsuranceProceeds => ({ netPnl, totalIndemnity, premium })
const govt = (arcPlc = 0, cropSpecificOther = 0, allocatedOther = 0): GovtProceeds => ({ arcPlc, cropSpecificOther, allocatedOther })

const CY = 2026

describe('computeRevenueProjections — single crop revenue rollup', () => {
  it('canonical worked example: crop sales = blended revenue, plus insurance + govt', () => {
    // 1,000 ac corn, 180,000 bu. Marketing blended revenue = 810,000 (the single
    // source of truth — already nets realized hedge P&L). Effective price = 4.50.
    // insurance netPnl 25,000; govt 12,000+3,000+1,500 = 16,500.
    // totalRevenue = 810,000 + 25,000 + 16,500 = 851,500.
    // cost 600/ac → 600,000; profit = 251,500; profit/ac = 251.50.
    // Breakeven is sales-only (cost ÷ price / yield), independent of the safety net:
    // breakevenPrice = 600/180 = 3.33; breakevenYield = 600/4.50 = 133.33.
    const m = mrow({
      cropId: 'corn', cropName: 'Corn', acres: 1000, yield: 180, yieldLabel: 'Actual',
      totalProduction: 180000, blendedRevenue: 810000, totalAvgPrice: 4.5, costPerAcre: 600,
    })
    const { rows, totals } = computeRevenueProjections({
      marketingRows: [m], contracts: [], cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.2]]),
      insuranceByCrop: new Map([['corn', ins(25000, 40000, 15000)]]),
      govtByCrop: new Map([['corn', govt(12000, 3000, 1500)]]),
    })
    const r = rows[0]
    expect(r.cropSalesRevenue).toBeCloseTo(810000, 2)
    expect(r.avgSalesPrice).toBeCloseTo(4.5, 6)       // 810,000 / 180,000
    expect(r.salesPriceSource).toBe('blended')
    expect(r.insuranceProceeds).toBeCloseTo(25000, 2)
    expect(r.govtPayments).toBeCloseTo(16500, 2)
    expect(r.totalRevenue).toBeCloseTo(851500, 2)
    expect(r.totalCost).toBeCloseTo(600000, 2)
    expect(r.profit).toBeCloseTo(251500, 2)
    expect(r.profitPerAcre).toBeCloseTo(251.5, 2)
    expect(r.marketPrice).toBeCloseTo(4.2, 2)
    expect(r.totalAvgPrice).toBeCloseTo(4.5, 6)     // no assumed futures → the total avg price
    expect(r.breakevenPrice).toBeCloseTo(3.33, 2)   // 600 / 180
    expect(r.breakevenYield).toBeCloseTo(133.33, 2) // 600 / 4.50

    expect(totals.cropSalesRevenue).toBeCloseTo(810000, 2)
    expect(totals.totalRevenue).toBeCloseTo(851500, 2)
    expect(totals.profit).toBeCloseTo(251500, 2)
    expect(totals.costPerAcre).toBeCloseTo(600, 2)
    expect(totals.profitPerAcre).toBeCloseTo(251.5, 2)
  })
})

describe('computeRevenueProjections — priced contracts & marketPrice (breakeven) fallback', () => {
  it('derives pricedBu/marketPrice from cash contracts; crop sales = blended revenue', () => {
    // Two priced contracts: 10,000 @ 4.00 + 5,000 @ 4.60 → pricedBu 15,000, pricedRevenue 63,000.
    // A null-cash contract is ignored. No explicit market price → marketPrice = 63,000/15,000 = 4.20.
    // cropSalesRevenue comes from blendedRevenue (84,000), independent of pricedRevenue.
    const m = mrow({ cropId: 'beans', cropName: 'Soybeans', acres: 200, totalProduction: 20000, blendedRevenue: 84000 })
    const contracts: Contract[] = [
      contract({ crop_id: 'beans', crop_year: CY, contracted_bushels: 10000, cash_price: 4.0 }),
      contract({ crop_id: 'beans', crop_year: CY, contracted_bushels: 5000, cash_price: 4.6 }),
      contract({ crop_id: 'beans', crop_year: CY, contracted_bushels: 9999, cash_price: null }),
    ]
    const { rows } = computeRevenueProjections({
      marketingRows: [m], contracts, cropYear: CY, marketPriceByCrop: new Map(), insuranceByCrop: new Map(),
    })
    const r = rows[0]
    expect(r.pricedBu).toBe(15000)
    expect(r.pricedRevenue).toBeCloseTo(63000, 2)
    expect(r.uncontractedBu).toBe(5000)
    expect(r.marketPrice).toBeCloseTo(4.2, 2)
    expect(r.cropSalesRevenue).toBeCloseTo(84000, 2)
    expect(r.avgSalesPrice).toBeCloseTo(4.2, 4)        // 84,000 / 20,000
    expect(r.salesPriceSource).toBe('blended')
    expect(r.totalRevenue).toBeCloseTo(84000, 2)
    expect(r.profit).toBeNull()
  })

  it('marketPrice ignores contracts for other crops and other crop years', () => {
    const m = mrow({ cropId: 'corn', acres: 100, totalProduction: 10000, blendedRevenue: 50000 })
    const contracts: Contract[] = [
      contract({ crop_id: 'corn', crop_year: CY, contracted_bushels: 1000, cash_price: 5.0 }),
      contract({ crop_id: 'corn', crop_year: CY - 1, contracted_bushels: 9999, cash_price: 5.0 }),
      contract({ crop_id: 'beans', crop_year: CY, contracted_bushels: 9999, cash_price: 5.0 }),
    ]
    const { rows } = computeRevenueProjections({
      marketingRows: [m], contracts, cropYear: CY, marketPriceByCrop: new Map(), insuranceByCrop: new Map(),
    })
    expect(rows[0].pricedBu).toBe(1000)
    expect(rows[0].pricedRevenue).toBeCloseTo(5000, 2)
    expect(rows[0].marketPrice).toBeCloseTo(5.0, 2)
  })
})

describe('computeRevenueProjections — edge cases', () => {
  it('zero blended revenue → cropSalesRevenue 0; insurance still flows', () => {
    // blendedRevenue 0 (e.g. no marketing value yet). totalProduction 5,000 > 0 so
    // avgSalesPrice = 0 and source 'blended'. totalRevenue = 0 + ins 2,000 = 2,000.
    const m = mrow({ cropId: 'milo', acres: 50, totalProduction: 5000, blendedRevenue: 0 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m], contracts: [], cropYear: CY,
      marketPriceByCrop: new Map(), insuranceByCrop: new Map([['milo', ins(2000)]]),
    })
    const r = rows[0]
    expect(r.cropSalesRevenue).toBeCloseTo(0, 2)
    expect(r.avgSalesPrice).toBeCloseTo(0, 6)
    expect(r.salesPriceSource).toBe('blended')
    expect(r.marketPrice).toBeNull()
    expect(r.totalRevenue).toBeCloseTo(2000, 2)
    expect(r.breakevenYield).toBeNull()
  })

  it('zero production → avgSalesPrice/source null; zero acres → per-acre null', () => {
    const m = mrow({ cropId: 'corn', acres: 0, totalProduction: 0, costPerAcre: 700, blendedRevenue: 0 })
    const { rows, totals } = computeRevenueProjections({
      marketingRows: [m], contracts: [], cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.2]]), insuranceByCrop: new Map(),
    })
    const r = rows[0]
    expect(r.avgSalesPrice).toBeNull()
    expect(r.salesPriceSource).toBeNull()
    expect(r.cropSalesRevenue).toBeCloseTo(0, 2)
    expect(r.totalCost).toBeCloseTo(0, 2)
    expect(r.revenuePerAcre).toBeNull()
    expect(r.profit).toBeCloseTo(0, 2)
    expect(r.profitPerAcre).toBeNull()
    expect(r.breakevenPrice).toBeNull()
    expect(totals.costPerAcre).toBeNull()
    expect(totals.profitPerAcre).toBeNull()
  })

  it('insurance loss reduces revenue; breakeven stays the sales-only cost ÷ price', () => {
    // 100 ac, 10,000 bu (yield 100), avg price 4.00, cost 500/ac. insurance −5,000.
    // totalRevenue = 40,000 − 5,000 = 35,000; profit = 35,000 − 50,000 = −15,000.
    // Breakeven is NOT moved by the insurance loss (sales-only, like the dashboard):
    // price = 500/100 = 5.00; yield = 500/4.00 = 125.0.
    const m = mrow({ cropId: 'corn', acres: 100, yield: 100, totalProduction: 10000, totalAvgPrice: 4.0, blendedRevenue: 40000, costPerAcre: 500 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m], contracts: [], cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.0]]), insuranceByCrop: new Map([['corn', ins(-5000, 0, 5000)]]),
    })
    const r = rows[0]
    expect(r.totalRevenue).toBeCloseTo(35000, 2)
    expect(r.profit).toBeCloseTo(-15000, 2)
    expect(r.breakevenPrice).toBeCloseTo(5.0, 2)
    expect(r.breakevenYield).toBeCloseTo(125.0, 2)
  })

  it('breakeven yield = cost ÷ average price, matching the Marketing dashboard (corn 969/5.06)', () => {
    // The reported case: cost 969/ac, average price 5.06 -> breakeven yield 191.5,
    // independent of the safety net and the market price -- the same figure the
    // Marketing dashboard shows (cost / Total Avg Price).
    const m = mrow({ cropId: 'corn', acres: 1000, yield: 190, totalProduction: 190000, totalAvgPrice: 5.06, blendedRevenue: 961400, costPerAcre: 969 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m], contracts: [], cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.5]]),               // a different "market" price must NOT change breakeven
      insuranceByCrop: new Map([['corn', ins(30000)]]),          // safety net present...
      govtByCrop: new Map([['corn', govt(20000)]]),              // ...but excluded from breakeven
    })
    const r = rows[0]
    expect(r.breakevenYield).toBeCloseTo(191.5, 2)   // 969 / 5.06
    expect(r.breakevenPrice).toBeCloseTo(5.1, 2)     // 969 / 190
  })

  it('breakeven yield divides by the effective (headline) price when an assumed futures is set', () => {
    // With an assumed futures the large "Total avg price" is the effective price,
    // revenue ÷ production = 506,000 / 100,000 = 5.06 — NOT the futures+basis total
    // (5.30). Breakeven yield = 969 / 5.06 = 191.5, not 969 / 5.30 = 182.8.
    const m = mrow({
      cropId: 'corn', acres: 500, yield: 200, totalProduction: 100000,
      blendedRevenue: 506000, totalAvgPrice: 5.3, assumedFutures: 4.8, costPerAcre: 969,
    })
    const { rows } = computeRevenueProjections({
      marketingRows: [m], contracts: [], cropYear: CY,
      marketPriceByCrop: new Map(), insuranceByCrop: new Map(),
    })
    expect(rows[0].totalAvgPrice).toBeCloseTo(5.06, 6)     // the large headline price = 506,000 / 100,000
    expect(rows[0].breakevenYield).toBeCloseTo(191.5, 1)   // 969 / 5.06, not 969 / 5.30
  })

  it('no cost → profit null and breakeven null', () => {
    const m = mrow({ cropId: 'corn', acres: 100, totalProduction: 10000, blendedRevenue: 40000 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m], contracts: [], cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.0]]), insuranceByCrop: new Map(),
    })
    expect(rows[0].totalCost).toBeCloseTo(0, 2)
    expect(rows[0].profit).toBeNull()
    expect(rows[0].breakevenPrice).toBeNull()
  })
})

describe('computeRevenueProjections — multi-crop aggregation', () => {
  it('sums two crops; totals roll up the rows', () => {
    // CORN blended 810,000; ins 25,000; govt 16,500 → revenue 851,500; cost 600,000.
    // BEANS blended 275,000; govt 4,000 → revenue 279,000; cost 175,000.
    // Totals: acres 1,500; sales 1,085,000; ins 25,000; govt 20,500; revenue 1,130,500;
    //   cost 775,000; profit 355,500; rev/ac 753.67; cost/ac 516.67; profit/ac 237.00.
    const corn = mrow({ cropId: 'corn', cropName: 'Corn', acres: 1000, totalProduction: 180000, blendedRevenue: 810000, costPerAcre: 600 })
    const beans = mrow({ cropId: 'beans', cropName: 'Soybeans', acres: 500, totalProduction: 25000, blendedRevenue: 275000, costPerAcre: 350 })
    const { rows, totals } = computeRevenueProjections({
      marketingRows: [corn, beans], contracts: [], cropYear: CY,
      marketPriceByCrop: new Map(),
      insuranceByCrop: new Map([['corn', ins(25000, 40000, 15000)]]),
      govtByCrop: new Map([['corn', govt(12000, 3000, 1500)], ['beans', govt(4000)]]),
    })
    expect(rows).toHaveLength(2)
    expect(rows[1].cropSalesRevenue).toBeCloseTo(275000, 2)
    expect(rows[1].totalRevenue).toBeCloseTo(279000, 2)
    expect(totals.acres).toBe(1500)
    expect(totals.cropSalesRevenue).toBeCloseTo(1085000, 2)
    expect(totals.govtPayments).toBeCloseTo(20500, 2)
    expect(totals.totalRevenue).toBeCloseTo(1130500, 2)
    expect(totals.totalCost).toBeCloseTo(775000, 2)
    expect(totals.profit).toBeCloseTo(355500, 2)
    expect(totals.revenuePerAcre).toBeCloseTo(753.67, 2)
    expect(totals.costPerAcre).toBeCloseTo(516.67, 2)
    expect(totals.profitPerAcre).toBeCloseTo(237.0, 2)
  })

  it('no crop has cost → totals.profit equals totalRevenue and costPerAcre is null', () => {
    const corn = mrow({ cropId: 'corn', acres: 100, totalProduction: 1000, blendedRevenue: 4000 })
    const beans = mrow({ cropId: 'beans', acres: 100, totalProduction: 500, blendedRevenue: 5000 })
    const { totals } = computeRevenueProjections({
      marketingRows: [corn, beans], contracts: [], cropYear: CY, marketPriceByCrop: new Map(), insuranceByCrop: new Map(),
    })
    expect(totals.totalCost).toBeCloseTo(0, 2)
    expect(totals.totalRevenue).toBeCloseTo(9000, 2)
    expect(totals.profit).toBeCloseTo(9000, 2)
    expect(totals.costPerAcre).toBeNull()
    expect(totals.profitPerAcre).toBeCloseTo(45.0, 2)
  })

  it('empty input → zeroed totals with null per-acre figures', () => {
    const { rows, totals } = computeRevenueProjections({
      marketingRows: [], contracts: [], cropYear: CY, marketPriceByCrop: new Map(), insuranceByCrop: new Map(),
    })
    expect(rows).toHaveLength(0)
    expect(totals.totalRevenue).toBeCloseTo(0, 2)
    expect(totals.profit).toBeCloseTo(0, 2)
    expect(totals.revenuePerAcre).toBeNull()
    expect(totals.costPerAcre).toBeNull()
  })
})
