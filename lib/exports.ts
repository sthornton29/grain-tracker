// Universal report exports — Excel, PDF, and Print.
//
// ONE shared layer every report's export goes through, so formatting is defined
// once and the export mirrors the on-screen report. A report builds an
// ExportPayload (title, plain-English filters, summary cards, and table sections
// with grouped headers / subtotal / total rows) and the renderers here handle
// all number formatting, styling, pagination, and sheet layout.
//
// Number formatting (Part A of the export overhaul) is centralized in
// `formatNumber` / `excelNumFmt`, keyed off each column's `format`:
//   - thousands separators everywhere (acres, bushels, dollars, quantities)
//   - decimals by data type (yields/acres 1, $/bu & $/ac 2, bushels 0, …)
//   - currency shows `$`; percentages show `%`
//   - negatives in parentheses, e.g. ($1,234.56) — financial convention
//   - Excel cells stay REAL NUMBERS with a numFmt (sortable / sum-able);
//     PDF cells are the formatted strings.
//
// The xlsx→exceljs and jspdf libraries are ~1 MB together; they're imported
// dynamically inside the export functions so a user who never exports never
// pays the download cost. Print uses the browser dialog + the `.print-area` /
// `.no-print` CSS in app/globals.css.

import { exportChrome, type ExportBranding, type ExportChrome } from '@/lib/branding'
import {
  columnLetters, evaluateFormula, toExcelFormula, FormulaError,
  type FormulaData, type FormulaLayout, type FormulaNode, type Scalar,
} from '@/lib/formula'

// ---------- formatting model ----------

// CANONICAL metric → format mapping (the consistency contract — every report
// uses the same NumFmt for the same metric so a value reads identically across
// all PDF/Excel exports):
//   year / crop year ............ 'text'  (never comma-grouped)
//   bushels (any) ............... 'bu'    (0 dec, comma)
//   acres (any) ................. 'acres' (1 dec)
//   yield (bu/ac) ............... 'yield' (1 dec)
//   $/bu prices ................. 'price' ($, 2 dec)
//   a contract's own price terms  'price4' ($, 4 dec — futures, basis and cash
//                                          price as the contract states them:
//                                          grain trades in quarter cents, and a
//                                          $/lb program rate needs the places)
//   whole-dollar totals ......... 'usd0'  (revenue, cost, profit, indemnity, payments…)
//   trading P&L (with cents) .... 'usd2'  (hedging — matches its on-screen cents)
//   counts / weights (lb) ....... 'int'
//   moisture .................... 'dec1'
//   option premium (cents) ...... 'dec2'
//   percentages ................. 'pct0' / 'pct1'
//   calendar dates .............. 'date'  (an ISO 'YYYY-MM-DD' string in the
//                                          payload; a REAL date in Excel shown
//                                          m/d/yyyy, '9/24/2026' in the PDF)
//   audit-workbook bushels ...... 'bu3'   (3 dec — load-level dry bushels and the
//                                          totals that sum them, so a fractional
//                                          bushel never hides behind a 0-dec format)
//
// FORMULA CELLS (lib/formula.ts): a cell may carry `f` (an expression over
// section/column KEYS) plus `v`, its cached result. Excel writes
// { formula, result } so viewers that never recalculate (phone previews, mail
// attachments) still show numbers, and the workbook is flagged to recalculate
// fully on open. `input: true` marks a value that came straight from a Turnrow
// record (weights, moisture, acres, overrides) — written in BLUE; formulas stay
// black. Sections used by formulas carry a `key` and keyed columns; `plain`
// sections put the header on row 1 (or 2, under a `note`) with an autofilter.
export type NumFmt =
  | 'text'
  | 'int' // 1,234
  | 'dec1' // 1,234.5
  | 'dec2' // 1,234.56
  | 'usd0' // $1,234
  | 'usd2' // $1,234.56
  | 'price' // $4.93 ($/bu, 2 decimals)
  | 'price4' // $4.8525 (a contract's futures / basis / cash price, a $/lb rate — 4 decimals)
  | 'cents' // a ¢/lb-STORED cotton price displayed as $/lb: 72.65 → $0.7265
  | 'bu' // 45,000 bushels (0 decimals)
  | 'bu2' // 1,000.00 bushels (2 decimals — audit load rows)
  | 'bu3' // 1,000.000 bushels (3 decimals — audit workbooks)
  | 'acres2' // 1,250.00 acres (FSA reports acres to hundredths)
  | 'factor' // 0.9838 (a balance factor, 4 decimals)
  | 'ratio' // a FRACTION shown as a percent: 0.0162 → 1.62% (Excel 0.00%)
  | 'lbs' // 412,000 lbs (0 decimals, commas)
  | 'acres' // 1,250.0 (1 decimal)
  | 'yield' // 182.5 bu/ac (1 decimal)
  | 'pct0' // 86%
  | 'pct1' // 86.5%
  | 'date' // an ISO 'YYYY-MM-DD' STRING: a real Excel date (m/d/yyyy), '9/24/2026' in the PDF

export type Tone = 'favorable' | 'unfavorable' | 'warning' | 'muted' | 'neutral'

export type ExportColumn = {
  /** Column header text. */
  label: string
  /** Stable key formulas refer to (lib/formula col/cell/self). Required on
   *  every column of a section that formulas reference. */
  key?: string
  align?: 'left' | 'right'
  /** How numeric cells in this column format (PDF string + Excel numFmt). When
   *  omitted, numbers are inferred (thousands separators, up to 2 decimals). */
  format?: NumFmt
  /** Excel column width override, in characters. */
  width?: number
  /** Excel: wrap text longer than the column (the row grows to fit). Default
   *  true — a long note never hides behind the next column or falls off the
   *  printed page. `false` keeps one line (the text runs on to the right when
   *  the cells beside it are empty). */
  wrap?: boolean
  /** What the column means (and, for a formula column, the formula in words).
   *  NOT written as an Excel comment — comment popups cover the data — a
   *  report that wants these visible lists them on its own notes sheet. */
  note?: string
  /** Excel: 'check' cells read OK / CHECK and get green / red conditional formats. */
  kind?: 'check'
}

/** Excel-only rows written ABOVE a plain section's header: a title block, a
 *  KPI strip (label / value pairs on one row), a line of links (`link` cells,
 *  '#' targets for other sheets), plain text, or a blank spacer. Formula
 *  cells may refer to other sections by `cell`/`col` (never `self`). */
export type PreludeRow = { kind: 'title' | 'subtitle' | 'text' | 'kpi' | 'links' | 'blank'; cells: ExportCell[] }

/** A cell is a bare value, or a value plus per-cell format/tone overrides —
 *  or a formula cell (`f`, with `v` its cached result once evaluated), or an
 *  input cell (`input: true`, blue in Excel). `link` makes the cell a hyperlink. */
export type ExportCell =
  | string
  | number
  | null
  | { v: string | number | null; format?: NumFmt; tone?: Tone; f?: FormulaNode; input?: boolean; link?: string }

/** Visual role of a row.
 *  'data'     — normal row.
 *  'subhead'  — a group label spanning the whole table (first non-empty cell shown).
 *  'subtotal' — a light, semibold group subtotal.
 *  'total'    — an emphasized grand-total row. */
export type RowKind = 'data' | 'subhead' | 'subtotal' | 'total'

export type ExportSection = {
  /** Section label — a heading bar in the PDF and the sheet name in Excel. */
  title?: string
  /** Stable key formulas refer to this section (sheet) by. */
  key?: string
  /** Excel: a plain data table — no automatic title block (the section brings
   *  its own short `prelude`); the header is frozen with an autofilter over
   *  the data. */
  plain?: boolean
  /** Excel (plain sections): one explanatory line above the header. */
  note?: string
  /** Excel (plain sections): rows above the note/header — a title, one line
   *  of context, a link back. KEEP IT SHORT: everything above the header is
   *  frozen with it, and a sheet whose header sits below row MAX_FROZEN_ROWS
   *  is refused (lib/export-layout.test.ts). KPI strips, contents lists and
   *  long explanations belong in `postlude`, under the table. */
  prelude?: PreludeRow[]
  /** Excel: rows written UNDER the table after a blank row — contents links,
   *  KPIs, footnotes. They scroll with the data and never eat frozen space.
   *  Formula cells may refer to other sections by `cell`/`col` (never `self`). */
  postlude?: PreludeRow[]
  /** Excel: the filter buttons on the header row. Default: on for `plain`
   *  sections (flat lists a reader sorts and filters), off otherwise. */
  autoFilter?: boolean
  /** Excel: light banding on alternate data rows (default true). */
  banded?: boolean
  /** Excel: the sheet tab color (ARGB). */
  tabColor?: string
  /** Excel: how many leading columns stay frozen beside the data — the ones
   *  that identify a row (Farm + Field, Date + Ticket). Default: the first
   *  column of a table too wide for one screen, none otherwise. Always capped
   *  so the frozen strip never exceeds MAX_FROZEN_WIDTH characters. */
  freezeColumns?: number
  columns: ExportColumn[]
  rows: ExportCell[][]
  /** Per-row role, parallel to `rows`. Missing entries default to 'data'. */
  rowMeta?: RowKind[]
  /** Optional spanning header groups above the columns (e.g. Production / Sales /
   *  Pricing / Profitability). Spans should sum to columns.length. */
  groups?: Array<{ label: string; span: number }>
}

