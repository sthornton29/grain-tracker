// Crop Insurance Production Report — the AUDIT WORKBOOK (Excel export).
//
// Builds an ExportPayload whose summary numbers are LIVE FORMULAS tracing back
// to the loads: Load Data (one row per counted load portion) → Field
// Production (one row per planting × practice, SUMIFS over Load Data by
// planting key) → Summary (SUMIFS over Field Production by county / state /
// crop / practice). An auditor can click any Summary cell, follow the SUMIFS
// to the field row, then to the exact loads, and change a load to watch the
// totals move. Every rule the engine (lib/production-report.ts) applies is
// written here as a formula; where a rule is really an input (a manual
// override, an entered breakout, a combine entry) the input is a BLUE cell
// and the formula around it stays black. The on-screen report and the PDF
// are untouched — this is the Excel button only.
//
// Shrink (lib/shrink.ts), exactly as the app computes a load:
//   wet bu  = net lbs applied ÷ lb per bushel
//   dry bu  = wet bu                                   when moisture ≤ base (or no moisture)
//           = wet bu × (100 − moisture) ÷ (100 − base) when moisture > base
//   A split portion's dry bushels are stored rounded to 2 decimals
//   (lib/load-splits allocateSplits), so its row ROUNDs; a whole load is not
//   rounded. A manual dry-bushel override replaces the computed figure (blue,
//   "manual override"); a parent load's override is NOT redistributed to its
//   split portions (the app stores each portion's own computed figure).
// Combine entries (062): the entry's adjusted total IS the field's
//   production; the weighed loads from that field are netted inside it (they
//   are listed on Load Data and summed in the field row for the record, but
//   the row's production is the combine figure).
// Cotton: lint lbs = Σ receipts (bale rows' weights when any, else the
//   receipt's stated bale weight) + picked-but-unginned seed cotton × the
//   resolved turnout, the estimate in its own row marked "estimated, not ginned".

import { computeBushels } from '@/lib/shrink'
import { truckExportLabel } from '@/lib/trucks'
import { evaluatePayload, type ExportCell, type ExportColumn, type ExportPayload, type ExportSection, type NumFmt } from '@/lib/exports'
import {
  abs, add, cell, col, div, iferror, iff, le, lt, mul, num, round, self, str, sub, sum, sumifs, gt, rows as rowsRange,
  type FormulaNode, type RangeNode,
} from '@/lib/formula'
import { practiceLabel, unitOf, type Practice, type ProductionLoadRow, type ProductionReport, type Resolved } from '@/lib/production-report'
import type { CombineEntryLike } from '@/lib/yields'
import type { LoadSale } from '@/lib/load-sales'
import type { County, Crop, Farm, Field, LoadSplit } from '@/lib/types'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The load columns the workbook lists (a superset of what the engine reads). */
export type AuditLoadRow = ProductionLoadRow & {
  gross_weight?: number | null
  tare_weight?: number | null
  test_weight?: number | null
  ticket_number?: string | null
  truck_id?: string | null
  truck_label?: string | null
  hauler_truck?: string | null
  to_type?: 'bin' | 'buyer' | null
  to_bin_id?: string | null
  to_buyer_id?: string | null
}

export type AuditCottonReceipt = {
  id: string
  gin_id: string | null
  receipt_number: string
  statement_number?: string | null
  receipt_date: string | null
  farm_id?: string | null
  field_id: string | null
  crop_year: number
  modules_count?: number | null
  total_seed_cotton_weight: number | string | null
  bales_count: number | null
  total_bale_weight: number | string | null
}

export type AuditCottonSources = {
  receipts: readonly AuditCottonReceipt[]
  bales: ReadonlyArray<{ id: string; gin_receipt_id: string; pbi_number: string; net_weight_lbs: number | string | null }>
  gins: ReadonlyArray<{ id: string; name: string }>
  /** The engine's per-planting cotton figures (lib/cotton cottonPlantingYield). */
  yieldFor: (p: { field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null }) =>
    { yardSeedLbs: number; estimatedLintLbs: number; actualLintLbs: number; turnout: { fraction: number; pct: number; label: string } } | null
}

export type ProductionAuditInput = {
  report: ProductionReport
  cropYear: number
  /** '' = all entities. */
  entityName: string
  /** Plain-English crop filter ("All crops" / "Corn, Soybeans"). */
  cropFilterLabel: string
  orgName: string
  generatedAt: Date
  /** The app's origin for load links (null → plain ids). */
  appOrigin: string | null
  crops: readonly Crop[]
  fields: readonly Field[]
  farms: readonly Farm[]
  counties: readonly County[]
  loads: readonly AuditLoadRow[]
  splits: readonly LoadSplit[]
  combineEntries: ReadonlyArray<CombineEntryLike & { notes?: string | null }>
  buyers?: ReadonlyArray<{ id: string; name: string }>
  bins?: ReadonlyArray<{ id: string; name_or_number: string }>
  trucks?: ReadonlyArray<{ id: string; name_or_number: string }>
  loadSales?: readonly LoadSale[]
  settlementLines?: ReadonlyArray<{ id: string; settlement_id: string; buyer_ticket_number?: string | null }>
  settlements?: ReadonlyArray<{ id: string; settlement_number: string | null }>
  cotton?: AuditCottonSources | null
  /** Which crop ids the screen filter selected ([] = all). */
  cropIds?: readonly string[]
  entityId?: string
}

// Section keys (sheet names are the titles below).
export const AUDIT = {
  summary: 'summary',
  fieldProduction: 'field_production',
  loadData: 'load_data',
  combine: 'combine_entries',
  ginReceipts: 'gin_receipts',
  bales: 'bales',
  notIncluded: 'not_included',
  notes: 'notes',
} as const

export const ESTIMATED_KIND = 'estimated, not ginned'
export const GINNED_KIND = 'ginned'
export const NO_STATE = '(none)'

const BU3: NumFmt = 'bu3'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const input = (v: number | string | null, format?: NumFmt): ExportCell => ({ v, input: true, format })
const formula = (f: FormulaNode, format?: NumFmt): ExportCell => ({ v: null, f, format })
const text = (v: string | null | undefined): ExportCell => v ?? ''

