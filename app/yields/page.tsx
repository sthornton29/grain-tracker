'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { buildDoubleCropSoySet, cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import YieldsByLandowner from '@/components/reports/yields-by-landowner'
import ExportBar from '@/components/export-bar'
import type { ExportColumn, ExportPayload } from '@/lib/exports'
import type { Crop, Entity, Farm, Field, FieldPlanting, FieldPlantingVariety, County, LoadSplit } from '@/lib/types'

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

type ViewMode = 'field' | 'farm' | 'variety' | 'landowner'
type YieldView = 'total' | 'breakdown'
type PracticeFilter = 'all' | 'irrigated' | 'dryland'

const currentYear = () => new Date().getFullYear()

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
  const [varieties, setVarieties] = useState<FieldPlantingVariety[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [loading, setLoading] = useState(true)

  // Filters persist in localStorage so the user returns to the same view and
  // filter set they last used (see usePersistentState).
  const [view, setView] = usePersistentState<ViewMode>('yields:view', 'field')
  const [year, setYear] = usePersistentState<number | ''>('yields:year', currentYear())
  const [cropId, setCropId] = usePersistentState('yields:cropId', '')
  const [farmId, setFarmId] = usePersistentState('yields:farmId', '')
  const [entityId, setEntityId] = usePersistentState('yields:entityId', '')
  const [countyId, setCountyId] = usePersistentState('yields:countyId', '')
  const [cropYear, setCropYear] = usePersistentState<number | ''>('yields:cropYear', '')
  const [yieldView, setYieldView] = usePersistentState<YieldView>('yields:yieldView', 'total')
  const [practiceFilter, setPracticeFilter] = usePersistentState<PracticeFilter>('yields:practiceFilter', 'all')

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

  // Per-variety bushel allocation state. varAllocId is the planting whose
  // variety editor is open; varAllocBu maps each variety row id → typed bushels.
  const [varAllocId, setVarAllocId] = useState<string | null>(null)
  const [varAllocBu, setVarAllocBu] = useState<Record<string, string>>({})
  const [varAllocSaving, setVarAllocSaving] = useState(false)
  const [varAllocErr, setVarAllocErr] = useState<string | null>(null)

  // The landowner view renders <YieldsByLandowner />, which owns its own
  // filters and data, so it hands a fresh export-payload builder up through
  // onPayloadChange. Default to an empty payload until the first build lands.
  const [landownerBuild, setLandownerBuild] = useState<() => ExportPayload>(
    () => () => ({ title: 'Yields by Landowner', sections: [{ columns: [], rows: [] }] }),
  )
  // useCallback so the child's effect dep stays stable — an inline arrow would
  // change identity each render and loop the callback.
  const handleLandownerPayload = useCallback((fn: () => ExportPayload) => {
    setLandownerBuild(() => fn)
  }, [])

  async function refresh() {
    setLoading(true)
    const [en, fa, fi, cr, pl, lo, co, sp, vv] = await Promise.all([
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('loads').select('id, date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('load_splits').select('*'),
      supabase.from('field_planting_varieties').select('*').order('variety'),
    ])
    setEntities((en.data as Entity[]) || [])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setLoads((lo.data as LoadRow[]) || [])
    setSplits((sp.data as LoadSplit[]) || [])
    setCounties((co.data as County[]) || [])
    setVarieties((vv.data as FieldPlantingVariety[]) || [])
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

  const varietiesByPlanting = useMemo(() => {
    const m = new Map<string, FieldPlantingVariety[]>()
    for (const v of varieties) {
      const list = m.get(v.planting_id) ?? []
      list.push(v)
      m.set(v.planting_id, list)
    }
    return m
  }, [varieties])

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
    // plantings appear in both filters, since both halves have acres. The
    // filter is a by-field concept only — the farm rollup always sees every
    // practice so its irrigated/dryland breakdown is complete.
    if (view === 'field') {
      if (practiceFilter === 'irrigated' && !(Number(p.irrigated_acres) > 0)) return false
      if (practiceFilter === 'dryland' && !(Number(p.dryland_acres) > 0)) return false
    }
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

  // Farm view has no practice filter, so its breakdown is driven purely by the
  // toggle: total only, or irrigated + dryland + total side by side.
  const farmShowBreakdown = yieldView === 'breakdown'

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
    // Irrigated/dryland breakdown, rolled up from the same per-planting rules
    // rowFor() uses. Only the determinable portion contributes: pure-irr and
    // pure-dry plantings, plus mixed plantings that have an entered breakout.
    // A mixed planting with no breakout adds to acres/dryBu (the totals) but
    // not to either side, exactly as it shows "—" in the by-field view.
    irrAc: number
    dryAc: number
    irrBu: number
    dryBuLand: number
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
      const irrAcP = Number(p.irrigated_acres) || 0
      const dryAcP = Number(p.dryland_acres) || 0

      // Per-side contributions for this planting.
      let irrBu = 0, irrAc = 0, dryBuLand = 0, dryAc = 0
      const practice = practiceOf(p)
      if (practice === 'pure-irr') {
        irrBu = dryBu; irrAc = irrAcP
      } else if (practice === 'pure-dry') {
        dryBuLand = dryBu; dryAc = dryAcP
      } else if (p.yield_breakout_entered) {
        if (p.irrigated_bushels != null) { irrBu = Number(p.irrigated_bushels); irrAc = irrAcP }
        if (p.dryland_bushels != null) { dryBuLand = Number(p.dryland_bushels); dryAc = dryAcP }
      }

      const key = `${farm?.id ?? '∅'}|${p.crop_id}|${p.season_year}`
      const existing = m.get(key)
      if (existing) {
        existing.acres += acres
        existing.dryBu += dryBu
        existing.irrAc += irrAc
        existing.dryAc += dryAc
        existing.irrBu += irrBu
        existing.dryBuLand += dryBuLand
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
          irrAc,
          dryAc,
          irrBu,
          dryBuLand,
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

  // Farm-level yields from the rolled-up bushels and acres. Each side divides
  // its own bushels by its own determinable acres; null when no acres on a side.
  function farmYields(r: FarmAgg) {
    return {
      total: r.acres > 0 ? r.dryBu / r.acres : null,
      irrigated: r.irrAc > 0 ? r.irrBu / r.irrAc : null,
      dryland: r.dryAc > 0 ? r.dryBuLand / r.dryAc : null,
    }
  }

  type VarietyAgg = {
    cropName: string
    variety: string
    seasonYear: number
    acres: number
    dryBu: number
    plantings: number
  }

  // Variety aggregation:
  //   - 0 varieties on a planting: excluded (no way to attribute the bushels)
  //   - 1 variety: all of the planting's dry bushels go to that variety; acres
  //     come from the variety row (falling back to planted_acres when the user
  //     left variety acres at 0)
  //   - 2+ varieties: ignored unless the user has manually allocated bushels
  //     to every variety row on that planting
  const varietyAgg = useMemo<VarietyAgg[]>(() => {
    const m = new Map<string, VarietyAgg>()
    const bump = (key: string, init: VarietyAgg) => {
      const existing = m.get(key)
      if (existing) {
        existing.acres += init.acres
        existing.dryBu += init.dryBu
        existing.plantings += 1
      } else {
        m.set(key, init)
      }
    }
    for (const p of visible) {
      const vs = varietiesByPlanting.get(p.id) ?? []
      if (vs.length === 0) continue
      const dryBu = dryBuByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`) ?? 0
      const cropName = cropById.get(p.crop_id)?.name ?? '—'
      const planted = Number(p.planted_acres) || 0
      if (vs.length === 1) {
        const v = vs[0]
        const acres = Number(v.acres) > 0 ? Number(v.acres) : planted
        bump(`${cropName}|${v.variety}|${p.season_year}`, {
          cropName, variety: v.variety, seasonYear: p.season_year, acres, dryBu, plantings: 1,
        })
      } else {
        const allAllocated = vs.every((v) => v.bushels != null)
        if (!allAllocated) continue
        for (const v of vs) {
          const bu = Number(v.bushels) || 0
          const acres = Number(v.acres) || 0
          bump(`${cropName}|${v.variety}|${p.season_year}`, {
            cropName, variety: v.variety, seasonYear: p.season_year, acres, dryBu: bu, plantings: 1,
          })
        }
      }
    }
    return [...m.values()].sort((a, b) => {
      if (b.seasonYear !== a.seasonYear) return b.seasonYear - a.seasonYear
      const cn = a.cropName.localeCompare(b.cropName)
      if (cn !== 0) return cn
      return a.variety.localeCompare(b.variety)
    })
  }, [visible, varietiesByPlanting, dryBuByKey, cropById])

  // Multi-variety plantings in the current filter. Surface all of them at the
  // top of the variety view: unallocated ones need attention, allocated ones
  // need to stay editable since the rollup table doesn't show per-planting.
  const multiVarietyPlantings = useMemo(() => {
    return visible.filter((p) => (varietiesByPlanting.get(p.id) ?? []).length >= 2)
  }, [visible, varietiesByPlanting])

  const unallocatedCount = useMemo(() => {
    return multiVarietyPlantings.filter((p) => {
      const vs = varietiesByPlanting.get(p.id) ?? []
      return !vs.every((v) => v.bushels != null)
    }).length
  }, [multiVarietyPlantings, varietiesByPlanting])

  // Filter summary shared by the field and farm exports — mirrors the filter
  // strip that drives both tables.
  function fieldFiltersLabel(): string {
    const parts: string[] = []
    parts.push(`Season: ${year === '' ? 'all' : year}`)
    parts.push(`Crop year: ${cropYear === '' ? 'all' : cropYear}`)
    if (cropId) parts.push(`Crop: ${cropById.get(cropId)?.name ?? '?'}`)
    if (farmId) parts.push(`Farm: ${farmById.get(farmId)?.name ?? '?'}`)
    if (entityId) parts.push(`Entity: ${entityById.get(entityId)?.name ?? '?'}`)
    if (countyId) {
      const c = counties.find((c) => c.id === countyId)
      parts.push(`County: ${c ? `${c.name}, ${c.state_code}` : '?'}`)
    }
    if (view === 'field' && practiceFilter !== 'all') parts.push(`Practice: ${practiceFilter}`)
    if (showYieldToggle && yieldView === 'breakdown') parts.push('Irrigated/Dryland breakdown')
    return parts.join(' · ')
  }

  // Both exports emit only the columns the current toggle/filter shows on
  // screen, so a "total only" export isn't padded with empty breakdown columns.
  function buildFieldPayload(): ExportPayload {
    const columns: ExportColumn[] = [
      { label: 'Field' },
      { label: 'Farm' },
      { label: 'FSA #' },
      { label: 'Crop' },
      { label: 'Year' },
      { label: 'Acres', align: 'right' },
    ]
    if (showIrrigatedCol) columns.push({ label: 'Irr ac', align: 'right' })
    if (showDrylandCol) columns.push({ label: 'Dry ac', align: 'right' })
    columns.push({ label: 'Dry bu', align: 'right' })
    if (showIrrigatedCol) columns.push({ label: 'Irrigated yield', align: 'right' })
    if (showDrylandCol) columns.push({ label: 'Dryland yield', align: 'right' })
    if (showTotalCol) columns.push({ label: 'Yield (bu/ac)', align: 'right' })
    columns.push({ label: 'Double-crop' })

    const rows = visible.map((p) => {
      const r = rowFor(p)
      // Mirror the on-screen fall-back: an irrigated/dryland-only filter shows
      // the total yield in its single column when no breakout exists.
      const irrY = r.irrigatedYield ?? (practiceFilter === 'irrigated' ? r.totalYield : null)
      const dryY = r.drylandYield ?? (practiceFilter === 'dryland' ? r.totalYield : null)
      const cells: (string | number)[] = [
        r.fld?.name_or_number ?? '',
        r.farm?.name ?? '',
        r.farm?.fsa_number ?? '',
        r.crop?.name ?? '',
        p.season_year,
        r.acres.toFixed(2),
      ]
      if (showIrrigatedCol) cells.push(r.irrAc.toFixed(2))
      if (showDrylandCol) cells.push(r.dryAc.toFixed(2))
      cells.push(r.dryBu.toFixed(2))
      if (showIrrigatedCol) cells.push(irrY != null ? irrY.toFixed(2) : '')
      if (showDrylandCol) cells.push(dryY != null ? dryY.toFixed(2) : '')
      if (showTotalCol) cells.push(r.totalYield != null ? r.totalYield.toFixed(2) : '')
      cells.push(doubleCropSoyIds.has(p.id) ? 'yes' : '')
      return cells
    })
    return { title: 'Yields by Field', filters: fieldFiltersLabel(), sections: [{ columns, rows }] }
  }

  function buildFarmPayload(): ExportPayload {
    const columns: ExportColumn[] = [
      { label: 'Farm' },
      { label: 'FSA #' },
      { label: 'Entity' },
      { label: 'Crop' },
      { label: 'Year' },
      { label: 'Acres', align: 'right' },
    ]
    if (farmShowBreakdown) {
      columns.push({ label: 'Irr ac', align: 'right' }, { label: 'Dry ac', align: 'right' })
    }
    columns.push({ label: 'Dry bu', align: 'right' })
    if (farmShowBreakdown) {
      columns.push({ label: 'Irrigated yield', align: 'right' }, { label: 'Dryland yield', align: 'right' })
    }
    columns.push({ label: 'Yield (bu/ac)', align: 'right' })

    const rows = byFarm.map((r) => {
      const y = farmYields(r)
      const cells: (string | number)[] = [
        r.farmName,
        r.fsaNumber ?? '',
        r.entityName,
        r.cropName,
        r.seasonYear,
        r.acres.toFixed(2),
      ]
      if (farmShowBreakdown) {
        cells.push(r.irrAc > 0 ? r.irrAc.toFixed(2) : '', r.dryAc > 0 ? r.dryAc.toFixed(2) : '')
      }
      cells.push(r.dryBu.toFixed(2))
      if (farmShowBreakdown) {
        cells.push(y.irrigated != null ? y.irrigated.toFixed(2) : '', y.dryland != null ? y.dryland.toFixed(2) : '')
      }
      cells.push(y.total != null ? y.total.toFixed(2) : '')
      return cells
    })
    return { title: 'Yields by Farm', filters: fieldFiltersLabel(), sections: [{ columns, rows }] }
  }

  function buildVarietyPayload(): ExportPayload {
    const columns: ExportColumn[] = [
      { label: 'Crop' },
      { label: 'Variety' },
      { label: 'Year' },
      { label: 'Plantings', align: 'right' },
      { label: 'Acres', align: 'right' },
      { label: 'Dry bu', align: 'right' },
      { label: 'Yield (bu/ac)', align: 'right' },
    ]
    const rows = varietyAgg.map((r) => {
      const yld = r.acres > 0 ? r.dryBu / r.acres : null
      return [
        r.cropName,
        r.variety,
        r.seasonYear,
        r.plantings,
        r.acres.toFixed(2),
        r.dryBu.toFixed(2),
        yld != null ? yld.toFixed(2) : '',
      ]
    })
    return { title: 'Yields by Variety', filters: fieldFiltersLabel(), sections: [{ columns, rows }] }
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

  function openVarAlloc(p: FieldPlanting) {
    const vs = varietiesByPlanting.get(p.id) ?? []
    const seed: Record<string, string> = {}
    for (const v of vs) seed[v.id] = v.bushels != null ? String(Number(v.bushels)) : ''
    setVarAllocId(p.id)
    setVarAllocBu(seed)
    setVarAllocErr(null)
  }

  function varAllocSum(vs: FieldPlantingVariety[]): number {
    return vs.reduce((s, v) => s + (Number(varAllocBu[v.id] ?? 0) || 0), 0)
  }

  function varAllocValid(vs: FieldPlantingVariety[], totalDryBu: number): boolean {
    if (vs.some((v) => (varAllocBu[v.id] ?? '') === '')) return false
    return Math.abs(varAllocSum(vs) - totalDryBu) < 0.01
  }

  async function saveVarAlloc(p: FieldPlanting, totalDryBu: number) {
    const vs = varietiesByPlanting.get(p.id) ?? []
    if (!varAllocValid(vs, totalDryBu)) return
    setVarAllocSaving(true)
    const updates = vs.map((v) =>
      supabase
        .from('field_planting_varieties')
        .update({ bushels: Number(varAllocBu[v.id] ?? 0) })
        .eq('id', v.id),
    )
    const results = await Promise.all(updates)
    setVarAllocSaving(false)
    const firstErr = results.find((r) => r.error)?.error
    if (firstErr) { setVarAllocErr(firstErr.message); return }
    setVarAllocId(null)
    refresh()
  }

  async function clearVarAlloc(p: FieldPlanting) {
    if (!confirm('Clear the variety bushel allocation for this planting?')) return
    const vs = varietiesByPlanting.get(p.id) ?? []
    setVarAllocSaving(true)
    const updates = vs.map((v) =>
      supabase
        .from('field_planting_varieties')
        .update({ bushels: null })
        .eq('id', v.id),
    )
    const results = await Promise.all(updates)
    setVarAllocSaving(false)
    const firstErr = results.find((r) => r.error)?.error
    if (firstErr) { setVarAllocErr(firstErr.message); return }
    setVarAllocId(null)
    refresh()
  }

  // Column count for table colspan calculations. Irr ac / Dry ac follow the
  // same visibility rules as the irrigated/dryland yield columns, so the table
  // collapses to just total acres + total yield in the default "Total yield
  // only" view.
  const visibleYieldCols = [showIrrigatedCol, showDrylandCol, showTotalCol].filter(Boolean).length
  const visibleAcresBreakoutCols = [showIrrigatedCol, showDrylandCol].filter(Boolean).length
  const fieldColCount = 4 /* Field/Farm/Crop/Year */ + 1 /* Acres */
    + visibleAcresBreakoutCols + 1 /* Dry bu */ + visibleYieldCols + 1 /* actions */
  // Farm: Farm/FSA#/Entity/Crop/Year/Acres/Dry bu/Yield = 8, plus 4 in breakdown
  // (Irr ac, Dry ac, Irrigated yield, Dryland yield).
  const farmColCount = 8 + (farmShowBreakdown ? 4 : 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-bold flex-1">
          Yields {
            view === 'field'   ? 'by Field' :
            view === 'farm'    ? 'by Farm' :
            view === 'variety' ? 'by Variety' :
            'by Landowner'
          }
        </h1>
        <label className="text-sm flex items-center gap-2 no-print">
          View
          <select value={view} onChange={(e) => setView(e.target.value as ViewMode)} className={inputCls}>
            <option value="field">By field</option>
            <option value="farm">By farm</option>
            <option value="variety">By variety</option>
            <option value="landowner">By landowner</option>
          </select>
        </label>
        <ExportBar
          buildPayload={() =>
            view === 'landowner'
              ? landownerBuild()
              : view === 'farm'
                ? buildFarmPayload()
                : view === 'variety'
                  ? buildVarietyPayload()
                  : buildFieldPayload()
          }
        />
      </div>
      {view !== 'landowner' && (
        <p className="text-sm text-slate-500">
          {view === 'field'
            ? 'Dry bushels harvested ÷ planted acres, matched to plantings by field + crop + load year.'
            : view === 'farm'
              ? 'Plantings rolled up to farm × crop × season. Dry bushels divided by planted acres.'
              : 'Bushels rolled up by crop × variety × season. Single-variety plantings are attributed automatically; multi-variety plantings only count once you allocate bushels to each variety.'}
        </p>
      )}

      {/* The outer filter strip drives the field- and farm-view tables. The
          landowner view has its own filter set inside <YieldsByLandowner /> so
          this row is hidden when that tab is active (otherwise the user would
          see two filter rows and only the inner one would actually apply). */}
      {view !== 'landowner' && (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 no-print">
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

      {view !== 'landowner' && view !== 'variety' && (view === 'field' || showYieldToggle) && (
        <div className="flex flex-wrap gap-3 items-center no-print">
          {view === 'field' && (
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
          )}
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
        <YieldsByLandowner onPayloadChange={handleLandownerPayload} />
      ) : view === 'variety' ? (
        <div className="space-y-4">
          {multiVarietyPlantings.length > 0 && (
            <div className="overflow-x-auto bg-white border border-slate-200 rounded-xl shadow">
              <div className="px-3 py-2 text-sm border-b border-slate-200 flex flex-wrap items-center gap-2">
                <span className="font-semibold">Multi-variety plantings ({multiVarietyPlantings.length})</span>
                {unallocatedCount > 0 && (
                  <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">
                    {unallocatedCount} need allocation
                  </span>
                )}
              </div>
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-700">
                  <tr>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Field</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Farm</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Crop</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Total dry bu</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Varieties</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {multiVarietyPlantings.map((p) => {
                    const r = rowFor(p)
                    const vs = varietiesByPlanting.get(p.id) ?? []
                    const allocated = vs.every((v) => v.bushels != null)
                    const isOpen = varAllocId === p.id
                    return (
                      <Fragment key={p.id}>
                        <tr className="border-t border-slate-100">
                          <td className="px-3 py-2">{r.fld?.name_or_number ?? '—'}</td>
                          <td className="px-3 py-2">{r.farm?.name ?? ''}</td>
                          <td className="px-3 py-2">{r.crop?.name ?? '—'}</td>
                          <td className="px-3 py-2">{p.season_year}</td>
                          <td className="px-3 py-2 text-right">{fmtNum(r.dryBu)}</td>
                          <td className="px-3 py-2 text-slate-600">
                            {vs.map((v) => {
                              const acres = Number(v.acres)
                              const bu = v.bushels != null ? Number(v.bushels) : null
                              const parts: string[] = []
                              if (acres > 0) parts.push(`${acres} ac`)
                              if (bu != null) parts.push(`${fmtNum(bu)} bu`)
                              const tail = parts.length > 0 ? ` (${parts.join(', ')})` : ''
                              return `${v.variety}${tail}`
                            }).join(', ')}
                          </td>
                          <td className="px-3 py-2 no-print whitespace-nowrap">
                            {!allocated && (
                              <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 mr-2">
                                Needs allocation
                              </span>
                            )}
                            {!isOpen && (
                              <button
                                type="button"
                                onClick={() => openVarAlloc(p)}
                                className="text-sky-700 text-sm whitespace-nowrap"
                              >{allocated ? 'Edit allocation' : 'Allocate bushels'}</button>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-sky-50 no-print">
                            <td colSpan={7} className="px-3 py-3">
                              <div className="space-y-2">
                                <div className="text-sm text-slate-600">
                                  Total dry bushels: <span className="font-semibold">{fmtNum(r.dryBu)}</span> · enter how many of those came from each variety
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  {vs.map((v) => (
                                    <label key={v.id} className="text-xs text-slate-500 flex items-center gap-2">
                                      <span className="min-w-32">{v.variety}{Number(v.acres) > 0 ? ` (${Number(v.acres)} ac)` : ''}</span>
                                      <input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        value={varAllocBu[v.id] ?? ''}
                                        onChange={(e) => setVarAllocBu({ ...varAllocBu, [v.id]: e.target.value })}
                                        className={`${inputCls} w-40`}
                                        placeholder="bushels"
                                      />
                                    </label>
                                  ))}
                                </div>
                                <div className="flex flex-wrap items-center gap-3">
                                  <div className="text-sm text-slate-600">
                                    Sum: <span className="font-semibold">{fmtNum(varAllocSum(vs))}</span> / {fmtNum(r.dryBu)}
                                  </div>
                                  <button
                                    type="button"
                                    disabled={varAllocSaving || !varAllocValid(vs, r.dryBu)}
                                    onClick={() => saveVarAlloc(p, r.dryBu)}
                                    className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
                                  >Save</button>
                                  <button
                                    type="button"
                                    onClick={() => { setVarAllocId(null); setVarAllocErr(null) }}
                                    className="text-slate-500 text-sm"
                                  >Cancel</button>
                                  {vs.some((v) => v.bushels != null) && (
                                    <button
                                      type="button"
                                      onClick={() => clearVarAlloc(p)}
                                      className="text-red-600 text-sm ml-auto"
                                    >Clear allocation</button>
                                  )}
                                </div>
                                {!varAllocValid(vs, r.dryBu) && (
                                  <p className="text-sm text-red-600">
                                    Variety bushels must each be filled in and sum to {fmtNum(r.dryBu)}
                                  </p>
                                )}
                                {varAllocErr && <p className="text-sm text-red-600">{varAllocErr}</p>}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="overflow-x-auto bg-white rounded-xl shadow">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  <th className="text-left px-3 py-2 whitespace-nowrap">Crop</th>
                  <th className="text-left px-3 py-2 whitespace-nowrap">Variety</th>
                  <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Plantings</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Acres</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Yield (bu/ac)</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
                {!loading && varietyAgg.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                    No varieties recorded for these filters. Add varieties on the Plantings page, or allocate bushels on any multi-variety plantings above.
                  </td></tr>
                )}
                {varietyAgg.map((r, i) => {
                  const yld = r.acres > 0 ? r.dryBu / r.acres : null
                  return (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-2">{r.cropName}</td>
                      <td className="px-3 py-2 font-semibold">{r.variety}</td>
                      <td className="px-3 py-2">{r.seasonYear}</td>
                      <td className="px-3 py-2 text-right">{r.plantings}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.acres)}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.dryBu)}</td>
                      <td className="px-3 py-2 text-right font-semibold">{yld != null ? yld.toFixed(1) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : view === 'field' ? (
        <div className="overflow-x-auto bg-white rounded-xl shadow">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="text-left px-3 py-2 whitespace-nowrap">Field</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Farm</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Crop</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Acres</th>
                {showIrrigatedCol && <th className="text-right px-3 py-2 whitespace-nowrap">Irr ac</th>}
                {showDrylandCol   && <th className="text-right px-3 py-2 whitespace-nowrap">Dry ac</th>}
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
                      <td className="px-3 py-2">{r.crop?.name ?? '—'}</td>
                      <td className="px-3 py-2">{p.season_year}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.acres)}</td>
                      {showIrrigatedCol && (
                        <td className="px-3 py-2 text-right">{r.irrAc > 0 ? fmtNum(r.irrAc) : '—'}</td>
                      )}
                      {showDrylandCol && (
                        <td className="px-3 py-2 text-right">{r.dryAc > 0 ? fmtNum(r.dryAc) : '—'}</td>
                      )}
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
                            className="text-sky-700 text-sm whitespace-nowrap no-print"
                          >
                            {p.yield_breakout_entered ? 'Edit breakout' : 'Allocate irr/dry'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isBreakoutOpen && (
                      <tr className="bg-sky-50 no-print">
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
                <th className="text-left px-3 py-2 whitespace-nowrap">Farm</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">FSA#</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Entity</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Crop</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Acres</th>
                {farmShowBreakdown && <th className="text-right px-3 py-2 whitespace-nowrap">Irr ac</th>}
                {farmShowBreakdown && <th className="text-right px-3 py-2 whitespace-nowrap">Dry ac</th>}
                <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
                {farmShowBreakdown && <th className="text-right px-3 py-2 whitespace-nowrap">Irrigated yield</th>}
                {farmShowBreakdown && <th className="text-right px-3 py-2 whitespace-nowrap">Dryland yield</th>}
                <th className="text-right px-3 py-2 whitespace-nowrap">Yield (bu/ac)</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={farmColCount} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
              {!loading && byFarm.length === 0 && (
                <tr><td colSpan={farmColCount} className="px-3 py-6 text-center text-slate-400">No plantings match these filters.</td></tr>
              )}
              {byFarm.map((r, i) => {
                const y = farmYields(r)
                return (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-semibold">{r.farmName}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.fsaNumber ?? ''}</td>
                    <td className="px-3 py-2">{r.entityName}</td>
                    <td className="px-3 py-2">{r.cropName}</td>
                    <td className="px-3 py-2">{r.seasonYear}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.acres)}</td>
                    {farmShowBreakdown && <td className="px-3 py-2 text-right">{r.irrAc > 0 ? fmtNum(r.irrAc) : '—'}</td>}
                    {farmShowBreakdown && <td className="px-3 py-2 text-right">{r.dryAc > 0 ? fmtNum(r.dryAc) : '—'}</td>}
                    <td className="px-3 py-2 text-right">{fmtNum(r.dryBu)}</td>
                    {farmShowBreakdown && (
                      <td className="px-3 py-2 text-right font-semibold">{y.irrigated != null ? y.irrigated.toFixed(1) : '—'}</td>
                    )}
                    {farmShowBreakdown && (
                      <td className="px-3 py-2 text-right font-semibold">{y.dryland != null ? y.dryland.toFixed(1) : '—'}</td>
                    )}
                    <td className="px-3 py-2 text-right font-semibold">
                      {y.total != null ? y.total.toFixed(1) : '—'}
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
