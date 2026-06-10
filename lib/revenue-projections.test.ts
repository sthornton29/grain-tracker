import { describe, it, expect } from 'vitest'
import { computeRevenueProjections } from '@/lib/revenue-projections'
import type { InsuranceProceeds, GovtProceeds } from '@/lib/revenue-projections'
import type { MarketingRow } from '@/lib/marketing'
import type { Contract } from '@/lib/types'

// All expected values below are hand-derived from the formulas in
// lib/revenue-projections.ts, NOT copied from the function's output. Key formulas:
//
//   pricedBu / pricedRevenue : summed over contracts with a non-null cash_price
//   uncontractedBu           = max(0, totalProduction - pricedBu)
//   marketPrice              = marketPriceByCrop ?? (pricedBu>0 ? pricedRevenue/pricedBu : null)
//   avgSalesPrice            = totalAvgPrice ?? avgCashPrice ?? marketPrice
//   salesPriceSource         = 'futures+basis' | 'cash' | 'market' | null  (in that priority)
//   cropSalesRevenue         = round2(avgSalesPrice * totalProduction)   (0 if avgSalesPrice null)
//   govtPayments             = round2(arcPlc + cropSpecificOther + allocatedOther)
//   totalRevenue             = round2(cropSalesRevenue + ins.netPnl + govtPayments)
//   revenuePerAcre           = round2(totalRevenue / acres)  (null if acres<=0)
//   totalCost                = round2(costPerAcre * acres)  (0 if costPerAcre null)
//   profit                   = round2(totalRevenue - totalCost)  (null if costPerAcre null)
//   profitPerAcre            = round2(profit / acres)  (null if profit null or acres<=0)
//   needFromSales            = max(0, totalCost - ins.netPnl - govtPayments)  (null if no cost)
//   breakevenPrice           = round2(needFromSales / totalProduction)  (null if prod<=0)
//   breakevenYield           = round2(needFromSales / (marketPrice * acres))  (null if mkt<=0)
//
// Totals: per-field sums, with totalCost summed over rows, and:
//   profit        = anyCost ? round2(totalRevenue - totalCost) : totalRevenue
//   costPerAcre   = (acres>0 && anyCost) ? round2(totalCost / acres) : null
//   profitPerAcre = round2((anyCost ? profit : totalRevenue) / acres)
//
// round2(n) = Math.round(n*100)/100; avgSalesPrice is rounded to 4 decimals.

// ----------------------------------------------------------------------------
// Fixture builders — minimal objects with only the fields the function reads.
// ----------------------------------------------------------------------------

function mrow(over: Partial<MarketingRow> & Pick<MarketingRow, 'cropId'>): MarketingRow {
  return {
    cropName: over.cropName ?? over.cropId,
    acres: 0,
    yield: null,
    yieldLabel: 'Est.',
    totalProduction: 0,
    contractedBu: 0,
    remaining: 0,
    avgCashPrice: null,
    excludedAwaitingBu: 0,
    avgFutures: null,
    avgBasis: null,
    totalAvgPrice: null,
    costPerAcre: null,
    costPerBu: null,
    profitPerAcre: null,
    totalProfit: null,
    openFuturesHedgedBu: 0,
    ...over,
  }
}

function contract(over: Partial<Contract> & Pick<Contract, 'crop_id' | 'crop_year'>): Contract {
  return {
    id: 'c-' + Math.random().toString(36).slice(2),
    contract_number: 'CN',
    buyer_id: null,
    entity_id: null,
    contracted_bushels: 0,
    price_per_bushel: null,
    notes: null,
    delivery_type: 'pickup',
    delivery_location_id: null,
    delivery_start_date: null,
    delivery_end_date: null,
    completed_at: null,
    created_at: '2026-01-01',
    contract_month: null,
    contract_type: 'forward',
    futures_price: null,
    basis: null,
    cash_price: null,
    service_fee: 0,
    futures_set_date: null,
    basis_set_date: null,
    pricing_status: 'fully_priced',
    ...over,
  }
}