/** SUMIFS criteria text must not carry wildcard characters; keys and labels
 *  are sanitized the same way wherever they are written or matched. */
export function criteriaSafe(s: string): string {
  return s.replace(/[*?~]/g, '-').replace(/\s+/g, ' ').trim()
}

function colsOf(defs: Array<ExportColumn & { key: string }>): ExportColumn[] {
  return defs
}

type PlantingRef = { field_id: string; crop_id: string; season_year: number }

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildProductionAuditPayload(input0: ProductionAuditInput): ExportPayload {
  const { report, cropYear } = input0
  const cropById = new Map(input0.crops.map((c) => [c.id, c]))
  const fieldById = new Map(input0.fields.map((f) => [f.id, f]))
  const farmById = new Map(input0.farms.map((f) => [f.id, f]))
  const countyById = new Map(input0.counties.map((c) => [c.id, c]))
  const buyerById = new Map((input0.buyers ?? []).map((b) => [b.id, b.name]))
  const binById = new Map((input0.bins ?? []).map((b) => [b.id, b.name_or_number]))
  const truckById = new Map((input0.trucks ?? []).map((t) => [t.id, t.name_or_number]))
  const lineById = new Map((input0.settlementLines ?? []).map((l) => [l.id, l]))
  const settlementById = new Map((input0.settlements ?? []).map((s) => [s.id, s]))
  const salesByLoad = new Map<string, LoadSale[]>()
  for (const s of input0.loadSales ?? []) {
    const arr = salesByLoad.get(s.load_id)
    if (arr) arr.push(s)
    else salesByLoad.set(s.load_id, [s])
  }
  const ginById = new Map((input0.cotton?.gins ?? []).map((g) => [g.id, g.name]))
  const cropIds = input0.cropIds ?? []
  const entityId = input0.entityId ?? ''

  // --- Planting keys: readable, unique, criteria-safe. ---------------------
  const keyByPlantingId = new Map<string, string>()
  const usedKeys = new Set<string>()
  const plantingKey = (p: PlantingRef & { id: string }): string => {
    const hit = keyByPlantingId.get(p.id)
    if (hit) return hit
    const fld = fieldById.get(p.field_id)
    const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
    const base = criteriaSafe(`${farm?.name ?? '(No Farm)'} / ${fld?.name_or_number ?? '(No Field)'} / ${cropById.get(p.crop_id)?.name ?? '(No Crop)'} ${p.season_year}`)
    let key = base
    for (let n = 2; usedKeys.has(key.toLowerCase()); n++) key = `${base} (${n})`
    usedKeys.add(key.toLowerCase())
    keyByPlantingId.set(p.id, key)
    return key
  }
  // Keys are assigned in report order so the Field Production tab reads top-down.
  for (const r of report.resolved) plantingKey(r.planting)

  const placeOf = (fieldId: string | null) => {
    const fld = fieldId ? fieldById.get(fieldId) ?? null : null
    const farm = fld?.farm_id ? farmById.get(fld.farm_id) ?? null : null
    const countyId = fld?.county_id ?? farm?.county_id ?? null
    const county = countyId ? countyById.get(countyId) ?? null : null
    return {
      field: fld, farm, county,
      farmName: farm?.name ?? '(No Farm)',
      fieldName: fld?.name_or_number ?? '(No Field)',
      countyLabel: criteriaSafe(county ? `${county.name} County` : '(No County)'),
      state: county?.state_code ? criteriaSafe(county.state_code) : NO_STATE,
    }
  }

  const plantingByKey = new Map<string, Resolved | 'in_progress'>()
  for (const r of report.resolved) plantingByKey.set(`${r.planting.field_id}|${r.planting.crop_id}|${r.planting.season_year}`, r)
  for (const p of report.inProgress) plantingByKey.set(`${p.field_id}|${p.crop_id}|${p.season_year}`, 'in_progress')
  // A planting that is in the year + entity set but filtered out by the crop
  // chips is simply out of scope (its loads are not "the same filters").
  const cropInFilter = (cropId: string | null) => cropId != null && (cropIds.length === 0 || cropIds.includes(cropId))
  const fieldInEntity = (fieldId: string | null) => {
    if (!entityId) return true
    const fld = fieldId ? fieldById.get(fieldId) : null
    const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
    return farm?.entity_id === entityId
  }

  // Combine entries indexed as the engine indexes them (field|crop|year).
  const entryByKey = new Map<string, CombineEntryLike & { notes?: string | null }>()
  for (const e of input0.combineEntries) if (e.crop_year === cropYear) entryByKey.set(`${e.field_id}|${e.crop_id}|${e.crop_year}`, e)
  const keyYearFor = (fieldId: string, cropId: string, dateYr: number, loadCropYear: number | null) => {
    const effYear = loadCropYear ?? dateYr
    return entryByKey.has(`${fieldId}|${cropId}|${effYear}`) ? effYear : dateYr
  }

  // --- Load portions → Load Data rows and Not Included rows. ---------------
  type Portion = {
    load: AuditLoadRow
    split: LoadSplit | null
    fieldId: string
    cropId: string
    pct: number
    netApplied: number | null
    practice: 'irrigated' | 'dryland' | null
  }
  const portions: Portion[] = []
  const splitsByLoad = new Map<string, LoadSplit[]>()
  for (const s of input0.splits) {
    const arr = splitsByLoad.get(s.load_id)
    if (arr) arr.push(s)
    else splitsByLoad.set(s.load_id, [s])
  }
  for (const l of input0.loads) {
    if (l.from_type !== 'field') continue
    // The engine counts a single-field load through from_field_id and a split
    // load through its load_splits rows (a split load's from_field_id is null).
    if (l.from_field_id && l.crop_id) {
      portions.push({ load: l, split: null, fieldId: l.from_field_id, cropId: l.crop_id, pct: 100, netApplied: l.net_weight, practice: l.practice ?? null })
    }
    for (const s of splitsByLoad.get(l.id) ?? []) {
      portions.push({ load: l, split: s, fieldId: s.field_id, cropId: s.crop_id, pct: Number(s.percentage) || 0, netApplied: s.net_weight, practice: s.practice ?? null })
    }
  }

  type LoadDataRow = { portion: Portion; resolved: Resolved; dryBu: number; overridden: boolean; noBase: boolean }
  const loadRows: LoadDataRow[] = []
  type NotIncludedRow = { portion: Portion | null; label: string; place: ReturnType<typeof placeOf>; cropName: string; cropYear: number | null; date: string; ticket: string; net: number | null; moisture: number | null; dryBu: number | null; reason: string }
  const notIncluded: NotIncludedRow[] = []

  for (const po of portions) {
    const l = po.load
    if (!cropInFilter(po.cropId) || !fieldInEntity(po.fieldId)) continue
    const dateYr = Number(l.date.slice(0, 4))
    const place = placeOf(po.fieldId)
    const cropName = cropById.get(po.cropId)?.name ?? '(No Crop)'
    const crop = cropById.get(l.crop_id ?? po.cropId) ?? null
    const parentCrop = cropById.get(l.crop_id ?? '') ?? crop
    const computed = po.split
      ? { dry: po.split.dry_bushels == null ? null : Number(po.split.dry_bushels), overridden: false }
      : (() => {
          const r = computeBushels({
            netWeightLb: l.net_weight, moisturePct: l.moisture,
            baseMoisturePct: crop?.base_moisture_pct ?? null, baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
            dryBushelsOverride: l.dry_bushels_override,
          })
          return { dry: r.dryBushels, overridden: r.overridden }
        })()
    const base = { portion: po, label: po.split ? `${l.id} (split)` : l.id, place, cropName, cropYear: l.crop_year, date: l.date, ticket: l.ticket_number ?? '', net: po.netApplied, moisture: l.moisture, dryBu: computed.dry }
    if (l.crop_year !== cropYear) {
      // Only a load dated in the report year with NO crop year is worth listing.
      if (l.crop_year == null && dateYr === cropYear) notIncluded.push({ ...base, reason: 'no crop year on the load' })
      continue
    }
    const keyYr = keyYearFor(po.fieldId, po.cropId, dateYr, l.crop_year)
    if (keyYr !== cropYear) {
      notIncluded.push({ ...base, reason: `hauled in ${dateYr}: credited to a ${dateYr} planting of this field, not the ${cropYear} one` })
      continue
    }
    const hit = plantingByKey.get(`${po.fieldId}|${po.cropId}|${cropYear}`)
    if (hit === 'in_progress') { notIncluded.push({ ...base, reason: 'harvest in progress' }); continue }
    if (!hit) {
      const outOfScope = report.yearEntityPlantings.length > 0 && !report.yearPlantings.some((p) => p.field_id === po.fieldId && p.crop_id === po.cropId)
      notIncluded.push({ ...base, reason: outOfScope ? `no ${cropYear} planting for this field and crop` : 'mixed practice not broken out' })
      continue
    }
    if (po.split ? po.split.dry_bushels == null : !computed.dry) {
      notIncluded.push({ ...base, reason: po.split ? 'split portion has no dry bushels' : 'no bushels: missing net weight, or the crop has no lb per bushel' })
      continue
    }
    if (hit.irrigatedAcres <= 0 && hit.drylandAcres <= 0) {
      notIncluded.push({ ...base, reason: 'planting has no certified acres (irrigated and dryland both 0)' })
      continue
    }
    loadRows.push({
      portion: po, resolved: hit, dryBu: computed.dry ?? 0, overridden: computed.overridden,
      noBase: parentCrop?.base_moisture_pct == null,
    })
  }
  // In-progress plantings with a combine entry and no loads would otherwise vanish.
  for (const p of report.inProgress) {
    const e = entryByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
    if (!e) continue
    notIncluded.push({
      portion: null, label: '(combine entry)', place: placeOf(p.field_id), cropName: cropById.get(p.crop_id)?.name ?? '', cropYear: e.crop_year,
      date: e.entry_date, ticket: '', net: null, moisture: null, dryBu: Number(e.adjusted_total_bushels) || 0, reason: 'harvest in progress',
    })
  }
  loadRows.sort((a, b) =>
    a.portion.load.date.localeCompare(b.portion.load.date) ||
    (a.portion.load.time ?? '').localeCompare(b.portion.load.time ?? '') ||
    a.portion.load.id.localeCompare(b.portion.load.id) ||
    (a.portion.split?.id ?? '').localeCompare(b.portion.split?.id ?? ''))

  // --- Combine Entries rows (resolved plantings whose figure is the combine's). ---
  const combineRows = report.resolved
    .filter((r) => r.source === 'combine' && r.agg?.combine)
    .map((r) => ({ r, e: entryByKey.get(`${r.planting.field_id}|${r.planting.crop_id}|${r.planting.season_year}`)! }))
    .filter((x) => x.e)

  // --- Cotton rows. ---------------------------------------------------------
  const cotton = input0.cotton ?? null
  type GinRow = { kind: string; r: Resolved; receipt: AuditCottonReceipt | null; est: { seedLbs: number; turnoutPct: number; label: string } | null }
  const ginRows: GinRow[] = []
  const baleRows: Array<{ bale: AuditCottonSources['bales'][number]; receipt: AuditCottonReceipt }> = []
  if (cotton) {
    for (const r of report.resolved) {
      if (r.source !== 'cotton') continue
      const receipts = cotton.receipts.filter((x) => x.field_id === r.planting.field_id && x.crop_year === r.planting.season_year)
      for (const rc of receipts) {
        ginRows.push({ kind: GINNED_KIND, r, receipt: rc, est: null })
        for (const b of cotton.bales) if (b.gin_receipt_id === rc.id) baleRows.push({ bale: b, receipt: rc })
      }
      const y = cotton.yieldFor(r.planting)
      if (y && y.yardSeedLbs > 0) {
        ginRows.push({ kind: ESTIMATED_KIND, r, receipt: null, est: { seedLbs: y.yardSeedLbs, turnoutPct: y.turnout.fraction * 100, label: y.turnout.label } })
      }
    }
  }
  const hasCotton = ginRows.length > 0
  const hasBales = baleRows.length > 0
  const hasCombine = combineRows.length > 0

  // =========================================================================
  // Sections
  // =========================================================================
  const S = AUDIT
  const LD = (c: string): RangeNode => col(S.loadData, c)
  const FP = (c: string): RangeNode => col(S.fieldProduction, c)
  const CE = (c: string): RangeNode => col(S.combine, c)
  const GR = (c: string): RangeNode => col(S.ginReceipts, c)
  const BL = (c: string): RangeNode => col(S.bales, c)

  // --- Field Production --------------------------------------------------
  const fpColumns = colsOf([
    { key: 'key', label: 'Planting key', width: 40 },
    { key: 'farm', label: 'Farm' },
    { key: 'field', label: 'Field' },
    { key: 'fsa', label: 'FSA farm #' },
    { key: 'county', label: 'County' },
    { key: 'state', label: 'State' },
    { key: 'crop', label: 'Crop' },
    { key: 'unit', label: 'Unit' },
    { key: 'practice', label: 'Practice' },
    { key: 'status', label: 'Harvest status' },
    { key: 'source', label: 'Production source' },
    { key: 'breakout', label: 'Practice split' },
    { key: 'acres', label: 'Acres', format: 'acres', align: 'right' },
    { key: 'scale_bu', label: 'Scale ticket bu', format: BU3, align: 'right' },
    { key: 'combine_bu', label: 'Combine entry bu', format: BU3, align: 'right' },
    ...(hasCotton ? [
      { key: 'ginned_lint', label: 'Ginned lint lbs', format: 'lbs' as NumFmt, align: 'right' as const },
      { key: 'est_lint', label: 'Estimated lint lbs (not ginned)', format: 'lbs' as NumFmt, align: 'right' as const },
    ] : []),
    { key: 'entered_irr', label: 'Entered irrigated bu', format: BU3, align: 'right' },
    { key: 'entered_dry', label: 'Entered dryland bu', format: BU3, align: 'right' },
    { key: 'field_total', label: 'Field total', format: BU3, align: 'right' },
    { key: 'share', label: 'Practice share (fraction)', format: 'dec2', align: 'right' },
    { key: 'production', label: 'Production', format: BU3, align: 'right' },
    { key: 'yield', label: 'Yield/acre', format: 'yield', align: 'right' },
    { key: 'check', label: 'Check' },
    { key: 'rule', label: 'Rule', width: 48 },
  ])

  type FpRow = { r: Resolved; practice: Practice }
  const fpRows: FpRow[] = []
  for (const r of report.resolved) {
    if (r.irrigatedAcres > 0) fpRows.push({ r, practice: 'irrigated' })
    if (r.drylandAcres > 0) fpRows.push({ r, practice: 'dryland' })
  }
  const fpSection: ExportSection = {
    key: S.fieldProduction,
    title: 'Field Production',
    plain: true,
    columns: fpColumns,
    rows: fpRows.map(({ r, practice }) => {
      const key = plantingKey(r.planting)
      const crop = cropById.get(r.planting.crop_id)
      const cropName = criteriaSafe(crop?.name ?? '')
      const unit = crop ? unitOf(crop) : 'bu'
      const fmtBu: NumFmt = unit === 'lbs' ? 'lbs' : BU3
      const place = placeOf(r.planting.field_id)
      const pLabel = practiceLabel(practice)
      const acres = practice === 'irrigated' ? r.irrigatedAcres : r.drylandAcres
      const status = r.countedAnyway ? 'counted anyway' : r.harvestStatus === 'unharvested' ? 'not harvested' : 'complete'
      const sourceText = r.source === 'combine' ? 'combine monitor' : r.source === 'cotton' ? 'gin receipts' : 'scale tickets'
      const breakoutText = r.breakout === 'single' ? 'single practice' : r.breakout === 'entered' ? 'entered breakout' : r.breakout === 'loads' ? 'from load tags' : 'rolled into dryland'

      const byKey = (range: RangeNode) => sumifs(range, [LD('key'), self('key')])
      const scaleBu = r.breakout === 'loads'
        ? sumifs(LD('dry_bu'), [LD('key'), self('key')], [LD('practice'), self('practice')])
        : byKey(LD('dry_bu'))
      const combineBu = hasCombine ? sumifs(CE('adjusted_bu'), [CE('key'), self('key')]) : null
      const ginned = hasCotton ? sumifs(GR('lint_lbs'), [GR('key'), self('key')], [GR('kind'), str(GINNED_KIND)]) : null
      const est = hasCotton ? sumifs(GR('lint_lbs'), [GR('key'), self('key')], [GR('kind'), str(ESTIMATED_KIND)]) : null

      const fieldTotal: FormulaNode =
        r.source === 'combine' && combineBu ? self('combine_bu')
        : r.source === 'cotton' && ginned ? add(self('ginned_lint'), self('est_lint'))
        : byKey(LD('dry_bu'))

      let share: FormulaNode
      let production: FormulaNode
      let check: ExportCell = ''
      let rule: string
      switch (r.breakout) {
        case 'single':
          share = num(1)
          production = self('field_total')
          rule = `Single-practice planting: all production is ${pLabel.toLowerCase()}.`
          break
        case 'entered':
          share = iferror(div(self(practice === 'irrigated' ? 'entered_irr' : 'entered_dry'), add(self('entered_irr'), self('entered_dry'))), num(0))
          production = mul(self('field_total'), self('share'))
          check = formula(iff(lt(abs(sub(add(self('entered_irr'), self('entered_dry')), self('field_total'))), num(0.5)), str('OK'), str('CHECK')))
          rule = 'Mixed planting with an entered breakout: this practice takes its share of the field total (share = entered irrigated or dryland bushels ÷ their sum). Check: entered irrigated + dryland = field total.'
          break
        case 'loads':
          share = iferror(div(self('scale_bu'), self('field_total')), num(0))
          production = self('scale_bu')
          check = formula(iff(lt(abs(sub(add(
            sumifs(LD('dry_bu'), [LD('key'), self('key')], [LD('practice'), str('Irrigated')]),
            sumifs(LD('dry_bu'), [LD('key'), self('key')], [LD('practice'), str('Dryland')]),
          ), self('field_total'))), num(0.5)), str('OK'), str('CHECK')))
          rule = 'Mixed planting, every load tagged: production is the sum of this practice\'s tagged load portions. Check: irrigated + dryland tagged loads = field total.'
          break
        case 'rolled_dryland':
          share = num(practice === 'dryland' ? 1 : 0)
          production = practice === 'dryland' ? self('field_total') : num(0)
          rule = 'Mixed planting with no breakout, generated as dryland: all production on the dryland row; acres stay split.'
          break
      }
      if (r.source === 'combine') rule = `Combine entry is the field\'s production; scale tickets from this field are netted inside it, not added. ${rule}`
      if (r.source === 'cotton') rule = `Cotton: lint lbs = ginned receipts + the turnout estimate on unginned seed cotton. ${rule}`

      const entered = r.breakout === 'entered'
      return [
        key,
        place.farmName,
        place.fieldName,
        text(place.farm?.fsa_number),
        place.countyLabel,
        place.state,
        cropName,
        unit,
        pLabel,
        status,
        sourceText,
        breakoutText,
        input(acres, 'acres'),
        formula(scaleBu, BU3),
        combineBu ? formula(combineBu, BU3) : '',
        ...(hasCotton ? [ginned ? formula(ginned, 'lbs') : '', est ? formula(est, 'lbs') : ''] : []),
        entered ? input(r.planting.irrigated_bushels != null ? Number(r.planting.irrigated_bushels) : 0, fmtBu) : '',
        entered ? input(r.planting.dryland_bushels != null ? Number(r.planting.dryland_bushels) : 0, fmtBu) : '',
        formula(fieldTotal, fmtBu),
        formula(share, 'dec2'),
        formula(production, fmtBu),
        formula(iferror(div(self('production'), self('acres')), num(0)), 'yield'),
        check,
        rule,
      ]
    }),
  }

  // --- Summary -------------------------------------------------------------
  const crops = report.reportCrops
  const sumCols = colsOf([
    { key: 'county', label: 'County' },
    { key: 'state', label: 'State' },
    { key: 'practice', label: 'Practice' },
    ...crops.map((c) => ({ key: `acres:${c.id}`, label: c.name, format: 'acres' as NumFmt, align: 'right' as const })),
    ...crops.map((c) => ({ key: `prod:${c.id}`, label: c.name, format: (unitOf(c) === 'lbs' ? 'lbs' : BU3) as NumFmt, align: 'right' as const })),
    ...crops.map((c) => ({ key: `yield:${c.id}`, label: c.name, format: 'yield' as NumFmt, align: 'right' as const })),
  ])
  const n = report.summaryRows.length
  const summaryRows: ExportCell[][] = report.summaryRows.map((row) => {
    const place = { countyLabel: criteriaSafe(row.countyLabel), state: row.county?.state_code ? criteriaSafe(row.county.state_code) : NO_STATE }
    const crit = (c: Crop): Array<[RangeNode, FormulaNode]> => [
      [FP('county'), self('county')], [FP('state'), self('state')], [FP('crop'), str(criteriaSafe(c.name))], [FP('practice'), self('practice')],
    ]
    return [
      place.countyLabel,
      place.state,
      practiceLabel(row.practice),
      ...crops.map((c) => formula(sumifs(FP('acres'), ...crit(c)), 'acres')),
      ...crops.map((c) => formula(sumifs(FP('production'), ...crit(c)), unitOf(c) === 'lbs' ? 'lbs' : BU3)),
      ...crops.map((c) => formula(iferror(div(self(`prod:${c.id}`), self(`acres:${c.id}`)), num(0)), 'yield')),
    ]
  })
  const totalRow: ExportCell[] = [
    'Total', '', '',
    ...crops.map((c) => formula(n > 0 ? sum(rowsRange(S.summary, `acres:${c.id}`, 0, n - 1)) : num(0), 'acres')),
    ...crops.map((c) => formula(n > 0 ? sum(rowsRange(S.summary, `prod:${c.id}`, 0, n - 1)) : num(0), unitOf(c) === 'lbs' ? 'lbs' : BU3)),
    ...crops.map((c) => formula(iferror(div(self(`prod:${c.id}`), self(`acres:${c.id}`)), num(0)), 'yield')),
  ]
  const summarySection: ExportSection = {
    key: S.summary,
    title: 'Summary',
    plain: true,
    columns: sumCols,
    groups: crops.length > 0 ? [
      { label: '', span: 3 },
      { label: 'Certified Acres', span: crops.length },
      { label: 'Production (Bu. Or Lbs.)', span: crops.length },
      { label: 'Yield/Acre (Bu. Or Lbs.)', span: crops.length },
    ] : undefined,
    rows: [...summaryRows, totalRow],
    rowMeta: [...report.summaryRows.map(() => 'data' as const), 'total'],
  }

  // --- Load Data -----------------------------------------------------------
  const ldColumns = colsOf([
    { key: 'load', label: 'Load', width: 38 },
    { key: 'date', label: 'Date', format: 'text' },
    { key: 'ticket', label: 'Our ticket #' },
    { key: 'buyer_ticket', label: 'Buyer ticket #' },
    { key: 'truck', label: 'Truck' },
    { key: 'farm', label: 'Farm' },
    { key: 'field', label: 'Field' },
    { key: 'county', label: 'County' },
    { key: 'state', label: 'State' },
    { key: 'crop', label: 'Crop' },
    { key: 'crop_year', label: 'Crop year', format: 'text' },
    { key: 'practice', label: 'Practice (load tag)' },
    { key: 'destination', label: 'Destination' },
    { key: 'gross', label: 'Gross lbs', format: 'lbs', align: 'right' },
    { key: 'tare', label: 'Tare lbs', format: 'lbs', align: 'right' },
    { key: 'net', label: 'Net lbs', format: 'lbs', align: 'right' },
    { key: 'split_pct', label: 'Split %', format: 'pct1', align: 'right' },
    { key: 'net_applied', label: 'Net lbs applied', format: 'lbs', align: 'right' },
    { key: 'moisture', label: 'Moisture %', format: 'dec1', align: 'right' },
    { key: 'base_mc', label: 'Base moisture %', format: 'dec1', align: 'right' },
    { key: 'lb_bu', label: 'Lb per bu', format: 'dec1', align: 'right' },
    { key: 'wet_bu', label: 'Wet bu', format: BU3, align: 'right' },
    { key: 'dry_bu', label: 'Dry bu', format: BU3, align: 'right' },
    { key: 'override', label: 'Override' },
    { key: 'note', label: 'Note', width: 40 },
    { key: 'test_weight', label: 'Test weight', format: 'dec1', align: 'right' },
    { key: 'settlement', label: 'Settlement #' },
    { key: 'buyer_net_bu', label: 'Buyer net bu (cross-check)', format: BU3, align: 'right' },
    { key: 'key', label: 'Planting key', width: 40 },
  ])
  const loadDataSection: ExportSection = {
    key: S.loadData,
    title: 'Load Data',
    plain: true,
    columns: ldColumns,
    rows: loadRows.map(({ portion: po, resolved: r, dryBu, overridden, noBase }) => {
      const l = po.load
      const place = placeOf(po.fieldId)
      const parentCrop = cropById.get(l.crop_id ?? po.cropId) ?? null
      const sales = salesByLoad.get(l.id) ?? []
      const line = sales.map((s) => (s.settlement_line_id ? lineById.get(s.settlement_line_id) : undefined)).find(Boolean)
      const settlement = line ? settlementById.get(line.settlement_id) : undefined
      const buyerNet = sales.reduce<number | null>((acc, s) => (s.buyer_net_bushels == null ? acc : (acc ?? 0) + s.buyer_net_bushels), null)
      const destination = l.to_type === 'bin' ? (binById.get(l.to_bin_id ?? '') ?? 'bin') : l.to_type === 'buyer' ? (buyerById.get(l.to_buyer_id ?? '') ?? 'buyer') : ''
      const wet = div(self('net_applied'), self('lb_bu'))
      const shrunk = noBase ? wet : iff(le(self('moisture'), self('base_mc')), wet, div(mul(wet, sub(num(100), self('moisture'))), sub(num(100), self('base_mc'))))
      const dryFormula = po.split ? round(shrunk, 2) : shrunk
      const note = overridden && !po.split ? 'manual override'
        : po.split ? (noBase ? 'split portion: dry bu rounded to 2 decimals as stored; crop has no base moisture, no shrink' : 'split portion: dry bu rounded to 2 decimals as stored')
        : noBase ? 'crop has no base moisture: no shrink'
        : ''
      const loadCell: ExportCell = input0.appOrigin ? { v: l.id, link: `${input0.appOrigin}/loads/${l.id}` } : l.id
      return [
        loadCell,
        l.date,
        text(l.ticket_number),
        text(line?.buyer_ticket_number),
        truckExportLabel({ truck_label: l.truck_label, truck: l.truck_id ? { name_or_number: truckById.get(l.truck_id) ?? '' } : null, hauler_truck: l.hauler_truck }),
        place.farmName,
        place.fieldName,
        place.countyLabel,
        place.state,
        criteriaSafe(cropById.get(po.cropId)?.name ?? ''),
        String(l.crop_year ?? ''),
        po.practice ? practiceLabel(po.practice) : '',
        destination,
        input(l.gross_weight ?? null, 'lbs'),
        input(l.tare_weight ?? null, 'lbs'),
        input(l.net_weight, 'lbs'),
        input(po.pct, 'pct1'),
        formula(div(mul(self('net'), self('split_pct')), num(100)), 'lbs'),
        input(l.moisture, 'dec1'),
        input(parentCrop?.base_moisture_pct ?? null, 'dec1'),
        input(parentCrop?.base_lb_per_bushel ?? null, 'dec1'),
        formula(wet, BU3),
        overridden && !po.split ? input(dryBu, BU3) : formula(dryFormula, BU3),
        overridden && !po.split ? 'manual override' : '',
        note,
        input(l.test_weight ?? null, 'dec1'),
        text(settlement?.settlement_number),
        buyerNet == null ? '' : input(buyerNet, BU3),
        plantingKey(r.planting),
      ]
    }),
  }

  // --- Combine Entries -----------------------------------------------------
  const combineSection: ExportSection | null = hasCombine ? {
    key: S.combine,
    title: 'Combine Entries',
    plain: true,
    note: 'No scale ticket. Bushels from the combine yield monitor.',
    columns: colsOf([
      { key: 'key', label: 'Planting key', width: 40 },
      { key: 'farm', label: 'Farm' },
      { key: 'field', label: 'Field' },
      { key: 'county', label: 'County' },
      { key: 'state', label: 'State' },
      { key: 'crop', label: 'Crop' },
      { key: 'date', label: 'Entry date', format: 'text' },
      { key: 'stated_bu', label: 'Monitor bushels (stated)', format: BU3, align: 'right' },
      { key: 'adjust', label: 'Calibration adj. (bu/ac)', format: 'dec1', align: 'right' },
      { key: 'adjusted_bu', label: 'Adjusted bushels (used)', format: BU3, align: 'right' },
      { key: 'complete', label: 'Harvest complete' },
      { key: 'netted_bu', label: 'Scale tickets netted (bu)', format: BU3, align: 'right' },
      { key: 'remainder_bu', label: 'Remainder to storage (bu)', format: BU3, align: 'right' },
      { key: 'notes', label: 'Notes', width: 40 },
    ]),
    rows: combineRows.map(({ r, e }) => {
      const place = placeOf(r.planting.field_id)
      return [
        plantingKey(r.planting),
        place.farmName,
        place.fieldName,
        place.countyLabel,
        place.state,
        criteriaSafe(cropById.get(r.planting.crop_id)?.name ?? ''),
        e.entry_date,
        input(Number(e.stated_total_bushels) || 0, BU3),
        input(e.adjustment_bu_per_acre == null ? null : Number(e.adjustment_bu_per_acre), 'dec1'),
        input(Number(e.adjusted_total_bushels) || 0, BU3),
        e.harvest_complete ? 'yes' : 'no',
        formula(sumifs(LD('dry_bu'), [LD('key'), self('key')]), BU3),
        formula(sub(self('adjusted_bu'), self('netted_bu')), BU3),
        text(e.notes),
      ]
    }),
  } : null

  // --- Gin Receipts + Bales (cotton) ---------------------------------------
  const ginSection: ExportSection | null = hasCotton ? {
    key: S.ginReceipts,
    title: 'Gin Receipts',
    plain: true,
    note: `Lint lbs per receipt: the bale rows' weights when the bales are listed, else the receipt's stated bale weight. Rows marked "${ESTIMATED_KIND}" are seed cotton picked but not yet ginned, valued at the resolved turnout.`,
    columns: colsOf([
      { key: 'kind', label: 'Kind' },
      { key: 'receipt', label: 'Receipt / statement #' },
      { key: 'receipt_id', label: 'Receipt id', width: 38 },
      { key: 'gin', label: 'Gin' },
      { key: 'date', label: 'Date', format: 'text' },
      { key: 'farm', label: 'Farm' },
      { key: 'field', label: 'Field' },
      { key: 'county', label: 'County' },
      { key: 'state', label: 'State' },
      { key: 'practice', label: 'Practice' },
      { key: 'modules', label: 'Modules', format: 'int', align: 'right' },
      { key: 'seed_lbs', label: 'Seed cotton lbs', format: 'lbs', align: 'right' },
      { key: 'bales', label: 'Bales', format: 'int', align: 'right' },
      { key: 'stated_lint', label: 'Stated bale weight (lbs)', format: 'lbs', align: 'right' },
      { key: 'bale_lbs', label: 'Bale rows lbs', format: 'lbs', align: 'right' },
      { key: 'turnout', label: 'Turnout %', format: 'pct1', align: 'right' },
      { key: 'lint_lbs', label: 'Lint lbs', format: 'lbs', align: 'right' },
      { key: 'basis', label: 'Basis' },
      { key: 'key', label: 'Planting key', width: 40 },
    ]),
    rows: ginRows.map((g) => {
      const place = placeOf(g.r.planting.field_id)
      const practice = g.r.isMixed ? 'Mixed' : g.r.irrigatedAcres > 0 ? 'Irrigated' : 'Dryland'
      const common = [place.farmName, place.fieldName, place.countyLabel, place.state, practice]
      if (g.receipt) {
        const rc = g.receipt
        const balesHere = baleRows.filter((b) => b.receipt.id === rc.id)
        const baleLbs = hasBales ? formula(sumifs(BL('net_lbs'), [BL('receipt_id'), self('receipt_id')]), 'lbs') : ''
        const lint = hasBales
          ? formula(iff(gt(self('bale_lbs'), num(0)), self('bale_lbs'), self('stated_lint')), 'lbs')
          : formula(self('stated_lint'), 'lbs')
        return [
          GINNED_KIND,
          rc.statement_number || rc.receipt_number,
          rc.id,
          ginById.get(rc.gin_id ?? '') ?? '',
          rc.receipt_date ?? '',
          ...common,
          input(rc.modules_count ?? null, 'int'),
          input(rc.total_seed_cotton_weight == null ? null : Number(rc.total_seed_cotton_weight), 'lbs'),
          input(balesHere.length > 0 ? balesHere.length : rc.bales_count ?? null, 'int'),
          input(rc.total_bale_weight == null ? null : Number(rc.total_bale_weight), 'lbs'),
          baleLbs,
          formula(iferror(div(mul(self('lint_lbs'), num(100)), self('seed_lbs')), num(0)), 'pct1'),
          lint,
          'ginned',
          plantingKey(g.r.planting),
        ]
      }
      const est = g.est!
      return [
        ESTIMATED_KIND,
        '(estimate)',
        '',
        '',
        '',
        ...common,
        '',
        input(est.seedLbs, 'lbs'),
        '',
        '',
        '',
        input(est.turnoutPct, 'pct1'),
        formula(div(mul(self('seed_lbs'), self('turnout')), num(100)), 'lbs'),
        `estimated, not ginned: ${est.label}`,
        plantingKey(g.r.planting),
      ]
    }),
  } : null

  const balesSection: ExportSection | null = hasBales ? {
    key: S.bales,
    title: 'Bales',
    plain: true,
    columns: colsOf([
      { key: 'pbi', label: 'PBI' },
      { key: 'receipt', label: 'Receipt / statement #' },
      { key: 'receipt_id', label: 'Receipt id', width: 38 },
      { key: 'net_lbs', label: 'Net lbs', format: 'lbs', align: 'right' },
    ]),
    rows: baleRows.map(({ bale, receipt }) => [
      bale.pbi_number,
      receipt.statement_number || receipt.receipt_number,
      receipt.id,
      input(bale.net_weight_lbs == null ? null : Number(bale.net_weight_lbs), 'lbs'),
    ]),
  } : null

  // --- Not Included --------------------------------------------------------
  const notIncludedSection: ExportSection = {
    key: S.notIncluded,
    title: 'Not Included',
    plain: true,
    note: 'Listed for completeness. Not counted in Summary.',
    columns: colsOf([
      { key: 'load', label: 'Load', width: 38 },
      { key: 'date', label: 'Date', format: 'text' },
      { key: 'ticket', label: 'Our ticket #' },
      { key: 'farm', label: 'Farm' },
      { key: 'field', label: 'Field' },
      { key: 'county', label: 'County' },
      { key: 'crop', label: 'Crop' },
      { key: 'crop_year', label: 'Crop year', format: 'text' },
      { key: 'net', label: 'Net lbs applied', format: 'lbs', align: 'right' },
      { key: 'moisture', label: 'Moisture %', format: 'dec1', align: 'right' },
      { key: 'dry_bu', label: 'Dry bu (as the app computes it)', format: BU3, align: 'right' },
      { key: 'reason', label: 'Reason', width: 48 },
    ]),
    rows: notIncluded.map((x) => [
      x.portion && input0.appOrigin ? { v: x.label, link: `${input0.appOrigin}/loads/${x.portion.load.id}` } : x.label,
      x.date,
      x.ticket,
      x.place.farmName,
      x.place.fieldName,
      x.place.countyLabel,
      x.cropName,
      String(x.cropYear ?? ''),
      x.net == null ? '' : { v: x.net, format: 'lbs' },
      x.moisture == null ? '' : { v: x.moisture, format: 'dec1' },
      x.dryBu == null ? '' : { v: x.dryBu, format: BU3 },
      x.reason,
    ]),
  }

  // --- Notes ---------------------------------------------------------------
  const notesRows: ExportCell[][] = []
  const line = (item: string, value: ExportCell = '', check: ExportCell = '') => { notesRows.push([item, value, check]) }
  line('How this workbook is built')
  line('Load Data lists every load portion that counts: one row per load, or one row per field share of a split load. Net lbs applied = net lbs × split %.')
  line('Field Production has one row per planting and practice. Its Scale ticket bu is a SUMIFS over Load Data by planting key; its Production applies the practice rule in the Rule column.')
  line('Summary sums Field Production by county, state, crop and practice with SUMIFS. Yield per acre is production ÷ acres; the Total row sums the rows above and its yield is total production ÷ total acres, never an average of yields.')
  line('To trace a number: click a Summary cell, read its SUMIFS, find the matching rows on Field Production, then follow that row\'s planting key to Load Data. Change a load\'s net lbs or moisture and every total above it recalculates.')
  line('')
  line('Shrink (dry bushels), exactly as Turnrow computes each load')
  line('Wet bu = net lbs applied ÷ lb per bushel. If moisture is at or below the crop\'s base moisture (or no moisture was recorded) dry bu = wet bu. Otherwise dry bu = wet bu × (100 − moisture) ÷ (100 − base moisture).')
  line('Excel: =IF(moisture<=base, net/lb, net/lb*(100-moisture)/(100-base)). A split portion is ROUNDed to 2 decimals because that is how the app stores it; a whole load is not rounded.')
  line('A load with a manual dry-bushel override shows the override (blue) with the note "manual override". A parent load\'s override is not spread over its split portions.')
  line('A field with a combine-monitor entry uses the entry\'s adjusted bushels as its production; scale tickets from that field are netted inside the entry, not added to it (see Combine Entries).')
  line('')
  line('Colors')
  line('Blue cells are values taken straight from Turnrow records: weights, moisture, acres, overrides, entered breakouts, combine entries, gin receipts. Black cells are formulas. Change a blue cell and the formulas follow.')
  line('')
  line('What is not here')
  line('Loads hauled out of a bin are not listed: production is counted when grain leaves the field, so counting a bin load as well would count the same bushels twice.')
  line('The Not Included tab lists loads for the same crop year and filters that the report leaves out, each with its reason (harvest in progress, no planting for the field, and so on).')
  line('')
  line('This export')
  line('Organization', input0.orgName)
  line('Filters', `${cropYear} crop · ${input0.entityName || 'All entities'} · ${input0.cropFilterLabel}`)
  line('Generated', input0.generatedAt.toLocaleString())
  line('')
  line('Reconciliation: Turnrow on-screen total vs the workbook\'s formulas', 'Value', 'Check')
  const totalIdx = report.summaryRows.length
  const recon: Array<{ crop: Crop; screen: number }> = crops.map((c) => ({ crop: c, screen: report.summaryTotals.get(c.id)?.bu ?? 0 }))
  for (const { crop, screen } of recon) {
    const unit = unitOf(crop)
    const fmt: NumFmt = unit === 'lbs' ? 'lbs' : BU3
    const r0 = notesRows.length
    line(`${crop.name}: Turnrow on-screen total production (${unit})`, input(screen, fmt))
    line(`${crop.name}: Workbook formula total (${unit})`, formula(cell(S.summary, `prod:${crop.id}`, totalIdx), fmt))
    line(`${crop.name}: Difference`, formula(sub(cell(S.notes, 'value', r0 + 1), cell(S.notes, 'value', r0)), fmt), formula(iff(lt(abs(self('value')), num(0.5)), str('OK'), str('CHECK'))))
  }
  const grain = recon.filter((x) => unitOf(x.crop) === 'bu')
  if (grain.length > 1) {
    const r0 = notesRows.length
    line('All bushel crops: Turnrow on-screen total production (bu)', input(grain.reduce((a, x) => a + x.screen, 0), BU3))
    line('All bushel crops: Workbook formula total (bu)', formula(sum(...grain.map((x) => cell(S.summary, `prod:${x.crop.id}`, totalIdx))), BU3))
    line('All bushel crops: Difference', formula(sub(cell(S.notes, 'value', r0 + 1), cell(S.notes, 'value', r0)), BU3), formula(iff(lt(abs(self('value')), num(0.5)), str('OK'), str('CHECK'))))
  }
  const notesSection: ExportSection = {
    key: S.notes,
    title: 'Notes',
    plain: true,
    columns: colsOf([
      { key: 'item', label: 'How this workbook is built', width: 48 },
      { key: 'value', label: 'Value', align: 'right', width: 22 },
      { key: 'check', label: 'Check', width: 12 },
    ]),
    rows: notesRows,
  }

  const sections: ExportSection[] = [summarySection, fpSection, loadDataSection]
  if (combineSection) sections.push(combineSection)
  if (ginSection) sections.push(ginSection)
  if (balesSection) sections.push(balesSection)
  sections.push(notIncludedSection, notesSection)

  const payload: ExportPayload = {
    title: `${input0.entityName ? input0.entityName + ' ' : ''}${cropYear} Production Report — audit workbook`,
    filters: `${cropYear} crop · ${input0.entityName || 'All entities'} · ${input0.cropFilterLabel}`,
    filename: `production-report-audit-${cropYear}-${input0.generatedAt.toISOString().slice(0, 10)}`,
    sections,
    fullCalcOnLoad: true,
  }
  // Cache every formula's result so viewers that never recalculate still show
  // numbers (and so tests compare the same values Excel will display).
  evaluatePayload(payload)
  return payload
}

/** The rows of a keyed section, by section key (for tests and the real-data check). */
export function auditSection(payload: ExportPayload, key: string): ExportSection {
  const s = payload.sections.find((x) => x.key === key)
  if (!s) throw new Error(`audit workbook has no section "${key}"`)
  return s
}
