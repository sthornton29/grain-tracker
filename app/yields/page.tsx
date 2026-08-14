'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import CottonYieldsSection from '@/components/reports/cotton-yields-section'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { roleCanEditYields } from '@/lib/app-role'
import { roleAllowsPath } from '@/lib/route-guard'
import { fieldCropAggregates, analyzeYields, isHarvestComplete, groupYieldAggregates, practiceOf, resolvePracticeBreakout, type HarvestProgress, type GroupYieldAgg, type GroupYieldPlanting, type PracticeBreakout } from '@/lib/yields'
import { isCottonCrop } from '@/lib/marketing'
import YieldsByLandowner from '@/components/reports/yields-by-landowner'
import AvgYieldHeader from '@/components/reports/avg-yield-header'
import ExportBar from '@/components/export-bar'
import {
  YieldRowDetail, useCottonDetailData, buildDetailForPlantings, cottonDetailsByYear,
  grainDetailExportSection, cottonDetailExportSection,
} from '@/components/yields-detail'
import type { ExportColumn, ExportPayload, ExportSection } from '@/lib/exports'
import type { CombineYieldEntry, Crop, CropAssumption, Entity, Farm, Field, FieldPlanting, FieldPlantingVariety, County, LoadSplit } from '@/lib/types'

// Carries everything the drill-down needs (lib/yield-detail's DetailLoadLike)
// on top of what the yield math uses — one fetch serves both.
type LoadRow = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  test_weight: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
  to_type: string | null
  to_bin_id: string | null
  to_buyer_id: string | null
  truck_id: string | null
  hauler_truck: string | null
  ticket_number: string | null
  practice: 'irrigated' | 'dryland' | null
}

type ViewMode = 'field' | 'farm' | 'entity' | 'variety' | 'landowner'
type YieldView = 'total' | 'breakdown'
type PracticeFilter = 'all' | 'irrigated' | 'dryland'

const currentYear = () => new Date().getFullYear()

