// Bale Quality report engine (2026-10-20). Pure — the screen, the PDF, the
// Excel workbook and Ask Turnrow compute from these functions.
//
//   buildBaleRows   bale → gin receipt → farm / field / entity / gin → the
//                   field's cotton planting (practice, variety) → classing
//                   row → disposition (held / loan / sold / contract / pool)
//   applyFilters    the multi-select chips (entity, farm, field, variety,
//                   gin, receipt, practice, class-date range, disposition)
//                   plus the contract's "exclude bales committed elsewhere"
//   groupRows       Overall / Entity / Farm / Field / Variety / Gin /
//                   Receipt / Class week
//   distribution    % of bales (or lbs) per bucket, colored by price band
//   average         bale-weighted (how a classing recap reads) or
//                   lbs-weighted; loan ¢/lb is ALWAYS lbs-weighted
//   comparisonRows  one row per group: bales, lbs, each factor's average
//                   and % premium / base / discount, % meets contract
//   colorGrid       the USDA color chart as counts and %
//   kpis            the strip at the top
//
// Variety rule: a single-variety planting gives its bales that variety; a
// multi-variety planting reads "Mixed (A / B)". Never a guessed split.
// Practice: the planting's irrigated / dryland acres (pure → that practice;
// both → mixed; no planting → unknown).

import { practiceOf } from './yields'
import { isCottonCrop } from './marketing'
import {
  bandOf, baseOrBetterOnLoanFactors, bucketOf, extraneousInfo, factorBuckets, factorText, factorValue, FACTORS, loanVsBase, tenths,
  type Band, type Bucket, type FactorKey, type GradeLike,
} from './cotton-quality'
import { evaluateBale, summarizeSpec, type BaleEvaluation, type BalePractice, type ContractQualitySpec, type SpecSummary } from './cotton-contract-spec'
import type { CottonDisposition } from './types'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type GradeRow = GradeLike & { bale_id: string; class_date: string | null; loan_value_total: number | string | null }

export type BaleQualityInputs = {
  cropYear: number
  bales: ReadonlyArray<{ id: string; gin_receipt_id: string; crop_year: number; pbi_number: string; net_weight_lbs: number | string }>
  grades: ReadonlyArray<GradeRow>
  receipts: ReadonlyArray<{ id: string; gin_id: string | null; receipt_number: string; receipt_date: string | null; statement_number?: string | null; gin_code?: string | null; entity_id: string | null; farm_id: string | null; field_id: string | null; crop_year?: number }>
  gins: ReadonlyArray<{ id: string; name: string }>
  farms: ReadonlyArray<{ id: string; name: string; entity_id: string | null; fsa_number: string | null }>
  fields: ReadonlyArray<{ id: string; farm_id: string | null; name_or_number: string }>
  entities: ReadonlyArray<{ id: string; name: string }>
  plantings: ReadonlyArray<{ id: string; field_id: string; crop_id: string; season_year: number; irrigated_acres: number | string | null; dryland_acres: number | string | null; archived_at?: string | null }>
  crops: ReadonlyArray<{ id: string; name: string }>
  varieties: ReadonlyArray<{ planting_id: string; variety: string }>
  dispositions: ReadonlyArray<{ bale_id: string; disposition: CottonDisposition; contract_id: string | null; loan_id: string | null }>
  loanBales: ReadonlyArray<{ bale_id: string; loan_id: string }>
}

export type BaleRow = {
  id: string
  pbi: string
  lbs: number
  receiptId: string
  receiptLabel: string
  receiptDate: string | null
  ginId: string | null
  ginName: string
  entityId: string | null
  entityName: string
  farmId: string | null
  farmName: string
  fsa: string | null
  fieldId: string | null
  fieldName: string
  practice: BalePractice
  variety: string | null
  varietyMixed: boolean
  classDate: string | null
  classWeek: string
  grade: GradeLike | null
  loanTotal: number | null
  disposition: CottonDisposition
  contractId: string | null
  loanId: string | null
}

export const NO_VARIETY = 'No variety'
export const NO_CLASS_DATE = 'No class date'

