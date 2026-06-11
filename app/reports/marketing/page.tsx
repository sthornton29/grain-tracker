'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeMarketing, segmentAcresByCrop, expectedProductionFromBreakout, type MarketingRow, type SegmentAcres } from '@/lib/marketing'
import { fieldCropAggregates, cropsWithCompleteHarvest } from '@/lib/yields'
import { buildDoubleCropSet } from '@/lib/plantings'
import { CONTRACT_TYPE_LABEL, PRICING_STATUS_LABEL, cropToCommodity } from '@/lib/contracts'
import { fmtPnl, buildContractSymbol } from '@/lib/hedging'
import { usePersistentState } from '@/lib/use-persistent-state'
import { StackedBar } from '@/components/reports/report-kit'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'
import type { Contract, Crop, CropAssumption, FuturesPosition, OptionPosition } from '@/lib/types'

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
// Chicago Wheat → JUL (ZWN{yy}). null for crops with no traded future (e.g. Canola).
const NEW_CROP_MONTH: Record<string, { abbr: string; num: number }> = {
  Corn: { abbr: 'DEC', num: 12 },
  Soybeans: { abbr: 'NOV', num: 11 },
  'Chicago Wheat': { abbr: 'JUL', num: 7 },
}
function newCropContract(cropName: string, cropYear: number): { symbol: string; monthNum: number; year: number } | null {
  const commodity = cropToCommodity(cropName)
  if (!commodity) return null
  const m = NEW_CROP_MONTH[commodity]
  const symbol = buildContractSymbol(commodity, `${m.abbr} ${String(cropYear % 100).padStart(2, '0')}`)
  return symbol ? { symbol, monthNum: m.num, year: cropYear } : null
}

// What-if scenario: re-value the unpriced bushels at the what-if price, keeping
// actually-priced bushels at their real average. `pricedBu` = futures-priced
// bushels in advanced mode (cash-contracted in simple mode); `whatIfPrice` is the
// per-bushel price applied to the rest (futures + basis in advanced, a cash price
// in simple). Profit follows the headline rule (price × yield − cost). Pure
// display layer — substitutes inputs into the established methodology.
// Breakeven, consistent with the card's profit (Total Avg $ × yield − cost):
//   price  = cost/acre ÷ yield        ($/bu needed at the expected yield)
//   yield  = cost/acre ÷ total avg $   (bu/ac needed at the average price)
// Both null until a cost is set.
function breakevenOf(row: MarketingRow): { price: number | null; yieldPerAcre: number | null } {
  const cost = row.costPerAcre
  return {
    price: cost != null && row.yield != null && row.yield > 0 ? cost / row.yield : null,
    yieldPerAcre: cost != null && row.totalAvgPrice != null && row.totalAvgPrice > 0 ? cost / row.totalAvgPrice : null,
  }
}

