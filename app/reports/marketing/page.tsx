'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeMarketing, segmentAcresByCrop, expectedProductionFromBreakout, type MarketingRow, type SegmentAcres } from '@/lib/marketing'
import { fieldCropAggregates, cropsWithCompleteHarvest } from '@/lib/yields'
import { buildDoubleCropSet } from '@/lib/plantings'
import { CONTRACT_TYPE_LABEL, PRICING_STATUS_LABEL, cropToCommodity } from '@/lib/contracts'
import { fmtPrice, fmtPnl } from '@/lib/hedging'
import { usePersistentState } from '@/lib/use-persistent-state'
import { StackedBar } from '@/components/reports/report-kit'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'
import type { Buyer, Contract, Crop, CropAssumption, FuturesPosition, OptionPosition } from '@/lib/types'

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

// Sold / hedged / unpriced split for one crop, from existing row fields only
// (no new calculations — just partitioning totalProduction). sold = contracted;
// hedged = open futures hedge bushels not already counted as sold; unpriced = rest.
function positionOf(r: MarketingRow) {
  const sold = Math.max(0, r.contractedBu)
  const hedged = Math.max(0, Math.min(r.openFuturesHedgedBu, r.totalProduction - sold))
  const unpriced = Math.max(0, r.totalProduction - sold - hedged)
  return { sold, hedged, unpriced }
}

