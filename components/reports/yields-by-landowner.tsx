'use client'

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { buildDoubleCropSet, buildSpringCropByFieldYear, croppingOf, cropYearOptionsFromPlantings, type Cropping } from '@/lib/plantings'
import { croppingFilterLabel, type CroppingFilter } from '@/components/reports/cropping'
import type { CroppingByKey } from '@/components/yields-detail'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useReportCropYear } from '@/lib/report-filters'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { roleAllowsPath } from '@/lib/route-guard'
import { fieldCropAggregates, analyzeYields, buildYieldInputs, type CombineEntryLike } from '@/lib/yields'
import { useCottonYields } from '@/lib/use-cotton-yields'
import { isCottonCrop } from '@/lib/marketing'
import AvgYieldHeader from '@/components/reports/avg-yield-header'
import {
  EmptyState, ReportHeader, ReportFilterBar, FilterField, theadCls, subtotalRowCls, selectCls,
  fmtNum, fmtInt, filterSummaryOf, cropYearLabel,
} from '@/components/reports/report-kit'
import {
  YieldRowDetail, useCottonDetailData, buildDetailForPlantings, cottonDetailsByYear,
  grainDetailExportSection, cottonDetailExportSection,
} from '@/components/yields-detail'
import type { ExportPayload, ExportSection } from '@/lib/exports'
import type {
  Crop, CropAssumption, Entity, Farm, Field, FieldPlanting, Landowner, LoadSplit,
} from '@/lib/types'

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
  truck_label: string | null
  hauler_truck: string | null
  ticket_number: string | null
}

type FarmCropAgg = {
  cropId: string
  acres: number
  dryBu: number
  cropName: string
  /** The constituent (harvest-included) plantings the numbers rolled up from. */
  plantings: FieldPlanting[]
}

type FarmAgg = {
  farmName: string
  fsaNumber: string | null
  byCrop: Map<string, FarmCropAgg>
}

type LandownerGroup = {
  key: string
  landownerName: string
  farms: FarmAgg[]
  byCrop: Map<string, { acres: number; dryBu: number; cropName: string }>
}

const NO_LANDOWNER_KEY = '__none__'
const NO_LANDOWNER_LABEL = 'Owned / No Landowner'

type Props = {
  /** When provided, callback is invoked any time the export payload changes,
   *  giving the parent a fresh builder it can pass to <ExportBar />. */
  onPayloadChange?: (build: () => ExportPayload) => void
  /** Rendered in the report header's action slot (the page passes <ExportBar/>). */
  headerActions?: ReactNode
  /** Embedded on the Yields page: the crop year / crop / entity come from the
   *  page's ONE filter strip; this component then shows only its landowner
   *  pick and no header of its own. */
  controlled?: { cropYear: number | ''; cropId: string; entityId: string; cropping?: CroppingFilter }
}