function scenarioFor(row: MarketingRow, pricedBu: number, whatIfPrice: number) {
  const prod = row.totalProduction
  if (prod <= 0 || row.totalAvgPrice == null || row.yield == null) return null
  const pb = Math.min(Math.max(0, pricedBu), prod)
  const unpricedBu = prod - pb
  const totalAvgPrice = (pb * row.totalAvgPrice + unpricedBu * whatIfPrice) / prod
  const revenuePerAcre = round2(totalAvgPrice * row.yield)
  const profitPerAcre = row.costPerAcre != null ? round2(revenuePerAcre - row.costPerAcre) : null
  const totalProfit = profitPerAcre != null ? round2(profitPerAcre * row.acres) : null
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
    const [cr, pl, ct, fp, op, ca, ld, sp] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres, yield_include_override').eq('season_year', cropYear),
      supabase.from('contracts').select('*').eq('crop_year', cropYear),
      supabase.from('futures_positions').select('*').eq('crop_year', cropYear),
      supabase.from('options_positions').select('*').eq('crop_year', cropYear),
      supabase.from('crop_assumptions').select('*').eq('crop_year', cropYear),
      supabase.from('loads').select('id, date, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override').eq('crop_year', cropYear),
      supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels'),
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
    () => (year == null ? [] : computeMarketing({ cropYear: year, crops, plantings, contracts, futures, options, assumptions, actualProductionByCrop: production, expectedProductionByCrop: expProdByCrop, currentFuturesByCrop: currentFutures, harvestCompleteCropIds: harvestCompleteIds })),
    [year, crops, plantings, contracts, futures, options, assumptions, production, expProdByCrop, currentFutures, harvestCompleteIds],
  )

  // Actual average yield (dry bushels from loads ÷ planted acres) per crop, used
  // to snap the estimate yield to actual when a crop is marked harvest-complete.
  const actualByCrop = useMemo(() => {
    const acres = new Map<string, number>()
    for (const p of plantings) acres.set(p.crop_id, (acres.get(p.crop_id) ?? 0) + Number(p.planted_acres ?? 0))
    const m = new Map<string, { production: number; yield: number | null }>()
    for (const c of crops) {
      const prod = production.get(c.id) ?? 0
      const a = acres.get(c.id) ?? 0
      m.set(c.id, { production: prod, yield: prod > 0 && a > 0 ? Math.round((prod / a) * 10) / 10 : null })
    }
    return m
  }, [plantings, crops, production])

  // Crops shown in the assumptions editor: those with plantings this year.
  const plantedCropIds = useMemo(() => new Set(plantings.map((p) => p.crop_id)), [plantings])
  const plantedCrops = crops.filter((c) => plantedCropIds.has(c.id))

  // The only meaningful combined metrics across mixed crops: total acres and
  // total projected profit (mixing corn/soy/wheat production or price is not).
  const combined = useMemo(() => {
    let acres = 0, profit = 0, profitKnown = false
    for (const r of rows) {
      acres += r.acres
      if (r.totalProfit != null) { profit += r.totalProfit; profitKnown = true }
    }
    return { acres, profit: profitKnown ? profit : null }
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
      const commodity = cropToCommodity(r.cropName)
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

  function buildPayload(): ExportPayload {
    // Mirror the cards: a combined-metrics section, then one section per crop with
    // all the detail (production / sales / pricing buildup / profitability).
    const sections: ExportPayload['sections'] = []
    const KV: ExportPayload['sections'][number]['columns'] = [{ label: 'Item' }, { label: 'Value', align: 'right' }]

    sections.push({
      title: 'Summary',
      columns: KV,
      rows: [
        ['Total acres', Math.round(combined.acres)],
        ['Total projected profit', combined.profit != null ? Math.round(combined.profit) : '—'],
      ],
    })

    for (const r of rows) {
      const adv = cropMeta.get(r.cropId) ?? false
      const seg = segByCrop.get(r.cropId)
      const irrAc = seg ? seg.fullIrr + seg.dcIrr : 0
      const dryAc = seg ? seg.fullDry + seg.dcDry : 0
      const cropContracts = contracts.filter((c) => c.crop_id === r.cropId)
      const byType = new Map<string, number>()
      for (const c of cropContracts) {
        const t = CONTRACT_TYPE_LABEL[c.contract_type ?? 'forward']
        byType.set(t, (byType.get(t) ?? 0) + Number(c.contracted_bushels ?? 0))
      }
      const rows2: Array<Array<string | number | null>> = []
      const meta2: ('data' | 'subhead' | 'total')[] = []
      const sub = (t: string) => { rows2.push([t, '']); meta2.push('subhead') }
      const kv = (k: string, v: string | number | null) => { rows2.push([k, v]); meta2.push('data') }

      sub('Production')
      kv('Planted acres', `${Math.round(r.acres)}${irrAc > 0 || dryAc > 0 ? ` (irr ${Math.round(irrAc)} / dry ${Math.round(dryAc)})` : ''}`)
      kv('Yield', r.yield != null ? `${r.yield.toFixed(1)} bu/ac ${r.yieldLabel}` : '—')
      kv('Total production', `${Math.round(r.totalProduction)} bu`)

      sub('Sales')
      kv('Contracted', `${Math.round(r.contractedBu)} bu`)
      kv('Remaining', `${Math.round(r.remaining)} bu`)
      for (const [t, b] of byType) kv(t, `${Math.round(b)} bu`)

      sub('Pricing')
      if (adv) {
        if (r.physicalFuturesBu > 0) kv(`Physical futures (${Math.round(r.physicalFuturesBu)} bu)`, r.physicalFuturesAvg != null ? r.physicalFuturesAvg.toFixed(2) : '—')
        if (r.openHedgeBu > 0) kv(`Open hedges (${Math.round(r.openHedgeBu)} bu)`, r.openHedgeAvg != null ? r.openHedgeAvg.toFixed(2) : '—')
        kv(`Raw avg futures (${Math.round(r.futuresPricedBu)} bu)`, r.rawAvgFutures != null ? r.rawAvgFutures.toFixed(2) : 'N/A')
        kv('Hedge P&L adj / bu', r.hedgeAdjPerBu.toFixed(2))
        kv('Avg futures price', r.avgFutures != null ? r.avgFutures.toFixed(2) : 'N/A')
        // The basis figure never appears without its (actual/assumed/blended)
        // qualifier; when both sides exist, show the composition too.
        if (r.basisLockedBu > 0 && r.basisAssumedBu > 0) {
          kv(`Basis — locked (${Math.round(r.basisLockedBu)} bu)`, r.basisLockedAvg != null ? r.basisLockedAvg.toFixed(2) : '—')
          kv(`Basis — assumed (${Math.round(r.basisAssumedBu)} bu)`, r.assumedBasis.toFixed(2))
        }
        kv(`Basis (${basisStateLabel(r)})`, r.avgBasis.toFixed(2))
        kv('Total avg price', r.totalAvgPrice != null ? r.totalAvgPrice.toFixed(2) : '—')
        if (r.hedgeRealizedPnl !== 0) kv('Realized hedge P&L (in revenue)', Math.round(r.hedgeRealizedPnl))
      } else {
        kv('Avg price', r.totalAvgPrice != null ? r.totalAvgPrice.toFixed(2) : '—')
      }

      sub('Profitability')
      kv('Cost / acre', r.costPerAcre != null ? Math.round(r.costPerAcre) : '—')
      kv('Cost / bu', r.costPerBu != null ? r.costPerBu.toFixed(2) : '—')
      kv('Revenue / acre', r.revenuePerAcre != null ? Math.round(r.revenuePerAcre) : '—')
      kv('Profit / acre', r.profitPerAcre != null ? Math.round(r.profitPerAcre) : '—')
      kv('Total profit', r.totalProfit != null ? Math.round(r.totalProfit) : '—')
      const be = breakevenOf(r)
      kv('Breakeven price', be.price != null ? be.price.toFixed(2) : '—')
      kv('Breakeven yield', be.yieldPerAcre != null ? `${be.yieldPerAcre.toFixed(1)} bu/ac` : '—')

      sections.push({ title: r.cropName, columns: KV, rows: rows2, rowMeta: meta2 })
    }

    return { title: `Marketing — ${year ?? ''}`, filters: `Crop year: ${year ?? '—'}`, sections, singleSheet: true }
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
            title="Edit yield, cost, and basis assumptions for each crop"
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
            <CropSection
              key={`${r.cropId}-${year}`}
              row={r}
              advanced={cropMeta.get(r.cropId) ?? false}
              basisOpen={basisExpanded.includes(r.cropId)}
              onToggleBasis={() => toggleBasis(r.cropId)}
              detailsOpen={expanded.includes(r.cropId)}
              onToggleDetails={() => toggleRow(r.cropId)}
              seg={segByCrop.get(r.cropId)}
              contracts={contracts.filter((c) => c.crop_id === r.cropId)}
              cropYear={year}
              onSaveBasis={(v) => saveAssumption(r.cropId, { assumed_basis: v })}
            />
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
// identity (left) + headline numbers (right), with the marketing position bars
// full width beneath — and the chevron expands a responsive detail grid:
// Production | Sales & Contracts | Pricing Buildup | Profitability & What-If.
// Adapts to the crop's marketing complexity: simple (forwards only) shows
// Sold/Unsold and hides all hedging and basis language.
// ---------------------------------------------------------------------------
function CropSection({
  row, advanced, basisOpen, onToggleBasis, detailsOpen, onToggleDetails,
  seg, contracts, cropYear, onSaveBasis,
}: {
  row: MarketingRow
  advanced: boolean
  basisOpen: boolean
  onToggleBasis: () => void
  detailsOpen: boolean
  onToggleDetails: () => void
  seg?: SegmentAcres
  contracts: Contract[]
  cropYear: number | null
  onSaveBasis: (v: number) => void
}) {
  const prod = row.totalProduction
  const profitTone = row.totalProfit == null ? 'text-slate-400' : row.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'
  const be = breakevenOf(row)

  // Contracted bushels by type, and irr/dry acre split (for the detail grid).
  const byType = new Map<string, number>()
  for (const c of contracts) {
    const t = CONTRACT_TYPE_LABEL[c.contract_type ?? 'forward']
    byType.set(t, (byType.get(t) ?? 0) + Number(c.contracted_bushels ?? 0))
  }
  const irrAc = seg ? seg.fullIrr + seg.dcIrr : 0
  const dryAc = seg ? seg.fullDry + seg.dcDry : 0

  // --- What-if pricing (session-scoped futures; basis persists to assumptions) ---
  const nc = cropYear != null ? newCropContract(row.cropName, cropYear) : null
  const expired = nc != null ? (() => { const now = new Date(); return nc.year * 12 + nc.monthNum < now.getFullYear() * 12 + (now.getMonth() + 1) })() : false
  const [wfFutures, setWfFutures] = useState('')
  const [wfSymbol, setWfSymbol] = useState<string | null>(null)
  const [wfStale, setWfStale] = useState(false)
  const [wfNote, setWfNote] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [basisInput, setBasisInput] = useState(String(row.assumedBasis ?? 0))

  const wfFut = wfFutures.trim() === '' || !Number.isFinite(Number(wfFutures)) ? null : Number(wfFutures)
  const wfBasis = basisInput.trim() === '' || !Number.isFinite(Number(basisInput)) ? (row.assumedBasis ?? 0) : Number(basisInput)
  // Priced bushels: futures-priced (advanced) vs cash-contracted (simple) — so a
  // forwards-only crop's contracted bushels count as priced, not unpriced.
  const scenarioPricedBu = advanced ? row.futuresPricedBu : row.contractedBu
  const scenarioUnpricedBu = Math.max(0, prod - scenarioPricedBu)
  const scenario = wfFut != null ? scenarioFor(row, scenarioPricedBu, advanced ? wfFut + wfBasis : wfFut) : null

  async function useTodaysPrice() {
    if (!nc || expired) return
    setFetching(true); setWfNote(null)
    try {
      const res = await fetch('/api/market-prices', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols: [nc.symbol] }),
      })
      const json = await res.json().catch(() => null)
      const p = json?.prices?.[0]
      if (p && p.price != null) { setWfFutures(String(p.price)); setWfSymbol(nc.symbol); setWfStale(!!p.stale) }
      else setWfNote('No price available — enter manually.')
    } catch {
      setWfNote('Could not fetch — enter manually.')
    } finally { setFetching(false) }
  }
  function commitBasis() {
    const v = basisInput.trim() === '' ? 0 : Number(basisInput)
    if (Number.isFinite(v) && v !== (row.assumedBasis ?? 0)) onSaveBasis(v)
  }
  // The pencil next to "Assumed (… bu)" in the Pricing Buildup column jumps to
  // the canonical assumed-basis input in the What-If block (same expanded grid).
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
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
          {/* Identity */}
          <div>
            <div className="font-bold text-xl leading-tight">{row.cropName}</div>
            <div className="text-sm text-slate-500 tabular-nums mt-0.5">
              {bu(row.acres)} ac · {row.yield != null ? `${row.yield.toFixed(1)} bu/ac ${row.yieldLabel}` : 'yield —'} · {bu(prod)} bu production
            </div>
          </div>

          {/* Headline numbers — large, color-coded */}
          <div className="flex items-center justify-between sm:justify-end gap-4 lg:gap-8 flex-wrap">
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">{advanced ? 'Total avg price' : 'Avg price'}</div>
              <div className="text-2xl font-bold tabular-nums leading-tight">{row.totalAvgPrice != null ? price2(row.totalAvgPrice) : '—'}</div>
              {advanced && <BasisTag row={row} />}
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Profit / acre</div>
              <div className={`text-2xl font-bold tabular-nums leading-tight ${profitTone}`}>
                {row.profitPerAcre != null ? usd0(row.profitPerAcre) : row.revenuePerAcre != null ? 'set cost' : '—'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Total profit</div>
              <div className={`text-2xl font-bold tabular-nums leading-tight ${profitTone}`}>{row.totalProfit != null ? usd0(row.totalProfit) : '—'}</div>
            </div>
            <button
              type="button" onClick={onToggleDetails} aria-expanded={detailsOpen}
              className="no-print rounded-full w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              title={detailsOpen ? 'Hide details' : 'Show details'}
            >
              {detailsOpen ? '▾' : '▸'}
            </button>
          </div>
        </div>

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

      {/* Expanded detail — side-by-side columns across the width; collapses to
          2-up, then 1-up on narrow screens. Never scrolls horizontally. */}
      {detailsOpen && (
        <div className="border-t border-slate-100 p-4 md:p-5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-8 gap-y-5 text-sm">
          <DetailSection title="Production">
            <Row label="Planted acres" value={`${bu(row.acres)}${irrAc > 0 || dryAc > 0 ? ` (irr ${bu(irrAc)} / dry ${bu(dryAc)})` : ''}`} />
            <Row label="Yield" value={row.yield != null ? `${row.yield.toFixed(1)} bu/ac ${row.yieldLabel}` : '—'} />
            <Row label="Total production" value={`${bu(prod)} bu`} />
          </DetailSection>

          <DetailSection title="Sales & Contracts">
            <Row label="Contracted" value={`${bu(row.contractedBu)} bu`} />
            <Row label="Remaining" value={`${bu(row.remaining)} bu`} tone={row.remaining < 0 ? 'text-red-700' : undefined} />
            {[...byType].map(([t, b]) => <Row key={t} label={t} value={`${bu(b)} bu`} />)}
            {byType.size === 0 && <div className="text-slate-400">No contracts.</div>}
          </DetailSection>

          <DetailSection title="Pricing Buildup">
            {advanced ? (
              <>
                {row.physicalFuturesBu > 0 && <Row label={`Physical futures (${bu(row.physicalFuturesBu)} bu)`} value={row.physicalFuturesAvg != null ? price2(row.physicalFuturesAvg) : '—'} />}
                {row.openHedgeBu > 0 && <Row label={`Open hedges (${bu(row.openHedgeBu)} bu)`} value={row.openHedgeAvg != null ? price2(row.openHedgeAvg) : '—'} />}
                <Row label={`Raw avg futures (${bu(row.futuresPricedBu)} bu)`} value={row.rawAvgFutures != null ? price2(row.rawAvgFutures) : 'N/A'} />
                <Row label="Hedge P&L adj / bu" value={`${row.hedgeAdjPerBu >= 0 ? '+' : ''}${price2(row.hedgeAdjPerBu)}`} tone={row.hedgeAdjPerBu > 0 ? 'text-green-700' : row.hedgeAdjPerBu < 0 ? 'text-red-700' : undefined} />
                <Row label="= Avg futures price" value={row.avgFutures != null ? price2(row.avgFutures) : 'N/A'} />
                {/* Basis mini-breakdown: locked vs assumed-valued bushels, then
                    the resulting figure used in Total Avg Price. */}
                <div className="rounded-md bg-slate-50 border border-slate-200 px-2 py-1.5 space-y-0.5 my-1">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">Basis</div>
                  {row.basisLockedBu > 0 && <Row label={`Locked (${bu(row.basisLockedBu)} bu)`} value={basis2(row.basisLockedAvg)} />}
                  {row.basisAssumedBu > 0 && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">
                        Assumed ({bu(row.basisAssumedBu)} bu)
                        <button type="button" onClick={focusBasisInput} className="no-print ml-1.5 text-sky-700 hover:text-sky-900" title="Edit the assumed basis (in What-If Pricing)" aria-label="Edit the assumed basis">✎</button>
                      </dt>
                      <dd className="tabular-nums text-amber-700">{basis2(row.assumedBasis)}</dd>
                    </div>
                  )}
                  <div className="border-t border-slate-200 pt-0.5">
                    <Row label={`= Basis (${basisStateLabel(row)})`} value={basis2(row.avgBasis)} tone={row.basisState === 'assumed' ? 'text-amber-700 font-medium' : 'text-slate-800 font-medium'} />
                  </div>
                </div>
                <div className="border-t border-slate-200 pt-1"><Row label="= Total avg price" value={row.totalAvgPrice != null ? price2(row.totalAvgPrice) : '—'} tone="text-slate-900 font-semibold" /></div>
                {row.hedgeRealizedPnl !== 0 && <Row label="Realized hedge P&L (in revenue)" value={fmtPnl(row.hedgeRealizedPnl)} tone={row.hedgeRealizedPnl > 0 ? 'text-green-700' : 'text-red-700'} />}
              </>
            ) : (
              <Row label="Avg price" value={row.totalAvgPrice != null ? price2(row.totalAvgPrice) : '—'} tone="text-slate-900 font-semibold" />
            )}
          </DetailSection>

          <div className="space-y-4">
            <DetailSection title="Profitability">
              <Row label="Cost / acre" value={usd(row.costPerAcre)} />
              <Row label="Cost / bu" value={row.costPerBu != null ? price2(row.costPerBu) : '—'} />
              <Row label="Revenue / acre" value={usd(row.revenuePerAcre)} />
              <Row label="Profit / acre" value={row.profitPerAcre != null ? usd(row.profitPerAcre) : row.revenuePerAcre != null ? 'set cost' : '—'} tone={profitTone} />
              <Row label="Total profit" value={row.totalProfit != null ? usd(row.totalProfit) : '—'} tone={profitTone} />
              <Row label="Breakeven price" value={be.price != null ? `${price2(be.price)}/bu` : '—'} />
              <Row label="Breakeven yield" value={be.yieldPerAcre != null ? `${be.yieldPerAcre.toFixed(1)} bu/ac` : '—'} />
            </DetailSection>

            {/* What-If pricing on unpriced bushels */}
            <div className="rounded-lg bg-sky-50 border border-sky-200 p-3 space-y-2 no-print">
              <div className="font-semibold text-sky-900">What-If Pricing</div>
              <div className="space-y-1">
                <div className="text-xs text-slate-600">{advanced ? 'Unpriced futures bushels' : 'Unsold bushels'}: <span className="tabular-nums font-medium">{bu(scenarioUnpricedBu)}</span></div>
                <div className="flex flex-wrap items-center gap-2">
                  <input type="number" step="0.01" inputMode="decimal" value={wfFutures} placeholder={advanced ? 'futures $/bu' : '$/bu'}
                    onChange={(e) => { setWfFutures(e.target.value); setWfSymbol(null); setWfNote(null) }}
                    className="rounded border border-slate-300 px-2 py-1 w-28 text-right" />
                  {nc
                    ? (expired
                      ? <span className="text-xs text-amber-700">Contract expired — enter price manually</span>
                      : <button type="button" onClick={useTodaysPrice} disabled={fetching} className="text-xs text-sky-700 font-medium disabled:opacity-50">{fetching ? 'Fetching…' : 'Use today’s price'}</button>)
                    : <span className="text-xs text-slate-400">{advanced ? 'No futures contract' : 'Enter a price'}</span>}
                </div>
                {/* Show the futures symbol only in advanced mode (no hedging jargon on simple sections). */}
                {wfSymbol && wfFut != null && <div className="text-xs text-slate-500">{advanced ? `${wfSymbol} · ` : 'Today · '}{price2(wfFut)}{wfStale ? ' (cached)' : ''}</div>}
                {wfNote && <div className="text-xs text-amber-700">{wfNote}</div>}
              </div>
              {advanced && (
                <div className="space-y-1">
                  <div className="text-xs text-slate-600">Bushels at assumed basis: <span className="tabular-nums font-medium">{bu(row.basisAssumedBu)}</span></div>
                  <div className="flex items-center gap-2">
                    <input id={basisInputId} type="number" step="0.01" inputMode="decimal" value={basisInput} placeholder="basis $/bu"
                      onChange={(e) => setBasisInput(e.target.value)} onBlur={commitBasis}
                      className="rounded border border-slate-300 px-2 py-1 w-28 text-right" />
                    <span className="text-xs text-slate-400">assumed basis — saved to assumptions</span>
                  </div>
                </div>
              )}
              {scenario ? (
                <div className="border-t border-sky-200 pt-2 space-y-0.5">
                  <div className="text-xs uppercase tracking-wide text-sky-700 font-semibold">Scenario <span className="font-normal italic normal-case lowercase">(what-if)</span></div>
                  <Row label="Proj. total avg price" value={price2(scenario.totalAvgPrice)} tone="italic text-sky-900 font-semibold" />
                  <Row label="Proj. profit / acre" value={scenario.profitPerAcre != null ? usd0(scenario.profitPerAcre) : 'set cost'} tone={`italic ${scenario.profitPerAcre == null ? 'text-slate-400' : scenario.profitPerAcre >= 0 ? 'text-green-700' : 'text-red-700'}`} />
                  <Row label="Proj. total profit" value={scenario.totalProfit != null ? usd0(scenario.totalProfit) : '—'} tone={`italic ${scenario.totalProfit == null ? 'text-slate-400' : scenario.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'}`} />
                </div>
              ) : (
                <div className="text-xs text-slate-400">Enter a futures price to model the unpriced bushels.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// The basis qualifier under Total Avg Price — a basis figure never appears
// without its (actual / assumed / blended) state. Assumed gets a dashed
// underline; blended shows the locked/assumed composition on hover or tap
// (and, in full, in the Pricing Buildup column).
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
      Basis: <span className={`tabular-nums${blended ? ' underline decoration-dotted decoration-slate-400 underline-offset-2 cursor-help' : ''}`}>{basis2(row.avgBasis)}</span> ({basisStateLabel(row)})
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
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
                    : <span className="text-xs text-slate-500 tabular-nums">{effYield?.toFixed(1)} bu/ac{a?.cost_per_acre != null ? ` · ${usd0(a.cost_per_acre)}/ac` : ''}{a?.harvest_complete ? ' · harvested' : ''}</span>}
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
  const [aBasis, setABasis] = useState(s0(a?.assumed_basis))

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
      assumed_basis: toNum(aBasis) ?? 0,
    })
  }

  const ic = 'rounded border border-slate-300 px-2 py-1 w-20 text-right'
  const cell = 'px-1 py-1'
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
      <label className="text-sm flex flex-col gap-1 text-slate-600">
        <span className="flex items-center gap-2">
          Assumed basis ($/bu)
          <input type="number" step="0.01" value={aBasis} onChange={(e) => setABasis(e.target.value)} className={`${ic} w-24`} />
        </span>
        <span className="text-xs text-slate-400">
          Used when no physical contracts have established basis, and to value unpriced bushels.
        </span>
      </label>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500">
            <th className={`${cell} text-left font-normal`}></th>
            <th className={`${cell} text-right font-normal`}>Acres</th>
            <th className={`${cell} text-right font-normal`}>Yield bu/ac</th>
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
          <span className="text-sm text-slate-600">Actual production: <span className="font-mono font-semibold">{bu(actual!.production)}</span> bu</span>
        ) : (
          <span className="text-sm text-slate-600">Expected production: <span className="font-mono font-semibold">{bu(prod)}</span> bu</span>
        )}
        <button onClick={save} className="ml-auto rounded-lg bg-green-700 text-white px-3 py-1 text-sm font-semibold">Save</button>
      </div>
    </div>
  )
}
