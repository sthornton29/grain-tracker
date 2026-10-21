// Cotton contract quality specs (0097, 2026-10-20). Pure.
//
//   * ContractQualitySpec — the thresholds a buyer wrote into a contract
//     (cotton_contract_specs row shape): allowed color codes, leaf max, staple
//     min, mic range, strength min, uniformity min, an extraneous-matter rule,
//     excluded remarks, eligible FSA farms, a dryland requirement, the cap and
//     the producer's estimate.
//   * evaluateBale(spec, bale) — meets / fails (with each failing factor as
//     "value vs requirement") / not_eligible / not_classed. Boundaries are
//     inclusive at reported precision (tenths); a missing value on a classed
//     bale fails with "missing <factor>".
//   * summarizeSpec — the headline, the cap tracker, the projection and the
//     Pareto of failing factors (with "fails only this factor" near misses).
//   * rulesFromWording — CODE, not the model, turns contract wording into
//     rules ("Color 41 and better" → 11/21/31/41). Anything it cannot map is
//     returned verbatim as "not understood", never silently dropped.
//   * matchEligibleFarms — Schedule A FSA numbers against Turnrow farms.

import {
  colorCode, colorCodesAndBetter, colorGradeInfo, extraneousInfo, remarksInfo, tenths,
  type FactorKey, type GradeLike,
} from './cotton-quality'

export type ExtraneousRule = 'any' | 'none' | 'level1_ok'
export const EXTRANEOUS_RULE_LABEL: Record<ExtraneousRule, string> = {
  any: 'No requirement',
  none: 'No extraneous matter',
  level1_ok: 'Level 1 allowed, level 2 fails',
}

export type ScheduleRow = {
  fsa_number: string
  county: string | null
  planted_acres: number | null
  aph_yield: number | null
  aph_est_bales: number | null
  trendline_est_bales: number | null
}

export type ContractQualitySpec = {
  /** Allowed color codes; null or empty = no color requirement. */
  allowed_color_codes: string[] | null
  leaf_max: number | null
  staple_min: number | null
  mic_min: number | null
  mic_max: number | null
  strength_min: number | null
  uniformity_min: number | null
  extraneous_rule: ExtraneousRule
  /** Remarks codes that fail a bale (e.g. ['77']); null or empty = none. */
  excluded_remarks: string[] | null
  /** FSA farm numbers eligible under the contract; null or empty = every farm. */
  eligible_fsa_farms: string[] | null
  require_dryland: boolean
  bale_cap: number | null
  estimated_bales: number | null
  base_grade: string | null
  base_price_cents: number | null
  off_spec_terms: string | null
  other_terms: string | null
  source_clause: string | null
  schedule: ScheduleRow[] | null
}

export const EMPTY_SPEC: ContractQualitySpec = {
  allowed_color_codes: null, leaf_max: null, staple_min: null, mic_min: null, mic_max: null,
  strength_min: null, uniformity_min: null, extraneous_rule: 'any', excluded_remarks: null,
  eligible_fsa_farms: null, require_dryland: false, bale_cap: null, estimated_bales: null,
  base_grade: null, base_price_cents: null, off_spec_terms: null, other_terms: null, source_clause: null, schedule: null,
}

/** True when the spec tests at least one fiber factor. */
export function specHasFiberTerms(spec: ContractQualitySpec): boolean {
  return (spec.allowed_color_codes?.length ?? 0) > 0 || spec.leaf_max != null || spec.staple_min != null
    || spec.mic_min != null || spec.mic_max != null || spec.strength_min != null || spec.uniformity_min != null
    || spec.extraneous_rule !== 'any' || (spec.excluded_remarks?.length ?? 0) > 0
}

export type BalePractice = 'irrigated' | 'dryland' | 'mixed' | null

/** What the evaluator needs to know about one bale. */
export type SpecBale = {
  fsaNumber: string | null
  practice: BalePractice
  /** The classing row, or null when the bale is not yet classed. */
  grade: GradeLike | null
}

export type BaleFailure = { factor: FactorKey; text: string }