const ins = (netPnl: number, totalIndemnity = 0, premium = 0): InsuranceProceeds => ({
  netPnl,
  totalIndemnity,
  premium,
})
const govt = (arcPlc = 0, cropSpecificOther = 0, allocatedOther = 0): GovtProceeds => ({
  arcPlc,
  cropSpecificOther,
  allocatedOther,
})

const CY = 2026

// ----------------------------------------------------------------------------
// Per-crop revenue = crop sales + net insurance + government payments
// ----------------------------------------------------------------------------

describe('computeRevenueProjections — single crop revenue rollup', () => {
  it('canonical worked example: corn with sales + insurance + govt', () => {
    // 1,000 ac corn, 180 bu/ac → totalProduction = 180,000 bu.
    // avgSalesPrice priority: totalAvgPrice (4.50) wins over avgCashPrice/market.
    // cropSalesRevenue = round2(4.50 * 180000) = 810,000.00
    // insurance netPnl = 25,000 (indemnity 40,000 − premium 15,000).
    // govt = 12,000 + 3,000 + 1,500 = 16,500.
    // totalRevenue = 810,000 + 25,000 + 16,500 = 851,500.00
    // revenuePerAcre = 851,500 / 1000 = 851.50
    // costPerAcre 600 → totalCost = 600,000; profit = 851,500 − 600,000 = 251,500
    // profitPerAcre = 251,500 / 1000 = 251.50
    // needFromSales = max(0, 600,000 − 25,000 − 16,500) = 558,500
    // marketPrice = 4.20 (explicit) → breakevenPrice = 558,500 / 180,000 = 3.102777… → 3.10
    // breakevenYield = 558,500 / (4.20 * 1000) = 558,500 / 4200 = 132.976… → 132.98
    const m = mrow({
      cropId: 'corn',
      cropName: 'Corn',
      acres: 1000,
      yield: 180,
      yieldLabel: 'Actual',
      totalProduction: 180000,
      totalAvgPrice: 4.5,
      avgCashPrice: 4.4,
      costPerAcre: 600,
    })
    const { rows, totals } = computeRevenueProjections({
      marketingRows: [m],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.2]]),
      insuranceByCrop: new Map([['corn', ins(25000, 40000, 15000)]]),
      govtByCrop: new Map([['corn', govt(12000, 3000, 1500)]]),
    })
    const r = rows[0]

    expect(r.avgSalesPrice).toBeCloseTo(4.5, 6)
    expect(r.salesPriceSource).toBe('futures+basis')
    expect(r.cropSalesRevenue).toBeCloseTo(810000, 2)
    expect(r.insuranceProceeds).toBeCloseTo(25000, 2)
    expect(r.insuranceIndemnity).toBeCloseTo(40000, 2)
    expect(r.insurancePremium).toBeCloseTo(15000, 2)
    expect(r.govtPayments).toBeCloseTo(16500, 2)
    expect(r.govtArcPlc).toBeCloseTo(12000, 2)
    expect(r.govtCropSpecificOther).toBeCloseTo(3000, 2)
    expect(r.govtAllocatedOther).toBeCloseTo(1500, 2)

    expect(r.totalRevenue).toBeCloseTo(851500, 2)
    expect(r.revenuePerAcre).toBeCloseTo(851.5, 2)
    expect(r.totalCost).toBeCloseTo(600000, 2)
    expect(r.profit).toBeCloseTo(251500, 2)
    expect(r.profitPerAcre).toBeCloseTo(251.5, 2)

    expect(r.marketPrice).toBeCloseTo(4.2, 2)
    expect(r.breakevenPrice).toBeCloseTo(3.1, 2)
    expect(r.breakevenYield).toBeCloseTo(132.98, 2)

    // single-crop totals mirror the row (anyCost true → profit = rev − cost)
    expect(totals.acres).toBe(1000)
    expect(totals.totalProduction).toBe(180000)
    expect(totals.cropSalesRevenue).toBeCloseTo(810000, 2)
    expect(totals.totalRevenue).toBeCloseTo(851500, 2)
    expect(totals.totalCost).toBeCloseTo(600000, 2)
    expect(totals.profit).toBeCloseTo(251500, 2)
    expect(totals.costPerAcre).toBeCloseTo(600, 2)
    expect(totals.revenuePerAcre).toBeCloseTo(851.5, 2)
    expect(totals.profitPerAcre).toBeCloseTo(251.5, 2)
  })
})