/** A headline metric (mirrors an on-screen summary card). */
export type SummaryCard = { label: string; value: string; sub?: string; tone?: Tone }

export type ExportPayload = {
  /** Report title shown at the top of every export. */
  title: string
  /** Active filters in plain English ("2026 Crop Year · All Entities · Corn"). */
  filters?: string
  /** Headline metrics → rendered as a summary band (PDF) / summary block (Excel). */
  summary?: SummaryCard[]
  /** One or more table sections. Single-section reports are common. */
  sections: ExportSection[]
  /** Filename without extension (defaults to slug of the title + date). */
  filename?: string
  /** Excel: stack every section onto one sheet instead of one sheet per section. */
  singleSheet?: boolean
  /** Excel: flag the workbook to recalculate every formula when opened (set
   *  automatically whenever a section carries formula cells). */
  fullCalcOnLoad?: boolean
  /** Excel: document properties, the print footer, and zero-as-dash number formats. */
  excel?: { title?: string; subject?: string; company?: string; footer?: string; zeroAsDash?: boolean }
  /** PDF orientation; defaults to landscape for wide tables, portrait otherwise. */
  orientation?: 'portrait' | 'landscape'
  /**
   * Branding mode (lib/branding.ts). Default Turnrow chrome; `mode: 'org'`
   * renders under the FARM'S identity with zero Turnrow marks — for
   * landowner/lender-facing documents (Rent Settlement statements).
   */
  branding?: ExportBranding
}

// ---------- number formatting (single source of truth) ----------

function group(n: number, minDec: number, maxDec: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: minDec, maximumFractionDigits: maxDec })
}

// Format a number for DISPLAY (PDF / Excel summary text). Negatives render in
// parentheses. `fmt` omitted → inference: thousands separators, up to 2 decimals.
export function formatNumber(value: number, fmt?: NumFmt): string {
  if (!Number.isFinite(value)) return ''
  if (fmt === 'text' || fmt === 'date') return String(value)
  const neg = value < 0
  const a = Math.abs(value)
  let body: string
  switch (fmt) {
    case 'int':
    case 'bu':
    case 'lbs':
      body = group(a, 0, 0); break
    case 'dec1':
    case 'acres':
    case 'yield':
      body = group(a, 1, 1); break
    case 'dec2':
      body = group(a, 2, 2); break
    case 'bu3':
      body = group(a, 3, 3); break
    case 'bu2':
    case 'acres2':
      body = group(a, 2, 2); break
    case 'factor':
      body = a.toFixed(4); break
    case 'ratio':
      body = group(a * 100, 2, 2) + '%'; break
    case 'usd0':
      body = '$' + group(a, 0, 0); break
    case 'usd2':
    case 'price':
      body = '$' + group(a, 2, 2); break
    case 'price4':
      body = '$' + group(a, 4, 4); break
    case 'cents': // a ¢/lb-stored cotton price, DISPLAYED as $/lb (÷100, 4dp)
      body = '$' + group(a / 100, 4, 4); break
    case 'pct0':
      body = group(a, 0, 0) + '%'; break
    case 'pct1':
      body = group(a, 1, 1) + '%'; break
    default: // inference
      body = group(a, 0, 2); break
  }
  return neg ? `(${body})` : body
}

// The Excel cell number-format string for a NumFmt. Negatives in parentheses to
// match the PDF; percentages use a literal "%" (the values are already percents,
// not fractions, so we must NOT use Excel's % which multiplies by 100).
export function excelNumFmt(fmt?: NumFmt): string | undefined {
  switch (fmt) {
    case 'text': return undefined
    case 'date': return 'm/d/yyyy'
    case 'int':
    case 'bu':
    case 'lbs': return '#,##0;(#,##0)'
    case 'dec1':
    case 'acres':
    case 'yield': return '#,##0.0;(#,##0.0)'
    case 'dec2': return '#,##0.00;(#,##0.00)'
    case 'bu3': return '#,##0.000;(#,##0.000)'
    case 'bu2':
    case 'acres2': return '#,##0.00;(#,##0.00)'
    case 'factor': return '0.0000'
    case 'ratio': return '0.00%;-0.00%'
    case 'usd0': return '$#,##0;($#,##0)'
    case 'usd2':
    case 'price': return '$#,##0.00;($#,##0.00)'
    case 'price4':
    case 'cents': return '$#,##0.0000;($#,##0.0000)'
    case 'pct0': return '#,##0"%";(#,##0"%")'
    case 'pct1': return '#,##0.0"%";(#,##0.0"%")'
    default: return '#,##0.##;(#,##0.##)' // inference
  }
}

type NormCell = { raw: string | number | null; format?: NumFmt; tone?: Tone; f?: FormulaNode; input?: boolean; link?: string }
function normCell(cell: ExportCell): NormCell {
  if (cell != null && typeof cell === 'object') return { raw: cell.v, format: cell.format, tone: cell.tone, f: cell.f, input: cell.input, link: cell.link }
  return { raw: cell }
}

// ---------- formula support (lib/formula.ts) ----------

/** Does any section carry a formula cell? */
export function payloadHasFormulas(payload: ExportPayload): boolean {
  const has = (c: ExportCell) => c != null && typeof c === 'object' && c.f != null
  return payload.sections.some((s) => s.rows.some((r) => r.some(has)) || [...(s.prelude ?? []), ...(s.postlude ?? [])].some((p) => p.cells.some(has)))
}

/** Sanitize + de-duplicate worksheet names exactly as the Excel writer does
 *  (≤31 chars, no \ / ? * [ ] :, unique case-insensitively). */
