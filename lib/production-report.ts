// Crop Insurance Production Report — the ENGINE, pure.
//
// components/reports/crop-insurance-report.tsx renders this; the audit
// workbook (lib/production-audit-workbook.ts) rebuilds every number here as a
// live Excel formula and reconciles against it. Keep the rules in one place:
//
//   * Production per planting (grain): dry bushels from field-sourced loads
//     and split portions — lib/yields fieldCropAggregates (shrink per
//     lib/shrink; a combine entry (062) REPLACES the field's figure and nets
//     the weighed loads inside it). Cotton (module on): lint lbs — gin
//     receipts (bale rows, else the receipt's stated bale weight) plus the
//     turnout estimate on picked-but-unginned seed cotton.
//   * Practice: a pure-irrigated / pure-dryland planting puts everything on
//     its side. A MIXED planting (both acre columns > 0) uses its breakout —
//     the Yields-page manual allocation, or the load-derived split when every
//     counted load/portion carries a practice tag (withLoadBreakouts) — taking
//     irrigated_bushels / dryland_bushels AS ENTERED. A mixed planting with no
//     breakout gates the report once harvest is complete; "Generate as
//     dryland" rolls its production into dryland (acres still split).
//   * Certified acres = the planting's irrigated_acres / dryland_acres.
//     County = the field's county, else the farm's; state from the county.
//   * Harvest in progress: a planting still classified in_progress by the
//     Yields rules (analyzeYields + the crop-level harvest-complete flag +
//     "count anyway") is LEFT OUT — acres and production — because its partial
//     bushels would certify a misleading yield. It is listed on screen with a
//     Count anyway button. A planting with no production yet keeps its acres
//     (production blank), exactly as before.
//   * Filters: crop year (plantings.season_year and loads.crop_year), entity
//     (the field's farm's entity), and the crop multi-select.

import {
  analyzeYields, buildYieldInputs, fieldCropAggregates, harvestStatusOf, withLoadBreakouts,
  type CombineEntryLike, type CottonYieldAdapter, type ExpectedYieldAssumption, type FieldCropAgg, type HarvestStatus,
} from '@/lib/yields'
import { buildDoubleCropSet } from '@/lib/plantings'
import { isCottonCrop } from '@/lib/marketing'
import type { County, Crop, Farm, Field, FieldPlanting, LoadSplit } from '@/lib/types'

/** The load columns the engine reads (the audit workbook reads more). */
export type ProductionLoadRow = {
  id: string
  date: string
  time?: string | null
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
  practice?: 'irrigated' | 'dryland' | null
}

export type Practice = 'irrigated' | 'dryland'

/** What the engine needs from the cotton yield model (lib/cotton-yield-sources). */
export type ProductionCottonModel = {
  on: boolean | null
  cottonCropIds: Set<string>
  adapter: CottonYieldAdapter | null
  yieldFor: (p: { field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null }) => { lintLbs: number } | null
}

export type ProductionReportInput = {
  cropYear: number | ''
  entityId: string
  cropIds: readonly string[]
  plantings: readonly FieldPlanting[]
  fields: readonly Field[]
  farms: readonly Farm[]
  counties: readonly County[]
  crops: readonly Crop[]
  loads: readonly ProductionLoadRow[]
  splits: readonly LoadSplit[]
  combineEntries: readonly CombineEntryLike[]
  /** Effective crop_assumptions rows (viewer overrides already applied). */
  assumptions: ReadonlyArray<ExpectedYieldAssumption & { harvest_complete?: boolean | null }>
  cotton: ProductionCottonModel
  /** The user accepted "Generate as dryland" for mixed plantings without a breakout. */
  acceptedAsDryland: boolean
  /** Clock for the harvest-status rules (tests pin it). */
  now?: Date
}

/** How a planting's production was split between practices. */
export type BreakoutKind = 'single' | 'entered' | 'loads' | 'rolled_dryland'

