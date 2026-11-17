// Crop Insurance Production Report — the Excel workbook.
//
// THE REPORT FIRST, THE PROOF BEHIND IT. The workbook opens on exactly what
// the screen shows and what an insurance agent asks for: a Summary (one line
// per county and practice), then one sheet per county × practice listing each
// farm with its FSA number, certified acres, production and yield. Behind
// those sit the supporting tabs an auditor follows: Field Production (one row
// per planting × practice), Load Data (one row per counted load portion), the
// combine / gin / settlement sources, and Notes.
//
// Every number on the report sheets is a LIVE FORMULA tracing back to the
// loads: Load Data → Field Production (SUMIFS over Load Data by Farm + Field +
// Crop + Crop Year, plus Practice where the load tag decides it) → the county
// sheets (SUMIFS over Field Production by farm) and the Summary (SUMIFS over
// Field Production by county / state / crop / practice). An auditor can click
// any cell, follow the SUMIFS to the field row, then to the exact loads, and
// change a load to watch the totals move. Every rule the engine
// (lib/production-report.ts) applies is written here as a formula; where a
// rule is really an input (a manual override, an entered breakout, a combine
// entry) the input is a BLUE cell and the formula around it stays black.
//
// Layout follows the shared contract (lib/exports.ts): each sheet is a title,
// one line of context with a link back to the Summary, then the table — so
// the frozen header is never more than a few rows and the data is on screen
// the moment the file opens. The contents list sits UNDER the Summary table.
//
// No hidden keys: the SUMIFS criteria are "=" & the row's own Farm / Field /
// Crop / Crop Year cells with Excel's wildcards escaped (lib/formula
// exactCriterion), so a field named "Pivot*" or "<40" matches only itself.
// Two plantings that would read the same (same farm, field, crop and year)
// get the field's display name disambiguated — "North 40 (2)" — on BOTH
// tabs, and the Notes tab says so.
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
// Balanced to settlements (lib/production-balance.ts): a Settlement Balance
//   tab computes settled + delivered-not-settled + still-in-bins ÷ measured
//   as a live factor per grain crop; Field Production gains a balanced
//   production column = measured × that factor (absolute reference) and the
//   Summary's Production / Yield groups read the balanced column while
//   Measured stays visible as its own group.

import { computeBushels } from '@/lib/shrink'
import { truckExportLabel } from '@/lib/trucks'
import { evaluatePayload, formulaLayout, type ExportCell, type ExportColumn, type ExportPayload, type ExportSection, type NumFmt, type PreludeRow } from '@/lib/exports'
import {
  abs, add, cell, col, div, exactCriterion, iferror, iff, le, lt, mul, num, round, self, sheetRef, str, sub, sum, sumifs, gt, rows as rowsRange,
  type FormulaNode, type RangeNode,
} from '@/lib/formula'
import { practiceLabel, unitOf, type Practice, type ProductionLoadRow, type ProductionReport, type Resolved } from '@/lib/production-report'
import { BINS_NOTE, factorLabel, type ProductionBalance } from '@/lib/production-balance'
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
  /** 091: the buyer's full ticket as printed on the matched settlement. */
  buyer_ticket_number?: string | null
  truck_id?: string | null
  truck_label?: string | null
  hauler_truck?: string | null
  to_type?: 'bin' | 'buyer' | null
  to_bin_id?: string | null
  to_buyer_id?: string | null
  from_bin_id?: string | null
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

export type ProductionBasis = 'measured' | 'balanced'

export type ProductionAuditInput = {
  /** The report as shown on screen (balanced factors already applied when basis is 'balanced'). */
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
  /** Production basis; 'balanced' needs `balance`. Default measured. */
  basis?: ProductionBasis
  balance?: ProductionBalance | null
}

// Section keys (sheet names are the titles below).
export const AUDIT = {
  summary: 'summary',
  balance: 'settlement_balance',
  fieldProduction: 'field_production',
  loadData: 'load_data',
  combine: 'combine_entries',
  ginReceipts: 'gin_receipts',
  bales: 'bales',
  settlements: 'settlements',
  unsettled: 'unsettled_deliveries',
  notes: 'notes',
} as const

/** Section key of the i-th county × practice sheet (report.detailSheets order). */
export const countySheetKey = (i: number): string => `county_${i}`

export const ESTIMATED_KIND = 'estimated, not ginned'
export const GINNED_KIND = 'ginned'
export const NO_STATE = '(none)'
const BRAND_GREEN = 'FF36B449'
const TAB_GRAY = 'FF9CA3AF'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const input = (v: number | string | null, format?: NumFmt): ExportCell => ({ v, input: true, format })
const formula = (f: FormulaNode, format?: NumFmt): ExportCell => ({ v: null, f, format })
const text = (v: string | null | undefined): ExportCell => v ?? ''

/** Excel wildcard escaping for a literal criterion ("=" & the text). */
export function literalCriterion(s: string): FormulaNode {
  return str('=' + s.replace(/~/g, '~~').replace(/\*/g, '~*').replace(/\?/g, '~?'))
}

/** Whitespace-normalized text, written identically wherever it is matched. */
export function criteriaText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** The display name per planting: the field's name, disambiguated with
 *  " (2)", " (3)"… when another planting in the export reads the same
 *  (farm + field + crop + crop year, case-insensitive). Pure. */
export function disambiguateFieldNames(
  plantings: ReadonlyArray<{ id: string; farmName: string; fieldName: string; cropName: string; year: number }>,
): { byId: Map<string, string>; renamed: string[] } {
  const byId = new Map<string, string>()
  const taken = new Set<string>()
  const renamed: string[] = []
  for (const p of plantings) {
    const base = criteriaText(p.fieldName)
    let name = base
    let n = 2
    while (taken.has(`${criteriaText(p.farmName)}|${name}|${criteriaText(p.cropName)}|${p.year}`.toLowerCase())) {
      name = `${base} (${n})`
      n++
    }
    if (name !== base) renamed.push(`${p.farmName} / ${base} / ${p.cropName} ${p.year} → "${name}"`)
    taken.add(`${criteriaText(p.farmName)}|${name}|${criteriaText(p.cropName)}|${p.year}`.toLowerCase())
    byId.set(p.id, name)
  }
  return { byId, renamed }
}

function colsOf(defs: Array<ExportColumn & { key: string }>): ExportColumn[] {
  return defs
}

type PlantingRef = { field_id: string; crop_id: string; season_year: number }

