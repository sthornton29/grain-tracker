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

// Acres per crop split into full-season vs double-crop and irrigated vs dryland.
export type SegmentAcres = { fullIrr: number; fullDry: number; dcIrr: number; dcDry: number }

// Aggregate planting acres into the four breakout segments per crop. `doubleCropIds`
// marks which plantings are double-crop (see buildDoubleCropSet).
export function segmentAcresByCrop(
  plantings: ReadonlyArray<{
    id: string; crop_id: string; season_year: number
    irrigated_acres: number | string | null; dryland_acres: number | string | null
  }>,
  cropYear: number,
  doubleCropIds: Set<string>,
): Map<string, SegmentAcres> {
  const m = new Map<string, SegmentAcres>()
  for (const p of plantings) {
    if (p.season_year !== cropYear) continue
    const irr = Number(p.irrigated_acres ?? 0) || 0
    const dry = Number(p.dryland_acres ?? 0) || 0
    const seg = m.get(p.crop_id) ?? { fullIrr: 0, fullDry: 0, dcIrr: 0, dcDry: 0 }
    if (doubleCropIds.has(p.id)) { seg.dcIrr += irr; seg.dcDry += dry }
    else { seg.fullIrr += irr; seg.fullDry += dry }
    m.set(p.crop_id, seg)
  }
  return m
}

// Expected production (bushels) per crop from the broken-out yields: each segment
// uses its own yield, falling back to the overall expected_yield where blank. A
// crop with no yields set at all is omitted, so the dashboard can fall back to
// actual loads.
export function expectedProductionFromBreakout(
  segByCrop: Map<string, SegmentAcres>,
  assumptions: CropAssumption[],
  cropYear: number,
): Map<string, number> {
  const out = new Map<string, number>()
  const num = (v: number | null | undefined) => (v != null ? Number(v) : null)
  for (const [cropId, seg] of segByCrop) {
    const a = assumptions.find((x) => x.crop_id === cropId && x.crop_year === cropYear)
    const blended = num(a?.expected_yield)
    const yIrr = num(a?.expected_yield_irr) ?? blended
    const yDry = num(a?.expected_yield_dry) ?? blended
    const yDcIrr = num(a?.expected_yield_dc_irr) ?? blended
    const yDcDry = num(a?.expected_yield_dc_dry) ?? blended
    if (blended == null && yIrr == null && yDry == null && yDcIrr == null && yDcDry == null) continue
    const prod = (yIrr ?? 0) * seg.fullIrr + (yDry ?? 0) * seg.fullDry + (yDcIrr ?? 0) * seg.dcIrr + (yDcDry ?? 0) * seg.dcDry
    out.set(cropId, round(prod, 2))
  }
  return out
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
  // Optional per-crop expected production (bushels) from the yield breakout.
  // When present for a crop, it replaces expected_yield × acres for the estimate.
  expectedProductionByCrop?: Map<string, number>
}): MarketingRow[] {
  const { cropYear, crops, plantings, contracts, futures, options, assumptions, actualProductionByCrop, expectedProductionByCrop } = args

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
      const broken = expectedProductionByCrop?.get(crop.id)
      if (broken != null) {
        // Broken-out estimate: yield shown is the implied blend (production ÷ acres).
        totalProduction = broken
        yieldVal = acres > 0 ? round(broken / acres, 2) : null
        yieldLabel = 'Est.'
      } else {
        yieldVal = expected
        yieldLabel = 'Est.'
        totalProduction = yieldVal != null ? yieldVal * acres : (actualProd > 0 ? actualProd : 0)
      }
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