function resolveSheetNames(payload: ExportPayload): string[] {
  const used = new Set<string>()
  const take = (desired: string, fallback: string): string => {
    // Cut to Excel's 31 characters at a word — "Rent Settlement — 2026 Crop",
    // never "…2026 Crop Yea" — and never leave a dangling separator
    // ("North 40 · Corn ·").
    const clean = desired.replace(/[\\/?*[\]:]/g, '-').trim()
    let cut = clean.slice(0, 31)
    if (clean.length > 31 && !/\s/.test(clean.charAt(31))) {
      const at = cut.lastIndexOf(' ')
      if (at >= 12) cut = cut.slice(0, at)
    }
    const base = cut.replace(/[\s·—–,;-]+$/, '') || fallback
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`
      name = base.slice(0, 31 - suffix.length).trim() + suffix
    }
    used.add(name.toLowerCase())
    return name
  }
  if (!payload.singleSheet && payload.summary?.length) take('Summary', 'Summary')
  if (payload.singleSheet) {
    const one = take(payload.title, 'Report')
    return payload.sections.map(() => one)
  }
  // A lone untitled table is named for its report, never "Sheet 1".
  const lone = payload.sections.length === 1
  return payload.sections.map((section, i) => take(section.title || (lone ? payload.title : `Sheet ${i + 1}`), `Sheet ${i + 1}`))
}

/** The physical row the section's column header lands on, given how the
 *  writer lays a sheet out (title block for titled sheets, note/groups). */
function headerRowOf(payload: ExportPayload, section: ExportSection): number {
  let row = 0
  if (!section.plain) {
    // Title, the context line (two in org mode: the letterhead line first), a thin spacer.
    row += 1 + (exportChrome(payload.branding).headerLines.length > 0 ? 2 : 1) + 1
  } else {
    // The section's own short title block, its note, then the same thin spacer.
    const above = (section.prelude ?? []).length + (section.note ? 1 : 0)
    row += above > 0 ? above + 1 : 0
  }
  if (section.groups && section.groups.length > 0) row += 1
  return row + 1
}

/** Section key → sheet name, first data row, row count, column letters. Only
 *  keyed sections appear; a formula that refers to an unkeyed section throws
 *  at render time with the missing key named. */
export function formulaLayout(payload: ExportPayload): FormulaLayout {
  if (payload.singleSheet && payloadHasFormulas(payload)) throw new Error('formula cells are not supported on singleSheet exports')
  const names = resolveSheetNames(payload)
  const layout: FormulaLayout = {}
  payload.sections.forEach((section, i) => {
    if (!section.key) return
    if (layout[section.key]) throw new Error(`duplicate section key "${section.key}"`)
    const columns: Record<string, string> = {}
    section.columns.forEach((c, ci) => { if (c.key) columns[c.key] = columnLetters(ci + 1) })
    layout[section.key] = {
      sheetName: names[i],
      firstRow: headerRowOf(payload, section) + 1,
      rowCount: section.rows.length,
      columns,
    }
  })
  return layout
}

/** The evaluator's view of the payload: keyed sections only, cells as values
 *  or `{ f }`. A number written under the 'cents' format is NOT divided here —
 *  formulas see the stored value, as the on-screen math does. */
export function payloadFormulaData(payload: ExportPayload): FormulaData {
  const data: FormulaData = {}
  for (const section of payload.sections) {
    if (!section.key) continue
    data[section.key] = {
      columns: section.columns.map((c, i) => c.key ?? `__col${i}`),
      rows: section.rows.map((row) => section.columns.map((_, i) => {
        const n = normCell(row[i] ?? null)
        return n.f ? { f: n.f, v: n.raw } : n.raw
      })),
    }
  }
  return data
}

/** Evaluate every formula cell of the payload IN PLACE (filling each formula
 *  cell's cached `v`) and return the evaluated grid per section key. A cell
 *  whose formula errors keeps `v: null` and reports a FormulaError here. */
export function evaluatePayload(payload: ExportPayload): Record<string, Array<Array<Scalar | FormulaError>>> {
  const data = payloadFormulaData(payload)
  const memo = new Map<string, Scalar | FormulaError>()
  const out: Record<string, Array<Array<Scalar | FormulaError>>> = {}
  for (const section of payload.sections) {
    if (!section.key) continue
    const key = section.key
    // The rows above a table and the rows under it (a KPI strip, a check line).
    for (const pr of [...(section.prelude ?? []), ...(section.postlude ?? [])]) {
      for (const raw of pr.cells) {
        const n = normCell(raw)
        if (!n.f || raw == null || typeof raw !== 'object') continue
        const v = evaluateFormula(n.f, data, { s: key, r: -1 }, memo)
        raw.v = v instanceof FormulaError ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v
      }
    }
    out[key] = section.rows.map((row, r) => section.columns.map((_, ci) => {
      const raw = row[ci] ?? null
      const n = normCell(raw)
      if (!n.f) return n.raw
      const v = evaluateFormula(n.f, data, { s: key, r }, memo)
      if (raw != null && typeof raw === 'object') raw.v = v instanceof FormulaError ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v
      return v
    }))
  }
  return out
}

/** The Excel formula text a keyed cell will be written with (for tests and
 *  for anyone reading the workbook's audit trail without opening Excel). */
export function formulaTextOf(payload: ExportPayload, sectionKey: string, rowIndex: number, colKey: string): string | null {
  const section = payload.sections.find((s) => s.key === sectionKey)
  if (!section) throw new Error(`unknown section key "${sectionKey}"`)
  const ci = section.columns.findIndex((c) => c.key === colKey)
  if (ci < 0) throw new Error(`unknown column key "${colKey}" in section "${sectionKey}"`)
  const n = normCell(section.rows[rowIndex]?.[ci] ?? null)
  if (!n.f) return null
  return toExcelFormula(n.f, { layout: formulaLayout(payload), at: { s: sectionKey, r: rowIndex } })
}

// Display string for a cell (PDF + Excel widths + summary). Strings pass through;
// numbers format via the cell/column format (or inference).
function cellText(raw: string | number | null, fmt?: NumFmt): string {
  if (raw == null) return ''
  if (typeof raw === 'number') return formatNumber(raw, fmt)
  if (fmt === 'date') return formatDateText(raw)
  return String(raw)
}

/** '2026-09-24' (or an ISO timestamp) → '9/24/2026', the app's one date
 *  style (lib/format-date); anything else passes through unchanged. */
export function formatDateText(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : raw
}

export function defaultFilename(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return `${slug}-${new Date().toISOString().slice(0, 10)}`
}

// PDF picks landscape automatically for wide tables.
function resolveOrientation(payload: ExportPayload): 'portrait' | 'landscape' {
  if (payload.orientation) return payload.orientation
  const maxCols = payload.sections.reduce((m, s) => Math.max(m, s.columns.length), 0)
  return maxCols > 6 ? 'landscape' : 'portrait'
}

// ---------- colors (shared by both renderers) ----------

const TONE_RGB: Record<Tone, [number, number, number]> = {
  favorable: [21, 128, 61], // green-700
  unfavorable: [185, 28, 28], // red-700
  warning: [180, 83, 9], // amber-700
  muted: [148, 163, 184], // slate-400
  neutral: [51, 65, 85], // slate-700
}
const toneArgb = (t: Tone) => 'FF' + TONE_RGB[t].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()

// Header fills now come from exportChrome (lib/branding.ts): Turnrow green
// by default, a neutral slate in org-branded mode.

// ---------- Excel (exceljs — real numbers, number formats, styling) ----------
//
// THE LAYOUT CONTRACT — every sheet of every export, pinned by
// lib/export-layout.test.ts. A reader opens the file and sees the numbers:
//
//   * THE TABLE STARTS AT THE TOP. Above its header sit a title, one or two
//     muted lines of context (filters, when it was generated, the farm's
//     letterhead line) and a thin spacer — nothing else. KPI strips, contents
//     lists and explanations go UNDER the table (`postlude`) or on their own
//     sheet, where they scroll with the data.
//   * FREEZE PANES hold exactly that and no more: the title block plus the
//     header row(s) — never more than MAX_FROZEN_ROWS rows — and, beside the
//     data, only the column(s) that identify a row, never wider than
//     MAX_FROZEN_WIDTH characters and only when the table is too wide for one
//     screen. A sheet that stacks several tables freezes nothing: no single
//     header row is true for the whole sheet. The sheet opens with the cursor
//     on the first data cell.
//   * BLANK MEANS EMPTY. A blank cell is written with no value at all (never
//     an empty string), so long text runs on across it, centered group
//     headings center, and COUNTA / Ctrl+Arrow behave.
//   * one font family (Calibri 11; sheet titles 14 bold; stacked-table heads
//     12 bold)
//   * header rows: forest fill, white bold wrapped text, as tall as their
//     longest label needs; a numeric column's header is right-aligned over
//     its numbers; filter buttons never cover a label
//   * column widths fitted to the longest header word or value; long text
//     wraps inside its column (the row grows) instead of being cut off
//   * thin light-gray horizontal rules only; subtotal rows light green + bold;
//     grand totals bold with a double top border; banding on plain data rows
//     only, through a conditional format so it survives sorting
//   * no merged cells — spanning group headers use Center Across Selection —
//     so sort and filter always work
//   * a number with no declared format shows as a whole number or with up to
//     two decimals, never with a stray trailing point
//   * inputs blue, formulas black; check columns green on OK, red on CHECK
//   * no green "number stored as text" / "inconsistent formula" corner flags
//     (ticket and FSA numbers are text on purpose)
//   * print-ready: portrait when the table fits, landscape otherwise, fit to
//     one page wide, header rows repeated, narrow margins, a footer with the
//     page number
//   * document properties (title / subject / company / created); the first
//     sheet opens active
// Report-specific layout (a title, a line of context, a link back, the sort
// order) is expressed through a section's `prelude` / `postlude` rows and
// stays in the report's own builder.

/** Most rows a sheet may freeze above its data (title block + header rows). */
export const MAX_FROZEN_ROWS = 6
/** Most column width, in characters, a sheet may freeze beside its data. */
export const MAX_FROZEN_WIDTH = 46
/** A table narrower than this fits one screen: no column is frozen by default. */
const ONE_SCREEN_WIDTH = 110
/** A table narrower than this prints portrait. */
const PORTRAIT_WIDTH = 100
/** Text columns grow to this many characters, then wrap. */
const TEXT_WIDTH_CAP = 50
/** One line of Calibri 11, in points. */
const LINE_PT = 15

function browserDownload(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ws = any

const FONT = 'Calibri'
const TITLE_ARGB = 'FF0B4A24' // brand forest
const INPUT_FONT_ARGB = 'FF0000FF' // blue — a value straight from a Turnrow record
const LINK_FONT_ARGB = 'FF256F35' // brand deep green
const RULE_ARGB = 'FFD9D9D9' // light-gray horizontal rules
const BAND_ARGB = 'FFF6F8F6' // very light banding
const SUBTOTAL_FILL_ARGB = 'FFE8F5E9' // light green
const TOTAL_FILL_ARGB = 'FFF1F5F9' // slate-100
const SUBHEAD_FILL_ARGB = 'FFF1F5F9'
const MUTED_ARGB = 'FF64748B'
const OK_FILL = 'FFC6EFCE'
const OK_FONT = 'FF006100'
const CHECK_FILL = 'FFFFC7CE'
const CHECK_FONT = 'FF9C0006'

/** Zero as an en dash: appended as the format's third section unless it has one. */
function withZeroDash(fmt: string | undefined, zeroAsDash: boolean | undefined): string | undefined {
  if (!fmt || !zeroAsDash) return fmt
  if (fmt.split(';').length >= 3) return fmt
  return fmt.split(';').length === 1 ? `${fmt};(${fmt});"–"` : `${fmt};"–"`
}

/** 'Generated 11/17/2026 9:16 AM' — the same stamp on every sheet of a file. */
function generatedStamp(d: Date): string {
  const hh = d.getHours()
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `Generated ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`
}

/** The muted line(s) under a sheet title. Org-branded documents lead with the
 *  farm's own letterhead line; then the filters and when the file was made. */
function contextLines(payload: ExportPayload, chrome: ExportChrome, now: Date): string[] {
  const letterhead = chrome.headerLines.length > 0
  const lines: string[] = []
  if (letterhead) lines.push([chrome.attributionPrefix, ...chrome.headerLines].join(' · '))
  lines.push([payload.filters, generatedStamp(now), letterhead ? null : chrome.attributionPrefix].filter(Boolean).join(' · '))
  return lines
}

/** The title on a sheet: the report, plus the section when there are several
 *  to tell apart. A report with one table is titled for the report alone (its
 *  section title only names the tab). */
function sheetTitleOf(payload: ExportPayload, section: ExportSection | null): string {
  const t = section?.title?.trim()
  if (!t || payload.sections.length < 2 || payload.title.toLowerCase().includes(t.toLowerCase())) return payload.title
  return `${payload.title} — ${t}`
}

/** Is this column a column of quantities (right-aligned, header and all)? */
function isNumericColumn(section: ExportSection, i: number): boolean {
  const c = section.columns[i]
  if (!c) return false
  if (c.align) return c.align === 'right'
  if (c.format) return c.format !== 'text' && c.format !== 'date'
  let nums = 0
  let texts = 0
  section.rows.forEach((row, ri) => {
    if (section.rowMeta?.[ri] === 'subhead') return
    const n = normCell(row[i] ?? null)
    if (n.format === 'text' || n.format === 'date') { texts++; return }
    if (typeof n.raw === 'number' || n.f != null) nums++
    else if (n.raw != null && n.raw !== '') texts++
  })
  return nums > 0 && texts * 4 <= nums
}

/** Lines a text takes when wrapped at whole words into `width` characters. */
function wrappedLines(text: string, width: number): number {
  const cap = Math.max(4, Math.floor(width))
  let lines = 0
  for (const para of text.split(/\r?\n/)) {
    let used = 0
    lines++
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (used === 0) { used = word.length; lines += Math.floor((word.length - 1) / cap); used = ((word.length - 1) % cap) + 1; continue }
      if (used + 1 + word.length <= cap) { used += 1 + word.length; continue }
      lines += 1 + Math.floor((word.length - 1) / cap)
      used = ((word.length - 1) % cap) + 1
    }
  }
  return lines
}

/** Column widths fitted to the longest header word or formatted value.
 *  `filtered` leaves room for the filter button beside every label. */
function excelColWidths(section: ExportSection, filtered: boolean): number[] {
  const headerLen = (label: string) => Math.max(...label.split(/\s+/).map((w) => w.length), Math.min(label.length, 18))
  const widths = section.columns.map((c) => c.width ?? headerLen(c.label) + (filtered ? 5 : 2))
  // A KPI strip (label / value pairs side by side) must read in full too.
  // Titles, text and link rows never set a width: they run on across the row.
  for (const pr of [...(section.prelude ?? []), ...(section.postlude ?? [])]) {
    if (pr.kind !== 'kpi') continue
    pr.cells.forEach((cell, i) => {
      if (i >= section.columns.length || section.columns[i]?.width != null) return
      const { raw, format } = normCell(cell)
      // KPI values are written at 14 pt bold: allow half again the characters.
      const len = Math.ceil(cellText(raw, format).length * (i % 2 === 1 ? 1.6 : 1))
      if (len + 2 > (widths[i] ?? 0)) widths[i] = len + 2
    })
  }
  section.rows.forEach((row, ri) => {
    // A group label runs on across its row; it never sets a column's width.
    if (section.rowMeta?.[ri] === 'subhead') return
    row.forEach((cell, i) => {
      if (i >= section.columns.length || section.columns[i]?.width != null) return
      const { raw, format } = normCell(cell)
      const len = cellText(raw, format ?? section.columns[i]?.format).length
      if (len + 2 > (widths[i] ?? 0)) widths[i] = len + 2
    })
  })
  return widths.map((w, i) => (section.columns[i]?.width != null ? w : Math.min(TEXT_WIDTH_CAP, Math.max(8, w))))
}

/** How many leading columns a sheet freezes (see the layout contract). */
function frozenColumnCount(section: ExportSection, widths: number[]): number {
  const ncols = section.columns.length
  const total = widths.reduce((a, w) => a + w, 0)
  let want = section.freezeColumns ?? (total > ONE_SCREEN_WIDTH ? 1 : 0)
  want = Math.max(0, Math.min(want, ncols - 1))
  while (want > 0 && widths.slice(0, want).reduce((a, w) => a + w, 0) > MAX_FROZEN_WIDTH) want--
  return want
}

function fontFor(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: FONT, size: 11, ...extra }
}

const ISO_DATE_CELL = /^(\d{4})-(\d{2})-(\d{2})/
const isDateCell = (n: NormCell, fmt: NumFmt | undefined): boolean => fmt === 'date' && typeof n.raw === 'string' && ISO_DATE_CELL.test(n.raw)

/** Write one cell's value (formula / hyperlink / date / plain), as exceljs takes it.
 *  A blank is `null` — a cell with no value — never an empty string. */
function cellValueFor(n: NormCell, fmt: NumFmt | undefined, formulaText: string | null): unknown {
  if (formulaText != null) {
    const result = n.raw == null ? undefined : typeof n.raw === 'number' && fmt === 'cents' ? n.raw / 100 : n.raw
    return result === undefined ? { formula: formulaText } : { formula: formulaText, result }
  }
  if (isDateCell(n, fmt)) {
    const m = ISO_DATE_CELL.exec(n.raw as string)!
    // UTC midnight: exceljs converts by UTC, so the serial is the calendar day.
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  }
  // 'cents' carries ¢/lb-stored cotton prices displayed as $/lb: the REAL
  // number written to the sheet is the $ value (÷100) so the $ numFmt and
  // any user math read correctly.
  const value = typeof n.raw === 'number' ? (fmt === 'cents' ? n.raw / 100 : n.raw) : n.raw
  if (value == null || value === '') return null
  if (n.link) return { text: String(value), hyperlink: n.link }
  return value
}

/** The number format a numeric cell is written with. With no declared format
 *  a whole number shows whole — '#,##0.##' alone would print "88,320." */
function numFmtForCell(fmt: NumFmt | undefined, raw: string | number | null): string | undefined {
  if (fmt == null && typeof raw === 'number' && Number.isInteger(raw)) return '#,##0;(#,##0)'
  return excelNumFmt(fmt)
}

function styleCell(xcell: any, n: NormCell, fmt: NumFmt | undefined, zeroAsDash: boolean | undefined, align: 'left' | 'right' | undefined, wrap = false): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const label = fmt === 'text' || fmt === 'date' // a year, a date: an identifier, not a quantity
  const numeric = !label && (typeof n.raw === 'number' || (n.f != null && fmt != null))
  if (isDateCell(n, fmt)) {
    xcell.numFmt = 'm/d/yyyy'
    xcell.alignment = { horizontal: align === 'right' ? 'right' : 'left', vertical: 'top' }
  } else if (numeric) {
    const code = withZeroDash(numFmtForCell(fmt, n.raw), zeroAsDash)
    if (code) xcell.numFmt = code
    xcell.alignment = { horizontal: 'right', vertical: 'top' }
  } else {
    xcell.alignment = { horizontal: align === 'right' ? 'right' : 'left', vertical: 'top', wrapText: wrap }
  }
  if (n.tone && n.tone !== 'neutral') xcell.font = fontFor({ color: { argb: toneArgb(n.tone) } })
  else if (n.input) xcell.font = fontFor({ color: { argb: INPUT_FONT_ARGB } })
  else if (n.link) xcell.font = fontFor({ color: { argb: LINK_FONT_ARGB }, underline: true })
  else xcell.font = fontFor()
}

type FormulaCtx = { layout?: FormulaLayout; key?: string }

/** Rows outside the table — a section's prelude (above the header) or
 *  postlude (under the data): titles, context, KPIs, links. */
function writeExtraRows(ws: Ws, rows: PreludeRow[], section: ExportSection, zeroAsDash: boolean | undefined, fx: FormulaCtx): void {
  for (const pr of rows) {
    if (pr.kind === 'blank') { ws.addRow([]); continue }
    const cells = pr.cells.map(normCell)
    const values = cells.map((n, i) => {
      const fmt = n.format ?? section.columns[i]?.format
      let formulaText: string | null = null
      if (n.f) {
        if (!fx.layout || !fx.key) throw new Error('formula cells need a keyed section and a resolved layout')
        formulaText = toExcelFormula(n.f, { layout: fx.layout, at: { s: fx.key, r: -1 } })
      }
      return cellValueFor(n, fmt, formulaText)
    })
    const r = ws.addRow(values)
    cells.forEach((n, i) => {
      const xcell = r.getCell(i + 1)
      const fmt = n.format ?? section.columns[i]?.format
      styleCell(xcell, n, fmt, zeroAsDash, undefined)
      if (pr.kind === 'title') xcell.font = fontFor({ size: 14, bold: true, color: { argb: n.link ? LINK_FONT_ARGB : TITLE_ARGB } })
      else if (pr.kind === 'subtitle') xcell.font = fontFor({ size: 12, bold: true })
      else if (pr.kind === 'text') xcell.font = fontFor({ color: { argb: n.link ? LINK_FONT_ARGB : MUTED_ARGB }, underline: !!n.link })
      else if (pr.kind === 'kpi') xcell.font = i % 2 === 0 ? fontFor({ bold: true, color: { argb: MUTED_ARGB } }) : fontFor({ size: 14, bold: true, color: { argb: n.input ? INPUT_FONT_ARGB : TITLE_ARGB } })
      else if (pr.kind === 'links') xcell.font = i === 0 || n.link ? fontFor({ color: { argb: LINK_FONT_ARGB }, underline: !!n.link }) : fontFor({ color: { argb: MUTED_ARGB } })
      if (n.f && n.raw === 0) xcell.model.result = 0
    })
    if (pr.kind === 'title') r.height = 22
  }
}

/** The title block of a titled sheet: title, context line(s), a thin spacer. */
function writeTitleBlock(ws: Ws, title: string, context: string[]): void {
  ws.addRow([title])
  ws.lastRow.font = fontFor({ bold: true, size: 14, color: { argb: TITLE_ARGB } })
  ws.lastRow.height = 22
  for (const line of context) {
    ws.addRow([line])
    ws.lastRow.font = fontFor({ color: { argb: MUTED_ARGB }, size: 10 })
  }
  ws.addRow([])
  ws.lastRow.height = 6
}

type TableLayout = { groupRow: number | null; headerRow: number; firstDataRow: number; lastDataRow: number }

/** Write one table — spanning group row, header row, data rows — at the
 *  sheet's next row, with `widths` already decided (wrapping depends on them). */
function writeTable(ws: Ws, payload: ExportPayload, section: ExportSection, widths: number[], opts: { layout?: FormulaLayout; filtered: boolean; headless?: boolean }): TableLayout {
  const chrome = exportChrome(payload.branding)
  const zeroAsDash = payload.excel?.zeroAsDash
  const ncols = section.columns.length
  const numericCol = section.columns.map((_, i) => isNumericColumn(section, i))
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: chrome.excelHeaderArgb } }

  // Spanning group header row: Center Across Selection, never merged, so the
  // table below sorts and filters cleanly. The cells a label is centered
  // across must be EMPTY (no value at all) or the centering stops at them.
  let groupRow: number | null = null
  if (section.groups && section.groups.length > 0) {
    const vals: Array<string | null> = []
    for (const g of section.groups) { vals.push(g.label || null); for (let k = 1; k < g.span; k++) vals.push(null) }
    const gr = ws.addRow(vals)
    groupRow = gr.number
    let lines = 1
    let col = 1
    for (const g of section.groups) {
      const span = widths.slice(col - 1, col - 1 + g.span).reduce((a, w) => a + w, 0)
      if (g.span === 1) lines = Math.max(lines, wrappedLines(g.label, span - 1))
      for (let k = 0; k < g.span; k++) {
        const cell = gr.getCell(col + k)
        cell.font = fontFor({ bold: true, color: { argb: 'FFFFFFFF' } })
        cell.fill = headFill
        // A one-column group wraps instead of centering across (nothing to center across).
        cell.alignment = { horizontal: g.span > 1 ? 'centerContinuous' : 'center', vertical: 'middle', wrapText: g.span === 1 }
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } }
      }
      col += g.span
    }
    gr.height = Math.max(20, lines * LINE_PT + 4)
  }

  // Column header row: wrapped, as tall as its longest label needs. A numeric
  // column's label sits over its numbers; under a filter button it is nudged
  // clear of the button.
  // (A stacked table with no labels at all — a signature block — draws none.)
  const headerRow = opts.headless ? null : ws.addRow(section.columns.map((c) => c.label || null))
  const headerRowNumber: number = headerRow ? headerRow.number : (ws.lastRow?.number ?? 0)
  let headerLines = 1
  for (let i = 0; headerRow && i < ncols; i++) {
    const c = section.columns[i]
    const cell = headerRow.getCell(i + 1)
    const right = numericCol[i]
    cell.font = fontFor({ bold: true, color: { argb: 'FFFFFFFF' } })
    cell.fill = headFill
    cell.alignment = { horizontal: right ? 'right' : 'left', vertical: 'middle', wrapText: true, ...(right && opts.filtered ? { indent: 2 } : {}) }
    headerLines = Math.max(headerLines, wrappedLines(c.label, widths[i] - (opts.filtered ? 4 : 1)))
  }
  if (headerRow) headerRow.height = Math.max(22, headerLines * LINE_PT + 6)

  // Data rows.
  const firstDataRow = headerRowNumber + 1
  section.rows.forEach((row, ri) => {
    const kind: RowKind = section.rowMeta?.[ri] ?? 'data'
    if (kind === 'subhead') {
      const label = row.map(normCell).find((c) => c.raw != null && c.raw !== '')?.raw ?? ''
      const r = ws.addRow([String(label)])
      for (let c = 1; c <= ncols; c++) {
        const cell = r.getCell(c)
        cell.font = fontFor({ bold: true, color: { argb: 'FF334155' } })
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBHEAD_FILL_ARGB } }
      }
      return
    }
    const cells = section.columns.map((_, i) => normCell(row[i] ?? null))
    const values = cells.map((n, i) => {
      const fmt = n.format ?? section.columns[i]?.format
      let formulaText: string | null = null
      if (n.f) {
        if (!opts.layout || !section.key) throw new Error('formula cells need a keyed section and a resolved layout')
        formulaText = toExcelFormula(n.f, { layout: opts.layout, at: { s: section.key, r: ri } })
      }
      return cellValueFor(n, fmt, formulaText)
    })
    const r = ws.addRow(values)
    let lines = 1
    cells.forEach((n, i) => {
      const xcell = r.getCell(i + 1)
      const col = section.columns[i]
      const fmt = n.format ?? col?.format
      // Long text wraps inside its column and the row grows to hold it.
      const wraps = typeof n.raw === 'string' && n.f == null && col?.wrap !== false && !isDateCell(n, fmt) &&
        (n.raw.length > widths[i] - 1 || n.raw.includes('\n'))
      // Body text in Calibri runs about a tenth narrower than the digit a
      // column's width is measured in, so a line holds a little more than `width`.
      if (wraps) lines = Math.max(lines, wrappedLines(n.raw as string, widths[i] * 1.1))
      styleCell(xcell, n, fmt, zeroAsDash, col?.align, wraps)
      xcell.border = { bottom: { style: 'thin', color: { argb: RULE_ARGB } } }
      // exceljs drops a falsy cached result (0) when it copies the formula
      // value in; put it back on the live model so the file carries <v>0</v>
      // and a viewer that never recalculates shows 0, not blank.
      if (n.f && n.raw === 0) xcell.model.result = 0
    })
    if (lines > 1) r.height = lines * LINE_PT
    if (kind === 'total' || kind === 'subtotal') {
      for (let c = 1; c <= ncols; c++) {
        const cell = r.getCell(c)
        cell.font = { ...(cell.font ?? fontFor()), bold: true }
        if (kind === 'subtotal') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBTOTAL_FILL_ARGB } }
        else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL_ARGB } }
          cell.border = { top: { style: 'double', color: { argb: 'FF334155' } }, bottom: { style: 'thin', color: { argb: RULE_ARGB } } }
        }
      }
    }
  })
  const lastDataRow = headerRowNumber + Math.max(1, section.rows.length)

  if (ncols > 0 && section.rows.length > 0) {
    // Banding on plain data rows only — a conditional format would paint over
    // a subtotal's or a group label's own fill — in runs between them.
    if (section.banded !== false) {
      let runStart: number | null = null
      const flush = (endIdx: number) => {
        if (runStart == null) return
        ws.addConditionalFormatting({
          ref: `A${firstDataRow + runStart}:${columnLetters(ncols)}${firstDataRow + endIdx}`,
          rules: [{ type: 'expression', formulae: ['MOD(ROW(),2)=0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: BAND_ARGB } } }, priority: 2 }],
        })
        runStart = null
      }
      section.rows.forEach((_, ri) => {
        const plainRow = (section.rowMeta?.[ri] ?? 'data') === 'data'
        if (plainRow && runStart == null) runStart = ri
        if (!plainRow) flush(ri - 1)
      })
      flush(section.rows.length - 1)
    }
    section.columns.forEach((c, i) => {
      if (c.kind !== 'check') return
      const ref = `${columnLetters(i + 1)}${firstDataRow}:${columnLetters(i + 1)}${firstDataRow + section.rows.length - 1}`
      ws.addConditionalFormatting({
        ref,
        rules: [
          { type: 'cellIs', operator: 'equal', formulae: ['"OK"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: OK_FILL } }, font: { color: { argb: OK_FONT } } }, priority: 1 },
          { type: 'cellIs', operator: 'equal', formulae: ['"CHECK"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: CHECK_FILL } }, font: { color: { argb: CHECK_FONT }, bold: true } }, priority: 1 },
        ],
      })
    })
  }
  return { groupRow, headerRow: headerRowNumber, firstDataRow, lastDataRow }
}

/** Print-ready: fit to one page wide, repeat the header, footer with the page number. */
function setupPrint(ws: Ws, payload: ExportPayload, opts: { ncols: number; lastRow: number; totalWidth: number; titles: string | null; tabColor?: string }): void {
  const chrome = exportChrome(payload.branding)
  const footer = payload.excel?.footer ?? `${chrome.attributionPrefix} · ${payload.title} · generated ${new Date().toLocaleDateString()}`
  ws.pageSetup = {
    orientation: payload.orientation ?? (opts.totalWidth > PORTRAIT_WIDTH ? 'landscape' : 'portrait'),
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 1,
    margins: { left: 0.25, right: 0.25, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    printTitlesRow: opts.titles ?? undefined,
    printArea: opts.ncols > 0 ? `A1:${columnLetters(opts.ncols)}${opts.lastRow}` : undefined,
  }
  ws.headerFooter = { oddFooter: `&L&8${footer}&R&8page &P of &N` }
  if (opts.tabColor) ws.properties.tabColor = { argb: opts.tabColor }
}

/** One section on its own sheet: title block (or the section's prelude),
 *  table, postlude — then widths, freeze panes, filter and print setup. */
function writeExcelSection(ws: Ws, payload: ExportPayload, section: ExportSection, opts: { layout?: FormulaLayout; now: Date }): void {
  const chrome = exportChrome(payload.branding)
  const zeroAsDash = payload.excel?.zeroAsDash
  const ncols = section.columns.length
  const filtered = (section.autoFilter ?? !!section.plain) && ncols > 0 && section.rows.length > 0
  const widths = excelColWidths(section, filtered)
  const fx: FormulaCtx = { layout: opts.layout, key: section.key }

  if (section.plain) {
    writeExtraRows(ws, section.prelude ?? [], section, zeroAsDash, fx)
    if (section.note) {
      ws.addRow([section.note])
      ws.lastRow.font = fontFor({ italic: true, color: { argb: 'FF475569' } })
    }
    if ((section.prelude ?? []).length > 0 || section.note) { ws.addRow([]); ws.lastRow.height = 6 }
  } else {
    writeTitleBlock(ws, sheetTitleOf(payload, section), contextLines(payload, chrome, opts.now))
  }

  const t = writeTable(ws, payload, section, widths, { layout: opts.layout, filtered })
  const expected = headerRowOf(payload, section)
  if (t.headerRow !== expected) throw new Error(`export layout drift: header landed on row ${t.headerRow}, layout expected ${expected}`)

  let lastRow = t.lastDataRow
  if (section.postlude && section.postlude.length > 0) {
    ws.addRow([])
    writeExtraRows(ws, section.postlude, section, zeroAsDash, fx)
    lastRow = ws.lastRow.number
  }

  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w })

  // Freeze panes: the header (with its short title block) and the identifying
  // column(s) — see the layout contract. A header that sits too deep is a bug
  // in the report's builder (too much above the table): every test that
  // builds a workbook fails on it, and a customer's file is left unfrozen
  // rather than opening with the window swallowed.
  if (t.headerRow > MAX_FROZEN_ROWS && process.env.NODE_ENV === 'test') {
    throw new Error(`export layout: "${section.title ?? payload.title}" puts its header on row ${t.headerRow} — at most ${MAX_FROZEN_ROWS} rows may sit above the data (move KPIs, link lists and notes to the section's postlude)`)
  }
  const ySplit = t.headerRow <= MAX_FROZEN_ROWS ? t.headerRow : 0
  const xSplit = frozenColumnCount(section, widths)
  const firstCell = `${columnLetters(xSplit + 1)}${t.firstDataRow}`
  ws.views = xSplit > 0 || ySplit > 0
    ? [{ state: 'frozen', xSplit, ySplit, topLeftCell: `${columnLetters(xSplit + 1)}${ySplit + 1}`, activeCell: firstCell, showGridLines: false }]
    : [{ showGridLines: false, activeCell: firstCell }]
  if (filtered) ws.autoFilter = { from: { row: t.headerRow, column: 1 }, to: { row: t.lastDataRow, column: ncols } }

  setupPrint(ws, payload, {
    ncols, lastRow, totalWidth: widths.reduce((a, w) => a + w, 0),
    titles: `${t.groupRow ?? t.headerRow}:${t.headerRow}`, tabColor: section.tabColor,
  })
}

/** The headline cards as a Metric / Value table at the sheet's next row.
 *  Values are the display strings the screen shows. Returns the two widths. */
function writeSummaryCards(ws: Ws, cards: SummaryCard[], chrome: ExportChrome): [number, number] {
  const hr = ws.addRow(['Metric', 'Value'])
  hr.height = 22
  for (const col of [1, 2]) {
    const c = hr.getCell(col)
    c.font = fontFor({ bold: true, color: { argb: 'FFFFFFFF' } })
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: chrome.excelHeaderArgb } }
    c.alignment = { horizontal: col === 2 ? 'right' : 'left', vertical: 'middle' }
  }
  let labelWidth = 24
  let valueWidth = 14
  for (const card of cards) {
    const label = card.sub ? `${card.label} (${card.sub})` : card.label
    const r = ws.addRow([label, card.value || null])
    r.getCell(1).font = fontFor()
    r.getCell(2).font = fontFor({ bold: true, ...(card.tone && card.tone !== 'neutral' ? { color: { argb: toneArgb(card.tone) } } : {}) })
    r.getCell(2).alignment = { horizontal: 'right' }
    for (const c of [1, 2]) r.getCell(c).border = { bottom: { style: 'thin', color: { argb: RULE_ARGB } } }
    labelWidth = Math.max(labelWidth, label.length + 2)
    valueWidth = Math.max(valueWidth, String(card.value ?? '').length + 3)
  }
  return [Math.min(60, labelWidth), Math.min(40, valueWidth)]
}

