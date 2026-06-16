// Marketing dashboard computation — combines physical contracts with hedging
// (futures + options) into a per-crop marketing position for a crop year.
// Pure: callers pass already-fetched rows and an actual-production map.

import { cropToCommodity, CONTRACT_TYPE_LABEL } from '@/lib/contracts'
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
  // --- price buildup (detailed view + the inspectable breakdown) ---
  // Bushels in the futures average: physical contracts with a futures price +
  // OPEN short hedges. (Closed hedges never contribute a trade price.)
  futuresPricedBu: number
  physicalFuturesBu: number
  physicalFuturesAvg: number | null
  openHedgeBu: number
  openHedgeAvg: number | null
  // Weighted futures over futuresPricedBu, before the hedge P&L adjustment.
  rawAvgFutures: number | null
  // Realized P&L from CLOSED futures (net of commission) + CLOSED options, and
  // that figure spread over total expected production.
  hedgeRealizedPnl: number
  hedgeAdjPerBu: number
  // avg_futures_price = rawAvgFutures + hedgeAdjPerBu.
  avgFutures: number | null
  // Always set: the bushel-weighted basis across all basis-component bushels —
  // locked contracts at their weighted average and the rest (open HTAs, open
  // hedges, unpriced) at the assumed basis. Falls back to the assumed basis
  // alone when nothing is locked.
  avgBasis: number
  avgBasisAssumed: boolean
  assumedBasis: number
  // The standing assumed futures price ($/bu) for unpriced bushels (null = none
  // set → the harvest-price estimate is used). Persisted per crop × year.
  assumedFutures: number | null
  // --- basis composition (drives the actual / assumed / blended labeling) ---
  // Bushels on contracts with locked basis and their weighted average (equals
  // avgBasis only when the state is 'actual').
  basisLockedBu: number
  basisLockedAvg: number | null
  // Bushels whose basis component is valued at the ASSUMED basis in blended
  // revenue: futures-priced contracts without basis (open HTAs) + open-hedge
  // bushels + completely-unpriced bushels. Flat-cash bushels carry no basis
  // component and count toward neither side.
  basisAssumedBu: number
  // 'actual'  = every bushel with a basis component has it contract-locked
  // 'assumed' = no contract has basis locked (avgBasis IS the assumed basis)
  // 'blended' = some locked, the rest valued at the assumed basis
  basisState: 'actual' | 'assumed' | 'blended'
  // Total Average Price = avg_futures_price + avg_basis. Always computes for a
  // crop with production (cash / current-futures fallback when no futures avg).
  totalAvgPrice: number | null
  // --- blended expected revenue (the Revenue Projections basis) ---
  unpricedBu: number
  blendedRevenue: number
  // The all-in futures $/bu the completely-unpriced bushels (`unpricedBu`) are
  // valued at inside blendedRevenue (assumed futures when set, else the market
  // estimate; raw futures avg / 0 as last resorts). Lets the dashboard's What-If
  // re-price exactly those bushels as a delta on blendedRevenue and stay
  // consistent with it.
  unpricedFuturesPrice: number
  costPerAcre: number | null
  costPerBu: number | null
  // Per-acre profitability — derived from blendedRevenue so the dashboard and
  // Revenue Projections agree to the cent: revenue/acre = blendedRevenue ÷ acres;
  // profit/acre = revenue/acre − cost/acre; totalProfit = blendedRevenue − total
  // cost. (Total Avg Price is the separate price-buildup reference, shown but no
  // longer the revenue driver — it overstates in mixed-pricing cases because it
  // extends the priced average over unpriced bushels.)
  revenuePerAcre: number | null
  profitPerAcre: number | null
  totalProfit: number | null
  // for the unpriced-production section (= openHedgeBu)
  openFuturesHedgedBu: number
  // --- buildup line items (display ledgers; the totals above are unchanged) ---
  // Each futures-priced source with its bushels and weighted price: physical
  // contracts grouped by contract type, then open short hedges grouped by
  // contract month. Σ bushels = futuresPricedBu; bushel-weighted avg = rawAvgFutures,
  // so the dashboard's futures ledger foots to the subtotal.
  futuresSources: FuturesSource[]
  // Production bushels whose total price is fully locked (no assumption): fully-
  // priced flat-cash contracts + contracts with BOTH futures and basis locked.
  // lockedPriceBu === totalProduction ⟺ the headline price is fully actual.
  lockedPriceBu: number
  // Production bushels with no locked/hedged futures price (valued at market or a
  // what-if price) = max(0, totalProduction − futuresPricedBu). With basisAssumedBu
  // it explains the "includes assumptions" marker (Y futures / Z basis).
  futuresAssumedBu: number
}

