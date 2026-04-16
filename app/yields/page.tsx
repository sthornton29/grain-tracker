'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { buildDoubleCropSoySet } from '@/lib/plantings'
import type { Crop, Entity, Farm, Field, FieldPlanting } from '@/lib/types'

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

export default function YieldsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [loading, setLoading] = useState(true)

  const [year, setYear] = useState<number | ''>(currentYear())
  const [cropId, setCropId] = useState('')
  const [farmId, setFarmId] = useState('')
  const [entityId, setEntityId] = useState('')
  const [cropYear, setCropYear] = useState<number | ''>('')

  async function refresh() {
    setLoading(true)
    const [en, fa, fi, cr, pl, lo] = await Promise.all([
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('loads').select('date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id'),
    ])
    setEntities((en.data as Entity[]) || [])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setLoads((lo.data as LoadRow[]) || [])
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const farmById  = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const cropById  = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const doubleCropSoyIds = useMemo(
    () => buildDoubleCropSoySet(plantings, cropById),
    [plantings, cropById],
  )

  // dry bushels per (fieldId, cropId, year)
  const dryBuByKey = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of loads) {
      if (l.from_type !== 'field' || !l.from_field_id || !l.crop_id) continue
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
      const yr = Number(l.date.slice(0, 4))
      const key = `${l.from_field_id}|${l.crop_id}|${yr}`
      map.set(key, (map.get(key) ?? 0) + dryBushels)
    }
    return map
  }, [loads, cropById, cropYear])

  const cropYearOptions = useMemo(() => {
    const set = new Set<number>()
    loads.forEach((l) => l.crop_year != null && set.add(l.crop_year))
    return [...set].sort((a, b) => b - a)
  }, [loads])

  const distinctYears = useMemo(() => {
    const s = new Set<number>([currentYear()])
    plantings.forEach((p) => s.add(p.season_year))
    return [...s].sort((a, b) => b - a)
  }, [plantings])

  const visible = plantings.filter((p) => {
    if (year !== '' && p.season_year !== year) return false
    if (cropId && p.crop_id !== cropId) return false
    const fld = fieldById.get(p.field_id)
    if (!fld) return false
    if (farmId && fld.farm_id !== farmId) return false
    if (entityId) {
      const farm = fld.farm_id ? farmById.get(fld.farm_id) : null
      if (!farm || farm.entity_id !== entityId) return false
    }
    return true
  })

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  function rowFor(p: FieldPlanting) {
    const fld = fieldById.get(p.field_id)
    const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
    const ent = farm?.entity_id ? entityById.get(farm.entity_id) : null
    const crop = cropById.get(p.crop_id)
    const dryBu = dryBuByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`) ?? 0
    const acres = Number(p.planted_acres)
    const yieldBuPerAc = acres > 0 ? dryBu / acres : null
    return { fld, farm, ent, crop, dryBu, acres, yieldBuPerAc }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Yields by Field</h1>
      <p className="text-sm text-slate-500">
        Dry bushels harvested ÷ planted acres, matched to plantings by field + crop + load year.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <select value={year} onChange={(e) => setYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
          <option value="">All seasons</option>
          {distinctYears.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
          <option value="">All crop years</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
        </select>
        <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
          <option value="">All crops</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={farmId} onChange={(e) => setFarmId(e.target.value)} className={inputCls}>
          <option value="">All farms</option>
          {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
          <option value="">All entities</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Field','Farm','Entity','Crop','Year','Acres','Dry bu','Yield (bu/ac)','']
                .map((h, i) => <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">No plantings match these filters.</td></tr>
            )}
            {visible.map((p) => {
              const r = rowFor(p)
              return (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{r.fld?.name_or_number ?? '—'}</td>
                  <td className="px-3 py-2">{r.farm?.name ?? ''}</td>
                  <td className="px-3 py-2">{r.ent?.name ?? ''}</td>
                  <td className="px-3 py-2">{r.crop?.name ?? '—'}</td>
                  <td className="px-3 py-2">{p.season_year}</td>
                  <td className="px-3 py-2 text-right">{r.acres.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2 text-right">{r.dryBu.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2 text-right font-semibold">
                    {r.yieldBuPerAc != null ? r.yieldBuPerAc.toFixed(1) : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {doubleCropSoyIds.has(p.id) && (
                      <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">double-crop</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
