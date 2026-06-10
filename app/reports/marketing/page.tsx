'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { computeMarketing, segmentAcresByCrop, expectedProductionFromBreakout, type MarketingRow, type SegmentAcres } from '@/lib/marketing'
import { buildDoubleCropSet } from '@/lib/plantings'
import { CONTRACT_TYPE_LABEL, PRICING_STATUS_LABEL, cropToCommodity } from '@/lib/contracts'
import { fmtPrice, fmtPnl } from '@/lib/hedging'
import { SummaryCards, StackedBar, type SummaryCardData } from '@/components/reports/report-kit'
import type { Buyer, Contract, Crop, CropAssumption, FuturesPosition, OptionPosition } from '@/lib/types'

type LoadRow = {
  crop_id: string | null
  crop_year: number | null
  from_type: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
}

type PlantingRow = {
  id: string
  field_id: string
  crop_id: string
  season_year: number
  planted_acres: number | null
  irrigated_acres: number | null
  dryland_acres: number | null
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
  const [view, setView] = useState<'base' | 'detailed'>('base')

  const [crops, setCrops] = useState<Crop[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [plantings, setPlantings] = useState<PlantingRow[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [futures, setFutures] = useState<FuturesPosition[]>([])
  const [options, setOptions] = useState<OptionPosition[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [production, setProduction] = useState<Map<string, number>>(new Map())
  // Current futures price per crop (Barchart) — values completely-unpriced bushels.
  const [currentFutures, setCurrentFutures] = useState<Map<string, number>>(new Map())

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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
    const [cr, by, pl, ct, fp, op, ca, ld] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('buyers').select('*').order('name'),
      supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres').eq('season_year', cropYear),
      supabase.from('contracts').select('*').eq('crop_year', cropYear),
      supabase.from('futures_positions').select('*').eq('crop_year', cropYear),
      supabase.from('options_positions').select('*').eq('crop_year', cropYear),
      supabase.from('crop_assumptions').select('*').eq('crop_year', cropYear),
      supabase.from('loads').select('crop_id, crop_year, from_type, net_weight, moisture, dry_bushels_override').eq('crop_year', cropYear),
    ])
    const cropsList = (cr.data as Crop[]) ?? []
    setCrops(cropsList)
    setBuyers((by.data as Buyer[]) ?? [])
    setPlantings((pl.data as PlantingRow[]) ?? [])
    setContracts((ct.data as Contract[]) ?? [])
    setFutures((fp.data as FuturesPosition[]) ?? [])
    setOptions((op.data as OptionPosition[]) ?? [])
    setAssumptions((ca.data as CropAssumption[]) ?? [])

    // Actual production: dry bushels of field-origin loads, by crop.
    const cropById = new Map(cropsList.map((c) => [c.id, c]))
    const prod = new Map<string, number>()
    for (const l of ((ld.data as LoadRow[]) ?? [])) {
      if (l.from_type !== 'field' || !l.crop_id) continue
      const crop = cropById.get(l.crop_id)
      const { dryBushels } = computeBushels({
        netWeightLb: l.net_weight, moisturePct: l.moisture,
        baseMoisturePct: crop?.base_moisture_pct ?? null, baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
        dryBushelsOverride: l.dry_bushels_override,
      })
      if (dryBushels) prod.set(l.crop_id, (prod.get(l.crop_id) ?? 0) + dryBushels)
    }
    setProduction(prod)
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
    () => (year == null ? [] : computeMarketing({ cropYear: year, crops, plantings, contracts, futures, options, assumptions, actualProductionByCrop: production, expectedProductionByCrop: expProdByCrop, currentFuturesByCrop: currentFutures })),
    [year, crops, plantings, contracts, futures, options, assumptions, production, expProdByCrop, currentFutures],
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

  // Portfolio roll-ups for the summary cards — sums/ratios of existing row
  // fields only (no per-crop calculation changes).
  const totals = useMemo(() => {
    let acres = 0, prod = 0, contracted = 0, profit = 0, profitKnown = false
    let priceNum = 0, priceDen = 0
    for (const r of rows) {
      acres += r.acres
      prod += r.totalProduction
      contracted += r.contractedBu
      if (r.totalProfit != null) { profit += r.totalProfit; profitKnown = true }
      // Production-weighted Total Average Price (always computes via assumed basis).
      if (r.totalAvgPrice != null && r.totalProduction > 0) { priceNum += r.totalAvgPrice * r.totalProduction; priceDen += r.totalProduction }
    }
    return {
      acres, prod, contracted,
      pctSold: prod > 0 ? (contracted / prod) * 100 : 0,
      avgPrice: priceDen > 0 ? priceNum / priceDen : null,
      profit: profitKnown ? profit : null,
    }
  }, [rows])

  // Crops planted this year whose effective yield assumption is still missing.
  const incompleteCount = useMemo(() => rows.filter((r) => r.yield == null).length, [rows])

  const summaryCards: SummaryCardData[] = useMemo(() => [
    { label: 'Total acres', value: bu(totals.acres) },
    { label: 'Total production', value: `${bu(totals.prod)} bu` },
    { label: '% sold', value: `${totals.pctSold.toFixed(0)}%`, tone: totals.pctSold >= 50 ? 'favorable' : 'warning', sub: `${bu(totals.contracted)} bu contracted` },
    { label: 'Wtd avg price', value: totals.avgPrice != null ? fmtPrice(totals.avgPrice) : '—', sub: 'futures + basis, per bu' },
    { label: 'Projected profit', value: totals.profit != null ? usd0(totals.profit) : 'Set costs', tone: totals.profit == null ? 'muted' : totals.profit >= 0 ? 'favorable' : 'unfavorable' },
  ], [totals])

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
          {/* Summary cards — lead with the numbers. */}
          <SummaryCards cards={summaryCards} />

          {/* Marketing Position — at-a-glance protection per crop. */}
          <MarketingPosition rows={rows} />

          {/* View toggle */}
          <div className="flex items-center gap-2">
            {(['base', 'detailed'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${view === v ? 'bg-slate-700 text-white border-slate-700' : 'bg-white border-slate-300'}`}>
                {v === 'base' ? 'Base View' : 'Detailed View'}
              </button>
            ))}
          </div>

          {view === 'base' ? (
            <BaseTable
              rows={rows} contracts={contracts} futures={futures} options={options}
              expanded={expanded} onToggle={toggleRow} buyerName={buyerName}
            />
          ) : (
            <DetailedTable rows={rows} />
          )}
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
// Marketing Position — horizontal stacked bar per crop (sold / hedged / unpriced)
// ---------------------------------------------------------------------------
function MarketingPosition({ rows }: { rows: MarketingRow[] }) {
  const withProd = rows.filter((r) => r.totalProduction > 0)
  if (withProd.length === 0) return null
  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Marketing Position</h2>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <Legend className="bg-green-600" label="Sold" />
          <Legend className="bg-amber-400" label="Hedged" />
          <Legend className="bg-slate-300" label="Unpriced" />
        </div>
      </div>
      <div className="space-y-2">
        {withProd.map((r) => {
          const p = positionOf(r)
          return (
            <div key={r.cropId} className="flex items-center gap-3">
              <div className="w-24 shrink-0 text-sm font-medium truncate">{r.cropName}</div>
              <div className="flex-1">
                <StackedBar segments={[
                  { value: p.sold, className: 'bg-green-600', label: p.sold > 0 ? `${bu(p.sold)}` : undefined },
                  { value: p.hedged, className: 'bg-amber-400', label: p.hedged > 0 ? `${bu(p.hedged)}` : undefined },
                  { value: p.unpriced, className: 'bg-slate-300', label: p.unpriced > 0 ? `${bu(p.unpriced)}` : undefined },
                ]} />
              </div>
              <div className="w-28 shrink-0 text-right text-xs text-slate-500 tabular-nums">{bu(r.totalProduction)} bu</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={`inline-block w-3 h-3 rounded-sm ${className}`} />{label}</span>
}

// ---------------------------------------------------------------------------
// Base table — one row per crop with a % sold progress bar, expandable to detail
// ---------------------------------------------------------------------------
function BaseTable({
  rows, contracts, futures, options, expanded, onToggle, buyerName,
}: {
  rows: MarketingRow[]
  contracts: Contract[]
  futures: FuturesPosition[]
  options: OptionPosition[]
  expanded: Set<string>
  onToggle: (id: string) => void
  buyerName: (id: string | null) => string
}) {
  const anyExcluded = rows.some((r) => r.excludedAwaitingBu > 0)
  const tot = rows.reduce((a, r) => ({ acres: a.acres + r.acres, prod: a.prod + r.totalProduction, contracted: a.contracted + r.contractedBu, remaining: a.remaining + r.remaining }), { acres: 0, prod: 0, contracted: 0, remaining: 0 })
  const colCount = 8
  return (
    <div className="bg-white rounded-xl shadow overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-100 text-slate-700">
          <tr>
            <th className="w-6 px-2 py-2" />
            {['Crop', 'Acres', 'Yield', 'Total Production', 'Contracted Bu', '% Sold', 'Avg Price'].map((h, i) => (
              <th key={h} className={`px-3 py-2 whitespace-nowrap ${i === 0 ? 'text-left sticky left-0 bg-slate-100' : 'text-left'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = expanded.has(r.cropId)
            const pctSold = r.totalProduction > 0 ? Math.min(100, (r.contractedBu / r.totalProduction) * 100) : 0
            return (
              <FragmentRow key={r.cropId}>
                <tr className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => onToggle(r.cropId)}>
                  <td className="px-2 py-2 text-slate-400 text-center">{isOpen ? '▾' : '▸'}</td>
                  <td className="px-3 py-2 font-semibold sticky left-0 bg-white">{r.cropName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{bu(r.acres)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.yield != null ? `${r.yield.toFixed(1)} ` : '—'}<span className="text-xs text-slate-400">{r.yield != null ? r.yieldLabel : ''}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{bu(r.totalProduction)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{bu(r.contractedBu)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden min-w-[60px]">
                        <div className={`h-full ${pctSold >= 50 ? 'bg-green-600' : 'bg-amber-400'}`} style={{ width: `${pctSold}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-slate-600 w-9 text-right">{pctSold.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.totalAvgPrice != null ? fmtPrice(r.totalAvgPrice) : '—'}{r.avgBasisAssumed && <span className="text-amber-600" title="Basis assumed — no physical contract has set basis">*</span>}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-slate-50/60">
                    <td />
                    <td colSpan={colCount - 1} className="px-3 py-3">
                      <CropDetail
                        row={r}
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
          <tr className="border-t-2 border-slate-300 bg-slate-100 font-bold">
            <td />
            <td className="px-3 py-2 sticky left-0 bg-slate-100">Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{bu(tot.acres)}</td>
            <td />
            <td className="px-3 py-2 text-right tabular-nums">{bu(tot.prod)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{bu(tot.contracted)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-600">{tot.prod > 0 ? `${((tot.contracted / tot.prod) * 100).toFixed(0)}%` : '—'}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="text-xs text-slate-500 px-3 py-2">
        Avg Price = futures + basis per bushel (P&amp;L-adjusted).{' '}
        <span className="text-amber-600">*</span> basis is assumed (no physical contract has set basis).
        {anyExcluded && ' Some contracts are still awaiting pricing.'} Expand a crop to verify the buildup.
      </p>
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
  row, contracts, futures, options, buyerName,
}: {
  row: MarketingRow
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
      {/* Price buildup — hand-verifiable: futures-priced bushels by source →
          raw avg → + hedge P&L adjustment → avg futures → + basis → total. */}
      <div>
        <div className="font-semibold text-slate-700 mb-1">Price buildup</div>
        <dl className="space-y-0.5">
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
          <Row label="Cost / bu" value={row.costPerBu != null ? fmtPrice(row.costPerBu) : '—'} />
        </dl>
      </div>
      {/* Position split */}
      <div>
        <div className="font-semibold text-slate-700 mb-1">Position</div>
        <dl className="space-y-0.5">
          <Row label="Sold (contracted)" value={`${bu(pos.sold)} bu`} />
          <Row label="Hedged (open futures)" value={`${bu(pos.hedged)} bu`} />
          <Row label="Unpriced" value={`${bu(pos.unpriced)} bu`} tone={pos.unpriced > 0 ? 'text-amber-700' : 'text-green-700'} />
          <Row label="Bu remaining" value={bu(row.remaining)} tone={row.remaining < 0 ? 'text-red-700' : undefined} />
        </dl>
      </div>
      {/* Contracts + hedges */}
      <div>
        <div className="font-semibold text-slate-700 mb-1">Contracts &amp; hedges</div>
        {byType.size === 0 && futures.length === 0 && options.length === 0 ? (
          <p className="text-slate-400">No contracts or hedges.</p>
        ) : (
          <dl className="space-y-0.5">
            {[...byType].map(([t, b]) => <Row key={t} label={t} value={`${bu(b)} bu`} />)}
            {futures.length > 0 && <Row label={`Futures (${futures.length})`} value={`${futures.reduce((s, f) => s + (f.realized_pnl != null ? Number(f.realized_pnl) : 0), 0) !== 0 ? fmtPnl(futures.reduce((s, f) => s + (f.realized_pnl != null ? Number(f.realized_pnl) : 0), 0)) : 'open'}`} />}
            {options.length > 0 && <Row label={`Options (${options.length})`} value="see Hedging" />}
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
// Detailed table — grouped spanning headers + frozen crop column on overflow
// ---------------------------------------------------------------------------
function DetailedTable({ rows }: { rows: MarketingRow[] }) {
  const frozen = 'sticky left-0 z-10'
  return (
    <div className="bg-white rounded-xl shadow overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead className="text-slate-700">
          <tr className="bg-slate-100">
            <th rowSpan={2} className={`px-3 py-2 text-left align-bottom bg-slate-100 ${frozen}`}>Crop</th>
            <th colSpan={3} className="px-3 py-1 text-center border-l border-slate-300">Production</th>
            <th colSpan={2} className="px-3 py-1 text-center border-l border-slate-300">Sales</th>
            <th colSpan={3} className="px-3 py-1 text-center border-l border-slate-300">Pricing</th>
            <th colSpan={3} className="px-3 py-1 text-center border-l border-slate-300">Profitability</th>
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
            <th className="px-3 py-1 text-right border-l border-slate-300">Cost/Ac</th>
            <th className="px-3 py-1 text-right">Profit/Ac</th>
            <th className="px-3 py-1 text-right">Total Profit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cropId} className="border-t border-slate-100">
              <td className="px-3 py-2 font-semibold sticky left-0 bg-white z-10">{r.cropName}</td>
              <td className="px-3 py-2 text-right tabular-nums border-l border-slate-200">{bu(r.acres)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.yield != null ? r.yield.toFixed(1) : '—'} <span className="text-xs text-slate-400">{r.yield != null ? r.yieldLabel : ''}</span></td>
              <td className="px-3 py-2 text-right tabular-nums">{bu(r.totalProduction)}</td>
              <td className="px-3 py-2 text-right tabular-nums border-l border-slate-200">{bu(r.contractedBu)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${r.remaining < 0 ? 'text-red-700 font-semibold' : ''}`}>{bu(r.remaining)}</td>
              <td className="px-3 py-2 text-right tabular-nums border-l border-slate-200">{r.avgFutures != null ? fmtPrice(r.avgFutures) : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.avgBasis != null ? Number(r.avgBasis).toFixed(4) : 'N/A'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.totalAvgPrice != null ? fmtPrice(r.totalAvgPrice) : r.avgFutures != null ? `${fmtPrice(r.avgFutures)}*` : r.avgCashPrice != null ? fmtPrice(r.avgCashPrice) : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums border-l border-slate-200">{usd(r.costPerAcre)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${r.profitPerAcre == null ? 'text-slate-400' : r.profitPerAcre >= 0 ? 'text-green-700' : 'text-red-700'}`}>{r.profitPerAcre != null ? usd(r.profitPerAcre) : 'Incomplete'}</td>
              <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.totalProfit == null ? 'text-slate-400' : r.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{r.totalProfit != null ? usd(r.totalProfit) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-slate-500 px-3 py-2">Avg Futures includes physical contracts with a futures price plus short futures hedges, adjusted for closed-hedge and options realized P&amp;L. * = futures only (no basis set yet).</p>
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
