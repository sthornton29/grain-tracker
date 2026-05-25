'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { computeMarketing, type MarketingRow, type Planting } from '@/lib/marketing'
import { fmtPrice } from '@/lib/hedging'
import type { ExportPayload } from '@/lib/exports'
import type { Contract, Crop, CropAssumption, FuturesPosition, OptionPosition } from '@/lib/types'

type LoadRow = { crop_id: string | null; from_type: string | null; net_weight: number | null; moisture: number | null; dry_bushels_override: number | null }
const bu = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
const usd = (n: number | null | undefined) => (n == null ? '' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

export default function MarketingReport({ onPayloadChange }: { onPayloadChange?: (build: () => ExportPayload) => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [yearOptions, setYearOptions] = useState<number[]>([])
  const [year, setYear] = useState<number | null>(null)
  const [view, setView] = useState<'base' | 'detailed'>('base')
  const [loading, setLoading] = useState(false)

  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<Planting[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [futures, setFutures] = useState<FuturesPosition[]>([])
  const [options, setOptions] = useState<OptionPosition[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [production, setProduction] = useState<Map<string, number>>(new Map())

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
    const [cr, pl, ct, fp, op, ca, ld] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('crop_id, season_year, planted_acres').eq('season_year', cropYear),
      supabase.from('contracts').select('*').eq('crop_year', cropYear),
      supabase.from('futures_positions').select('*').eq('crop_year', cropYear),
      supabase.from('options_positions').select('*').eq('crop_year', cropYear),
      supabase.from('crop_assumptions').select('*').eq('crop_year', cropYear),
      supabase.from('loads').select('crop_id, from_type, net_weight, moisture, dry_bushels_override').eq('crop_year', cropYear),
    ])
    const cropsList = (cr.data as Crop[]) ?? []
    setCrops(cropsList)
    setPlantings((pl.data as Planting[]) ?? [])
    setContracts((ct.data as Contract[]) ?? [])
    setFutures((fp.data as FuturesPosition[]) ?? [])
    setOptions((op.data as OptionPosition[]) ?? [])
    setAssumptions((ca.data as CropAssumption[]) ?? [])
    const cropById = new Map(cropsList.map((c) => [c.id, c]))
    const prod = new Map<string, number>()
    for (const l of ((ld.data as LoadRow[]) ?? [])) {
      if (l.from_type !== 'field' || !l.crop_id) continue
      const crop = cropById.get(l.crop_id)
      const { dryBushels } = computeBushels({ netWeightLb: l.net_weight, moisturePct: l.moisture, baseMoisturePct: crop?.base_moisture_pct ?? null, baseLbPerBushel: crop?.base_lb_per_bushel ?? null, dryBushelsOverride: l.dry_bushels_override })
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

  function buildExportPayload(): ExportPayload {
    const sections: ExportPayload['sections'] = []
    sections.push({
      title: 'Base',
      columns: [{ label: 'Crop' }, { label: 'Acres', align: 'right' }, { label: 'Yield', align: 'right' }, { label: 'Total Production', align: 'right' }, { label: 'Contracted Bu', align: 'right' }, { label: 'Bu Remaining', align: 'right' }, { label: 'Avg Price', align: 'right' }],
      rows: rows.map((r) => [r.cropName, Math.round(r.acres), r.yield != null ? Number(r.yield.toFixed(1)) : '', Math.round(r.totalProduction), Math.round(r.contractedBu), Math.round(r.remaining), r.avgCashPrice != null ? Number(r.avgCashPrice) : '']),
    })
    sections.push({
      title: 'Detailed',
      columns: [{ label: 'Crop' }, { label: 'Acres', align: 'right' }, { label: 'Yield', align: 'right' }, { label: 'Total Production', align: 'right' }, { label: 'Contracted Bu', align: 'right' }, { label: 'Bu Remaining', align: 'right' }, { label: 'Avg Futures', align: 'right' }, { label: 'Avg Basis', align: 'right' }, { label: 'Total Avg Price', align: 'right' }, { label: 'Cost/Acre', align: 'right' }, { label: 'Cost/Bu', align: 'right' }, { label: 'Profit/Acre', align: 'right' }, { label: 'Total Profit', align: 'right' }],
      rows: rows.map((r) => [r.cropName, Math.round(r.acres), r.yield != null ? Number(r.yield.toFixed(1)) : '', Math.round(r.totalProduction), Math.round(r.contractedBu), Math.round(r.remaining), r.avgFutures != null ? Number(r.avgFutures) : '', r.avgBasis != null ? Number(r.avgBasis) : '', r.totalAvgPrice != null ? Number(r.totalAvgPrice) : '', r.costPerAcre ?? '', r.costPerBu ?? '', r.profitPerAcre ?? '', r.totalProfit ?? '']),
    })
    return { title: `Marketing Dashboard${year != null ? ` — ${year}` : ''}`, filters: year != null ? `Crop year: ${year}` : 'No crop year selected', sections }
  }

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, year, onPayloadChange])

  return (
    <div className="space-y-4 print-area">
      <div className="flex items-center gap-3 flex-wrap no-print">
        <select value={year ?? ''} onChange={(e) => setYear(e.target.value === '' ? null : Number(e.target.value))} className="rounded-lg border border-slate-300 px-3 py-2">
          <option value="">— pick a crop year —</option>
          {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        {year != null && (['base', 'detailed'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${view === v ? 'bg-slate-700 text-white border-slate-700' : 'bg-white border-slate-300'}`}>
            {v === 'base' ? 'Base View' : 'Detailed View'}
          </button>
        ))}
      </div>

      {year == null ? (
        <p className="text-amber-700 text-sm">Pick a crop year to run the marketing report.</p>
      ) : loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-slate-400 text-center py-8">No planted crops for {year}.</p>
      ) : (
        <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
          <h2 className="font-bold text-lg mb-2">Marketing Dashboard — {year}</h2>
          <table className="min-w-full text-sm">
            <thead className="text-slate-500">
              {view === 'base' ? (
                <tr>{['Crop', 'Acres', 'Yield', 'Total Production', 'Contracted Bu', 'Bu Remaining', 'Avg Price'].map((h) => <th key={h} className="text-left pr-4 font-medium whitespace-nowrap">{h}</th>)}</tr>
              ) : (
                <tr>{['Crop', 'Acres', 'Yield', 'Total Prod', 'Contracted', 'Remaining', 'Avg Futures', 'Avg Basis', 'Total Avg Price', 'Cost/Acre', 'Cost/Bu', 'Profit/Acre', 'Total Profit'].map((h) => <th key={h} className="text-left pr-4 font-medium whitespace-nowrap">{h}</th>)}</tr>
              )}
            </thead>
            <tbody>
              {rows.map((r: MarketingRow) => view === 'base' ? (
                <tr key={r.cropId} className="border-t border-slate-100">
                  <td className="pr-4 py-1 font-semibold">{r.cropName}</td>
                  <td className="pr-4 py-1 text-right font-mono">{bu(r.acres)}</td>
                  <td className="pr-4 py-1 text-right font-mono">{r.yield != null ? `${r.yield.toFixed(1)} ${r.yieldLabel}` : '—'}</td>
                  <td className="pr-4 py-1 text-right font-mono">{bu(r.totalProduction)}</td>
                  <td className="pr-4 py-1 text-right font-mono">{bu(r.contractedBu)}</td>
                  <td className={`pr-4 py-1 text-right font-mono ${r.remaining < 0 ? 'text-red-700' : ''}`}>{bu(r.remaining)}</td>
                  <td className="pr-4 py-1 text-right font-mono">{r.avgCashPrice != null ? fmtPrice(r.avgCashPrice) : '—'}</td>
                </tr>
              ) : (
                <tr key={r.cropId} className="border-t border-slate-100">
                  <td className="pr-4 py-1 font-semibold">{r.cropName}</td>
                  <td className="pr-4 py-1 text-right font-mono">{bu(r.acres)}</td>
                  <td className="pr-4 py-1 text-right font-mono">{r.yield != null ? r.yield.toFixed(1) : '—'}</td>
                  <td className="pr-4 py-1 text-right font-mono">{bu(r.totalProduction)}</td>
                  <td className="pr-4 py-1 text-right font-mono">{bu(r.contractedBu)}</td>
                  <td className={`pr-4 py-1 text-right font-mono ${r.remaining < 0 ? 'text-red-700' : ''}`}>{bu(r.remaining)}</td>
                  <td className="pr-4 py-1 text-right font-mono">{r.avgFutures != null ? fmtPrice(r.avgFutures) : '—'}</td>
                  <td className="pr-4 py-1 text-right font-mono">{r.avgBasis != null ? Number(r.avgBasis).toFixed(4) : 'N/A'}</td>
                  <td className="pr-4 py-1 text-right font-mono">{r.totalAvgPrice != null ? fmtPrice(r.totalAvgPrice) : '—'}</td>
                  <td className="pr-4 py-1 text-right font-mono">{usd(r.costPerAcre) || '—'}</td>
                  <td className="pr-4 py-1 text-right font-mono">{r.costPerBu != null ? fmtPrice(r.costPerBu) : '—'}</td>
                  <td className={`pr-4 py-1 text-right font-mono ${r.profitPerAcre == null ? 'text-slate-400' : r.profitPerAcre >= 0 ? 'text-green-700' : 'text-red-700'}`}>{r.profitPerAcre != null ? usd(r.profitPerAcre) : 'Incomplete'}</td>
                  <td className={`pr-4 py-1 text-right font-mono font-semibold ${r.totalProfit == null ? 'text-slate-400' : r.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{r.totalProfit != null ? usd(r.totalProfit) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