// One line item in the average-futures-price buildup ledger.
export type FuturesSource = { label: string; bushels: number; avgPrice: number }

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

function round2(n: number): number {
  return Math.round(n * 100) / 100
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
  // Optional current futures price ($/bu) per crop (from Barchart) used to value
  // completely-unpriced bushels in blended revenue. Falls back to the crop's raw
  // futures average when absent.
  currentFuturesByCrop?: Map<string, number>
  // Crops whose harvest is complete by the field-level analysis (in addition to
  // the crop-level harvest_complete flag). When complete, production uses ACTUAL
  // harvested bushels instead of the yield estimate — see lib/yields.ts.
  harvestCompleteCropIds?: Set<string>
}): MarketingRow[] {
  const { cropYear, crops, plantings, contracts, futures, options, assumptions, actualProductionByCrop, expectedProductionByCrop, currentFuturesByCrop, harvestCompleteCropIds } = args

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
    // Harvest is complete when the crop is flagged OR every field is harvested by
    // the yield analysis — then production reflects ACTUAL, not the estimate.
    const harvestComplete = (assumption?.harvest_complete ?? false) || (harvestCompleteCropIds?.has(crop.id) ?? false)
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

    const assumedBasis = assumption?.assumed_basis != null ? Number(assumption.assumed_basis) : 0

    const cropContracts = contracts.filter((c) => c.crop_id === crop.id && c.crop_year === cropYear)
    const contractedBu = cropContracts.reduce((s, c) => s + Number(c.contracted_bushels ?? 0), 0)
    const remaining = totalProduction - contractedBu

    // Bushels whose total price is fully locked (no assumption): fully-priced
    // flat-cash contracts + contracts with BOTH futures and basis set. Drives the
    // dashboard's "includes assumptions" marker (locked === production ⟹ actual).
    let lockedPriceBu = 0
    for (const c of cropContracts) {
      const bu = Number(c.contracted_bushels ?? 0)
      if (c.cash_price != null && c.pricing_status === 'fully_priced') lockedPriceBu += bu
      else if (c.futures_price != null && c.basis != null) lockedPriceBu += bu
    }
    lockedPriceBu = Math.min(round2(lockedPriceBu), round2(totalProduction))

    // Base: weighted avg cash on fully-priced contracts; track excluded bushels.
    let cashBu = 0, cashW = 0, excludedAwaitingBu = 0
    for (const c of cropContracts) {
      const bu = Number(c.contracted_bushels ?? 0)
      if (c.pricing_status === 'fully_priced' && c.cash_price != null) { cashBu += bu; cashW += Number(c.cash_price) * bu }
      else if (c.pricing_status !== 'fully_priced') excludedAwaitingBu += bu
    }
    const avgCashPrice = cashBu > 0 ? round(cashW / cashBu) : null

    const commodity = cropToCommodity(crop.name)
    const cropFutures = commodity ? futures.filter((f) => f.commodity === commodity && f.crop_year === cropYear && f.side === 'short') : []
    const cropOptions = commodity ? options.filter((o) => o.commodity === commodity && o.crop_year === cropYear) : []

    // (1) Average futures price — weighted over FUTURES-PRICED bushels only:
    //     physical contracts with a futures price + OPEN short hedges. Closed
    //     hedges do NOT contribute a trade price (their result is the P&L
    //     adjustment below); flat-cash contracts (no futures_price) are excluded.
    let physicalFuturesBu = 0, physW = 0
    for (const c of cropContracts) {
      if (c.futures_price != null) { const bu = Number(c.contracted_bushels ?? 0); physicalFuturesBu += bu; physW += Number(c.futures_price) * bu }
    }
    let openHedgeBu = 0, openW = 0
    for (const f of cropFutures) {
      if (f.status === 'open') { const bu = Number(f.num_contracts) * CONTRACT_SIZE_BU; openHedgeBu += bu; openW += Number(f.trade_price) * bu }
    }
    const futuresPricedBu = physicalFuturesBu + openHedgeBu
    const physicalFuturesAvg = physicalFuturesBu > 0 ? round(physW / physicalFuturesBu) : null
    const openHedgeAvg = openHedgeBu > 0 ? round(openW / openHedgeBu) : null
    const rawAvgFutures = futuresPricedBu > 0 ? round((physW + openW) / futuresPricedBu) : null

    // Line items behind rawAvgFutures, for the futures-price buildup ledger:
    // physical contracts carrying a futures price (grouped by contract type),
    // then open short hedges (grouped by contract month). Σ bushels = futuresPricedBu
    // and the bushel-weighted average = rawAvgFutures, so the ledger foots.
    const futuresSources: FuturesSource[] = []
    const physByType = new Map<string, { bu: number; w: number }>()
    for (const c of cropContracts) {
      if (c.futures_price == null) continue
      const key = c.contract_type ?? 'forward'
      const bu = Number(c.contracted_bushels ?? 0)
      const g = physByType.get(key) ?? { bu: 0, w: 0 }
      g.bu += bu; g.w += Number(c.futures_price) * bu
      physByType.set(key, g)
    }
    for (const key of ['forward', 'hta', 'basis'] as const) {
      const g = physByType.get(key)
      if (g && g.bu > 0) futuresSources.push({ label: `${CONTRACT_TYPE_LABEL[key]} contracts`, bushels: round2(g.bu), avgPrice: round(g.w / g.bu) })
    }
    const hedgeByMonth = new Map<string, { bu: number; w: number }>()
    for (const f of cropFutures) {
      if (f.status !== 'open') continue
      const month = f.contract_month ?? f.contract_symbol ?? 'hedge'
      const bu = Number(f.num_contracts) * CONTRACT_SIZE_BU
      const g = hedgeByMonth.get(month) ?? { bu: 0, w: 0 }
      g.bu += bu; g.w += Number(f.trade_price) * bu
      hedgeByMonth.set(month, g)
    }
    for (const [month, g] of hedgeByMonth) {
      if (g.bu > 0) futuresSources.push({ label: `Open hedges (${month})`, bushels: round2(g.bu), avgPrice: round(g.w / g.bu) })
    }
    const futuresAssumedBu = round2(Math.max(0, totalProduction - futuresPricedBu))

    // (2) Hedging P&L adjustment — realized results from LIFTED (closed) hedges,
    //     spread over TOTAL expected production (the standard "hedge account
    //     blended into the crop" treatment). Open options are excluded entirely.
    const closedFuturesPnl = cropFutures
      .filter((f) => f.status === 'closed')
      .reduce((s, f) => s + (Number(f.realized_pnl ?? 0) - Number(f.commission ?? 0)), 0)
    const closedOptionsPnl = cropOptions
      .filter((o) => o.status !== 'open')
      .reduce((s, o) => s + Number(o.realized_pnl ?? 0), 0)
    const hedgeRealizedPnl = round2(closedFuturesPnl + closedOptionsPnl)
    const hedgeAdjPerBu = totalProduction > 0 ? round(hedgeRealizedPnl / totalProduction) : 0
    const avgFutures = rawAvgFutures != null ? round(rawAvgFutures + hedgeAdjPerBu) : null

    // Bushel buckets shared by the basis average and blended revenue: unsold
    // production, the open hedges covering it, and the completely-unpriced rest.
    const unsold = Math.max(0, totalProduction - contractedBu)
    const hedgeCovered = Math.max(0, Math.min(openHedgeBu, unsold))
    const unpricedBu = Math.max(0, unsold - hedgeCovered)

    // (3) Average basis — bushel-weighted across ALL basis-component bushels:
    //     contracts with locked basis at their weighted average, plus everything
    //     valued at the assumed basis (futures contracts without basis, open
    //     hedges, unpriced bushels). All locked → 'actual' (= the locked avg);
    //     none locked → 'assumed' (= the assumed basis); a mix → 'blended'.
    //     Flat-cash bushels carry no basis component and stay out of the blend.
    let bBu = 0, bW = 0
    for (const c of cropContracts) if (c.basis != null) { const bu = Number(c.contracted_bushels ?? 0); bBu += bu; bW += Number(c.basis) * bu }
    let htaNoBasisBu = 0
    for (const c of cropContracts) if (c.futures_price != null && c.basis == null) htaNoBasisBu += Number(c.contracted_bushels ?? 0)
    const basisLockedBu = bBu
    const basisLockedAvg = bBu > 0 ? round(bW / bBu) : null
    const basisAssumedBu = round2(htaNoBasisBu + hedgeCovered + unpricedBu)
    const basisState: MarketingRow['basisState'] =
      basisLockedBu > 0 ? (basisAssumedBu > 0 ? 'blended' : 'actual') : 'assumed'
    const avgBasisAssumed = basisLockedBu === 0
    const avgBasis = basisLockedBu > 0
      ? round((bW + assumedBasis * basisAssumedBu) / (basisLockedBu + basisAssumedBu))
      : round(assumedBasis)

    const assumedFutures = assumption?.assumed_futures != null ? Number(assumption.assumed_futures) : null
    const currentFutures = currentFuturesByCrop?.get(crop.id) ?? null
    // The price for completely-unpriced bushels: the user's assumed futures when
    // set (a standing What-If assumption), otherwise the auto-fetched harvest-price
    // estimate (Barchart).
    const marketFutures = assumedFutures ?? currentFutures

    // (5) Total Average Price = avg_futures_price + avg_basis. Always computes for
    //     a crop with production: cash fallback (flat-cash only), then assumed/market
    //     futures + assumed basis (all unpriced), then assumed basis.
    let totalAvgPrice: number | null
    if (avgFutures != null) totalAvgPrice = round(avgFutures + avgBasis)
    else if (avgCashPrice != null) totalAvgPrice = avgCashPrice
    else if (marketFutures != null) totalAvgPrice = round(marketFutures + assumedBasis)
    else totalAvgPrice = totalProduction > 0 ? round(assumedBasis) : null

    // (6) Blended expected revenue — the profitability + Revenue Projections basis.
    //     Each bushel bucket is valued at its own price (raw, no P&L), then the
    //     realized hedge P&L is added ONCE so it isn't double-counted with #2.
    let blendedRevenue = 0
    for (const c of cropContracts) {
      const bu = Number(c.contracted_bushels ?? 0)
      if (c.futures_price != null) {
        // Futures-component contract (forward-with-futures / HTA / priced basis):
        // futures + its basis, using assumed basis where basis isn't set yet.
        const basisForC = c.basis != null ? Number(c.basis) : assumedBasis
        blendedRevenue += (Number(c.futures_price) + basisForC) * bu
      } else if (c.cash_price != null) {
        blendedRevenue += Number(c.cash_price) * bu // flat-cash forward
      } else {
        blendedRevenue += ((marketFutures ?? rawAvgFutures ?? 0) + assumedBasis) * bu
      }
    }
    // Open-hedge bushels (hedged but not physically sold), capped at unsold acres.
    if (hedgeCovered > 0) blendedRevenue += hedgeCovered * ((openHedgeAvg ?? rawAvgFutures ?? marketFutures ?? 0) + assumedBasis)
    // Completely-unpriced bushels at the assumed/market futures + assumed basis.
    if (unpricedBu > 0) blendedRevenue += unpricedBu * ((marketFutures ?? rawAvgFutures ?? 0) + assumedBasis)
    blendedRevenue = round2(blendedRevenue + hedgeRealizedPnl)

    const costPerAcre = assumption?.cost_per_acre != null ? Number(assumption.cost_per_acre) : null
    const costPerBu = costPerAcre != null && yieldVal != null && yieldVal > 0 ? round(costPerAcre / yieldVal, 4) : null
    // The futures price the completely-unpriced bushels are valued at in blended
    // revenue (see the unpricedBu term above) — exposed so the dashboard What-If
    // can re-price them as a delta on blendedRevenue.
    const unpricedFuturesPrice = round(marketFutures ?? rawAvgFutures ?? 0)
    // Revenue / profit come straight off blendedRevenue — the single source of
    // truth Revenue Projections also uses — so the two reports reconcile exactly
    // (their only difference is RevProj's insurance + government payments).
    const totalCost = costPerAcre != null ? round2(costPerAcre * acres) : null
    const revenuePerAcre = acres > 0 ? round2(blendedRevenue / acres) : null
    const profitPerAcre = revenuePerAcre != null && costPerAcre != null ? round2(revenuePerAcre - costPerAcre) : null
    const totalProfit = totalCost != null ? round2(blendedRevenue - totalCost) : null

    rows.push({
      cropId: crop.id, cropName: crop.name, acres, yield: yieldVal, yieldLabel, totalProduction,
      contractedBu, remaining, avgCashPrice, excludedAwaitingBu,
      futuresPricedBu, physicalFuturesBu, physicalFuturesAvg, openHedgeBu, openHedgeAvg,
      rawAvgFutures, hedgeRealizedPnl, hedgeAdjPerBu, avgFutures, avgBasis, avgBasisAssumed, assumedBasis, assumedFutures,
      basisLockedBu, basisLockedAvg, basisAssumedBu, basisState,
      totalAvgPrice, unpricedBu, blendedRevenue, unpricedFuturesPrice, costPerAcre, costPerBu, revenuePerAcre, profitPerAcre, totalProfit,
      openFuturesHedgedBu: openHedgeBu,
      futuresSources, lockedPriceBu, futuresAssumedBu,
    })
  }
  return rows.sort((a, b) => a.cropName.localeCompare(b.cropName))
}
