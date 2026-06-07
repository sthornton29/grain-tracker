// Revenue Projections — assembles a per-crop financial picture for a crop year
// by combining three sources: crop sales revenue (priced contracts + uncontracted
// bushels valued at the current market price), net insurance proceeds (indemnity
// − premium from the Crop Insurance Claims Monitor engine), and government
// payments (a placeholder until that section is built). Then layers cost, profit,
// and a simple breakeven. Pure: the report fetches and computes the pieces and
// passes them in, so the page can recompute live as any source changes.

import type { Contract } from '@/lib/types'
import type { MarketingRow } from '@/lib/marketing'

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
  acres: number
  yield: number | null
  yieldLabel: 'Est.' | 'Actual'
  totalProduction: number
  // Sales
  pricedBu: number
  pricedRevenue: number
  uncontractedBu: number
  marketPrice: number | null
  // The average price applied to total production, and where it came from. The
  // futures+basis average already folds in realized futures/options P&L, so crop
  // sales revenue is reported NET of that P&L.
  avgSalesPrice: number | null
  salesPriceSource: 'futures+basis' | 'cash' | 'market' | null
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
  // Breakeven (holding the other variable fixed; ignores insurance's own
  // yield-dependence, so it's a guide rather than an exact solve).
  breakevenPrice: number | null
  breakevenYield: number | null
}

export type RevenueTotals = {
  acres: number
  totalProduction: number
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

function round2(n: number): number {
  return Math.round(n * 100) / 100
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

    // Crop sales revenue = the crop's average marketed price × total production.
    // Prefer the futures+basis average (which already incorporates realized
    // futures and options P&L), then the average cash price, then market. Because
    // the futures average folds in hedge/option P&L, this figure is NET of
    // futures/options P&L.
    const avgSalesPrice = m.totalAvgPrice ?? m.avgCashPrice ?? marketPrice
    const salesPriceSource: RevenueRow['salesPriceSource'] =
      m.totalAvgPrice != null ? 'futures+basis' : m.avgCashPrice != null ? 'cash' : marketPrice != null ? 'market' : null
    const cropSalesRevenue = avgSalesPrice != null ? round2(avgSalesPrice * m.totalProduction) : 0

    const ins = insuranceByCrop.get(m.cropId) ?? { netPnl: 0, totalIndemnity: 0, premium: 0 }
    const g = govtByCrop?.get(m.cropId) ?? { arcPlc: 0, cropSpecificOther: 0, allocatedOther: 0 }
    const govtPayments = round2(g.arcPlc + g.cropSpecificOther + g.allocatedOther)

    const totalRevenue = round2(cropSalesRevenue + ins.netPnl + govtPayments)
    const revenuePerAcre = m.acres > 0 ? round2(totalRevenue / m.acres) : null

    const costPerAcre = m.costPerAcre
    const totalCost = costPerAcre != null ? round2(costPerAcre * m.acres) : 0
    const profit = costPerAcre != null ? round2(totalRevenue - totalCost) : null
    const profitPerAcre = profit != null && m.acres > 0 ? round2(profit / m.acres) : null

    // Breakeven: dollars of crop sales still needed to cover cost after insurance
    // and government payments, converted to a per-bushel price or a per-acre yield.
    const needFromSales = costPerAcre != null ? Math.max(0, totalCost - ins.netPnl - govtPayments) : null
    const breakevenPrice = needFromSales != null && m.totalProduction > 0 ? round2(needFromSales / m.totalProduction) : null
    const breakevenYield =
      needFromSales != null && marketPrice != null && marketPrice > 0 && m.acres > 0
        ? round2(needFromSales / (marketPrice * m.acres))
        : null

    return {
      cropId: m.cropId,
      cropName: m.cropName,
      acres: m.acres,
      yield: m.yield,
      yieldLabel: m.yieldLabel,
      totalProduction: m.totalProduction,
      pricedBu,
      pricedRevenue: round2(pricedRevenue),
      uncontractedBu,
      marketPrice: marketPrice != null ? round2(marketPrice) : null,
      avgSalesPrice: avgSalesPrice != null ? Math.round(avgSalesPrice * 1e4) / 1e4 : null,
      salesPriceSource,
      cropSalesRevenue,
      insuranceProceeds: round2(ins.netPnl),
      insuranceIndemnity: round2(ins.totalIndemnity),
      insurancePremium: round2(ins.premium),
      govtPayments,
      govtArcPlc: round2(g.arcPlc),
      govtCropSpecificOther: round2(g.cropSpecificOther),
      govtAllocatedOther: round2(g.allocatedOther),
      totalRevenue,
      revenuePerAcre,
      costPerAcre,
      totalCost,
      profit,
      profitPerAcre,
      breakevenPrice,
      breakevenYield,
    }
  })

  const acres = rows.reduce((s, r) => s + r.acres, 0)
  const totalProduction = rows.reduce((s, r) => s + r.totalProduction, 0)
  const cropSalesRevenue = round2(rows.reduce((s, r) => s + r.cropSalesRevenue, 0))
  const insuranceProceeds = round2(rows.reduce((s, r) => s + r.insuranceProceeds, 0))
  const govtPayments = round2(rows.reduce((s, r) => s + r.govtPayments, 0))
  const totalRevenue = round2(rows.reduce((s, r) => s + r.totalRevenue, 0))
  const totalCost = round2(rows.reduce((s, r) => s + r.totalCost, 0))
  const anyCost = rows.some((r) => r.costPerAcre != null)
  const profit = round2(totalRevenue - totalCost)

  const totals: RevenueTotals = {
    acres,
    totalProduction,
    cropSalesRevenue,
    insuranceProceeds,
    govtPayments,
    totalRevenue,
    revenuePerAcre: acres > 0 ? round2(totalRevenue / acres) : null,
    totalCost,
    costPerAcre: acres > 0 && anyCost ? round2(totalCost / acres) : null,
    profit: anyCost ? profit : totalRevenue,
    profitPerAcre: acres > 0 ? round2((anyCost ? profit : totalRevenue) / acres) : null,
  }

  return { rows, totals }
}