export type BaleEvaluation =
  | { status: 'meets'; failures: [] }
  | { status: 'fails'; failures: BaleFailure[] }
  | { status: 'not_eligible'; failures: []; reason: string }
  | { status: 'not_classed'; failures: [] }

export const EVALUATION_LABEL: Record<BaleEvaluation['status'], string> = {
  meets: 'Meets', fails: 'Fails', not_eligible: 'Not eligible', not_classed: 'Not classed',
}

const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** FSA numbers compare on digits only: "0252" = "252". */
export function fsaKey(raw: string | number | null | undefined): string | null {
  if (raw == null) return null
  const digits = String(raw).replace(/\D/g, '').replace(/^0+(?=\d)/, '')
  return digits === '' ? null : digits
}
const fmt1 = (n: number) => n.toFixed(1)

/** Evaluate one bale against a spec. */
export function evaluateBale(spec: ContractQualitySpec, bale: SpecBale): BaleEvaluation {
  const farms = (spec.eligible_fsa_farms ?? []).map(fsaKey).filter((k): k is string => k != null)
  if (farms.length > 0) {
    const key = fsaKey(bale.fsaNumber)
    if (!key) return { status: 'not_eligible', failures: [], reason: 'farm has no FSA number' }
    if (!farms.includes(key)) return { status: 'not_eligible', failures: [], reason: `farm ${key} not on the contract's farm list` }
  }
  if (spec.require_dryland && bale.practice !== 'dryland') {
    return { status: 'not_eligible', failures: [], reason: bale.practice == null ? 'practice unknown (contract requires dryland)' : `${bale.practice} (contract requires dryland)` }
  }
  const g = bale.grade
  if (!g) return { status: 'not_classed', failures: [] }

  const failures: BaleFailure[] = []
  const allowed = (spec.allowed_color_codes ?? []).map((c) => colorCode(c)).filter((c): c is string => c != null)
  if (allowed.length > 0) {
    const code = colorCode(g.color_grade)
    if (!code) failures.push({ factor: 'color', text: 'missing color grade' })
    else if (!allowed.includes(code)) {
      const info = colorGradeInfo(code)
      failures.push({ factor: 'color', text: `Color ${code}: ${info ? info.name.toLowerCase() : 'not allowed'} (needs ${allowed.join('/')})` })
    }
  }
  if (spec.leaf_max != null) {
    const leaf = numOrNull(g.leaf_grade)
    if (leaf == null) failures.push({ factor: 'leaf', text: 'missing leaf grade' })
    else if (leaf > spec.leaf_max) failures.push({ factor: 'leaf', text: `Leaf ${leaf} (needs ${spec.leaf_max} or better)` })
  }
  if (spec.staple_min != null) {
    const st = numOrNull(g.staple_32nds)
    if (st == null) failures.push({ factor: 'staple', text: 'missing staple' })
    else if (st < spec.staple_min) failures.push({ factor: 'staple', text: `Staple ${st} (needs ${spec.staple_min} or longer)` })
  }
  if (spec.mic_min != null || spec.mic_max != null) {
    const mic = numOrNull(g.micronaire)
    const need = spec.mic_min != null && spec.mic_max != null ? `${fmt1(spec.mic_min)}-${fmt1(spec.mic_max)}`
      : spec.mic_min != null ? `${fmt1(spec.mic_min)} or higher` : `${fmt1(spec.mic_max!)} or lower`
    if (mic == null) failures.push({ factor: 'mic', text: 'missing micronaire' })
    else if ((spec.mic_min != null && tenths(mic) < tenths(spec.mic_min)) || (spec.mic_max != null && tenths(mic) > tenths(spec.mic_max))) {
      failures.push({ factor: 'mic', text: `Mic ${fmt1(mic)} (needs ${need})` })
    }
  }
  if (spec.strength_min != null) {
    const s = numOrNull(g.strength_g_tex)
    if (s == null) failures.push({ factor: 'strength', text: 'missing strength' })
    else if (tenths(s) < tenths(spec.strength_min)) failures.push({ factor: 'strength', text: `Strength ${fmt1(s)} (needs ${fmt1(spec.strength_min)} or better)` })
  }
  if (spec.uniformity_min != null) {
    const u = numOrNull(g.uniformity_pct)
    if (u == null) failures.push({ factor: 'uniformity', text: 'missing uniformity' })
    else if (tenths(u) < tenths(spec.uniformity_min)) failures.push({ factor: 'uniformity', text: `Uniformity ${fmt1(u)} (needs ${fmt1(spec.uniformity_min)} or better)` })
  }
  if (spec.extraneous_rule !== 'any') {
    const ex = extraneousInfo(g.extraneous)
    if (ex && (spec.extraneous_rule === 'none' || ex.level === 2)) {
      failures.push({ factor: 'extraneous', text: `${ex.label} (${spec.extraneous_rule === 'none' ? 'contract allows none' : 'level 2 not allowed'})` })
    }
  }
  const excluded = (spec.excluded_remarks ?? []).map((r) => String(r).trim()).filter(Boolean)
  if (excluded.length > 0) {
    const rm = remarksInfo(g.remarks)
    if (rm && excluded.includes(rm.code)) failures.push({ factor: 'remarks', text: `${rm.label} (remark ${rm.code} excluded)` })
  }
  return failures.length === 0 ? { status: 'meets', failures: [] } : { status: 'fails', failures }
}