function fmtNum(n: number, d = 2) {
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

export default function YieldsPage() {
  const supabase = useMemo(() => createClient(), [])
  // Viewer role (052): RLS already limits farms/fields/loads/splits to the
  // granted entities server-side; here we prune the entity dropdown, name the
  // grants on exports, and hide the edit affordances (writes are RLS-blocked
  // anyway — no point offering buttons that would only error).
  // Agronomist role (061): org-wide read-only — all entities and tabs, but the
  // same hidden edit affordances, and load links render as plain text because
  // /loads is outside the role's route allowlist.
  const viewer = useViewerScope(supabase)
  const canEdit = roleCanEditYields(viewer.role)
  const allowLoadLinks = roleAllowsPath(viewer.role, '/loads')
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [varieties, setVarieties] = useState<FieldPlantingVariety[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [counties, setCounties] = useState<County[]>([])
  // Light name lookups (id + name only) for the drill-down's load list.
  const [trucks, setTrucks] = useState<Array<{ id: string; name_or_number: string }>>([])
  const [bins, setBins] = useState<Array<{ id: string; name_or_number: string }>>([])
  const [buyers, setBuyers] = useState<Array<{ id: string; name: string }>>([])
  const [combineEntries, setCombineEntries] = useState<CombineYieldEntry[]>([])
  const [loading, setLoading] = useState(true)

  // Filters persist in localStorage so the user returns to the same view and
  // filter set they last used (see usePersistentState).
  const [view, setView] = usePersistentState<ViewMode>('yields:view', 'field')
  const [year, setYear] = usePersistentState<number | ''>('yields:year', currentYear())
  const [cropId, setCropId] = usePersistentState('yields:cropId', '')
  const [farmId, setFarmId] = usePersistentState('yields:farmId', '')
  const [entityId, setEntityId] = usePersistentState('yields:entityId', '')
  const [countyId, setCountyId] = usePersistentState('yields:countyId', '')
  // yieldView intentionally does NOT persist: it defaults to total every visit
  // and is only flipped to breakdown when arriving from the crop-insurance
  // report to enter irrigated/dryland breakouts (see the ?breakout=1 effect).
  const [yieldView, setYieldView] = useState<YieldView>('total')
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

  // Manual override of a field's harvest classification (count anyway / reset).
  const [overrideErr, setOverrideErr] = useState<string | null>(null)
  const [overrideSavingId, setOverrideSavingId] = useState<string | null>(null)

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
    const [en, fa, fi, cr, pl, lo, co, sp, vv, ca, tr, bi, bu, ce] = await Promise.all([
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('loads').select('id, date, net_weight, moisture, test_weight, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, to_type, to_bin_id, to_buyer_id, truck_id, hauler_truck, ticket_number, practice'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('load_splits').select('*'),
      supabase.from('field_planting_varieties').select('*').order('variety'),
      supabase.from('crop_assumptions').select('*'),
      supabase.from('trucks').select('id, name_or_number').order('name_or_number'),
      supabase.from('bins').select('id, name_or_number').order('name_or_number'),
      supabase.from('buyers').select('id, name').order('name'),
      // Combine yield entries (062) — tolerate the table not existing yet
      // (migration pending): error → no entries, the page still works.
      supabase.from('combine_yield_entries').select('*'),
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
    setAssumptions((ca.data as CropAssumption[]) || [])
    setTrucks((tr.data as Array<{ id: string; name_or_number: string }>) || [])
    setBins((bi.data as Array<{ id: string; name_or_number: string }>) || [])
    setBuyers((bu.data as Array<{ id: string; name: string }>) || [])
    setCombineEntries((ce.data as CombineYieldEntry[]) || [])
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  // Arriving from the crop-insurance report (?breakout=1): jump to the by-field
  // view with the irrigated/dryland breakdown on, so the user can enter the
  // breakouts. Strip the param afterward so the toggle doesn't stick on refresh
  // or persist to later visits.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('breakout') !== '1') return
    setView('field')
    setYieldView('breakdown')
    params.delete('breakout')
    const qs = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const farmById  = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const cropById  = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])

  // ---- Drill-down detail --------------------------------------------------
  // One open detail at a time, keyed per view; any view or filter change
  // closes it (the row it pointed at may no longer exist).
  const [openDetail, setOpenDetail] = useState<{ view: ViewMode; key: string } | null>(null)
  useEffect(() => { setOpenDetail(null) }, [view, year, cropId, farmId, entityId, countyId, practiceFilter])
  // Cotton sources load lazily the first time a cotton row's detail opens.
  const cottonDetail = useCottonDetailData(supabase)
  function toggleDetail(v: ViewMode, key: string, rowCropName: string) {
    const isOpen = openDetail?.view === v && openDetail.key === key
    setOpenDetail(isOpen ? null : { view: v, key })
    if (!isOpen && isCottonCrop(rowCropName)) cottonDetail.ensure()
  }
  // Ignore clicks that land on a row's own controls (buttons/links).
  const rowClickIsOnControl = (e: { target: EventTarget | null }) =>
    e.target instanceof Element && e.target.closest('button, a') != null
  const detailLookups = useMemo(() => ({
    fieldNameById: new Map(fields.map((f) => [f.id, f.name_or_number])),
    truckNameById: new Map(trucks.map((t) => [t.id, t.name_or_number])),
    binNameById: new Map(bins.map((b) => [b.id, b.name_or_number])),
    buyerNameById: new Map(buyers.map((b) => [b.id, b.name])),
  }), [fields, trucks, bins, buyers])

  const varietiesByPlanting = useMemo(() => {
    const m = new Map<string, FieldPlantingVariety[]>()
    for (const v of varieties) {
      const list = m.get(v.planting_id) ?? []
      list.push(v)
      m.set(v.planting_id, list)
    }
    return m
  }, [varieties])

  // Dry bushels + most-recent load date per field+crop+year (shared allocation
  // rules). dryBuFor() is the bushel lookup; aggByKey also carries the load
  // dates the yield analysis needs. Combine entries (062) make the combine
  // authoritative for their field × crop × year, netting weighed loads.
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { combineEntries }),
    [loads, splits, cropById, combineEntries],
  )
  const dryBuFor = (fieldId: string, cropId: string, year: number) =>
    aggByKey.get(`${fieldId}|${cropId}|${year}`)?.dryBu ?? 0

  // Effective irrigated/dryland breakout for a mixed planting, whichever path
  // produced it: the manual post-harvest allocation (always wins) or fully
  // practice-tagged loads. Every per-practice consumer on this page reads
  // through this so the two paths never fork.
  const breakoutFor = (p: FieldPlanting): PracticeBreakout =>
    resolvePracticeBreakout(p, aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`))

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

  // Viewer grants as a set — belt-and-suspenders on top of the 052 RLS row
  // filters: even if a fetch somehow returns beyond-grant rows, they never
  // render. Null for owners (no restriction).
  const viewerGranted = viewer.isViewer ? new Set(viewer.grantedIds ?? []) : null

  const visible = plantings.filter((p) => {
    if (year !== '' && p.season_year !== year) return false
    if (cropId && p.crop_id !== cropId) return false
    const fld = fieldById.get(p.field_id)
    if (!fld) return false
    if (farmId && fld.farm_id !== farmId) return false
    const farm = fld.farm_id ? farmById.get(fld.farm_id) : null
    if (viewerGranted && (!farm || farm.entity_id == null || !viewerGranted.has(farm.entity_id))) return false
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

  // Drop unharvested and in-progress fields from the yield numbers (per crop,
  // over the currently-filtered plantings). The by-field table still shows them,
  // flagged; every rollup, average, and export uses `includedPlantings`.
  const yieldAnalysis = useMemo(() => analyzeYields(
    visible.map((p) => {
      const agg = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
      return {
        id: p.id,
        cropId: p.crop_id,
        acres: Number(p.planted_acres),
        dryBu: agg?.dryBu ?? 0,
        lastLoadDate: agg?.lastLoadDate ?? null,
        override: p.yield_include_override,
        combineComplete: agg?.combine?.harvestComplete,
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [plantings, aggByKey, fieldById, farmById, year, cropId, farmId, entityId, countyId, view, practiceFilter, viewer.isViewer, viewer.grantedIds])
  const excludedFields = yieldAnalysis.excluded
  const includedPlantings = visible.filter((p) => !excludedFields.has(p.id))

  // Summary cards only for crops with harvest activity — a crop with nothing
  // done and nothing in progress (e.g. fall crops in June) is just a row of 0%
  // cards, so it's dropped until its first loads come in.
  const activeProgress = useMemo(() => {
    const m = new Map<string, HarvestProgress>()
    for (const [id, pr] of yieldAnalysis.progress) {
      if (pr.completedAcres > 0 || pr.inProgressAcres > 0) m.set(id, pr)
    }
    return m
  }, [yieldAnalysis])

  // Crop+year combos the user has marked harvest-complete at the crop level
  // (Marketing assumptions). These force every field of that crop to "complete".
  const cropCompleteKeys = useMemo(() => {
    const s = new Set<string>()
    for (const a of assumptions) if (a.harvest_complete) s.add(`${a.crop_id}|${a.crop_year}`)
    return s
  }, [assumptions])
  // Bushel allocation (irr/dry breakout, per-variety) is only offered once a
  // field's harvest is complete — not while it's unharvested or in progress.
  const fieldComplete = (p: FieldPlanting) => isHarvestComplete(p, excludedFields, cropCompleteKeys)
  // Completion rank, now used only as a tiebreaker: completed (counted) before
  // in-progress before unharvested.
  const fieldRank = (id: string) => {
    const reason = excludedFields.get(id)
    if (!reason) return 0
    return reason === 'in_progress' ? 1 : 2
  }
  // By-field row order: most recently harvested first (by the latest load date
  // for that field+crop), with not-yet-harvested fields last. Same-date ties
  // fall back to completion rank, then stable original order.
  const lastLoadOf = (p: FieldPlanting) =>
    aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)?.lastLoadDate ?? null
  const fieldRows = [...visible].sort((a, b) => {
    const da = lastLoadOf(a)
    const db = lastLoadOf(b)
    if (da !== db) {
      if (da == null) return 1
      if (db == null) return -1
      return db < da ? -1 : 1
    }
    return fieldRank(a.id) - fieldRank(b.id)
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
    const dryBu = dryBuFor(p.field_id, p.crop_id, p.season_year)
    const acres = Number(p.planted_acres)
    const irrAc = Number(p.irrigated_acres) || 0
    const dryAc = Number(p.dryland_acres) || 0
    const totalYield = acres > 0 ? dryBu / acres : null
    const practice = practiceOf(p)
    // Practice-specific yields per the spec:
    //   pure-dry  -> dryland yield uses total dry bushels / dryland acres
    //   pure-irr  -> irrigated yield uses total dry bushels / irrigated acres
    //   mixed     -> the resolved breakout (manual allocation or fully
    //                practice-tagged loads) when present, else null
    let irrigatedYield: number | null = null
    let drylandYield: number | null = null
    if (practice === 'pure-dry') {
      drylandYield = dryAc > 0 ? dryBu / dryAc : null
    } else if (practice === 'pure-irr') {
      irrigatedYield = irrAc > 0 ? dryBu / irrAc : null
    } else {
      const b = breakoutFor(p)
      if (b.source != null) {
        if (b.irrigatedBushels != null && irrAc > 0) irrigatedYield = b.irrigatedBushels / irrAc
        if (b.drylandBushels != null && dryAc > 0) drylandYield = b.drylandBushels / dryAc
      }
    }
    return { fld, farm, ent, crop, dryBu, acres, irrAc, dryAc, totalYield, irrigatedYield, drylandYield, practice }
  }

  type FarmAgg = {
    farmId: string | null
    farmName: string
    fsaNumber: string | null
    entityName: string
    cropId: string
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
    for (const p of includedPlantings) {
      const fld = fieldById.get(p.field_id)
      const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
      const ent = farm?.entity_id ? entityById.get(farm.entity_id) : null
      const crop = cropById.get(p.crop_id)
      const dryBu = dryBuFor(p.field_id, p.crop_id, p.season_year)
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
      } else {
        const b = breakoutFor(p)
        if (b.source != null) {
          if (b.irrigatedBushels != null) { irrBu = b.irrigatedBushels; irrAc = irrAcP }
          if (b.drylandBushels != null) { dryBuLand = b.drylandBushels; dryAc = dryAcP }
        }
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
          cropId: p.crop_id,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includedPlantings, fieldById, farmById, entityById, cropById, aggByKey])

  // Farm-level yields from the rolled-up bushels and acres. Each side divides
  // its own bushels by its own determinable acres; null when no acres on a side.
  function farmYields(r: FarmAgg) {
    return {
      total: r.acres > 0 ? r.dryBu / r.acres : null,
      irrigated: r.irrAc > 0 ? r.irrBu / r.irrAc : null,
      dryland: r.dryAc > 0 ? r.dryBuLand / r.dryAc : null,
    }
  }

  const farmRowKey = (r: FarmAgg) => `${r.farmId ?? '∅'}|${r.cropId}|${r.seasonYear}`

  // Constituent plantings of a farm row — the SAME includedPlantings + grouping
  // rule byFarm was computed from, so the detail sums to the row exactly.
  function farmRowPlantings(r: FarmAgg): FieldPlanting[] {
    return includedPlantings.filter((p) => {
      if (p.crop_id !== r.cropId || p.season_year !== r.seasonYear) return false
      const fld = fieldById.get(p.field_id)
      const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
      return (farm?.id ?? null) === r.farmId
    })
  }

  // --- By Entity: roll the harvest-included plantings up to entity × crop ×
  //     season, across every farm that belongs to the entity. Same exclusion and
  //     irrigated/dryland breakdown rules as By Farm (shared groupYieldAggregates).
  const entityShowBreakdown = farmShowBreakdown
  const byEntity = useMemo<GroupYieldAgg[]>(() => {
    const inputs: GroupYieldPlanting[] = includedPlantings.map((p) => {
      const fld = fieldById.get(p.field_id)
      const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
      const ent = farm?.entity_id ? entityById.get(farm.entity_id) : null
      // Feed the rollup the RESOLVED breakout (manual or load-derived) so the
      // entity view agrees with by-field/by-farm whichever path produced it.
      const b = breakoutFor(p)
      return {
        groupId: ent?.id ?? '∅',
        groupName: ent?.name ?? '— No entity —',
        cropId: p.crop_id,
        cropName: cropById.get(p.crop_id)?.name ?? '—',
        seasonYear: p.season_year,
        acres: Number(p.planted_acres),
        dryBu: dryBuFor(p.field_id, p.crop_id, p.season_year),
        irrigatedAcres: Number(p.irrigated_acres) || 0,
        drylandAcres: Number(p.dryland_acres) || 0,
        yieldBreakoutEntered: b.source != null,
        irrigatedBushels: b.irrigatedBushels,
        drylandBushels: b.drylandBushels,
      }
    })
    return groupYieldAggregates(inputs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includedPlantings, fieldById, farmById, entityById, cropById, aggByKey])

  // Group the per-entity×crop rows under each entity for the grouped display, and
  // only show entities that actually have production this period (drop empty
  // groupings — same spirit as the other tabs).
  type EntityGroup = { groupId: string; groupName: string; rows: GroupYieldAgg[]; acres: number; dryBu: number }
  const entityGroups = useMemo<EntityGroup[]>(() => {
    const m = new Map<string, EntityGroup>()
    for (const r of byEntity) {
      const g = m.get(r.groupId) ?? { groupId: r.groupId, groupName: r.groupName, rows: [], acres: 0, dryBu: 0 }
      g.rows.push(r); g.acres += r.acres; g.dryBu += r.dryBu
      m.set(r.groupId, g)
    }
    return [...m.values()].filter((g) => g.dryBu > 0).sort((a, b) => {
      if (a.groupId === '∅') return 1
      if (b.groupId === '∅') return -1
      return a.groupName.localeCompare(b.groupName)
    })
  }, [byEntity])
  // Hide the per-row Year column when every entity row is the same season.
  const showEntityYear = new Set(byEntity.map((r) => r.seasonYear)).size > 1

  const entityRowKey = (r: GroupYieldAgg) => `${r.groupId}|${r.cropId}|${r.seasonYear}`

  // Constituent plantings of an entity row — same source + grouping as byEntity.
  function entityRowPlantings(r: GroupYieldAgg): FieldPlanting[] {
    return includedPlantings.filter((p) => {
      if (p.crop_id !== r.cropId || p.season_year !== r.seasonYear) return false
      const fld = fieldById.get(p.field_id)
      const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
      const ent = farm?.entity_id ? entityById.get(farm.entity_id) : null
      return (ent?.id ?? '∅') === r.groupId
    })
  }

  // While a detail is open on the current view, the view's export gains one
  // extra section itemizing that row's loads (or, for cotton, its gin/bale
  // numbers). Returns null when nothing is open for the view.
  function openDetailExportSection(v: ViewMode): ExportSection | null {
    if (!openDetail || openDetail.view !== v) return null
    let label = ''
    let rowCropName = ''
    let yearLabel = ''
    let rowPlantings: FieldPlanting[] = []
    if (v === 'field') {
      const p = visible.find((x) => x.id === openDetail.key)
      if (!p) return null
      rowPlantings = [p]
      label = fieldById.get(p.field_id)?.name_or_number ?? '—'
      rowCropName = cropById.get(p.crop_id)?.name ?? '—'
      yearLabel = String(p.season_year)
    } else if (v === 'farm') {
      const r = byFarm.find((x) => farmRowKey(x) === openDetail.key)
      if (!r) return null
      rowPlantings = farmRowPlantings(r)
      label = r.farmName
      rowCropName = r.cropName
      yearLabel = String(r.seasonYear)
    } else if (v === 'entity') {
      const r = byEntity.find((x) => entityRowKey(x) === openDetail.key)
      if (!r) return null
      rowPlantings = entityRowPlantings(r)
      label = r.groupName
      rowCropName = r.cropName
      yearLabel = String(r.seasonYear)
    } else {
      return null
    }
    const title = `Load Detail — ${label} · ${rowCropName} · ${yearLabel}`
    if (isCottonCrop(rowCropName)) {
      if (!cottonDetail.data) return null
      const details = cottonDetailsByYear(rowPlantings, cottonDetail.data)
      return cottonDetailExportSection({ title, details, showYear: details.length > 1 })
    }
    const detail = buildDetailForPlantings({ plantings: rowPlantings, loads, splits, cropById, combineEntries })
    return grainDetailExportSection({ title, detailLoads: detail.loads, lookups: detailLookups, combineRows: detail.combineRows })
  }

  function buildEntityPayload(): ExportPayload {
    const columns: ExportColumn[] = [{ label: 'Crop' }]
    if (showEntityYear) columns.push({ label: 'Year', format: 'text' })
    columns.push({ label: 'Acres', align: 'right', format: 'acres' })
    if (entityShowBreakdown) columns.push({ label: 'Irr ac', align: 'right', format: 'acres' }, { label: 'Dry ac', align: 'right', format: 'acres' })
    columns.push({ label: 'Dry bu', align: 'right', format: 'bu' })
    if (entityShowBreakdown) columns.push({ label: 'Irrigated yield', align: 'right', format: 'yield' }, { label: 'Dryland yield', align: 'right', format: 'yield' })
    columns.push({ label: 'Yield (bu/ac)', align: 'right', format: 'yield' })

    const sections: ExportSection[] = entityGroups.map((g) => {
      const rows: Array<Array<string | number | null>> = []
      const rowMeta: ('data' | 'subhead' | 'total')[] = []
      for (const r of g.rows) {
        const cells: (string | number)[] = [r.cropName]
        if (showEntityYear) cells.push(r.seasonYear)
        cells.push(r.acres)
        if (entityShowBreakdown) cells.push(r.irrAc > 0 ? r.irrAc : '', r.dryAc > 0 ? r.dryAc : '')
        cells.push(r.dryBu)
        if (entityShowBreakdown) cells.push(r.irrigatedYield ?? '', r.drylandYield ?? '')
        cells.push(r.yield ?? '')
        rows.push(cells); rowMeta.push('data')
      }
      if (g.rows.length > 1) {
        const cells: (string | number)[] = [`${g.groupName} total`]
        if (showEntityYear) cells.push('')
        cells.push(g.acres)
        if (entityShowBreakdown) cells.push('', '')
        cells.push(g.dryBu)
        if (entityShowBreakdown) cells.push('', '')
        cells.push('')
        rows.push(cells); rowMeta.push('total')
      }
      return { title: `${g.groupName} — ${g.rows.length} crop${g.rows.length === 1 ? '' : 's'}`, columns, rows, rowMeta }
    })
    const detailSection = openDetailExportSection('entity')
    if (detailSection) sections.push(detailSection)
    return { title: 'Yields by Entity', filters: fieldFiltersLabel(), singleSheet: true, sections }
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
    for (const p of includedPlantings) {
      const vs = varietiesByPlanting.get(p.id) ?? []
      if (vs.length === 0) continue
      const dryBu = dryBuFor(p.field_id, p.crop_id, p.season_year)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includedPlantings, varietiesByPlanting, aggByKey, cropById])

  // Multi-variety plantings in the current filter — but only once their field's
  // harvest is COMPLETE. A still-harvesting field has no final bushels to
  // allocate, so listing it is noise; it appears here when it finishes. An
  // existing allocation always stays visible so saved data is never stranded.
  const multiVarietyPlantings = useMemo(() => {
    return visible.filter((p) => {
      const vs = varietiesByPlanting.get(p.id) ?? []
      if (vs.length < 2) return false
      const allocated = vs.every((v) => v.bushels != null)
      return allocated || fieldComplete(p)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, varietiesByPlanting, excludedFields, cropCompleteKeys])

  // Every listed-but-unallocated planting needs allocation (the list is already
  // restricted to harvest-complete fields).
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
    if (cropId) parts.push(`Crop: ${cropById.get(cropId)?.name ?? '?'}`)
    if (farmId) parts.push(`Farm: ${farmById.get(farmId)?.name ?? '?'}`)
    if (entityId) parts.push(`Entity: ${entityById.get(entityId)?.name ?? '?'}`)
    else {
      const granted = viewerAllEntitiesLabel(viewer, entities)
      if (granted) parts.push(`Entity: ${granted}`)
    }
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
      { label: 'Year', format: 'text' },
      { label: 'Acres', align: 'right', format: 'acres' },
    ]
    if (showIrrigatedCol) columns.push({ label: 'Irr ac', align: 'right', format: 'acres' })
    if (showDrylandCol) columns.push({ label: 'Dry ac', align: 'right', format: 'acres' })
    columns.push({ label: 'Dry bu', align: 'right', format: 'bu' })
    if (showIrrigatedCol) columns.push({ label: 'Irrigated yield', align: 'right', format: 'yield' })
    if (showDrylandCol) columns.push({ label: 'Dryland yield', align: 'right', format: 'yield' })
    if (showTotalCol) columns.push({ label: 'Yield (bu/ac)', align: 'right', format: 'yield' })

    const rows = includedPlantings.map((p) => {
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
        r.acres,
      ]
      if (showIrrigatedCol) cells.push(r.irrAc)
      if (showDrylandCol) cells.push(r.dryAc)
      cells.push(r.dryBu)
      if (showIrrigatedCol) cells.push(irrY ?? '')
      if (showDrylandCol) cells.push(dryY ?? '')
      if (showTotalCol) cells.push(r.totalYield ?? '')
      return cells
    })
    const sections: ExportSection[] = [{ columns, rows }]
    const detailSection = openDetailExportSection('field')
    if (detailSection) sections.push(detailSection)
    return { title: 'Yields by Field', filters: fieldFiltersLabel(), sections }
  }

  function buildFarmPayload(): ExportPayload {
    const columns: ExportColumn[] = [
      { label: 'Farm' },
      { label: 'FSA #' },
      { label: 'Entity' },
      { label: 'Crop' },
      { label: 'Year', format: 'text' },
      { label: 'Acres', align: 'right', format: 'acres' },
    ]
    if (farmShowBreakdown) {
      columns.push({ label: 'Irr ac', align: 'right', format: 'acres' }, { label: 'Dry ac', align: 'right', format: 'acres' })
    }
    columns.push({ label: 'Dry bu', align: 'right', format: 'bu' })
    if (farmShowBreakdown) {
      columns.push({ label: 'Irrigated yield', align: 'right', format: 'yield' }, { label: 'Dryland yield', align: 'right', format: 'yield' })
    }
    columns.push({ label: 'Yield (bu/ac)', align: 'right', format: 'yield' })

    const rows = byFarm.map((r) => {
      const y = farmYields(r)
      const cells: (string | number)[] = [
        r.farmName,
        r.fsaNumber ?? '',
        r.entityName,
        r.cropName,
        r.seasonYear,
        r.acres,
      ]
      if (farmShowBreakdown) {
        cells.push(r.irrAc > 0 ? r.irrAc : '', r.dryAc > 0 ? r.dryAc : '')
      }
      cells.push(r.dryBu)
      if (farmShowBreakdown) {
        cells.push(y.irrigated ?? '', y.dryland ?? '')
      }
      cells.push(y.total ?? '')
      return cells
    })
    const sections: ExportSection[] = [{ columns, rows }]
    const detailSection = openDetailExportSection('farm')
    if (detailSection) sections.push(detailSection)
    return { title: 'Yields by Farm', filters: fieldFiltersLabel(), sections }
  }

  function buildVarietyPayload(): ExportPayload {
    const columns: ExportColumn[] = [
      { label: 'Crop' },
      { label: 'Variety' },
      { label: 'Year', format: 'text' },
      { label: 'Plantings', align: 'right', format: 'int' },
      { label: 'Acres', align: 'right', format: 'acres' },
      { label: 'Dry bu', align: 'right', format: 'bu' },
      { label: 'Yield (bu/ac)', align: 'right', format: 'yield' },
    ]
    const rows = varietyAgg.map((r) => {
      const yld = r.acres > 0 ? r.dryBu / r.acres : null
      return [
        r.cropName,
        r.variety,
        r.seasonYear,
        r.plantings,
        r.acres,
        r.dryBu,
        yld ?? '',
      ]
    })
    return { title: 'Yields by Variety', filters: fieldFiltersLabel(), sections: [{ columns, rows }] }
  }

  function openBreakout(p: FieldPlanting) {
    setBreakoutId(p.id)
    setBreakoutErr(null)
    setLastTouched(null)
    const b = breakoutFor(p)
    if (p.yield_breakout_entered) {
      setBreakoutIrr(p.irrigated_bushels != null ? String(p.irrigated_bushels) : '')
      setBreakoutDry(p.dryland_bushels != null ? String(p.dryland_bushels) : '')
    } else if (b.designatedLoads > 0) {
      // Pre-fill from the loads that carry an irrigated/dryland tag — either
      // the complete load-derived split (adjusting it manually) or a partial
      // one ("from X of Y loads — complete the remainder"). The user confirms
      // the final numbers.
      setBreakoutIrr(String(Number(b.designatedIrrBu.toFixed(2))))
      setBreakoutDry(String(Number(b.designatedDryBu.toFixed(2))))
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
    if (!canEdit) return
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
    if (!canEdit) return
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

  // Override the auto harvest classification. value=true counts the field
  // despite an unharvested/in-progress flag; value=null restores the automatic
  // behavior.
  async function setInclusionOverride(p: FieldPlanting, value: boolean | null) {
    if (!canEdit) return
    setOverrideErr(null)
    setOverrideSavingId(p.id)
    const { error } = await supabase
      .from('field_plantings')
      .update({ yield_include_override: value })
      .eq('id', p.id)
    setOverrideSavingId(null)
    if (error) { setOverrideErr(error.message); return }
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
    if (!canEdit) return
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
    if (!canEdit) return
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

  // Hide the per-row Year column when every visible row is the same year — it's
  // just clutter once the data is scoped to a single season.
  const showFieldYear = new Set(visible.map((p) => p.season_year)).size > 1
  const showFarmYear = new Set(byFarm.map((r) => r.seasonYear)).size > 1
  const showVarietyYear = new Set(varietyAgg.map((r) => r.seasonYear)).size > 1
  const multiVarYears = new Set(multiVarietyPlantings.map((p) => p.season_year))
  const showMultiVarYear = multiVarYears.size > 1

  // Column count for table colspan calculations. Irr ac / Dry ac follow the
  // same visibility rules as the irrigated/dryland yield columns, so the table
  // collapses to just total acres + total yield in the default "Total yield
  // only" view.
  const visibleYieldCols = [showIrrigatedCol, showDrylandCol, showTotalCol].filter(Boolean).length
  const visibleAcresBreakoutCols = [showIrrigatedCol, showDrylandCol].filter(Boolean).length
  const fieldColCount = 1 /* detail chevron */ + 2 /* Field/Crop */ + (showFieldYear ? 1 : 0) + 1 /* Acres */
    + visibleAcresBreakoutCols + 1 /* Dry bu */ + visibleYieldCols
    + (yieldView === 'breakdown' ? 1 : 0) /* allocate actions */
  // Farm: chevron + Farm/FSA#/Entity/Crop/Acres/Dry bu/Yield = 8 (+Year), plus
  // 4 in breakdown (Irr ac, Dry ac, Irrigated yield, Dryland yield).
  const farmColCount = 8 + (showFarmYear ? 1 : 0) + (farmShowBreakdown ? 4 : 0)
  // Entity: chevron + Crop/Acres/Dry bu/Yield = 5 (+Year), plus 4 in breakdown.
  const entityColCount = 5 + (showEntityYear ? 1 : 0) + (entityShowBreakdown ? 4 : 0)
  const multiVarColCount = 6 + (showMultiVarYear ? 1 : 0)
  // Variety rollup: Crop/Variety/Plantings/Acres/Dry bu/Yield = 6 (+Year).
  const varietyColCount = 6 + (showVarietyYear ? 1 : 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-bold flex-1">
          Yields {
            view === 'field'   ? 'by Field' :
            view === 'farm'    ? 'by Farm' :
            view === 'entity'  ? 'by Entity' :
            view === 'variety' ? 'by Variety' :
            'by Landowner'
          }
        </h1>
        <label className="text-sm flex items-center gap-2 no-print">
          View
          <select value={view} onChange={(e) => setView(e.target.value as ViewMode)} className={inputCls}>
            <option value="field">By field</option>
            <option value="farm">By farm</option>
            <option value="entity">By entity</option>
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
                : view === 'entity'
                  ? buildEntityPayload()
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
              : view === 'entity'
                ? 'Plantings rolled up to entity × crop × season, across every farm that belongs to the entity. Dry bushels divided by planted acres.'
                : 'Bushels rolled up by crop × variety × season. Single-variety plantings are attributed automatically; multi-variety plantings only count once you allocate bushels to each variety.'}
        </p>
      )}

      {view !== 'landowner' && (
        <AvgYieldHeader
          averages={yieldAnalysis.averages}
          cropName={(id) => cropById.get(id)?.name ?? '—'}
          progress={view === 'field' ? activeProgress : undefined}
          label={view === 'field' ? 'Yield & harvest progress by crop' : undefined}
        />
      )}

      {overrideErr && <p className="text-sm text-red-600 no-print">{overrideErr}</p>}

      {/* The outer filter strip drives the field- and farm-view tables. The
          landowner view has its own filter set inside <YieldsByLandowner /> so
          this row is hidden when that tab is active (otherwise the user would
          see two filter rows and only the inner one would actually apply). */}
      {view !== 'landowner' && (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 no-print">
        <select value={year} onChange={(e) => setYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
          <option value="">All seasons</option>
          {distinctYears.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
          <option value="">All crops</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={farmId} onChange={(e) => setFarmId(e.target.value)} className={inputCls}>
          <option value="">All farms</option>
          {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {(!viewer.isViewer || entityOptionsFor(viewer, entities).length > 1) && (
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
          <option value="">All entities</option>
          {entityOptionsFor(viewer, entities).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        )}
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
                    {showMultiVarYear && <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>}
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
                          {showMultiVarYear && <td className="px-3 py-2">{p.season_year}</td>}
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
                            {/* Every row here is harvest-complete (or already
                                allocated) — still-harvesting fields are filtered
                                out of this list entirely. */}
                            {!allocated && (
                              <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 mr-2">
                                Needs allocation
                              </span>
                            )}
                            {!isOpen && canEdit && (
                              <button
                                type="button"
                                onClick={() => openVarAlloc(p)}
                                className="text-brand-deep text-sm whitespace-nowrap"
                              >{allocated ? 'Edit allocation' : 'Allocate bushels'}</button>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-sky-50 no-print">
                            <td colSpan={multiVarColCount} className="px-3 py-3">
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
                                    className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
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
                  {showVarietyYear && <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>}
                  <th className="text-right px-3 py-2 whitespace-nowrap">Plantings</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Acres</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Yield (bu/ac)</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={varietyColCount} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
                {!loading && varietyAgg.length === 0 && (
                  <tr><td colSpan={varietyColCount} className="px-3 py-6 text-center text-slate-400">
                    No varieties recorded for these filters. Add varieties on the Plantings page, or allocate bushels on any multi-variety plantings above.
                  </td></tr>
                )}
                {varietyAgg.map((r, i) => {
                  const yld = r.acres > 0 ? r.dryBu / r.acres : null
                  return (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-2">{r.cropName}</td>
                      <td className="px-3 py-2 font-semibold">{r.variety}</td>
                      {showVarietyYear && <td className="px-3 py-2">{r.seasonYear}</td>}
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
                <th className="w-6 px-2 py-2"></th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Field</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Crop</th>
                {showFieldYear && <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>}
                <th className="text-right px-3 py-2 whitespace-nowrap">Acres</th>
                {showIrrigatedCol && <th className="text-right px-3 py-2 whitespace-nowrap">Irr ac</th>}
                {showDrylandCol   && <th className="text-right px-3 py-2 whitespace-nowrap">Dry ac</th>}
                <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
                {showIrrigatedCol && <th className="text-right px-3 py-2 whitespace-nowrap">Irrigated yield</th>}
                {showDrylandCol   && <th className="text-right px-3 py-2 whitespace-nowrap">Dryland yield</th>}
                {showTotalCol     && <th className="text-right px-3 py-2 whitespace-nowrap">Yield (bu/ac)</th>}
                {yieldView === 'breakdown' && <th className="text-left px-3 py-2 whitespace-nowrap"></th>}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={fieldColCount} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={fieldColCount} className="px-3 py-6 text-center text-slate-400">No plantings match these filters.</td></tr>
              )}
              {fieldRows.map((p) => {
                const r = rowFor(p)
                const showAllocateButton = r.practice === 'mixed'
                const isBreakoutOpen = breakoutId === p.id
                const exclusion = excludedFields.get(p.id)         // effective (after override)
                const autoFlag = yieldAnalysis.autoExcluded.get(p.id) // what the auto rule says
                // Override only makes sense for in-progress fields — an
                // unharvested field has no bushels to count.
                const overridden = p.yield_include_override === true && autoFlag === 'in_progress'
                const savingOverride = overrideSavingId === p.id
                const rowCropName = r.crop?.name ?? ''
                const detailOpen = openDetail?.view === 'field' && openDetail.key === p.id
                return (
                  <Fragment key={p.id}>
                    <tr
                      className={`border-t border-slate-100 hover:bg-slate-50 cursor-pointer ${exclusion ? 'text-slate-400' : ''}`}
                      onClick={(e) => { if (rowClickIsOnControl(e)) return; toggleDetail('field', p.id, rowCropName) }}
                    >
                      <td className="px-2 py-2 text-slate-400">{detailOpen ? '▾' : '▸'}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{r.fld?.name_or_number ?? '—'}</span>
                          {exclusion === 'in_progress' && (
                            <span className="text-xs rounded px-2 py-0.5 bg-amber-100 text-amber-800">
                              in progress
                            </span>
                          )}
                          {overridden && (
                            <span className="text-xs rounded px-2 py-0.5 bg-green-100 text-green-800">
                              in progress · counted
                            </span>
                          )}
                          {exclusion === 'in_progress' && canEdit && (
                            <button
                              type="button"
                              disabled={savingOverride}
                              onClick={() => setInclusionOverride(p, true)}
                              className="text-brand-deep text-xs underline disabled:opacity-50 no-print"
                            >Count anyway</button>
                          )}
                          {overridden && canEdit && (
                            <button
                              type="button"
                              disabled={savingOverride}
                              onClick={() => setInclusionOverride(p, null)}
                              className="text-slate-500 text-xs underline disabled:opacity-50 no-print"
                            >Reset</button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">{r.crop?.name ?? '—'}</td>
                      {showFieldYear && <td className="px-3 py-2">{p.season_year}</td>}
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
                      {yieldView === 'breakdown' && (
                        <td className="px-3 py-2 whitespace-nowrap">
                          {showAllocateButton && !isBreakoutOpen && canEdit && (() => {
                            const b = breakoutFor(p)
                            // Fully load-tagged fields are already allocated —
                            // no prompt, just a quiet note (still adjustable;
                            // saving a manual split overrides the load tags).
                            if (b.source === 'loads') {
                              return (
                                <button
                                  type="button"
                                  onClick={() => openBreakout(p)}
                                  title="Every load on this field carries an irrigated/dryland tag — the split comes straight from the loads. Open to replace it with a manual split."
                                  className="text-slate-500 text-sm whitespace-nowrap no-print"
                                >
                                  From load tags ✓
                                </button>
                              )
                            }
                            // Allocation is offered only once harvest is complete;
                            // an existing breakout stays editable so saved data is
                            // never stranded.
                            return (fieldComplete(p) || p.yield_breakout_entered) ? (
                              <button
                                type="button"
                                onClick={() => openBreakout(p)}
                                className="text-brand-deep text-sm whitespace-nowrap no-print"
                              >
                                {p.yield_breakout_entered ? 'Edit breakout' : 'Allocate irr/dry'}
                              </button>
                            ) : (
                              <span
                                title="Available after harvest is complete"
                                className="text-slate-400 text-sm whitespace-nowrap no-print cursor-help"
                              >
                                Allocate irr/dry
                              </span>
                            )
                          })()}
                        </td>
                      )}
                    </tr>
                    {detailOpen && (
                      <tr className="bg-slate-50">
                        <td colSpan={fieldColCount} className="px-3 py-3">
                          <YieldRowDetail
                            plantings={[p]}
                            loads={loads}
                            splits={splits}
                            cropById={cropById}
                            lookups={detailLookups}
                            allowLoadLinks={allowLoadLinks}
                            combineEntries={combineEntries}
                            perFieldBreakdown={false}
                            flag={
                              overridden ? (
                                <span className="text-xs rounded px-2 py-0.5 bg-green-100 text-green-800">
                                  in progress · counted
                                </span>
                              ) : exclusion === 'in_progress' ? (
                                <span className="text-xs rounded px-2 py-0.5 bg-amber-100 text-amber-800">
                                  in progress
                                </span>
                              ) : undefined
                            }
                            cotton={isCottonCrop(rowCropName) ? cottonDetail : null}
                          />
                        </td>
                      </tr>
                    )}
                    {isBreakoutOpen && (
                      <tr className="bg-sky-50 no-print">
                        <td colSpan={fieldColCount} className="px-3 py-3">
                          {(() => {
                            const b = breakoutFor(p)
                            if (p.yield_breakout_entered) {
                              return (
                                <p className="text-xs text-slate-600 mb-2">
                                  Manual split — it stays in charge even if the irrigated/dryland tags on this
                                  field&rsquo;s loads change later. Clear it to go back to using the load tags.
                                </p>
                              )
                            }
                            if (b.source === 'loads') {
                              return (
                                <p className="text-xs text-slate-600 mb-2">
                                  This split comes from the irrigated/dryland tags on all {b.totalLoads} of this
                                  field&rsquo;s loads. Saving here replaces it with a manual split, which then stays
                                  in charge even if the load tags change later.
                                </p>
                              )
                            }
                            if (b.designatedLoads > 0) {
                              return (
                                <p className="text-xs text-slate-600 mb-2">
                                  Pre-filled from {b.designatedLoads} of {b.totalLoads} tagged loads — complete the
                                  remainder and save to confirm the final split.
                                </p>
                              )
                            }
                            return null
                          })()}
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
                              className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
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
      ) : view === 'entity' ? (
        loading ? (
          <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">Loading…</div>
        ) : entityGroups.length === 0 ? (
          <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">No entities with production match these filters.</div>
        ) : (
          <div className="space-y-6">
            {entityGroups.map((g) => (
              <section key={g.groupId} className="bg-white rounded-xl shadow overflow-hidden avoid-break">
                <header className="bg-slate-100 px-4 py-2 flex items-baseline gap-2 flex-wrap">
                  <h2 className="font-bold text-lg">{g.groupName}</h2>
                  <span className="text-xs text-slate-500">{g.rows.length} crop{g.rows.length === 1 ? '' : 's'}</span>
                </header>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-700">
                      <tr>
                        <th className="w-6 px-2 py-2"></th>
                        <th className="text-left px-3 py-2 whitespace-nowrap">Crop</th>
                        {showEntityYear && <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>}
                        <th className="text-right px-3 py-2 whitespace-nowrap">Acres</th>
                        {entityShowBreakdown && <th className="text-right px-3 py-2 whitespace-nowrap">Irr ac</th>}
                        {entityShowBreakdown && <th className="text-right px-3 py-2 whitespace-nowrap">Dry ac</th>}
                        <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
                        {entityShowBreakdown && <th className="text-right px-3 py-2 whitespace-nowrap">Irrigated yield</th>}
                        {entityShowBreakdown && <th className="text-right px-3 py-2 whitespace-nowrap">Dryland yield</th>}
                        <th className="text-right px-3 py-2 whitespace-nowrap">Yield (bu/ac)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r) => {
                        const rowKey = entityRowKey(r)
                        const detailOpen = openDetail?.view === 'entity' && openDetail.key === rowKey
                        return (
                          <Fragment key={rowKey}>
                            <tr
                              className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                              onClick={(e) => { if (rowClickIsOnControl(e)) return; toggleDetail('entity', rowKey, r.cropName) }}
                            >
                              <td className="px-2 py-2 text-slate-400">{detailOpen ? '▾' : '▸'}</td>
                              <td className="px-3 py-2 font-medium">{r.cropName}</td>
                              {showEntityYear && <td className="px-3 py-2">{r.seasonYear}</td>}
                              <td className="px-3 py-2 text-right">{fmtNum(r.acres)}</td>
                              {entityShowBreakdown && <td className="px-3 py-2 text-right">{r.irrAc > 0 ? fmtNum(r.irrAc) : '—'}</td>}
                              {entityShowBreakdown && <td className="px-3 py-2 text-right">{r.dryAc > 0 ? fmtNum(r.dryAc) : '—'}</td>}
                              <td className="px-3 py-2 text-right">{fmtNum(r.dryBu)}</td>
                              {entityShowBreakdown && <td className="px-3 py-2 text-right font-semibold">{r.irrigatedYield != null ? r.irrigatedYield.toFixed(1) : '—'}</td>}
                              {entityShowBreakdown && <td className="px-3 py-2 text-right font-semibold">{r.drylandYield != null ? r.drylandYield.toFixed(1) : '—'}</td>}
                              <td className="px-3 py-2 text-right font-semibold">{r.yield != null ? r.yield.toFixed(1) : '—'}</td>
                            </tr>
                            {detailOpen && (
                              <tr className="bg-slate-50">
                                <td colSpan={entityColCount} className="px-3 py-3">
                                  <YieldRowDetail
                                    plantings={entityRowPlantings(r)}
                                    loads={loads}
                                    splits={splits}
                                    cropById={cropById}
                                    lookups={detailLookups}
                                    allowLoadLinks={allowLoadLinks}
                                    combineEntries={combineEntries}
                                    perFieldBreakdown
                                    cotton={isCottonCrop(r.cropName) ? cottonDetail : null}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                    {g.rows.length > 1 && (
                      <tfoot>
                        <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                          <td></td>
                          <td className="px-3 py-2">{g.groupName} total</td>
                          {showEntityYear && <td></td>}
                          <td className="px-3 py-2 text-right">{fmtNum(g.acres)}</td>
                          {entityShowBreakdown && <td></td>}
                          {entityShowBreakdown && <td></td>}
                          <td className="px-3 py-2 text-right">{fmtNum(g.dryBu)}</td>
                          {entityShowBreakdown && <td></td>}
                          {entityShowBreakdown && <td></td>}
                          <td className="px-3 py-2 text-right text-slate-400">—</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </section>
            ))}
          </div>
        )
      ) : (
        <div className="overflow-x-auto bg-white rounded-xl shadow">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="w-6 px-2 py-2"></th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Farm</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">FSA#</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Entity</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Crop</th>
                {showFarmYear && <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>}
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
              {byFarm.map((r) => {
                const y = farmYields(r)
                const rowKey = farmRowKey(r)
                const detailOpen = openDetail?.view === 'farm' && openDetail.key === rowKey
                return (
                  <Fragment key={rowKey}>
                    <tr
                      className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={(e) => { if (rowClickIsOnControl(e)) return; toggleDetail('farm', rowKey, r.cropName) }}
                    >
                      <td className="px-2 py-2 text-slate-400">{detailOpen ? '▾' : '▸'}</td>
                      <td className="px-3 py-2 font-semibold">{r.farmName}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.fsaNumber ?? ''}</td>
                      <td className="px-3 py-2">{r.entityName}</td>
                      <td className="px-3 py-2">{r.cropName}</td>
                      {showFarmYear && <td className="px-3 py-2">{r.seasonYear}</td>}
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
                    {detailOpen && (
                      <tr className="bg-slate-50">
                        <td colSpan={farmColCount} className="px-3 py-3">
                          <YieldRowDetail
                            plantings={farmRowPlantings(r)}
                            loads={loads}
                            splits={splits}
                            cropById={cropById}
                            lookups={detailLookups}
                            allowLoadLinks={allowLoadLinks}
                            combineEntries={combineEntries}
                            perFieldBreakdown
                            cotton={isCottonCrop(r.cropName) ? cottonDetail : null}
                          />
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
      {/* Cotton module (feature-flagged): lint lbs/acre from gin receipts. */}
      <CottonYieldsSection year={year} />
    </div>
  )
}