export default function MarketingPage() {
  const supabase = useMemo(() => createClient(), [])
  const [yearOptions, setYearOptions] = useState<number[]>([])
  const [year, setYear] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const [crops, setCrops] = useState<Crop[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
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

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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
    const [cr, by, pl, ct, fp, op, ca, ld, sp] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('buyers').select('*').order('name'),
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
    setBuyers((by.data as Buyer[]) ?? [])
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

  const cropName = (id: string | null) => crops.find((c) => c.id === id)?.name ?? ''
  const buyerName = (id: string | null) => buyers.find((b) => b.id === id)?.name ?? ''

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

  // Per-crop marketing complexity + basis-priced bushels (display only, derived
  // from the already-fetched contracts/futures/options). A crop is "advanced" if
  // it has any futures/options positions or any HTA/basis contract; otherwise
  // it's simple (forwards only) and the card hides all hedging language.
  const cropMeta = useMemo(() => {
    const m = new Map<string, { advanced: boolean; basisPricedBu: number }>()
    for (const r of rows) {
      const commodity = cropToCommodity(r.cropName)
      const cropContracts = contracts.filter((c) => c.crop_id === r.cropId)
      const hasHtaOrBasis = cropContracts.some((c) => c.contract_type === 'hta' || c.contract_type === 'basis')
      const hasFut = commodity ? futures.some((f) => f.commodity === commodity) : false
      const hasOpt = commodity ? options.some((o) => o.commodity === commodity) : false
      const basisPricedBu = cropContracts.reduce((s, c) => s + (c.basis != null ? Number(c.contracted_bushels ?? 0) : 0), 0)
      m.set(r.cropId, { advanced: hasHtaOrBasis || hasFut || hasOpt, basisPricedBu })
    }
    return m
  }, [rows, contracts, futures, options])

  function toggleBasis(cropId: string) {
    setBasisExpanded((s) => (s.includes(cropId) ? s.filter((x) => x !== cropId) : [...s, cropId]))
  }

  function buildPayload(): ExportPayload {
    // Per-crop summary mirroring the cards (priced % is sold% in simple mode,
    // futures-priced% in advanced; basis% only when advanced).
    const summary: ExportPayload['sections'][number] = {
      title: 'Marketing Summary by Crop',
      columns: [
        { label: 'Crop' }, { label: 'Acres', align: 'right' }, { label: 'Production', align: 'right' },
        { label: 'Priced %', align: 'right' }, { label: 'Basis %', align: 'right' },
        { label: 'Avg Price', align: 'right' }, { label: 'Profit/Ac', align: 'right' }, { label: 'Total Profit', align: 'right' },
      ],
      rows: rows.map((r) => {
        const meta = cropMeta.get(r.cropId)
        const adv = meta?.advanced ?? false
        const pricedBu = adv ? r.futuresPricedBu : r.contractedBu
        const pricedPct = r.totalProduction > 0 ? (pricedBu / r.totalProduction) * 100 : 0
        const basisPct = adv && r.totalProduction > 0 ? ((meta?.basisPricedBu ?? 0) / r.totalProduction) * 100 : null
        return [
          r.cropName, Math.round(r.acres), Math.round(r.totalProduction),
          `${Math.min(100, pricedPct).toFixed(0)}%`, basisPct != null ? `${Math.min(100, basisPct).toFixed(0)}%` : '—',
          r.totalAvgPrice != null ? Number(r.totalAvgPrice.toFixed(4)) : '',
          r.profitPerAcre != null ? Math.round(r.profitPerAcre) : '', r.totalProfit != null ? Math.round(r.totalProfit) : '',
        ]
      }),
      rowMeta: rows.map(() => 'data' as const),
    }
    summary.rows.push(['Total', Math.round(combined.acres), '', '', '', '', '', combined.profit != null ? Math.round(combined.profit) : ''])
    summary.rowMeta!.push('total')

    const detail: ExportPayload['sections'][number] = {
      title: 'Detail by Crop',
      columns: [
        { label: 'Crop' }, { label: 'Acres', align: 'right' }, { label: 'Yield', align: 'right' },
        { label: 'Total Prod', align: 'right' }, { label: 'Contracted', align: 'right' }, { label: 'Remaining', align: 'right' },
        { label: 'Avg Futures', align: 'right' }, { label: 'Avg Basis', align: 'right' }, { label: 'Total Avg $', align: 'right' },
        { label: 'Revenue/Ac', align: 'right' }, { label: 'Cost/Ac', align: 'right' }, { label: 'Profit/Ac', align: 'right' }, { label: 'Total Profit', align: 'right' },
      ],
      rows: rows.map((r) => [
        r.cropName, Math.round(r.acres), r.yield != null ? Number(r.yield.toFixed(1)) : '',
        Math.round(r.totalProduction), Math.round(r.contractedBu), Math.round(r.remaining),
        r.avgFutures != null ? Number(r.avgFutures.toFixed(4)) : '', Number(r.avgBasis.toFixed(4)),
        r.totalAvgPrice != null ? Number(r.totalAvgPrice.toFixed(4)) : '',
        r.revenuePerAcre != null ? Math.round(r.revenuePerAcre) : '', r.costPerAcre != null ? Math.round(r.costPerAcre) : '',
        r.profitPerAcre != null ? Math.round(r.profitPerAcre) : '', r.totalProfit != null ? Math.round(r.totalProfit) : '',
      ]),
    }
    return { title: `Marketing — ${year ?? ''}`, filters: `Crop year: ${year ?? '—'}`, sections: [summary, detail] }
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
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  return (
    <div className="space-y-4">
      {/* Header: title + crop-year filter + Assumptions button */}
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Marketing</h1>
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
            className="relative rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold mb-px"
          >
            Assumptions
            {incompleteCount > 0 && (
              <span className="ml-2 rounded-full bg-amber-500 text-white text-xs px-1.5 py-0.5 leading-none">
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
        <>
          {/* Two combined metrics only — the rest is meaningful per crop. */}
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
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

          {/* Per-crop cards — the at-a-glance dashboard. Stacked on iPad portrait
              (< lg), side by side on wider desktop screens. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {rows.map((r) => (
              <CropCard
                key={r.cropId}
                row={r}
                advanced={cropMeta.get(r.cropId)?.advanced ?? false}
                basisPricedBu={cropMeta.get(r.cropId)?.basisPricedBu ?? 0}
                basisOpen={basisExpanded.includes(r.cropId)}
                onToggleBasis={() => toggleBasis(r.cropId)}
              />
            ))}
          </div>

          {/* Detailed table — grouped headers + expandable per-crop buildup. */}
          <DetailedTable
            rows={rows} contracts={contracts} futures={futures} options={options}
            cropMeta={cropMeta} expanded={expanded} onToggle={toggleRow} buyerName={buyerName}
          />
        </>
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
// Per-crop card — the at-a-glance dashboard. Adapts to the crop's marketing
// complexity: simple (forwards only) shows Sold/Unsold; advanced shows a
// Futures-priced bar with an expandable Basis bar.
// ---------------------------------------------------------------------------
function CropCard({ row, advanced, basisPricedBu, basisOpen, onToggleBasis }: {
  row: MarketingRow
  advanced: boolean
  basisPricedBu: number
  basisOpen: boolean
  onToggleBasis: () => void
}) {
  const prod = row.totalProduction
  const profitTone = row.totalProfit == null ? 'text-slate-400' : row.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'
  return (
    <div className="bg-white rounded-xl shadow p-5 space-y-4">
      <div>
        <div className="font-bold text-lg leading-tight">{row.cropName}</div>
        <div className="text-sm text-slate-500 tabular-nums">{bu(row.acres)} ac</div>
      </div>

      {/* Marketing position — adaptive */}
      {!advanced ? (
        <PositionBlock title="Sold" prod={prod} green={row.contractedBu} greenLabel="Sold" grayLabel="Unsold" />
      ) : (
        <div className="space-y-2">
          <PositionBlock title="Futures-priced" prod={prod} green={row.futuresPricedBu} greenLabel="Priced" grayLabel="Unpriced" />
          <button type="button" onClick={onToggleBasis} className="text-xs text-sky-700 font-medium">
            {basisOpen ? '▾ Hide basis' : '▸ Show basis'}
          </button>
          {basisOpen && (
            <PositionBlock title="Basis-priced" prod={prod} green={basisPricedBu} greenLabel="Basis set" grayLabel="No basis" />
          )}
        </div>
      )}

      {/* Average price */}
      <div className="flex items-baseline justify-between border-t border-slate-100 pt-3">
        <span className="text-xs text-slate-500 uppercase tracking-wide">{advanced ? 'Total avg price' : 'Avg price'}</span>
        <span className="text-lg font-semibold tabular-nums">
          {row.totalAvgPrice != null ? fmtPrice(row.totalAvgPrice) : '—'}
          {advanced && row.avgBasisAssumed && <span className="text-amber-600 text-xs font-normal"> (assumed)</span>}
        </span>
      </div>

      {/* Profitability */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">Profit / acre</div>
          <div className={`text-xl font-bold tabular-nums ${profitTone}`}>{row.profitPerAcre != null ? usd0(row.profitPerAcre) : row.revenuePerAcre != null ? 'set cost' : '—'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">Total profit</div>
          <div className={`text-xl font-bold tabular-nums ${profitTone}`}>{row.totalProfit != null ? usd0(row.totalProfit) : '—'}</div>
        </div>
      </div>
    </div>
  )
}

// One position bar: green segment (priced) vs gray (unpriced), with the % as the
// prominent number. Both green and gray are clamped to total production so two
// bars on the same card share a denominator and read comparably.
function PositionBlock({ title, prod, green, greenLabel, grayLabel }: {
  title: string
  prod: number
  green: number
  greenLabel: string
  grayLabel: string
}) {
  const greenClamped = Math.max(0, Math.min(green, prod))
  const gray = Math.max(0, prod - greenClamped)
  const pct = prod > 0 ? Math.min(100, (green / prod) * 100) : 0
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs text-slate-500">{title}</span>
        <span className="text-base font-bold tabular-nums">{pct.toFixed(0)}%</span>
      </div>
      <StackedBar segments={[
        { value: greenClamped, className: 'bg-green-600', label: greenClamped > 0 ? bu(greenClamped) : undefined },
        { value: gray, className: 'bg-slate-300', label: gray > 0 ? bu(gray) : undefined },
      ]} />
      <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
        <span>{greenLabel}</span><span>{grayLabel}</span>
      </div>
    </div>
  )
}

// React.Fragment wrapper that accepts a key (so we can emit two <tr>s per crop).
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

// Inline per-crop detail: price components, contracted breakdown by type,
// hedge positions, and the unpriced split. Read-only summaries of existing data.
function CropDetail({
  row, advanced, contracts, futures, options, buyerName,
}: {
  row: MarketingRow
  advanced: boolean
  contracts: Contract[]
  futures: FuturesPosition[]
  options: OptionPosition[]
  buyerName: (id: string | null) => string
}) {
  const pos = positionOf(row)
  // Contracted bushels grouped by contract type.
  const byType = new Map<string, number>()
  for (const c of contracts) {
    const t = CONTRACT_TYPE_LABEL[c.contract_type ?? 'forward']
    byType.set(t, (byType.get(t) ?? 0) + Number(c.contracted_bushels))
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-sm">
      {/* Price — full futures/basis buildup in advanced mode; just the average
          (no hedging language) in simple mode. */}
      <div>
        <div className="font-semibold text-slate-700 mb-1">{advanced ? 'Price buildup' : 'Price'}</div>
        <dl className="space-y-0.5">
          {advanced ? (
            <>
              {row.physicalFuturesBu > 0 && (
                <Row label={`Physical futures (${bu(row.physicalFuturesBu)} bu)`} value={row.physicalFuturesAvg != null ? fmtPrice(row.physicalFuturesAvg) : '—'} />
              )}
              {row.openHedgeBu > 0 && (
                <Row label={`Open hedges (${bu(row.openHedgeBu)} bu)`} value={row.openHedgeAvg != null ? fmtPrice(row.openHedgeAvg) : '—'} />
              )}
              <Row label={`Raw avg futures (${bu(row.futuresPricedBu)} bu)`} value={row.rawAvgFutures != null ? fmtPrice(row.rawAvgFutures) : 'N/A'} />
              <Row
                label="Hedge P&L adj / bu"
                value={`${row.hedgeAdjPerBu >= 0 ? '+' : ''}${fmtPrice(row.hedgeAdjPerBu)}`}
                tone={row.hedgeAdjPerBu > 0 ? 'text-green-700' : row.hedgeAdjPerBu < 0 ? 'text-red-700' : undefined}
              />
              <Row label="= Avg futures price" value={row.avgFutures != null ? fmtPrice(row.avgFutures) : 'N/A'} />
              <Row label={`+ Basis${row.avgBasisAssumed ? ' (assumed)' : ''}`} value={`${row.avgBasis >= 0 ? '+' : ''}${Number(row.avgBasis).toFixed(4)}`} tone={row.avgBasisAssumed ? 'text-amber-700' : undefined} />
              <div className="border-t border-slate-200 mt-1 pt-1">
                <Row label="= Total avg price" value={row.totalAvgPrice != null ? fmtPrice(row.totalAvgPrice) : '—'} tone="text-slate-900 font-semibold" />
              </div>
              {row.hedgeRealizedPnl !== 0 && (
                <Row label="Realized hedge P&L (in revenue)" value={fmtPnl(row.hedgeRealizedPnl)} tone={row.hedgeRealizedPnl > 0 ? 'text-green-700' : 'text-red-700'} />
              )}
            </>
          ) : (
            <Row label="Avg price" value={row.totalAvgPrice != null ? fmtPrice(row.totalAvgPrice) : '—'} tone="text-slate-900 font-semibold" />
          )}
          <Row label="Cost / bu" value={row.costPerBu != null ? fmtPrice(row.costPerBu) : '—'} />
        </dl>
      </div>
      {/* Position split */}
      <div>
        <div className="font-semibold text-slate-700 mb-1">Position</div>
        <dl className="space-y-0.5">
          <Row label={advanced ? 'Sold (contracted)' : 'Sold'} value={`${bu(pos.sold)} bu`} />
          {advanced && <Row label="Hedged (open futures)" value={`${bu(pos.hedged)} bu`} />}
          <Row label={advanced ? 'Unpriced' : 'Unsold'} value={`${bu(advanced ? pos.unpriced : Math.max(0, row.totalProduction - pos.sold))} bu`} tone="text-slate-600" />
          <Row label="Bu remaining" value={bu(row.remaining)} tone={row.remaining < 0 ? 'text-red-700' : undefined} />
        </dl>
      </div>
      {/* Contracts (+ hedges in advanced mode) */}
      <div>
        <div className="font-semibold text-slate-700 mb-1">{advanced ? 'Contracts & hedges' : 'Contracts'}</div>
        {byType.size === 0 && (!advanced || (futures.length === 0 && options.length === 0)) ? (
          <p className="text-slate-400">No contracts{advanced ? ' or hedges' : ''}.</p>
        ) : (
          <dl className="space-y-0.5">
            {[...byType].map(([t, b]) => <Row key={t} label={t} value={`${bu(b)} bu`} />)}
            {advanced && futures.length > 0 && <Row label={`Futures (${futures.length})`} value={`${futures.reduce((s, f) => s + (f.realized_pnl != null ? Number(f.realized_pnl) : 0), 0) !== 0 ? fmtPnl(futures.reduce((s, f) => s + (f.realized_pnl != null ? Number(f.realized_pnl) : 0), 0)) : 'open'}`} />}
            {advanced && options.length > 0 && <Row label={`Options (${options.length})`} value="see Hedging" />}
          </dl>
        )}
        {contracts.length > 0 && (
          <div className="mt-2 text-xs text-slate-500">
            {contracts.slice(0, 4).map((c) => (
              <div key={c.id} className="truncate">#{c.contract_number} · {buyerName(c.buyer_id)} · {PRICING_STATUS_LABEL[c.pricing_status]}</div>
            ))}
            {contracts.length > 4 && <div>+{contracts.length - 4} more</div>}
          </div>
        )}
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
// Detailed table — grouped spanning headers, frozen crop column, and expandable
// per-crop rows showing the price-component buildup.
// ---------------------------------------------------------------------------
function DetailedTable({
  rows, contracts, futures, options, cropMeta, expanded, onToggle, buyerName,
}: {
  rows: MarketingRow[]
  contracts: Contract[]
  futures: FuturesPosition[]
  options: OptionPosition[]
  cropMeta: Map<string, { advanced: boolean; basisPricedBu: number }>
  expanded: Set<string>
  onToggle: (id: string) => void
  buyerName: (id: string | null) => string
}) {
  const frozen = 'sticky left-0 z-10'
  const COLSPAN = 14 // chevron + 13 data columns
  return (
    <div className="bg-white rounded-xl shadow overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead className="text-slate-700">
          <tr className="bg-slate-100">
            <th rowSpan={2} className="w-6 px-2 py-2 bg-slate-100" />
            <th rowSpan={2} className={`px-3 py-2 text-left align-bottom bg-slate-100 ${frozen}`}>Crop</th>
            <th colSpan={3} className="px-3 py-1 text-center border-l border-slate-300">Production</th>
            <th colSpan={2} className="px-3 py-1 text-center border-l border-slate-300">Sales</th>
            <th colSpan={3} className="px-3 py-1 text-center border-l border-slate-300">Pricing</th>
            <th colSpan={4} className="px-3 py-1 text-center border-l border-slate-300">Profitability</th>
          </tr>
          <tr className="bg-slate-50 text-xs text-slate-600">
            <th className="px-3 py-1 text-right border-l border-slate-300">Acres</th>
            <th className="px-3 py-1 text-right">Yield</th>
            <th className="px-3 py-1 text-right">Total Prod</th>
            <th className="px-3 py-1 text-right border-l border-slate-300">Contracted</th>
            <th className="px-3 py-1 text-right">Remaining</th>
            <th className="px-3 py-1 text-right border-l border-slate-300">Avg Futures</th>
            <th className="px-3 py-1 text-right">Avg Basis</th>
            <th className="px-3 py-1 text-right">Total Avg $</th>
            <th className="px-3 py-1 text-right border-l border-slate-300">Revenue/Ac</th>
            <th className="px-3 py-1 text-right">Cost/Ac</th>
            <th className="px-3 py-1 text-right">Profit/Ac</th>
            <th className="px-3 py-1 text-right">Total Profit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = expanded.has(r.cropId)
            const advanced = cropMeta.get(r.cropId)?.advanced ?? false
            return (
              <FragmentRow key={r.cropId}>
                <tr className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => onToggle(r.cropId)}>
                  <td className="px-2 py-2 text-slate-400 text-center">{isOpen ? '▾' : '▸'}</td>
                  <td className="px-3 py-2 font-semibold sticky left-0 bg-white z-10">{r.cropName}</td>
                  <td className="px-3 py-2 text-right tabular-nums border-l border-slate-200">{bu(r.acres)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.yield != null ? r.yield.toFixed(1) : '—'} <span className="text-xs text-slate-400">{r.yield != null ? r.yieldLabel : ''}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{bu(r.totalProduction)}</td>
                  <td className="px-3 py-2 text-right tabular-nums border-l border-slate-200">{bu(r.contractedBu)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.remaining < 0 ? 'text-red-700 font-semibold' : ''}`}>{bu(r.remaining)}</td>
                  <td className="px-3 py-2 text-right tabular-nums border-l border-slate-200">{r.avgFutures != null ? fmtPrice(r.avgFutures) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.avgBasis != null ? Number(r.avgBasis).toFixed(4) : 'N/A'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.totalAvgPrice != null ? fmtPrice(r.totalAvgPrice) : r.avgFutures != null ? `${fmtPrice(r.avgFutures)}*` : r.avgCashPrice != null ? fmtPrice(r.avgCashPrice) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums border-l border-slate-200" title={r.totalAvgPrice != null && r.yield != null ? `${fmtPrice(r.totalAvgPrice)} × ${r.yield.toFixed(1)} bu/ac` : undefined}>{usd(r.revenuePerAcre)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(r.costPerAcre)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.profitPerAcre == null ? 'text-slate-400' : r.profitPerAcre >= 0 ? 'text-green-700' : 'text-red-700'}`}>{r.profitPerAcre != null ? usd(r.profitPerAcre) : r.revenuePerAcre != null ? 'set cost' : '—'}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.totalProfit == null ? 'text-slate-400' : r.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{r.totalProfit != null ? usd(r.totalProfit) : '—'}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-slate-50/60">
                    <td />
                    <td colSpan={COLSPAN - 1} className="px-3 py-3">
                      <CropDetail
                        row={r}
                        advanced={advanced}
                        contracts={contracts.filter((c) => c.crop_id === r.cropId)}
                        futures={futures.filter((f) => f.commodity === cropToCommodity(r.cropName))}
                        options={options.filter((o) => o.commodity === cropToCommodity(r.cropName))}
                        buyerName={buyerName}
                      />
                    </td>
                  </tr>
                )}
              </FragmentRow>
            )
          })}
        </tbody>
      </table>
      <p className="text-xs text-slate-500 px-3 py-2">Avg Futures includes physical contracts with a futures price plus short futures hedges, adjusted for closed-hedge and options realized P&amp;L. Revenue/Ac = Total Avg $ × yield; Profit/Ac = Revenue/Ac − Cost/Ac. * = futures only (no basis set yet). Expand a crop for the buildup.</p>
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
