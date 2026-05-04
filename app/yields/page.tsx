'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { buildDoubleCropSoySet, cropYearOptionsFromPlantings } from '@/lib/plantings'
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

type ViewMode = 'field' | 'farm'

const currentYear = () => new Date().getFullYear()

function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function fmtNum(n: number, d = 2) {
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

export default function YieldsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [loading, setLoading] = useState(true)

  const [view, setView] = useState<ViewMode>('field')
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

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

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

  type FarmAgg = {
    farmId: string | null
    farmName: string
    fsaNumber: string | null
    entityName: string
    cropName: string
    seasonYear: number
    acres: number
    dryBu: number
  }

  const byFarm = useMemo<FarmAgg[]>(() => {
    const m = new Map<string, FarmAgg>()
    for (const p of visible) {
      const fld = fieldById.get(p.field_id)
      const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
      const ent = farm?.entity_id ? entityById.get(farm.entity_id) : null
      const crop = cropById.get(p.crop_id)
      const dryBu = dryBuByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`) ?? 0
      const acres = Number(p.planted_acres)
      const key = `${farm?.id ?? '∅'}|${p.crop_id}|${p.season_year}`
      const existing = m.get(key)
      if (existing) {
        existing.acres += acres
        existing.dryBu += dryBu
      } else {
        m.set(key, {
          farmId: farm?.id ?? null,
          farmName: farm?.name ?? '— no farm —',
          fsaNumber: farm?.fsa_number ?? null,
          entityName: ent?.name ?? '',
          cropName: crop?.name ?? '—',
          seasonYear: p.season_year,
          acres,
          dryBu,
        })
      }
    }
    return [...m.values()].sort((a, b) => {
      if (b.seasonYear !== a.seasonYear) return b.seasonYear - a.seasonYear
      const fn = a.farmName.localeCompare(b.farmName)
      if (fn !== 0) return fn
      return a.cropName.localeCompare(b.cropName)
    })
  }, [visible, fieldById, farmById, entityById, cropById, dryBuByKey])

  function exportFieldCsv() {
    const header = ['Field', 'Farm', 'FSA#', 'Entity', 'Crop', 'Year', 'Acres', 'Dry bu', 'Yield (bu/ac)', 'Double-crop']
    const body = visible.map((p) => {
      const r = rowFor(p)
      return [
        r.fld?.name_or_number ?? '',
        r.farm?.name ?? '',
        r.farm?.fsa_number ?? '',
        r.ent?.name ?? '',
        r.crop?.name ?? '',
        p.season_year,
        r.acres.toFixed(2),
        r.dryBu.toFixed(2),
        r.yieldBuPerAc != null ? r.yieldBuPerAc.toFixed(2) : '',
        doubleCropSoyIds.has(p.id) ? 'yes' : '',
      ]
    })
    downloadCsv(`yields-by-field-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...body])
  }

  function exportFarmCsv() {
    const header = ['Farm', 'FSA#', 'Entity', 'Crop', 'Year', 'Acres', 'Dry bu', 'Yield (bu/ac)']
    const body = byFarm.map((r) => [
      r.farmName,
      r.fsaNumber ?? '',
      r.entityName,
      r.cropName,
      r.seasonYear,
      r.acres.toFixed(2),
      r.dryBu.toFixed(2),
      r.acres > 0 ? (r.dryBu / r.acres).toFixed(2) : '',
    ])
    downloadCsv(`yields-by-farm-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...body])
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-bold flex-1">
          Yields {view === 'field' ? 'by Field' : 'by Farm'}
        </h1>
        <label className="text-sm flex items-center gap-2">
          View
          <select value={view} onChange={(e) => setView(e.target.value as ViewMode)} className={inputCls}>
            <option value="field">By field</option>
            <option value="farm">By farm</option>
          </select>
        </label>
        <button
          type="button"
          onClick={view === 'field' ? exportFieldCsv : exportFarmCsv}
          disabled={loading || (view === 'field' ? visible.length === 0 : byFarm.length === 0)}
          className="rounded-lg bg-green-700 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>
      <p className="text-sm text-slate-500">
        {view === 'field'
          ? 'Dry bushels harvested ÷ planted acres, matched to plantings by field + crop + load year.'
          : 'Plantings rolled up to farm × crop × season. Dry bushels divided by planted acres.'}
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

      {view === 'field' ? (
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
                    <td className="px-3 py-2 text-right">{fmtNum(r.acres)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.dryBu)}</td>
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
      ) : (
        <div className="overflow-x-auto bg-white rounded-xl shadow">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                {['Farm','FSA#','Entity','Crop','Year','Acres','Dry bu','Yield (bu/ac)']
                  .map((h, i) => <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
              {!loading && byFarm.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No plantings match these filters.</td></tr>
              )}
              {byFarm.map((r, i) => {
                const yld = r.acres > 0 ? r.dryBu / r.acres : null
                return (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-semibold">{r.farmName}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.fsaNumber ?? ''}</td>
                    <td className="px-3 py-2">{r.entityName}</td>
                    <td className="px-3 py-2">{r.cropName}</td>
                    <td className="px-3 py-2">{r.seasonYear}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.acres)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.dryBu)}</td>
                    <td className="px-3 py-2 text-right font-semibold">
                      {yld != null ? yld.toFixed(1) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
