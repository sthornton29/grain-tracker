'use client'

// Crop Insurance Production Report.
//
// Mirrors the spreadsheet format crop insurance agents accept: one Summary
// sheet plus one detail sheet per (county, practice) combination. Acres come
// from field_plantings.irrigated_acres / dryland_acres; production comes from
// loads + load_splits with optional per-planting irrigated/dryland breakouts.
//
// Mixed-practice plantings (both irrigated and dryland acres) without a
// production breakout are gated, but only once their harvest is complete —
// an unharvested or still-in-progress field has no final production to split,
// so it never blocks the report. Completion uses the same analyzeYields logic
// as the Yields page. For a gated planting the user either fills in the
// breakout on the Yields page or chooses to roll the production into dryland.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { analyzeYields, expectedYieldForPlanting, fieldCropAggregates, harvestStatusOf, withLoadBreakouts, type CombineEntryLike, type HarvestStatus } from '@/lib/yields'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { roleCanEditYields } from '@/lib/app-role'
import { useViewerAssumptions } from '@/lib/use-viewer-assumptions'
import { resolveCropAssumptions } from '@/lib/viewer-assumptions'
import { SupersededNotice } from '@/components/viewer-scenario'
import { EmptyState, theadCls, grandTotalRowCls } from '@/components/reports/report-kit'
import { exportToExcel, exportToPdf, type ExportPayload } from '@/lib/exports'
import type {
  County, Crop, CropAssumption, Entity, Farm, Field, FieldPlanting, LoadSplit,
} from '@/lib/types'

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

type Practice = 'irrigated' | 'dryland'

// One resolved planting with its sheet placement and split bushels.
type Resolved = {
  planting: FieldPlanting
  field: Field | null
  farm: Farm | null
  countyId: string | null
  countyLabel: string
  irrigatedAcres: number
  drylandAcres: number
  totalBu: number
  irrigatedBu: number
  drylandBu: number
  isMixed: boolean
  hasBreakout: boolean
  fieldDisplayName: string
}

// Per-cell aggregate inside a sheet: one farm + one crop.
type FarmCropCell = {
  acres: number
  bu: number
}

// One detail sheet (county + practice).
type DetailSheet = {
  countyId: string | null
  countyLabel: string
  practice: Practice
  sheetName: string
  // farmId -> { farm, byCropId -> FarmCropCell }
  farms: Map<string, { farm: Farm | null; farmName: string; fsaNumber: string | null; byCrop: Map<string, FarmCropCell> }>
}

// Summary row: one (county, practice) line.
type SummaryRow = {
  sheetName: string
  countyId: string | null
  countyLabel: string
  practice: Practice
  byCrop: Map<string, FarmCropCell>
}

const NO_COUNTY_KEY = '__no_county__'
const NO_FARM_KEY = '__no_farm__'

function practiceLabel(p: Practice): string {
  return p === 'irrigated' ? 'Irrigated' : 'Dryland'
}