/** Several tables stacked on one sheet (a ticket, a statement): one title
 *  block, each table under its own heading. Nothing is frozen — no single
 *  header row is true for the whole sheet — and every column is as wide as
 *  the widest table needs. */
function writeStackedSheet(ws: Ws, payload: ExportPayload, now: Date): void {
  const chrome = exportChrome(payload.branding)
  const zeroAsDash = payload.excel?.zeroAsDash
  const widths: number[] = []
  for (const section of payload.sections) {
    excelColWidths(section, false).forEach((w, i) => { widths[i] = Math.max(widths[i] ?? 0, w) })
  }
  writeTitleBlock(ws, payload.title, contextLines(payload, chrome, now))
  // A document's headline figures lead it, as on screen.
  if (payload.summary?.length) {
    const w = writeSummaryCards(ws, payload.summary, chrome)
    widths[0] = Math.max(widths[0] ?? 0, w[0])
    widths[1] = Math.max(widths[1] ?? 0, w[1])
    ws.addRow([])
  }
  payload.sections.forEach((section, i) => {
    if (i > 0) ws.addRow([])
    if (section.title) {
      ws.addRow([section.title])
      ws.lastRow.font = fontFor({ bold: true, size: 12 })
      ws.lastRow.height = 20
    }
    if (section.prelude) writeExtraRows(ws, section.prelude, section, zeroAsDash, {})
    if (section.note) {
      ws.addRow([section.note])
      ws.lastRow.font = fontFor({ italic: true, color: { argb: 'FF475569' } })
    }
    writeTable(ws, payload, section, widths.slice(0, section.columns.length), { filtered: false, headless: section.columns.every((c) => !c.label) })
    if (section.postlude && section.postlude.length > 0) writeExtraRows(ws, section.postlude, section, zeroAsDash, {})
  })
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w })
  ws.views = [{ showGridLines: false, activeCell: 'A1' }]
  setupPrint(ws, payload, { ncols: widths.length, lastRow: ws.lastRow.number, totalWidth: widths.reduce((a, w) => a + w, 0), titles: null })
}

