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
  | 'lbs' // 412,000 lbs (0 decimals, commas)
  | 'acres' // 1,250.0 (1 decimal)
  | 'yield' // 182.5 bu/ac (1 decimal)
  | 'pct0' // 86%
  | 'pct1' // 86.5%

export type Tone = 'favorable' | 'unfavorable' | 'warning' | 'muted' | 'neutral'

export type ExportColumn = {
  /** Column header text. */
  label: string
  align?: 'left' | 'right'
  /** How numeric cells in this column format (PDF string + Excel numFmt). When
   *  omitted, numbers are inferred (thousands separators, up to 2 decimals). */
  format?: NumFmt
  /** Excel column width override, in characters. */
  width?: number
}

/** A cell is a bare value, or a value plus per-cell format/tone overrides. */
export type ExportCell =
  | string
  | number
  | null
  | { v: string | number | null; format?: NumFmt; tone?: Tone }

/** Visual role of a row.
 *  'data'     — normal row.
 *  'subhead'  — a group label spanning the whole table (first non-empty cell shown).
 *  'subtotal' — a light, semibold group subtotal.
 *  'total'    — an emphasized grand-total row. */
export type RowKind = 'data' | 'subhead' | 'subtotal' | 'total'

export type ExportSection = {
  /** Section label — a heading bar in the PDF and the sheet name in Excel. */
  title?: string
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
  /** PDF orientation; defaults to landscape for wide tables, portrait otherwise. */
  orientation?: 'portrait' | 'landscape'
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
    case 'usd0': return '$#,##0;($#,##0)'
    case 'usd2':
    case 'price': return '$#,##0.00;($#,##0.00)'
    case 'cents': return '$#,##0.0000;($#,##0.0000)'
    case 'pct0': return '#,##0"%";(#,##0"%")'
    case 'pct1': return '#,##0.0"%";(#,##0.0"%")'
    default: return '#,##0.##;(#,##0.##)' // inference
  }
}

