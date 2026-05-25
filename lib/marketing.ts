// Marketing dashboard computation — combines physical contracts with hedging
// (futures + options) into a per-crop marketing position for a crop year.
// Pure: callers pass already-fetched rows and an actual-production map.

import { cropToCommodity } from '@/lib/contracts'
import { CONTRACT_SIZE_BU } from '@/lib/hedging'
import type { Contract, Crop, CropAssumption, FuturesPosition, OptionPosition } from '@/lib/types'

export type MarketingRow = {
  cropId: string
  cropName: string
  acres: number
  yield: number | null
  yieldLabel: 'Est.' | 'Actual'
  totalProduction: number
  contractedBu: number
  remaining: number
  // base view
  avgCashPrice: number | null
  excludedAwaitingBu: number
  // detailed view
  avgFutures: number | null
  avgBasis: number | null
  totalAvgPrice: number | null
  costPerAcre: number | null
  costPerBu: number | null
  profitPerAcre: number | null
  totalProfit: number | null
  // for the unpriced-production section
  openFuturesHedgedBu: number
}

export type Planting = { crop_id: string; season_year: number; planted_acres: number | string | null }

function round(n: number, d = 6): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

export function computeMarketing(args: {
  cropYear: number
  crops: Crop[]
  plantings: Planting[]
  contracts: Contract[]
  futures: FuturesPosition[]
  options: OptionPosition[]
  assumptions: CropAssumption[]
  actualProductionByCrop: Map<string, number>
}): MarketingRow[] {
  const { cropYear, crops, plantings, contracts, futures, options, assumptions, actualProductionByCrop } = args

  const cropIdsWithPlantings = new Set(
    plantings.filter((p) => p.season_year === cropYear).map((p) => p.crop_id),
  )

  const rows: MarketingRow[] = []
  for (const crop of crops) {
    if (!cropIdsWithPlantings.has(crop.id)) continue

    const acres = plantings
      .filter((p) => p.crop_id === crop.id && p.season_year === cropYear)
      .reduce((s, p) => s + Number(p.planted_acres ?? 0), 0)

    const assumption = assumptions.find((a) => a.crop_id === crop.id && a.crop_year === cropYear)
    const expected = assumption?.expected_yield != null ? Number(assumption.expected_yield) : null
    const harvestComplete = assumption?.harvest_complete ?? false
    const actualProd = actualProductionByCrop.get(crop.id) ?? 0

    let yieldVal: number | null
    let yieldLabel: 'Est.' | 'Actual'
    let totalProduction: number
    if (harvestComplete && actualProd > 0) {
      totalProduction = actualProd
      yieldVal = acres > 0 ? round(actualProd / acres, 2) : null
      yieldLabel = 'Actual'
    } else {
      yieldVal = expected
      yieldLabel = 'Est.'
      totalProduction = yieldVal != null ? yieldVal * acres : (actualProd > 0 ? actualProd : 0)
    }

    const cropContracts = contracts.filter((c) => c.crop_id === crop.id && c.crop_year === cropYear)
    const contractedBu = cropContracts.reduce((s, c) => s + Number(c.contracted_bushels ?? 0), 0)
    const remaining = totalProduction - contractedBu

    // Base: weighted avg cash on fully-priced contracts; track excluded bushels.
    let cashBu = 0, cashW = 0, excludedAwaitingBu = 0
    for (const c of cropContracts) {
      const bu = Number(c.contracted_bushels ?? 0)
      if (c.pricing_status === 'fully_priced' && c.cash_price != null) { cashBu += bu; cashW += Number(c.cash_price) * bu }
      else if (c.pricing_status !== 'fully_priced') excludedAwaitingBu += bu
    }
    const avgCashPrice = cashBu > 0 ? round(cashW / cashBu) : null

    // Detailed: futures-equivalent average across physical (with futures) + short
    // futures hedges (open + closed), adjusted by closed-futures and options P&L.
    const commodity = cropToCommodity(crop.name)
    const cropFutures = commodity ? futures.filter((f) => f.commodity === commodity && f.crop_year === cropYear && f.side === 'short') : []
    const cropOptions = commodity ? options.filter((o) => o.commodity === commodity && o.crop_year === cropYear) : []

    let fBu = 0, fW = 0
    for (const c of cropContracts) if (c.futures_price != null) { const bu = Number(c.contracted_bushels ?? 0); fBu += bu; fW += Number(c.futures_price) * bu }
    for (const f of cropFutures) { const bu = Number(f.num_contracts) * CONTRACT_SIZE_BU; fBu += bu; fW += Number(f.trade_price) * bu }
    const rawAvgFutures = fBu > 0 ? fW / fBu : null

    const closedFuturesPnl = cropFutures.filter((f) => f.status === 'closed').reduce((s, f) => s + ((Number(f.realized_pnl ?? 0)) - Number(f.commission ?? 0)), 0)
    const optionsPnl = cropOptions.filter((o) => o.status !== 'open').reduce((s, o) => s + Number(o.realized_pnl ?? 0), 0)
    const adjPerBu = fBu > 0 ? (closedFuturesPnl + optionsPnl) / fBu : 0
    const avgFutures = rawAvgFutures != null ? round(rawAvgFutures + adjPerBu) : null

    let bBu = 0, bW = 0
    for (const c of cropContracts) if (c.basis != null) { const bu = Number(c.contracted_bushels ?? 0); bBu += bu; bW += Number(c.basis) * bu }
    const avgBasis = bBu > 0 ? round(bW / bBu) : null

    const totalAvgPrice = avgFutures != null && avgBasis != null ? round(avgFutures + avgBasis) : null

    const costPerAcre = assumption?.cost_per_acre != null ? Number(assumption.cost_per_acre) : null
    const costPerBu = costPerAcre != null && yieldVal != null && yieldVal > 0 ? round(costPerAcre / yieldVal, 4) : null
    // Use the full futures+basis price when available, else fall back to cash.
    const profitPrice = totalAvgPrice ?? avgCashPrice
    const profitPerAcre = profitPrice != null && yieldVal != null && costPerAcre != null ? round(yieldVal * profitPrice - costPerAcre, 2) : null
    const totalProfit = profitPerAcre != null ? round(profitPerAcre * acres, 2) : null

    const openFuturesHedgedBu = cropFutures.filter((f) => f.status === 'open').reduce((s, f) => s + Number(f.num_contracts) * CONTRACT_SIZE_BU, 0)

    rows.push({
      cropId: crop.id, cropName: crop.name, acres, yield: yieldVal, yieldLabel, totalProduction,
      contractedBu, remaining, avgCashPrice, excludedAwaitingBu,
      avgFutures, avgBasis, totalAvgPrice, costPerAcre, costPerBu, profitPerAcre, totalProfit,
      openFuturesHedgedBu,
    })
  }
  return rows.sort((a, b) => a.cropName.localeCompare(b.cropName))
}