// One resolved planting with its sheet placement and split bushels.
export type Resolved = {
  planting: FieldPlanting
  field: Field | null
  farm: Farm | null
  countyId: string | null
  countyLabel: string
  county: County | null
  irrigatedAcres: number
  drylandAcres: number
  totalBu: number
  irrigatedBu: number
  drylandBu: number
  isMixed: boolean
  hasBreakout: boolean
  breakout: BreakoutKind
  /** 'scale' = loads (and splits); 'combine' = a combine entry is the authority; 'cotton' = lint lbs. */
  source: 'scale' | 'combine' | 'cotton'
  fieldDisplayName: string
  harvestStatus: HarvestStatus
  /** In progress by the automatic rules but counted on the user's "count anyway". */
  countedAnyway: boolean
  agg: FieldCropAgg | null
}

// Per-cell aggregate inside a sheet: one farm + one crop.
export type FarmCropCell = { acres: number; bu: number }

// One detail sheet (county + practice).
export type DetailSheet = {
  countyId: string | null
  countyLabel: string
  county: County | null
  practice: Practice
  sheetName: string
  farms: Map<string, { farm: Farm | null; farmName: string; fsaNumber: string | null; byCrop: Map<string, FarmCropCell> }>
}

// Summary row: one (county, practice) line.
export type SummaryRow = {
  sheetName: string
  countyId: string | null
  countyLabel: string
  county: County | null
  practice: Practice
  byCrop: Map<string, FarmCropCell>
}

export type ProductionReport = {
  /** Plantings in the year + entity filter (before the crop filter). */
  yearEntityPlantings: FieldPlanting[]
  /** Crops present in the year + entity (the crop-filter options). */
  cropFilterOptions: Crop[]
  /** Plantings after the crop filter, with load-derived breakouts materialized. */
  yearPlantings: FieldPlanting[]
  aggByKey: Map<string, FieldCropAgg>
  harvestStatusById: Map<string, HarvestStatus>
  /** Mixed, no breakout, harvest complete — these gate the report. */
  mixedWithoutBreakout: FieldPlanting[]
  /** Still-harvesting plantings — left out of the report, listed with Count anyway. */
  inProgress: FieldPlanting[]
  isBlocked: boolean
  resolved: Resolved[]
  reportCrops: Crop[]
  detailSheets: DetailSheet[]
  summaryRows: SummaryRow[]
  summaryTotals: Map<string, FarmCropCell>
}

export const NO_COUNTY_KEY = '__no_county__'
export const NO_FARM_KEY = '__no_farm__'

export function practiceLabel(p: Practice): string {
  return p === 'irrigated' ? 'Irrigated' : 'Dryland'
}

/** The unit a crop's production and yield carry: lint lbs for cotton, bushels otherwise. */
export function unitOf(crop: Pick<Crop, 'name'>): 'bu' | 'lbs' {
  return isCottonCrop(crop.name) ? 'lbs' : 'bu'
}

export function isMixedNoBreakout(p: Pick<FieldPlanting, 'irrigated_acres' | 'dryland_acres' | 'yield_breakout_entered'>): boolean {
  return (Number(p.irrigated_acres) || 0) > 0 && (Number(p.dryland_acres) || 0) > 0 && !p.yield_breakout_entered
}