// ---------------------------------------------------------------------------
// Summary: headline, cap tracker, projection, Pareto
// ---------------------------------------------------------------------------

export type SpecSummaryBale = SpecBale & { id: string; lbs: number }

export type ParetoRow = { factor: FactorKey; bales: number; onlyThis: number }

export type SpecSummary = {
  /** Bales on eligible farms with classing data. */
  eligibleClassed: number
  eligibleClassedLbs: number
  meets: number
  meetsLbs: number
  fails: number
  notEligible: number
  notClassed: number
  /** meets ÷ eligibleClassed, 0–1 (null when nothing is classed). */
  passRate: number | null
  passRateLbs: number | null
  pareto: ParetoRow[]
  /** Bales failing exactly one factor. */
  singleFactorFails: number
  cap: number | null
  /** Pass rate × the estimate (the contract's, else the app's), rounded. */
  projection: { estimatedBales: number; estimateSource: 'contract' | 'app'; projected: number } | null
  evaluations: Map<string, BaleEvaluation>
}

export function summarizeSpec(
  spec: ContractQualitySpec,
  bales: ReadonlyArray<SpecSummaryBale>,
  opts: { appEstimatedBales?: number | null } = {},
): SpecSummary {
  const evaluations = new Map<string, BaleEvaluation>()
  let eligibleClassed = 0, eligibleClassedLbs = 0, meets = 0, meetsLbs = 0, fails = 0, notEligible = 0, notClassed = 0
  const byFactor = new Map<FactorKey, { bales: number; onlyThis: number }>()
  let singleFactorFails = 0
  for (const b of bales) {
    const ev = evaluateBale(spec, b)
    evaluations.set(b.id, ev)
    if (ev.status === 'not_eligible') { notEligible++; continue }
    if (ev.status === 'not_classed') { notClassed++; continue }
    eligibleClassed++
    eligibleClassedLbs += b.lbs
    if (ev.status === 'meets') { meets++; meetsLbs += b.lbs; continue }
    fails++
    const factors = Array.from(new Set(ev.failures.map((f) => f.factor)))
    if (factors.length === 1) singleFactorFails++
    for (const f of factors) {
      const row = byFactor.get(f) ?? { bales: 0, onlyThis: 0 }
      row.bales++
      if (factors.length === 1) row.onlyThis++
      byFactor.set(f, row)
    }
  }
  const pareto = Array.from(byFactor.entries()).map(([factor, r]) => ({ factor, ...r })).sort((a, z) => z.bales - a.bales || a.factor.localeCompare(z.factor))
  const passRate = eligibleClassed > 0 ? meets / eligibleClassed : null
  const passRateLbs = eligibleClassedLbs > 0 ? meetsLbs / eligibleClassedLbs : null
  const estimate = spec.estimated_bales != null ? { estimatedBales: spec.estimated_bales, estimateSource: 'contract' as const }
    : opts.appEstimatedBales != null && opts.appEstimatedBales > 0 ? { estimatedBales: Math.round(opts.appEstimatedBales), estimateSource: 'app' as const } : null
  const projection = estimate && passRate != null ? { ...estimate, projected: Math.round(passRate * estimate.estimatedBales) } : null
  return { eligibleClassed, eligibleClassedLbs, meets, meetsLbs, fails, notEligible, notClassed, passRate, passRateLbs, pareto, singleFactorFails, cap: spec.bale_cap, projection, evaluations }
}

