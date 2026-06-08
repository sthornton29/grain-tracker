'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { buildDoubleCropSoySet } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { fieldCropAggregates, analyzeYields } from '@/lib/yields'
import AvgYieldHeader from '@/components/reports/avg-yield-header'
import type { Crop, FieldPlanting, LoadSplit } from '@/lib/types'

type LoadRow = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
}

const currentYear = () => new Date().getFullYear()

export default function SeasonSummaryPage() {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [loading, setLoading] = useState(true)
  // Filter persists across visits (see usePersistentState).
  const [year, setYear] = usePersistentState<number>('season:year', currentYear())

  async function refresh() {
    setLoading(true)
    const [cr, pl, lo, sp] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('loads').select('id, date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id'),
      supabase.from('load_splits').select('*'),
    ])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setLoads((lo.data as LoadRow[]) || [])
    setSplits((sp.data as LoadSplit[]) || [])
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])

  const distinctYears = useMemo(() => {
    const s = new Set<number>([currentYear()])
    plantings.forEach((p) => s.add(p.season_year))
    return [...s].sort((a, b) => b - a)
  }, [plantings])

  const yearPlantings = plantings.filter((p) => p.season_year === year)

  // Dry bushels + most-recent load date per field+crop+year (shared rules),
  // scoped to the selected season year.
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { loadYear: year }),
    [loads, splits, cropById, year],
  )
  const dryBuFor = (fieldId: string, cropId: string, yr: number) =>
    aggByKey.get(`${fieldId}|${cropId}|${yr}`)?.dryBu ?? 0

  // Unharvested / in-progress fields are excluded from the season's production
  // and yield (per crop). Acreage columns still count every planted field.
  const yieldAnalysis = useMemo(() => analyzeYields(
    yearPlantings.map((p) => {
      const agg = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
      return {
        id: p.id,
        cropId: p.crop_id,
        acres: Number(p.planted_acres),
        dryBu: agg?.dryBu ?? 0,
        lastLoadDate: agg?.lastLoadDate ?? null,
        override: p.yield_include_override,
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [plantings, aggByKey, year])

  type Agg = {
    cropName: string
    fullSeasonAcres: number
    doubleCropAcres: number
    totalAcres: number
    irrigatedAcres: number
    drylandAcres: number
    dryBu: number
    // Acres of the harvested, included fields only — the denominator for yield
    // so partial/unharvested fields don't drag bu/ac down.
    harvestedAcres: number
  }

  const doubleCropSoyIds = useMemo(
    () => buildDoubleCropSoySet(plantings, cropById),
    [plantings, cropById],
  )

  const byCrop = useMemo(() => {
    const excluded = yieldAnalysis.excluded
    const m = new Map<string, Agg>()
    for (const p of yearPlantings) {
      const cropName = cropById.get(p.crop_id)?.name ?? '—'
      const key = p.crop_id
      if (!m.has(key)) m.set(key, {
        cropName,
        fullSeasonAcres: 0, doubleCropAcres: 0, totalAcres: 0,
        irrigatedAcres: 0, drylandAcres: 0, dryBu: 0, harvestedAcres: 0,
      })
      const agg = m.get(key)!
      const acres = Number(p.planted_acres)
      agg.totalAcres += acres
      agg.irrigatedAcres += Number(p.irrigated_acres) || 0
      agg.drylandAcres   += Number(p.dryland_acres)   || 0
      if (doubleCropSoyIds.has(p.id)) agg.doubleCropAcres += acres
      else agg.fullSeasonAcres += acres
      // Production + yield count only harvested, non-in-progress fields.
      if (!excluded.has(p.id)) {
        agg.dryBu += dryBuFor(p.field_id, p.crop_id, p.season_year)
        agg.harvestedAcres += acres
      }
    }
    return [...m.values()].sort((a, b) => a.cropName.localeCompare(b.cropName))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearPlantings, cropById, aggByKey, yieldAnalysis, doubleCropSoyIds])

  const totals = byCrop.reduce(
    (acc, r) => {
      acc.acres += r.totalAcres
      acc.dryBu += r.dryBu
      acc.fullSeason += r.fullSeasonAcres
      acc.doubleCrop += r.doubleCropAcres
      acc.irrigated += r.irrigatedAcres
      acc.dryland += r.drylandAcres
      return acc
    },
    { acres: 0, dryBu: 0, fullSeason: 0, doubleCrop: 0, irrigated: 0, dryland: 0 }
  )

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const fmt = (n: number, d = 1) => n.toLocaleString(undefined, { maximumFractionDigits: d })

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Season Summary</h1>
        <label className="text-sm flex items-center gap-2">
          Season
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={inputCls}>
            {distinctYears.map((y) => <option key={y} value={y}>{y}</option>)}
            {!distinctYears.includes(year) && <option value={year}>{year}</option>}
          </select>
        </label>
      </div>

      {loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : (
        <>
          <AvgYieldHeader averages={yieldAnalysis.averages} cropName={(id) => cropById.get(id)?.name ?? '—'} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Crops planted" value={String(byCrop.length)} />
            <Stat label="Total acres" value={fmt(totals.acres, 2)} />
            <Stat label="Irrigated acres" value={fmt(totals.irrigated, 2)} />
            <Stat label="Dryland acres" value={fmt(totals.dryland, 2)} />
          </div>

          <div className="overflow-x-auto bg-white rounded-xl shadow">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {['Crop','Full-season ac','Double-crop ac','Total ac','Irrigated ac','Dryland ac','Dry bu','Yield (bu/ac)']
                    .map((h, i) => <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {byCrop.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No plantings recorded for {year}.</td></tr>
                )}
                {byCrop.map((r) => {
                  const yld = r.harvestedAcres > 0 ? r.dryBu / r.harvestedAcres : null
                  return (
                    <tr key={r.cropName} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-semibold">{r.cropName}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.fullSeasonAcres, 2)}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.doubleCropAcres, 2)}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.totalAcres, 2)}</td>
                      <td className="px-3 py-2 text-right">{r.irrigatedAcres > 0 ? fmt(r.irrigatedAcres, 2) : '—'}</td>
                      <td className="px-3 py-2 text-right">{r.drylandAcres > 0 ? fmt(r.drylandAcres, 2) : '—'}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.dryBu, 2)}</td>
                      <td className="px-3 py-2 text-right font-semibold">{yld != null ? yld.toFixed(1) : '—'}</td>
                    </tr>
                  )
                })}
                {byCrop.length > 0 && (
                  <tr className="border-t-2 border-slate-300 bg-slate-50">
                    <td className="px-3 py-2 font-bold">Total</td>
                    <td className="px-3 py-2 text-right">{fmt(totals.fullSeason, 2)}</td>
                    <td className="px-3 py-2 text-right">{fmt(totals.doubleCrop, 2)}</td>
                    <td className="px-3 py-2 text-right">{fmt(totals.acres, 2)}</td>
                    <td className="px-3 py-2 text-right">{fmt(totals.irrigated, 2)}</td>
                    <td className="px-3 py-2 text-right">{fmt(totals.dryland, 2)}</td>
                    <td className="px-3 py-2 text-right">{fmt(totals.dryBu, 2)}</td>
                    <td className="px-3 py-2"></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  )
}
