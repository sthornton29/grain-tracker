'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { buildDoubleCropSoySet, cropYearOptionsFromPlantings } from '@/lib/plantings'
import YieldsByLandowner from '@/components/reports/yields-by-landowner'
import type { Crop, Entity, Farm, Field, FieldPlanting, County, LoadSplit } from '@/lib/types'

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

type ViewMode = 'field' | 'farm' | 'landowner'
type YieldView = 'total' | 'breakdown'
type PracticeFilter = 'all' | 'irrigated' | 'dryland'

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

// Practice classification per planting.
//   pure-dry: irrigated_acres == 0
//   pure-irr: dryland_acres == 0
//   mixed:    both > 0 (the only case where yield breakout makes sense)
function practiceOf(p: FieldPlanting): 'pure-dry' | 'pure-irr' | 'mixed' {
  const irr = Number(p.irrigated_acres) || 0
  const dry = Number(p.dryland_acres) || 0
  if (irr > 0 && dry > 0) return 'mixed'
  if (irr > 0) return 'pure-irr'
  return 'pure-dry'
}

export default function YieldsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [loading, setLoading] = useState(true)

  const [view, setView] = useState<ViewMode>('field')
  const [year, setYear] = useState<number | ''>(currentYear())
  const [cropId, setCropId] = useState('')
  const [farmId, setFarmId] = useState('')
  const [entityId, setEntityId] = useState('')
  const [countyId, setCountyId] = useState('')
  const [cropYear, setCropYear] = useState<number | ''>('')
  const [yieldView, setYieldView] = useState<YieldView>('total')
  const [practiceFilter, setPracticeFilter] = useState<PracticeFilter>('all')

  // Breakout-entry UI state. Tracks which planting's row is being allocated
  // and the in-flight input values. `lastTouched` records which of the two
  // inputs the user typed in most recently — used to auto-fill the other so
  // the pair sums to total dry bushels.
  const [breakoutId, setBreakoutId] = useState<string | null>(null)
  const [breakoutIrr, setBreakoutIrr] = useState('')
  const [breakoutDry, setBreakoutDry] = useState('')
  const [lastTouched, setLastTouched] = useState<'irr' | 'dry' | null>(null)
  const [breakoutSaving, setBreakoutSaving] = useState(false)
  const [breakoutErr, setBreakoutErr] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    const [en, fa, fi, cr, pl, lo, co, sp] = await Promise.all([
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('loads').select('id, date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('load_splits').select('*'),
    ])
    setEntities((en.data as Entity[]) || [])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setLoads((lo.data as LoadRow[]) || [])
    setSplits((sp.data as LoadSplit[]) || [])
    setCounties((co.data as County[]) || [])
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
    const loadById = new Map(loads.map((l) => [l.id, l]))
    for (const s of splits) {
      const parent = loadById.get(s.load_id)
      if (!parent) continue
      if (cropYear !== '' && parent.crop_year !== cropYear) continue
      if (s.dry_bushels == null) continue
      const yr = Number(parent.date.slice(0, 4))
      const key = `${s.field_id}|${s.crop_id}|${yr}`
      map.set(key, (map.get(key) ?? 0) + s.dry_bushels)
    }
    return map
  }, [loads, splits, cropById, cropYear])

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

  const countyOptions = useMemo(() => {
    const used = new Set<string>()
    for (const f of farms) if (f.county_id) used.add(f.county_id)
    return counties.filter((c) => used.has(c.id))
  }, [farms, counties])

  const visible = plantings.filter((p) => {
    if (year !== '' && p.season_year !== year) return false
    if (cropId && p.crop_id !== cropId) return false
    const fld = fieldById.get(p.field_id)
    if (!fld) return false
    if (farmId && fld.farm_id !== farmId) return false
    const farm = fld.farm_id ? farmById.get(fld.farm_id) : null
    if (entityId) {
      if (!farm || farm.entity_id !== entityId) return false
    }
    if (countyId) {
      const effective = fld.county_id ?? farm?.county_id ?? null
      if (effective !== countyId) return false
    }
    // Practice filter: irrigated_acres > 0 or dryland_acres > 0. Mixed
    // plantings appear in both filters, since both halves have acres.
    if (practiceFilter === 'irrigated' && !(Number(p.irrigated_acres) > 0)) return false
    if (practiceFilter === 'dryland' && !(Number(p.dryland_acres) > 0)) return false
    return true
  })

  // Toggle visibility: hide when nothing irrigated and no breakouts entered.
  // Once any season has an irrigated planting or an allocated breakout, the
  // breakdown view becomes useful, so we show the toggle.
  const showYieldToggle = useMemo(() => {
    return visible.some(
      (p) => p.yield_breakout_entered || Number(p.irrigated_acres) > 0,
    )
  }, [visible])

  // Column visibility:
  //   All practice  + total      -> Total only
  //   All practice  + breakdown  -> Irrigated + Dryland + Total
  //   Irrigated only             -> Irrigated only (falls back to total when
  //                                 a mixed planting has no breakout yet)
  //   Dryland only               -> Dryland only (same fall-back)
  // The yield toggle is hidden when there's nothing to break out, so we
  // never land in a "breakdown + irrigated-only" mismatch that would show
  // two columns.
  const showIrrigatedCol = practiceFilter === 'irrigated' || (practiceFilter === 'all' && yieldView === 'breakdown')
  const showDrylandCol   = practiceFilter === 'dryland'   || (practiceFilter === 'all' && yieldView === 'breakdown')
  const showTotalCol     = practiceFilter === 'all'

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  function rowFor(p: FieldPlanting) {
    const fld = fieldById.get(p.field_id)
    const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
    const ent = farm?.entity_id ? entityById.get(farm.entity_id) : null
    const crop = cropById.get(p.crop_id)
    const dryBu = dryBuByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`) ?? 0
    const acres = Number(p.planted_acres)
    const irrAc = Number(p.irrigated_acres) || 0
    const dryAc = Number(p.dryland_acres) || 0
    const totalYield = acres > 0 ? dryBu / acres : null
    const practice = practiceOf(p)
    // Practice-specific yields per the spec:
    //   pure-dry  -> dryland yield uses total dry bushels / dryland acres
    //   pure-irr  -> irrigated yield uses total dry bushels / irrigated acres
    //   mixed     -> use the user-entered breakout when present, else null
    let irrigatedYield: number | null = null
    let drylandYield: number | null = null
    if (practice === 'pure-dry') {
      drylandYield = dryAc > 0 ? dryBu / dryAc : null
    } else if (practice === 'pure-irr') {
      irrigatedYield = irrAc > 0 ? dryBu / irrAc : null
    } else if (p.yield_breakout_entered) {
      const ib = p.irrigated_bushels != null ? Number(p.irrigated_bushels) : null
      const db = p.dryland_bushels != null ? Number(p.dryland_bushels) : null
      if (ib != null && irrAc > 0) irrigatedYield = ib / irrAc
      if (db != null && dryAc > 0) drylandYield = db / dryAc
    }
    return { fld, farm, ent, crop, dryBu, acres, irrAc, dryAc, totalYield, irrigatedYield, drylandYield, practice }
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
    const header = ['Field', 'Farm', 'FSA#', 'Entity', 'Crop', 'Year',
      'Acres', 'Irr ac', 'Dry ac', 'Dry bu',
      'Yield (bu/ac)', 'Irrigated yield', 'Dryland yield', 'Double-crop']
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
        r.irrAc.toFixed(2),
        r.dryAc.toFixed(2),
        r.dryBu.toFixed(2),
        r.totalYield != null ? r.totalYield.toFixed(2) : '',
        r.irrigatedYield != null ? r.irrigatedYield.toFixed(2) : '',
        r.drylandYield != null ? r.drylandYield.toFixed(2) : '',
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

  function openBreakout(p: FieldPlanting) {
    setBreakoutId(p.id)
    setBreakoutErr(null)
    setLastTouched(null)
    if (p.yield_breakout_entered) {
      setBreakoutIrr(p.irrigated_bushels != null ? String(p.irrigated_bushels) : '')
      setBreakoutDry(p.dryland_bushels != null ? String(p.dryland_bushels) : '')
    } else {
      // No prior allocation — leave inputs blank so the auto-calc kicks in
      // the moment the user types the first number.
      setBreakoutIrr('')
      setBreakoutDry('')
    }
  }

  function onBreakoutIrr(v: string, totalDryBu: number) {
    setBreakoutIrr(v)
    setLastTouched('irr')
    // Auto-fill the dryland side if it hasn't been manually overridden in
    // this session (lastTouched stays 'irr' until user clicks the dry input).
    if (lastTouched !== 'dry') {
      const n = Number(v || 0) || 0
      const dry = Math.max(0, totalDryBu - n)
      setBreakoutDry(v === '' ? '' : String(Number(dry.toFixed(2))))
    }
  }

  function onBreakoutDry(v: string, totalDryBu: number) {
    setBreakoutDry(v)
    setLastTouched('dry')
    if (lastTouched !== 'irr') {
      const n = Number(v || 0) || 0
      const irr = Math.max(0, totalDryBu - n)
      setBreakoutIrr(v === '' ? '' : String(Number(irr.toFixed(2))))
    }
  }

  function breakoutSumValid(totalDryBu: number): boolean {
    const i = Number(breakoutIrr || 0) || 0
    const d = Number(breakoutDry || 0) || 0
    // Allow a tiny fudge for floating point — yield maps come in with two
    // decimals so 0.01 is plenty of slack.
    return Math.abs(i + d - totalDryBu) < 0.01
  }

  async function saveBreakout(p: FieldPlanting, totalDryBu: number) {
    if (!breakoutSumValid(totalDryBu)) return
    setBreakoutSaving(true)
    const { error } = await supabase
      .from('field_plantings')
      .update({
        irrigated_bushels: Number(breakoutIrr || 0),
        dryland_bushels: Number(breakoutDry || 0),
        yield_breakout_entered: true,
      })
      .eq('id', p.id)
    setBreakoutSaving(false)
    if (error) { setBreakoutErr(error.message); return }
    setBreakoutId(null)
    refresh()
  }

  async function clearBreakout(p: FieldPlanting) {
    if (!confirm('Clear the irrigated/dryland breakout for this planting?')) return
    setBreakoutSaving(true)
    const { error } = await supabase
      .from('field_plantings')
      .update({
        irrigated_bushels: null,
        dryland_bushels: null,
        yield_breakout_entered: false,
      })
      .eq('id', p.id)
    setBreakoutSaving(false)
    if (error) { setBreakoutErr(error.message); return }
    setBreakoutId(null)
    refresh()
  }

  // Column count for table colspan calculations.
  const visibleYieldCols = [showIrrigatedCol, showDrylandCol, showTotalCol].filter(Boolean).length
  const fieldColCount = 5 /* Field/Farm/Entity/Crop/Year */ + 3 /* Acres + Irr + Dry */
    + 1 /* Dry bu */ + visibleYieldCols + 1 /* actions */

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-bold flex-1">
          Yields {view === 'field' ? 'by Field' : view === 'farm' ? 'by Farm' : 'by Landowner'}
        </h1>
        <label className="text-sm flex items-center gap-2">
          View
          <select value={view} onChange={(e) => setView(e.target.value as ViewMode)} className={inputCls}>
            <option value="field">By field</option>
            <option value="farm">By farm</option>
            <option value="landowner">By landowner</option>
          </select>
        </label>
        {view !== 'landowner' && (
          <button
            type="button"
            onClick={view === 'field' ? exportFieldCsv : exportFarmCsv}
            disabled={loading || (view === 'field' ? visible.length === 0 : byFarm.length === 0)}
            className="rounded-lg bg-green-700 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            Export CSV
          </button>
        )}
      </div>
      {view !== 'landowner' && (
        <p className="text-sm text-slate-500">
          {view === 'field'
            ? 'Dry bushels harvested ÷ planted acres, matched to plantings by field + crop + load year.'
            : 'Plantings rolled up to farm × crop × season. Dry bushels divided by planted acres.'}
        </p>
      )}

      {/* The outer filter strip drives the field- and farm-view tables. The
          landowner view has its own filter set inside <YieldsByLandowner /> so
          this row is hidden when that tab is active (otherwise the user would
          see two filter rows and only the inner one would actually apply). */}
      {view !== 'landowner' && (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
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
        <select value={countyId} onChange={(e) => setCountyId(e.target.value)} className={inputCls}>
          <option value="">All counties</option>
          {countyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
        </select>
      </div>
      )}

      {view === 'field' && (
        <div className="flex flex-wrap gap-3 items-center">
          <label className="text-sm flex items-center gap-2">
            Practice
            <select
              value={practiceFilter}
              onChange={(e) => setPracticeFilter(e.target.value as PracticeFilter)}
              className={inputCls}
            >
              <option value="all">All</option>
              <option value="irrigated">Irrigated only</option>
              <option value="dryland">Dryland only</option>
            </select>
          </label>
          {showYieldToggle && (
            <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => setYieldView('total')}
                className={`px-3 py-2 ${yieldView === 'total' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'}`}
              >
                Total yield only
              </button>
              <button
                type="button"
                onClick={() => setYieldView('breakdown')}
                className={`px-3 py-2 ${yieldView === 'breakdown' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'}`}
              >
                Irrigated / Dryland breakdown
              </button>
            </div>
          )}
        </div>
      )}

      {view === 'landowner' ? (
        <YieldsByLandowner />
      ) : view === 'field' ? (
        <div className="overflow-x-auto bg-white rounded-xl shadow">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="text-left px-3 py-2 whitespace-nowrap">Field</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Farm</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Entity</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Crop</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Acres</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Irr ac</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Dry ac</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
                {showIrrigatedCol && <th className="text-right px-3 py-2 whitespace-nowrap">Irrigated yield</th>}
                {showDrylandCol   && <th className="text-right px-3 py-2 whitespace-nowrap">Dryland yield</th>}
                {showTotalCol     && <th className="text-right px-3 py-2 whitespace-nowrap">Yield (bu/ac)</th>}
                <th className="text-left px-3 py-2 whitespace-nowrap"></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={fieldColCount} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={fieldColCount} className="px-3 py-6 text-center text-slate-400">No plantings match these filters.</td></tr>
              )}
              {visible.map((p) => {
                const r = rowFor(p)
                const showAllocateButton = r.practice === 'mixed'
                const isBreakoutOpen = breakoutId === p.id
                return (
                  <Fragment key={p.id}>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2">{r.fld?.name_or_number ?? '—'}</td>
                      <td className="px-3 py-2">{r.farm?.name ?? ''}</td>
                      <td className="px-3 py-2">{r.ent?.name ?? ''}</td>
                      <td className="px-3 py-2">{r.crop?.name ?? '—'}</td>
                      <td className="px-3 py-2">{p.season_year}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.acres)}</td>
                      <td className="px-3 py-2 text-right">{r.irrAc > 0 ? fmtNum(r.irrAc) : '—'}</td>
                      <td className="px-3 py-2 text-right">{r.dryAc > 0 ? fmtNum(r.dryAc) : '—'}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.dryBu)}</td>
                      {showIrrigatedCol && (
                        <td className="px-3 py-2 text-right font-semibold">
                          {r.irrigatedYield != null
                            ? r.irrigatedYield.toFixed(1)
                            : practiceFilter === 'irrigated' && r.totalYield != null
                              ? r.totalYield.toFixed(1)
                              : '—'}
                        </td>
                      )}
                      {showDrylandCol && (
                        <td className="px-3 py-2 text-right font-semibold">
                          {r.drylandYield != null
                            ? r.drylandYield.toFixed(1)
                            : practiceFilter === 'dryland' && r.totalYield != null
                              ? r.totalYield.toFixed(1)
                              : '—'}
                        </td>
                      )}
                      {showTotalCol && (
                        <td className="px-3 py-2 text-right font-semibold">
                          {r.totalYield != null ? r.totalYield.toFixed(1) : '—'}
                        </td>
                      )}
                      <td className="px-3 py-2 whitespace-nowrap">
                        {doubleCropSoyIds.has(p.id) && (
                          <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5 mr-2">double-crop</span>
                        )}
                        {showAllocateButton && yieldView === 'breakdown' && !isBreakoutOpen && (
                          <button
                            type="button"
                            onClick={() => openBreakout(p)}
                            className="text-sky-700 text-sm whitespace-nowrap"
                          >
                            {p.yield_breakout_entered ? 'Edit breakout' : 'Allocate irr/dry'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isBreakoutOpen && (
                      <tr className="bg-sky-50">
                        <td colSpan={fieldColCount} className="px-3 py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <div className="text-sm text-slate-600">
                              Total dry bushels: <span className="font-semibold">{fmtNum(r.dryBu)}</span>
                            </div>
                            <label className="text-xs text-slate-500 flex flex-col gap-1">
                              Irrigated bushels
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={breakoutIrr}
                                onChange={(e) => onBreakoutIrr(e.target.value, r.dryBu)}
                                className={`${inputCls} w-40`}
                              />
                            </label>
                            <label className="text-xs text-slate-500 flex flex-col gap-1">
                              Dryland bushels
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={breakoutDry}
                                onChange={(e) => onBreakoutDry(e.target.value, r.dryBu)}
                                className={`${inputCls} w-40`}
                              />
                            </label>
                            <button
                              type="button"
                              disabled={breakoutSaving || !breakoutSumValid(r.dryBu)}
                              onClick={() => saveBreakout(p, r.dryBu)}
                              className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
                            >Save</button>
                            <button
                              type="button"
                              onClick={() => { setBreakoutId(null); setBreakoutErr(null) }}
                              className="text-slate-500 text-sm"
                            >Cancel</button>
                            {p.yield_breakout_entered && (
                              <button
                                type="button"
                                onClick={() => clearBreakout(p)}
                                className="text-red-600 text-sm ml-auto"
                              >Clear breakout</button>
                            )}
                          </div>
                          {!breakoutSumValid(r.dryBu) && (breakoutIrr !== '' || breakoutDry !== '') && (
                            <p className="text-sm text-red-600 mt-2">
                              Irrigated + Dryland bushels must equal total bushels ({fmtNum(r.dryBu)})
                            </p>
                          )}
                          {breakoutErr && <p className="text-sm text-red-600 mt-2">{breakoutErr}</p>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