// ----------------------------------------------------------------------------
// Priced-contract revenue + marketPrice fallback to priced average.
// ----------------------------------------------------------------------------

describe('computeRevenueProjections — priced contracts & marketPrice fallback', () => {
  it('sums only contracts with a cash_price; derives marketPrice from priced avg', () => {
    // Two priced contracts: 10,000 bu @ 4.00 and 5,000 bu @ 4.60.
    //   pricedBu = 15,000; pricedRevenue = 40,000 + 23,000 = 63,000
    // One contract with null cash_price → ignored entirely.
    // No explicit market price → marketPrice = pricedRevenue/pricedBu = 63,000/15,000 = 4.20
    // totalProduction 20,000 → uncontractedBu = max(0, 20,000 − 15,000) = 5,000
    // No totalAvgPrice/avgCashPrice → avgSalesPrice = marketPrice = 4.20, source 'market'
    // cropSalesRevenue = round2(4.20 * 20,000) = 84,000.00
    // no insurance/govt/cost → totalRevenue = 84,000; profit null (no cost)
    const m = mrow({
      cropId: 'beans',
      cropName: 'Soybeans',
      acres: 200,
      totalProduction: 20000,
    })
    const contracts: Contract[] = [
      contract({ crop_id: 'beans', crop_year: CY, contracted_bushels: 10000, cash_price: 4.0 }),
      contract({ crop_id: 'beans', crop_year: CY, contracted_bushels: 5000, cash_price: 4.6 }),
      contract({ crop_id: 'beans', crop_year: CY, contracted_bushels: 9999, cash_price: null }),
    ]
    const { rows } = computeRevenueProjections({
      marketingRows: [m],
      contracts,
      cropYear: CY,
      marketPriceByCrop: new Map(),
      insuranceByCrop: new Map(),
    })
    const r = rows[0]
    expect(r.pricedBu).toBe(15000)
    expect(r.pricedRevenue).toBeCloseTo(63000, 2)
    expect(r.uncontractedBu).toBe(5000)
    expect(r.marketPrice).toBeCloseTo(4.2, 2)
    expect(r.avgSalesPrice).toBeCloseTo(4.2, 4)
    expect(r.salesPriceSource).toBe('market')
    expect(r.cropSalesRevenue).toBeCloseTo(84000, 2)
    expect(r.totalRevenue).toBeCloseTo(84000, 2)
    expect(r.insuranceProceeds).toBeCloseTo(0, 2)
    expect(r.govtPayments).toBeCloseTo(0, 2)
    expect(r.profit).toBeNull()
    expect(r.profitPerAcre).toBeNull()
  })

  it('ignores contracts for other crops and other crop years', () => {
    // Only the matching crop_id + crop_year contributes to pricedBu/Revenue.
    const m = mrow({ cropId: 'corn', acres: 100, totalProduction: 10000 })
    const contracts: Contract[] = [
      contract({ crop_id: 'corn', crop_year: CY, contracted_bushels: 1000, cash_price: 5.0 }),
      contract({ crop_id: 'corn', crop_year: CY - 1, contracted_bushels: 9999, cash_price: 5.0 }), // wrong year
      contract({ crop_id: 'beans', crop_year: CY, contracted_bushels: 9999, cash_price: 5.0 }), // wrong crop
    ]
    const { rows } = computeRevenueProjections({
      marketingRows: [m],
      contracts,
      cropYear: CY,
      marketPriceByCrop: new Map(),
      insuranceByCrop: new Map(),
    })
    // Only the 1,000 bu @ 5.00 counts → pricedBu 1000, pricedRevenue 5000, mktPrice 5.00
    expect(rows[0].pricedBu).toBe(1000)
    expect(rows[0].pricedRevenue).toBeCloseTo(5000, 2)
    expect(rows[0].marketPrice).toBeCloseTo(5.0, 2)
  })
})