const num = (v: number | string | null | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Monday of the ISO week a date falls in, as "Week of Oct 13" (sortable key kept apart). */
export function classWeekOf(iso: string | null): { key: string; label: string } {
  if (!iso) return { key: '9999-99-99', label: NO_CLASS_DATE }
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return { key: '9999-99-99', label: NO_CLASS_DATE }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  const day = (d.getUTCDay() + 6) % 7 // Monday = 0
  d.setUTCDate(d.getUTCDate() - day)
  const key = d.toISOString().slice(0, 10)
  const label = `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
  return { key, label }
}

/** The variety a field's cotton planting gives its bales. */
export function varietyOfPlanting(varieties: ReadonlyArray<{ variety: string }>): { label: string | null; mixed: boolean } {
  const names = Array.from(new Set(varieties.map((v) => v.variety.trim()).filter(Boolean))).sort((a, z) => a.localeCompare(z))
  if (names.length === 0) return { label: null, mixed: false }
  if (names.length === 1) return { label: names[0], mixed: false }
  return { label: `Mixed (${names.join(' / ')})`, mixed: true }
}

export function buildBaleRows(input: BaleQualityInputs): BaleRow[] {
  const gradeByBale = new Map(input.grades.map((g) => [g.bale_id, g]))
  const receiptById = new Map(input.receipts.map((r) => [r.id, r]))
  const ginById = new Map(input.gins.map((g) => [g.id, g]))
  const farmById = new Map(input.farms.map((f) => [f.id, f]))
  const fieldById = new Map(input.fields.map((f) => [f.id, f]))
  const entityById = new Map(input.entities.map((e) => [e.id, e]))
  const cottonCropIds = new Set(input.crops.filter((c) => isCottonCrop(c.name)).map((c) => c.id))
  const varietiesByPlanting = new Map<string, Array<{ variety: string }>>()
  for (const v of input.varieties) {
    const arr = varietiesByPlanting.get(v.planting_id)
    if (arr) arr.push(v)
    else varietiesByPlanting.set(v.planting_id, [v])
  }
  // The field's cotton planting for the crop year (the first when several).
  const plantingByField = new Map<string, BaleQualityInputs['plantings'][number]>()
  for (const p of input.plantings) {
    if (p.archived_at) continue
    if (p.season_year !== input.cropYear || !cottonCropIds.has(p.crop_id)) continue
    if (!plantingByField.has(p.field_id)) plantingByField.set(p.field_id, p)
  }
  const dispByBale = new Map(input.dispositions.map((d) => [d.bale_id, d]))
  const loanByBale = new Map(input.loanBales.map((l) => [l.bale_id, l.loan_id]))

  const rows: BaleRow[] = []
  for (const b of input.bales) {
    if (b.crop_year !== input.cropYear) continue
    const r = receiptById.get(b.gin_receipt_id)
    const farm = r?.farm_id ? farmById.get(r.farm_id) ?? null : null
    const field = r?.field_id ? fieldById.get(r.field_id) ?? null : null
    const entityId = r?.entity_id ?? farm?.entity_id ?? null
    const entity = entityId ? entityById.get(entityId) ?? null : null
    const gin = r?.gin_id ? ginById.get(r.gin_id) ?? null : null
    const planting = field ? plantingByField.get(field.id) ?? null : null
    const practice: BalePractice = planting ? ({ 'pure-dry': 'dryland', 'pure-irr': 'irrigated', mixed: 'mixed' } as const)[practiceOf(planting)] : null
    const variety = planting ? varietyOfPlanting(varietiesByPlanting.get(planting.id) ?? []) : { label: null, mixed: false }
    const g = gradeByBale.get(b.id) ?? null
    const disp = dispByBale.get(b.id)
    const loanId = disp?.loan_id ?? loanByBale.get(b.id) ?? null
    const disposition: CottonDisposition = disp?.disposition ?? (loanId ? 'ccc_loan' : 'held')
    const ginName = gin?.name ?? (r?.gin_code ? `Gin ${r.gin_code}` : 'No gin')
    const week = classWeekOf(g?.class_date ?? null)
    rows.push({
      id: b.id,
      pbi: b.pbi_number,
      lbs: num(b.net_weight_lbs),
      receiptId: b.gin_receipt_id,
      receiptLabel: r ? receiptShortLabel({ ginName: gin?.name ?? null, ginCode: r.gin_code ?? null, date: r.receipt_date, farmName: farm?.name ?? null, fieldName: field?.name_or_number ?? null, statementNumber: r.statement_number ?? null }) : 'No receipt',
      receiptDate: r?.receipt_date ?? null,
      ginId: r?.gin_id ?? null,
      ginName,
      entityId,
      entityName: entity?.name ?? 'No entity',
      farmId: farm?.id ?? null,
      farmName: farm?.name ?? 'No farm',
      fsa: farm?.fsa_number ?? null,
      fieldId: field?.id ?? null,
      fieldName: field?.name_or_number ?? 'No field',
      practice,
      variety: variety.label,
      varietyMixed: variety.mixed,
      classDate: g?.class_date ?? null,
      classWeek: week.label,
      grade: g,
      loanTotal: g?.loan_value_total != null && g.loan_value_total !== '' ? num(g.loan_value_total) : null,
      disposition,
      contractId: disp?.contract_id ?? null,
      loanId,
    })
  }
  return rows
}

/** "Servico · 10/13 · Highway 20" — the receipt as a chip. */
export function receiptShortLabel(r: { ginName: string | null; ginCode: string | null; date: string | null; farmName: string | null; fieldName: string | null; statementNumber: string | null }): string {
  const parts: string[] = []
  parts.push(r.ginName?.trim() || (r.ginCode ? `Gin ${r.ginCode}` : 'Gin'))
  const m = r.date?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  parts.push(m ? `${Number(m[2])}/${Number(m[3])}` : 'no date')
  const where = r.fieldName || r.farmName
  if (where) parts.push(where)
  if (r.statementNumber) parts.push(`#${r.statementNumber}`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type BaleQualityFilters = {
  entityIds: string[]
  farmIds: string[]
  fieldIds: string[]
  varieties: string[]
  ginIds: string[]
  receiptIds: string[]
  practices: Array<'irrigated' | 'dryland' | 'mixed' | 'unknown'>
  classFrom: string
  classTo: string
  dispositions: CottonDisposition[]
  /** The selected contract (one with a quality spec), '' = none. */
  contractId: string
  /** With a contract: leave out bales in a loan, sold, pooled, or on another contract. */
  excludeCommitted: boolean
}

export const EMPTY_FILTERS: BaleQualityFilters = {
  entityIds: [], farmIds: [], fieldIds: [], varieties: [], ginIds: [], receiptIds: [], practices: [],
  classFrom: '', classTo: '', dispositions: [], contractId: '', excludeCommitted: false,
}

export function activeFilterCount(f: BaleQualityFilters): number {
  return [f.entityIds, f.farmIds, f.fieldIds, f.varieties, f.ginIds, f.receiptIds, f.practices, f.dispositions].filter((a) => a.length > 0).length
    + (f.classFrom || f.classTo ? 1 : 0) + (f.contractId ? 1 : 0) + (f.contractId && f.excludeCommitted ? 1 : 0)
}

/** A bale committed somewhere other than the selected contract. */
export function committedElsewhere(row: BaleRow, contractId: string): boolean {
  if (row.disposition === 'held') return false
  if (row.disposition === 'contract_delivery') return row.contractId != null && row.contractId !== contractId
  return true
}

export function applyFilters(rows: ReadonlyArray<BaleRow>, f: BaleQualityFilters): BaleRow[] {
  const has = (list: string[], v: string | null) => list.length === 0 || (v != null && list.includes(v))
  return rows.filter((r) => {
    if (!has(f.entityIds, r.entityId)) return false
    if (!has(f.farmIds, r.farmId)) return false
    if (!has(f.fieldIds, r.fieldId)) return false
    if (f.varieties.length > 0 && !f.varieties.includes(r.variety ?? NO_VARIETY)) return false
    if (!has(f.ginIds, r.ginId)) return false
    if (!has(f.receiptIds, r.receiptId)) return false
    if (f.practices.length > 0 && !f.practices.includes(r.practice ?? 'unknown')) return false
    if (f.classFrom && (!r.classDate || r.classDate < f.classFrom)) return false
    if (f.classTo && (!r.classDate || r.classDate > f.classTo)) return false
    if (f.dispositions.length > 0 && !f.dispositions.includes(r.disposition)) return false
    if (f.contractId && f.excludeCommitted && committedElsewhere(r, f.contractId)) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type GroupBy = 'overall' | 'entity' | 'farm' | 'field' | 'variety' | 'gin' | 'receipt' | 'week'
export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  overall: 'Overall', entity: 'Entity', farm: 'Farm', field: 'Field', variety: 'Variety', gin: 'Gin', receipt: 'Receipt', week: 'Class week',
}

/** The group a bale belongs to under a grouping; `last` sends the "none"
 *  group (no farm, no variety, no class date…) to the bottom. */
export function groupKeyOf(r: BaleRow, by: GroupBy): { key: string; label: string; sort: string; last: boolean } {
  switch (by) {
    case 'overall': return { key: 'all', label: 'All bales', sort: '', last: false }
    case 'entity': return { key: r.entityId ?? 'none', label: r.entityName, sort: r.entityName, last: r.entityId == null }
    case 'farm': return { key: r.farmId ?? 'none', label: r.farmName, sort: r.farmName, last: r.farmId == null }
    case 'field': return { key: r.fieldId ?? 'none', label: `${r.farmName} · ${r.fieldName}`, sort: `${r.farmName}|${r.fieldName}`, last: r.fieldId == null }
    case 'variety': return { key: r.variety ?? NO_VARIETY, label: r.variety ?? NO_VARIETY, sort: r.variety ?? '', last: r.variety == null }
    case 'gin': return { key: r.ginId ?? 'none', label: r.ginName, sort: r.ginName, last: r.ginId == null }
    case 'receipt': return { key: r.receiptId, label: r.receiptLabel, sort: `${r.receiptDate ?? '9999'}|${r.receiptLabel}`, last: false }
    case 'week': return { key: r.classWeek, label: r.classWeek, sort: classWeekOf(r.classDate).key, last: r.classDate == null }
  }
}

export type Group = { key: string; label: string; sort: string; last: boolean; rows: BaleRow[] }

export function groupRows(rows: ReadonlyArray<BaleRow>, by: GroupBy): Group[] {
  const map = new Map<string, Group>()
  for (const r of rows) {
    const k = groupKeyOf(r, by)
    let g = map.get(k.key)
    if (!g) { g = { ...k, rows: [] }; map.set(k.key, g) }
    g.rows.push(r)
  }
  return Array.from(map.values()).sort((a, z) => Number(a.last) - Number(z.last) || a.sort.localeCompare(z.sort))
}

// ---------------------------------------------------------------------------
// Distributions and averages
// ---------------------------------------------------------------------------

export type Weighting = 'bales' | 'lbs'

export type DistributionBucket = Bucket & { bales: number; lbs: number; pct: number }

export type Distribution = {
  factor: FactorKey
  buckets: DistributionBucket[]
  /** Classed bales with a value for this factor. */
  classed: number
  classedLbs: number
  missing: number
  byBand: Record<Band, { bales: number; lbs: number; pct: number }>
  average: number | null
  /** The other weighting's average, for the card's small print. */
  averageOther: number | null
}

export function classedRows(rows: ReadonlyArray<BaleRow>): BaleRow[] {
  return rows.filter((r) => r.grade != null)
}

/** The average of a numeric factor. Loan ¢/lb is always lbs-weighted. */
export function factorAverage(rows: ReadonlyArray<BaleRow>, key: FactorKey, weighting: Weighting): number | null {
  if (FACTORS[key].kind !== 'number') return null
  const w: Weighting = key === 'loan' ? 'lbs' : weighting
  let total = 0
  let weight = 0
  for (const r of rows) {
    if (!r.grade) continue
    const v = factorValue(r.grade, key)
    if (typeof v !== 'number') continue
    const wt = w === 'lbs' ? r.lbs : 1
    total += v * wt
    weight += wt
  }
  return weight > 0 ? total / weight : null
}

export function distribution(rows: ReadonlyArray<BaleRow>, key: FactorKey, cropYear: number, weighting: Weighting, mode: 'coarse' | 'fine' = 'coarse'): Distribution {
  const buckets: DistributionBucket[] = factorBuckets(key, cropYear, mode).map((b) => ({ ...b, bales: 0, lbs: 0, pct: 0 }))
  const byKey = new Map(buckets.map((b) => [b.key, b]))
  let classed = 0, classedLbs = 0, missing = 0
  for (const r of rows) {
    if (!r.grade) continue
    const v = factorValue(r.grade, key)
    const bucket = bucketOf(key, v, cropYear, mode)
    if (!bucket) {
      // Code factors treat "no code" as their None bucket; a numeric factor with no reading is missing.
      const none = key === 'extraneous' ? byKey.get('ex_none') : key === 'remarks' ? byKey.get('rm_none') : null
      if (none && v == null) { none.bales++; none.lbs += r.lbs; classed++; classedLbs += r.lbs } else missing++
      continue
    }
    const target = byKey.get(bucket.key)!
    target.bales++
    target.lbs += r.lbs
    classed++
    classedLbs += r.lbs
  }
  const denom = weighting === 'lbs' ? classedLbs : classed
  for (const b of buckets) b.pct = denom > 0 ? (weighting === 'lbs' ? b.lbs : b.bales) / denom : 0
  const byBand: Distribution['byBand'] = { premium: { bales: 0, lbs: 0, pct: 0 }, base: { bales: 0, lbs: 0, pct: 0 }, discount: { bales: 0, lbs: 0, pct: 0 } }
  for (const b of buckets) {
    if (!b.band) continue
    byBand[b.band].bales += b.bales
    byBand[b.band].lbs += b.lbs
  }
  for (const band of Object.keys(byBand) as Band[]) byBand[band].pct = denom > 0 ? (weighting === 'lbs' ? byBand[band].lbs : byBand[band].bales) / denom : 0
  return {
    factor: key, buckets, classed, classedLbs, missing, byBand,
    average: factorAverage(rows, key, weighting),
    averageOther: factorAverage(rows, key, weighting === 'lbs' ? 'bales' : 'lbs'),
  }
}

/** Only the buckets with bales, for a slim bar (empty buckets clutter the card). */
export function occupiedBuckets(d: Distribution): DistributionBucket[] {
  return d.buckets.filter((b) => b.bales > 0)
}

// ---------------------------------------------------------------------------
// Color grid
// ---------------------------------------------------------------------------

export type ColorGridCell = { code: string; bales: number; lbs: number; pct: number }

export function colorGrid(rows: ReadonlyArray<BaleRow>, weighting: Weighting): { cells: Map<string, ColorGridCell>; classed: number; classedLbs: number } {
  const cells = new Map<string, ColorGridCell>()
  let classed = 0, classedLbs = 0
  for (const r of rows) {
    if (!r.grade) continue
    const code = factorValue(r.grade, 'color')
    if (typeof code !== 'string') continue
    classed++
    classedLbs += r.lbs
    const c = cells.get(code) ?? { code, bales: 0, lbs: 0, pct: 0 }
    c.bales++
    c.lbs += r.lbs
    cells.set(code, c)
  }
  const denom = weighting === 'lbs' ? classedLbs : classed
  for (const c of cells.values()) c.pct = denom > 0 ? (weighting === 'lbs' ? c.lbs : c.bales) / denom : 0
  return { cells, classed, classedLbs }
}

// ---------------------------------------------------------------------------
// KPIs, comparison rows, contract view
// ---------------------------------------------------------------------------

export type Kpis = {
  bales: number
  classed: number
  notClassed: number
  lintLbs: number
  classedLbs: number
  /** Lbs-weighted average loan value, ¢/lb, over bales with a loan value. */
  avgLoanCents: number | null
  /** Bales at base-or-better on all loan factors ÷ classed bales. */
  baseOrBetter: number
  baseOrBetterPct: number | null
}

export function kpis(rows: ReadonlyArray<BaleRow>, cropYear: number): Kpis {
  let classed = 0, lintLbs = 0, classedLbs = 0, loanValue = 0, loanLbs = 0, bob = 0
  for (const r of rows) {
    lintLbs += r.lbs
    if (!r.grade) continue
    classed++
    classedLbs += r.lbs
    const cents = factorValue(r.grade, 'loan')
    if (typeof cents === 'number') { loanValue += cents * r.lbs; loanLbs += r.lbs }
    if (baseOrBetterOnLoanFactors(r.grade, cropYear)) bob++
  }
  return {
    bales: rows.length, classed, notClassed: rows.length - classed, lintLbs, classedLbs,
    avgLoanCents: loanLbs > 0 ? loanValue / loanLbs : null,
    baseOrBetter: bob, baseOrBetterPct: classed > 0 ? bob / classed : null,
  }
}

export type ComparisonCell = { average: number | null; premium: number; base: number; discount: number; classed: number }
export type ComparisonRow = {
  key: string
  label: string
  bales: number
  classed: number
  lbs: number
  cells: Record<string, ComparisonCell>
  /** With a contract: meets ÷ eligible classed (null when none eligible). */
  meetsPct: number | null
  meets: number
  eligibleClassed: number
}

export function comparisonRows(
  groups: ReadonlyArray<Group>,
  factors: ReadonlyArray<FactorKey>,
  cropYear: number,
  weighting: Weighting,
  spec: ContractQualitySpec | null,
): { rows: ComparisonRow[]; total: ComparisonRow } {
  const build = (key: string, label: string, rows: ReadonlyArray<BaleRow>): ComparisonRow => {
    const cells: Record<string, ComparisonCell> = {}
    for (const f of factors) {
      const d = distribution(rows, f, cropYear, weighting)
      cells[f] = { average: d.average, premium: d.byBand.premium.pct, base: d.byBand.base.pct, discount: d.byBand.discount.pct, classed: d.classed }
    }
    let meets = 0, eligibleClassed = 0
    if (spec) {
      for (const r of rows) {
        const ev = evaluateBale(spec, specBaleOf(r))
        if (ev.status === 'meets' || ev.status === 'fails') eligibleClassed++
        if (ev.status === 'meets') meets++
      }
    }
    return {
      key, label, bales: rows.length, classed: rows.filter((r) => r.grade).length, lbs: rows.reduce((s, r) => s + r.lbs, 0), cells,
      meets, eligibleClassed, meetsPct: spec && eligibleClassed > 0 ? meets / eligibleClassed : null,
    }
  }
  const rows = groups.map((g) => build(g.key, g.label, g.rows))
  const all = groups.flatMap((g) => g.rows)
  return { rows, total: build('__total', 'Total', all) }
}

export function specBaleOf(r: BaleRow): { fsaNumber: string | null; practice: BalePractice; grade: GradeLike | null } {
  return { fsaNumber: r.fsa, practice: r.practice, grade: r.grade }
}

export type ContractView = {
  summary: SpecSummary
  evaluationOf: (baleId: string) => BaleEvaluation | undefined
}

export function contractView(rows: ReadonlyArray<BaleRow>, spec: ContractQualitySpec, appEstimatedBales: number | null): ContractView {
  const summary = summarizeSpec(spec, rows.map((r) => ({ id: r.id, lbs: r.lbs, ...specBaleOf(r) })), { appEstimatedBales })
  return { summary, evaluationOf: (id) => summary.evaluations.get(id) }
}

/** The app's own production estimate in bales for the projection fallback:
 *  expected lint lbs ÷ 500. */
export function balesFromLint(expectedLintLbs: number | null | undefined): number | null {
  return expectedLintLbs != null && expectedLintLbs > 0 ? expectedLintLbs / 500 : null
}

/** Expected lint for the crop year from the cotton crop assumption (lbs of
 *  lint per acre, by practice where set) × the cotton plantings' acres,
 *  as bales (÷ 500). Null without an assumption. */
export function estimatedBalesFromAssumptions(
  input: Pick<BaleQualityInputs, 'cropYear' | 'plantings' | 'crops'>,
  assumptions: ReadonlyArray<{ crop_id: string; crop_year?: number; expected_yield: number | string | null; expected_yield_irr?: number | string | null; expected_yield_dry?: number | string | null }>,
): number | null {
  const cottonIds = new Set(input.crops.filter((c) => isCottonCrop(c.name)).map((c) => c.id))
  const asm = assumptions.find((a) => cottonIds.has(a.crop_id) && (a.crop_year == null || a.crop_year === input.cropYear))
  if (!asm) return null
  const yAll = Number(asm.expected_yield) || 0
  const yIrr = asm.expected_yield_irr != null && asm.expected_yield_irr !== '' ? Number(asm.expected_yield_irr) : yAll
  const yDry = asm.expected_yield_dry != null && asm.expected_yield_dry !== '' ? Number(asm.expected_yield_dry) : yAll
  let lint = 0
  for (const p of input.plantings) {
    if (p.archived_at || !cottonIds.has(p.crop_id) || p.season_year !== input.cropYear) continue
    const irr = Number(p.irrigated_acres) || 0
    const dry = Number(p.dryland_acres) || 0
    const planted = Number((p as { planted_acres?: number | string | null }).planted_acres) || irr + dry
    lint += irr + dry > 0 ? irr * yIrr + dry * yDry : planted * yAll
  }
  return balesFromLint(lint)
}

/** Band → the on-screen tone (data-semantic colors, never brand green). */
export function bandTone(band: Band | null): 'favorable' | 'neutral' | 'unfavorable' | 'muted' {
  return band === 'premium' ? 'favorable' : band === 'discount' ? 'unfavorable' : band === 'base' ? 'neutral' : 'muted'
}

/** The value's band for a cell (null when the factor is not banded). */
export function cellBand(key: FactorKey, value: number | string | null, cropYear: number): Band | null {
  return FACTORS[key].banded ? bandOf(key, value, cropYear) : null
}

// ---------------------------------------------------------------------------
// Factor detail: the panel behind a factor tile (2026-10-21)
// ---------------------------------------------------------------------------
//
// A real histogram of the readings (fine bins at the factor's own precision,
// colored by price band), the averages both ways, the spread, and — with a
// contract — that factor's requirement as a line on the chart plus how many
// bales fail it. Code factors (color, extraneous, remarks, quadrant) list
// their codes instead, marked allowed / not allowed by the contract.

/** Bin width per numeric factor, in the reading's units. */
export const BIN_STEP: Partial<Record<FactorKey, number>> = {
  leaf: 1, staple: 1, mic: 0.1, strength: 0.5, uniformity: 0.5, rd: 1, plus_b: 0.5, trash: 0.5, length: 1, loan: 1,
}
const MAX_BINS = 60

export type FactorBin = {
  key: string
  label: string
  /** Numeric bins: inclusive lower edge and exclusive upper edge. */
  min: number | null
  max: number | null
  /** Code bins: the code (null = the None bucket of extraneous / remarks). */
  code: string | null
  band: Band | null
  bales: number
  lbs: number
  pct: number
  /** With a contract: whether readings in this bin satisfy the factor's requirement (null = no requirement). */
  allowed: boolean | null
}

export type FactorRequirement = {
  min: number | null
  max: number | null
  /** Code factors: the codes the contract accepts (null when it tests by rule only). */
  allowedCodes: string[] | null
  /** Plain words: "4.0 – 4.7", "3 or better", "11 / 21 / 31 / 41". */
  text: string
}

export type FactorDetail = {
  factor: FactorKey
  /** The crop year read (loan value is shown against its base loan rate). */
  cropYear: number
  bins: FactorBin[]
  step: number | null
  classed: number
  classedLbs: number
  missing: number
  /** Per-bale average (loan value: always lbs-weighted). */
  avgBale: number | null
  avgLbs: number | null
  median: number | null
  min: number | null
  max: number | null
  byBand: Distribution['byBand']
  requirement: FactorRequirement | null
  /** With a contract: eligible classed bales failing this factor, and those failing only this one. */
  fails: number
  onlyThis: number
  /** Eligible classed bales (the denominator for fails). */
  eligibleClassed: number
}

/** The contract's requirement on one factor, or null when it has none. */
export function factorRequirement(spec: ContractQualitySpec | null, key: FactorKey): FactorRequirement | null {
  if (!spec) return null
  const f1 = (n: number) => n.toFixed(1)
  switch (key) {
    case 'color': {
      const codes = (spec.allowed_color_codes ?? []).filter(Boolean)
      return codes.length ? { min: null, max: null, allowedCodes: codes, text: codes.join(' / ') } : null
    }
    case 'leaf': return spec.leaf_max != null ? { min: null, max: spec.leaf_max, allowedCodes: null, text: `${spec.leaf_max} or better` } : null
    case 'staple': return spec.staple_min != null ? { min: spec.staple_min, max: null, allowedCodes: null, text: `${spec.staple_min} or longer` } : null
    case 'mic':
      if (spec.mic_min == null && spec.mic_max == null) return null
      return {
        min: spec.mic_min, max: spec.mic_max, allowedCodes: null,
        text: spec.mic_min != null && spec.mic_max != null ? `${f1(spec.mic_min)} – ${f1(spec.mic_max)}` : spec.mic_min != null ? `${f1(spec.mic_min)} or higher` : `${f1(spec.mic_max!)} or lower`,
      }
    case 'strength': return spec.strength_min != null ? { min: spec.strength_min, max: null, allowedCodes: null, text: `${f1(spec.strength_min)} or better` } : null
    case 'uniformity': return spec.uniformity_min != null ? { min: spec.uniformity_min, max: null, allowedCodes: null, text: `${f1(spec.uniformity_min)} or better` } : null
    case 'extraneous':
      return spec.extraneous_rule === 'any' ? null : { min: null, max: null, allowedCodes: null, text: spec.extraneous_rule === 'none' ? 'none allowed' : 'level 1 allowed, level 2 fails' }
    case 'remarks': {
      const ex = (spec.excluded_remarks ?? []).filter(Boolean)
      return ex.length ? { min: null, max: null, allowedCodes: null, text: `remark ${ex.join(' / ')} excluded` } : null
    }
    default: return null
  }
}

/** Does a reading satisfy the factor's numeric requirement? (null = no requirement.) */
function numericAllowed(req: FactorRequirement | null, v: number): boolean | null {
  if (!req || (req.min == null && req.max == null)) return null
  if (req.min != null && tenths(v) < tenths(req.min)) return false
  if (req.max != null && tenths(v) > tenths(req.max)) return false
  return true
}

/** Does a code satisfy the factor's code requirement? (null = no requirement.) */
function codeAllowed(key: FactorKey, req: FactorRequirement | null, spec: ContractQualitySpec | null, code: string | null): boolean | null {
  if (!req || !spec) return null
  switch (key) {
    case 'color': return code != null && (req.allowedCodes ?? []).includes(code)
    case 'extraneous': {
      if (code == null) return true
      const info = extraneousInfo(code)
      if (!info) return true
      return spec.extraneous_rule === 'level1_ok' ? info.level === 1 : false
    }
    case 'remarks': return code == null || !(spec.excluded_remarks ?? []).includes(code)
    default: return null
  }
}

function binLabel(key: FactorKey, lo: number, step: number, cropYear: number): string {
  if (key === 'length') return `${(lo / 100).toFixed(2)}"`
  if (key === 'loan') {
    // Against the base loan rate: +2¢ above, (3¢) below.
    const d = Math.round(loanVsBase(lo, cropYear))
    return d > 0 ? `+${d}¢` : d < 0 ? `(${-d}¢)` : '0¢'
  }
  if (key === 'leaf' || key === 'staple') return String(lo)
  return lo.toFixed(step < 1 ? 1 : 0)
}

/** The code-bin order for a code factor: the chart's own order (color grid
 *  order, extraneous kinds, remark kinds), occupied codes only, None first
 *  where the factor has a None bucket. */
function codeBins(key: FactorKey, cropYear: number, codes: Map<string | null, { bales: number; lbs: number }>, requirement: FactorRequirement | null, spec: ContractQualitySpec | null): FactorBin[] {
  const bucketKeyOf = (c: string | null): string | null => {
    if (c == null) return key === 'extraneous' ? 'ex_none' : key === 'remarks' ? 'rm_none' : null
    return bucketOf(key, c, cropYear)?.key ?? null
  }
  const order = factorBuckets(key, cropYear).map((b) => b.key)
  const rank = (c: string | null) => { const i = order.indexOf(bucketKeyOf(c) ?? ''); return i < 0 ? order.length : i }
  const entries = Array.from(codes.entries()).sort((a, z) => rank(a[0]) - rank(z[0]) || String(a[0] ?? '').localeCompare(String(z[0] ?? '')))
  return entries.map(([c, cnt]) => {
    const bk = bucketKeyOf(c)
    const bucket = bk ? factorBuckets(key, cropYear).find((b) => b.key === bk) ?? null : null
    return {
      key: `${key}_${c ?? 'none'}`, label: c == null ? 'None' : factorText(key, c), min: null, max: null, code: c,
      band: bucket?.band ?? null, bales: cnt.bales, lbs: cnt.lbs, pct: 0, allowed: codeAllowed(key, requirement, spec, c),
    }
  })
}

export function factorDetail(
  rows: ReadonlyArray<BaleRow>,
  key: FactorKey,
  cropYear: number,
  weighting: Weighting,
  spec: ContractQualitySpec | null,
  evaluationOf?: (baleId: string) => BaleEvaluation | undefined,
): FactorDetail {
  const def = FACTORS[key]
  const requirement = factorRequirement(spec, key)
  const d = distribution(rows, key, cropYear, weighting)

  // The readings.
  const nums: Array<{ v: number; lbs: number }> = []
  const codes = new Map<string | null, { bales: number; lbs: number }>()
  let classed = 0, classedLbs = 0, missing = 0
  for (const r of rows) {
    if (!r.grade) continue
    const v = factorValue(r.grade, key)
    if (def.kind === 'number') {
      if (typeof v !== 'number') { missing++; continue }
      nums.push({ v, lbs: r.lbs })
    } else {
      const code = typeof v === 'string' ? v : null
      // Extraneous / remarks treat "no code" as a real reading (None); color / quadrant need a code.
      if (code == null && key !== 'extraneous' && key !== 'remarks') { missing++; continue }
      const c = codes.get(code) ?? { bales: 0, lbs: 0 }
      c.bales++; c.lbs += r.lbs
      codes.set(code, c)
    }
    classed++
    classedLbs += r.lbs
  }
  const denom = weighting === 'lbs' ? classedLbs : classed

  let bins: FactorBin[] = []
  let step: number | null = null
  if (def.kind === 'number') {
    step = BIN_STEP[key] ?? 1
    if (nums.length > 0) {
      const lo0 = Math.min(...nums.map((n) => n.v)), hi0 = Math.max(...nums.map((n) => n.v))
      const idx = (v: number, s: number) => Math.floor((v + 1e-9) / s)
      while ((idx(hi0, step) - idx(lo0, step) + 1) > MAX_BINS) step *= 2
      const first = idx(lo0, step), last = idx(hi0, step)
      const byIdx = new Map<number, FactorBin>()
      for (let i = first; i <= last; i++) {
        const lo = Math.round(i * step * 1000) / 1000
        const hi = Math.round((i + 1) * step * 1000) / 1000
        const bin: FactorBin = {
          key: `${key}_${i}`, label: binLabel(key, lo, step, cropYear), min: lo, max: hi, code: null,
          band: def.banded ? bandOf(key, lo, cropYear) : null, bales: 0, lbs: 0, pct: 0,
          allowed: numericAllowed(requirement, lo),
        }
        byIdx.set(i, bin)
        bins.push(bin)
      }
      for (const n of nums) {
        const bin = byIdx.get(idx(n.v, step))!
        bin.bales++
        bin.lbs += n.lbs
      }
    }
  } else {
    bins = codeBins(key, cropYear, codes, requirement, spec)
  }
  for (const bin of bins) bin.pct = denom > 0 ? (weighting === 'lbs' ? bin.lbs : bin.bales) / denom : 0

  // Spread.
  const sorted = nums.map((n) => n.v).sort((a, z) => a - z)
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null

  // Fails on this factor (with a contract).
  let fails = 0, onlyThis = 0, eligibleClassed = 0
  if (spec && evaluationOf) {
    for (const r of rows) {
      const ev = evaluationOf(r.id)
      if (!ev || (ev.status !== 'meets' && ev.status !== 'fails')) continue
      eligibleClassed++
      if (ev.status !== 'fails') continue
      const fs = new Set(ev.failures.map((f) => f.factor))
      if (!fs.has(key)) continue
      fails++
      if (fs.size === 1) onlyThis++
    }
  }

  return {
    factor: key, cropYear, bins, step, classed, classedLbs, missing,
    avgBale: factorAverage(rows, key, 'bales'),
    avgLbs: factorAverage(rows, key, 'lbs'),
    median, min: sorted.length ? sorted[0] : null, max: sorted.length ? sorted[sorted.length - 1] : null,
    byBand: d.byBand, requirement, fails, onlyThis, eligibleClassed,
  }
}

/** The bales a histogram bin or code bin holds (the drill from the chart). */
export function rowsInBin(rows: ReadonlyArray<BaleRow>, key: FactorKey, bin: Pick<FactorBin, 'min' | 'max' | 'code'>): BaleRow[] {
  const def = FACTORS[key]
  return rows.filter((r) => {
    if (!r.grade) return false
    const v = factorValue(r.grade, key)
    if (def.kind === 'number') {
      if (typeof v !== 'number') return false
      if (bin.min != null && v + 1e-9 < bin.min) return false
      if (bin.max != null && v + 1e-9 >= bin.max) return false
      return true
    }
    return (typeof v === 'string' ? v : null) === bin.code
  })
}