/** Build the exceljs Workbook for a payload (exported so tests can inspect the
 *  sheets, formulas and cached results without a browser download). Formula
 *  cells are evaluated here if their cached result is still missing. */
export async function buildExcelWorkbook(payload: ExportPayload): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const mod = await import('exceljs')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS: any = (mod as any).default ?? mod
  const wb = new ExcelJS.Workbook()
  const chrome = exportChrome(payload.branding)
  const now = new Date()
  wb.creator = chrome.attributionPrefix
  wb.title = payload.excel?.title ?? payload.title
  wb.subject = payload.excel?.subject ?? payload.filters ?? payload.title
  wb.company = payload.excel?.company ?? chrome.attributionPrefix
  wb.created = now
  wb.modified = now

  // Excel sheet names must be ≤31 chars, exclude \ / ? * [ ] :, be non-empty, and
  // be UNIQUE within the workbook (case-insensitively) — exceljs throws
  // "Worksheet name already exists" otherwise. resolveSheetNames sanitizes each
  // requested name and disambiguates collisions with a " (2)" suffix, so a report
  // whose own section is titled "Summary" (which would collide with the auto
  // Summary sheet) or whose long section titles truncate to the same 31 chars
  // still exports. The same resolution feeds the formula layout, so a
  // cross-sheet reference always names the sheet that was actually written.
  const sheetNames = resolveSheetNames(payload)
  const hasFormulas = payloadHasFormulas(payload)
  const layout = hasFormulas ? formulaLayout(payload) : undefined
  if (hasFormulas) {
    // Cache every formula result (an idempotent pass — the audit builders
    // already evaluate; a payload built by hand gets its results here).
    evaluatePayload(payload)
    wb.calcProperties.fullCalcOnLoad = true
  }
  if (payload.fullCalcOnLoad) wb.calcProperties.fullCalcOnLoad = true

  // The headline cards the screen shows above its table go on a Summary sheet
  // of their own, first in the file — for every report that has cards, one
  // table or several — so the workbook reads in the screen's order and no
  // table carries a block of metrics frozen above it.
  if (!payload.singleSheet && payload.summary?.length) {
    const ws = wb.addWorksheet('Summary')
    writeTitleBlock(ws, payload.title, contextLines(payload, chrome, now))
    const w = writeSummaryCards(ws, payload.summary, chrome)
    ws.getColumn(1).width = w[0]
    ws.getColumn(2).width = w[1]
    ws.views = [{ showGridLines: false, activeCell: 'A1' }]
    setupPrint(ws, payload, { ncols: 2, lastRow: ws.lastRow.number, totalWidth: w[0] + w[1], titles: null })
  }

  if (payload.singleSheet && payload.sections.length > 1) {
    writeStackedSheet(wb.addWorksheet(sheetNames[0]), payload, now)
  } else {
    payload.sections.forEach((section, i) => {
      const ws = wb.addWorksheet(sheetNames[i])
      writeExcelSection(ws, payload, section, { layout, now })
    })
  }
  // The first sheet opens active.
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: 'visible' }]
  return wb
}

