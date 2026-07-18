'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeMarketing, aggregateMarketing, breakevenAvgPrice, segmentAcresByCrop, expectedProductionFromBreakout, isCottonCrop, type MarketingRow, type SegmentAcres } from '@/lib/marketing'
import { buildMarketingExport } from '@/lib/marketing-export'
import { fieldCropAggregates, cropsWithCompleteHarvest } from '@/lib/yields'
import { buildDoubleCropSet } from '@/lib/plantings'
import { cropToHedgeCommodity } from '@/lib/contracts'
import { fmtPnl, buildContractSymbol } from '@/lib/hedging'
import { usePersistentState } from '@/lib/use-persistent-state'
import { StackedBar } from '@/components/reports/report-kit'
import ExportBar from '@/components/export-bar'
import { type ExportPayload } from '@/lib/exports'
import type { Contract, Crop, CropAssumption, FuturesPosition, OptionPosition, GinReceipt, CottonBale } from '@/lib/types'

type LoadRow = {
  id: string
  date: string
  crop_id: string | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
}

type SplitRow = { load_id: string; field_id: string; crop_id: string; dry_bushels: number | null }

type PlantingRow = {
  id: string
  field_id: string
  crop_id: string
  season_year: number
  planted_acres: number | null
  irrigated_acres: number | null
  dryland_acres: number | null
  yield_include_override: boolean | null
}