type NormCell = { raw: string | number | null; format?: NumFmt; tone?: Tone }
function normCell(cell: ExportCell): NormCell {
  if (cell != null && typeof cell === 'object') return { raw: cell.v, format: cell.format, tone: cell.tone }
  return { raw: cell }
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

const HEADER_FILL_ARGB = 'FF166534' // green-800 (matches nav / PDF head)
const SUBHEAD_FILL_ARGB = 'FFF1F5F9' // slate-100
const SUBTOTAL_FILL_ARGB = 'FFF8FAFC' // slate-50
const TOTAL_FILL_ARGB = 'FFE2E8F0' // slate-200

// ---------- Excel (exceljs — real numbers, number formats, styling) ----------

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

function excelColWidths(section: ExportSection): number[] {
  const widths = section.columns.map((c) => c.width ?? c.label.length + 2)
  for (const row of section.rows) {
    row.forEach((cell, i) => {
      if (section.columns[i]?.width != null) return
      const { raw, format } = normCell(cell)
      const len = cellText(raw, format ?? section.columns[i]?.format).length
      if (len + 2 > (widths[i] ?? 0)) widths[i] = len + 2
    })
  }
  return widths.map((w) => Math.min(48, Math.max(10, w)))
}

function writeExcelSection(ws: Ws, payload: ExportPayload, section: ExportSection, opts: { withTitle: boolean }): void {
  if (opts.withTitle) {
    ws.addRow([payload.title])
    ws.lastRow.font = { bold: true, size: 14 }
    if (payload.filters) { ws.addRow([payload.filters]); ws.lastRow.font = { color: { argb: 'FF64748B' } } }
    ws.addRow([`Turnrow · Generated ${new Date().toLocaleString()}`])
    ws.lastRow.font = { color: { argb: 'FF94A3B8' }, size: 9 }
    ws.addRow([])
  }
  if (section.title) {
    ws.addRow([section.title])
    ws.lastRow.font = { bold: true, size: 12 }
  }

  const ncols = section.columns.length

  // Spanning group header row (merged per group).
  if (section.groups && section.groups.length > 0) {
    const groupRowVals: string[] = []
    for (const g of section.groups) { groupRowVals.push(g.label); for (let k = 1; k < g.span; k++) groupRowVals.push('') }
    const gr = ws.addRow(groupRowVals)
    let col = 1
    for (const g of section.groups) {
      if (g.span > 1) ws.mergeCells(gr.number, col, gr.number, col + g.span - 1)
      const cell = gr.getCell(col)
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } }
      cell.alignment = { horizontal: 'center' }
      col += g.span
    }
  }

  // Column header row.
  const headerRow = ws.addRow(section.columns.map((c) => c.label))
  const headerRowNumber = headerRow.number
  headerRow.eachCell((cell: any, col: number) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } }
    cell.alignment = { horizontal: section.columns[col - 1]?.align === 'right' ? 'right' : 'left' }
  })

  // Data rows.
  section.rows.forEach((row, ri) => {
    const kind: RowKind = section.rowMeta?.[ri] ?? 'data'
    if (kind === 'subhead') {
      const label = row.map(normCell).find((c) => c.raw != null && c.raw !== '')?.raw ?? ''
      const r = ws.addRow([String(label)])
      ws.mergeCells(r.number, 1, r.number, ncols)
      const cell = r.getCell(1)
      cell.font = { bold: true, color: { argb: 'FF334155' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBHEAD_FILL_ARGB } }
      return
    }
    const values = row.map((cell, i) => {
      const { raw, format } = normCell(cell)
      const fmt = format ?? section.columns[i]?.format
      // 'cents' carries ¢/lb-stored cotton prices displayed as $/lb: the REAL
      // number written to the sheet is the $ value (÷100) so the $ numFmt and
      // any user math read correctly.
      if (typeof raw === 'number') return fmt === 'cents' ? raw / 100 : raw
      return raw ?? ''
    })
    const r = ws.addRow(values)
    row.forEach((cell, i) => {
      const { raw, format, tone } = normCell(cell)
      const xcell = r.getCell(i + 1)
      const fmt = format ?? section.columns[i]?.format
      if (typeof raw === 'number') {
        xcell.numFmt = excelNumFmt(fmt)!
        xcell.alignment = { horizontal: 'right' }
      } else if (section.columns[i]?.align === 'right') {
        xcell.alignment = { horizontal: 'right' }
      }
      if (tone && tone !== 'neutral') xcell.font = { color: { argb: toneArgb(tone) } }
    })
    if (kind === 'total' || kind === 'subtotal') {
      const fill = kind === 'total' ? TOTAL_FILL_ARGB : SUBTOTAL_FILL_ARGB
      r.eachCell((c: any) => {
        c.font = { ...(c.font ?? {}), bold: true }
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
        if (kind === 'total') c.border = { top: { style: 'thin', color: { argb: 'FF94A3B8' } } }
      })
    }
  })

  // Column widths + freeze the header row (and the first/label column).
  excelColWidths(section).forEach((w, i) => { ws.getColumn(i + 1).width = w })
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: headerRowNumber }]
}

