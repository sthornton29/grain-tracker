'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { computeMarketing, segmentAcresByCrop, expectedProductionFromBreakout, type MarketingRow, type SegmentAcres } from '@/lib/marketing'
import { buildDoubleCropSet } from '@/lib/plantings'
import { CONTRACT_TYPE_LABEL, PRICING_STATUS_LABEL } from '@/lib/contracts'
import { fmtPrice, fmtPnl } from '@/lib/hedging'
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

  const [openSection, setOpenSection] = useState<'contracts' | 'hedges' | 'unpriced' | null>(null)
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
    () => (year == null ? [] : computeMarketing({ cropYear: year, crops, plantings, contracts, futures, options, assumptions, actualProductionByCrop: production, expectedProductionByCrop: expProdByCrop })),
    [year, crops, plantings, contracts, futures, options, assumptions, production, expProdByCrop],
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

  return (
    <div className="space-y-4">
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
      </div>

      {banner && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</div>}

      {year == null ? (
        <div className="bg-white rounded-xl shadow p-8 text-center text-slate-500">
          Pick a crop year to load the marketing dashboard.
        </div>
      ) : loading ? (
        <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">Loading…</div>
      ) : (
        <>
          {/* Assumptions */}
          <AssumptionsEditor crops={plantedCrops} year={year} assumptions={assumptions} segByCrop={segByCrop} actualByCrop={actualByCrop} onSave={saveAssumption} />

          {/* View toggle */}
          <div className="flex items-center gap-2">
            {(['base', 'detailed'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${view === v ? 'bg-slate-700 text-white border-slate-700' : 'bg-white border-slate-300'}`}>
                {v === 'base' ? 'Base View' : 'Detailed View'}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">No planted crops for {year}.</div>
          ) : view === 'base' ? (
            <BaseTable rows={rows} />
          ) : (
            <DetailedTable rows={rows} />
          )}

          {/* Detail sections */}
          <CollapsibleSection title="Physical Contracts Detail" open={openSection === 'contracts'} onToggle={() => setOpenSection((s) => (s === 'contracts' ? null : 'contracts'))}>
            {contracts.length === 0 ? <p className="text-sm text-slate-400">No contracts for {year}.</p> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600"><tr>{['Crop', 'Type', 'Buyer', 'Month', 'Bushels', 'Futures', 'Basis', 'Cash', 'Delivery', 'Status'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
                  <tbody>
                    {contracts.map((c) => (
                      <tr key={c.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{cropName(c.crop_id)}</td>
                        <td className="px-3 py-2"><span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{CONTRACT_TYPE_LABEL[c.contract_type ?? 'forward']}</span></td>
                        <td className="px-3 py-2">{buyerName(c.buyer_id)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{c.contract_month ?? '—'}</td>
                        <td className="px-3 py-2 text-right font-mono">{bu(Number(c.contracted_bushels))}</td>
                        <td className="px-3 py-2 text-right font-mono">{c.futures_price != null ? fmtPrice(c.futures_price) : '—'}</td>
                        <td className="px-3 py-2 text-right font-mono">{c.basis != null ? Number(c.basis).toFixed(4) : '—'}</td>
                        <td className="px-3 py-2 text-right font-mono">{c.cash_price != null ? fmtPrice(c.cash_price) : '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs">{(c.delivery_start_date || c.delivery_end_date) ? `${c.delivery_start_date ?? '?'} → ${c.delivery_end_date ?? '?'}` : '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs">{PRICING_STATUS_LABEL[c.pricing_status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Hedge Positions Detail" open={openSection === 'hedges'} onToggle={() => setOpenSection((s) => (s === 'hedges' ? null : 'hedges'))}>
            <div className="space-y-3">
              <div>
                <div className="text-sm font-semibold text-slate-700 mb-1">Futures ({futures.length})</div>
                {futures.length === 0 ? <p className="text-sm text-slate-400">None.</p> : (
                  <div className="overflow-x-auto"><table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600"><tr>{['Commodity', 'Month', 'Side', '#', 'Trade $', 'Status', 'Realized'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
                    <tbody>{futures.map((f) => (
                      <tr key={f.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{f.commodity}</td><td className="px-3 py-2">{f.contract_month}</td>
                        <td className="px-3 py-2 capitalize">{f.side}</td><td className="px-3 py-2 text-right">{f.num_contracts}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtPrice(f.trade_price)}</td><td className="px-3 py-2 capitalize">{f.status}</td>
                        <td className="px-3 py-2 text-right font-mono">{f.realized_pnl != null ? fmtPnl(f.realized_pnl) : '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-700 mb-1">Options ({options.length})</div>
                {options.length === 0 ? <p className="text-sm text-slate-400">None.</p> : (
                  <div className="overflow-x-auto"><table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600"><tr>{['Commodity', 'Type', 'Side', 'Month', 'Strike', '#', 'Status', 'Realized'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
                    <tbody>{options.map((o) => (
                      <tr key={o.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{o.commodity}</td><td className="px-3 py-2 capitalize">{o.option_type}</td>
                        <td className="px-3 py-2 capitalize">{o.side}</td><td className="px-3 py-2">{o.underlying_contract_month}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtPrice(o.strike_price)}</td><td className="px-3 py-2 text-right">{o.num_contracts}</td>
                        <td className="px-3 py-2">{o.status}</td><td className="px-3 py-2 text-right font-mono">{o.realized_pnl != null ? fmtPnl(o.realized_pnl) : '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Unpriced Production" open={openSection === 'unpriced'} onToggle={() => setOpenSection((s) => (s === 'unpriced' ? null : 'unpriced'))}>
            <p className="text-xs text-slate-500 mb-2">Bushels with zero price protection = Total Production − (Contracted + Open Futures Hedged).</p>
            <div className="overflow-x-auto"><table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600"><tr>{['Crop', 'Total Production', 'Contracted', 'Open Futures Hedged', 'Completely Unpriced'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>{rows.map((r) => {
                const unpriced = r.totalProduction - (r.contractedBu + r.openFuturesHedgedBu)
                return (
                  <tr key={r.cropId} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.cropName}</td>
                    <td className="px-3 py-2 text-right font-mono">{bu(r.totalProduction)}</td>
                    <td className="px-3 py-2 text-right font-mono">{bu(r.contractedBu)}</td>
                    <td className="px-3 py-2 text-right font-mono">{bu(r.openFuturesHedgedBu)}</td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${unpriced > 0 ? 'text-amber-700' : 'text-green-700'}`}>{bu(unpriced)}</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          </CollapsibleSection>
        </>
      )}
    </div>
  )
}

function BaseTable({ rows }: { rows: MarketingRow[] }) {
  const anyExcluded = rows.some((r) => r.excludedAwaitingBu > 0)
  const tot = rows.reduce((a, r) => ({ acres: a.acres + r.acres, prod: a.prod + r.totalProduction, contracted: a.contracted + r.contractedBu, remaining: a.remaining + r.remaining }), { acres: 0, prod: 0, contracted: 0, remaining: 0 })
  return (
    <div className="bg-white rounded-xl shadow overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-100 text-slate-700"><tr>{['Crop', 'Acres', 'Yield', 'Total Production', 'Contracted Bu', 'Bu Remaining', 'Avg Price'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cropId} className="border-t border-slate-100">
              <td className="px-3 py-2 font-semibold">{r.cropName}</td>
              <td className="px-3 py-2 text-right font-mono">{bu(r.acres)}</td>
              <td className="px-3 py-2 text-right font-mono">{r.yield != null ? `${r.yield.toFixed(1)} ` : '—'}<span className="text-xs text-slate-400">{r.yield != null ? r.yieldLabel : ''}</span></td>
              <td className="px-3 py-2 text-right font-mono">{bu(r.totalProduction)}</td>
              <td className="px-3 py-2 text-right font-mono">{bu(r.contractedBu)}</td>
              <td className={`px-3 py-2 text-right font-mono ${r.remaining < 0 ? 'text-red-700 font-semibold' : ''}`}>{bu(r.remaining)}</td>
              <td className="px-3 py-2 text-right font-mono">{r.avgCashPrice != null ? fmtPrice(r.avgCashPrice) : '—'}{r.excludedAwaitingBu > 0 && <span className="text-amber-600">*</span>}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
            <td className="px-3 py-2">Total</td>
            <td className="px-3 py-2 text-right font-mono">{bu(tot.acres)}</td>
            <td />
            <td className="px-3 py-2 text-right font-mono">{bu(tot.prod)}</td>
            <td className="px-3 py-2 text-right font-mono">{bu(tot.contracted)}</td>
            <td className={`px-3 py-2 text-right font-mono ${tot.remaining < 0 ? 'text-red-700' : ''}`}>{bu(tot.remaining)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      {anyExcluded && <p className="text-xs text-amber-700 px-3 py-2">* Excludes bushels on contracts still awaiting pricing (HTA basis / basis futures not set).</p>}
    </div>
  )
}

function DetailedTable({ rows }: { rows: MarketingRow[] }) {
  return (
    <div className="bg-white rounded-xl shadow overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-100 text-slate-700"><tr>{['Crop', 'Acres', 'Yield', 'Total Prod', 'Contracted Bu', 'Bu Remaining', 'Avg Futures', 'Avg Basis', 'Total Avg Price', 'Cost/Acre', 'Cost/Bu', 'Profit/Acre', 'Total Profit'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cropId} className="border-t border-slate-100">
              <td className="px-3 py-2 font-semibold">{r.cropName}</td>
              <td className="px-3 py-2 text-right font-mono">{bu(r.acres)}</td>
              <td className="px-3 py-2 text-right font-mono">{r.yield != null ? r.yield.toFixed(1) : '—'} <span className="text-xs text-slate-400">{r.yield != null ? r.yieldLabel : ''}</span></td>
              <td className="px-3 py-2 text-right font-mono">{bu(r.totalProduction)}</td>
              <td className="px-3 py-2 text-right font-mono">{bu(r.contractedBu)}</td>
              <td className={`px-3 py-2 text-right font-mono ${r.remaining < 0 ? 'text-red-700 font-semibold' : ''}`}>{bu(r.remaining)}</td>
              <td className="px-3 py-2 text-right font-mono">{r.avgFutures != null ? fmtPrice(r.avgFutures) : '—'}</td>
              <td className="px-3 py-2 text-right font-mono">{r.avgBasis != null ? Number(r.avgBasis).toFixed(4) : 'N/A'}</td>
              <td className="px-3 py-2 text-right font-mono">{r.totalAvgPrice != null ? fmtPrice(r.totalAvgPrice) : r.avgFutures != null ? `${fmtPrice(r.avgFutures)}*` : r.avgCashPrice != null ? fmtPrice(r.avgCashPrice) : '—'}</td>
              <td className="px-3 py-2 text-right font-mono">{usd(r.costPerAcre)}</td>
              <td className="px-3 py-2 text-right font-mono">{r.costPerBu != null ? fmtPrice(r.costPerBu) : '—'}</td>
              <td className={`px-3 py-2 text-right font-mono ${r.profitPerAcre == null ? 'text-slate-400' : r.profitPerAcre >= 0 ? 'text-green-700' : 'text-red-700'}`}>{r.profitPerAcre != null ? usd(r.profitPerAcre) : 'Incomplete'}</td>
              <td className={`px-3 py-2 text-right font-mono font-semibold ${r.totalProfit == null ? 'text-slate-400' : r.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{r.totalProfit != null ? usd(r.totalProfit) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-slate-500 px-3 py-2">Avg Futures includes physical contracts with a futures price plus short futures hedges, adjusted for closed-hedge and options realized P&amp;L. * = futures only (no basis set yet).</p>
    </div>
  )
}

function AssumptionsEditor({ crops, year, assumptions, segByCrop, actualByCrop, onSave }: {
  crops: Crop[]; year: number; assumptions: CropAssumption[]
  segByCrop: Map<string, SegmentAcres>
  actualByCrop: Map<string, { production: number; yield: number | null }>
  onSave: (cropId: string, patch: Partial<CropAssumption>) => void
}) {
  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Assumptions — {year}</h2>
        <p className="text-xs text-slate-500">
          Enter an overall yield and cost/acre, or break them out by irrigated/dryland (and full-season/double-crop
          for double-cropped acres) — a blank breakout cell falls back to the overall. Once you break a column out,
          the Overall row shows the acre-weighted average. On harvest complete, the actual average yield from loads
          replaces the estimate and is used going forward.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {crops.map((c) => {
          const a = assumptions.find((x) => x.crop_id === c.id && x.crop_year === year)
          // Key on updated_at so the inputs re-seed from the DB after a save —
          // e.g. when harvest-complete snaps the overall yield to actual.
          return (
            <AssumptionRow
              key={`${c.id}:${a?.updated_at ?? 'new'}`}
              crop={c}
              assumption={a}
              seg={segByCrop.get(c.id)}
              actual={actualByCrop.get(c.id)}
              onSave={onSave}
            />
          )
        })}
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
    })
  }

  const ic = 'rounded border border-slate-300 px-2 py-1 w-20 text-right'
  const cell = 'px-1 py-1'
  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-semibold flex-1">{crop.name}</span>
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
      </div>
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

function CollapsibleSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow overflow-hidden">
      <button onClick={onToggle} className="w-full text-left px-4 py-3 font-semibold flex items-center justify-between">
        <span>{title}</span>
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}