// ---------------------------------------------------------------------------
// Wording → rules (code, not the model)
// ---------------------------------------------------------------------------

/** What the document reader returns for a contract's quality terms: each
 *  factor's wording AS STATED (or null when the contract is silent). */
export type QualityTermsExtract = {
  quality_clause: string | null
  color: string | null
  leaf: string | null
  staple: string | null
  micronaire: string | null
  strength: string | null
  uniformity: string | null
  extraneous_matter: string | null
  eligible_farms: Array<{ fsa_number: string | null; county: string | null; planted_acres: number | null; aph_yield: number | null; aph_est_bales: number | null; trendline_est_bales: number | null }> | null
  bale_cap: number | null
  estimated_bales: number | null
  base_grade: string | null
  base_price_cents_per_lb: number | null
  off_spec_terms: string | null
  other_deliverables: string | null
  practice_requirement: string | null
}

export type NotUnderstood = { factor: string; text: string }

export type WordingResult = {
  spec: ContractQualitySpec
  notUnderstood: NotUnderstood[]
}

const BETTER = /\b(and|or)\s+(better|higher|above|up|longer|stronger|greater|more)\b|\bor\s+above\b|\bminimum\b|\bmin\.?\b|\bat\s+least\b|\+\s*$|≥|>=/i
const WORSE = /\b(and|or)\s+(lower|less|below|shorter|finer|under)\b|\bmaximum\b|\bmax\.?\b|\bat\s+most\b|\bno\s+more\s+than\b|≤|<=/i
const RANGE = /(\d+(?:\.\d+)?)\s*(?:-|–|—|to|through|thru)\s*(\d+(?:\.\d+)?)/i
const NUMBER = /\d+(?:\.\d+)?/

function firstNumber(s: string): number | null {
  const m = s.match(NUMBER)
  return m ? Number(m[0]) : null
}

/** "41 and better" → the white grades 11/21/31/41; an explicit list "11, 21,
 *  31, 41" is taken as written; "white grades" alone → 11–71 white. */
export function parseColorWording(text: string): string[] | null {
  const t = text.trim()
  const list = t.match(/\b\d{2}\b/g) ?? []
  if (list.length >= 2 && !BETTER.test(t)) {
    const codes = list.filter((c) => colorGradeInfo(c))
    return codes.length === list.length ? Array.from(new Set(codes)) : null
  }
  const m = t.match(/\b(\d{2})\b/)
  if (m && BETTER.test(t)) {
    const codes = colorCodesAndBetter(m[1])
    return codes.length ? codes : null
  }
  if (m && list.length === 1 && /\bonly\b|\bexactly\b/i.test(t)) return colorGradeInfo(m[1]) ? [m[1]] : null
  if (/\bwhite\b/i.test(t) && !m) return colorCodesAndBetter('71')
  return null
}

/** "3 and better" / "leaf 3 maximum" → 3. */
export function parseMaxWording(text: string): number | null {
  const t = text.trim()
  const n = firstNumber(t)
  if (n == null) return null
  if (BETTER.test(t) || WORSE.test(t) || /\b(leaf|max|maximum|or\s+better|and\s+better)\b/i.test(t)) return n
  return /^\s*\d+(?:\.\d+)?\s*$/.test(t) ? n : null
}

/** "37 and longer" / "29 g/tex and better" / "minimum 80" → the floor. */
export function parseMinWording(text: string): number | null {
  const t = text.trim()
  const n = firstNumber(t)
  if (n == null) return null
  if (BETTER.test(t)) return n
  if (WORSE.test(t)) return null
  return /^\s*\d+(?:\.\d+)?\s*(g\/tex|grams?\s+per\s+tex|%)?\s*$/i.test(t) ? n : null
}