// ----------------------------------------------------------------------------
// Sales-price source priority: cash beats market when no futures+basis.
// ----------------------------------------------------------------------------

describe('computeRevenueProjections — avgSalesPrice source priority', () => {
  it('uses avgCashPrice (source "cash") when totalAvgPrice is null', () => {
    // totalAvgPrice null, avgCashPrice 4.75 present → avgSalesPrice = 4.75, source 'cash'
    // cropSalesRevenue = round2(4.75 * 1000) = 4,750.00
    const m = mrow({ cropId: 'corn', acres: 10, totalProduction: 1000, avgCashPrice: 4.75 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.2]]), // present but lower priority
      insuranceByCrop: new Map(),
    })
    expect(rows[0].avgSalesPrice).toBeCloseTo(4.75, 4)
    expect(rows[0].salesPriceSource).toBe('cash')
    expect(rows[0].cropSalesRevenue).toBeCloseTo(4750, 2)
  })
})

// ----------------------------------------------------------------------------
// Edge cases: missing price, zero acres, zero production, insurance loss.
// ----------------------------------------------------------------------------

describe('computeRevenueProjections — edge cases', () => {
  it('missing price entirely → cropSalesRevenue 0, source null, no inflated revenue', () => {
    // No totalAvgPrice, no avgCashPrice, no marketPrice, no priced contracts →
    // avgSalesPrice null → cropSalesRevenue = 0. Insurance still flows through.
    // totalRevenue = 0 + ins.netPnl(2000) + govt(0) = 2,000.
    const m = mrow({ cropId: 'milo', acres: 50, totalProduction: 5000 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map(),
      insuranceByCrop: new Map([['milo', ins(2000)]]),
    })
    const r = rows[0]
    expect(r.avgSalesPrice).toBeNull()
    expect(r.salesPriceSource).toBeNull()
    expect(r.cropSalesRevenue).toBeCloseTo(0, 2)
    expect(r.marketPrice).toBeNull()
    expect(r.totalRevenue).toBeCloseTo(2000, 2)
    // marketPrice null → breakevenYield null even though there is a cost? No cost here → null too.
    expect(r.breakevenYield).toBeNull()
  })

  it('zero acres → revenuePerAcre/profitPerAcre null; zero production → breakevenPrice null', () => {
    // acres 0, production 0, costPerAcre set. totalCost = round2(700*0)=0.
    // revenuePerAcre null (acres<=0); profit = round2(totalRev − 0); profitPerAcre null.
    // breakevenPrice null (production<=0); breakevenYield null (acres<=0).
    const m = mrow({ cropId: 'corn', acres: 0, totalProduction: 0, costPerAcre: 700, totalAvgPrice: 4.5 })
    const { rows, totals } = computeRevenueProjections({
      marketingRows: [m],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.2]]),
      insuranceByCrop: new Map(),
    })
    const r = rows[0]
    expect(r.cropSalesRevenue).toBeCloseTo(0, 2) // 4.5 * 0
    expect(r.totalCost).toBeCloseTo(0, 2)
    expect(r.revenuePerAcre).toBeNull()
    expect(r.profit).toBeCloseTo(0, 2) // costPerAcre non-null → profit = 0 − 0 = 0
    expect(r.profitPerAcre).toBeNull()
    expect(r.breakevenPrice).toBeNull()
    expect(r.breakevenYield).toBeNull()
    // totals with acres 0 → all per-acre null
    expect(totals.revenuePerAcre).toBeNull()
    expect(totals.costPerAcre).toBeNull()
    expect(totals.profitPerAcre).toBeNull()
  })

  it('insurance loss (negative netPnl) reduces revenue and raises breakeven need', () => {
    // 100 ac, 100 bu/ac → 10,000 bu. avgSalesPrice 4.00 → cropSalesRevenue 40,000.
    // insurance netPnl = −5,000 (premium 5,000, no indemnity).
    // totalRevenue = 40,000 + (−5,000) + 0 = 35,000.
    // costPerAcre 500 → totalCost 50,000. profit = 35,000 − 50,000 = −15,000.
    // needFromSales = max(0, 50,000 − (−5,000) − 0) = 55,000.
    // breakevenPrice = 55,000 / 10,000 = 5.50.
    // marketPrice 4.00 → breakevenYield = 55,000 / (4.00 * 100) = 137.50.
    const m = mrow({ cropId: 'corn', acres: 100, totalProduction: 10000, totalAvgPrice: 4.0, costPerAcre: 500 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.0]]),
      insuranceByCrop: new Map([['corn', ins(-5000, 0, 5000)]]),
    })
    const r = rows[0]
    expect(r.insuranceProceeds).toBeCloseTo(-5000, 2)
    expect(r.totalRevenue).toBeCloseTo(35000, 2)
    expect(r.profit).toBeCloseTo(-15000, 2)
    expect(r.breakevenPrice).toBeCloseTo(5.5, 2)
    expect(r.breakevenYield).toBeCloseTo(137.5, 2)
  })

  it('breakeven need clamps to zero when insurance+govt already exceed cost', () => {
    // costPerAcre 100 over 10 ac → totalCost 1,000. ins netPnl 800, govt 500 = 1,300 covered.
    // needFromSales = max(0, 1,000 − 800 − 500) = max(0, −300) = 0.
    // breakevenPrice = 0 / production; breakevenYield = 0 / (mkt*acres) = 0.
    const m = mrow({ cropId: 'corn', acres: 10, totalProduction: 1000, totalAvgPrice: 4.0, costPerAcre: 100 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.0]]),
      insuranceByCrop: new Map([['corn', ins(800)]]),
      govtByCrop: new Map([['corn', govt(500)]]),
    })
    expect(rows[0].breakevenPrice).toBeCloseTo(0, 2)
    expect(rows[0].breakevenYield).toBeCloseTo(0, 2)
  })

  it('no cost (costPerAcre null) → totalCost 0, profit null, breakeven null', () => {
    const m = mrow({ cropId: 'corn', acres: 100, totalProduction: 10000, totalAvgPrice: 4.0 })
    const { rows } = computeRevenueProjections({
      marketingRows: [m],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.0]]),
      insuranceByCrop: new Map(),
    })
    expect(rows[0].totalCost).toBeCloseTo(0, 2)
    expect(rows[0].profit).toBeNull()
    expect(rows[0].profitPerAcre).toBeNull()
    expect(rows[0].breakevenPrice).toBeNull()
    expect(rows[0].breakevenYield).toBeNull()
  })
})