export default function YieldsByLandowner({ onPayloadChange, headerActions, controlled }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [combineEntries, setCombineEntries] = useState<CombineEntryLike[]>([])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  // Light name lookups (id + name only) for the drill-down's load list.
  const [trucks, setTrucks] = useState<Array<{ id: string; name_or_number: string }>>([])
  const [bins, setBins] = useState<Array<{ id: string; name_or_number: string }>>([])
  const [buyers, setBuyers] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)

  // Filters persist across visits; the crop year follows the one report rule
  // (current year by default, never overwritten on load; "All" stays on
  // offer). Embedded on the Yields page, the page's filters take over.
  const [ownCropYear, setOwnCropYear] = useReportCropYear('yields-by-landowner:cropYear', { allowAll: true })
  const [ownCropId, setOwnCropId] = usePersistentState('yields-by-landowner:cropId', '')
  const [ownEntityId, setOwnEntityId] = usePersistentState('yields-by-landowner:entityId', '')
  const [landownerId, setLandownerId] = usePersistentState('yields-by-landowner:landownerId', '')
  const cropYear = controlled ? controlled.cropYear : ownCropYear
  const cropId = controlled ? controlled.cropId : ownCropId
  const entityId = controlled ? controlled.entityId : ownEntityId
  // Full-season / double-crop: the Yields page's Cropping control reaches
  // this tab through `controlled`; standalone the report shows everything.
  const cropping: CroppingFilter = controlled?.cropping ?? 'all'

  useEffect(() => {
    ;(async () => {
      const [cr, en, fa, fi, pl, lo, sp, lan, tr, bi, bu, ce, ca] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('field_plantings').select('*'),
        fetchAllRows((f, t) => supabase.from('loads').select('id, date, time, net_weight, moisture, test_weight, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, to_type, to_bin_id, to_buyer_id, truck_id, truck_label, hauler_truck, ticket_number').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
        supabase.from('landowners').select('*').order('name'),
        supabase.from('trucks').select('id, name_or_number').order('name_or_number'),
        supabase.from('bins').select('id, name_or_number').order('name_or_number'),
        supabase.from('buyers').select('id, name').order('name'),
        // May not exist yet (migration 062): an error leaves data null → [].
        fetchAllRows((f, t) => supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date').order('id').range(f, t)),
        // Expected yields (the thin-peers comparison tier) + the cotton turnout (092).
        supabase.from('crop_assumptions').select('*'),
      ])
      setCrops((cr.data as Crop[]) || [])
      setEntities((en.data as Entity[]) || [])
      setFarms((fa.data as Farm[]) || [])
      setFields((fi.data as Field[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoads((lo.data as LoadRow[]) || [])
      setSplits((sp.data as LoadSplit[]) || [])
      setLandowners((lan.data as Landowner[]) || [])
      setTrucks((tr.data as Array<{ id: string; name_or_number: string }>) || [])
      setBins((bi.data as Array<{ id: string; name_or_number: string }>) || [])
      setBuyers((bu.data as Array<{ id: string; name: string }>) || [])
      setCombineEntries((ce.data as CombineEntryLike[]) || [])
      setAssumptions((ca.data as CropAssumption[]) || [])
      setLoading(false)
    })()
  }, [supabase])

  // Viewer role (052): RLS already row-filters the data; here the grants only
  // limit the entity dropdown and name the granted entities on the export.
  // Viewers AND agronomists (061) get plain-text load rows — /loads is
  // outside both roles' route allowlists.
  const viewer = useViewerScope(supabase)
  const entityOptions = entityOptionsFor(viewer, entities)
  const allowLoadLinks = roleAllowsPath(viewer.role, '/loads')

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const landownerById = useMemo(() => new Map(landowners.map((l) => [l.id, l])), [landowners])
  // Cotton module (092): cotton plantings classify off their seed cotton loads
  // and roll up in LINT lbs (receipts + the turnout estimate on unginned seed
  // cotton); grain stays in dry bushels. Inert when the module is off.
  const cottonYields = useCottonYields(supabase, { crops, assumptions })
  const cottonModel = cottonYields.model
  const cottonOn = cottonYields.on === true
  const isCottonId = (id: string) => cottonOn && cottonModel.cottonCropIds.has(id)
  const unitOf = (id: string): 'bu' | 'lbs' => (isCottonId(id) ? 'lbs' : 'bu')

  // Dry bushels + most-recent load date per field+crop+year (shared rules).
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { cropYear: cropYear === '' ? null : cropYear, combineEntries }),
    [loads, splits, cropById, cropYear, combineEntries],
  )
  const dryBuFor = (fieldId: string, cropId2: string, year: number) =>
    aggByKey.get(`${fieldId}|${cropId2}|${year}`)?.dryBu ?? 0
  // A planting's production in its crop's unit: lint lbs for cotton (module
  // on), dry bushels otherwise.
  const prodFor = (p: FieldPlanting) => (isCottonId(p.crop_id) ? (cottonModel.yieldFor(p)?.lintLbs ?? 0) : dryBuFor(p.field_id, p.crop_id, p.season_year))

  // ---- Drill-down detail --------------------------------------------------
  // One open detail at a time (a farm × crop row inside a landowner group);
  // any filter change closes it.
  const [openDetail, setOpenDetail] = useState<{ ownerKey: string; farmName: string; cropId: string } | null>(null)
  useEffect(() => { setOpenDetail(null) }, [cropYear, cropId, entityId, landownerId])
  // Cotton sources load lazily the first time a cotton row's detail opens.
  const cottonDetail = useCottonDetailData(supabase)
  // Mirror fieldCropAggregates' cropYear option above: the drill-down must see
  // exactly the loads the row's dry bushels came from — no more, no less.
  const detailLoads = useMemo(
    () => (cropYear === '' ? loads : loads.filter((l) => l.crop_year === cropYear)),
    [loads, cropYear],
  )
  const detailLookups = useMemo(() => ({
    fieldNameById: new Map(fields.map((f) => [f.id, f.name_or_number])),
    truckNameById: new Map(trucks.map((t) => [t.id, t.name_or_number])),
    binNameById: new Map(bins.map((b) => [b.id, b.name_or_number])),
    buyerNameById: new Map(buyers.map((b) => [b.id, b.name])),
  }), [fields, trucks, bins, buyers])
  function toggleDetail(ownerKey: string, farmName: string, t: FarmCropAgg) {
    const isOpen = openDetail?.ownerKey === ownerKey && openDetail.farmName === farmName && openDetail.cropId === t.cropId
    setOpenDetail(isOpen ? null : { ownerKey, farmName, cropId: t.cropId })
    if (!isOpen && isCottonCrop(t.cropName)) cottonDetail.ensure()
  }

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

  // Full-season / double-crop cohorts, from EVERY planting (the spring crop
  // that makes a field double-cropped is outside the crop filter).
  const doubleCropIds = useMemo(() => buildDoubleCropSet(plantings, cropById), [plantings, cropById])
  const springCropByFieldYear = useMemo(() => buildSpringCropByFieldYear(plantings, cropById), [plantings, cropById])
  const croppingByKey = useMemo<CroppingByKey>(() => {
    const m = new Map<string, { cropping: Cropping; springCropName: string | null }>()
    for (const p of plantings) {
      const spring = springCropByFieldYear.get(`${p.field_id}|${p.season_year}`)
      m.set(`${p.field_id}|${p.crop_id}|${p.season_year}`, { cropping: croppingOf(p, doubleCropIds), springCropName: spring ? cropById.get(spring)?.name ?? null : null })
    }
    return m
  }, [plantings, doubleCropIds, springCropByFieldYear, cropById])

  // Plantings matching the active filters (before the harvest exclusion).
  const filteredPlantings = useMemo(() => plantings.filter((p) => {
    if (cropYear !== '' && p.season_year !== cropYear) return false
    if (cropId && p.crop_id !== cropId) return false
    const fld = fieldById.get(p.field_id)
    if (!fld) return false
    const farm = fld.farm_id ? farmById.get(fld.farm_id) ?? null : null
    if (entityId && farm?.entity_id !== entityId) return false
    const ownerKey = farm?.landowner_id ?? NO_LANDOWNER_KEY
    if (landownerId && ownerKey !== landownerId) return false
    if (cropping !== 'all' && croppingOf(p, doubleCropIds) !== cropping) return false
    return true
  }), [plantings, fieldById, farmById, cropYear, cropId, entityId, landownerId, cropping, doubleCropIds])

  // Drop unharvested / in-progress fields from the rolled-up numbers and the
  // average-yield header (per crop, over the filtered plantings).
  const yieldAnalysis = useMemo(() => {
    return analyzeYields(buildYieldInputs({ plantings: filteredPlantings, aggByKey, assumptions, cotton: cottonModel.adapter, doubleCropIds }))
  }, [filteredPlantings, aggByKey, assumptions, cottonModel, doubleCropIds])

  // Build per-landowner aggregation.
  const groups = useMemo<LandownerGroup[]>(() => {
    const excluded = yieldAnalysis.excluded
    const byOwner = new Map<string, LandownerGroup>()

    // Pre-create the groups for landowners that exist so an empty owner still
    // shows up if the user is filtering specifically on them.
    if (landownerId) {
      const l = landownerById.get(landownerId)
      byOwner.set(landownerId, {
        key: landownerId,
        landownerName: l?.name ?? '(missing)',
        farms: [],
        byCrop: new Map(),
      })
    }

    for (const p of filteredPlantings) {
      if (excluded.has(p.id)) continue
      const fld = fieldById.get(p.field_id)
      if (!fld) continue
      const farm = fld.farm_id ? farmById.get(fld.farm_id) ?? null : null
      const ownerKey = farm?.landowner_id ?? NO_LANDOWNER_KEY
      if (!byOwner.has(ownerKey)) {
        const l = farm?.landowner_id ? landownerById.get(farm.landowner_id) : null
        byOwner.set(ownerKey, {
          key: ownerKey,
          landownerName: l?.name ?? NO_LANDOWNER_LABEL,
          farms: [],
          byCrop: new Map(),
        })
      }
      const group = byOwner.get(ownerKey)!

      const acres = Number(p.planted_acres)
      const dryBu = prodFor(p)
      const cropName = cropById.get(p.crop_id)?.name ?? '—'

      let farmAgg = group.farms.find((f) => f.farmName === (farm?.name ?? '— no farm —'))
      if (!farmAgg) {
        farmAgg = {
          farmName: farm?.name ?? '— no farm —',
          fsaNumber: farm?.fsa_number ?? null,
          byCrop: new Map(),
        }
        group.farms.push(farmAgg)
      }
      const farmCropTotal = farmAgg.byCrop.get(p.crop_id) ?? { cropId: p.crop_id, acres: 0, dryBu: 0, cropName, plantings: [] }
      farmCropTotal.acres += acres
      farmCropTotal.dryBu += dryBu
      farmCropTotal.plantings.push(p)
      farmAgg.byCrop.set(p.crop_id, farmCropTotal)

      const ownerCropTotal = group.byCrop.get(p.crop_id) ?? { acres: 0, dryBu: 0, cropName }
      ownerCropTotal.acres += acres
      ownerCropTotal.dryBu += dryBu
      group.byCrop.set(p.crop_id, ownerCropTotal)
    }

    return [...byOwner.values()].sort((a, b) => {
      // Push "Owned / No Landowner" to the bottom; otherwise alphabetical.
      if (a.key === NO_LANDOWNER_KEY) return 1
      if (b.key === NO_LANDOWNER_KEY) return -1
      return a.landownerName.localeCompare(b.landownerName)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredPlantings, yieldAnalysis, fieldById, farmById, landownerById, cropById, aggByKey, landownerId, cottonModel])

  // A landowner signed in as a viewer gets their handout: the operation's own
  // "Owned / No Landowner" ground is the operator's business, not theirs.
  const shownGroups = useMemo(
    () => (viewer.isViewer ? groups.filter((g) => g.key !== NO_LANDOWNER_KEY) : groups),
    [groups, viewer.isViewer],
  )

  function filtersLabel(): string {
    // For a viewer, "no entity selected" means their granted entities — name
    // them. Null for owners (keep existing wording).
    const entityName = entityId
      ? entities.find((e) => e.id === entityId)?.name ?? '?'
      : viewerAllEntitiesLabel(viewer, entities)
    return filterSummaryOf(
      cropYearLabel(cropYear),
      entityName ?? 'All Entities',
      cropId ? (cropById.get(cropId)?.name ?? 'Crop') : 'All Crops',
      landownerId ? (landownerById.get(landownerId)?.name ?? 'Landowner') : 'All Landowners',
      croppingFilterLabel(cropping),
    )
  }

  // Export payload mirrors the on-screen layout: one section per landowner,
  // with a sub-header row per farm followed by its crop rows, then a tinted
  // totals block. Per-field detail is intentionally omitted — the report rolls
  // up to the farm level for readability.
  function buildExportPayload(): ExportPayload {
    const anyCotton = cottonOn && shownGroups.some((g) => [...g.byCrop.keys()].some(isCottonId))
    const columns: ExportPayload['sections'][number]['columns'] = anyCotton
      ? [
          { label: 'Crop' },
          { label: 'Acres', align: 'right', format: 'acres' },
          { label: 'Production', align: 'right', format: 'int' },
          { label: 'Unit' },
          { label: 'Yield per acre', align: 'right', format: 'yield' },
        ]
      : [
          { label: 'Crop' },
          { label: 'Acres', align: 'right', format: 'acres' },
          { label: 'Dry bu', align: 'right', format: 'bu' },
          { label: 'Yield (bu/ac)', align: 'right', format: 'yield' },
        ]
    const cells = (cropId: string, cropName: string, acres: number, prod: number): Array<string | number | null> =>
      anyCotton ? [cropName, acres, prod, unitOf(cropId), yld(acres, prod)] : [cropName, acres, prod, yld(acres, prod)]
    // Real number (formatted to 1 dec by the column), or '—' when there are no acres.
    const yld = (acres: number, dryBu: number): number | string => (acres > 0 ? dryBu / acres : '—')

    const sections: ExportSection[] = shownGroups.map((g) => {
      const rows: Array<Array<string | number | null>> = []
      const rowMeta: NonNullable<ExportPayload['sections'][number]['rowMeta']> = []

      for (const f of g.farms) {
        rows.push([f.fsaNumber ? `${f.farmName}  ·  FSA #${f.fsaNumber}` : f.farmName])
        rowMeta.push('subhead')
        for (const t of f.byCrop.values()) {
          rows.push(cells(t.cropId, t.cropName, t.acres, t.dryBu))
          rowMeta.push('data')
        }
      }

      if (g.byCrop.size > 0) {
        rows.push([`${g.landownerName} totals`])
        rowMeta.push('subhead')
        for (const [cropId2, t] of g.byCrop) {
          rows.push(cells(cropId2, t.cropName, t.acres, t.dryBu))
          rowMeta.push('total')
        }
      }

      const farmCount = `${g.farms.length} farm${g.farms.length === 1 ? '' : 's'}`
      return {
        title: `${g.landownerName}  —  ${farmCount}`,
        columns,
        rows,
        rowMeta,
      }
    })

    // While a drill-down is open, its load list (or cotton numbers) rides along
    // as one extra section.
    if (openDetail) {
      const g = groups.find((x) => x.key === openDetail.ownerKey)
      const f = g?.farms.find((x) => x.farmName === openDetail.farmName)
      const t = f?.byCrop.get(openDetail.cropId)
      if (g && f && t) {
        const yearLabel = cropYear === '' ? 'all crop years' : String(cropYear)
        const title = `Load Detail — ${g.landownerName} · ${f.farmName} · ${t.cropName} · ${yearLabel}`
        if (isCottonCrop(t.cropName)) {
          if (cottonDetail.data) {
            const details = cottonDetailsByYear(t.plantings, cottonDetail.data)
            sections.push(cottonDetailExportSection({ title, details, showYear: details.length > 1 }))
          }
        } else {
          const detail = buildDetailForPlantings({ plantings: t.plantings, loads: detailLoads, splits, cropById })
          sections.push(grainDetailExportSection({ title, detailLoads: detail.loads, lookups: detailLookups }))
        }
      }
    }

    return {
      title: 'Yields by Landowner',
      filters: filtersLabel(),
      singleSheet: true,
      sections,
    }
  }

  // Hand a fresh builder up to the parent any time the data or filters change.
  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownGroups, cropYear, cropId, entityId, landownerId, viewer, onPayloadChange, openDetail, cottonDetail.data])

  const landownerSelect = (
    <FilterField label="Landowner">
      <select value={landownerId} onChange={(e) => setLandownerId(e.target.value)} className={selectCls}>
        <option value="">All landowners</option>
        {landowners.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </FilterField>
  )

  return (
    <div className="space-y-4">
      {controlled ? (
        <div className="no-print">{landownerSelect}</div>
      ) : (
        <>
          <ReportHeader title="Yields by Landowner" filterSummary={filtersLabel()} actions={headerActions} />
          <ReportFilterBar activeCount={(cropId ? 1 : 0) + (entityId ? 1 : 0) + (landownerId ? 1 : 0)}>
            <FilterField label="Crop year">
              <select value={cropYear} onChange={(e) => setOwnCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={selectCls}>
                <option value="">All crop years</option>
                {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </FilterField>
            <FilterField label="Crop">
              <select value={cropId} onChange={(e) => setOwnCropId(e.target.value)} className={selectCls}>
                <option value="">All crops</option>
                {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </FilterField>
            {!(viewer.isViewer && entityOptions.length <= 1) && (
              <FilterField label="Entity">
                <select value={entityId} onChange={(e) => setOwnEntityId(e.target.value)} className={selectCls}>
                  <option value="">All entities</option>
                  {entityOptions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </FilterField>
            )}
            {landownerSelect}
          </ReportFilterBar>
        </>
      )}

      {!loading && (
        <AvgYieldHeader averages={yieldAnalysis.averages} cropName={(id) => cropById.get(id)?.name ?? '—'} />
      )}

      {loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : shownGroups.length === 0 ? (
        <EmptyState
          message="No plantings match these filters."
          hint="Try widening the crop year, crop, entity, or landowner filters — or record yields for these fields."
          linkHref="/loads"
          linkLabel="Enter loads"
          role={viewer.role}
        />
      ) : (
        <div className="space-y-6">
          {shownGroups.map((g) => (
            <section key={g.key} className={`bg-white rounded-xl shadow overflow-hidden avoid-break ${g.key === NO_LANDOWNER_KEY ? 'print:hidden' : ''}`}>
              <header className="bg-slate-100 px-4 py-2 flex items-baseline gap-2 flex-wrap">
                <h2 className="font-bold text-lg">{g.landownerName}</h2>
                <span className="text-xs text-slate-500">{g.farms.length} farm{g.farms.length === 1 ? '' : 's'}</span>
              </header>

              {g.farms.map((f, fi) => (
                <div key={fi} className="px-4 py-3 border-t border-slate-100">
                  <div className="flex items-baseline gap-2 mb-1">
                    <h3 className="font-semibold">{f.farmName}</h3>
                    {f.fsaNumber && <span className="text-xs text-slate-500">FSA #{f.fsaNumber}</span>}
                  </div>
                  <table className="min-w-full text-sm">
                    <thead className={theadCls}>
                      <tr>
                        <th className="w-10"></th>
                        <th className="text-left pr-4 py-1 font-medium">Crop</th>
                        <th className="text-right pr-4 py-1 font-medium">Acres</th>
                        <th className="text-right pr-4 py-1 font-medium">{cottonOn && [...f.byCrop.keys()].some(isCottonId) ? 'Production' : 'Dry bu'}</th>
                        <th className="text-right pr-4 py-1 font-medium">{cottonOn && [...f.byCrop.keys()].some(isCottonId) ? 'Yield per acre' : 'Yield (bu/ac)'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...f.byCrop.values()].map((t) => {
                        const detailOpen = openDetail?.ownerKey === g.key
                          && openDetail.farmName === f.farmName
                          && openDetail.cropId === t.cropId
                        return (
                          <Fragment key={t.cropId}>
                            <tr
                              className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                              onClick={(e) => {
                                if ((e.target as HTMLElement).closest('button, a')) return
                                toggleDetail(g.key, f.farmName, t)
                              }}
                            >
                              <td className="px-1 py-1">
                                <button type="button" aria-expanded={detailOpen} aria-label={`${detailOpen ? 'Hide' : 'Show'} detail for ${t.cropName}`} onClick={() => toggleDetail(g.key, f.farmName, t)} className="inline-flex items-center justify-center min-h-10 min-w-10 rounded-lg text-slate-400 hover:bg-slate-100 no-print">{detailOpen ? '▾' : '▸'}</button>
                              </td>
                              <td className="pr-4 py-1 font-medium">{t.cropName}</td>
                              <td className="pr-4 py-1 text-right tabular-nums">{fmtNum(t.acres, 1)}</td>
                              <td className="pr-4 py-1 text-right tabular-nums">{fmtInt(t.dryBu)}{isCottonId(t.cropId) ? ' lbs' : ''}</td>
                              <td className="pr-4 py-1 text-right tabular-nums">{t.acres > 0 ? fmtNum(t.dryBu / t.acres, 1) : '—'}{isCottonId(t.cropId) ? ' lbs/ac' : ''}</td>
                            </tr>
                            {detailOpen && (
                              <tr className="bg-slate-50">
                                <td colSpan={5} className="px-2 py-3">
                                  <YieldRowDetail
                                    plantings={t.plantings}
                                    loads={detailLoads}
                                    splits={splits}
                                    cropById={cropById}
                                    lookups={detailLookups}
                                    allowLoadLinks={allowLoadLinks}
                                    perFieldBreakdown
                                    combineEntries={combineEntries}
                                    croppingByKey={croppingByKey}
                                    cotton={isCottonCrop(t.cropName) ? cottonDetail : null}
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
              ))}

              {g.byCrop.size > 0 && (
                <div className={`px-4 py-3 border-t-2 border-slate-200 ${subtotalRowCls}`}>
                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{g.landownerName} totals</div>
                  <table className="min-w-full text-sm">
                    <tbody>
                      {[...g.byCrop.entries()].map(([cropId2, t]) => (
                        <tr key={`grand-${t.cropName}`}>
                          <td className="pr-4 py-1 font-semibold">{t.cropName}</td>
                          <td className="pr-4 py-1 text-right tabular-nums">{fmtNum(t.acres, 1)} ac</td>
                          <td className="pr-4 py-1 text-right tabular-nums">{fmtInt(t.dryBu)} {unitOf(cropId2)}</td>
                          <td className="pr-4 py-1 text-right tabular-nums font-semibold">{t.acres > 0 ? fmtNum(t.dryBu / t.acres, 1) : '—'} {unitOf(cropId2)}/ac</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