export function buildProductionReport(input: ProductionReportInput): ProductionReport {
  const { cropYear, entityId, cropIds } = input
  const cropById = new Map(input.crops.map((c) => [c.id, c]))
  const fieldById = new Map(input.fields.map((f) => [f.id, f]))
  const farmById = new Map(input.farms.map((f) => [f.id, f]))
  const countyById = new Map(input.counties.map((c) => [c.id, c]))

  // (fieldId|cropId|year) → { dryBu, lastLoadDate, … } — the same allocation
  // as the Yields page (combine entries replace a field's figure).
  const aggByKey = fieldCropAggregates(input.loads, input.splits, cropById, {
    cropYear: cropYear === '' ? null : cropYear,
    combineEntries: input.combineEntries,
  })

  // Plantings matching the year + entity filter (before the crop filter).
  const yearEntityPlantings = cropYear === '' ? [] : input.plantings.filter((p) => {
    if (p.season_year !== cropYear) return false
    const fld = fieldById.get(p.field_id)
    const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
    if (entityId && farm?.entity_id !== entityId) return false
    return true
  })
  const presentCropIds = new Set(yearEntityPlantings.map((p) => p.crop_id))
  const cropFilterOptions = input.crops.filter((c) => presentCropIds.has(c.id))

  // The crop filter, then the load-derived breakout materialized onto mixed
  // plantings whose counted loads are all practice-tagged.
  const yearPlantings = withLoadBreakouts(
    cropIds.length === 0 ? yearEntityPlantings : yearEntityPlantings.filter((p) => cropIds.includes(p.crop_id)),
    aggByKey,
  )

  // Crop + year combos flagged harvest-complete at the crop level.
  const cropCompleteKeys = new Set<string>()
  for (const a of input.assumptions) if (a.harvest_complete) cropCompleteKeys.add(`${a.crop_id}|${a.crop_year}`)

  // Field-level harvest status per planting, by the same rule the Yields page
  // uses. Cohorts come from EVERY planting (the wheat that makes a bean field
  // double-cropped is not in the year's crop filter).
  const doubleCropIds = buildDoubleCropSet(input.plantings, cropById)
  const analysis = analyzeYields(
    buildYieldInputs({ plantings: yearPlantings, aggByKey, assumptions: input.assumptions, cotton: input.cotton.adapter, doubleCropIds }),
    undefined,
    input.now,
  )
  const harvestStatusById = new Map<string, HarvestStatus>()
  for (const p of yearPlantings) harvestStatusById.set(p.id, harvestStatusOf(p, analysis.excluded, cropCompleteKeys))

  const mixedWithoutBreakout = yearPlantings.filter((p) => isMixedNoBreakout(p) && harvestStatusById.get(p.id) === 'complete')
  const inProgress = yearPlantings.filter((p) => harvestStatusById.get(p.id) === 'in_progress')
  const isBlocked = mixedWithoutBreakout.length > 0 && !input.acceptedAsDryland

  const originalById = new Map(input.plantings.map((p) => [p.id, p]))
  const resolved: Resolved[] = cropYear === '' || isBlocked ? [] : yearPlantings
    .filter((p) => harvestStatusById.get(p.id) !== 'in_progress')
    .map<Resolved>((p) => {
      const fld = fieldById.get(p.field_id) ?? null
      const farm = fld?.farm_id ? (farmById.get(fld.farm_id) ?? null) : null
      const countyId = fld?.county_id ?? farm?.county_id ?? null
      const county = countyId ? (countyById.get(countyId) ?? null) : null
      const countyLabel = county ? `${county.name} County` : '(No County)'
      const irr = Number(p.irrigated_acres) || 0
      const dry = Number(p.dryland_acres) || 0
      const isMixed = irr > 0 && dry > 0
      const hasBreakout = p.yield_breakout_entered === true
      const agg = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`) ?? null
      const isCotton = input.cotton.cottonCropIds.has(p.crop_id) && input.cotton.on === true
      const totalBu = isCotton ? (input.cotton.yieldFor(p)?.lintLbs ?? 0) : (agg?.dryBu ?? 0)
      // Where the breakout came from: the ORIGINAL planting row says whether
      // the user entered it; withLoadBreakouts set the flag for load-derived ones.
      const original = originalById.get(p.id)
      let irrBu = 0
      let dryBu = 0
      let breakout: BreakoutKind
      if (isMixed && hasBreakout) {
        irrBu = p.irrigated_bushels != null ? Number(p.irrigated_bushels) : 0
        dryBu = p.dryland_bushels != null ? Number(p.dryland_bushels) : 0
        breakout = original?.yield_breakout_entered ? 'entered' : 'loads'
      } else if (isMixed && !hasBreakout) {
        // "Generate as dryland": all production to dryland, acres still split.
        irrBu = 0
        dryBu = totalBu
        breakout = 'rolled_dryland'
      } else if (irr > 0 && dry === 0) {
        irrBu = totalBu
        breakout = 'single'
      } else {
        dryBu = totalBu
        breakout = 'single'
      }
      const status = harvestStatusById.get(p.id) ?? 'complete'
      return {
        planting: p,
        field: fld,
        farm,
        countyId,
        countyLabel,
        county,
        irrigatedAcres: irr,
        drylandAcres: dry,
        totalBu,
        irrigatedBu: irrBu,
        drylandBu: dryBu,
        isMixed,
        hasBreakout,
        breakout,
        source: isCotton ? 'cotton' : agg?.combine ? 'combine' : 'scale',
        fieldDisplayName: fld?.name_or_number ?? '—',
        harvestStatus: status,
        countedAnyway: status === 'complete' && p.yield_include_override === true && analysis.autoExcluded.get(p.id) === 'in_progress',
        agg,
      }
    })

  // Crops that actually appear — the dynamic column set, name order.
  const reportCropIds = new Set<string>()
  for (const r of resolved) if (r.irrigatedAcres > 0 || r.drylandAcres > 0 || r.totalBu > 0) reportCropIds.add(r.planting.crop_id)
  const reportCrops = input.crops.filter((c) => reportCropIds.has(c.id)).sort((a, b) => a.name.localeCompare(b.name))

  // Per-sheet aggregation: (county|practice) → farms → crops.
  const sheets = new Map<string, DetailSheet>()
  const ensureSheet = (r: Resolved, practice: Practice): DetailSheet => {
    const key = `${r.countyId ?? NO_COUNTY_KEY}|${practice}`
    let s = sheets.get(key)
    if (!s) {
      s = { countyId: r.countyId, countyLabel: r.countyLabel, county: r.county, practice, sheetName: `${r.countyLabel} ${practiceLabel(practice)}`, farms: new Map() }
      sheets.set(key, s)
    }
    return s
  }
  const putCell = (sheet: DetailSheet, farm: Farm | null, cropId: string, acres: number, bu: number) => {
    const farmKey = farm?.id ?? NO_FARM_KEY
    let entry = sheet.farms.get(farmKey)
    if (!entry) {
      entry = { farm, farmName: farm?.name ?? '(No Farm)', fsaNumber: farm?.fsa_number ?? null, byCrop: new Map() }
      sheet.farms.set(farmKey, entry)
    }
    const c = entry.byCrop.get(cropId) ?? { acres: 0, bu: 0 }
    c.acres += acres
    c.bu += bu
    entry.byCrop.set(cropId, c)
  }
  for (const r of resolved) {
    if (r.irrigatedAcres > 0) putCell(ensureSheet(r, 'irrigated'), r.farm, r.planting.crop_id, r.irrigatedAcres, r.irrigatedBu)
    if (r.drylandAcres > 0) putCell(ensureSheet(r, 'dryland'), r.farm, r.planting.crop_id, r.drylandAcres, r.drylandBu)
  }
  const detailSheets: DetailSheet[] = []
  for (const s of sheets.values()) {
    const filteredFarms = new Map<string, DetailSheet['farms'] extends Map<string, infer V> ? V : never>()
    for (const [fk, fv] of s.farms) {
      if ([...fv.byCrop.values()].some((c) => c.acres > 0)) filteredFarms.set(fk, fv)
    }
    if (filteredFarms.size > 0) {
      s.farms = filteredFarms
      detailSheets.push(s)
    }
  }
  detailSheets.sort((a, b) => a.countyLabel.localeCompare(b.countyLabel) || a.practice.localeCompare(b.practice))

  const summaryRows: SummaryRow[] = detailSheets.map((s) => {
    const byCrop = new Map<string, FarmCropCell>()
    for (const farm of s.farms.values()) {
      for (const [cropId, cell] of farm.byCrop) {
        const agg = byCrop.get(cropId) ?? { acres: 0, bu: 0 }
        agg.acres += cell.acres
        agg.bu += cell.bu
        byCrop.set(cropId, agg)
      }
    }
    return { sheetName: s.sheetName, countyId: s.countyId, countyLabel: s.countyLabel, county: s.county, practice: s.practice, byCrop }
  })

  const summaryTotals = new Map<string, FarmCropCell>()
  for (const r of summaryRows) {
    for (const [cropId, cell] of r.byCrop) {
      const agg = summaryTotals.get(cropId) ?? { acres: 0, bu: 0 }
      agg.acres += cell.acres
      agg.bu += cell.bu
      summaryTotals.set(cropId, agg)
    }
  }

  return {
    yearEntityPlantings, cropFilterOptions, yearPlantings, aggByKey, harvestStatusById,
    mixedWithoutBreakout, inProgress, isBlocked, resolved, reportCrops, detailSheets, summaryRows, summaryTotals,
  }
}