/** Excel flags ticket numbers, FSA numbers and per-row formulas with green
 *  corner triangles ("number stored as text", "inconsistent formula"). They
 *  are deliberate here, so each sheet tells Excel not to flag them. exceljs
 *  has no setting for it; the sheet XML is patched in the finished file. A
 *  real error value (#DIV/0!) is still flagged. Any failure returns the file
 *  untouched. */
async function quietErrorFlags(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const mod = await import('jszip')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const JSZip: any = (mod as any).default ?? mod
    const zip = await JSZip.loadAsync(bytes)
    for (const name of Object.keys(zip.files)) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue
      const xml: string = await zip.file(name).async('string')
      if (xml.includes('<ignoredErrors')) continue
      const dim = /<dimension ref="([^"]+)"/.exec(xml)?.[1]
      if (!dim) continue
      // Schema order: ignoredErrors follows the print settings and precedes drawings, tables and extensions.
      const at = xml.search(/<(?:smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)[\s>/]|<\/worksheet>/)
      if (at < 0) continue
      const node = `<ignoredErrors><ignoredError sqref="${dim}" numberStoredAsText="1" formula="1" formulaRange="1" unlockedFormula="1" emptyCellReference="1" twoDigitTextYear="1"/></ignoredErrors>`
      zip.file(name, xml.slice(0, at) + node + xml.slice(at))
    }
    return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  } catch {
    return bytes
  }
}