/** "4.0-4.7" → inclusive range; "4.0 and above" → min only; "4.9 and below" → max only. */
export function parseRangeWording(text: string): { min: number | null; max: number | null } | null {
  const t = text.trim()
  const r = t.match(RANGE)
  if (r) return { min: Number(r[1]), max: Number(r[2]) }
  const n = firstNumber(t)
  if (n == null) return null
  if (BETTER.test(t)) return { min: n, max: null }
  if (WORSE.test(t)) return { min: null, max: n }
  return null
}

export function parseExtraneousWording(text: string): ExtraneousRule | null {
  const t = text.trim().toLowerCase()
  if (/\b(no|none|free of|without|zero)\b/.test(t) && !/level\s*1/.test(t)) return 'none'
  if (/level\s*1/.test(t) && /\b(ok|okay|allowed|accept|permitted)\b/.test(t)) return 'level1_ok'
  if (/level\s*2/.test(t) && /\b(no|not|reject|fail)\b/.test(t)) return 'level1_ok'
  if (/\b(any|no requirement|not specified|n\/a)\b/.test(t)) return 'any'
  return null
}

/** Turn the reader's wording into a spec. Every factor the contract states
 *  either becomes a rule or lands in `notUnderstood` with its verbatim text. */
export function rulesFromWording(x: QualityTermsExtract): WordingResult {
  const spec: ContractQualitySpec = { ...EMPTY_SPEC }
  const notUnderstood: NotUnderstood[] = []
  const miss = (factor: string, text: string) => notUnderstood.push({ factor, text })

  if (x.color) { const codes = parseColorWording(x.color); if (codes) spec.allowed_color_codes = codes; else miss('Color', x.color) }
  if (x.leaf) { const n = parseMaxWording(x.leaf); if (n != null) spec.leaf_max = n; else miss('Leaf', x.leaf) }
  if (x.staple) { const n = parseMinWording(x.staple); if (n != null) spec.staple_min = n; else miss('Staple', x.staple) }
  if (x.micronaire) { const r = parseRangeWording(x.micronaire); if (r) { spec.mic_min = r.min; spec.mic_max = r.max } else miss('Micronaire', x.micronaire) }
  if (x.strength) { const n = parseMinWording(x.strength); if (n != null) spec.strength_min = n; else miss('Strength', x.strength) }
  if (x.uniformity) { const n = parseMinWording(x.uniformity); if (n != null) spec.uniformity_min = n; else miss('Uniformity', x.uniformity) }
  if (x.extraneous_matter) { const r = parseExtraneousWording(x.extraneous_matter); if (r) spec.extraneous_rule = r; else miss('Extraneous matter', x.extraneous_matter) }

  if (x.eligible_farms && x.eligible_farms.length > 0) {
    const rows: ScheduleRow[] = []
    for (const f of x.eligible_farms) {
      const key = fsaKey(f.fsa_number)
      if (!key) { miss('Eligible farm', JSON.stringify(f)); continue }
      rows.push({ fsa_number: key, county: f.county ?? null, planted_acres: f.planted_acres ?? null, aph_yield: f.aph_yield ?? null, aph_est_bales: f.aph_est_bales ?? null, trendline_est_bales: f.trendline_est_bales ?? null })
    }
    if (rows.length) {
      spec.eligible_fsa_farms = Array.from(new Set(rows.map((r) => r.fsa_number)))
      spec.schedule = rows
    }
  }
  if (x.bale_cap != null && Number.isFinite(Number(x.bale_cap))) spec.bale_cap = Math.round(Number(x.bale_cap))
  if (x.estimated_bales != null && Number.isFinite(Number(x.estimated_bales))) spec.estimated_bales = Math.round(Number(x.estimated_bales))
  if (x.base_grade) spec.base_grade = String(x.base_grade).trim() || null
  if (x.base_price_cents_per_lb != null && Number.isFinite(Number(x.base_price_cents_per_lb))) spec.base_price_cents = Number(x.base_price_cents_per_lb)
  spec.off_spec_terms = x.off_spec_terms?.trim() || null
  spec.other_terms = x.other_deliverables?.trim() || null
  spec.source_clause = x.quality_clause?.trim() || null
  // A practice requirement is modeled (require_dryland) but never switched on
  // from wording: "rain-fed" in a deliverables list is informational. The
  // reviewer flips the toggle by hand.
  if (x.practice_requirement) miss('Practice (left off — tick by hand if the contract tests it)', x.practice_requirement)
  return { spec, notUnderstood }
}

