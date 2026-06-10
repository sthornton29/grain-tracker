'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { computeMarketing, type MarketingRow, type Planting } from '@/lib/marketing'
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
  const [plantings, setPlantings] = useState<Planting[]>([])
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
      supabase.from('field_plantings').select('crop_id, season_year, planted_acres').eq('season_year', cropYear),
      supabase.from('contracts').select('*').eq('crop_year', cropYear),
      supabase.from('futures_positions').select('*').eq('crop_year', cropYear),
      supabase.from('options_positions').select('*').eq('crop_year', cropYear),
      supabase.from('crop_assumptions').select('*').eq('crop_year', cropYear),
      supabase.from('loads').select('crop_id, crop_year, from_type, net_weight, moisture, dry_bushels_override').eq('crop_year', cropYear),
    ])
    const cropsList = (cr.data as Crop[]) ?? []
    setCrops(cropsList)
    setBuyers((by.data as Buyer[]) ?? [])
    setPlantings((pl.data as Planting[]) ?? [])
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

  const rows = useMemo(
    () => (year == null ? [] : computeMarketing({ cropYear: year, crops, plantings, contracts, futures, options, assumptions, actualProductionByCrop: production })),
    [year, crops, plantings, contracts, futures, options, assumptions, production],
  )

  const cropName = (id: string | null) => crops.find((c) => c.id === id)?.name ?? ''
  const buyerName = (id: string | null) => buyers.find((b) => b.id === id)?.name ?? ''

  // Crops shown in the assumptions editor: those with plantings this year.
  const plantedCropIds = useMemo(() => new Set(plantings.map((p) => p.crop_id)), [plantings])
  const plantedCrops = crops.filter((c) => plantedCropIds.has(c.id))

  async function saveAssumption(cropId: string, patch: Partial<CropAssumption>) {
    if (year == null) return
    const existing = assumptions.find((a) => a.crop_id === cropId && a.crop_year === year)
    const row = {
      crop_id: cropId,
      crop_year: year,
      expected_yield: patch.expected_yield ?? existing?.expected_yield ?? null,
      harvest_complete: patch.harvest_complete ?? existing?.harvest_complete ?? false,
      cost_per_acre: patch.cost_per_acre ?? existing?.cost_per_acre ?? null,
      notes: patch.notes ?? existing?.notes ?? null,
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
          <AssumptionsEditor crops={plantedCrops} year={year} assumptions={assumptions} onSave={saveAssumption} />

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
              <td className="px-3 py-2 text-right font-mono">{r.totalAvgPrice != null ? fmtPrice(r.totalAvgPrice) : (r.avgFutures != null ? `${fmtPrice(r.avgFutures)}*` : '—')}</td>
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

function AssumptionsEditor({ crops, year, assumptions, onSave }: {
  crops: Crop[]; year: number; assumptions: CropAssumption[]; onSave: (cropId: string, patch: Partial<CropAssumption>) => void
}) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <h2 className="font-semibold mb-2">Assumptions — {year}</h2>
      <p className="text-xs text-slate-500 mb-2">Expected yield is used until you mark harvest complete, then actual yield from loads is used. Enter cost/acre for profit calculations.</p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr>{['Crop', 'Expected Yield (bu/ac)', 'Harvest complete', 'Cost / Acre', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>
            {crops.map((c) => <AssumptionRow key={c.id} crop={c} assumption={assumptions.find((a) => a.crop_id === c.id && a.crop_year === year)} onSave={onSave} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AssumptionRow({ crop, assumption, onSave }: { crop: Crop; assumption?: CropAssumption; onSave: (cropId: string, patch: Partial<CropAssumption>) => void }) {
  const [yieldStr, setYieldStr] = useState(assumption?.expected_yield != null ? String(assumption.expected_yield) : '')
  const [costStr, setCostStr] = useState(assumption?.cost_per_acre != null ? String(assumption.cost_per_acre) : '')
  const inputCls = 'rounded border border-slate-300 px-2 py-1 w-32'
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 font-semibold">{crop.name}</td>
      <td className="px-3 py-2"><input type="number" step="0.1" value={yieldStr} onChange={(e) => setYieldStr(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2">
        <input type="checkbox" checked={assumption?.harvest_complete ?? false} onChange={(e) => onSave(crop.id, { harvest_complete: e.target.checked })} />
      </td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={costStr} onChange={(e) => setCostStr(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2">
        <button
          onClick={() => onSave(crop.id, { expected_yield: yieldStr === '' ? null : Number(yieldStr), cost_per_acre: costStr === '' ? null : Number(costStr) })}
          className="rounded-lg bg-green-700 text-white px-3 py-1 text-sm font-semibold"
        >Save</button>
      </td>
    </tr>
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
