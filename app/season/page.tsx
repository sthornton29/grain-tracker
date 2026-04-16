'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { buildDoubleCropSoySet } from '@/lib/plantings'
import type { Crop, FieldPlanting } from '@/lib/types'

type LoadRow = {
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
  const [loading, setLoading] = useState(true)
  const [year, setYear] = useState<number>(currentYear())
  const [cropYear, setCropYear] = useState<number | ''>('')

  async function refresh() {
    setLoading(true)
    const [cr, pl, lo] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('loads').select('date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id'),
    ])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setLoads((lo.data as LoadRow[]) || [])
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

  // dry bushels per (fieldId, cropId, year)
  const dryBuByKey = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of loads) {
      if (l.from_type !== 'field' || !l.from_field_id || !l.crop_id) continue
      const yr = Number(l.date.slice(0, 4))
      if (yr !== year) continue
      if (cropYear !== '' && l.crop_year !== cropYear) continue
      const crop = cropById.get(l.crop_id)
      const { dryBushels } = computeBushels({
        netWeightLb: l.net_weight,
        moisturePct: l.moisture,
        baseMoisturePct: crop?.base_moisture_pct ?? null,
        baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
        dryBushelsOverride: l.dry_bushels_override,
      })
      if (!dryBushels) continue
      const key = `${l.from_field_id}|${l.crop_id}|${yr}`
      map.set(key, (map.get(key) ?? 0) + dryBushels)
    }
    return map
  }, [loads, cropById, year, cropYear])

  const cropYearOptions = useMemo(() => {
    const set = new Set<number>()
    loads.forEach((l) => l.crop_year != null && set.add(l.crop_year))
    return [...set].sort((a, b) => b - a)
  }, [loads])

  type Agg = {
    cropName: string
    fullSeasonAcres: number
    doubleCropAcres: number
    totalAcres: number
    dryBu: number
  }

  const doubleCropSoyIds = useMemo(
    () => buildDoubleCropSoySet(plantings, cropById),
    [plantings, cropById],
  )

  const byCrop = useMemo(() => {
    const m = new Map<string, Agg>()
    for (const p of yearPlantings) {
      const cropName = cropById.get(p.crop_id)?.name ?? '—'
      const key = p.crop_id
      if (!m.has(key)) m.set(key, { cropName, fullSeasonAcres: 0, doubleCropAcres: 0, totalAcres: 0, dryBu: 0 })
      const agg = m.get(key)!
      const acres = Number(p.planted_acres)
      agg.totalAcres += acres
      if (doubleCropSoyIds.has(p.id)) agg.doubleCropAcres += acres
      else agg.fullSeasonAcres += acres
      agg.dryBu += dryBuByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`) ?? 0
    }
    return [...m.values()].sort((a, b) => a.cropName.localeCompare(b.cropName))
  }, [yearPlantings, cropById, dryBuByKey, doubleCropSoyIds])

  const totals = byCrop.reduce(
    (acc, r) => {
      acc.acres += r.totalAcres
      acc.dryBu += r.dryBu
      acc.fullSeason += r.fullSeasonAcres
      acc.doubleCrop += r.doubleCropAcres
      return acc
    },
    { acres: 0, dryBu: 0, fullSeason: 0, doubleCrop: 0 }
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
        <label className="text-sm flex items-center gap-2">
          Crop year
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
            <option value="">All</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
      </div>

      {loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Crops planted" value={String(byCrop.length)} />
            <Stat label="Total acres" value={fmt(totals.acres, 2)} />
            <Stat label="Full-season acres" value={fmt(totals.fullSeason, 2)} />
            <Stat label="Double-crop acres" value={fmt(totals.doubleCrop, 2)} />
          </div>

          <div className="overflow-x-auto bg-white rounded-xl shadow">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {['Crop','Full-season ac','Double-crop ac','Total ac','Dry bu','Yield (bu/ac)']
                    .map((h, i) => <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {byCrop.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No plantings recorded for {year}.</td></tr>
                )}
                {byCrop.map((r) => {
                  const yld = r.totalAcres > 0 ? r.dryBu / r.totalAcres : null
                  return (
                    <tr key={r.cropName} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-semibold">{r.cropName}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.fullSeasonAcres, 2)}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.doubleCropAcres, 2)}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.totalAcres, 2)}</td>
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
