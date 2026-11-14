// Deterministic parser for the classing office's grade CSV — NOT AI. The real
// files carry two preamble lines above the header row, CRLF line endings,
// header order that can shift between offices, and blank Ex/Rm cells. Columns
// are mapped by HEADER NAME; each bale row parses into the cotton_bale_grades
// shape (loan ¢/lb derived from the Total Value $ ÷ NetWt).

import { loanCentsPerLb, matchGradesToBales, type BaleLite } from './cotton'
import { pbiKey } from './number-key'

export type ParsedGradeRow = {
  pbi_number: string
  net_weight_lbs: number | null
  /** Corroboration columns — shown in review, never the join key. */
  producer: string | null
  farm: string | null
  field_id_text: string | null
  class_date: string | null // ISO when parseable
  color_grade: string | null
  leaf_grade: string | null
  staple_32nds: number | null
  micronaire: number | null
  strength_g_tex: number | null
  composite_grade: string | null
  rd: number | null
  plus_b: number | null
  trash_pct: number | null
  uniformity_pct: number | null
  length_100ths: number | null
  extraneous: string | null
  remarks: string | null
  loan_value_total: number | null
  loan_value_cents_per_lb: number | null
}

export type GradeCsvResult = {
  rows: ParsedGradeRow[]
  preambleLines: number
  /** Header labels the mapper didn't recognize (informational). */
  unknownHeaders: string[]
  /** The classing date printed above the header ("Date Classing Imported:
   *  2026-11-12"), used for rows whose file has no class-date column. */
  preambleClassDate: string | null
  /** Lines after the header that are not bale rows ("Total Bales: 23,…"). */
  skippedLines: number
  error: string | null
}

// Header-name → field mapping, tolerant of spacing/case/punctuation variants.
const HEADER_ALIASES: Record<string, keyof ParsedGradeRow> = {
  'bale#': 'pbi_number', 'bale': 'pbi_number', 'pbi': 'pbi_number', 'pbi#': 'pbi_number',
  'netwt': 'net_weight_lbs', 'netweight': 'net_weight_lbs', 'wt': 'net_weight_lbs',
  'prod': 'producer', 'producer': 'producer',
  'farm': 'farm', 'farm#': 'farm',
  'fieldid': 'field_id_text', 'field': 'field_id_text',
  'date': 'class_date', 'classdate': 'class_date', 'dateclassed': 'class_date', 'classeddate': 'class_date', 'classingdate': 'class_date',
  'classdt': 'class_date', 'dtclassed': 'class_date', 'datecls': 'class_date', 'clsdate': 'class_date', 'classified': 'class_date',
  'gr': 'color_grade', 'colorgrade': 'color_grade', 'color': 'color_grade',
  'lf': 'leaf_grade', 'leaf': 'leaf_grade',
  'st': 'staple_32nds', 'staple': 'staple_32nds',
  'mic': 'micronaire', 'micronaire': 'micronaire',
  'str': 'strength_g_tex', 'strength': 'strength_g_tex',
  'cgr': 'composite_grade',
  'rd': 'rd',
  '+b': 'plus_b', 'b': 'plus_b', '_b': 'plus_b',
  'tr': 'trash_pct', 'trash': 'trash_pct',
  'unif': 'uniformity_pct', 'uniformity': 'uniformity_pct',
  'len': 'length_100ths', 'length': 'length_100ths',
  'ex': 'extraneous', 'extr': 'extraneous', 'extraneous': 'extraneous', 'extraneousmatter': 'extraneous', 'em': 'extraneous',
  'rm': 'remarks', 'remarks': 'remarks', 'rmk': 'remarks', 'rmks': 'remarks', 'remark': 'remarks',
  'totalvalue': 'loan_value_total', 'value': 'loan_value_total', 'loanvalue': 'loan_value_total',
}

