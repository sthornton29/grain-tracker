// Revenue Projections — assembles a per-crop financial picture for a crop year
// by combining three sources: crop sales revenue (priced contracts + uncontracted
// bushels valued at the current market price), net insurance proceeds (indemnity
// − premium from the Crop Insurance Claims Monitor engine), and government
// payments (a placeholder until that section is built). Then layers cost, profit,
// and a simple breakeven. Pure: the report fetches and computes the pieces and
// passes them in, so the page can recompute live as any source changes.

import type { Contract } from '@/lib/types'
import { aggregateMarketing, breakevenAvgPrice, type MarketingRow } from '@/lib/marketing'

export type InsuranceProceeds = {
  netPnl: number
  totalIndemnity: number
  premium: number
}

export type GovtProceeds = {
  arcPlc: number
  cropSpecificOther: number
  allocatedOther: number
}

export type RevenueRow = {
  cropId: string
  cropName: string
  // Mirrors the marketing row: 'bu' (bushels, $/bu) or 'lbs' (cotton lint, ¢/lb).
  // Quantity fields carry that unit; dollar fields are dollars either way.
  unit: 'bu' | 'lbs'
  acres: number
  yield: number | null
  yieldLabel: 'Est.' | 'Actual'
  totalProduction: number
  // Sales
  pricedBu: number
  pricedRevenue: number
  uncontractedBu: number
  marketPrice: number | null
  // The effective average price applied to total production (blended revenue ÷
  // production). Crop sales revenue is the marketing "blended expected revenue",
  // which values each bushel bucket at its own price and folds in realized
  // futures/options P&L exactly once.
  avgSalesPrice: number | null
  salesPriceSource: 'blended' | null
  cropSalesRevenue: number
  // Insurance
  insuranceProceeds: number
  insuranceIndemnity: number
  insurancePremium: number
  // Government payments (allocated from ARC/PLC + other USDA payments)
  govtPayments: number
  govtArcPlc: number
  govtCropSpecificOther: number
  govtAllocatedOther: number
  // Totals
  totalRevenue: number
  revenuePerAcre: number | null
  costPerAcre: number | null
  totalCost: number
  profit: number | null
  profitPerAcre: number | null
  // The Marketing dashboard's large headline "Total Avg Price" (breakevenAvgPrice):
  // the effective revenue ÷ production price once assumptions blend in, else the
  // futures+basis total. This is exactly the price breakeven yield divides into.
  totalAvgPrice: number | null
  // Breakeven (holding the other variable fixed; ignores insurance's own
  // yield-dependence, so it's a guide rather than an exact solve).
  breakevenPrice: number | null
  breakevenYield: number | null
}

export type RevenueTotals = {
  acres: number
  /** Bushels across grain rows; cotton lbs are totalProductionLbs. */
  totalProduction: number
  totalProductionLbs: number
  cropSalesRevenue: number
  insuranceProceeds: number
  govtPayments: number
  totalRevenue: number
  revenuePerAcre: number | null
  totalCost: number
  costPerAcre: number | null
  profit: number
  profitPerAcre: number | null
}

