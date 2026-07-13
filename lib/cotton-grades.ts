// Deterministic parser for the classing office's grade CSV — NOT AI. The real
// files carry two preamble lines above the header row, CRLF line endings,
// header order that can shift between offices, and blank Ex/Rm cells. Columns
// are mapped by HEADER NAME; each bale row parses into the cotton_bale_grades
// shape (loan ¢/lb derived from the Total Value $ ÷ NetWt).

import { loanCentsPerLb } from './cotton'

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
  error: string | null
}

// Header-name → field mapping, tolerant of spacing/case/punctuation variants.
const HEADER_ALIASES: Record<string, keyof ParsedGradeRow> = {
  'bale#': 'pbi_number', 'bale': 'pbi_number', 'pbi': 'pbi_number', 'pbi#': 'pbi_number',
  'netwt': 'net_weight_lbs', 'netweight': 'net_weight_lbs', 'wt': 'net_weight_lbs',
  'prod': 'producer', 'producer': 'producer',
  'farm': 'farm', 'farm#': 'farm',
  'fieldid': 'field_id_text', 'field': 'field_id_text',
  'date': 'class_date', 'classdate': 'class_date',
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
  'ex': 'extraneous',
  'rm': 'remarks', 'remarks': 'remarks',
  'totalvalue': 'loan_value_total', 'value': 'loan_value_total', 'loanvalue': 'loan_value_total',
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

function parseDateCell(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  // MM/DD/YYYY or MM/DD/YY (classing offices) → ISO; ISO passes through.
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (us) {
    const y = Number(us[3]) < 100 ? 2000 + Number(us[3]) : Number(us[3])
    return `${y}-${String(Number(us[1])).padStart(2, '0')}-${String(Number(us[2])).padStart(2, '0')}`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
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
 * then parse each bale row. Rows without a bale number are skipped.
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
    return { rows: [], preambleLines: 0, unknownHeaders: [], error: 'No header row found — expected a "Bale #" column within the first 20 lines.' }
  }
  const fieldByCol: Array<keyof ParsedGradeRow | null> = headers.map((h) => HEADER_ALIASES[normHeader(h)] ?? null)
  const unknownHeaders = headers.filter((h, i) => h.trim() !== '' && fieldByCol[i] == null)

  const rows: ParsedGradeRow[] = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    const cells = splitCsvLine(lines[i])
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
    if (row.loan_value_total != null && row.net_weight_lbs != null) {
      row.loan_value_cents_per_lb = loanCentsPerLb(row.loan_value_total, row.net_weight_lbs)
    }
    rows.push(row)
  }
  return { rows, preambleLines: headerIdx, unknownHeaders, error: null }
}
