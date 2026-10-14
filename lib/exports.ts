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

import { exportChrome, type ExportBranding } from '@/lib/branding'
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
//   whole-dollar totals ......... 'usd0'  (revenue, cost, profit, indemnity, payments…)
//   trading P&L (with cents) .... 'usd2'  (hedging — matches its on-screen cents)
//   counts / weights (lb) ....... 'int'
//   moisture .................... 'dec1'
//   option premium (cents) ...... 'dec2'
//   percentages ................. 'pct0' / 'pct1'
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
  /** Excel: a note on the header cell explaining the column (and, for a
   *  formula column, the formula in words). */
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
  /** Excel: a plain data table — no title block; the header sits on row 1
   *  (row 2 under a `note`), frozen, with an autofilter over the data. */
  plain?: boolean
  /** Excel (plain sections): one explanatory line above the header. */
  note?: string
  /** Excel (plain sections): rows above the note/header — title block, KPIs, links. */
  prelude?: PreludeRow[]
  /** Excel: the sheet tab color (ARGB). */
  tabColor?: string
  /** Excel: how many leading columns stay frozen beside the header row (default 1). */
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
  if (fmt === 'text') return String(value)
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
  return payload.sections.some((s) => s.rows.some((r) => r.some(has)) || (s.prelude ?? []).some((p) => p.cells.some(has)))
}

/** Sanitize + de-duplicate worksheet names exactly as the Excel writer does
 *  (≤31 chars, no \ / ? * [ ] :, unique case-insensitively). */