// Columns some offices print that the grade record doesn't keep — known, so
// they are not reported as unrecognized. "Date Ginned" is the GIN's date and
// must never be read as the class date (2026-11-13, the View Celeste export).
const KNOWN_UNUSED_HEADERS = new Set(['dateginned', 'ginned', 'gindate', 'datgin', 'pk', 'pkg', 'crop', 'cropyear'])

/** A bale-number cell: digits, with any spaces or dashes a print adds. A
 *  totals footer ("Total Bales: 23") or a note line is not a bale. */
const isBaleNumberCell = (s: string) => /^\s*\d[\d\s-]*\s*$/.test(s)

/** The classing date a preamble line names ("Date Classing Imported:
 *  2026-11-12 Producer: …", "Classed: 11/12/2026"). Null when none does. */
function preambleClassDate(lines: readonly string[]): string | null {
  for (const line of lines) {
    const m = line.match(/class\w*[^:]*:\s*([0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{1,4})/i)
    if (m) {
      const d = parseDateCell(m[1])
      if (d) return d
    }
  }
  return null
}

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9+_#]/g, '')

const NUMERIC_FIELDS = new Set<keyof ParsedGradeRow>([
  'net_weight_lbs', 'staple_32nds', 'micronaire', 'strength_g_tex', 'rd', 'plus_b',
  'trash_pct', 'uniformity_pct', 'length_100ths', 'loan_value_total',
])

function parseNum(s: string): number | null {
  const t = s.trim().replace(/[$,]/g, '')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** The classing date, from any shape an office prints: MM/DD/YYYY, MM/DD/YY,
 *  MM-DD-YYYY, YYYY-MM-DD (with or without a time), YYYYMMDD, DD-MON-YY,
 *  "Oct 14 2026". Unreadable → null (2026-10-20: the first real import
 *  saved 609 bales with no class date because its header and date shape
 *  were not among the two the parser knew). */
export function parseDateCell(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  const iso = (y: number, m: number, d: number): string | null => {
    const yy = y < 100 ? 2000 + y : y
    if (m < 1 || m > 12 || d < 1 || d > 31 || yy < 1990 || yy > 2100) return null
    return `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  const us = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:\s.*)?$/)
  if (us) return iso(Number(us[3]), Number(us[1]), Number(us[2]))
  const isoLike = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/)
  if (isoLike) return iso(Number(isoLike[1]), Number(isoLike[2]), Number(isoLike[3]))
  const compact = t.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return iso(Number(compact[1]), Number(compact[2]), Number(compact[3]))
  const mon = t.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]*(\d{2,4})$/)
  if (mon && MONTHS[mon[2].toLowerCase()]) return iso(Number(mon[3]), MONTHS[mon[2].toLowerCase()], Number(mon[1]))
  const monFirst = t.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{2,4})$/)
  if (monFirst && MONTHS[monFirst[1].toLowerCase()]) return iso(Number(monFirst[3]), MONTHS[monFirst[1].toLowerCase()], Number(monFirst[2]))
  return null
}

/** Split one CSV line, honoring simple double-quoted cells. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Parse the classing CSV: skip preamble lines until the row whose first cell
 * maps to the bale number (the header row), map every column by header name,
 * then parse each bale row. Lines whose bale cell is not a number (a totals
 * footer) are skipped. A row with no class date takes the date the preamble
 * names, when it names one.
 */
export function parseGradeCsv(text: string): GradeCsvResult {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let headerIdx = -1
  let headers: string[] = []
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const cells = splitCsvLine(lines[i])
    if (cells.length >= 2 && HEADER_ALIASES[normHeader(cells[0])] === 'pbi_number') {
      headerIdx = i
      headers = cells
      break
    }
  }
  if (headerIdx === -1) {
    return { rows: [], preambleLines: 0, unknownHeaders: [], preambleClassDate: null, skippedLines: 0, error: 'No header row found — expected a "Bale #" column within the first 20 lines.' }
  }
  const fieldByCol: Array<keyof ParsedGradeRow | null> = headers.map((h) => HEADER_ALIASES[normHeader(h)] ?? null)
  const unknownHeaders = headers.filter((h, i) => h.trim() !== '' && fieldByCol[i] == null && !KNOWN_UNUSED_HEADERS.has(normHeader(h)))
  const baleCol = fieldByCol.indexOf('pbi_number')
  const fileClassDate = preambleClassDate(lines.slice(0, headerIdx))
  let skippedLines = 0

  const rows: ParsedGradeRow[] = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    const cells = splitCsvLine(lines[i])
    if (!isBaleNumberCell(cells[baleCol] ?? '')) { skippedLines++; continue }
    const row: ParsedGradeRow = {
      pbi_number: '', net_weight_lbs: null, producer: null, farm: null, field_id_text: null,
      class_date: null, color_grade: null, leaf_grade: null, staple_32nds: null, micronaire: null,
      strength_g_tex: null, composite_grade: null, rd: null, plus_b: null, trash_pct: null,
      uniformity_pct: null, length_100ths: null, extraneous: null, remarks: null,
      loan_value_total: null, loan_value_cents_per_lb: null,
    }
    for (let c = 0; c < cells.length && c < fieldByCol.length; c++) {
      const field = fieldByCol[c]
      if (!field) continue
      const raw = cells[c]
      if (field === 'class_date') row.class_date = parseDateCell(raw)
      else if (NUMERIC_FIELDS.has(field)) (row[field] as number | null) = parseNum(raw)
      else {
        const t = raw.trim()
        ;(row[field] as string | null) = t === '' ? null : t
      }
    }
    if (!row.pbi_number) continue
    if (row.class_date == null) row.class_date = fileClassDate
    if (row.loan_value_total != null && row.net_weight_lbs != null) {
      row.loan_value_cents_per_lb = loanCentsPerLb(row.loan_value_total, row.net_weight_lbs)
    }
    rows.push(row)
  }
  return { rows, preambleLines: headerIdx, unknownHeaders, preambleClassDate: fileClassDate, skippedLines, error: null }
}

// ---------- Import plan: the ONE duplicate rule for classing files ----------
//
// 2026-11-14: the gin's "2nd run" files repeat every bale of the 1st run (513
// bales, identical grades), and the office warned more repeats are likely.
// The bale is the identity — a PBI resolves to ONE saved bale (the DB holds
// one bale per org × crop year × PBI key and one grade row per bale), so
// every row is placed in exactly one bucket:
//
//   new        → the bale has no grade yet: saved
//   unchanged  → the bale's saved grade equals this row: skipped, never rewritten
//   changed    → the bale's saved grade differs: held unless the user opts in
//   repeatedSame / repeatedConflict → the FILE names one bale twice; identical
//                copies keep one, conflicting copies hold every copy out
//   unmatched  → no bale this crop year (otherYear when another year has it)
//
// The class date alone never makes a row "changed": a re-sent bale carries
// the re-run file's date, and the first date is the real one.

/** The graded values compared to decide "same bale, same grades". */
export const GRADE_VALUE_FIELDS = [
  'color_grade', 'leaf_grade', 'staple_32nds', 'micronaire', 'strength_g_tex', 'composite_grade',
  'rd', 'plus_b', 'trash_pct', 'uniformity_pct', 'length_100ths', 'extraneous', 'remarks', 'loan_value_total',
] as const
export type GradeValueField = (typeof GRADE_VALUE_FIELDS)[number]
export type GradeValues = { [K in GradeValueField]?: string | number | null }

const GRADE_FIELD_LABELS: Record<GradeValueField, string> = {
  color_grade: 'Gr', leaf_grade: 'Lf', staple_32nds: 'St', micronaire: 'Mic', strength_g_tex: 'Str',
  composite_grade: 'Cgr', rd: 'Rd', plus_b: '+b', trash_pct: 'Tr', uniformity_pct: 'Unif',
  length_100ths: 'Len', extraneous: 'Ex', remarks: 'Rm', loan_value_total: 'Value',
}

function sameValue(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '')
  if (blank(a) || blank(b)) return blank(a) && blank(b)
  const na = Number(a), nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-9
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase()
}

/** The fields whose values differ, labeled the way the file prints them
 *  ("Mic 4.2 → 4.4"). Empty = the same grades. */
export function gradeDiffs(saved: GradeValues, incoming: GradeValues): string[] {
  const out: string[] = []
  for (const f of GRADE_VALUE_FIELDS) {
    if (!sameValue(saved[f], incoming[f])) out.push(`${GRADE_FIELD_LABELS[f]} ${saved[f] ?? '—'} → ${incoming[f] ?? '—'}`)
  }
  return out
}

export type PlanBale = BaleLite & { crop_year?: number }
export type GradeImportPlan<T> = {
  new: Array<{ row: T; bale: PlanBale; weightMismatch: boolean }>
  unchanged: Array<{ row: T; bale: PlanBale }>
  changed: Array<{ row: T; bale: PlanBale; weightMismatch: boolean; diffs: string[] }>
  /** Extra identical copies of a bale the file already listed (one copy is planned). */
  repeatedSame: T[]
  /** A bale the file lists more than once with DIFFERENT grades — every copy held out. */
  repeatedConflict: Array<{ pbi: string; rows: T[] }>
  unmatched: T[]
  /** Unmatched rows whose bale is on another crop year's receipts. */
  otherYear: Array<{ row: T; cropYear: number }>
}

/**
 * Sort every classing row into exactly one bucket (see above). `yearBales`
 * are the selected crop year's bales; `otherBales` (optional) every other
 * year's, only to tell the user a file belongs to another year. `savedGrades`
 * are the grades already on file, keyed by bale id.
 */
export function planGradeImport<T extends ParsedGradeRow>(
  rows: readonly T[],
  yearBales: readonly PlanBale[],
  savedGrades: ReadonlyMap<string, GradeValues>,
  otherBales: readonly PlanBale[] = [],
): GradeImportPlan<T> {
  const plan: GradeImportPlan<T> = { new: [], unchanged: [], changed: [], repeatedSame: [], repeatedConflict: [], unmatched: [], otherYear: [] }
  const { matched, unmatched } = matchGradesToBales(rows, yearBales)

  // Group by the bale each row resolved to — a 7-digit and a 12-digit PBI for
  // the same bale are one bale, not two.
  const byBale = new Map<string, Array<{ row: T; bale: PlanBale; weightMismatch: boolean }>>()
  for (const m of matched) byBale.set(m.bale.id, [...(byBale.get(m.bale.id) ?? []), m as { row: T; bale: PlanBale; weightMismatch: boolean }])
  for (const group of byBale.values()) {
    const [first, ...rest] = group
    if (rest.some((r) => gradeDiffs(first.row, r.row).length > 0)) {
      plan.repeatedConflict.push({ pbi: first.bale.pbi_number, rows: group.map((g) => g.row) })
      continue
    }
    plan.repeatedSame.push(...rest.map((r) => r.row))
    const saved = savedGrades.get(first.bale.id)
    if (!saved) { plan.new.push(first); continue }
    const diffs = gradeDiffs(saved, first.row)
    if (diffs.length === 0) plan.unchanged.push({ row: first.row, bale: first.bale })
    else plan.changed.push({ ...first, diffs })
  }

  // Unmatched rows: repeats collapse by PBI key too, then look in other years.
  const seen = new Set<string>()
  const left: T[] = []
  for (const row of unmatched) {
    const k = pbiKey(row.pbi_number) ?? row.pbi_number
    if (seen.has(k)) { plan.repeatedSame.push(row); continue }
    seen.add(k)
    left.push(row)
  }
  if (otherBales.length && left.length) {
    const other = matchGradesToBales(left, otherBales)
    for (const m of other.matched) plan.otherYear.push({ row: m.row, cropYear: (m.bale as PlanBale).crop_year ?? 0 })
    plan.unmatched.push(...other.unmatched)
  } else plan.unmatched.push(...left)
  return plan
}