// ---------------------------------------------------------------------------
// Eligible farms ↔ Turnrow farms
// ---------------------------------------------------------------------------

export type FarmLike = { id: string; name: string; fsa_number: string | null; archived_at?: string | null }

export function matchEligibleFarms<F extends FarmLike>(fsaNumbers: ReadonlyArray<string>, farms: ReadonlyArray<F>): { matched: Array<{ fsa: string; farms: F[] }>; unmatched: string[] } {
  const byKey = new Map<string, F[]>()
  for (const f of farms) {
    if (f.archived_at) continue
    const k = fsaKey(f.fsa_number)
    if (!k) continue
    const arr = byKey.get(k)
    if (arr) arr.push(f)
    else byKey.set(k, [f])
  }
  const matched: Array<{ fsa: string; farms: F[] }> = []
  const unmatched: string[] = []
  for (const raw of fsaNumbers) {
    const k = fsaKey(raw)
    if (!k) continue
    const hit = byKey.get(k)
    if (hit) matched.push({ fsa: k, farms: hit })
    else unmatched.push(k)
  }
  return { matched, unmatched }
}

/** Row shape ↔ spec: the database stores numerics as strings sometimes. */
export function specFromRow(row: Record<string, unknown> | null | undefined): ContractQualitySpec | null {
  if (!row) return null
  const n = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
  const arr = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null)
  const rule = row.extraneous_rule
  return {
    allowed_color_codes: arr(row.allowed_color_codes),
    leaf_max: n(row.leaf_max), staple_min: n(row.staple_min), mic_min: n(row.mic_min), mic_max: n(row.mic_max),
    strength_min: n(row.strength_min), uniformity_min: n(row.uniformity_min),
    extraneous_rule: rule === 'none' || rule === 'level1_ok' ? rule : 'any',
    excluded_remarks: arr(row.excluded_remarks),
    eligible_fsa_farms: arr(row.eligible_fsa_farms),
    require_dryland: row.require_dryland === true,
    bale_cap: n(row.bale_cap), estimated_bales: n(row.estimated_bales),
    base_grade: row.base_grade == null ? null : String(row.base_grade),
    base_price_cents: n(row.base_price_cents),
    off_spec_terms: row.off_spec_terms == null ? null : String(row.off_spec_terms),
    other_terms: row.other_terms == null ? null : String(row.other_terms),
    source_clause: row.source_clause == null ? null : String(row.source_clause),
    schedule: Array.isArray(row.schedule) ? (row.schedule as ScheduleRow[]) : null,
  }
}

/** One line a merchant would read: "Color 41+ · leaf ≤ 3 · staple ≥ 37 · mic 4.0–4.7 · strength ≥ 29.0 · unif ≥ 80.0". */
export function specSummaryLine(spec: ContractQualitySpec): string {
  const parts: string[] = []
  if (spec.allowed_color_codes?.length) parts.push(`Color ${spec.allowed_color_codes.join('/')}`)
  if (spec.leaf_max != null) parts.push(`leaf ≤ ${spec.leaf_max}`)
  if (spec.staple_min != null) parts.push(`staple ≥ ${spec.staple_min}`)
  if (spec.mic_min != null || spec.mic_max != null) parts.push(`mic ${spec.mic_min != null ? fmt1(spec.mic_min) : '…'}–${spec.mic_max != null ? fmt1(spec.mic_max) : '…'}`)
  if (spec.strength_min != null) parts.push(`strength ≥ ${fmt1(spec.strength_min)}`)
  if (spec.uniformity_min != null) parts.push(`uniformity ≥ ${fmt1(spec.uniformity_min)}`)
  if (spec.extraneous_rule !== 'any') parts.push(EXTRANEOUS_RULE_LABEL[spec.extraneous_rule].toLowerCase())
  if (spec.require_dryland) parts.push('dryland only')
  return parts.join(' · ')
}