// ----------------------------------------------------------------------------
// Aggregation across multiple crops, including the mixed-cost totals rules.
// ----------------------------------------------------------------------------

describe('computeRevenueProjections — multi-crop aggregation', () => {
  it('sums two crops; totals roll up rows', () => {
    // CORN: 1,000 ac, 180,000 bu @ 4.50 = 810,000 sales; ins 25,000; govt 16,500.
    //   totalRevenue 851,500; cost 600/ac → 600,000.
    // BEANS: 500 ac, 25,000 bu @ 11.00 = 275,000 sales; ins 0; govt 4,000.
    //   cropSalesRevenue = round2(11 * 25,000) = 275,000.
    //   totalRevenue = 275,000 + 0 + 4,000 = 279,000; cost 350/ac → 175,000.
    // Totals:
    //   acres = 1,500; production = 205,000.
    //   cropSalesRevenue = 810,000 + 275,000 = 1,085,000.
    //   insuranceProceeds = 25,000 + 0 = 25,000.
    //   govtPayments = 16,500 + 4,000 = 20,500.
    //   totalRevenue = 851,500 + 279,000 = 1,130,500.
    //   totalCost = 600,000 + 175,000 = 775,000.
    //   profit (anyCost) = 1,130,500 − 775,000 = 355,500.
    //   revenuePerAcre = 1,130,500 / 1,500 = 753.6666… → 753.67
    //   costPerAcre = 775,000 / 1,500 = 516.6666… → 516.67
    //   profitPerAcre = 355,500 / 1,500 = 237.00
    const corn = mrow({
      cropId: 'corn', cropName: 'Corn', acres: 1000, totalProduction: 180000,
      totalAvgPrice: 4.5, costPerAcre: 600,
    })
    const beans = mrow({
      cropId: 'beans', cropName: 'Soybeans', acres: 500, totalProduction: 25000,
      totalAvgPrice: 11.0, costPerAcre: 350,
    })
    const { rows, totals } = computeRevenueProjections({
      marketingRows: [corn, beans],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map([['corn', 4.2], ['beans', 11.0]]),
      insuranceByCrop: new Map([['corn', ins(25000, 40000, 15000)]]),
      govtByCrop: new Map([['corn', govt(12000, 3000, 1500)], ['beans', govt(4000)]]),
    })
    expect(rows).toHaveLength(2)
    expect(rows[1].cropSalesRevenue).toBeCloseTo(275000, 2)
    expect(rows[1].totalRevenue).toBeCloseTo(279000, 2)
    expect(rows[1].totalCost).toBeCloseTo(175000, 2)

    expect(totals.acres).toBe(1500)
    expect(totals.totalProduction).toBe(205000)
    expect(totals.cropSalesRevenue).toBeCloseTo(1085000, 2)
    expect(totals.insuranceProceeds).toBeCloseTo(25000, 2)
    expect(totals.govtPayments).toBeCloseTo(20500, 2)
    expect(totals.totalRevenue).toBeCloseTo(1130500, 2)
    expect(totals.totalCost).toBeCloseTo(775000, 2)
    expect(totals.profit).toBeCloseTo(355500, 2)
    expect(totals.revenuePerAcre).toBeCloseTo(753.67, 2)
    expect(totals.costPerAcre).toBeCloseTo(516.67, 2)
    expect(totals.profitPerAcre).toBeCloseTo(237.0, 2)
  })

  it('no crop has cost → totals.profit equals totalRevenue and costPerAcre is null', () => {
    // anyCost false: profit = totalRevenue (not revenue − 0 conceptually different label),
    // costPerAcre = null, profitPerAcre = totalRevenue / acres.
    // CORN: 100 ac, 1,000 bu @ 4.00 = 4,000 sales. BEANS: 100 ac, 500 bu @ 10.00 = 5,000.
    //   totalRevenue = 4,000 + 5,000 = 9,000; acres = 200.
    //   profit = 9,000 (anyCost false); profitPerAcre = 9,000/200 = 45.00.
    const corn = mrow({ cropId: 'corn', acres: 100, totalProduction: 1000, totalAvgPrice: 4.0 })
    const beans = mrow({ cropId: 'beans', acres: 100, totalProduction: 500, totalAvgPrice: 10.0 })
    const { totals } = computeRevenueProjections({
      marketingRows: [corn, beans],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map(),
      insuranceByCrop: new Map(),
    })
    expect(totals.totalCost).toBeCloseTo(0, 2)
    expect(totals.totalRevenue).toBeCloseTo(9000, 2)
    expect(totals.profit).toBeCloseTo(9000, 2)
    expect(totals.costPerAcre).toBeNull()
    expect(totals.profitPerAcre).toBeCloseTo(45.0, 2)
  })

  it('empty input → zeroed totals with null per-acre figures', () => {
    const { rows, totals } = computeRevenueProjections({
      marketingRows: [],
      contracts: [],
      cropYear: CY,
      marketPriceByCrop: new Map(),
      insuranceByCrop: new Map(),
    })
    expect(rows).toHaveLength(0)
    expect(totals.acres).toBe(0)
    expect(totals.totalRevenue).toBeCloseTo(0, 2)
    expect(totals.profit).toBeCloseTo(0, 2) // anyCost false → totalRevenue (0)
    expect(totals.revenuePerAcre).toBeNull()
    expect(totals.costPerAcre).toBeNull()
    expect(totals.profitPerAcre).toBeNull()
  })
})