/** The finished .xlsx file for a payload, as bytes. */
export async function excelFileBytes(payload: ExportPayload): Promise<Uint8Array> {
  const wb = await buildExcelWorkbook(payload)
  const buf = await wb.xlsx.writeBuffer()
  return quietErrorFlags(new Uint8Array(buf as ArrayBuffer))
}

export async function exportToExcel(payload: ExportPayload): Promise<void> {
  const bytes = await excelFileBytes(payload)
  browserDownload(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${payload.filename || defaultFilename(payload.title)}.xlsx`)
}

// ---------- PDF (jsPDF + jspdf-autotable) ----------

// jsPDF's default fonts are Latin-1/WinAnsi and have no glyph for arrows or
// math symbols (e.g. "→" renders as tofu). Map the few we use to ASCII so PDF
// text stays legible. Em dash / middot / curly quotes ARE in WinAnsi, so they
// pass through unchanged.
export function pdfSafe(s: string): string {
  return s
    .replace(/[→➔➜➡⟶⭢]/g, '->') // → and friends
    .replace(/[←⟵]/g, '<-')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=')
    .replace(/≈/g, '~')
    .replace(/≠/g, '<>')
    .replace(/\u2212/g, '-') // a true minus sign
    .replace(/[\u2713\u2714]/g, 'Yes') // check marks
    .replace(/[\u2715\u2716\u2717\u2718]/g, '×') // crosses (× is in the font)
    .replace(/[\u2009\u200A\u202F\u00A0]/g, ' ') // thin / narrow / no-break spaces
}

// The header logo (Turnrow mark, or the org's own logo in org-branded mode)
// as a data URL (jsPDF addImage input). Browser-only; returns null on any
// failure so exports never block on it.
async function brandMarkDataUrl(url: string): Promise<string | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
      r.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/** Build the jsPDF document for a payload (exported so tests and the sample
 *  dump can write the file without a browser download). */
export async function buildPdfDocument(payload: ExportPayload): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [{ default: JsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const autoTable = (autoTableMod as { default: unknown }).default ?? autoTableMod
  const orientation = resolveOrientation(payload)
  const doc = new JsPDF({ orientation, unit: 'pt' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const stamp = generatedStamp(new Date())

  // Brand header: Turnrow chrome by default; `branding: 'org'` renders the
  // FARM'S identity instead — org logo + display name, NO Turnrow marks
  // (these can be documents the farm mails to a landowner or lender). Fetch
  // failure (offline, asset missing) silently falls back to text alone.
  const chrome = exportChrome(payload.branding)
  const mark = chrome.logoAssetUrl ? await brandMarkDataUrl(chrome.logoAssetUrl) : null
  if (mark) {
    try { doc.addImage(mark, 'PNG', 40, 22, 18, 18) } catch { /* wordmark-only */ }
  }
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...chrome.wordmarkColor)
  doc.text(pdfSafe(chrome.wordmark), mark ? 64 : 40, 34, chrome.wordmarkSpaced ? { charSpace: 2.5 } : undefined)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(0)

  doc.setFontSize(16)
  doc.text(pdfSafe(payload.title), 40, 58)
  doc.setFontSize(10)
  doc.setTextColor(110)
  doc.text(stamp, pageWidth - 40, 34, { align: 'right' })
  doc.setTextColor(0)

  let cursorY = 76
  for (const line of chrome.headerLines) {
    doc.setFontSize(9)
    doc.setTextColor(110)
    doc.text(pdfSafe(line), 40, cursorY)
    doc.setTextColor(0)
    cursorY += 12
  }
  if (payload.filters) {
    // A long filter line wraps inside the margins instead of running off the page.
    doc.setFontSize(10)
    doc.setTextColor(90)
    const lines = doc.splitTextToSize(pdfSafe(payload.filters), pageWidth - 80) as string[]
    doc.text(lines, 40, cursorY)
    doc.setTextColor(0)
    cursorY += 4 + 12 * lines.length
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const at = autoTable as any
  const TOP = 40 // top margin of every page after the first
  const BOTTOM = 40

  // Summary band: a compact Metric / Value table mirroring the cards.
  if (payload.summary?.length) {
    at(doc, {
      body: payload.summary.map((c) => [pdfSafe(c.sub ? `${c.label}  (${c.sub})` : c.label), pdfSafe(c.value)]),
      startY: cursorY + 4,
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 3 },
      columnStyles: { 0: { textColor: [100, 116, 139] }, 1: { halign: 'right', fontStyle: 'bold' } },
      margin: { left: 40, right: pageWidth / 2 },
      didParseCell: (data: any) => {
        const tone = payload.summary?.[data.row.index]?.tone
        if (data.column.index === 1 && tone && tone !== 'neutral') data.cell.styles.textColor = TONE_RGB[tone]
      },
    })
    cursorY = (doc as any).lastAutoTable?.finalY ?? cursorY
    cursorY += 14
  }

  for (const section of payload.sections) {
    const meta = section.rowMeta ?? []
    const cols = section.columns
    // A wide table gets smaller type before its text columns start wrapping.
    const fontSize = cols.length >= 16 ? 7 : cols.length >= 12 ? 8 : 9
    const hasSubheads = meta.some((k) => k === 'subhead')
    // A heading bar tells several tables apart; a report with one table needs none.
    const heading = payload.sections.length > 1 ? section.title : undefined
    doc.setFontSize(9)
    const noteLines = section.note ? (doc.splitTextToSize(pdfSafe(section.note), pageWidth - 80) as string[]) : []
    const titleH = (heading ? 30 : 0) + (noteLines.length > 0 ? 6 + 11 * noteLines.length : 0)

    // Resolved horizontal alignment per column (numeric → right).
    const colAlign = (i: number): 'left' | 'right' =>
      cols[i]?.align ?? (cols[i]?.format && cols[i].format !== 'text' && cols[i].format !== 'date' ? 'right' : 'left')

    // Head: optional spanning-group row above the column labels.
    const head: any[] = []
    if (section.groups && section.groups.length > 0) {
      head.push(section.groups.map((g) => ({
        content: pdfSafe(g.label),
        colSpan: g.span,
        styles: { halign: 'center' as const, fillColor: chrome.pdfHeadFill as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontStyle: 'bold' as const },
      })))
    }
    // A table with no column labels (a signature block) draws no header bar.
    const headless = cols.every((c) => !c.label) && head.length === 0
    head.push(cols.map((c) => pdfSafe(c.label)))

    // Body: format numbers; expand subhead rows to a full-width spanning cell.
    const body = section.rows.map((r, ri) => {
      if (meta[ri] === 'subhead') {
        const label = r.map(normCell).find((c) => c.raw != null && c.raw !== '')?.raw ?? ''
        return [{
          content: pdfSafe(String(label)),
          colSpan: cols.length,
          styles: { fontStyle: 'bold' as const, fillColor: [241, 245, 249] as [number, number, number], textColor: [51, 65, 85] as [number, number, number], halign: 'left' as const },
        }]
      }
      return cols.map((_, ci) => {
        const { raw, format, tone } = normCell(r[ci] ?? null)
        const text = pdfSafe(cellText(raw, format ?? cols[ci]?.format))
        const styles: Record<string, unknown> = {}
        if (tone && tone !== 'neutral') styles.textColor = TONE_RGB[tone]
        return Object.keys(styles).length ? { content: text, styles } : text
      })
    })

    // The table's options for rows [from, …) drawn at startY. `widths` pins the
    // column widths so a table drawn in several pieces lines up exactly.
    const optionsFor = (from: number, startY: number, widths?: number[]) => ({
      head,
      showHead: headless ? ('never' as const) : ('everyPage' as const),
      body: body.slice(from),
      startY,
      styles: { fontSize, cellPadding: fontSize >= 9 ? 4 : 3, overflow: 'linebreak' },
      headStyles: { fillColor: chrome.pdfHeadFill, textColor: [255, 255, 255] },
      columnStyles: Object.fromEntries(cols.map((_, idx) => [idx, { halign: colAlign(idx), ...(widths ? { cellWidth: widths[idx] } : {}) }])),
      margin: { left: 40, right: 40, top: TOP, bottom: BOTTOM },
      rowPageBreak: 'avoid', // don't split a row across pages
      didParseCell: (data: any) => {
        // Align column-label headers with their column (autotable's headStyles
        // otherwise left-aligns them, so headings sit left of right-aligned
        // numbers). Spanning cells (group headers) keep their own alignment.
        if (data.section === 'head' && data.cell.colSpan === 1) {
          data.cell.styles.halign = colAlign(data.column.index)
          return
        }
        if (data.section !== 'body') return
        const kind = meta[from + data.row.index]
        if (kind === 'total') {
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.fillColor = [226, 232, 240]
          data.cell.styles.lineWidth = { top: 0.9, right: 0, bottom: 0, left: 0 }
          data.cell.styles.lineColor = [51, 65, 85]
        } else if (kind === 'subtotal') {
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.fillColor = [232, 245, 233] // the light green the Excel subtotal rows carry
        }
      },
    })

    // Dry run on a scratch document: which page each row lands on, the column
    // widths the table settles on, and where it ends.
    const measure = (from: number, startY: number, widths?: number[]) => {
      const scratch = new JsPDF({ orientation, unit: 'pt' })
      const pageOfRow: number[] = []
      at(scratch, { ...optionsFor(from, startY, widths), didDrawCell: (data: any) => { if (data.section === 'body') pageOfRow[data.row.index] = data.pageNumber } })
      const t = (scratch as any).lastAutoTable
      return {
        pageOfRow,
        pages: Math.max(1, ...pageOfRow.filter((n) => Number.isFinite(n))),
        finalY: (t?.finalY as number | undefined) ?? startY,
        widths: ((t?.columns ?? []) as Array<{ width: number }>).map((c) => c.width),
      }
    }

    // Where the section starts. A table that fits on one page is never split
    // across two, and a heading is never left alone at the foot of a page.
    // (Measured only when it can matter: a short table, or one with group
    // labels to keep with their rows.)
    let widths: number[] | undefined
    const freshPage = cursorY <= TOP + 1
    if (body.length > 0 && (hasSubheads || body.length <= 60)) {
      const fresh = measure(0, TOP + titleH + 4)
      if (fresh.widths.length === cols.length) widths = fresh.widths
      const remaining = pageHeight - BOTTOM - cursorY
      const needed = fresh.pages === 1 ? titleH + 4 + (fresh.finalY - (TOP + titleH + 4)) : titleH + 110
      if (!freshPage && needed > remaining) { doc.addPage(); cursorY = TOP }
    } else if (!freshPage && cursorY > pageHeight - BOTTOM - (titleH + 110)) {
      doc.addPage(); cursorY = TOP
    }

    if (heading) {
      doc.setFillColor(241, 245, 249)
      doc.rect(40, cursorY + 2, pageWidth - 80, 22, 'F')
      doc.setFontSize(12)
      doc.setTextColor(15, 23, 42)
      doc.text(pdfSafe(heading), 48, cursorY + 17)
      doc.setTextColor(0)
      cursorY += 30
    }
    if (noteLines.length > 0) {
      // The one line of context a table carries (what its rows are).
      doc.setFontSize(9)
      doc.setFont('helvetica', 'italic')
      doc.setTextColor(71, 85, 105)
      doc.text(noteLines, 40, cursorY + 12)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(0)
      cursorY += 6 + 11 * noteLines.length
    }

    // Draw the table. A group label (subhead) that would be the last line on a
    // page is carried to the next page with its rows: the table is drawn up
    // to it, the page is turned, and the rest follows with the same widths.
    let from = 0
    for (let guard = 0; guard < 500; guard++) {
      let breakAt = -1
      if (hasSubheads) {
        const m = measure(from, cursorY + 4, widths)
        for (let i = 0; i + 1 < body.length - from; i++) {
          if (meta[from + i] === 'subhead' && m.pageOfRow[i + 1] > m.pageOfRow[i]) { breakAt = i; break }
        }
      }
      if (breakAt === 0 && cursorY > TOP + 1) { doc.addPage(); cursorY = TOP; continue }
      if (breakAt > 0) {
        at(doc, { ...optionsFor(from, cursorY + 4, widths), body: body.slice(from, from + breakAt) })
        doc.addPage()
        cursorY = TOP
        from += breakAt
        continue
      }
      at(doc, optionsFor(from, cursorY + 4, widths))
      cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY) + 20
      break
    }

    // The rows a section writes under its table (footnotes, what a figure
    // means, a KPI line) follow it here too, as small print.
    const under = (section.postlude ?? []).map((pr) => ({
      kind: pr.kind,
      text: pr.cells.map((c) => { const n = normCell(c); return cellText(n.raw, n.format) }).filter((t) => t !== '').join('   '),
    }))
    if (under.some((u) => u.text !== '')) {
      cursorY -= 10
      for (const u of under) {
        if (u.text === '') { cursorY += 5; continue }
        const strong = u.kind === 'subtitle' || u.kind === 'title'
        doc.setFontSize(strong ? 10 : 9)
        doc.setFont('helvetica', strong ? 'bold' : 'normal')
        const lines = doc.splitTextToSize(pdfSafe(u.text), pageWidth - 80) as string[]
        if (cursorY + 12 * lines.length > pageHeight - BOTTOM) { doc.addPage(); cursorY = TOP }
        if (strong) doc.setTextColor(15, 23, 42)
        else doc.setTextColor(100, 116, 139)
        doc.text(lines, 40, cursorY + 9)
        cursorY += 12 * lines.length + (strong ? 2 : 0)
      }
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(0)
      cursorY += 16
    }
  }

  // Footer on every page, now that the page count is known.
  const pageCount = (doc.internal as any).getNumberOfPages?.() ?? doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    doc.setFontSize(8)
    doc.setTextColor(140)
    doc.text(pdfSafe(payload.title), 40, pageHeight - 20)
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - 40, pageHeight - 20, { align: 'right' })
    doc.setTextColor(0)
  }

  return doc
}

/** The finished .pdf file for a payload, as bytes. */
export async function pdfFileBytes(payload: ExportPayload): Promise<Uint8Array> {
  const doc = await buildPdfDocument(payload)
  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer)
}

export async function exportToPdf(payload: ExportPayload): Promise<void> {
  const doc = await buildPdfDocument(payload)
  doc.save(`${payload.filename || defaultFilename(payload.title)}.pdf`)
}

// ---------- CSV ----------

// A plain spreadsheet file built from the SAME payload as Excel/PDF, so a
// report never keeps a bespoke CSV path beside its formatted exports. Numbers
// are written as plain numbers (no commas, no $ or %) rounded to the column's
// decimals so the file sorts and sums in any spreadsheet; strings are quoted
// when they need it. Subhead rows collapse to their label; every section
// after the first is separated by a blank line and its title.

function csvEscape(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Decimal places a NumFmt carries in a plain CSV cell. */
function csvDecimals(fmt?: NumFmt): number | null {
  switch (fmt) {
    case 'int': case 'bu': case 'lbs': case 'usd0': case 'pct0': return 0
    case 'dec1': case 'acres': case 'yield': case 'pct1': return 1
    case 'dec2': case 'usd2': case 'price': return 2
    case 'bu3': return 3
    case 'bu2': case 'acres2': return 2
    case 'factor': case 'ratio': return 4
    case 'cents': case 'price4': return 4
    default: return null // 'text' and inference pass the raw number through
  }
}

/** The CSV cell for a value: plain number text or the escaped string. */
export function csvCellText(raw: string | number | null, fmt?: NumFmt): string {
  if (raw == null) return ''
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return ''
    const value = fmt === 'cents' ? raw / 100 : raw
    const d = csvDecimals(fmt)
    return d == null ? String(value) : value.toFixed(d)
  }
  return csvEscape(String(raw))
}

/** Build the CSV text for a payload (exported for tests). */
export function buildCsv(payload: ExportPayload): string {
  const lines: string[] = []
  payload.sections.forEach((section, si) => {
    if (si > 0) lines.push('')
    if (section.title && payload.sections.length > 1) lines.push(csvEscape(section.title))
    lines.push(section.columns.map((c) => csvEscape(c.label)).join(','))
    section.rows.forEach((row, ri) => {
      const kind: RowKind = section.rowMeta?.[ri] ?? 'data'
      if (kind === 'subhead') {
        const label = row.map(normCell).find((c) => c.raw != null && c.raw !== '')?.raw ?? ''
        lines.push(csvEscape(String(label)))
        return
      }
      lines.push(row.map((cell, i) => {
        const { raw, format } = normCell(cell)
        return csvCellText(raw, format ?? section.columns[i]?.format)
      }).join(','))
    })
  })
  return lines.join('\r\n') + '\r\n'
}

export async function exportToCsv(payload: ExportPayload): Promise<void> {
  // The byte-order mark makes Excel open the file as UTF-8 (em dashes, ×).
  const text = '﻿' + buildCsv(payload)
  browserDownload(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${payload.filename || defaultFilename(payload.title)}.csv`)
}

// ---------- Print ----------

// Opens the browser print dialog. Print CSS in globals.css hides nav/sidebar/
// export buttons so only the report content renders.
export function printReport(): void {
  if (typeof window === 'undefined') return
  window.print()
}