export async function exportToExcel(payload: ExportPayload): Promise<void> {
  const mod = await import('exceljs')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS: any = (mod as any).default ?? mod
  const wb = new ExcelJS.Workbook()

  // Excel sheet names must be ≤31 chars, exclude \ / ? * [ ] :, be non-empty, and
  // be UNIQUE within the workbook (case-insensitively) — exceljs throws
  // "Worksheet name already exists" otherwise. addSheet sanitizes each requested
  // name and disambiguates collisions with a " (2)" suffix, so a report whose own
  // section is titled "Summary" (which would collide with the auto Summary sheet)
  // or whose long section titles truncate to the same 31 chars still exports.
  const usedSheetNames = new Set<string>()
  const addSheet = (desired: string, fallback: string): Ws => {
    const base = desired.replace(/[\\/?*[\]:]/g, '-').trim().slice(0, 31) || fallback
    let name = base
    for (let n = 2; usedSheetNames.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`
      name = base.slice(0, 31 - suffix.length).trim() + suffix
    }
    usedSheetNames.add(name.toLowerCase())
    return wb.addWorksheet(name)
  }

  // Multi-section reports: a Summary sheet first (title/filters/cards), then one
  // sheet per section — matching how the report is organized on screen. Filters
  // already render atop every section sheet, so only summary CARDS justify a
  // dedicated cover sheet (a report may also define its own "Summary" section).
  const multi = !payload.singleSheet && payload.sections.length > 1
  if (multi && payload.summary?.length) {
    const ws = addSheet('Summary', 'Summary')
    ws.addRow([payload.title]); ws.lastRow.font = { bold: true, size: 14 }
    if (payload.filters) { ws.addRow([payload.filters]); ws.lastRow.font = { color: { argb: 'FF64748B' } } }
    ws.addRow([`Turnrow · Generated ${new Date().toLocaleString()}`]); ws.lastRow.font = { color: { argb: 'FF94A3B8' }, size: 9 }
    ws.addRow([])
    if (payload.summary?.length) {
      const hr = ws.addRow(['Metric', 'Value'])
      hr.eachCell((c: any) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } } })
      for (const card of payload.summary) {
        const r = ws.addRow([card.sub ? `${card.label} (${card.sub})` : card.label, card.value])
        r.getCell(2).alignment = { horizontal: 'right' }
        if (card.tone && card.tone !== 'neutral') r.getCell(2).font = { color: { argb: toneArgb(card.tone) } }
      }
      ws.getColumn(1).width = 32
      ws.getColumn(2).width = 22
    }
  }

  if (payload.singleSheet) {
    const ws = addSheet(payload.title, 'Report')
    payload.sections.forEach((section, i) => {
      if (i > 0) ws.addRow([])
      writeExcelSection(ws, payload, section, { withTitle: i === 0 })
    })
    // singleSheet: freeze only the very first header row is awkward across stacked
    // sections, so leave the per-section freeze from writeExcelSection (last wins).
  } else {
    payload.sections.forEach((section, i) => {
      const ws = addSheet(section.title || `Sheet ${i + 1}`, `Sheet ${i + 1}`)
      writeExcelSection(ws, payload, section, { withTitle: true })
    })
  }

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

// The brand mark for PDF headers, as a data URL (jsPDF addImage input).
// Browser-only; returns null on any failure so exports never block on it.
async function brandMarkDataUrl(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch('/brand/logo-mark.png')
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

  // Turnrow brand header: the mark + spaced-caps wordmark above the report
  // title — these are lender-facing documents. Fetch failure (offline, asset
  // missing) silently falls back to the wordmark alone.
  const mark = await brandMarkDataUrl()
  if (mark) {
    try { doc.addImage(mark, 'PNG', 40, 22, 18, 18) } catch { /* wordmark-only */ }
  }
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(11, 74, 36) // brand forest
  doc.text('TURNROW', mark ? 64 : 40, 34, { charSpace: 2.5 })
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(0)

  doc.setFontSize(16)
  doc.text(pdfSafe(payload.title), 40, 58)
  doc.setFontSize(10)
  doc.setTextColor(110)
  doc.text(`Generated ${today}`, pageWidth - 40, 34, { align: 'right' })
  doc.setTextColor(0)

  let cursorY = 76
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
        styles: { halign: 'center' as const, fillColor: [22, 101, 52] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontStyle: 'bold' as const },
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
      headStyles: { fillColor: [22, 101, 52], textColor: [255, 255, 255] },
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

// ---------- Print ----------

// Opens the browser print dialog. Print CSS in globals.css hides nav/sidebar/
// export buttons so only the report content renders.
export function printReport(): void {
  if (typeof window === 'undefined') return
  window.print()
}