export function computeRevenueProjections(args: {
  marketingRows: MarketingRow[]
  contracts: Contract[]
  cropYear: number
  marketPriceByCrop: Map<string, number>
  insuranceByCrop: Map<string, InsuranceProceeds>
  govtByCrop?: Map<string, GovtProceeds>
}): { rows: RevenueRow[]; totals: RevenueTotals } {
  const { marketingRows, contracts, cropYear, marketPriceByCrop, insuranceByCrop, govtByCrop } = args

  const rows: RevenueRow[] = marketingRows.map((m) => {
    // Priced contract revenue: only contracts with a locked cash price.
    const cropContracts = contracts.filter((c) => c.crop_id === m.cropId && c.crop_year === cropYear)
    let pricedBu = 0
    let pricedRevenue = 0
    for (const c of cropContracts) {
      if (c.cash_price != null) {
        const b = Number(c.contracted_bushels ?? 0)
        pricedBu += b
        pricedRevenue += Number(c.cash_price) * b
      }
    }

    const uncontractedBu = Math.max(0, m.totalProduction - pricedBu)
    // Current market price for uncontracted bushels / breakeven; fall back to the
    // priced average so a missing price never inflates revenue.
    const marketPrice =
      marketPriceByCrop.get(m.cropId) ??
      (pricedBu > 0 ? pricedRevenue / pricedBu : null)

    // Crop sales revenue = the marketing "blended expected revenue": each bushel
    // bucket (flat-cash, futures+basis, open-hedge, unpriced-at-market) valued at
    // its own price, plus realized futures/options P&L counted ONCE. The single
    // source of truth — identical to what the Marketing dashboard shows. Kept at
    // FULL precision (the UI rounds at display); nothing rounded is summed below.
    const cropSalesRevenue = m.blendedRevenue
    // Effective price per unit: $/bu for grains, ¢/lb (×100) for cotton.
    const avgSalesPrice = m.totalProduction > 0
      ? (m.blendedRevenue / m.totalProduction) * (m.unit === 'lbs' ? 100 : 1)
      : null
    const salesPriceSource: RevenueRow['salesPriceSource'] = m.totalProduction > 0 ? 'blended' : null

    const ins = insuranceByCrop.get(m.cropId) ?? { netPnl: 0, totalIndemnity: 0, premium: 0 }
    const g = govtByCrop?.get(m.cropId) ?? { arcPlc: 0, cropSpecificOther: 0, allocatedOther: 0 }
    const govtPayments = g.arcPlc + g.cropSpecificOther + g.allocatedOther

    const totalRevenue = cropSalesRevenue + ins.netPnl + govtPayments
    const revenuePerAcre = m.acres > 0 ? totalRevenue / m.acres : null

    const costPerAcre = m.costPerAcre
    const totalCost = costPerAcre != null ? costPerAcre * m.acres : 0
    const profit = costPerAcre != null ? totalRevenue - totalCost : null
    const profitPerAcre = profit != null && m.acres > 0 ? profit / m.acres : null

    // Breakeven — the standard, sales-only marketing breakeven, identical to the
    // Marketing dashboard so the two pages agree:
    //   price = cost/acre ÷ expected yield        ($/bu to cover cost at this yield)
    //   yield = cost/acre ÷ breakeven avg price    (bu/ac to cover cost at that price)
    // The yield divides by the large "Total avg price" (breakevenAvgPrice — the
    // effective price over all production once assumptions blend in), the same
    // figure the dashboard headline shows. The insurance + government safety net is
    // reflected in Total Revenue / Profit above, not folded into breakeven.
    // Cotton (¢/lb, lbs): the headline avg is the row's effective ¢/lb, breakeven
    // price is ¢/lb (cost×100 ÷ lbs/ac), breakeven yield lbs/ac against that ¢.
    const beAvg = m.unit === 'lbs' ? m.totalAvgPrice : breakevenAvgPrice(m)
    const priceScale = m.unit === 'lbs' ? 100 : 1
    const breakevenPrice = costPerAcre != null && m.yield != null && m.yield > 0 ? (costPerAcre * priceScale) / m.yield : null
    const breakevenYield = costPerAcre != null && beAvg != null && beAvg > 0 ? (costPerAcre * priceScale) / beAvg : null

    return {
      cropId: m.cropId,
      cropName: m.cropName,
      unit: m.unit,
      acres: m.acres,
      yield: m.yield,
      yieldLabel: m.yieldLabel,
      totalProduction: m.totalProduction,
      pricedBu,
      pricedRevenue,
      uncontractedBu,
      marketPrice,
      avgSalesPrice,
      salesPriceSource,
      cropSalesRevenue,
      insuranceProceeds: ins.netPnl,
      insuranceIndemnity: ins.totalIndemnity,
      insurancePremium: ins.premium,
      govtPayments,
      govtArcPlc: g.arcPlc,
      govtCropSpecificOther: g.cropSpecificOther,
      govtAllocatedOther: g.allocatedOther,
      totalRevenue,
      revenuePerAcre,
      costPerAcre,
      totalCost,
      profit,
      profitPerAcre,
      totalAvgPrice: beAvg,
      breakevenPrice,
      breakevenYield,
    }
  })

  // Totals come from the SHARED aggregator (full-precision sum of per-crop blended
  // revenue + cost) — the SAME function the Marketing dashboard rolls up with — so
  // the two pages' crop-sales total and projected profit are structurally identical.
  // Revenue Projections then layers insurance + government payments on top; nothing
  // is re-summed independently here, and rounding happens only at display.
  const agg = aggregateMarketing(marketingRows)
  const insuranceProceeds = rows.reduce((s, r) => s + r.insuranceProceeds, 0)
  const govtPayments = rows.reduce((s, r) => s + r.govtPayments, 0)
  const cropSalesRevenue = agg.blendedRevenue
  const totalCost = agg.totalCost
  const totalRevenue = cropSalesRevenue + insuranceProceeds + govtPayments
  const anyCost = agg.hasCost
  const profit = anyCost ? totalRevenue - totalCost : totalRevenue

  const totals: RevenueTotals = {
    acres: agg.acres,
    totalProduction: agg.totalProduction,
    totalProductionLbs: agg.totalProductionLbs,
    cropSalesRevenue,
    insuranceProceeds,
    govtPayments,
    totalRevenue,
    revenuePerAcre: agg.acres > 0 ? totalRevenue / agg.acres : null,
    totalCost,
    costPerAcre: agg.acres > 0 && anyCost ? totalCost / agg.acres : null,
    profit,
    profitPerAcre: agg.acres > 0 ? profit / agg.acres : null,
  }

  return { rows, totals }
}