function resolveSheetNames(payload: ExportPayload): string[] {
  const used = new Set<string>()
  const take = (desired: string, fallback: string): string => {
    const base = desired.replace(/[\\/?*[\]:]/g, '-').trim().slice(0, 31) || fallback
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`
      name = base.slice(0, 31 - suffix.length).trim() + suffix
    }
    used.add(name.toLowerCase())
    return name
  }
  const multi = !payload.singleSheet && payload.sections.length > 1
  if (multi && payload.summary?.length) take('Summary', 'Summary')
  if (payload.singleSheet) {
    const one = take(payload.title, 'Report')
    return payload.sections.map(() => one)
  }
  return payload.sections.map((section, i) => take(section.title || `Sheet ${i + 1}`, `Sheet ${i + 1}`))
}

/** The physical row the section's column header lands on, given how the
 *  writer lays a sheet out (title block for titled sheets, note/groups). */
function headerRowOf(payload: ExportPayload, section: ExportSection): number {
  let row = 0
  if (!section.plain) {
    const chrome = exportChrome(payload.branding)
    row += 1 + chrome.headerLines.length + (payload.filters ? 1 : 0) + 1 + 1 // title, chrome, filters, generated, blank
    if (section.title) row += 1
  } else {
    row += (section.prelude ?? []).length
    if (section.note) row += 1
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
    for (const pr of section.prelude ?? []) {
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
  return String(raw)
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
// DESIGN DEFAULTS (every export):
//   * one font family (Calibri 11; titles 16 bold; section heads 12 bold)
//   * header rows: forest fill, white bold wrapped text, ~30 high, an Excel
//     note per column when the column carries one
//   * thin light-gray horizontal rules only; subtotal rows light green + bold;
//     grand totals bold with a double top border
//   * banding through a conditional format (=MOD(ROW(),2)=0) so it survives
//     sorting and filtering; gridlines off on every sheet
//   * no merged cells inside a table — spanning group headers use Center
//     Across Selection — so sort and filter always work
//   * inputs blue, formulas black; check columns green on OK, red on CHECK
//   * column widths fitted to the longest header or value, capped; freeze the
//     header row (and the identifying columns a section names)
//   * print-ready: landscape, fit to one page wide, header rows repeated,
//     narrow margins, print area, a footer with the page number
//   * document properties (title / subject / company / created); the first
//     sheet opens active at A1
// Report-specific layout (title blocks, KPI strips, contents links, sort
// orders) is expressed through a section's `prelude` rows and stays in the
// report's own builder.

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

/** Column widths fitted to the longest header line or formatted value. */
function excelColWidths(section: ExportSection): number[] {
  const headerLen = (label: string) => Math.max(...label.split(/\s+/).map((w) => w.length), Math.min(label.length, 18))
  const widths = section.columns.map((c) => c.width ?? headerLen(c.label) + 2)
  // KPI labels and link rows above the header must read in full too.
  for (const pr of section.prelude ?? []) {
    if (pr.kind !== 'kpi' && pr.kind !== 'links') continue
    pr.cells.forEach((cell, i) => {
      if (section.columns[i]?.width != null) return
      const { raw, format } = normCell(cell)
      // KPI values are written at 14 pt bold: allow half again the characters.
      const len = Math.ceil(cellText(raw, format).length * (pr.kind === 'kpi' && i % 2 === 1 ? 1.6 : 1))
      if (len + 2 > (widths[i] ?? 0)) widths[i] = len + 2
    })
  }
  for (const row of section.rows) {
    row.forEach((cell, i) => {
      if (section.columns[i]?.width != null) return
      const { raw, format } = normCell(cell)
      const len = cellText(raw, format ?? section.columns[i]?.format).length
      if (len + 2 > (widths[i] ?? 0)) widths[i] = len + 2
    })
  }
  return widths.map((w) => Math.min(60, Math.max(8, w)))
}

function fontFor(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: FONT, size: 11, ...extra }
}

/** Write one cell's value (formula / hyperlink / plain), returning what exceljs got. */
function cellValueFor(n: NormCell, fmt: NumFmt | undefined, formulaText: string | null): unknown {
  if (formulaText != null) {
    const result = n.raw == null ? undefined : typeof n.raw === 'number' && fmt === 'cents' ? n.raw / 100 : n.raw
    return result === undefined ? { formula: formulaText } : { formula: formulaText, result }
  }
  // 'cents' carries ¢/lb-stored cotton prices displayed as $/lb: the REAL
  // number written to the sheet is the $ value (÷100) so the $ numFmt and
  // any user math read correctly.
  const value = typeof n.raw === 'number' ? (fmt === 'cents' ? n.raw / 100 : n.raw) : (n.raw ?? '')
  if (n.link) return { text: String(value), hyperlink: n.link }
  return value
}

function styleCell(xcell: any, n: NormCell, fmt: NumFmt | undefined, zeroAsDash: boolean | undefined, align: 'left' | 'right' | undefined): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const numeric = typeof n.raw === 'number' || (n.f != null && fmt != null && fmt !== 'text')
  if (numeric) {
    xcell.numFmt = withZeroDash(excelNumFmt(fmt), zeroAsDash)!
    xcell.alignment = { horizontal: 'right', vertical: 'top' }
  } else {
    xcell.alignment = { horizontal: align === 'right' ? 'right' : 'left', vertical: 'top' }
  }
  if (n.tone && n.tone !== 'neutral') xcell.font = fontFor({ color: { argb: toneArgb(n.tone) } })
  else if (n.input) xcell.font = fontFor({ color: { argb: INPUT_FONT_ARGB } })
  else if (n.link) xcell.font = fontFor({ color: { argb: LINK_FONT_ARGB }, underline: true })
  else xcell.font = fontFor()
}

function writeExcelSection(ws: Ws, payload: ExportPayload, section: ExportSection, opts: { withTitle: boolean; layout?: FormulaLayout }): void {
  const chrome = exportChrome(payload.branding)
  const zeroAsDash = payload.excel?.zeroAsDash
  const expectedHeaderRow = opts.withTitle || section.plain ? headerRowOf(payload, section) : null
  const ncols = section.columns.length
  const formulaCtxAt = (r: number) => ({ layout: opts.layout!, at: { s: section.key!, r } })
  const requireLayout = () => {
    if (!opts.layout || !section.key) throw new Error('formula cells need a keyed section and a resolved layout')
  }

  if (section.plain) {
    // Report-specific title block / KPI strip / contents links.
    for (const pr of section.prelude ?? []) {
      if (pr.kind === 'blank') { ws.addRow([]); continue }
      const cells = pr.cells.map(normCell)
      const values = cells.map((n, i) => {
        const fmt = n.format ?? section.columns[i]?.format
        let formulaText: string | null = null
        if (n.f) { requireLayout(); formulaText = toExcelFormula(n.f, formulaCtxAt(-1)) }
        return cellValueFor(n, fmt, formulaText)
      })
      const r = ws.addRow(values)
      cells.forEach((n, i) => {
        const xcell = r.getCell(i + 1)
        const fmt = n.format ?? section.columns[i]?.format
        styleCell(xcell, n, fmt, zeroAsDash, undefined)
        if (pr.kind === 'title') xcell.font = fontFor({ size: 16, bold: true, color: { argb: n.link ? LINK_FONT_ARGB : 'FF0B4A24' } })
        else if (pr.kind === 'subtitle') xcell.font = fontFor({ size: 12, bold: true })
        else if (pr.kind === 'text') xcell.font = fontFor({ color: { argb: n.link ? LINK_FONT_ARGB : MUTED_ARGB }, underline: !!n.link })
        else if (pr.kind === 'kpi') xcell.font = i % 2 === 0 ? fontFor({ bold: true, color: { argb: MUTED_ARGB } }) : fontFor({ size: 14, bold: true, color: { argb: n.input ? INPUT_FONT_ARGB : 'FF0B4A24' } })
        else if (pr.kind === 'links') xcell.font = fontFor({ color: { argb: LINK_FONT_ARGB }, underline: true })
        if (n.f && n.raw === 0) xcell.model.result = 0
      })
      if (pr.kind === 'title') r.height = 24
    }
    if (section.note) {
      ws.addRow([section.note])
      ws.lastRow.font = fontFor({ italic: true, color: { argb: 'FF475569' } })
    }
  } else if (opts.withTitle) {
    ws.addRow([payload.title])
    ws.lastRow.font = fontFor({ bold: true, size: 16, color: { argb: 'FF0B4A24' } })
    for (const line of chrome.headerLines) {
      ws.addRow([line]); ws.lastRow.font = fontFor({ color: { argb: MUTED_ARGB }, size: 10 })
    }
    if (payload.filters) { ws.addRow([payload.filters]); ws.lastRow.font = fontFor({ color: { argb: MUTED_ARGB } }) }
    ws.addRow([`${chrome.attributionPrefix} · Generated ${new Date().toLocaleString()}`])
    ws.lastRow.font = fontFor({ color: { argb: 'FF94A3B8' }, size: 9 })
    ws.addRow([])
  }
  if (section.title && !section.plain) {
    ws.addRow([section.title])
    ws.lastRow.font = fontFor({ bold: true, size: 12 })
  }

  // Spanning group header row: Center Across Selection, never merged, so the
  // table below sorts and filters cleanly.
  if (section.groups && section.groups.length > 0) {
    const groupRowVals: string[] = []
    for (const g of section.groups) { groupRowVals.push(g.label); for (let k = 1; k < g.span; k++) groupRowVals.push('') }
    const gr = ws.addRow(groupRowVals)
    // Two lines normally; three when a one-column group has to wrap a long label.
    gr.height = section.groups.some((g) => g.span === 1 && g.label.length > 14) ? 45 : 32
    let col = 1
    for (const g of section.groups) {
      for (let k = 0; k < g.span; k++) {
        const cell = gr.getCell(col + k)
        cell.font = fontFor({ bold: true, color: { argb: 'FFFFFFFF' } })
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: chrome.excelHeaderArgb } }
        // A one-column group wraps instead of centering across (nothing to center across).
        cell.alignment = { horizontal: g.span > 1 ? 'centerContinuous' : 'center', vertical: 'middle', wrapText: g.span === 1 }
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } }
      }
      col += g.span
    }
  }

  // Column header row: wrapped, tall, with a note per column when given.
  const headerRow = ws.addRow(section.columns.map((c) => c.label))
  const headerRowNumber = headerRow.number
  if (expectedHeaderRow != null && headerRowNumber !== expectedHeaderRow) {
    throw new Error(`export layout drift: header landed on row ${headerRowNumber}, layout expected ${expectedHeaderRow}`)
  }
  headerRow.height = 30
  headerRow.eachCell((cell: any, col: number) => {
    const c = section.columns[col - 1]
    cell.font = fontFor({ bold: true, color: { argb: 'FFFFFFFF' } })
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: chrome.excelHeaderArgb } }
    cell.alignment = { horizontal: c?.align === 'right' ? 'right' : 'left', vertical: 'middle', wrapText: true }
    if (c?.note) cell.note = c.note
  })

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
    const values = row.map((cell, i) => {
      const n = normCell(cell)
      const fmt = n.format ?? section.columns[i]?.format
      let formulaText: string | null = null
      if (n.f) { requireLayout(); formulaText = toExcelFormula(n.f, formulaCtxAt(ri)) }
      return cellValueFor(n, fmt, formulaText)
    })
    const r = ws.addRow(values)
    row.forEach((cell, i) => {
      const n = normCell(cell)
      const xcell = r.getCell(i + 1)
      const fmt = n.format ?? section.columns[i]?.format
      styleCell(xcell, n, fmt, zeroAsDash, section.columns[i]?.align)
      xcell.border = { bottom: { style: 'thin', color: { argb: RULE_ARGB } } }
      // exceljs drops a falsy cached result (0) when it copies the formula
      // value in; put it back on the live model so the file carries <v>0</v>
      // and a viewer that never recalculates shows 0, not blank.
      if (n.f && n.raw === 0) xcell.model.result = 0
    })
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

  // Widths, freeze, gridlines, autofilter, banding and check formats.
  excelColWidths(section).forEach((w, i) => { ws.getColumn(i + 1).width = w })
  ws.views = [{ state: 'frozen', xSplit: section.freezeColumns ?? 1, ySplit: headerRowNumber, showGridLines: false, activeCell: 'A1' }]
  if (section.plain && ncols > 0) {
    ws.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: lastDataRow, column: ncols } }
  }
  if (ncols > 0 && section.rows.length > 0) {
    const dataRef = `A${firstDataRow}:${columnLetters(ncols)}${firstDataRow + section.rows.length - 1}`
    ws.addConditionalFormatting({
      ref: dataRef,
      rules: [{ type: 'expression', formulae: ['MOD(ROW(),2)=0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: BAND_ARGB } } }, priority: 2 }],
    })
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

  // Print-ready.
  const generated = new Date()
  const footer = payload.excel?.footer ?? `${chrome.attributionPrefix} · ${payload.title} · generated ${generated.toLocaleDateString()}`
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 1,
    margins: { left: 0.25, right: 0.25, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    printTitlesRow: `${headerRowNumber}:${headerRowNumber}`,
    printArea: ncols > 0 ? `A1:${columnLetters(ncols)}${lastDataRow}` : undefined,
  }
  ws.headerFooter = { oddFooter: `&L&8${footer}&R&8page &P of &N` }
  if (section.tabColor) ws.properties.tabColor = { argb: section.tabColor }
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
  wb.creator = chrome.attributionPrefix
  wb.title = payload.excel?.title ?? payload.title
  wb.subject = payload.excel?.subject ?? payload.filters ?? payload.title
  wb.company = payload.excel?.company ?? chrome.attributionPrefix
  wb.created = new Date()
  wb.modified = wb.created

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

  // Multi-section reports: a Summary sheet first (title/filters/cards), then one
  // sheet per section — matching how the report is organized on screen. Filters
  // already render atop every section sheet, so only summary CARDS justify a
  // dedicated cover sheet (a report may also define its own "Summary" section).
  const multi = !payload.singleSheet && payload.sections.length > 1
  if (multi && payload.summary?.length) {
    const ws = wb.addWorksheet('Summary')
    ws.addRow([payload.title]); ws.lastRow.font = fontFor({ bold: true, size: 16, color: { argb: 'FF0B4A24' } })
    for (const line of chrome.headerLines) { ws.addRow([line]); ws.lastRow.font = fontFor({ color: { argb: MUTED_ARGB }, size: 10 }) }
    if (payload.filters) { ws.addRow([payload.filters]); ws.lastRow.font = fontFor({ color: { argb: MUTED_ARGB } }) }
    ws.addRow([`${chrome.attributionPrefix} · Generated ${new Date().toLocaleString()}`]); ws.lastRow.font = fontFor({ color: { argb: 'FF94A3B8' }, size: 9 })
    ws.addRow([])
    if (payload.summary?.length) {
      const hr = ws.addRow(['Metric', 'Value'])
      hr.eachCell((c: any) => { c.font = fontFor({ bold: true, color: { argb: 'FFFFFFFF' } }); c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: chrome.excelHeaderArgb } } })
      for (const card of payload.summary) {
        const r = ws.addRow([card.sub ? `${card.label} (${card.sub})` : card.label, card.value])
        r.getCell(1).font = fontFor()
        r.getCell(2).font = fontFor(card.tone && card.tone !== 'neutral' ? { color: { argb: toneArgb(card.tone) } } : {})
        r.getCell(2).alignment = { horizontal: 'right' }
      }
      ws.getColumn(1).width = 32
      ws.getColumn(2).width = 22
    }
    ws.views = [{ showGridLines: false }]
  }

  if (payload.singleSheet) {
    const ws = wb.addWorksheet(sheetNames[0])
    payload.sections.forEach((section, i) => {
      if (i > 0) ws.addRow([])
      writeExcelSection(ws, payload, section, { withTitle: i === 0 })
    })
    // singleSheet: freeze only the very first header row is awkward across stacked
    // sections, so leave the per-section freeze from writeExcelSection (last wins).
  } else {
    payload.sections.forEach((section, i) => {
      const ws = wb.addWorksheet(sheetNames[i])
      writeExcelSection(ws, payload, section, { withTitle: true, layout })
    })
  }
  // The first sheet opens active, at A1.
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: 'visible' }]
  return wb
}

export async function exportToExcel(payload: ExportPayload): Promise<void> {
  const wb = await buildExcelWorkbook(payload)
  const buf = await wb.xlsx.writeBuffer()
  browserDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${payload.filename || defaultFilename(payload.title)}.xlsx`)
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

export async function exportToPdf(payload: ExportPayload): Promise<void> {
  const [{ default: JsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const autoTable = (autoTableMod as { default: unknown }).default ?? autoTableMod
  const orientation = resolveOrientation(payload)
  const doc = new JsPDF({ orientation, unit: 'pt' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const today = new Date().toLocaleString()

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
  doc.text(`Generated ${today}`, pageWidth - 40, 34, { align: 'right' })
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
    doc.setFontSize(10)
    doc.setTextColor(90)
    doc.text(pdfSafe(payload.filters), 40, cursorY)
    doc.setTextColor(0)
    cursorY += 16
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const at = autoTable as any

  // Summary band: a compact Metric / Value table mirroring the cards.
  if (payload.summary?.length) {
    at(doc, {
      body: payload.summary.map((c) => [pdfSafe(c.sub ? `${c.label}  (${c.sub})` : c.label), pdfSafe(c.value)]),
      startY: cursorY + 4,
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 3 },
      columnStyles: { 0: { textColor: [100, 116, 139] }, 1: { halign: 'right', fontStyle: 'bold' } },
      margin: { left: 40, right: pageWidth / 2 },
    })
    cursorY = (doc as any).lastAutoTable?.finalY ?? cursorY
    cursorY += 14
  }

  for (const section of payload.sections) {
    const meta = section.rowMeta ?? []
    const cols = section.columns

    if (section.title) {
      if (cursorY > pageHeight - 90) { doc.addPage(); cursorY = 40 }
      doc.setFillColor(241, 245, 249)
      doc.rect(40, cursorY + 2, pageWidth - 80, 22, 'F')
      doc.setFontSize(12)
      doc.setTextColor(15, 23, 42)
      doc.text(section.title, 48, cursorY + 17)
      doc.setTextColor(0)
      cursorY += 30
    }

    // Resolved horizontal alignment per column (numeric → right).
    const colAlign = (i: number): 'left' | 'right' =>
      cols[i]?.align ?? (cols[i]?.format && cols[i].format !== 'text' ? 'right' : 'left')

    // Head: optional spanning-group row above the column labels.
    const head: any[] = []
    if (section.groups && section.groups.length > 0) {
      head.push(section.groups.map((g) => ({
        content: pdfSafe(g.label),
        colSpan: g.span,
        styles: { halign: 'center' as const, fillColor: chrome.pdfHeadFill as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontStyle: 'bold' as const },
      })))
    }
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
      return r.map((cell, ci) => {
        const { raw, format, tone } = normCell(cell)
        const text = pdfSafe(cellText(raw, format ?? cols[ci]?.format))
        const styles: Record<string, unknown> = {}
        if (tone && tone !== 'neutral') styles.textColor = TONE_RGB[tone]
        return Object.keys(styles).length ? { content: text, styles } : text
      })
    })

    at(doc, {
      head,
      body,
      startY: cursorY + 4,
      styles: { fontSize: 9, cellPadding: 4, overflow: 'linebreak' },
      headStyles: { fillColor: chrome.pdfHeadFill, textColor: [255, 255, 255] },
      columnStyles: Object.fromEntries(cols.map((c, idx) => [idx, { halign: c.align ?? (c.format && c.format !== 'text' ? 'right' : 'left') }])),
      margin: { left: 40, right: 40 },
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
        const kind = meta[data.row.index]
        if (kind === 'total') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [226, 232, 240] }
        else if (kind === 'subtotal') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [248, 250, 252] }
      },
      didDrawPage: () => {
        const n = (doc.internal as any).getNumberOfPages?.() ?? doc.getNumberOfPages()
        doc.setFontSize(8)
        doc.setTextColor(140)
        doc.text(pdfSafe(payload.title), 40, pageHeight - 20)
        doc.text(`Page ${n}`, pageWidth - 40, pageHeight - 20, { align: 'right' })
        doc.setTextColor(0)
      },
    })
    cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY) + 20
  }

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
    case 'cents': return 4
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