/** The export file name: Turnrow_Crop_Insurance_Production_<year>_<crops>_<basis>_<date>. */
export function auditFilename(cropYear: number, cropNames: readonly string[], basis: ProductionBasis, generatedAt: Date): string {
  const crops = cropNames.length === 0 ? 'All' : cropNames.map((c) => c.replace(/[^A-Za-z0-9]+/g, '')).filter(Boolean).join('-')
  const basisText = basis === 'balanced' ? 'Balanced' : 'Measured'
  const d = generatedAt
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `Turnrow_Crop_Insurance_Production_${cropYear}_${crops}_${basisText}_${date}`
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildProductionAuditPayload(input0: ProductionAuditInput): ExportPayload {
  const { report, cropYear } = input0
  const basis: ProductionBasis = input0.basis ?? 'measured'
  const balanced = basis === 'balanced' && !!input0.balance
  const balance = balanced ? input0.balance! : null
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

  const placeOf = (fieldId: string | null) => {
    const fld = fieldId ? fieldById.get(fieldId) ?? null : null
    const farm = fld?.farm_id ? farmById.get(fld.farm_id) ?? null : null
    const countyId = fld?.county_id ?? farm?.county_id ?? null
    const county = countyId ? countyById.get(countyId) ?? null : null
    return {
      field: fld, farm, county,
      farmName: criteriaText(farm?.name ?? '(No Farm)'),
      fieldName: criteriaText(fld?.name_or_number ?? '(No Field)'),
      countyLabel: criteriaText(county ? `${county.name} County` : '(No County)'),
      state: county?.state_code ? criteriaText(county.state_code) : NO_STATE,
    }
  }
  const cropName = (id: string | null) => criteriaText(cropById.get(id ?? '')?.name ?? '(No Crop)')

  // --- Display names: the field, disambiguated when two plantings would read alike. ---
  const sortedResolved = [...report.resolved].sort((a, b) =>
    a.countyLabel.localeCompare(b.countyLabel) || placeOf(a.planting.field_id).farmName.localeCompare(placeOf(b.planting.field_id).farmName) ||
    placeOf(a.planting.field_id).fieldName.localeCompare(placeOf(b.planting.field_id).fieldName) || cropName(a.planting.crop_id).localeCompare(cropName(b.planting.crop_id)))
  const names = disambiguateFieldNames(sortedResolved.map((r) => {
    const pl = placeOf(r.planting.field_id)
    return { id: r.planting.id, farmName: pl.farmName, fieldName: pl.fieldName, cropName: cropName(r.planting.crop_id), year: r.planting.season_year }
  }))
  const displayField = (p: { id: string; field_id: string }) => names.byId.get(p.id) ?? placeOf(p.field_id).fieldName

  const plantingByKey = new Map<string, Resolved | 'in_progress'>()
  for (const r of report.resolved) plantingByKey.set(`${r.planting.field_id}|${r.planting.crop_id}|${r.planting.season_year}`, r)
  for (const p of report.inProgress) plantingByKey.set(`${p.field_id}|${p.crop_id}|${p.season_year}`, 'in_progress')
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

  // --- Load portions → Load Data rows (the engine's exact inclusion rule). ---
  type Portion = { load: AuditLoadRow; split: LoadSplit | null; fieldId: string; cropId: string; pct: number; netApplied: number | null; practice: 'irrigated' | 'dryland' | null }
  const portions: Portion[] = []
  const splitsByLoad = new Map<string, LoadSplit[]>()
  for (const s of input0.splits) {
    const arr = splitsByLoad.get(s.load_id)
    if (arr) arr.push(s)
    else splitsByLoad.set(s.load_id, [s])
  }
  for (const l of input0.loads) {
    if (l.from_type !== 'field') continue
    if (l.from_field_id && l.crop_id) portions.push({ load: l, split: null, fieldId: l.from_field_id, cropId: l.crop_id, pct: 100, netApplied: l.net_weight, practice: l.practice ?? null })
    for (const s of splitsByLoad.get(l.id) ?? []) portions.push({ load: l, split: s, fieldId: s.field_id, cropId: s.crop_id, pct: Number(s.percentage) || 0, netApplied: s.net_weight, practice: s.practice ?? null })
  }
  type LoadDataRow = { portion: Portion; resolved: Resolved; dryBu: number; overridden: boolean; noBase: boolean }
  const loadRows: LoadDataRow[] = []
  for (const po of portions) {
    const l = po.load
    if (!cropInFilter(po.cropId) || !fieldInEntity(po.fieldId)) continue
    if (l.crop_year !== cropYear) continue
    const dateYr = Number(l.date.slice(0, 4))
    if (keyYearFor(po.fieldId, po.cropId, dateYr, l.crop_year) !== cropYear) continue
    const hit = plantingByKey.get(`${po.fieldId}|${po.cropId}|${cropYear}`)
    if (!hit || hit === 'in_progress') continue
    const crop = cropById.get(l.crop_id ?? po.cropId) ?? null
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
    if (po.split ? po.split.dry_bushels == null : !computed.dry) continue
    if (hit.irrigatedAcres <= 0 && hit.drylandAcres <= 0) continue
    loadRows.push({ portion: po, resolved: hit, dryBu: computed.dry ?? 0, overridden: computed.overridden, noBase: crop?.base_moisture_pct == null })
  }
  // Sort: County, Farm, Field, Date, Ticket — each field's loads sit together.
  loadRows.sort((a, b) =>
    a.resolved.countyLabel.localeCompare(b.resolved.countyLabel) ||
    placeOf(a.portion.fieldId).farmName.localeCompare(placeOf(b.portion.fieldId).farmName) ||
    displayField(a.resolved.planting).localeCompare(displayField(b.resolved.planting)) ||
    a.portion.load.date.localeCompare(b.portion.load.date) ||
    (a.portion.load.ticket_number ?? '').localeCompare(b.portion.load.ticket_number ?? '') ||
    a.portion.load.id.localeCompare(b.portion.load.id) ||
    (a.portion.split?.id ?? '').localeCompare(b.portion.split?.id ?? ''))

  // --- Combine Entries rows (resolved plantings whose figure is the combine's). ---
  const combineRows = sortedResolved
    .filter((r) => r.source === 'combine' && r.agg?.combine)
    .map((r) => ({ r, e: entryByKey.get(`${r.planting.field_id}|${r.planting.crop_id}|${r.planting.season_year}`)! }))
    .filter((x) => x.e)

  // --- Cotton rows. ---------------------------------------------------------
  const cotton = input0.cotton ?? null
  type GinRow = { kind: string; r: Resolved; receipt: AuditCottonReceipt | null; est: { seedLbs: number; turnoutPct: number; label: string } | null }
  const ginRows: GinRow[] = []
  const baleRows: Array<{ bale: AuditCottonSources['bales'][number]; receipt: AuditCottonReceipt }> = []
  if (cotton) {
    for (const r of sortedResolved) {
      if (r.source !== 'cotton') continue
      const receipts = cotton.receipts.filter((x) => x.field_id === r.planting.field_id && x.crop_year === r.planting.season_year)
      for (const rc of receipts) {
        ginRows.push({ kind: GINNED_KIND, r, receipt: rc, est: null })
        for (const b of cotton.bales) if (b.gin_receipt_id === rc.id) baleRows.push({ bale: b, receipt: rc })
      }
      const y = cotton.yieldFor(r.planting)
      if (y && y.yardSeedLbs > 0) ginRows.push({ kind: ESTIMATED_KIND, r, receipt: null, est: { seedLbs: y.yardSeedLbs, turnoutPct: y.turnout.fraction * 100, label: y.turnout.label } })
    }
  }
  const hasCotton = ginRows.length > 0
  const hasBales = baleRows.length > 0
  // The receipt as the gin numbers it — the text the Bales tab matches on. A
  // number that repeats (two gins, a reissued statement) is told apart "(2)".
  const receiptLabel = new Map<string, string>()
  {
    const taken = new Set<string>()
    for (const g of ginRows) {
      if (!g.receipt || receiptLabel.has(g.receipt.id)) continue
      const base = criteriaText(g.receipt.statement_number || g.receipt.receipt_number || 'receipt')
      let label = base
      for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${base} (${n})`
      taken.add(label.toLowerCase())
      receiptLabel.set(g.receipt.id, label)
    }
  }
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
  const ST = (c: string): RangeNode => col(S.settlements, c)
  const UN = (c: string): RangeNode => col(S.unsettled, c)
  const crops = report.reportCrops
  const grainCrops = crops.filter((c) => unitOf(c) === 'bu')
  const fmtOf = (c: Crop, grain: NumFmt): NumFmt => (unitOf(c) === 'lbs' ? 'lbs' : grain)
  const loadLink = (id: string): string | undefined => (input0.appOrigin ? `${input0.appOrigin}/loads/${id}` : undefined)
  // Every supporting sheet opens the same way: its title, then ONE line — a
  // link back to the Summary and, starting at the first column that scrolls, a
  // sentence saying what the sheet is. Two rows above the header, no more.
  const sheetHead = (title: string, about: string, textCol: number): PreludeRow[] => [
    { kind: 'title', cells: [title] },
    { kind: 'text', cells: [{ v: '← Summary', link: "#'Summary'!A1" }, ...Array<ExportCell>(Math.max(0, textCol - 1)).fill(null), about] },
  ]
  const openLoad = (id: string): ExportCell => {
    const link = loadLink(id)
    return link ? { v: 'Open', link } : ''
  }

  // Identity criteria: this row's own Farm / Field / Crop / Crop Year against
  // Load Data's columns — exact, wildcard-escaped.
  const identity = (): Array<[RangeNode, FormulaNode]> => [
    [LD('farm'), exactCriterion(self('farm'))], [LD('field'), exactCriterion(self('field'))],
    [LD('crop'), exactCriterion(self('crop'))], [LD('crop_year'), exactCriterion(self('crop_year'))],
  ]
  const identityOn = (range: (c: string) => RangeNode): Array<[RangeNode, FormulaNode]> => [
    [range('farm'), exactCriterion(self('farm'))], [range('field'), exactCriterion(self('field'))],
    [range('crop'), exactCriterion(self('crop'))], [range('crop_year'), exactCriterion(self('crop_year'))],
  ]

  // --- Settlement Balance (balanced only): row index of each crop's factor. ---
  const factorRowByCrop = new Map<string, number>()
  const balanceRows: ExportCell[][] = []
  const balanceCheckIdx: number[] = []
  if (balance) {
    for (const c of grainCrops) {
      const b = balance.byCrop.get(c.id)
      if (!b) continue
      const r0 = balanceRows.length
      const line = (item: string, value: ExportCell, pct: ExportCell = '', note: string = '') => balanceRows.push([item, value, pct, note])
      // The crop-wide measured total: the Summary's measured total when the
      // export covers every entity; under an entity filter the Summary holds
      // only that entity's share, so the all-entities figure is a blue input.
      if (entityId) line(`${c.name}: Measured total, all entities (bu)`, input(b.measured, 'bu3'), '', `the crop\'s production across every entity, before any balance (this export is filtered to ${input0.entityName || 'one entity'}, so the Summary shows only its share)`)
      else line(`${c.name}: Measured total (bu)`, formula(cell(S.summary, `mprod:${c.id}`, report.summaryRows.length), 'bu3'), '', 'the report\'s production for the crop, all entities, before any balance')
      line(`${c.name}: Settled (paid) bu`, formula(sumifs(ST('net_bu'), [ST('crop'), literalCriterion(criteriaText(c.name))]), 'bu3'), '', `buyer net bushels on ${b.settledLines.length} settlement line${b.settledLines.length === 1 ? '' : 's'} across ${b.settlementCount} settlement${b.settlementCount === 1 ? '' : 's'} (Settlements tab)`)
      line(`${c.name}: Delivered, not settled (bu)`, formula(sumifs(UN('dry_bu'), [UN('crop'), literalCriterion(criteriaText(c.name))]), 'bu3'), '', `our dry bushels on ${b.unsettledLoads.length} load${b.unsettledLoads.length === 1 ? '' : 's'} delivered to a buyer with no settlement line yet (Unsettled Deliveries tab)`)
      line(`${c.name}: Still in bins (bu)`, input(b.bins, 'bu3'), '', `${BINS_NOTE}: ${b.binsIn.toFixed(2)} in − ${b.binsOut.toFixed(2)} out${b.binsCombine ? ` + ${b.binsCombine.toFixed(2)} combine remainder` : ''}`)
      line(`${c.name}: Balanced total (bu)`, formula(add(add(cell(S.balance, 'value', r0 + 1), cell(S.balance, 'value', r0 + 2)), cell(S.balance, 'value', r0 + 3)), 'bu3'), '', 'settled + delivered not settled + still in bins')
      factorRowByCrop.set(c.id, r0 + 5)
      line(`${c.name}: Factor`, formula(iferror(div(cell(S.balance, 'value', r0 + 4), cell(S.balance, 'value', r0)), num(1)), 'factor'), formula(sub(cell(S.balance, 'value', r0 + 5), num(1)), 'ratio'), 'balanced total ÷ measured total; every field\'s balanced production = measured × this factor')
      balanceCheckIdx.push(balanceRows.length)
      line(`${c.name}: Check`, formula(iff(lt(abs(sub(cell(S.balance, 'value', r0 + 4), add(add(cell(S.balance, 'value', r0 + 1), cell(S.balance, 'value', r0 + 2)), cell(S.balance, 'value', r0 + 3)))), num(0.5)), str('OK'), str('CHECK'))), '', 'balanced total = settled + unsettled + bins')
      if (b.allPaid) {
        balanceCheckIdx.push(balanceRows.length)
        line(`${c.name}: Production equals bushels paid`, formula(iff(lt(abs(sub(cell(S.balance, 'value', r0 + 4), cell(S.balance, 'value', r0 + 1))), num(0.5)), str('OK'), str('CHECK'))), '', 'nothing unsettled and the bins empty: balanced production is exactly the bushels paid')
      }
      if (entityId) {
        line(`${c.name}: ${input0.entityName || 'This entity'} measured production (bu)`, formula(cell(S.summary, `mprod:${c.id}`, report.summaryRows.length), 'bu3'), '', 'this entity\'s share of the measured production (the Summary measured total)')
        line(`${c.name}: ${input0.entityName || 'This entity'} balanced production (bu)`, formula(cell(S.summary, `prod:${c.id}`, report.summaryRows.length), 'bu3'), '', 'this entity\'s measured production × the crop-wide factor (the Summary balanced total)')
      }
      balanceRows.push(['', '', '', ''])
    }
  }
  const balanceSection: ExportSection | null = balance ? {
    key: S.balance,
    title: 'Settlement Balance',
    plain: true,
    tabColor: undefined,
    autoFilter: false,
    banded: false,
    freezeColumns: 0,
    prelude: sheetHead('Settlement Balance', 'Balanced total = settled + delivered not settled + still in bins. Factor = balanced ÷ measured, applied to every field of the crop.', 1),
    columns: colsOf([
      { key: 'item', label: 'Item', width: 44 },
      { key: 'value', label: 'Value', align: 'right', width: 16, note: 'Bushels, or the factor. Blue = taken from Turnrow records (the bin book figure); black = formula.' },
      { key: 'pct', label: 'As %', align: 'right', width: 10, note: 'Factor − 1, as a percent.' },
      { key: 'note', label: 'Source / rule', width: 70 },
    ]),
    rows: balanceRows,
  } : null
  if (balanceSection) balanceSection.columns[1] = { ...balanceSection.columns[1], kind: 'check' }

  // --- Field Production ------------------------------------------------------
  const fpColumns = colsOf([
    { key: 'farm', label: 'Farm', note: 'The farm the field belongs to. Load Data matches on this text.' },
    { key: 'field', label: 'Field', note: 'The field name (disambiguated with "(2)" when two plantings would read alike). Click to jump to its loads.' },
    { key: 'fsa', label: 'FSA farm #' },
    { key: 'county', label: 'County', note: 'The field\'s county, or the farm\'s when the field has none.' },
    { key: 'state', label: 'State' },
    { key: 'crop', label: 'Crop' },
    { key: 'crop_year', label: 'Crop year', format: 'text' },
    { key: 'unit', label: 'Unit', note: 'bu for grain; lbs (lint) for cotton.' },
    { key: 'practice', label: 'Practice', note: 'Irrigated or Dryland. A mixed planting has one row per practice.' },
    { key: 'status', label: 'Harvest status', note: 'complete, counted anyway (the user overrode an in-progress flag), or not harvested (acres only).' },
    { key: 'source', label: 'Production source', note: 'scale tickets (Load Data), combine monitor (Combine Entries), or gin receipts (cotton).' },
    { key: 'breakout', label: 'Practice split', note: 'single practice; entered breakout (Yields page); from load tags (every load tagged); rolled into dryland (no breakout, generated as dryland).' },
    { key: 'acres', label: 'Acres', format: 'acres2', align: 'right', note: 'Certified acres for this practice: the planting\'s irrigated or dryland acres (blue input).' },
    { key: 'scale_bu', label: 'Scale ticket bu', format: 'bu', align: 'right', note: 'SUMIFS over Load Data dry bushels for this Farm + Field + Crop + Crop Year (and this Practice when the load tags decide the split).' },
    { key: 'combine_bu', label: 'Combine entry bu', format: 'bu', align: 'right', note: 'SUMIFS over Combine Entries adjusted bushels for this field. Blank when no field uses a combine entry.' },
    ...(hasCotton ? [
      { key: 'ginned_lint', label: 'Ginned lint (lbs)', format: 'lbs' as NumFmt, align: 'right' as const, note: 'SUMIFS over Gin Receipts lint lbs for this field, ginned rows only.' },
      { key: 'est_lint', label: 'Estimated lint, not ginned (lbs)', format: 'lbs' as NumFmt, align: 'right' as const, note: 'SUMIFS over Gin Receipts for this field, the "estimated, not ginned" rows: seed cotton still on the yard × the resolved turnout.' },
    ] : []),
    { key: 'entered_irr', label: 'Entered irrigated bu', format: 'bu', align: 'right', note: 'The breakout entered on the Yields page (blue input). Blank unless the split was entered.' },
    { key: 'entered_dry', label: 'Entered dryland bu', format: 'bu', align: 'right', note: 'The breakout entered on the Yields page (blue input). Blank unless the split was entered.' },
    { key: 'field_total', label: 'Field total', format: 'bu', align: 'right', note: 'The whole field\'s measured production: the scale tickets, the combine entry, or ginned + estimated lint.' },
    { key: 'share', label: 'Practice share (fraction)', format: 'dec2', align: 'right', note: 'This practice\'s share of the field total: entered irrigated or dryland ÷ their sum; 1 for a single practice.' },
    { key: 'production', label: 'Measured production', format: 'bu', align: 'right', note: 'Field total × practice share (or the practice SUMIFS when the load tags decide). Full precision is kept in the cell; the format shows whole bushels.' },
    { key: 'yield', label: 'Measured yield (bu/ac)', format: 'yield', align: 'right', note: 'Measured production ÷ acres (0 when acres are 0).' },
    ...(balance ? [
      { key: 'balanced_production', label: 'Balanced production', format: 'bu' as NumFmt, align: 'right' as const, note: 'Measured production × the crop\'s factor on the Settlement Balance tab (absolute reference).' },
      { key: 'balanced_yield', label: 'Balanced yield (bu/ac)', format: 'yield' as NumFmt, align: 'right' as const, note: 'Balanced production ÷ acres.' },
    ] : []),
    { key: 'check', label: 'Check', kind: 'check', note: 'For a mixed planting: OK when the entered (or tagged) irrigated + dryland bushels equal the field total within half a bushel.' },
    { key: 'rule', label: 'Rule', width: 60, wrap: false, note: 'The rule applied to this row, in words.' },
  ])
  type FpRow = { r: Resolved; practice: Practice }
  const fpRows: FpRow[] = []
  // Sort: County, Practice, Farm, Field — the Summary's order.
  for (const practice of ['dryland', 'irrigated'] as Practice[]) {
    for (const r of sortedResolved) {
      if (practice === 'irrigated' ? r.irrigatedAcres > 0 : r.drylandAcres > 0) fpRows.push({ r, practice })
    }
  }
  fpRows.sort((a, b) => a.r.countyLabel.localeCompare(b.r.countyLabel) || a.practice.localeCompare(b.practice) ||
    placeOf(a.r.planting.field_id).farmName.localeCompare(placeOf(b.r.planting.field_id).farmName) ||
    displayField(a.r.planting).localeCompare(displayField(b.r.planting)) || cropName(a.r.planting.crop_id).localeCompare(cropName(b.r.planting.crop_id)))
  const fpSection: ExportSection = {
    key: S.fieldProduction,
    title: 'Field Production',
    plain: true,
    freezeColumns: 2,
    prelude: sheetHead('Field Production', 'One row per field and practice. Click a field name to see its loads; the Rule column says how its production was worked out.', 2),
    columns: fpColumns,
    rows: fpRows.map(({ r, practice }) => {
      const crop = cropById.get(r.planting.crop_id)
      const cName = cropName(r.planting.crop_id)
      const unit = crop ? unitOf(crop) : 'bu'
      const fmtBu: NumFmt = unit === 'lbs' ? 'lbs' : 'bu'
      const place = placeOf(r.planting.field_id)
      const pLabel = practiceLabel(practice)
      const acres = practice === 'irrigated' ? r.irrigatedAcres : r.drylandAcres
      const status = r.countedAnyway ? 'counted anyway' : r.harvestStatus === 'unharvested' ? 'not harvested' : 'complete'
      const sourceText = r.source === 'combine' ? 'combine monitor' : r.source === 'cotton' ? 'gin receipts' : 'scale tickets'
      const breakoutText = r.breakout === 'single' ? 'single practice' : r.breakout === 'entered' ? 'entered breakout' : r.breakout === 'loads' ? 'from load tags' : 'rolled into dryland'
      const scaleBu = r.breakout === 'loads'
        ? sumifs(LD('dry_bu'), ...identity(), [LD('practice'), exactCriterion(self('practice'))])
        : sumifs(LD('dry_bu'), ...identity())
      const combineBu = hasCombine ? sumifs(CE('adjusted_bu'), ...identityOn(CE)) : null
      const ginned = hasCotton ? sumifs(GR('lint_lbs'), ...identityOn(GR), [GR('kind'), str(GINNED_KIND)]) : null
      const est = hasCotton ? sumifs(GR('lint_lbs'), ...identityOn(GR), [GR('kind'), str(ESTIMATED_KIND)]) : null
      const fieldTotal: FormulaNode =
        r.source === 'combine' && combineBu ? self('combine_bu')
        : r.source === 'cotton' && ginned ? add(self('ginned_lint'), self('est_lint'))
        : sumifs(LD('dry_bu'), ...identity())
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
            sumifs(LD('dry_bu'), ...identity(), [LD('practice'), str('=Irrigated')]),
            sumifs(LD('dry_bu'), ...identity(), [LD('practice'), str('=Dryland')]),
          ), self('field_total'))), num(0.5)), str('OK'), str('CHECK')))
          rule = 'Mixed planting, every load tagged: production is the sum of this practice\'s tagged load portions. Check: irrigated + dryland tagged loads = field total.'
          break
        case 'rolled_dryland':
          share = num(practice === 'dryland' ? 1 : 0)
          production = practice === 'dryland' ? self('field_total') : num(0)
          rule = 'Mixed planting with no breakout, generated as dryland: all production on the dryland row; acres stay split.'
          break
      }
      if (r.source === 'combine') rule = `Combine entry is the field's production; scale tickets from this field are netted inside it, not added. ${rule}`
      if (r.source === 'cotton') rule = `Cotton: lint lbs = ginned receipts + the turnout estimate on unginned seed cotton. ${rule}`
      const factorRow = balance ? factorRowByCrop.get(r.planting.crop_id) : undefined
      const entered = r.breakout === 'entered'
      return [
        place.farmName,
        displayField(r.planting),
        text(place.farm?.fsa_number),
        place.countyLabel,
        place.state,
        cName,
        r.planting.season_year,
        unit,
        pLabel,
        status,
        sourceText,
        breakoutText,
        input(acres, 'acres2'),
        formula(scaleBu, fmtBu),
        combineBu ? formula(combineBu, 'bu') : '',
        ...(hasCotton ? [ginned ? formula(ginned, 'lbs') : '', est ? formula(est, 'lbs') : ''] : []),
        entered ? input(r.planting.irrigated_bushels != null ? Number(r.planting.irrigated_bushels) : 0, fmtBu) : '',
        entered ? input(r.planting.dryland_bushels != null ? Number(r.planting.dryland_bushels) : 0, fmtBu) : '',
        formula(fieldTotal, fmtBu),
        formula(share, 'dec2'),
        formula(production, fmtBu),
        formula(iferror(div(self('production'), self('acres')), num(0)), 'yield'),
        ...(balance ? [
          factorRow != null ? formula(mul(self('production'), cell(S.balance, 'value', factorRow)), fmtBu) : formula(self('production'), fmtBu),
          formula(iferror(div(self('balanced_production'), self('acres')), num(0)), 'yield'),
        ] : []),
        check,
        rule,
      ]
    }),
  }

  // --- Summary ---------------------------------------------------------------
  const n = report.summaryRows.length
  const prodCol = balance ? 'balanced_production' : 'production'
  const sumCols = colsOf([
    { key: 'county', label: 'County' },
    { key: 'state', label: 'State' },
    { key: 'practice', label: 'Practice' },
    ...crops.map((c) => ({ key: `acres:${c.id}`, label: c.name, format: 'acres2' as NumFmt, align: 'right' as const, note: `SUMIFS over Field Production acres for ${c.name}, this county, state and practice.` })),
    ...crops.map((c) => ({ key: `prod:${c.id}`, label: `${c.name} (${unitOf(c)})`, format: fmtOf(c, 'bu'), align: 'right' as const, note: balance && unitOf(c) === 'bu' ? `SUMIFS over Field Production balanced production for ${c.name} (measured × the settlement factor).` : `SUMIFS over Field Production measured production for ${c.name}.` })),
    ...crops.map((c) => ({ key: `yield:${c.id}`, label: `${c.name} (${unitOf(c)}/ac)`, format: 'yield' as NumFmt, align: 'right' as const, note: 'Production ÷ acres; the Total row divides total production by total acres.' })),
    ...(balance ? [
      ...crops.map((c) => ({ key: `mprod:${c.id}`, label: `${c.name} (${unitOf(c)})`, format: fmtOf(c, 'bu'), align: 'right' as const, note: `SUMIFS over Field Production measured production for ${c.name} — scale tickets, before the settlement balance.` })),
      ...crops.map((c) => ({ key: `myield:${c.id}`, label: `${c.name} (${unitOf(c)}/ac)`, format: 'yield' as NumFmt, align: 'right' as const, note: 'Measured production ÷ acres.' })),
    ] : []),
  ])
  const summaryRows: ExportCell[][] = report.summaryRows.map((row) => {
    const place = { countyLabel: criteriaText(row.countyLabel), state: row.county?.state_code ? criteriaText(row.county.state_code) : NO_STATE }
    const crit = (c: Crop): Array<[RangeNode, FormulaNode]> => [
      [FP('county'), exactCriterion(self('county'))], [FP('state'), exactCriterion(self('state'))],
      [FP('crop'), literalCriterion(criteriaText(c.name))], [FP('practice'), exactCriterion(self('practice'))],
    ]
    return [
      place.countyLabel,
      place.state,
      practiceLabel(row.practice),
      ...crops.map((c) => formula(sumifs(FP('acres'), ...crit(c)), 'acres2')),
      ...crops.map((c) => formula(sumifs(FP(unitOf(c) === 'bu' ? prodCol : 'production'), ...crit(c)), fmtOf(c, 'bu'))),
      ...crops.map((c) => formula(iferror(div(self(`prod:${c.id}`), self(`acres:${c.id}`)), num(0)), 'yield')),
      ...(balance ? [
        ...crops.map((c) => formula(sumifs(FP('production'), ...crit(c)), fmtOf(c, 'bu'))),
        ...crops.map((c) => formula(iferror(div(self(`mprod:${c.id}`), self(`acres:${c.id}`)), num(0)), 'yield')),
      ] : []),
    ]
  })
  const totalRow: ExportCell[] = [
    'Total', '', '',
    ...crops.map((c) => formula(n > 0 ? sum(rowsRange(S.summary, `acres:${c.id}`, 0, n - 1)) : num(0), 'acres2')),
    ...crops.map((c) => formula(n > 0 ? sum(rowsRange(S.summary, `prod:${c.id}`, 0, n - 1)) : num(0), fmtOf(c, 'bu'))),
    ...crops.map((c) => formula(iferror(div(self(`prod:${c.id}`), self(`acres:${c.id}`)), num(0)), 'yield')),
    ...(balance ? [
      ...crops.map((c) => formula(n > 0 ? sum(rowsRange(S.summary, `mprod:${c.id}`, 0, n - 1)) : num(0), fmtOf(c, 'bu'))),
      ...crops.map((c) => formula(iferror(div(self(`mprod:${c.id}`), self(`acres:${c.id}`)), num(0)), 'yield')),
    ] : []),
  ]
  const totalIdx = n
  const basisLabel = balance ? 'Balanced to settlements' : 'Measured (scale tickets)'
  const generated = input0.generatedAt
  const generatedText = `${generated.getMonth() + 1}/${generated.getDate()}/${generated.getFullYear()}`
  /** The one line of context every report sheet carries under its title. */
  const contextLine = `${input0.orgName} · ${cropYear} crop · ${input0.entityName || 'All entities'} · ${input0.cropFilterLabel} · ${basisLabel} · Generated ${generatedText}`
  // The Summary opens on its table: title, one line of context, the header.
  // What used to sit above it (a KPI per crop, the contents list) pushed the
  // table below the fold and froze there; the totals ARE the Total row, and
  // the contents list now follows the table (filled in below, once the sheet
  // names are known).
  const summarySection: ExportSection = {
    key: S.summary,
    title: 'Summary',
    plain: true,
    tabColor: BRAND_GREEN,
    freezeColumns: 3,
    autoFilter: false,
    prelude: [
      { kind: 'title', cells: [`${cropYear} Crop Insurance Production Report`] },
      { kind: 'text', cells: [contextLine] },
    ],
    columns: sumCols,
    groups: crops.length > 0 ? [
      { label: '', span: 3 },
      { label: 'Certified Acres', span: crops.length },
      { label: balance ? 'Balanced Production' : 'Production', span: crops.length },
      { label: balance ? 'Balanced Yield per Acre' : 'Yield per Acre', span: crops.length },
      ...(balance ? [{ label: 'Measured Production', span: crops.length }, { label: 'Measured Yield per Acre', span: crops.length }] : []),
    ] : undefined,
    rows: [...summaryRows, totalRow],
    rowMeta: [...report.summaryRows.map(() => 'data' as const), 'total'],
  }

  // --- County × practice sheets -------------------------------------------------
  // The pages the screen shows and an insurance agent files by: one sheet per
  // county and practice, a row per farm with its FSA number, and certified
  // acres / production / yield for each crop grown there. Every figure is a
  // SUMIFS over Field Production for the farm (so it ties to the Summary and
  // traces to the loads). Farms are matched by NAME, as Field Production
  // lists them: two farm records that share a name in one county are one row
  // here, their FSA numbers listed together.
  const countySections: ExportSection[] = report.detailSheets.map((sheet, si) => {
    const pLabel = practiceLabel(sheet.practice)
    const countyLabel = criteriaText(sheet.countyLabel)
    const state = sheet.county?.state_code ? criteriaText(sheet.county.state_code) : NO_STATE
    const sheetFarms = [...sheet.farms.values()]
    // Only the crops grown on this sheet, as on screen — a county page stays narrow.
    const sheetCrops = crops.filter((c) => sheetFarms.some((f) => (f.byCrop.get(c.id)?.acres ?? 0) > 0))
    const byName = new Map<string, { name: string; fsa: string[] }>()
    for (const f of sheetFarms) {
      const name = criteriaText(f.farmName)
      const entry = byName.get(name.toLowerCase()) ?? { name, fsa: [] }
      if (f.fsaNumber && !entry.fsa.includes(f.fsaNumber)) entry.fsa.push(f.fsaNumber)
      byName.set(name.toLowerCase(), entry)
    }
    const farmRows = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    const m = farmRows.length
    const key = countySheetKey(si)
    const crit = (c: Crop): Array<[RangeNode, FormulaNode]> => [
      [FP('farm'), exactCriterion(self('farm'))], [FP('county'), literalCriterion(countyLabel)], [FP('state'), literalCriterion(state)],
      [FP('crop'), literalCriterion(criteriaText(c.name))], [FP('practice'), literalCriterion(pLabel)],
    ]
    const prodOf = (c: Crop) => (unitOf(c) === 'bu' ? prodCol : 'production')
    return {
      key,
      title: sheet.sheetName,
      plain: true,
      tabColor: BRAND_GREEN,
      freezeColumns: 2,
      autoFilter: false,
      prelude: sheetHead(`${countyLabel} — ${pLabel}`, contextLine, 2),
      columns: colsOf([
        { key: 'farm', label: 'Farm', note: 'The farm, as Field Production lists it.' },
        { key: 'fsa', label: 'FSA farm #' },
        ...sheetCrops.map((c) => ({ key: `acres:${c.id}`, label: c.name, format: 'acres2' as NumFmt, align: 'right' as const })),
        ...sheetCrops.map((c) => ({ key: `prod:${c.id}`, label: `${c.name} (${unitOf(c)})`, format: fmtOf(c, 'bu'), align: 'right' as const })),
        ...sheetCrops.map((c) => ({ key: `yield:${c.id}`, label: `${c.name} (${unitOf(c)}/ac)`, format: 'yield' as NumFmt, align: 'right' as const })),
      ]),
      groups: sheetCrops.length > 0 ? [
        { label: '', span: 2 },
        { label: `Certified ${pLabel} Acres`, span: sheetCrops.length },
        { label: `${balance ? 'Balanced ' : ''}${pLabel} Production`, span: sheetCrops.length },
        { label: 'Yield per Acre', span: sheetCrops.length },
      ] : undefined,
      rows: [
        ...farmRows.map((f): ExportCell[] => [
          f.name,
          f.fsa.join(', '),
          ...sheetCrops.map((c) => formula(sumifs(FP('acres'), ...crit(c)), 'acres2')),
          ...sheetCrops.map((c) => formula(sumifs(FP(prodOf(c)), ...crit(c)), fmtOf(c, 'bu'))),
          ...sheetCrops.map((c) => formula(iferror(div(self(`prod:${c.id}`), self(`acres:${c.id}`)), num(0)), 'yield')),
        ]),
        [
          'Total', '',
          ...sheetCrops.map((c) => formula(m > 0 ? sum(rowsRange(key, `acres:${c.id}`, 0, m - 1)) : num(0), 'acres2')),
          ...sheetCrops.map((c) => formula(m > 0 ? sum(rowsRange(key, `prod:${c.id}`, 0, m - 1)) : num(0), fmtOf(c, 'bu'))),
          ...sheetCrops.map((c) => formula(iferror(div(self(`prod:${c.id}`), self(`acres:${c.id}`)), num(0)), 'yield')),
        ],
      ],
      rowMeta: [...farmRows.map(() => 'data' as const), 'total'],
    }
  })

  // --- Load Data ---------------------------------------------------------------
  const ldColumns = colsOf([
    { key: 'date', label: 'Date', format: 'date', note: 'The load\'s date as entered.' },
    { key: 'ticket', label: 'Our ticket #', note: 'The scale ticket number as entered on the load.' },
    { key: 'buyer_ticket', label: 'Buyer ticket #', note: 'The buyer\'s ticket number as printed on the matched settlement, when matched.' },
    { key: 'load', label: 'Load record', note: 'Opens the load in Turnrow.' },
    { key: 'truck', label: 'Truck' },
    { key: 'farm', label: 'Farm', note: 'Field Production matches on this text.' },
    { key: 'field', label: 'Field', note: 'Field Production matches on this text (disambiguated the same way).' },
    { key: 'county', label: 'County' },
    { key: 'state', label: 'State' },
    { key: 'crop', label: 'Crop' },
    { key: 'crop_year', label: 'Crop year', format: 'text' },
    { key: 'practice', label: 'Practice (load tag)', note: 'The irrigated / dryland tag on the load or split portion, when set.' },
    { key: 'destination', label: 'Destination', note: 'The bin or the buyer the load went to.' },
    { key: 'gross', label: 'Gross (lb)', format: 'lbs', align: 'right' },
    { key: 'tare', label: 'Tare (lb)', format: 'lbs', align: 'right' },
    { key: 'net', label: 'Net (lb)', format: 'lbs', align: 'right', note: 'Net pounds on the ticket (blue input). Change it and every total above recalculates.' },
    { key: 'split_pct', label: 'Split (%)', format: 'pct1', align: 'right', note: '100 for a whole load; a split load\'s share for this field.' },
    { key: 'net_applied', label: 'Net applied (lb)', format: 'lbs', align: 'right', note: 'Net × split ÷ 100.' },
    { key: 'moisture', label: 'Moisture (%)', format: 'dec1', align: 'right', note: 'The measured moisture (blue input). Blank = none recorded, so no shrink.' },
    { key: 'base_mc', label: 'Base moisture (%)', format: 'dec1', align: 'right', note: 'The crop\'s base moisture from Settings → Crops.' },
    { key: 'lb_bu', label: 'Lb per bu', format: 'dec1', align: 'right', note: 'The crop\'s pounds per bushel from Settings → Crops.' },
    { key: 'wet_bu', label: 'Wet bu', format: 'bu2', align: 'right', note: 'Net applied ÷ lb per bu.' },
    { key: 'dry_bu', label: 'Dry bu', format: 'bu2', align: 'right', note: 'Wet bu shrunk to base moisture: if moisture is at or below base, wet bu; otherwise wet × (100 − moisture) ÷ (100 − base). A split portion is rounded to 2 decimals as stored; a manual override is the blue value.' },
    { key: 'override', label: 'Override', note: '"manual override" when the load\'s dry bushels were entered by hand.' },
    { key: 'note', label: 'Note', width: 40 },
    { key: 'test_weight', label: 'Test weight', format: 'dec1', align: 'right' },
    { key: 'settlement', label: 'Settlement #', note: 'Cross-check only: the settlement the load was paid on.' },
    { key: 'buyer_net_bu', label: 'Buyer net bu (cross-check)', format: 'bu2', align: 'right', note: 'Cross-check only, never summed: the buyer\'s net bushels on the settlement line.' },
  ])
  const loadDataSection: ExportSection = {
    key: S.loadData,
    title: 'Load Data',
    plain: true,
    freezeColumns: 2,
    prelude: sheetHead('Load Data', 'One row per load that counts; a split load has one row per field share. Production is counted when grain leaves the field, so loads hauled out of a bin are not listed.', 2),
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
      return [
        l.date,
        text(l.ticket_number),
        text(l.buyer_ticket_number ?? line?.buyer_ticket_number),
        openLoad(l.id),
        truckExportLabel({ truck_label: l.truck_label, truck: l.truck_id ? { name_or_number: truckById.get(l.truck_id) ?? '' } : null, hauler_truck: l.hauler_truck }),
        place.farmName,
        displayField(r.planting),
        place.countyLabel,
        place.state,
        cropName(po.cropId),
        l.crop_year ?? '',
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
        formula(wet, 'bu2'),
        overridden && !po.split ? input(dryBu, 'bu2') : formula(dryFormula, 'bu2'),
        overridden && !po.split ? 'manual override' : '',
        note,
        input(l.test_weight ?? null, 'dec1'),
        text(settlement?.settlement_number),
        buyerNet == null ? '' : input(buyerNet, 'bu2'),
      ]
    }),
  }

  // --- Combine Entries -------------------------------------------------------
  const combineSection: ExportSection | null = hasCombine ? {
    key: S.combine,
    title: 'Combine Entries',
    plain: true,
    freezeColumns: 2,
    prelude: sheetHead('Combine Entries', 'No scale ticket: bushels from the combine yield monitor. The adjusted figure is the field\'s production.', 2),
    columns: colsOf([
      { key: 'farm', label: 'Farm' },
      { key: 'field', label: 'Field' },
      { key: 'county', label: 'County' },
      { key: 'state', label: 'State' },
      { key: 'crop', label: 'Crop' },
      { key: 'crop_year', label: 'Crop year', format: 'text' },
      { key: 'date', label: 'Entry date', format: 'date' },
      { key: 'stated_bu', label: 'Monitor bushels (stated)', format: 'bu2', align: 'right', note: 'What the yield monitor said (blue input).' },
      { key: 'adjust', label: 'Calibration adj. (bu/ac)', format: 'dec1', align: 'right', note: 'The ± bu/ac calibration offset entered with the figure.' },
      { key: 'adjusted_bu', label: 'Adjusted bushels (used)', format: 'bu2', align: 'right', note: 'Stated + adjustment × acres, as stored — the field\'s production (blue input).' },
      { key: 'complete', label: 'Harvest complete' },
      { key: 'netted_bu', label: 'Scale tickets netted (bu)', format: 'bu2', align: 'right', note: 'SUMIFS over Load Data for this field: weighed loads netted inside the entry, not added.' },
      { key: 'remainder_bu', label: 'Remainder to storage (bu)', format: 'bu2', align: 'right', note: 'Adjusted − netted: what went to the bin without a ticket.' },
      { key: 'notes', label: 'Notes', width: 40 },
    ]),
    rows: combineRows.map(({ r, e }) => {
      const place = placeOf(r.planting.field_id)
      return [
        place.farmName,
        displayField(r.planting),
        place.countyLabel,
        place.state,
        cropName(r.planting.crop_id),
        r.planting.season_year,
        e.entry_date,
        input(Number(e.stated_total_bushels) || 0, 'bu2'),
        input(e.adjustment_bu_per_acre == null ? null : Number(e.adjustment_bu_per_acre), 'dec1'),
        input(Number(e.adjusted_total_bushels) || 0, 'bu2'),
        e.harvest_complete ? 'yes' : 'no',
        formula(sumifs(LD('dry_bu'), ...identity()), 'bu2'),
        formula(sub(self('adjusted_bu'), self('netted_bu')), 'bu2'),
        text(e.notes),
      ]
    }),
  } : null

  // --- Gin Receipts + Bales (cotton) -----------------------------------------
  const ginSection: ExportSection | null = hasCotton ? {
    key: S.ginReceipts,
    title: 'Gin Receipts',
    plain: true,
    freezeColumns: 2,
    prelude: sheetHead('Gin Receipts', `Lint per receipt: the bale weights when the bales are listed, else the receipt's stated bale weight. "${ESTIMATED_KIND}" rows are seed cotton picked but not yet ginned, valued at the turnout.`, 2),
    columns: colsOf([
      { key: 'kind', label: 'Kind', note: '"ginned" (a receipt) or "estimated, not ginned" (seed cotton still on the yard).' },
      { key: 'receipt', label: 'Receipt / statement #', note: 'The gin\'s receipt or statement number (a repeated number is told apart with "(2)"). The Bales tab matches on this text.' },
      { key: 'gin', label: 'Gin' },
      { key: 'date', label: 'Date', format: 'date' },
      { key: 'farm', label: 'Farm' },
      { key: 'field', label: 'Field' },
      { key: 'county', label: 'County' },
      { key: 'state', label: 'State' },
      { key: 'crop', label: 'Crop' },
      { key: 'crop_year', label: 'Crop year', format: 'text' },
      { key: 'practice', label: 'Practice' },
      { key: 'modules', label: 'Modules', format: 'int', align: 'right' },
      { key: 'seed_lbs', label: 'Seed cotton (lb)', format: 'lbs', align: 'right' },
      { key: 'bales', label: 'Bales', format: 'int', align: 'right' },
      { key: 'stated_lint', label: 'Stated bale weight (lb)', format: 'lbs', align: 'right' },
      { key: 'bale_lbs', label: 'Bale rows (lb)', format: 'lbs', align: 'right', note: 'SUMIFS over the Bales tab for this receipt.' },
      { key: 'turnout', label: 'Turnout (%)', format: 'pct1', align: 'right', note: 'Lint ÷ seed cotton × 100; on an estimate row the resolved turnout (blue input).' },
      { key: 'lint_lbs', label: 'Lint (lb)', format: 'lbs', align: 'right', note: 'Bale rows when any, else the stated bale weight; on an estimate row seed cotton × turnout.' },
      { key: 'basis', label: 'Basis' },
    ]),
    rows: ginRows.map((g) => {
      const place = placeOf(g.r.planting.field_id)
      const practice = g.r.isMixed ? 'Mixed' : g.r.irrigatedAcres > 0 ? 'Irrigated' : 'Dryland'
      const common = [place.farmName, displayField(g.r.planting), place.countyLabel, place.state, cropName(g.r.planting.crop_id), g.r.planting.season_year, practice]
      if (g.receipt) {
        const rc = g.receipt
        const balesHere = baleRows.filter((b) => b.receipt.id === rc.id)
        const baleLbs = hasBales ? formula(sumifs(BL('net_lbs'), [BL('receipt'), exactCriterion(self('receipt'))]), 'lbs') : ''
        const lint = hasBales ? formula(iff(gt(self('bale_lbs'), num(0)), self('bale_lbs'), self('stated_lint')), 'lbs') : formula(self('stated_lint'), 'lbs')
        return [
          GINNED_KIND, receiptLabel.get(rc.id) ?? '', ginById.get(rc.gin_id ?? '') ?? '', rc.receipt_date ?? '',
          ...common,
          input(rc.modules_count ?? null, 'int'),
          input(rc.total_seed_cotton_weight == null ? null : Number(rc.total_seed_cotton_weight), 'lbs'),
          input(balesHere.length > 0 ? balesHere.length : rc.bales_count ?? null, 'int'),
          input(rc.total_bale_weight == null ? null : Number(rc.total_bale_weight), 'lbs'),
          baleLbs,
          formula(iferror(div(mul(self('lint_lbs'), num(100)), self('seed_lbs')), num(0)), 'pct1'),
          lint,
          'ginned',
        ]
      }
      const est = g.est!
      return [
        ESTIMATED_KIND, '(estimate)', '', '',
        ...common,
        '', input(est.seedLbs, 'lbs'), '', '', '',
        input(est.turnoutPct, 'pct1'),
        formula(div(mul(self('seed_lbs'), self('turnout')), num(100)), 'lbs'),
        `estimated, not ginned: ${est.label}`,
      ]
    }),
  } : null

  const balesSection: ExportSection | null = hasBales ? {
    key: S.bales,
    title: 'Bales',
    plain: true,
    prelude: sheetHead('Bales', 'The bale weights behind each gin receipt.', 1),
    columns: colsOf([
      { key: 'pbi', label: 'PBI' },
      { key: 'receipt', label: 'Receipt / statement #' },
      { key: 'net_lbs', label: 'Net (lb)', format: 'lbs', align: 'right' },
    ]),
    rows: baleRows.map(({ bale, receipt }) => [
      bale.pbi_number, receiptLabel.get(receipt.id) ?? '',
      input(bale.net_weight_lbs == null ? null : Number(bale.net_weight_lbs), 'lbs'),
    ]),
  } : null

  // --- Settlements + Unsettled Deliveries (balanced only) --------------------
  const sourceOf = (l: { from_type: string | null; from_field_id: string | null; from_bin_id?: string | null }) =>
    l.from_type === 'field' ? (l.from_field_id ? placeOf(l.from_field_id).fieldName : 'field') : l.from_type === 'bin' ? `bin: ${binById.get(l.from_bin_id ?? '') ?? ''}`.trim() : ''
  const settlementsSection: ExportSection | null = balance ? {
    key: S.settlements,
    title: 'Settlements',
    plain: true,
    freezeColumns: 2,
    prelude: sheetHead('Settlements', 'Every settlement line counted for the crop year, through the load it was matched to (each line once). Lines not matched to a load are not listed; the report screen names them.', 2),
    columns: colsOf([
      { key: 'settlement', label: 'Settlement #' },
      { key: 'date', label: 'Settlement date', format: 'date' },
      { key: 'buyer', label: 'Buyer' },
      { key: 'ticket', label: 'Ticket', note: 'The buyer\'s ticket on the line, else ours.' },
      { key: 'load', label: 'Load record' },
      { key: 'source', label: 'Load source', note: 'The field the load came from, or the bin it was hauled out of.' },
      { key: 'crop', label: 'Crop' },
      { key: 'crop_year', label: 'Crop year', format: 'text' },
      { key: 'net_bu', label: 'Buyer net bu', format: 'bu2', align: 'right', note: 'The buyer\'s net bushels on the line (blue input) — the bushels paid for.' },
    ]),
    rows: grainCrops.flatMap((c) => (balance.byCrop.get(c.id)?.settledLines ?? []).map((x) => {
      return [
        text(x.settlement?.settlement_number),
        x.settlement?.settlement_date ?? '',
        buyerById.get(x.settlement?.buyer_id ?? '') ?? '',
        x.line.ticket_number || (x.load as AuditLoadRow).buyer_ticket_number || x.load.ticket_number || '',
        openLoad(x.load.id),
        sourceOf(x.load),
        criteriaText(c.name),
        x.load.crop_year ?? '',
        input(x.netBu, 'bu2'),
      ]
    })),
  } : null
  const unsettledSection: ExportSection | null = balance ? {
    key: S.unsettled,
    title: 'Unsettled Deliveries',
    plain: true,
    freezeColumns: 2,
    prelude: sheetHead('Unsettled Deliveries', 'Loads delivered to a buyer with no settlement line yet (price-later deliveries included). The balance changes as settlements arrive.', 2),
    columns: colsOf([
      { key: 'date', label: 'Date', format: 'date' },
      { key: 'ticket', label: 'Our ticket #' },
      { key: 'buyer', label: 'Buyer' },
      { key: 'load', label: 'Load record' },
      { key: 'source', label: 'Load source' },
      { key: 'crop', label: 'Crop' },
      { key: 'crop_year', label: 'Crop year', format: 'text' },
      { key: 'dry_bu', label: 'Dry bu', format: 'bu2', align: 'right', note: 'Our dry bushels for the load (blue input) — the app\'s own figure.' },
    ]),
    rows: grainCrops.flatMap((c) => (balance.byCrop.get(c.id)?.unsettledLoads ?? []).map((x) => {
      return [
        x.load.date, text(x.load.ticket_number), buyerById.get(x.load.to_buyer_id ?? '') ?? '',
        openLoad(x.load.id), sourceOf(x.load), criteriaText(c.name), x.load.crop_year ?? '',
        input(x.dryBu, 'bu2'),
      ]
    })),
  } : null

  // --- Notes -----------------------------------------------------------------
  // A page to READ: headings, wrapped paragraphs, no filter buttons or banding.
  const notesRows: ExportCell[][] = []
  const notesMeta: Array<'data' | 'subhead'> = []
  const line = (item: string, value: ExportCell = '', check: ExportCell = '') => { notesRows.push([item, value, check]); notesMeta.push('data') }
  const heading = (label: string) => { notesRows.push([label, '', '']); notesMeta.push('subhead') }
  heading('How this workbook is built')
  line('The Summary and the county sheets are the report: certified acres, production and yield by county and practice, then farm by farm. The tabs after them are the records behind those numbers.')
  line('Load Data lists every load portion that counts: one row per load, or one row per field share of a split load. Net lbs applied = net lbs × split %.')
  line('Field Production has one row per planting and practice. Its Scale ticket bu is a SUMIFS over Load Data matching the row\'s own Farm, Field, Crop and Crop Year (and Practice where the load tags decide the split); its production applies the practice rule in the Rule column.')
  line('Summary sums Field Production by county, state, crop and practice with SUMIFS; each county sheet sums it by farm. Yield per acre is production ÷ acres; the Total row sums the rows above and its yield is total production ÷ total acres, never an average of yields.')
  line('To trace a number: click a Summary or county-sheet cell, read its SUMIFS, find the matching rows on Field Production, then click the field name (or match Farm + Field + Crop + Crop Year) on Load Data. Change a load\'s net lbs or moisture and every total above it recalculates.')
  line('Matching text: every SUMIFS criterion is "=" & the row\'s own cell with Excel\'s wildcard characters (* ? ~) escaped, so a field named "Pivot*" or "<40" matches only itself.')
  if (names.renamed.length > 0) {
    line('Two plantings would have read the same (same farm, field, crop and crop year), so the field name is disambiguated identically on every tab:')
    for (const r of names.renamed) line(`  ${r}`)
  }
  line('')
  heading('Shrink (dry bushels), exactly as Turnrow computes each load')
  line('Wet bu = net lbs applied ÷ lb per bushel. If moisture is at or below the crop\'s base moisture (or no moisture was recorded) dry bu = wet bu. Otherwise dry bu = wet bu × (100 − moisture) ÷ (100 − base moisture).')
  line('Excel: =IF(moisture<=base, net/lb, net/lb*(100-moisture)/(100-base)). A split portion is ROUNDed to 2 decimals because that is how the app stores it; a whole load is not rounded.')
  line('A load with a manual dry-bushel override shows the override (blue) with the note "manual override". A parent load\'s override is not spread over its split portions.')
  line('A field with a combine-monitor entry uses the entry\'s adjusted bushels as its production; scale tickets from that field are netted inside the entry, not added to it (see Combine Entries).')
  line('')
  if (balance) {
    heading('Production basis: balanced to settlements')
    line('An auditor compares reported production to the bushels the buyers paid for, and scale-ticket dry bushels never match buyer net bushels exactly (buyer shrink, FM, dockage). So, per grain crop and crop year, across every entity: settled = buyer net bushels on saved settlement lines whose matched load is this crop and year; delivered not settled = our dry bushels on loads delivered to a buyer with no settlement line yet; still in bins = the book inventory for the crop year (loads in minus loads out, plus combine remainders posted to a bin; measure bins to support farm-stored production).')
    line('Balanced total = settled + delivered not settled + still in bins. Factor = balanced ÷ measured. Every field\'s balanced production = its measured production × the factor (an entity filter still uses the crop-wide factor). When nothing is unsettled and the bins are empty, balanced production is exactly the bushels paid.')
    for (const c of grainCrops) {
      const b = balance.byCrop.get(c.id)
      if (b) line(`${c.name}: factor ${factorLabel(b.factor)} — settled ${b.settled.toFixed(3)} + unsettled ${b.unsettled.toFixed(3)} + bins ${b.bins.toFixed(3)} = ${b.balancedTotal.toFixed(3)} over measured ${b.measured.toFixed(3)}.`)
      if (b && b.unmatched.lines > 0) line(`${c.name}: ${b.unmatched.lines} settlement line${b.unmatched.lines === 1 ? '' : 's'} (${b.unmatched.bu.toFixed(2)} bu) on these settlements are not matched to a load and cannot count until matched.`)
    }
    if (balance.orphanUnmatched.lines > 0) line(`${balance.orphanUnmatched.lines} settlement line${balance.orphanUnmatched.lines === 1 ? '' : 's'} (${balance.orphanUnmatched.bu.toFixed(2)} bu) on settlements with no matched load at all are not matched and cannot count until matched.`)
    line('Balancing is a report option only: Yields, Marketing, the Claims Monitor and the partner API keep measured production. Cotton is never balanced; it already reports the gin\'s lint.')
    line('')
  }
  heading('Colors')
  line('Blue cells are values taken straight from Turnrow records: weights, moisture, acres, overrides, entered breakouts, combine entries, gin receipts, settlement lines. Black cells are formulas. Change a blue cell and the formulas follow.')
  line('')
  heading('What is not here')
  line('Loads hauled out of a bin are not listed: production is counted when grain leaves the field, so counting a bin load as well would count the same bushels twice. Loads the report leaves out (a different calendar year than the crop year, no planting for the field, no crop year on the load) are listed on the report screen with a link to each load.')
  line('')
  heading('Column guide')
  for (const sec of [summarySection, countySections[0] ?? null, balanceSection, fpSection, loadDataSection, combineSection, ginSection, balesSection, settlementsSection, unsettledSection]) {
    if (!sec) continue
    const tab = sec.key?.startsWith('county_') ? 'County sheets' : sec.title
    for (const c of sec.columns) if (c.note) line(`${tab} — ${c.label}: ${c.note}`)
  }
  line('')
  heading('This export')
  line('Organization', input0.orgName)
  line('Filters', `${cropYear} crop · ${input0.entityName || 'All entities'} · ${input0.cropFilterLabel}`)
  line('Production basis', basisLabel)
  line('Generated', input0.generatedAt.toLocaleString())
  line('')
  heading('Reconciliation: Turnrow on-screen total vs the workbook\'s formulas')
  const recon: Array<{ crop: Crop; screen: number }> = crops.map((c) => ({ crop: c, screen: report.summaryTotals.get(c.id)?.bu ?? 0 }))
  for (const { crop, screen } of recon) {
    const unit = unitOf(crop)
    const fmt: NumFmt = unit === 'lbs' ? 'lbs' : 'bu3'
    const r0 = notesRows.length
    line(`${crop.name}: Turnrow on-screen total production (${unit})`, input(screen, fmt))
    line(`${crop.name}: Workbook formula total (${unit})`, formula(cell(S.summary, `prod:${crop.id}`, totalIdx), fmt))
    line(`${crop.name}: Difference`, formula(sub(cell(S.notes, 'value', r0 + 1), cell(S.notes, 'value', r0)), fmt), formula(iff(lt(abs(self('value')), num(0.5)), str('OK'), str('CHECK'))))
  }
  const grain = recon.filter((x) => unitOf(x.crop) === 'bu')
  if (grain.length > 1) {
    const r0 = notesRows.length
    line('All bushel crops: Turnrow on-screen total production (bu)', input(grain.reduce((a, x) => a + x.screen, 0), 'bu3'))
    line('All bushel crops: Workbook formula total (bu)', formula(sum(...grain.map((x) => cell(S.summary, `prod:${x.crop.id}`, totalIdx))), 'bu3'))
    line('All bushel crops: Difference', formula(sub(cell(S.notes, 'value', r0 + 1), cell(S.notes, 'value', r0)), 'bu3'), formula(iff(lt(abs(self('value')), num(0.5)), str('OK'), str('CHECK'))))
  }
  const notesSection: ExportSection = {
    key: S.notes,
    title: 'Notes',
    plain: true,
    tabColor: TAB_GRAY,
    autoFilter: false,
    banded: false,
    freezeColumns: 0,
    prelude: [{ kind: 'title', cells: ['Notes'] }, { kind: 'text', cells: [{ v: '← Summary', link: "#'Summary'!A1" }] }],
    columns: colsOf([
      { key: 'item', label: 'Note', width: 100 },
      { key: 'value', label: 'Value', align: 'right', width: 24 },
      { key: 'check', label: 'Check', width: 12, kind: 'check' },
    ]),
    rows: notesRows,
    rowMeta: notesMeta,
  }

  // Tab order: the report first (Summary, then each county × practice), then
  // the records behind it — Settlement Balance, Field Production, Load Data,
  // Combine Entries / Gin Receipts / Bales, Settlements, Unsettled, Notes.
  const sections: ExportSection[] = [summarySection, ...countySections]
  if (balanceSection) sections.push(balanceSection)
  sections.push(fpSection, loadDataSection)
  if (combineSection) sections.push(combineSection)
  if (ginSection) sections.push(ginSection)
  if (balesSection) sections.push(balesSection)
  if (settlementsSection) sections.push(settlementsSection)
  if (unsettledSection) sections.push(unsettledSection)
  sections.push(notesSection)

  const cropFilterNames = cropIds.length === 0 ? [] : cropIds.map((id) => cropById.get(id)?.name ?? '').filter(Boolean)
  const payload: ExportPayload = {
    title: `${input0.entityName ? input0.entityName + ' ' : ''}${cropYear} Crop Insurance Production Report`,
    filters: `${cropYear} crop · ${input0.entityName || 'All entities'} · ${input0.cropFilterLabel} · ${basisLabel}`,
    filename: auditFilename(cropYear, cropFilterNames, basis, input0.generatedAt),
    sections,
    fullCalcOnLoad: true,
    excel: {
      title: `Crop Insurance Production Report ${cropYear}`,
      subject: `${cropYear} crop · ${input0.cropFilterLabel} · ${input0.entityName || 'All entities'} · ${basisLabel}`,
      company: input0.orgName,
      footer: `Turnrow · Crop Insurance Production · generated ${input0.generatedAt.toLocaleDateString()}`,
      zeroAsDash: true,
    },
  }

  // Now that every section exists, resolve the sheet layout once: the
  // contents list under the Summary table and each Field Production row's
  // link to its first Load Data row. (Rows under a table never move a
  // header, so the layout holds once the contents are added.)
  const layout = formulaLayout(payload)
  const about: Record<string, string> = {
    [S.balance]: 'How production was balanced to the bushels the buyers paid for',
    [S.fieldProduction]: 'One row per field and practice: how each field\'s production was worked out',
    [S.loadData]: 'Every scale ticket counted, with the shrink to dry bushels',
    [S.combine]: 'Fields measured by the combine yield monitor',
    [S.ginReceipts]: 'Cotton lint by gin receipt',
    [S.bales]: 'The bale weights behind the gin receipts',
    [S.settlements]: 'The settlement lines counted in the balance',
    [S.unsettled]: 'Loads delivered but not yet settled',
    [S.notes]: 'How the numbers are worked out, and the check against Turnrow',
  }
  // A link in the first column; what the tab holds starts at the first column that scrolls.
  const contentsRow = (s: ExportSection): PreludeRow => ({
    kind: 'links',
    cells: [{ v: s.title ?? '', link: `#${sheetRef(layout[s.key!].sheetName)}!A1` }, null, null, s.key?.startsWith('county_') ? 'Acres, production and yield by farm' : about[s.key ?? ''] ?? ''],
  })
  summarySection.postlude = [
    { kind: 'text', cells: ['Every number above is a formula. Click a cell to see where it comes from; the tabs listed here hold the farms, fields and scale tickets behind it.'] },
    { kind: 'blank', cells: [] },
    { kind: 'subtitle', cells: ['In this workbook'] },
    ...sections.filter((s) => s !== summarySection).map(contentsRow),
  ]
  const ld = layout[S.loadData]
  const fpFieldIdx = fpColumns.findIndex((c) => c.key === 'field')
  const firstLoadRowByPlanting = new Map<string, number>()
  loadRows.forEach((x, i) => { if (!firstLoadRowByPlanting.has(x.resolved.planting.id)) firstLoadRowByPlanting.set(x.resolved.planting.id, i) })
  fpRows.forEach(({ r }, i) => {
    const idx = firstLoadRowByPlanting.get(r.planting.id)
    if (idx == null) return
    const cellRef = fpSection.rows[i][fpFieldIdx]
    const name = typeof cellRef === 'string' ? cellRef : (cellRef as { v: string | number | null }).v
    fpSection.rows[i][fpFieldIdx] = { v: name as string, link: `#${sheetRef(ld.sheetName)}!A${ld.firstRow + idx}` }
  })

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