const bu = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
// Cotton ¢/lb price, 2 decimals ("72.65¢").
const cents2 = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}¢`)
const usd = (n: number | null | undefined) => (n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const usd0 = (n: number | null | undefined) => (n == null ? '—' : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`)
const round2 = (n: number) => Math.round(n * 100) / 100
// Per-bushel price, always to 2 decimals on this dashboard (vs the app-wide
// fmtPrice which keeps quarter-cent / 4-decimal precision for hedging).
const price2 = (n: number | null | undefined) => (n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
// Signed basis figure: −$0.25 / +$0.10.
const basis2 = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`)
// A basis figure never appears without its state qualifier (PART B):
//   actual  = every basis-component bushel has contract-locked basis
//   assumed = none locked; the figure IS crop_assumptions.assumed_basis
//   blended = some locked, the rest valued at the assumed basis
const basisStateLabel = (r: MarketingRow) => (r.basisState === 'actual' ? 'actual, all contracted' : r.basisState)
// Blended composition, for hover/tap tooltips.
const basisCompositionTitle = (r: MarketingRow) =>
  `Locked: ${bu(r.basisLockedBu)} bu @ ${basis2(r.basisLockedAvg)} · Assumed: ${bu(r.basisAssumedBu)} bu @ ${basis2(r.assumedBasis)}`

// The new-crop benchmark futures contract for a crop year, used by the what-if
// "use today's price" button: Corn → DEC (ZCZ{yy}), Soybeans → NOV (ZSX{yy}),
// Chicago Wheat → JUL (ZWN{yy}), Cotton → DEC (CTZ{yy}, the new-crop benchmark).
// null for crops with no traded future (e.g. Canola).
const NEW_CROP_MONTH: Record<string, { abbr: string; num: number }> = {
  Corn: { abbr: 'DEC', num: 12 },
  Soybeans: { abbr: 'NOV', num: 11 },
  'Chicago Wheat': { abbr: 'JUL', num: 7 },
  Cotton: { abbr: 'DEC', num: 12 },
}
function newCropContract(cropName: string, cropYear: number): { symbol: string; monthNum: number; year: number } | null {
  const commodity = cropToHedgeCommodity(cropName)
  if (!commodity) return null
  const m = NEW_CROP_MONTH[commodity]
  const symbol = buildContractSymbol(commodity, `${m.abbr} ${String(cropYear % 100).padStart(2, '0')}`)
  return symbol ? { symbol, monthNum: m.num, year: cropYear } : null
}

// Breakeven (a guide, holding the other variable fixed):
//   price  = cost/acre ÷ yield                  ($/bu needed at the expected yield)
//   yield  = cost/acre ÷ breakeven avg price     (bu/ac needed at that price)
// The yield divides by the large headline "Total avg price" (breakevenAvgPrice),
// not the plain futures+basis total, so it matches what the card shows. Both null
// until a cost is set.
function breakevenOf(row: MarketingRow): { price: number | null; yieldPerAcre: number | null } {
  const cost = row.costPerAcre
  if (row.unit === 'lbs') {
    // Cotton: breakeven price in ¢/lb; breakeven yield in lbs lint/ac against
    // the effective ¢/lb the card shows.
    return {
      price: cost != null && row.yield != null && row.yield > 0 ? (cost * 100) / row.yield : null,
      yieldPerAcre: cost != null && row.totalAvgPrice != null && row.totalAvgPrice > 0 ? (cost * 100) / row.totalAvgPrice : null,
    }
  }
  const avg = breakevenAvgPrice(row)
  return {
    price: cost != null && row.yield != null && row.yield > 0 ? cost / row.yield : null,
    yieldPerAcre: cost != null && avg != null && avg > 0 ? cost / avg : null,
  }
}

// What-If scenario: re-price the crop's unpriced bushels at the typed futures
// (and, in advanced mode, the typed basis) as an exact DELTA on blendedRevenue —
// the same single source of truth the headline and Revenue Projections use. So a
// typed value previews the very number that persisting it as the standing
// assumption would produce (no jump on blur), and the headline stays reconciled
// with Revenue Projections. `wfFut` is the futures $/bu (a flat cash $/bu in
// simple mode); `wfBasis` the assumed basis. Pure.
function scenarioFor(row: MarketingRow, wfFut: number | null, wfBasis: number, advanced: boolean) {
  const prod = row.totalProduction
  if (prod <= 0 || row.acres <= 0 || wfFut == null) return null
  // Cotton rows price in ¢/lb over lbs: a price delta × lbs is cents, ÷100 to
  // dollars — and the headline price re-derives in ¢ (×100). Grains are 1:1.
  const toUsd = row.unit === 'lbs' ? 1 / 100 : 1
  let blended: number
  if (advanced) {
    // Futures delta hits the completely-unpriced bushels; the basis delta hits
    // every assumed-basis bushel (open HTAs + open hedges + unpriced) — exactly
    // what computeMarketing does when those values are saved. (Cotton has no
    // basis bushels, so its basis term is always 0.)
    const dFut = wfFut - row.unpricedFuturesPrice
    const dBasis = wfBasis - row.assumedBasis
    blended = round2(row.blendedRevenue + (dFut * row.unpricedBu + dBasis * row.basisAssumedBu) * toUsd)
  } else {
    // Simple: a flat cash price replaces (futures + assumed basis) on the unsold
    // (completely-unpriced) bushels.
    const dCash = wfFut - (row.unpricedFuturesPrice + row.assumedBasis)
    blended = round2(row.blendedRevenue + dCash * row.unpricedBu * toUsd)
  }
  const revenuePerAcre = round2(blended / row.acres)
  const profitPerAcre = row.costPerAcre != null ? round2(blended / row.acres - row.costPerAcre) : null
  const totalProfit = row.costPerAcre != null ? round2(blended - row.costPerAcre * row.acres) : null
  const totalAvgPrice = round2((blended / prod) * (row.unit === 'lbs' ? 100 : 1))
  return { totalAvgPrice, revenuePerAcre, profitPerAcre, totalProfit }
}

export default function MarketingPage() {
  const supabase = useMemo(() => createClient(), [])
  const [yearOptions, setYearOptions] = useState<number[]>([])
  // Crop year persists, so returning to the dashboard doesn't ask again — it
  // reopens on the last year the user picked.
  const [year, setYear] = usePersistentState<number | null>('marketing:cropYear', null)
  const [loading, setLoading] = useState(false)

  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<PlantingRow[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [futures, setFutures] = useState<FuturesPosition[]>([])
  const [options, setOptions] = useState<OptionPosition[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [production, setProduction] = useState<Map<string, number>>(new Map())
  // Crops whose harvest is complete (field-level) → use actual, not the estimate.
  const [harvestCompleteIds, setHarvestCompleteIds] = useState<Set<string>>(new Set())
  // Current futures price per crop (Barchart) — values completely-unpriced bushels.
  const [currentFutures, setCurrentFutures] = useState<Map<string, number>>(new Map())
  // Cotton actuals per cotton crop id: lbs of lint + bales, from gin receipts.
  const [cottonProd, setCottonProd] = useState<Map<string, { lintLbs: number; bales: number }>>(new Map())

  // Expanded crop sections (crop ids) — persisted per crop so a section the user
  // opened is still open when they come back.
  const [expanded, setExpanded] = usePersistentState<string[]>('marketing:detailsExpanded', [])
  // Which advanced crops have their basis position bar revealed — persisted per
  // user (crop ids), consistent with the app's other filter persistence.
  const [basisExpanded, setBasisExpanded] = usePersistentState<string[]>('marketing:basisExpanded', [])
  const [assumptionsOpen, setAssumptionsOpen] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  // Crop years that have any plantings, contracts, or futures positions.
  useEffect(() => {
    ;(async () => {
      const [pl, ct, fp] = await Promise.all([
        supabase.from('field_plantings').select('season_year'),
        supabase.from('contracts').select('crop_year'),
        supabase.from('futures_positions').select('crop_year'),
      ])
      const set = new Set<number>()
      for (const r of (pl.data as Array<{ season_year: number | null }>) ?? []) if (r.season_year != null) set.add(r.season_year)
      for (const r of (ct.data as Array<{ crop_year: number | null }>) ?? []) if (r.crop_year != null) set.add(r.crop_year)
      for (const r of (fp.data as Array<{ crop_year: number | null }>) ?? []) if (r.crop_year != null) set.add(r.crop_year)
      setYearOptions(Array.from(set).sort((a, b) => b - a))
    })()
  }, [supabase])

  const load = useCallback(async (cropYear: number) => {
    setLoading(true)
    const [cr, pl, ct, fp, op, ca, ld, sp, gr, cb] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres, yield_include_override').eq('season_year', cropYear),
      supabase.from('contracts').select('*').eq('crop_year', cropYear),
      supabase.from('futures_positions').select('*').eq('crop_year', cropYear),
      supabase.from('options_positions').select('*').eq('crop_year', cropYear),
      supabase.from('crop_assumptions').select('*').eq('crop_year', cropYear),
      supabase.from('loads').select('id, date, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override').eq('crop_year', cropYear),
      supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels'),
      supabase.from('gin_receipts').select('id, crop_year, bales_count, total_bale_weight').eq('crop_year', cropYear),
      supabase.from('cotton_bales').select('gin_receipt_id, net_weight_lbs').eq('crop_year', cropYear),
    ])
    const cropsList = (cr.data as Crop[]) ?? []
    const plantingList = (pl.data as PlantingRow[]) ?? []
    const assumptionList = (ca.data as CropAssumption[]) ?? []
    setCrops(cropsList)
    setPlantings(plantingList)
    setContracts((ct.data as Contract[]) ?? [])
    setFutures((fp.data as FuturesPosition[]) ?? [])
    setOptions((op.data as OptionPosition[]) ?? [])
    setAssumptions(assumptionList)

    // (field|crop|year) → dry bushels + last load date, splits-aware. Drives both
    // actual production (by crop) and the field-level harvest-completion check.
    const cropById = new Map(cropsList.map((c) => [c.id, c]))
    const aggByKey = fieldCropAggregates((ld.data as LoadRow[]) ?? [], (sp.data as SplitRow[]) ?? [], cropById, { cropYear })
    const prod = new Map<string, number>()
    for (const [key, agg] of aggByKey) {
      const cropId = key.split('|')[1]
      if (cropId) prod.set(cropId, (prod.get(cropId) ?? 0) + agg.dryBu)
    }
    setProduction(prod)

    // Cotton actual production: lbs of lint from gin receipts — per-bale net
    // weights when the bales are on file, else the receipt's total bale weight.
    const receipts = ((gr.data as unknown) as Pick<GinReceipt, 'id' | 'bales_count' | 'total_bale_weight'>[]) ?? []
    const bales = ((cb.data as unknown) as Pick<CottonBale, 'gin_receipt_id' | 'net_weight_lbs'>[]) ?? []
    const balesByReceipt = new Map<string, { lbs: number; count: number }>()
    for (const b of bales) {
      const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
      g.lbs += Number(b.net_weight_lbs) || 0
      g.count += 1
      balesByReceipt.set(b.gin_receipt_id, g)
    }
    let lintLbs = 0, baleCount = 0
    for (const r of receipts) {
      const fromBales = balesByReceipt.get(r.id)
      lintLbs += fromBales && fromBales.lbs > 0 ? fromBales.lbs : Number(r.total_bale_weight) || 0
      baleCount += fromBales && fromBales.count > 0 ? fromBales.count : Number(r.bales_count) || 0
    }
    const cotton = new Map<string, { lintLbs: number; bales: number }>()
    for (const c of cropsList) if (isCottonCrop(c.name)) cotton.set(c.id, { lintLbs, bales: baleCount })
    setCottonProd(cotton)

    // Crops fully in the bin → use actual production instead of the estimate.
    const cropCompleteKeys = new Set<string>()
    for (const a of assumptionList) if (a.harvest_complete) cropCompleteKeys.add(`${a.crop_id}|${a.crop_year}`)
    setHarvestCompleteIds(cropsWithCompleteHarvest({ plantings: plantingList, aggByKey, cropYear, cropCompleteKeys }))
    setLoading(false)
  }, [supabase])

  useEffect(() => { if (year != null) load(year) }, [year, load])

  // Refresh current futures (Barchart harvest-month estimate) for the planted
  // crops, to value completely-unpriced bushels in blended revenue. Falls back to
  // each crop's raw futures average when unavailable, so it never blocks numbers.
  useEffect(() => {
    if (year == null || crops.length === 0) { setCurrentFutures(new Map()); return }
    const plantedIds = new Set(plantings.map((p) => p.crop_id))
    const payload = crops.filter((c) => plantedIds.has(c.id)).map((c) => ({ crop_id: c.id, crop_name: c.name })).filter((c) => c.crop_name)
    if (payload.length === 0) { setCurrentFutures(new Map()); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/harvest-price-estimate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ crop_year: year, crops: payload }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled || !json) return
        const m = new Map<string, number>()
        for (const e of (json.estimates ?? []) as Array<{ crop_id: string; price: number | null }>) if (e.price != null) m.set(e.crop_id, Number(e.price))
        setCurrentFutures(m)
      } catch { /* fall back to raw futures average */ }
    })()
    return () => { cancelled = true }
  }, [year, crops, plantings])

  // Acres per crop split into full-season/double-crop × irrigated/dryland, and
  // the broken-out expected production used by the dashboard.
  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const doubleCropIds = useMemo(() => buildDoubleCropSet(plantings, cropById), [plantings, cropById])
  const segByCrop = useMemo<Map<string, SegmentAcres>>(
    () => (year == null ? new Map() : segmentAcresByCrop(plantings, year, doubleCropIds)),
    [plantings, year, doubleCropIds],
  )
  const expProdByCrop = useMemo(
    () => (year == null ? new Map<string, number>() : expectedProductionFromBreakout(segByCrop, assumptions, year)),
    [segByCrop, assumptions, year],
  )

  const rows = useMemo(
    () => (year == null ? [] : computeMarketing({ cropYear: year, crops, plantings, contracts, futures, options, assumptions, actualProductionByCrop: production, expectedProductionByCrop: expProdByCrop, currentFuturesByCrop: currentFutures, harvestCompleteCropIds: harvestCompleteIds, cottonProductionByCrop: cottonProd })),
    [year, crops, plantings, contracts, futures, options, assumptions, production, expProdByCrop, currentFutures, harvestCompleteIds, cottonProd],
  )

  // Actual average yield (dry bushels from loads ÷ planted acres) per crop, used
  // to snap the estimate yield to actual when a crop is marked harvest-complete.
  const actualByCrop = useMemo(() => {
    const acres = new Map<string, number>()
    for (const p of plantings) acres.set(p.crop_id, (acres.get(p.crop_id) ?? 0) + Number(p.planted_acres ?? 0))
    const m = new Map<string, { production: number; yield: number | null }>()
    for (const c of crops) {
      // Cotton actuals are lbs of lint from gin receipts; grains are dry bushels
      // from loads. Same shape either way — the crop's own unit.
      const prod = isCottonCrop(c.name) ? (cottonProd.get(c.id)?.lintLbs ?? 0) : (production.get(c.id) ?? 0)
      const a = acres.get(c.id) ?? 0
      m.set(c.id, { production: prod, yield: prod > 0 && a > 0 ? Math.round((prod / a) * 10) / 10 : null })
    }
    return m
  }, [plantings, crops, production, cottonProd])

  // Crops shown in the assumptions editor: those with plantings this year.
  // Cotton is included — its expected_yield is lbs of lint/acre and cost/acre
  // works the same; the row labels adapt (see AssumptionRow).
  const plantedCropIds = useMemo(() => new Set(plantings.map((p) => p.crop_id)), [plantings])
  const plantedCrops = crops.filter((c) => plantedCropIds.has(c.id))

  // The only meaningful combined metrics across mixed crops: total acres and
  // total projected profit (mixing corn/soy/wheat production or price is not).
  // Rolled up by the SHARED aggregateMarketing() — the exact same full-precision
  // sum Revenue Projections uses — so the two pages' projected profit can't drift.
  const combined = useMemo(() => {
    const agg = aggregateMarketing(rows)
    return { acres: agg.acres, profit: agg.totalProfit }
  }, [rows])

  // Crops planted this year whose effective yield assumption is still missing.
  const incompleteCount = useMemo(() => rows.filter((r) => r.yield == null).length, [rows])

  // Per-crop marketing complexity (display only, derived from the already-fetched
  // contracts/futures/options). A crop is "advanced" if it has any futures/options
  // positions or any HTA/basis contract; otherwise it's simple (forwards only)
  // and the section hides all hedging and basis language.
  const cropMeta = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const r of rows) {
      const commodity = cropToHedgeCommodity(r.cropName)
      const cropContracts = contracts.filter((c) => c.crop_id === r.cropId)
      const hasHtaOrBasis = cropContracts.some((c) => c.contract_type === 'hta' || c.contract_type === 'basis')
      const hasFut = commodity ? futures.some((f) => f.commodity === commodity) : false
      const hasOpt = commodity ? options.some((o) => o.commodity === commodity) : false
      m.set(r.cropId, hasHtaOrBasis || hasFut || hasOpt)
    }
    return m
  }, [rows, contracts, futures, options])

  function toggleBasis(cropId: string) {
    setBasisExpanded((s) => (s.includes(cropId) ? s.filter((x) => x !== cropId) : [...s, cropId]))
  }

  // Export mirrors the cards; the pure builder handles grain ($/bu + bu) and
  // cotton (cents/lb + lbs) sections - see lib/marketing-export.ts.
  function buildPayload(): ExportPayload {
    return buildMarketingExport({ year, rows, contracts, cropMeta, segByCrop, combined })
  }

  async function saveAssumption(cropId: string, patch: Partial<CropAssumption>) {
    if (year == null) return
    const existing = assumptions.find((a) => a.crop_id === cropId && a.crop_year === year)
    // Use a field from `patch` when it's present (even if null, to clear it);
    // otherwise keep the stored value. This lets a partial patch (e.g. just the
    // harvest-complete checkbox) leave the other fields untouched.
    const has = (k: keyof CropAssumption) => Object.prototype.hasOwnProperty.call(patch, k)
    const pick = (k: keyof CropAssumption) => (has(k) ? patch[k] ?? null : existing?.[k] ?? null)
    const row = {
      crop_id: cropId,
      crop_year: year,
      expected_yield: pick('expected_yield'),
      expected_yield_irr: pick('expected_yield_irr'),
      expected_yield_dry: pick('expected_yield_dry'),
      expected_yield_dc_irr: pick('expected_yield_dc_irr'),
      expected_yield_dc_dry: pick('expected_yield_dc_dry'),
      harvest_complete: has('harvest_complete') ? patch.harvest_complete : existing?.harvest_complete ?? false,
      // assumed_basis is NOT NULL (default 0) — never write null.
      assumed_basis: (has('assumed_basis') ? patch.assumed_basis : existing?.assumed_basis) ?? 0,
      // assumed_futures is nullable (null = fall back to the harvest-price estimate).
      assumed_futures: has('assumed_futures') ? patch.assumed_futures ?? null : existing?.assumed_futures ?? null,
      cost_per_acre: pick('cost_per_acre'),
      cost_per_acre_irr: pick('cost_per_acre_irr'),
      cost_per_acre_dry: pick('cost_per_acre_dry'),
      cost_per_acre_dc_irr: pick('cost_per_acre_dc_irr'),
      cost_per_acre_dc_dry: pick('cost_per_acre_dc_dry'),
      notes: pick('notes'),
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('crop_assumptions').upsert(row, { onConflict: 'crop_id,crop_year' })
    if (error) { setBanner(`Could not save assumptions: ${error.message}`); return }
    load(year)
  }

  function toggleRow(id: string) {
    setExpanded((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  }

  return (
    <div className="space-y-4">
      {/* Slim top bar: title + the two combined metrics + crop-year filter +
          Assumptions. Everything else is per crop, in the sections below. */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 flex items-baseline gap-x-6 gap-y-1 flex-wrap">
          <h1 className="text-2xl font-bold">Marketing</h1>
          {year != null && !loading && rows.length > 0 && (
            <div className="flex items-baseline gap-x-6 gap-y-1 text-sm flex-wrap">
              <div>
                <span className="text-slate-500">Total acres</span>{' '}
                <span className="font-bold tabular-nums">{bu(combined.acres)}</span>
              </div>
              <div>
                <span className="text-slate-500">Total projected profit</span>{' '}
                <span className={`font-bold tabular-nums ${combined.profit == null ? 'text-slate-400' : combined.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  {combined.profit != null ? usd0(combined.profit) : 'Set costs'}
                </span>
              </div>
            </div>
          )}
        </div>
        <label className="text-sm text-slate-700">
          Crop year
          <select
            value={year ?? ''}
            onChange={(e) => setYear(e.target.value === '' ? null : Number(e.target.value))}
            className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 bg-white"
          >
            <option value="">— pick a crop year —</option>
            {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        {year != null && !loading && (
          <button
            type="button"
            onClick={() => setAssumptionsOpen(true)}
            className={`relative inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold mb-px text-white shadow-sm ${incompleteCount > 0 ? 'bg-amber-500 hover:bg-amber-600' : 'bg-sky-700 hover:bg-sky-800'}`}
            title="Edit yield and cost assumptions for each crop"
          >
            <span aria-hidden>⚙</span> Edit Assumptions
            {incompleteCount > 0 && (
              <span className="rounded-full bg-white/25 text-white text-xs px-1.5 py-0.5 leading-none">
                {incompleteCount} missing
              </span>
            )}
          </button>
        )}
        {year != null && !loading && rows.length > 0 && <ExportBar buildPayload={buildPayload} className="mb-px" />}
      </div>

      {banner && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</div>}

      {year == null ? (
        <div className="bg-white rounded-xl shadow p-8 text-center text-slate-500">
          Pick a crop year to load the marketing dashboard.
        </div>
      ) : loading ? (
        <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">No planted crops for {year}.</div>
      ) : (
        /* Full-width crop sections, stacked — the user scrolls down through
           crops. Each section is the complete view for its crop: an at-a-glance
           header row plus an expandable 4-column detail grid. */
        <div className="space-y-5 print-area">
          {rows.map((r) => (
            r.unit === 'lbs' ? (
              <CottonSection
                key={`${r.cropId}-${year}`}
                row={r}
                detailsOpen={expanded.includes(r.cropId)}
                onToggleDetails={() => toggleRow(r.cropId)}
                cropYear={year}
                onSaveFutures={(v) => saveAssumption(r.cropId, { assumed_futures: v })}
                onClearAssumptions={() => saveAssumption(r.cropId, { assumed_futures: null, assumed_basis: 0 })}
              />
            ) : (
            <CropSection
              key={`${r.cropId}-${year}`}
              row={r}
              advanced={cropMeta.get(r.cropId) ?? false}
              basisOpen={basisExpanded.includes(r.cropId)}
              onToggleBasis={() => toggleBasis(r.cropId)}
              detailsOpen={expanded.includes(r.cropId)}
              onToggleDetails={() => toggleRow(r.cropId)}
              cropYear={year}
              onSaveBasis={(v) => saveAssumption(r.cropId, { assumed_basis: v })}
              onSaveFutures={(v) => saveAssumption(r.cropId, { assumed_futures: v })}
              onClearAssumptions={() => saveAssumption(r.cropId, { assumed_futures: null, assumed_basis: 0 })}
            />
            )
          ))}
        </div>
      )}

      {/* Assumptions slide-over */}
      {assumptionsOpen && year != null && (
        <AssumptionsPanel
          crops={plantedCrops} year={year} assumptions={assumptions}
          segByCrop={segByCrop} actualByCrop={actualByCrop}
          onSave={saveAssumption} onClose={() => setAssumptionsOpen(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Full-width crop section. The header is the always-visible at-a-glance layer —
// identity (left) + headline numbers (right, which reflect any active what-if and
// carry an assumption marker), with the marketing position bars full width beneath
// — and the chevron expands a responsive detail grid of
// Avg Futures Price Buildup | Basis Buildup | Profitability, with a full-width
// horizontal What-If row beneath it.
// Adapts to the crop's marketing complexity: simple (forwards only) shows
// Sold/Unsold and hides all hedging and basis language.
// ---------------------------------------------------------------------------
function CropSection({
  row, advanced, basisOpen, onToggleBasis, detailsOpen, onToggleDetails,
  cropYear, onSaveBasis, onSaveFutures, onClearAssumptions,
}: {
  row: MarketingRow
  advanced: boolean
  basisOpen: boolean
  onToggleBasis: () => void
  detailsOpen: boolean
  onToggleDetails: () => void
  cropYear: number | null
  onSaveBasis: (v: number) => void
  onSaveFutures: (v: number | null) => void
  onClearAssumptions: () => void
}) {
  const prod = row.totalProduction
  const profitTone = row.totalProfit == null ? 'text-slate-400' : row.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'
  const be = breakevenOf(row)

  // --- What-if pricing. Both the futures price and the basis are STANDING
  //     assumptions persisted to crop_assumptions, so they survive leaving the
  //     page and are wiped by "Clear assumptions". Inputs save on blur. ---
  const nc = cropYear != null ? newCropContract(row.cropName, cropYear) : null
  const expired = nc != null ? (() => { const now = new Date(); return nc.year * 12 + nc.monthNum < now.getFullYear() * 12 + (now.getMonth() + 1) })() : false
  const [wfFutures, setWfFutures] = useState(row.assumedFutures != null ? String(row.assumedFutures) : '')
  const [wfSymbol, setWfSymbol] = useState<string | null>(null)
  const [wfStale, setWfStale] = useState(false)
  const [wfNote, setWfNote] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [basisInput, setBasisInput] = useState(row.assumedBasis ? String(row.assumedBasis) : '')

  const wfFut = wfFutures.trim() === '' || !Number.isFinite(Number(wfFutures)) ? null : Number(wfFutures)
  const wfBasis = basisInput.trim() === '' || !Number.isFinite(Number(basisInput)) ? (row.assumedBasis ?? 0) : Number(basisInput)
  // Priced bushels: futures-priced (advanced) vs cash-contracted (simple) — so a
  // forwards-only crop's contracted bushels count as priced, not unpriced.
  const scenarioPricedBu = advanced ? row.futuresPricedBu : row.contractedBu
  const scenarioUnpricedBu = Math.max(0, prod - scenarioPricedBu)
  const scenario = wfFut != null ? scenarioFor(row, wfFut, wfBasis, advanced) : null

  // --- Headline stats reflect any assumed futures the user has entered (the
  //     scenario re-values the unpriced bushels); otherwise the saved figures. ---
  const headlineAvg = scenario ? scenario.totalAvgPrice : row.totalAvgPrice
  const headlineRevenueAc = scenario ? scenario.revenuePerAcre : row.revenuePerAcre
  const headlineProfitAc = scenario ? scenario.profitPerAcre : row.profitPerAcre
  const headlineTotalProfit = scenario ? scenario.totalProfit : row.totalProfit
  const headlineProfitTone = headlineTotalProfit == null ? 'text-slate-400' : headlineTotalProfit >= 0 ? 'text-green-700' : 'text-red-700'
  // Breakeven yield = cost/acre ÷ the SAME large "Total avg price" shown in the
  // headline (the effective price over all production, reflecting any assumptions),
  // not the futures+basis buildup price — so cost ÷ that price stays consistent
  // with what the card displays.
  const beYieldPerAcre = row.costPerAcre != null && headlineAvg != null && headlineAvg > 0 ? row.costPerAcre / headlineAvg : null
  // "Includes assumptions" whenever some production isn't fully locked — the
  // unpriced bushels are valued with the assumed futures and/or assumed basis.
  // A single amber tier, the same whether the assumption is basis or futures.
  const includesAssumptions = row.lockedPriceBu + 0.5 < prod
  const assumptionBu = Math.max(0, prod - row.lockedPriceBu)
  const markerTitle = advanced
    ? `Includes assumed pricing on ${bu(assumptionBu)} unpriced bushels (${bu(row.futuresAssumedBu)} futures, ${bu(row.basisAssumedBu)} basis). Actual locked price on the remaining ${bu(row.lockedPriceBu)} bu.`
    : `Includes assumed pricing on ${bu(assumptionBu)} unsold bushels (valued at the average cash price). Locked price on the ${bu(row.lockedPriceBu)} bu already contracted.`
  const markSup = includesAssumptions ? <sup className="text-amber-600"> *</sup> : null
  // Avg futures across ALL production once an assumed futures price is entered:
  // priced bushels at their actual avg futures, the unpriced rest at the assumed
  // price. This is exactly the futures component of the headline (the basis blend
  // is the other half), so the buildup reconciles with the headline.
  const blendedFutures = wfFut != null && prod > 0 && row.avgFutures != null
    ? (row.futuresPricedBu * row.avgFutures + scenarioUnpricedBu * wfFut) / prod
    : null

  async function useTodaysPrice() {
    if (!nc || expired) return
    setFetching(true); setWfNote(null)
    try {
      const res = await fetch('/api/market-prices', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols: [nc.symbol] }),
      })
      const json = await res.json().catch(() => null)
      const p = json?.prices?.[0]
      if (p && p.price != null) { setWfFutures(String(p.price)); setWfSymbol(nc.symbol); setWfStale(!!p.stale); onSaveFutures(Number(p.price)) }
      else setWfNote('No price available — enter manually.')
    } catch {
      setWfNote('Could not fetch — enter manually.')
    } finally { setFetching(false) }
  }
  function commitBasis() {
    const v = basisInput.trim() === '' ? 0 : Number(basisInput)
    if (Number.isFinite(v) && v !== (row.assumedBasis ?? 0)) onSaveBasis(v)
  }
  // Persist the assumed futures on blur (empty clears it back to null).
  function commitFutures() {
    const t = wfFutures.trim()
    if (t === '') { if (row.assumedFutures != null) onSaveFutures(null); return }
    const v = Number(t)
    if (Number.isFinite(v) && v !== (row.assumedFutures ?? null)) onSaveFutures(v)
  }
  // Wipe both assumptions for this crop and reset the inputs to match.
  const hasAssumptions = row.assumedFutures != null || (row.assumedBasis ?? 0) !== 0
  function clearAssumptions() {
    setWfFutures(''); setWfSymbol(null); setWfStale(false); setWfNote(null)
    setBasisInput('')
    onClearAssumptions()
  }
  // The pencil next to "Assumed basis" in the Basis Buildup block jumps to the
  // canonical assumed-basis input in the What-If block (same expanded grid).
  const basisInputId = `assumed-basis-${row.cropId}`
  function focusBasisInput() {
    const el = document.getElementById(basisInputId) as HTMLInputElement | null
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.focus({ preventScroll: true })
  }

  return (
    <section className="bg-white rounded-xl shadow avoid-break">
      {/* Header — the always-visible at-a-glance layer. Top row: identity (left)
          + headline numbers (right); the position bars run full width below so
          they're never crunched between the two. */}
      <div className="p-4 md:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          {/* Identity — acres and yield carry the same weight as the price metrics */}
          <div>
            <div className="font-bold text-xl leading-tight">{row.cropName}</div>
            <div className="text-sm text-slate-500 tabular-nums mt-0.5">{bu(prod)} bu production</div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500 uppercase tracking-wide">Acres</div>
            <div className="text-2xl font-bold tabular-nums leading-tight">{bu(row.acres)}</div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500 uppercase tracking-wide">Yield</div>
            <div className="text-2xl font-bold tabular-nums leading-tight">
              {row.yield != null
                ? <>{row.yield.toFixed(1)} <span className="text-sm font-normal text-slate-500">bu/ac {row.yieldLabel}</span></>
                : '—'}
            </div>
          </div>

          {/* Headline numbers — large, color-coded. Reflect any assumed futures /
              basis the user has entered, and carry the assumption marker. */}
          <div className="flex items-center justify-between sm:justify-end gap-4 lg:gap-8 flex-wrap ml-auto">
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">{advanced ? 'Total avg price' : 'Avg price'}</div>
              <div className="text-2xl font-bold tabular-nums leading-tight">{headlineAvg != null ? price2(headlineAvg) : '—'}{markSup}</div>
              {advanced && <FuturesTag row={row} />}
              {advanced && <BasisTag row={row} />}
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Profit / acre</div>
              <div className={`text-2xl font-bold tabular-nums leading-tight ${headlineProfitTone}`}>
                {headlineProfitAc != null ? usd0(headlineProfitAc) : headlineRevenueAc != null ? 'set cost' : '—'}{markSup}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Total profit</div>
              <div className={`text-2xl font-bold tabular-nums leading-tight ${headlineProfitTone}`}>{headlineTotalProfit != null ? usd0(headlineTotalProfit) : '—'}{markSup}</div>
            </div>
          </div>
        </div>

        {/* Assumption legend — unmistakable that the headline leans on assumed
            pricing for the unpriced bushels. Hidden entirely when fully priced. */}
        {includesAssumptions && (
          <div className="flex justify-end -mt-1">
            <AssumptionBadge title={markerTitle} />
          </div>
        )}

        {/* Marketing position — full-width bars below the metrics */}
        <div className="min-w-0">
          {!advanced ? (
            <PositionBlock title="Sold" prod={prod} green={row.contractedBu} greenLabel="Sold" grayLabel="Unsold" />
          ) : (
            <div className="space-y-1.5">
              <PositionBlock title="Futures-priced" prod={prod} green={row.futuresPricedBu} greenLabel="Priced" grayLabel="Unpriced"
                avg={row.avgFutures != null ? `avg ${price2(row.avgFutures)}` : undefined} />
              <button type="button" onClick={onToggleBasis} className="text-xs text-sky-700 font-medium no-print">
                {basisOpen ? '▾ Hide basis' : '▸ Show basis'}
              </button>
              {basisOpen && (
                <PositionBlock title="Basis-priced" prod={prod} green={row.basisLockedBu} greenLabel="Basis set" grayLabel="No basis"
                  avg={`avg ${basis2(row.avgBasis)} (${basisStateLabel(row)})`} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Details toggle — a full-width labeled bar, hard to miss */}
      <button
        type="button" onClick={onToggleDetails} aria-expanded={detailsOpen}
        className="no-print w-full flex items-center justify-center gap-1.5 border-t border-slate-100 px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 rounded-b-xl"
      >
        {detailsOpen
          ? <>▾ Hide details</>
          : <>▸ Show details <span className="font-normal text-slate-400">— futures &amp; basis buildup, what-if &amp; profitability</span></>}
      </button>

      {/* Expanded detail — side-by-side columns across the width; collapses to
          2-up, then 1-up on narrow screens. Never scrolls horizontally. */}
      {detailsOpen && (
        <div className="border-t border-slate-100 p-4 md:p-5 space-y-5">
          {/* Buildup + Profitability cards — wider now that What-If moved to a
              full-width row below: 3-up (advanced) / 2-up (simple) on wide screens,
              collapsing to 2-up then 1-up. */}
          <div className={`grid grid-cols-1 sm:grid-cols-2 ${advanced ? 'xl:grid-cols-3' : 'xl:grid-cols-2'} gap-x-8 gap-y-5 text-sm`}>
            {/* Block 1 — Average Futures Price Buildup (a line-item ledger). */}
            <DetailSection title={advanced ? 'Avg Futures Price Buildup' : 'Pricing'}>
              {advanced ? (
                row.futuresSources.length > 0 ? (
                  <>
                    {row.futuresSources.map((s, i) => (
                      <Row key={i} label={s.label} value={`${bu(s.bushels)} bu @ ${price2(s.avgPrice)}`} />
                    ))}
                    {row.hedgeRealizedPnl !== 0 ? (
                      <>
                        <div className="border-t border-slate-200 pt-0.5">
                          <Row label={`Weighted avg futures (${bu(row.futuresPricedBu)} bu)`} value={row.rawAvgFutures != null ? price2(row.rawAvgFutures) : 'N/A'} tone="text-slate-600" />
                        </div>
                        <Row label="Realized hedge P&L" value={`${row.hedgeAdjPerBu >= 0 ? '+' : ''}${price2(row.hedgeAdjPerBu)}/bu`} tone={row.hedgeAdjPerBu > 0 ? 'text-green-700' : row.hedgeAdjPerBu < 0 ? 'text-red-700' : undefined} />
                        <div className="text-[11px] text-slate-400 leading-snug">{fmtPnl(row.hedgeRealizedPnl)} spread across {bu(prod)} bu total production</div>
                        <div className="border-t border-slate-300 pt-1">
                          <Row label="= Average futures price" value={row.avgFutures != null ? price2(row.avgFutures) : 'N/A'} tone="text-slate-900 font-bold" />
                        </div>
                      </>
                    ) : (
                      <div className="border-t border-slate-300 pt-1">
                        <Row label="= Average futures price" value={row.avgFutures != null ? price2(row.avgFutures) : 'N/A'} tone="text-slate-900 font-bold" />
                      </div>
                    )}
                    {/* Assumed futures price on the unpriced bushels folds into the
                        buildup, then re-foots to an avg across all production. */}
                    {wfFut != null && scenarioUnpricedBu > 0 && (
                      <div className="border-t border-amber-200 pt-1 mt-1 space-y-0.5">
                        <Row label={`Assumed · unpriced (${bu(scenarioUnpricedBu)} bu)`} value={price2(wfFut)} tone="text-amber-700" />
                        {blendedFutures != null && <Row label="= Avg futures incl. assumed" value={price2(blendedFutures)} tone="text-slate-900 font-bold" />}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-slate-400">No futures positions — priced via flat cash contracts.</div>
                )
              ) : (
                <Row label="Avg cash price" value={row.totalAvgPrice != null ? price2(row.totalAvgPrice) : '—'} tone="text-slate-900 font-semibold" />
              )}
            </DetailSection>

            {/* Block 2 — Basis Buildup (advanced only), with the state front-and-center. */}
            {advanced && (
              <DetailSection title="Basis Buildup">
                {row.basisLockedBu > 0 && <Row label="Locked basis" value={`${bu(row.basisLockedBu)} bu @ ${basis2(row.basisLockedAvg)}`} />}
                {row.basisAssumedBu > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">
                      Assumed basis
                      <button type="button" onClick={focusBasisInput} className="no-print ml-1.5 text-sky-700 hover:text-sky-900" title="Edit the assumed basis (in What-If)" aria-label="Edit the assumed basis">✎</button>
                    </dt>
                    <dd className="tabular-nums text-amber-700">{bu(row.basisAssumedBu)} bu @ {basis2(row.assumedBasis)}</dd>
                  </div>
                )}
                <div className="border-t border-slate-300 pt-1 flex justify-between gap-3 items-baseline">
                  <dt className="font-bold text-slate-900">= Basis</dt>
                  <dd className="text-right whitespace-nowrap">
                    <span className={`tabular-nums font-bold ${row.basisState === 'actual' ? 'text-slate-900' : 'text-amber-700'}`}>{basis2(row.avgBasis)}</span>
                    {row.basisState !== 'blended' && <span className={`ml-1.5 text-[11px] uppercase tracking-wide font-semibold ${row.basisState === 'actual' ? 'text-slate-500' : 'text-amber-600'}`}>{row.basisState}</span>}
                  </dd>
                </div>
              </DetailSection>
            )}

            {/* Block 3 — Profitability. */}
            <DetailSection title="Profitability">
              <Row label="Cost / acre" value={usd(row.costPerAcre)} />
              <Row label="Cost / bu" value={row.costPerBu != null ? price2(row.costPerBu) : '—'} />
              <Row label="Revenue / acre" value={usd(row.revenuePerAcre)} />
              <Row label="Profit / acre" value={row.profitPerAcre != null ? usd(row.profitPerAcre) : row.revenuePerAcre != null ? 'set cost' : '—'} tone={profitTone} />
              <div className="border-t border-slate-300 pt-1">
                <Row label="= Total profit" value={row.totalProfit != null ? usd(row.totalProfit) : '—'} tone={`font-bold ${profitTone}`} />
              </div>
              <Row label="Breakeven price" value={be.price != null ? `${price2(be.price)}/bu` : '—'} />
              <Row label="Breakeven yield" value={beYieldPerAcre != null ? `${beYieldPerAcre.toFixed(1)} bu/ac` : '—'} />
            </DetailSection>
          </div>

          {/* What-If on Unpriced Bushels — full-width, horizontal. The assumed
              futures price and assumed basis are STANDING assumptions: they persist
              to crop_assumptions (survive leaving the page), save on blur, and feed
              the headline + futures buildup above. "Clear assumptions" wipes both.
              Each input keeps its explanation beside it. */}
          <div className="rounded-lg bg-sky-50 border border-sky-200 p-3 sm:p-4 no-print text-sm">
            <div className="flex items-baseline gap-3 mb-3">
              <div className="font-semibold text-sky-900">What-If on Unpriced Bushels</div>
              {hasAssumptions && (
                <button type="button" onClick={clearAssumptions} className="ml-auto text-xs text-slate-500 hover:text-red-600 font-medium">
                  Clear assumptions
                </button>
              )}
            </div>
            <div className="flex flex-col lg:flex-row lg:items-start gap-x-8 gap-y-4">
              {/* Assumed futures — input + its explanation, kept together. */}
              <div className="space-y-1 lg:max-w-xs">
                <div className="text-xs text-slate-600">{advanced ? 'Unpriced futures bushels' : 'Unsold bushels'}: <span className="tabular-nums font-medium">{bu(scenarioUnpricedBu)}</span></div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <input type="number" step="0.01" inputMode="decimal" value={wfFutures} placeholder={advanced ? 'futures $/bu' : '$/bu'}
                    onChange={(e) => { setWfFutures(e.target.value); setWfSymbol(null); setWfNote(null) }} onBlur={commitFutures}
                    className="rounded border border-slate-300 px-2 py-1 w-28 text-right" />
                  {nc && !expired && <button type="button" onClick={useTodaysPrice} disabled={fetching} className="text-xs text-sky-700 font-medium disabled:opacity-50">{fetching ? 'Fetching…' : 'Use today’s price'}</button>}
                  {!nc && <span className="text-xs text-slate-400">{advanced ? 'No futures contract' : 'Enter a price'}</span>}
                </div>
                {nc && expired && <div className="text-xs text-amber-700">Contract expired — enter price manually.</div>}
                {/* Show the futures symbol only in advanced mode (no hedging jargon on simple sections). */}
                {wfSymbol && wfFut != null && <div className="text-xs text-slate-500">{advanced ? `${wfSymbol} · ` : 'Today · '}{price2(wfFut)}{wfStale ? ' (cached)' : ''}</div>}
                {wfNote && <div className="text-xs text-amber-700">{wfNote}</div>}
                {/* Explanation under the futures input. */}
                <div className="text-xs text-slate-400">Assumed {advanced ? 'futures ' : ''}price — saves automatically; values the unpriced bushels until cleared.</div>
              </div>
              {/* Assumed basis — input + its explanation, kept together. */}
              {advanced && (
                <div className="space-y-1 lg:max-w-xs">
                  <div className="text-xs text-slate-600">Bushels at assumed basis: <span className="tabular-nums font-medium">{bu(row.basisAssumedBu)}</span></div>
                  <input id={basisInputId} type="number" step="0.01" inputMode="decimal" value={basisInput} placeholder="basis $/bu"
                    onChange={(e) => setBasisInput(e.target.value)} onBlur={commitBasis}
                    className="rounded border border-slate-300 px-2 py-1 w-28 text-right" />
                  <div className="text-xs text-slate-400">Assumed basis — saves automatically; values every bushel without locked basis.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Cotton crop section — lbs of lint and ¢/lb throughout. Production + futures
// hedges only: no Sold segment and no basis buildup (physical cotton marketing
// isn't tracked yet, and cotton has no basis concept until it is). The What-If
// re-prices the unhedged lbs at a scenario ¢/lb against the crop-year CTZ.
// ---------------------------------------------------------------------------
function CottonSection({ row, detailsOpen, onToggleDetails, cropYear, onSaveFutures, onClearAssumptions }: {
  row: MarketingRow
  detailsOpen: boolean
  onToggleDetails: () => void
  cropYear: number | null
  onSaveFutures: (v: number | null) => void
  onClearAssumptions: () => void
}) {
  const prod = row.totalProduction
  const be = breakevenOf(row)
  const nc = cropYear != null ? newCropContract(row.cropName, cropYear) : null
  const expired = nc != null ? (() => { const now = new Date(); return nc.year * 12 + nc.monthNum < now.getFullYear() * 12 + (now.getMonth() + 1) })() : false
  const [wfFutures, setWfFutures] = useState(row.assumedFutures != null ? String(row.assumedFutures) : '')
  const [wfSymbol, setWfSymbol] = useState<string | null>(null)
  const [wfStale, setWfStale] = useState(false)
  const [wfNote, setWfNote] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const wfFut = wfFutures.trim() === '' || !Number.isFinite(Number(wfFutures)) ? null : Number(wfFutures)
  // Advanced-mode scenario: the ¢/lb delta hits exactly the unhedged lbs (the
  // basis term is structurally 0 for cotton).
  const scenario = wfFut != null ? scenarioFor(row, wfFut, 0, true) : null

  const headlineAvg = scenario ? scenario.totalAvgPrice : row.totalAvgPrice
  const headlineRevenueAc = scenario ? scenario.revenuePerAcre : row.revenuePerAcre
  const headlineProfitAc = scenario ? scenario.profitPerAcre : row.profitPerAcre
  const headlineTotalProfit = scenario ? scenario.totalProfit : row.totalProfit
  const headlineProfitTone = headlineTotalProfit == null ? 'text-slate-400' : headlineTotalProfit >= 0 ? 'text-green-700' : 'text-red-700'
  // Unhedged lbs are always valued at an assumed/market price — flag it.
  const includesAssumptions = row.unpricedBu > 0.5
  const markerTitle = `Includes assumed pricing on ${bu(row.unpricedBu)} unhedged lbs (valued at ${row.assumedFutures != null ? 'your assumed price' : 'the current futures estimate'}). Open hedges cover the remaining ${bu(Math.min(row.openHedgeBu, prod))} lbs.`
  const markSup = includesAssumptions ? <sup className="text-amber-600"> *</sup> : null

  async function useTodaysPrice() {
    if (!nc || expired) return
    setFetching(true); setWfNote(null)
    try {
      const res = await fetch('/api/market-prices', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols: [nc.symbol] }),
      })
      const json = await res.json().catch(() => null)
      const p = json?.prices?.[0]
      if (p && p.price != null) { setWfFutures(String(p.price)); setWfSymbol(nc.symbol); setWfStale(!!p.stale); onSaveFutures(Number(p.price)) }
      else setWfNote('No price available — enter manually.')
    } catch {
      setWfNote('Could not fetch — enter manually.')
    } finally { setFetching(false) }
  }
  function commitFutures() {
    const t = wfFutures.trim()
    if (t === '') { if (row.assumedFutures != null) onSaveFutures(null); return }
    const v = Number(t)
    if (Number.isFinite(v) && v !== (row.assumedFutures ?? null)) onSaveFutures(v)
  }
  function clearAssumptions() {
    setWfFutures(''); setWfSymbol(null); setWfStale(false); setWfNote(null)
    onClearAssumptions()
  }

  return (
    <section className="bg-white rounded-xl shadow avoid-break">
      <div className="p-4 md:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div>
            <div className="font-bold text-xl leading-tight">{row.cropName}</div>
            <div className="text-sm text-slate-500 tabular-nums mt-0.5">
              {bu(prod)} lbs lint{row.cottonBales != null ? ` · ${bu(row.cottonBales)} bales` : ''}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500 uppercase tracking-wide">Acres</div>
            <div className="text-2xl font-bold tabular-nums leading-tight">{bu(row.acres)}</div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500 uppercase tracking-wide">Yield</div>
            <div className="text-2xl font-bold tabular-nums leading-tight">
              {row.yield != null
                ? <>{bu(row.yield)} <span className="text-sm font-normal text-slate-500">lbs lint/ac {row.yieldLabel}</span></>
                : '—'}
            </div>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-4 lg:gap-8 flex-wrap ml-auto">
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Avg price</div>
              <div className="text-2xl font-bold tabular-nums leading-tight">{headlineAvg != null ? cents2(headlineAvg) : '—'}{markSup}</div>
              {row.openHedgeAvg != null && (
                <div className="text-xs text-slate-500 mt-0.5">Hedged: <span className="tabular-nums">{cents2(row.openHedgeAvg)}</span></div>
              )}
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Profit / acre</div>
              <div className={`text-2xl font-bold tabular-nums leading-tight ${headlineProfitTone}`}>
                {headlineProfitAc != null ? usd0(headlineProfitAc) : headlineRevenueAc != null ? 'set cost' : '—'}{markSup}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Total profit</div>
              <div className={`text-2xl font-bold tabular-nums leading-tight ${headlineProfitTone}`}>{headlineTotalProfit != null ? usd0(headlineTotalProfit) : '—'}{markSup}</div>
            </div>
          </div>
        </div>

        {includesAssumptions && (
          <div className="flex justify-end -mt-1">
            <AssumptionBadge title={markerTitle} />
          </div>
        )}

        <div className="min-w-0 space-y-1">
          <PositionBlock title="Hedged" prod={prod} green={row.openHedgeBu} greenLabel="Hedged" grayLabel="Unhedged"
            avg={row.openHedgeAvg != null ? `avg ${cents2(row.openHedgeAvg)}` : undefined} />
          <p className="text-xs text-slate-500 italic">
            Physical cotton marketing not yet tracked — showing production and futures hedges only.
          </p>
        </div>
      </div>

      <button
        type="button" onClick={onToggleDetails} aria-expanded={detailsOpen}
        className="no-print w-full flex items-center justify-center gap-1.5 border-t border-slate-100 px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 rounded-b-xl"
      >
        {detailsOpen
          ? <>▾ Hide details</>
          : <>▸ Show details <span className="font-normal text-slate-400">— hedge pricing, what-if &amp; profitability</span></>}
      </button>

      {detailsOpen && (
        <div className="border-t border-slate-100 p-4 md:p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5 text-sm">
            <DetailSection title="Hedge Pricing (¢/lb)">
              {row.futuresSources.length > 0 ? (
                <>
                  {row.futuresSources.map((s, i) => (
                    <Row key={i} label={s.label} value={`${bu(s.bushels)} lbs @ ${cents2(s.avgPrice)}`} />
                  ))}
                  {row.hedgeRealizedPnl !== 0 && (
                    <>
                      <Row label="Realized hedge P&L" value={`${row.hedgeAdjPerBu >= 0 ? '+' : ''}${cents2(row.hedgeAdjPerBu)}/lb`} tone={row.hedgeAdjPerBu > 0 ? 'text-green-700' : row.hedgeAdjPerBu < 0 ? 'text-red-700' : undefined} />
                      <div className="text-[11px] text-slate-400 leading-snug">{fmtPnl(row.hedgeRealizedPnl)} spread across {bu(prod)} lbs total production</div>
                    </>
                  )}
                </>
              ) : (
                <div className="text-slate-400">No open CT hedges.</div>
              )}
              {row.unpricedBu > 0 && (
                <Row label={`Unhedged (${bu(row.unpricedBu)} lbs)`} value={row.unpricedFuturesPrice > 0 ? cents2(row.unpricedFuturesPrice) : '—'} tone="text-amber-700" />
              )}
              <div className="border-t border-slate-300 pt-1">
                <Row label="= Effective avg price" value={headlineAvg != null ? cents2(headlineAvg) : '—'} tone="text-slate-900 font-bold" />
              </div>
              {row.hedgeRealizedPnl !== 0 && (
                <Row label="Realized hedge P&L (in revenue)" value={fmtPnl(row.hedgeRealizedPnl)} tone={row.hedgeRealizedPnl > 0 ? 'text-green-700' : 'text-red-700'} />
              )}
            </DetailSection>

            <DetailSection title="Profitability">
              <Row label="Cost / acre" value={usd(row.costPerAcre)} />
              <Row label="Cost / lb" value={row.costPerBu != null ? cents2(row.costPerBu) : '—'} />
              <Row label="Revenue / acre" value={usd(row.revenuePerAcre)} />
              <Row label="Profit / acre" value={row.profitPerAcre != null ? usd(row.profitPerAcre) : row.revenuePerAcre != null ? 'set cost' : '—'} tone={headlineProfitTone} />
              <div className="border-t border-slate-300 pt-1">
                <Row label="= Total profit" value={row.totalProfit != null ? usd(row.totalProfit) : '—'} tone={`font-bold ${headlineProfitTone}`} />
              </div>
              <Row label="Breakeven price" value={be.price != null ? `${cents2(be.price)}/lb` : '—'} />
              <Row label="Breakeven yield" value={be.yieldPerAcre != null ? `${bu(be.yieldPerAcre)} lbs/ac` : '—'} />
            </DetailSection>
          </div>

          <div className="rounded-lg bg-sky-50 border border-sky-200 p-3 sm:p-4 no-print text-sm">
            <div className="flex items-baseline gap-3 mb-3">
              <div className="font-semibold text-sky-900">What-If on Unhedged Lbs</div>
              {row.assumedFutures != null && (
                <button type="button" onClick={clearAssumptions} className="ml-auto text-xs text-slate-500 hover:text-red-600 font-medium">
                  Clear assumptions
                </button>
              )}
            </div>
            <div className="space-y-1 lg:max-w-md">
              <div className="text-xs text-slate-600">Unhedged lbs: <span className="tabular-nums font-medium">{bu(row.unpricedBu)}</span></div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <input type="number" step="0.01" inputMode="decimal" value={wfFutures} placeholder="¢/lb"
                  onChange={(e) => { setWfFutures(e.target.value); setWfSymbol(null); setWfNote(null) }} onBlur={commitFutures}
                  className="rounded border border-slate-300 px-2 py-1 w-28 text-right" />
                {nc && !expired && <button type="button" onClick={useTodaysPrice} disabled={fetching} className="text-xs text-sky-700 font-medium disabled:opacity-50">{fetching ? 'Fetching…' : 'Use today’s price'}</button>}
                {!nc && <span className="text-xs text-slate-400">Enter a price</span>}
              </div>
              {nc && expired && <div className="text-xs text-amber-700">Contract expired — enter price manually.</div>}
              {wfSymbol && wfFut != null && <div className="text-xs text-slate-500">{wfSymbol} · {cents2(wfFut)}{wfStale ? ' (cached)' : ''}</div>}
              {wfNote && <div className="text-xs text-amber-700">{wfNote}</div>}
              <div className="text-xs text-slate-400">Assumed ¢/lb — saves automatically; values the unhedged lbs until cleared.</div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// The futures half of Total Avg Price, shown under it the same way as basis: the
// realized average futures over priced bushels (slate), or — when the crop is
// entirely unpriced — the assumed futures the user entered (amber, dashed).
function FuturesTag({ row }: { row: MarketingRow }) {
  if (row.avgFutures != null) {
    return (
      <div className="text-xs text-slate-500 mt-0.5">
        Futures: <span className="tabular-nums">{price2(row.avgFutures)}</span>
      </div>
    )
  }
  if (row.assumedFutures != null) {
    return (
      <div className="text-xs text-amber-700 mt-0.5">
        Futures: <span className="tabular-nums underline decoration-dashed decoration-amber-400 underline-offset-2">{price2(row.assumedFutures)}</span> (assumed)
      </div>
    )
  }
  return null
}

// The basis qualifier under Total Avg Price — a basis figure never appears
// without its (actual / assumed / blended) state. Assumed gets a dashed
// underline; blended shows the locked/assumed composition on hover or tap
// (and, in full, in the Basis Buildup block).
function BasisTag({ row }: { row: MarketingRow }) {
  if (row.basisState === 'assumed') {
    return (
      <div className="text-xs text-amber-700 mt-0.5">
        Basis: <span className="tabular-nums underline decoration-dashed decoration-amber-400 underline-offset-2">{basis2(row.avgBasis)}</span> (assumed)
      </div>
    )
  }
  const blended = row.basisState === 'blended'
  return (
    <div className="text-xs text-slate-500 mt-0.5" title={blended ? basisCompositionTitle(row) : undefined}>
      Basis: <span className={`tabular-nums${blended ? ' underline decoration-dotted decoration-slate-400 underline-offset-2 cursor-help' : ''}`}>{basis2(row.avgBasis)}</span>{blended ? '' : ` (${basisStateLabel(row)})`}
    </div>
  )
}

// Headline assumption marker (amber). Flags that the numbers lean on assumed
// pricing — the assumed futures and/or assumed basis on the unpriced bushels.
// The full "X unpriced (Y futures, Z basis)" explanation lives in the tooltip.
function AssumptionBadge({ title }: { title: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 text-[11px] font-medium px-2 py-0.5 cursor-help">
      <span aria-hidden>✷</span>&nbsp;includes assumptions
    </span>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="font-semibold text-slate-700 text-xs uppercase tracking-wide mb-1">{title}</div>
      <dl className="space-y-0.5">{children}</dl>
    </div>
  )
}

// One position bar: green segment (priced) vs gray (unpriced), with the % as the
// prominent number. Both green and gray are clamped to total production so two
// bars on the same card share a denominator and read comparably.
function PositionBlock({ title, prod, green, greenLabel, grayLabel, avg }: {
  title: string
  prod: number
  green: number
  greenLabel: string
  grayLabel: string
  // Optional average price/basis to show alongside the bar (e.g. "avg $4.55").
  avg?: string
}) {
  const greenClamped = Math.max(0, Math.min(green, prod))
  const gray = Math.max(0, prod - greenClamped)
  const pct = prod > 0 ? Math.min(100, (green / prod) * 100) : 0
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <span className="text-xs text-slate-500">{title}</span>
        <span className="text-base font-bold tabular-nums">
          {avg && <span className="text-xs font-normal text-slate-500 mr-2">{avg}</span>}
          {pct.toFixed(0)}%
        </span>
      </div>
      <StackedBar height="h-6" segments={[
        { value: greenClamped, className: 'bg-green-600', label: greenClamped > 0 ? bu(greenClamped) : undefined },
        { value: gray, className: 'bg-slate-300', label: gray > 0 ? bu(gray) : undefined },
      ]} />
      <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
        <span>{greenLabel}</span><span>{grayLabel}</span>
      </div>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`tabular-nums ${tone ?? 'text-slate-800'}`}>{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assumptions slide-over panel — collapsible per crop, live recalc, stays open
// ---------------------------------------------------------------------------
function AssumptionsPanel({ crops, year, assumptions, segByCrop, actualByCrop, onSave, onClose }: {
  crops: Crop[]; year: number; assumptions: CropAssumption[]
  segByCrop: Map<string, SegmentAcres>
  actualByCrop: Map<string, { production: number; yield: number | null }>
  onSave: (cropId: string, patch: Partial<CropAssumption>) => void
  onClose: () => void
}) {
  const [openCrop, setOpenCrop] = useState<string | null>(crops[0]?.id ?? null)
  return (
    <div className="fixed inset-0 z-40 no-print">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-xl bg-slate-50 shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <div className="flex-1">
            <h2 className="font-bold">Assumptions — {year}</h2>
            <p className="text-xs text-slate-500">Changes save and recalculate the dashboard live; this panel stays open.</p>
          </div>
          <button onClick={onClose} className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm font-semibold">Done</button>
        </div>
        <div className="p-4 space-y-2">
          <p className="text-xs text-slate-500">
            Enter an overall yield and cost/acre, or break them out by irrigated/dryland (and full-season/double-crop) —
            a blank breakout cell falls back to the overall. On harvest complete, the actual average yield from loads
            replaces the estimate.
          </p>
          {crops.map((c) => {
            const a = assumptions.find((x) => x.crop_id === c.id && x.crop_year === year)
            const isOpen = openCrop === c.id
            const actual = actualByCrop.get(c.id)
            const effYield = (a?.harvest_complete && actual?.yield != null) ? actual.yield : a?.expected_yield ?? null
            const missing = effYield == null
            return (
              <div key={c.id} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenCrop(isOpen ? null : c.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left"
                >
                  <span className="text-slate-400">{isOpen ? '▾' : '▸'}</span>
                  <span className="font-semibold flex-1">{c.name}</span>
                  {missing
                    ? <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">needs yield</span>
                    : <span className="text-xs text-slate-500 tabular-nums">{effYield?.toFixed(1)} {isCottonCrop(c.name) ? 'lbs lint/ac' : 'bu/ac'}{a?.cost_per_acre != null ? ` · ${usd0(a.cost_per_acre)}/ac` : ''}{a?.harvest_complete ? ' · harvested' : ''}</span>}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 border-t border-slate-100">
                    <AssumptionRow
                      key={`${c.id}:${a?.updated_at ?? 'new'}`}
                      crop={c} assumption={a} seg={segByCrop.get(c.id)} actual={actual} onSave={onSave}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function AssumptionRow({ crop, assumption, seg, actual, onSave }: {
  crop: Crop; assumption?: CropAssumption; seg?: SegmentAcres
  actual?: { production: number; yield: number | null }
  onSave: (cropId: string, patch: Partial<CropAssumption>) => void
}) {
  const s0 = (v: number | null | undefined) => (v != null ? String(v) : '')
  const a = assumption
  const [oYield, setOYield] = useState(s0(a?.expected_yield))
  const [yIrr, setYIrr] = useState(s0(a?.expected_yield_irr))
  const [yDry, setYDry] = useState(s0(a?.expected_yield_dry))
  const [yDcIrr, setYDcIrr] = useState(s0(a?.expected_yield_dc_irr))
  const [yDcDry, setYDcDry] = useState(s0(a?.expected_yield_dc_dry))
  const [oCost, setOCost] = useState(s0(a?.cost_per_acre))
  const [cIrr, setCIrr] = useState(s0(a?.cost_per_acre_irr))
  const [cDry, setCDry] = useState(s0(a?.cost_per_acre_dry))
  const [cDcIrr, setCDcIrr] = useState(s0(a?.cost_per_acre_dc_irr))
  const [cDcDry, setCDcDry] = useState(s0(a?.cost_per_acre_dc_dry))

  const toNum = (str: string) => (str.trim() === '' ? null : Number(str))
  const s = seg ?? { fullIrr: 0, fullDry: 0, dcIrr: 0, dcDry: 0 }
  const totalAcres = s.fullIrr + s.fullDry + s.dcIrr + s.dcDry
  // Only distinguish full-season vs double-crop when the crop actually has both.
  const showType = s.fullIrr + s.fullDry > 0 && s.dcIrr + s.dcDry > 0

  const segs = [
    { key: 'irr', acres: s.fullIrr, label: showType ? 'Full-season · Irrigated' : 'Irrigated', y: yIrr, setY: setYIrr, c: cIrr, setC: setCIrr },
    { key: 'dry', acres: s.fullDry, label: showType ? 'Full-season · Dryland' : 'Dryland', y: yDry, setY: setYDry, c: cDry, setC: setCDry },
    { key: 'dcIrr', acres: s.dcIrr, label: showType ? 'Double-crop · Irrigated' : 'Irrigated', y: yDcIrr, setY: setYDcIrr, c: cDcIrr, setC: setCDcIrr },
    { key: 'dcDry', acres: s.dcDry, label: showType ? 'Double-crop · Dryland' : 'Dryland', y: yDcDry, setY: setYDcDry, c: cDcDry, setC: setCDcDry },
  ].filter((row) => row.acres > 0)

  // Acre-weighted average over the segments that have a value entered.
  const weighted = (get: (r: (typeof segs)[number]) => string): number | null => {
    let num = 0, den = 0
    for (const r of segs) { const v = toNum(get(r)); if (v != null) { num += v * r.acres; den += r.acres } }
    return den > 0 ? num / den : null
  }
  const round1 = (n: number) => Math.round(n * 10) / 10
  const round2 = (n: number) => Math.round(n * 100) / 100
  const wYield = weighted((r) => r.y)
  const wCost = weighted((r) => r.c)
  // The overall value used (and saved): the weighted average once any segment is
  // broken out, otherwise the value typed in the overall field.
  const effYield = wYield != null ? round1(wYield) : toNum(oYield)
  const effCost = wCost != null ? round2(wCost) : toNum(oCost)

  // Expected production: each segment uses its own yield, else the overall.
  const prod = segs.length > 0
    ? segs.reduce((sum, r) => sum + (toNum(r.y) ?? effYield ?? 0) * r.acres, 0)
    : (effYield ?? 0) * totalAcres

  const harvestDone = !!(a?.harvest_complete && actual && actual.production > 0)
  // What the overall yield field shows: actual avg after harvest, the weighted
  // average once broken out, else the editable estimate.
  const overallYieldText = harvestDone
    ? (actual?.yield != null ? actual.yield.toFixed(1) : '—')
    : wYield != null ? round1(wYield).toFixed(1) : null

  function save() {
    onSave(crop.id, {
      expected_yield: effYield,
      expected_yield_irr: toNum(yIrr),
      expected_yield_dry: toNum(yDry),
      expected_yield_dc_irr: toNum(yDcIrr),
      expected_yield_dc_dry: toNum(yDcDry),
      cost_per_acre: effCost,
      cost_per_acre_irr: toNum(cIrr),
      cost_per_acre_dry: toNum(cDry),
      cost_per_acre_dc_irr: toNum(cDcIrr),
      cost_per_acre_dc_dry: toNum(cDcDry),
      // assumed_basis is deliberately untouched here — it's edited on the crop
      // section's What-If block, not in this panel (saveAssumption preserves it).
    })
  }

  const ic = 'rounded border border-slate-300 px-2 py-1 w-20 text-right'
  const cell = 'px-1 py-1'
  // Cotton assumptions are lbs of lint per acre (and its actuals come from gin
  // receipts); everything else is bushels. Same fields, the crop's own unit.
  const lbsUnit = isCottonCrop(crop.name)
  const yieldUnit = lbsUnit ? 'lbs/ac' : 'bu/ac'
  const prodUnit = lbsUnit ? 'lbs' : 'bu'
  return (
    <div className="space-y-2 pt-2">
      <label className="text-sm flex items-center gap-1 text-slate-600">
        <input
          type="checkbox"
          checked={a?.harvest_complete ?? false}
          onChange={(e) => {
            const checked = e.target.checked
            const patch: Partial<CropAssumption> = { harvest_complete: checked }
            // On completing harvest, snap the overall estimate yield to actual.
            if (checked && actual?.yield != null) patch.expected_yield = actual.yield
            onSave(crop.id, patch)
          }}
        />
        Harvest complete
      </label>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500">
            <th className={`${cell} text-left font-normal`}></th>
            <th className={`${cell} text-right font-normal`}>Acres</th>
            <th className={`${cell} text-right font-normal`}>Yield {yieldUnit}</th>
            <th className={`${cell} text-right font-normal`}>Cost/ac</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={`${cell} text-slate-600 font-medium`}>Overall</td>
            <td className={`${cell} text-right font-mono text-slate-500`}>{bu(totalAcres)}</td>
            <td className={`${cell} text-right`}>
              {overallYieldText != null
                ? <span className="font-mono">{overallYieldText}</span>
                : <input type="number" step="0.1" value={oYield} onChange={(e) => setOYield(e.target.value)} className={ic} />}
            </td>
            <td className={`${cell} text-right`}>
              {wCost != null
                ? <span className="font-mono">{effCost != null ? usd(effCost) : '—'}</span>
                : <input type="number" step="0.01" value={oCost} onChange={(e) => setOCost(e.target.value)} className={ic} />}
            </td>
          </tr>
          {segs.map((r) => (
            <tr key={r.key}>
              <td className={`${cell} text-slate-600`}>{r.label}</td>
              <td className={`${cell} text-right font-mono text-slate-500`}>{bu(r.acres)}</td>
              <td className={`${cell} text-right`}>
                <input type="number" step="0.1" value={r.y} placeholder={oYield || ''} onChange={(e) => r.setY(e.target.value)} className={ic} />
              </td>
              <td className={`${cell} text-right`}>
                <input type="number" step="0.01" value={r.c} placeholder={oCost || ''} onChange={(e) => r.setC(e.target.value)} className={ic} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3">
        {harvestDone ? (
          <span className="text-sm text-slate-600">Actual production: <span className="font-mono font-semibold">{bu(actual!.production)}</span> {prodUnit}</span>
        ) : (
          <span className="text-sm text-slate-600">Expected production: <span className="font-mono font-semibold">{bu(prod)}</span> {prodUnit}</span>
        )}
        <button onClick={save} className="ml-auto rounded-lg bg-green-700 text-white px-3 py-1 text-sm font-semibold">Save</button>
      </div>
    </div>
  )
}