function fmt(n: number, d = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

export default function CropInsuranceReport() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [combineEntries, setCombineEntries] = useState<CombineEntryLike[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])

  // Filters persist across visits (see usePersistentState).
  const [cropYear, setCropYear] = usePersistentState<number | ''>('crop-insurance:cropYear', '')
  const [entityId, setEntityId] = usePersistentState('crop-insurance:entityId', '')
  // Optional crop filter — empty means all crops. Multi-select via toggle chips.
  const [cropIds, setCropIds] = usePersistentState<string[]>('crop-insurance:cropIds', [])
  // Gate state for mixed-without-breakout plantings. The user must explicitly
  // resolve this before we generate the report — either fill in the breakout
  // upstream or accept that production rolls into dryland.
  const [acceptedAsDryland, setAcceptedAsDryland] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('summary')
  const [exportErr, setExportErr] = useState<string | null>(null)
  const [exporting, setExporting] = useState<null | 'xlsx' | 'pdf'>(null)

  useEffect(() => {
    ;(async () => {
      const [cr, en, fa, fi, co, pl, lo, sp, ca, ce] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('counties').select('*').order('state_code').order('name'),
        supabase.from('field_plantings').select('*'),
        fetchAllRows((f, t) => supabase.from('loads').select('id, date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
        supabase.from('crop_assumptions').select('*'),
        // May not exist yet (migration 062): an error leaves data null → [].
        supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date'),
      ])
      setCrops((cr.data as Crop[]) || [])
      setEntities((en.data as Entity[]) || [])
      setFarms((fa.data as Farm[]) || [])
      setFields((fi.data as Field[]) || [])
      setCounties((co.data as County[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoads((lo.data as LoadRow[]) || [])
      setSplits((sp.data as LoadSplit[]) || [])
      setAssumptions((ca.data as CropAssumption[]) || [])
      setCombineEntries((ce.data as CombineEntryLike[]) || [])
      // Default to the most recent crop year with plantings.
      const yrs = (pl.data as FieldPlanting[] | null)?.map((p) => p.season_year) ?? []
      if (yrs.length > 0) setCropYear(Math.max(...yrs))
      setLoading(false)
    })()
  }, [supabase])

  // Reset the dryland-rollover choice whenever filters change — the set of
  // affected plantings depends on the year, so the user should re-confirm.
  useEffect(() => {
    setAcceptedAsDryland(false)
  }, [cropYear, entityId, cropIds])

  // "Count anyway" on a still-harvesting field — the same persisted override
  // the Yields page sets (field_plantings.yield_include_override), so the
  // field counts as finished everywhere. Only the plantings are refetched.
  const [overrideSavingId, setOverrideSavingId] = useState<string | null>(null)
  const [overrideErr, setOverrideErr] = useState<string | null>(null)
  async function countAnyway(p: FieldPlanting) {
    const name = fieldById.get(p.field_id)?.name_or_number ?? 'this field'
    if (!confirm(`Count ${name} as finished? Its current bushels will be treated as the field's final yield. You can undo this from the field's detail on the Yields page.`)) return
    setOverrideErr(null)
    setOverrideSavingId(p.id)
    const { error } = await supabase
      .from('field_plantings')
      .update({ yield_include_override: true })
      .eq('id', p.id)
    if (!error) {
      const pl = await supabase.from('field_plantings').select('*')
      setPlantings((pl.data as FieldPlanting[]) || [])
    }
    setOverrideSavingId(null)
    if (error) setOverrideErr(error.message)
  }

  // Viewer role (052): grants prune the entity dropdown and name the export's
  // entity label; the viewer's private overrides layer over crop_assumptions.
  // The row data itself (farms/fields/loads) is already RLS-scoped server-side,
  // so the hand-rolled entity filtering below stays as-is.
  const viewer = useViewerScope(supabase)
  const viewerA = useViewerAssumptions(supabase, viewer)
  const assumptionRes = useMemo(() => resolveCropAssumptions(assumptions, viewerA.overrides), [assumptions, viewerA.overrides])
  const effAssumptions = assumptionRes.rows
  useEffect(() => { if (assumptionRes.staleIds.length > 0) viewerA.cleanupStale(assumptionRes.staleIds) }, [assumptionRes, viewerA])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])

  // (fieldId|cropId|year) → { dryBu, lastLoadDate } — same allocation as the
  // Yields page. lastLoadDate feeds the harvest-completion check below.
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, {
      cropYear: cropYear === '' ? null : cropYear,
      combineEntries,
    }),
    [loads, splits, cropById, cropYear, combineEntries],
  )

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

  // Plantings matching the year + entity filter (before the crop filter). This
  // drives the crop-filter option list so it only offers crops actually present.
  const yearEntityPlantings = useMemo(() => {
    if (cropYear === '') return []
    return plantings.filter((p) => {
      if (p.season_year !== cropYear) return false
      const fld = fieldById.get(p.field_id)
      const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
      if (entityId && farm?.entity_id !== entityId) return false
      return true
    })
  }, [plantings, cropYear, entityId, fieldById, farmById])

  // Crops present in the selected year + entity — the crop-filter options (name
  // order preserved from the crops query).
  const cropFilterOptions = useMemo(() => {
    const ids = new Set(yearEntityPlantings.map((p) => p.crop_id))
    return crops.filter((c) => ids.has(c.id))
  }, [yearEntityPlantings, crops])

  // Apply the optional crop filter. Empty selection = all crops. Everything
  // downstream (gate, resolution, sheets) keys off this filtered list.
  // withLoadBreakouts materializes the load-derived irrigated/dryland split
  // onto mixed plantings whose loads are all practice-tagged, so those fields
  // read as already-allocated here — same as a manual breakout — and never
  // trip the missing-breakout gate.
  const yearPlantings = useMemo(
    () => withLoadBreakouts(
      cropIds.length === 0 ? yearEntityPlantings : yearEntityPlantings.filter((p) => cropIds.includes(p.crop_id)),
      aggByKey,
    ),
    [yearEntityPlantings, cropIds, aggByKey],
  )

  // Crop+year combos flagged harvest-complete at the crop level (Marketing
  // assumptions) — these force every field of that crop to "complete".
  const cropCompleteKeys = useMemo(() => {
    const s = new Set<string>()
    for (const a of effAssumptions) if (a.harvest_complete) s.add(`${a.crop_id}|${a.crop_year}`)
    return s
  }, [effAssumptions])

  // Field-level harvest status per planting, by the same rule the Yields page
  // uses (analyzeYields + the crop-level harvest-complete override). Only
  // complete fields can need (or block on) a production breakout.
  const harvestStatusById = useMemo(() => {
    const assumptionByKey = new Map(effAssumptions.map((a) => [`${a.crop_id}|${a.crop_year}`, a]))
    const analysis = analyzeYields(
      yearPlantings.map((p) => {
        const agg = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
        return {
          id: p.id,
          cropId: p.crop_id,
          acres: Number(p.planted_acres),
          dryBu: agg?.dryBu ?? 0,
          lastLoadDate: agg?.lastLoadDate ?? null,
          override: p.yield_include_override,
          combineComplete: agg?.combine?.harvestComplete,
          expectedYield: expectedYieldForPlanting(assumptionByKey.get(`${p.crop_id}|${p.season_year}`), p),
        }
      }),
    )
    const m = new Map<string, HarvestStatus>()
    for (const p of yearPlantings) m.set(p.id, harvestStatusOf(p, analysis.excluded, cropCompleteKeys))
    return m
  }, [yearPlantings, aggByKey, cropCompleteKeys, effAssumptions])

  const isMixedNoBreakout = (p: FieldPlanting) =>
    (Number(p.irrigated_acres) || 0) > 0 && (Number(p.dryland_acres) || 0) > 0 && !p.yield_breakout_entered

  // Mixed-practice plantings missing breakouts whose harvest is complete — these
  // gate the report. In-progress ones are excluded from the gate and surfaced
  // separately (mixedStillHarvesting) so a mid-harvest field never blocks it.
  const mixedWithoutBreakout = useMemo(
    () => yearPlantings.filter((p) => isMixedNoBreakout(p) && harvestStatusById.get(p.id) === 'complete'),
    [yearPlantings, harvestStatusById],
  )
  const mixedStillHarvesting = useMemo(
    () => yearPlantings.filter((p) => isMixedNoBreakout(p) && harvestStatusById.get(p.id) === 'in_progress'),
    [yearPlantings, harvestStatusById],
  )

  const isBlocked = mixedWithoutBreakout.length > 0 && !acceptedAsDryland

  // Resolve every planting into its sheet placement and split bushels. The
  // resolution depends on whether the user accepted the "roll into dryland"
  // option, so this only runs when we're past the gate.
  const resolved: Resolved[] = useMemo(() => {
    if (cropYear === '' || isBlocked) return []
    return yearPlantings.map<Resolved>((p) => {
      const fld = fieldById.get(p.field_id) ?? null
      const farm = fld?.farm_id ? (farmById.get(fld.farm_id) ?? null) : null
      const countyId = fld?.county_id ?? farm?.county_id ?? null
      const county = countyId ? countyById.get(countyId) : null
      const countyLabel = county ? `${county.name} County` : '(No County)'
      const irr = Number(p.irrigated_acres) || 0
      const dry = Number(p.dryland_acres) || 0
      const isMixed = irr > 0 && dry > 0
      const hasBreakout = p.yield_breakout_entered === true
      const totalBu = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)?.dryBu ?? 0
      let irrBu = 0
      let dryBu = 0
      if (isMixed && hasBreakout) {
        irrBu = p.irrigated_bushels != null ? Number(p.irrigated_bushels) : 0
        dryBu = p.dryland_bushels != null ? Number(p.dryland_bushels) : 0
      } else if (isMixed && !hasBreakout) {
        // User chose to roll into dryland — per spec, all production goes
        // to dryland but acres still split by the planting's columns.
        irrBu = 0
        dryBu = totalBu
      } else if (irr > 0 && dry === 0) {
        irrBu = totalBu
      } else {
        dryBu = totalBu
      }
      return {
        planting: p,
        field: fld,
        farm,
        countyId,
        countyLabel,
        irrigatedAcres: irr,
        drylandAcres: dry,
        totalBu,
        irrigatedBu: irrBu,
        drylandBu: dryBu,
        isMixed,
        hasBreakout,
        fieldDisplayName: fld?.name_or_number ?? '—',
      }
    })
  }, [yearPlantings, fieldById, farmById, countyById, aggByKey, cropYear, isBlocked])

  // Crops that actually appear in the selected year — these drive the
  // dynamic column set. Sorted by name for stable display.
  const reportCrops = useMemo<Crop[]>(() => {
    if (resolved.length === 0) return []
    const ids = new Set<string>()
    for (const r of resolved) {
      if (r.irrigatedAcres > 0 || r.drylandAcres > 0 || r.totalBu > 0) ids.add(r.planting.crop_id)
    }
    return crops.filter((c) => ids.has(c.id)).sort((a, b) => a.name.localeCompare(b.name))
  }, [resolved, crops])

  // Build the per-sheet aggregation.
  const detailSheets: DetailSheet[] = useMemo(() => {
    if (resolved.length === 0) return []
    // (countyId|practice) → DetailSheet
    const sheets = new Map<string, DetailSheet>()

    function ensureSheet(countyId: string | null, countyLabel: string, practice: Practice): DetailSheet {
      const key = `${countyId ?? NO_COUNTY_KEY}|${practice}`
      let s = sheets.get(key)
      if (!s) {
        s = {
          countyId,
          countyLabel,
          practice,
          sheetName: `${countyLabel} ${practiceLabel(practice)}`,
          farms: new Map(),
        }
        sheets.set(key, s)
      }
      return s
    }

    function putCell(sheet: DetailSheet, farm: Farm | null, cropId: string, acres: number, bu: number) {
      const farmKey = farm?.id ?? NO_FARM_KEY
      let entry = sheet.farms.get(farmKey)
      if (!entry) {
        entry = {
          farm,
          farmName: farm?.name ?? '(No Farm)',
          fsaNumber: farm?.fsa_number ?? null,
          byCrop: new Map(),
        }
        sheet.farms.set(farmKey, entry)
      }
      const c = entry.byCrop.get(cropId) ?? { acres: 0, bu: 0 }
      c.acres += acres
      c.bu += bu
      entry.byCrop.set(cropId, c)
    }

    for (const r of resolved) {
      // Irrigated half — only if the planting has irrigated acres.
      if (r.irrigatedAcres > 0) {
        const sheet = ensureSheet(r.countyId, r.countyLabel, 'irrigated')
        putCell(sheet, r.farm, r.planting.crop_id, r.irrigatedAcres, r.irrigatedBu)
      }
      // Dryland half.
      if (r.drylandAcres > 0) {
        const sheet = ensureSheet(r.countyId, r.countyLabel, 'dryland')
        putCell(sheet, r.farm, r.planting.crop_id, r.drylandAcres, r.drylandBu)
      }
    }

    // Drop farm rows with all-zero acres in every crop (shouldn't happen
    // because we only insert rows with acres > 0, but be defensive).
    const result: DetailSheet[] = []
    for (const s of sheets.values()) {
      const filteredFarms = new Map<string, typeof s.farms extends Map<string, infer V> ? V : never>()
      for (const [fk, fv] of s.farms) {
        const anyAcres = [...fv.byCrop.values()].some((c) => c.acres > 0)
        if (anyAcres) filteredFarms.set(fk, fv)
      }
      if (filteredFarms.size > 0) {
        s.farms = filteredFarms
        result.push(s)
      }
    }

    result.sort((a, b) => {
      const c = a.countyLabel.localeCompare(b.countyLabel)
      if (c !== 0) return c
      return a.practice.localeCompare(b.practice)
    })
    return result
  }, [resolved])

  const summaryRows: SummaryRow[] = useMemo(() => {
    return detailSheets.map((s) => {
      const byCrop = new Map<string, FarmCropCell>()
      for (const farm of s.farms.values()) {
        for (const [cropId, cell] of farm.byCrop) {
          const agg = byCrop.get(cropId) ?? { acres: 0, bu: 0 }
          agg.acres += cell.acres
          agg.bu += cell.bu
          byCrop.set(cropId, agg)
        }
      }
      return {
        sheetName: s.sheetName,
        countyId: s.countyId,
        countyLabel: s.countyLabel,
        practice: s.practice,
        byCrop,
      }
    })
  }, [detailSheets])

  // Grand totals row for the summary sheet.
  const summaryTotals = useMemo(() => {
    const byCrop = new Map<string, FarmCropCell>()
    for (const r of summaryRows) {
      for (const [cropId, cell] of r.byCrop) {
        const agg = byCrop.get(cropId) ?? { acres: 0, bu: 0 }
        agg.acres += cell.acres
        agg.bu += cell.bu
        byCrop.set(cropId, agg)
      }
    }
    return byCrop
  }, [summaryRows])

  // Switch back to summary tab when the available sheet list changes, so we
  // never linger on a tab that no longer exists.
  useEffect(() => {
    if (activeTab !== 'summary' && !detailSheets.some((s) => s.sheetName === activeTab)) {
      setActiveTab('summary')
    }
  }, [detailSheets, activeTab])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  // A viewer with no entity selected reports over their granted entities, and
  // the title/filter line must say so by name.
  const entityName = entityId
    ? (entities.find((e) => e.id === entityId)?.name ?? '')
    : (viewerAllEntitiesLabel(viewer, entities) ?? '')
  const entityOptions = entityOptionsFor(viewer, entities)
  const reportTitle = `${entityName ? entityName + ' ' : ''}${cropYear === '' ? '' : cropYear + ' '}Production Report`

  // Build the shared ExportPayload: a Summary section (one sheet) listing each
  // county × practice with per-crop acres/bu, then one section (sheet) per
  // county × practice detailing farms. Dynamic crop columns come from reportCrops.
  function buildPayload(): ExportPayload {
    // Mirror the on-screen grouped layout: three per-crop metric groups —
    // Certified Acres, Production, Yield/Acre — each spanning every crop, with
    // the crop name as the column header. (The screen shows all three; earlier
    // exports dropped Yield/Acre entirely.)
    const metricCols = (fmt: 'acres' | 'bu' | 'yield') =>
      reportCrops.map((c) => ({ label: c.name, align: 'right' as const, format: fmt }))
    const cropCols = (): ExportPayload['sections'][number]['columns'] =>
      [...metricCols('acres'), ...metricCols('bu'), ...metricCols('yield')]
    // Values for all three metrics across every crop. Blank where the screen is
    // blank — 0 acres / 0 bu render empty, and yield needs both to be positive.
    const metricCells = (byCrop: Map<string, FarmCropCell>): Array<string | number> => {
      const acres = reportCrops.map((c) => { const v = byCrop.get(c.id); return v && v.acres > 0 ? v.acres : '' })
      const bu = reportCrops.map((c) => { const v = byCrop.get(c.id); return v && v.bu > 0 ? v.bu : '' })
      const yld = reportCrops.map((c) => { const v = byCrop.get(c.id); return v && v.acres > 0 && v.bu > 0 ? v.bu / v.acres : '' })
      return [...acres, ...bu, ...yld]
    }
    const metricGroups = (acresLabel: string, prodLabel: string): ExportPayload['sections'][number]['groups'] =>
      reportCrops.length > 0
        ? [
            { label: '', span: 2 },
            { label: acresLabel, span: reportCrops.length },
            { label: prodLabel, span: reportCrops.length },
            { label: 'Yield/Acre (Bu. Or Lbs.)', span: reportCrops.length },
          ]
        : undefined

    const sections: ExportPayload['sections'] = []

    // Summary section.
    const summarySection: ExportPayload['sections'][number] = {
      title: 'Summary',
      columns: [{ label: 'County' }, { label: 'Practice' }, ...cropCols()],
      groups: metricGroups('Certified Acres', 'Production (Bu. Or Lbs.)'),
      rows: summaryRows.map((r) => [r.countyLabel, practiceLabel(r.practice), ...metricCells(r.byCrop)]),
      rowMeta: summaryRows.map(() => 'data' as const),
    }
    summarySection.rows.push(['Total', '', ...metricCells(summaryTotals)])
    summarySection.rowMeta!.push('total')
    sections.push(summarySection)

    // One detail section (sheet) per county × practice.
    for (const s of detailSheets) {
      const practice = practiceLabel(s.practice)
      const farms = [...s.farms.values()]
      const rows: Array<Array<string | number>> = farms.map((f) => [f.farmName, f.fsaNumber ?? '', ...metricCells(f.byCrop)])
      const totalByCrop = summaryRows.find((r) => r.sheetName === s.sheetName)?.byCrop ?? new Map()
      rows.push(['Total', '', ...metricCells(totalByCrop)])
      sections.push({
        title: s.sheetName,
        columns: [{ label: 'Farm' }, { label: 'FSA #' }, ...cropCols()],
        groups: metricGroups(`Certified ${practice} Acres`, `${practice} Production (Bu. Or Lbs.)`),
        rows,
        rowMeta: [...farms.map(() => 'data' as const), 'total'],
      })
    }

    return {
      title: reportTitle,
      filters: [
        cropYear === '' ? 'All crop years' : `${cropYear} crop`,
        entityName || 'All entities',
        cropIds.length === 0 ? 'All crops' : cropIds.map((id) => cropById.get(id)?.name ?? '').filter(Boolean).join(', '),
      ].join(' · '),
      sections,
    }
  }

  async function onExportExcel() {
    setExportErr(null)
    setExporting('xlsx')
    try {
      await exportToExcel(buildPayload())
    } catch (e) {
      setExportErr((e as Error)?.message ?? 'Excel export failed.')
    } finally {
      setExporting(null)
    }
  }

  async function onExportPdf() {
    setExportErr(null)
    setExporting('pdf')
    try {
      await exportToPdf(buildPayload())
    } catch (e) {
      setExportErr((e as Error)?.message ?? 'PDF export failed.')
    } finally {
      setExporting(null)
    }
  }

  function onPrint() {
    if (typeof window !== 'undefined') window.print()
  }

  // Hold the report until the viewer scope/overrides resolve too, so a viewer
  // never sees a flash of unresolved numbers. Inert timing for owners.
  if (loading || viewer.loading || !viewerA.ready) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4">
      {/* Filter strip — hidden when printing. */}
      <div className="flex flex-wrap gap-3 items-end no-print">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year *</span>
          <select
            value={cropYear}
            onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))}
            className={inputCls}
          >
            <option value="">— pick a crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
        {/* A viewer with a single grant has nothing to switch between (the
            EntityFilter component's <=1 hide rule); owners keep the select. */}
        {(!viewer.isViewer || entityOptions.length > 1) && (
          <label className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Entity (optional)</span>
            <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
              <option value="">All entities</option>
              {entityOptions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
        )}
        {cropFilterOptions.length > 0 && (
          <div className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Crops (optional)</span>
            <div className="flex flex-wrap gap-1.5 items-center">
              {cropFilterOptions.map((c) => {
                const on = cropIds.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCropIds((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                    className={
                      on
                        ? 'rounded-full bg-brand hover:bg-brand-deep text-white px-3 py-1.5 text-xs font-semibold'
                        : 'rounded-full bg-white border border-slate-300 text-slate-700 px-3 py-1.5 text-xs'
                    }
                  >
                    {c.name}
                  </button>
                )
              })}
              {cropIds.length > 0 && (
                <button type="button" onClick={() => setCropIds([])} className="text-xs text-slate-500 underline px-1">
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onExportExcel}
            disabled={cropYear === '' || isBlocked || detailSheets.length === 0 || exporting != null}
            className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {exporting === 'xlsx' ? 'Exporting…' : 'Export Excel'}
          </button>
          <button
            type="button"
            onClick={onExportPdf}
            disabled={cropYear === '' || isBlocked || detailSheets.length === 0 || exporting != null}
            className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
          </button>
          <button
            type="button"
            onClick={onPrint}
            disabled={cropYear === '' || isBlocked || detailSheets.length === 0}
            className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
          >
            Print
          </button>
        </div>
      </div>
      <SupersededNotice show={viewerA.superseded} onDismiss={viewerA.dismissSuperseded} />
      {exportErr && <p className="text-sm text-red-600 no-print">{exportErr}</p>}

      {cropYear === '' && (
        <p className="text-amber-700 text-sm">Pick a crop year to run the report.</p>
      )}

      {/* Mixed-practice gate. */}
      {cropYear !== '' && mixedWithoutBreakout.length > 0 && !acceptedAsDryland && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-3 no-print">
          <div className="font-semibold text-amber-900">
            Production breakout needed for {mixedWithoutBreakout.length} mixed-practice planting
            {mixedWithoutBreakout.length === 1 ? '' : 's'}
          </div>
          <p className="text-sm text-amber-900">
            The following harvested fields have both irrigated and dryland acres but no
            production breakout. Either enter the breakout on the Yields page, or generate
            the report with all production rolled into the dryland sheet. Fields still
            being harvested won&apos;t appear here until their harvest is complete.
          </p>
          <ul className="text-sm text-amber-900 list-disc ml-6">
            {mixedWithoutBreakout.map((p) => {
              const fld = fieldById.get(p.field_id)
              const crop = cropById.get(p.crop_id)
              return (
                <li key={p.id}>
                  {fld?.name_or_number ?? '—'} — {crop?.name ?? '—'} (
                  {Number(p.irrigated_acres)} irr / {Number(p.dryland_acres)} dry ac)
                </li>
              )
            })}
          </ul>
          <div className="flex gap-2 flex-wrap">
            <Link
              href="/yields?breakout=1"
              className="rounded-lg bg-sky-700 text-white px-3 py-2 text-sm font-semibold"
            >
              Enter breakouts on Yields →
            </Link>
            <button
              type="button"
              onClick={() => setAcceptedAsDryland(true)}
              className="rounded-lg bg-amber-700 text-white px-3 py-2 text-sm font-semibold"
            >
              Generate as dryland
            </button>
          </div>
        </div>
      )}

      {/* Still-harvesting mixed fields: excluded from the gate (and not blocking),
          noted so the user knows why they aren't in the breakout prompt. */}
      {cropYear !== '' && mixedStillHarvesting.length > 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 no-print">
          <div className="font-semibold text-slate-700">
            {mixedStillHarvesting.length} mixed-practice field{mixedStillHarvesting.length === 1 ? '' : 's'} still harvesting — excluded
          </div>
          <p className="text-sm text-slate-600">
            These have both irrigated and dryland acres but harvest isn&apos;t complete, so they don&apos;t
            need a breakout yet and won&apos;t block the report. Their production rolls into dryland for now;
            enter the breakout on the Yields page once harvest finishes. If a field here is actually
            done, use Count anyway to treat its bushels as final.
          </p>
          {overrideErr && <p className="text-sm text-red-700">{overrideErr}</p>}
          <ul className="text-sm text-slate-600 list-disc ml-6">
            {mixedStillHarvesting.map((p) => {
              const fld = fieldById.get(p.field_id)
              const crop = cropById.get(p.crop_id)
              return (
                <li key={p.id}>
                  {fld?.name_or_number ?? '—'} — {crop?.name ?? '—'} (
                  {Number(p.irrigated_acres)} irr / {Number(p.dryland_acres)} dry ac)
                  {roleCanEditYields(viewer.role) && (
                    <button
                      type="button"
                      disabled={overrideSavingId === p.id}
                      onClick={() => countAnyway(p)}
                      className="ml-2 text-brand-deep underline disabled:opacity-50"
                    >Count anyway</button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {cropYear !== '' && !isBlocked && detailSheets.length === 0 && (
        <EmptyState
          message={
            cropIds.length > 0
              ? `No plantings with acres for the selected crop${cropIds.length === 1 ? '' : 's'} in ${cropYear}.`
              : `No plantings with acres for ${cropYear}.`
          }
          linkHref="/settings/plantings"
          linkLabel="Add field plantings"
        />
      )}

      {cropYear !== '' && !isBlocked && detailSheets.length > 0 && (
        <>
          {/* Tab bar. */}
          <div className="flex flex-wrap gap-1 border-b border-slate-200 no-print">
            <TabButton active={activeTab === 'summary'} onClick={() => setActiveTab('summary')}>Summary</TabButton>
            {detailSheets.map((s) => (
              <TabButton
                key={s.sheetName}
                active={activeTab === s.sheetName}
                onClick={() => setActiveTab(s.sheetName)}
              >
                {s.sheetName}
              </TabButton>
            ))}
          </div>

          {/* Tabbed body — only one visible at a time on screen, but all
              rendered when printing so every sheet ends up in the PDF.   */}
          <div className="print-area space-y-6">
            <SheetCard
              hidden={activeTab !== 'summary'}
              title="Summary"
              subtitle={reportTitle}
            >
              <SummaryTable
                reportCrops={reportCrops}
                summaryRows={summaryRows}
                summaryTotals={summaryTotals}
              />
            </SheetCard>
            {detailSheets.map((s) => (
              <SheetCard
                key={s.sheetName}
                hidden={activeTab !== s.sheetName}
                title={s.sheetName}
                subtitle={reportTitle}
              >
                <DetailTable sheet={s} reportCrops={reportCrops} />
              </SheetCard>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function TabButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'px-3 py-2 text-sm font-semibold border-b-2 border-slate-900 -mb-px'
          : 'px-3 py-2 text-sm text-slate-600 border-b-2 border-transparent hover:text-slate-900'
      }
    >
      {children}
    </button>
  )
}

function SheetCard({
  title, subtitle, hidden, children,
}: {
  title: string
  subtitle: string
  hidden: boolean
  children: React.ReactNode
}) {
  // Each sheet is its own page in print, even when hidden on screen.
  return (
    <section
      className={`bg-white rounded-xl shadow p-4 ${hidden ? 'hidden print:block' : ''} print:break-before-page first:print:break-before-auto avoid-break`}
    >
      <div className="mb-3">
        <h2 className="font-bold text-lg">{title}</h2>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function SummaryTable({
  reportCrops, summaryRows, summaryTotals,
}: {
  reportCrops: Crop[]
  summaryRows: SummaryRow[]
  summaryTotals: Map<string, FarmCropCell>
}) {
  return (
    <table className="min-w-full text-sm border-collapse">
      <thead className={theadCls}>
        <tr>
          <th rowSpan={2} className="border border-slate-300 bg-slate-100 px-2 py-1 text-left align-bottom">
            County / Practice
          </th>
          <th colSpan={reportCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Certified Acres
          </th>
          <th colSpan={reportCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Production (Bu. Or Lbs.)
          </th>
          <th colSpan={reportCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Yield/Acre (Bu. Or Lbs.)
          </th>
        </tr>
        <tr>
          {[...reportCrops, ...reportCrops, ...reportCrops].map((c, i) => (
            <th key={i} className="border border-slate-300 bg-slate-50 px-2 py-1 text-center">{c.name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {summaryRows.map((row) => (
          <tr key={row.sheetName} className="border-t border-slate-100">
            <td className="border border-slate-200 px-2 py-1 font-semibold">{row.sheetName}</td>
            {reportCrops.map((c) => {
              const v = row.byCrop.get(c.id)
              return <td key={`a-${c.id}`} className="border border-slate-200 px-2 py-1 text-right font-mono tabular-nums">
                {v && v.acres > 0 ? fmt(v.acres) : ''}
              </td>
            })}
            {reportCrops.map((c) => {
              const v = row.byCrop.get(c.id)
              return <td key={`b-${c.id}`} className="border border-slate-200 px-2 py-1 text-right font-mono tabular-nums">
                {v && v.bu > 0 ? fmt(v.bu) : ''}
              </td>
            })}
            {reportCrops.map((c) => {
              const v = row.byCrop.get(c.id)
              const yld = v && v.acres > 0 && v.bu > 0 ? v.bu / v.acres : null
              return <td key={`y-${c.id}`} className="border border-slate-200 px-2 py-1 text-right font-mono tabular-nums">
                {yld != null ? yld.toFixed(1) : ''}
              </td>
            })}
          </tr>
        ))}
        <tr className={`border-t-2 border-slate-400 ${grandTotalRowCls}`}>
          <td className="border border-slate-300 px-2 py-1">Total</td>
          {reportCrops.map((c) => {
            const v = summaryTotals.get(c.id)
            return <td key={`ta-${c.id}`} className="border border-slate-300 px-2 py-1 text-right font-mono tabular-nums">
              {v && v.acres > 0 ? fmt(v.acres) : ''}
            </td>
          })}
          {reportCrops.map((c) => {
            const v = summaryTotals.get(c.id)
            return <td key={`tb-${c.id}`} className="border border-slate-300 px-2 py-1 text-right font-mono tabular-nums">
              {v && v.bu > 0 ? fmt(v.bu) : ''}
            </td>
          })}
          {reportCrops.map((c) => {
            const v = summaryTotals.get(c.id)
            const yld = v && v.acres > 0 && v.bu > 0 ? v.bu / v.acres : null
            return <td key={`ty-${c.id}`} className="border border-slate-300 px-2 py-1 text-right font-mono tabular-nums">
              {yld != null ? yld.toFixed(1) : ''}
            </td>
          })}
        </tr>
      </tbody>
    </table>
  )
}

function DetailTable({ sheet, reportCrops }: { sheet: DetailSheet; reportCrops: Crop[] }) {
  const practice = practiceLabel(sheet.practice)
  // Only crops that have any acres in THIS sheet — keeps each county sheet
  // narrow. (A field's irrigated-only crop won't show on the dryland sheet.)
  const sheetCrops = useMemo(() => {
    const ids = new Set<string>()
    for (const farm of sheet.farms.values()) {
      for (const [cid, cell] of farm.byCrop) {
        if (cell.acres > 0) ids.add(cid)
      }
    }
    return reportCrops.filter((c) => ids.has(c.id))
  }, [sheet, reportCrops])

  const farmRows = useMemo(
    () => [...sheet.farms.values()].sort((a, b) => a.farmName.localeCompare(b.farmName)),
    [sheet],
  )

  // Per-sheet column totals (used for the total row).
  const totalsByCrop = useMemo(() => {
    const m = new Map<string, FarmCropCell>()
    for (const farm of sheet.farms.values()) {
      for (const [cid, cell] of farm.byCrop) {
        const agg = m.get(cid) ?? { acres: 0, bu: 0 }
        agg.acres += cell.acres
        agg.bu += cell.bu
        m.set(cid, agg)
      }
    }
    return m
  }, [sheet])

  return (
    <table className="min-w-full text-sm border-collapse">
      <thead className={theadCls}>
        <tr>
          <th rowSpan={2} className="border border-slate-300 bg-slate-100 px-2 py-1 text-left align-bottom">Farm Name</th>
          <th rowSpan={2} className="border border-slate-300 bg-slate-100 px-2 py-1 text-left align-bottom">Farm #</th>
          <th colSpan={sheetCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Certified {practice} Acres
          </th>
          <th colSpan={sheetCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            {practice} Production (Bu. Or Lbs.)
          </th>
          <th colSpan={sheetCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Yield/Acre (Bu. Or Lbs.)
          </th>
        </tr>
        <tr>
          {[...sheetCrops, ...sheetCrops, ...sheetCrops].map((c, i) => (
            <th key={i} className="border border-slate-300 bg-slate-50 px-2 py-1 text-center">{c.name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {farmRows.map((farm) => (
          <tr key={farm.farmName + (farm.fsaNumber ?? '')} className="border-t border-slate-100">
            <td className="border border-slate-200 px-2 py-1 font-semibold">{farm.farmName}</td>
            <td className="border border-slate-200 px-2 py-1 font-mono text-xs">{farm.fsaNumber ?? ''}</td>
            {sheetCrops.map((c) => {
              const cell = farm.byCrop.get(c.id)
              return <td key={`a-${c.id}`} className="border border-slate-200 px-2 py-1 text-right font-mono tabular-nums">
                {cell && cell.acres > 0 ? fmt(cell.acres) : ''}
              </td>
            })}
            {sheetCrops.map((c) => {
              const cell = farm.byCrop.get(c.id)
              return <td key={`b-${c.id}`} className="border border-slate-200 px-2 py-1 text-right font-mono tabular-nums">
                {cell && cell.bu > 0 ? fmt(cell.bu) : ''}
              </td>
            })}
            {sheetCrops.map((c) => {
              const cell = farm.byCrop.get(c.id)
              const yld = cell && cell.acres > 0 && cell.bu > 0 ? cell.bu / cell.acres : null
              return <td key={`y-${c.id}`} className="border border-slate-200 px-2 py-1 text-right font-mono tabular-nums">
                {yld != null ? yld.toFixed(1) : ''}
              </td>
            })}
          </tr>
        ))}
        <tr className={`border-t-2 border-slate-400 ${grandTotalRowCls}`}>
          <td colSpan={2} className="border border-slate-300 px-2 py-1">Total</td>
          {sheetCrops.map((c) => {
            const t = totalsByCrop.get(c.id)
            return <td key={`ta-${c.id}`} className="border border-slate-300 px-2 py-1 text-right font-mono tabular-nums">
              {t && t.acres > 0 ? fmt(t.acres) : ''}
            </td>
          })}
          {sheetCrops.map((c) => {
            const t = totalsByCrop.get(c.id)
            return <td key={`tb-${c.id}`} className="border border-slate-300 px-2 py-1 text-right font-mono tabular-nums">
              {t && t.bu > 0 ? fmt(t.bu) : ''}
            </td>
          })}
          {sheetCrops.map((c) => {
            const t = totalsByCrop.get(c.id)
            const yld = t && t.acres > 0 && t.bu > 0 ? t.bu / t.acres : null
            return <td key={`ty-${c.id}`} className="border border-slate-300 px-2 py-1 text-right font-mono tabular-nums">
              {yld != null ? yld.toFixed(1) : ''}
            </td>
          })}
        </tr>
      </tbody>
    </table>
  )
}

export type { DetailSheet, SummaryRow, FarmCropCell }
