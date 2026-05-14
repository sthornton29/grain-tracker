// Crop Insurance Production Report — Excel and PDF exports.
//
// The on-screen tables and these exports share the same data structures
// (DetailSheet / SummaryRow / FarmCropCell) so a column added to the screen
// flows through to the workbook without separate plumbing. The Yield column
// in Excel is emitted as a formula (= production / acres) so the spreadsheet
// stays live when an agent tweaks an acre or bushel cell.

import type {
  DetailSheet, FarmCropCell, SummaryRow,
} from '@/components/reports/crop-insurance-report'
import type { Crop } from '@/lib/types'

export type ExportArgs = {
  title: string
  cropYear: number | null
  entityName: string
  reportCrops: Crop[]
  summaryRows: SummaryRow[]
  summaryTotals: Map<string, FarmCropCell>
  detailSheets: DetailSheet[]
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function safeSheetName(name: string): string {
  // Excel disallows : \ / ? * [ ] and caps sheet names at 31 chars.
  return name.replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet'
}

// Crops appearing in a given detail sheet — keeps each sheet's column set
// narrow (matches the on-screen DetailTable behavior).
function cropsForSheet(sheet: DetailSheet, all: Crop[]): Crop[] {
  const ids = new Set<string>()
  for (const farm of sheet.farms.values()) {
    for (const [cid, cell] of farm.byCrop) {
      if (cell.acres > 0) ids.add(cid)
    }
  }
  return all.filter((c) => ids.has(c.id))
}

// ---------- Excel ----------

export async function exportCropInsuranceWorkbook(args: ExportArgs): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  buildSummarySheet(XLSX, wb, args)
  for (const sheet of args.detailSheets) {
    buildDetailSheet(XLSX, wb, sheet, args)
  }

  const filename = `${slug(args.title || 'crop-insurance-production-report')}-${new Date().toISOString().slice(0, 10)}.xlsx`
  XLSX.writeFile(wb, filename)
}

type XlsxModule = typeof import('xlsx')
type Worksheet = ReturnType<XlsxModule['utils']['aoa_to_sheet']>
type Range = { s: { r: number; c: number }; e: { r: number; c: number } }

const FMT_NUM2 = '#,##0.00'
const FMT_YIELD = '#,##0.0'

function colLetter(c: number): string {
  // Reused per row for formula cells. 0 -> A, 26 -> AA, etc.
  let s = ''
  let n = c
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return s
}

function setCell(ws: Worksheet, XLSX: XlsxModule, r: number, c: number, value: unknown, opts: { z?: string; f?: string; bold?: boolean; italic?: boolean; align?: 'left' | 'right' | 'center' } = {}) {
  const addr = XLSX.utils.encode_cell({ r, c })
  const cell: Record<string, unknown> = {}
  if (opts.f) {
    cell.f = opts.f
    cell.t = 'n'
  } else if (typeof value === 'number') {
    cell.v = value
    cell.t = 'n'
  } else if (value === null || value === undefined || value === '') {
    cell.v = ''
    cell.t = 's'
  } else {
    cell.v = value
    cell.t = 's'
  }
  if (opts.z) cell.z = opts.z
  // Note: SheetJS Community Edition writes `s` (style) onto the cell but
  // doesn't apply it on write. The styles still travel through if the agent
  // opens and re-saves; bolding the title row keeps the structure intact for
  // an Excel-paid tier upgrade later.
  const s: Record<string, unknown> = {}
  if (opts.bold || opts.italic) s.font = { bold: !!opts.bold, italic: !!opts.italic }
  if (opts.align) s.alignment = { horizontal: opts.align }
  if (Object.keys(s).length > 0) cell.s = s
  ws[addr] = cell
}

function ensureRange(ws: Worksheet, XLSX: XlsxModule, lastRow: number, lastCol: number) {
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } })
}

function setColWidths(ws: Worksheet, widths: number[]) {
  ws['!cols'] = widths.map((w) => ({ wch: w }))
}

function setMerges(ws: Worksheet, merges: Range[]) {
  ws['!merges'] = merges
}

function headerRows(
  XLSX: XlsxModule,
  ws: Worksheet,
  title: string,
  subtitle: string,
  totalCols: number,
): number {
  setCell(ws, XLSX, 0, 0, title, { bold: true, align: 'left' })
  setCell(ws, XLSX, 1, 0, subtitle, { align: 'left' })
  setCell(ws, XLSX, 2, 0, `Generated ${new Date().toLocaleString()}`, { italic: true, align: 'left' })
  // Merge the title rows across all data columns so the text doesn't get
  // truncated visually when an agent opens the workbook.
  const merges: Range[] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, totalCols - 1) } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: Math.max(0, totalCols - 1) } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: Math.max(0, totalCols - 1) } },
  ]
  ws['!merges'] = merges
  return 4 // first body row
}

function buildSummarySheet(XLSX: XlsxModule, wb: ReturnType<XlsxModule['utils']['book_new']>, args: ExportArgs): void {
  const ws: Worksheet = {}
  const nCrops = args.reportCrops.length
  // Layout: col 0 = row label; then 3 groups × nCrops sub-columns.
  const totalCols = 1 + 3 * nCrops
  const subtitle = `${args.entityName ? args.entityName + ' · ' : ''}${args.cropYear ?? ''} crop year`

  let r = headerRows(XLSX, ws, `${args.title} — Summary`, subtitle, totalCols)
  // Group header row.
  setCell(ws, XLSX, r, 0, 'County / Practice', { bold: true, align: 'left' })
  setCell(ws, XLSX, r, 1, 'Certified Acres', { bold: true, align: 'center' })
  setCell(ws, XLSX, r, 1 + nCrops, 'Production (Bu. Or Lbs.)', { bold: true, align: 'center' })
  setCell(ws, XLSX, r, 1 + 2 * nCrops, 'Yield/Acre (Bu. Or Lbs.)', { bold: true, align: 'center' })
  const groupHeaderRow = r
  const merges: Range[] = [
    ...(ws['!merges'] as Range[] ?? []),
    { s: { r: groupHeaderRow, c: 0 }, e: { r: groupHeaderRow + 1, c: 0 } },
    { s: { r: groupHeaderRow, c: 1 }, e: { r: groupHeaderRow, c: nCrops } },
    { s: { r: groupHeaderRow, c: 1 + nCrops }, e: { r: groupHeaderRow, c: 2 * nCrops } },
    { s: { r: groupHeaderRow, c: 1 + 2 * nCrops }, e: { r: groupHeaderRow, c: 3 * nCrops } },
  ]
  r++
  // Crop subheader row.
  for (let i = 0; i < nCrops; i++) {
    setCell(ws, XLSX, r, 1 + i, args.reportCrops[i].name, { bold: true, align: 'center' })
    setCell(ws, XLSX, r, 1 + nCrops + i, args.reportCrops[i].name, { bold: true, align: 'center' })
    setCell(ws, XLSX, r, 1 + 2 * nCrops + i, args.reportCrops[i].name, { bold: true, align: 'center' })
  }
  r++
  const firstDataRow = r

  // One row per (county, practice).
  for (const row of args.summaryRows) {
    setCell(ws, XLSX, r, 0, row.sheetName, { align: 'left' })
    for (let i = 0; i < nCrops; i++) {
      const c = args.reportCrops[i]
      const v = row.byCrop.get(c.id)
      const acres = v?.acres ?? 0
      const bu = v?.bu ?? 0
      if (acres > 0) setCell(ws, XLSX, r, 1 + i, acres, { z: FMT_NUM2 })
      if (bu > 0) setCell(ws, XLSX, r, 1 + nCrops + i, bu, { z: FMT_NUM2 })
      // Yield = production / acres (formula, blank when either is missing).
      if (acres > 0 && bu > 0) {
        const prodCell = `${colLetter(1 + nCrops + i)}${r + 1}`
        const acresCell = `${colLetter(1 + i)}${r + 1}`
        setCell(ws, XLSX, r, 1 + 2 * nCrops + i, '', { f: `IFERROR(${prodCell}/${acresCell},"")`, z: FMT_YIELD })
      }
    }
    r++
  }
  const lastDataRow = r - 1

  // Total row — sums per crop, yield uses summed production / summed acres.
  setCell(ws, XLSX, r, 0, 'Total', { bold: true, align: 'left' })
  for (let i = 0; i < nCrops; i++) {
    const acresCol = colLetter(1 + i)
    const prodCol = colLetter(1 + nCrops + i)
    if (lastDataRow >= firstDataRow) {
      setCell(ws, XLSX, r, 1 + i, '', { f: `SUM(${acresCol}${firstDataRow + 1}:${acresCol}${lastDataRow + 1})`, z: FMT_NUM2, bold: true })
      setCell(ws, XLSX, r, 1 + nCrops + i, '', { f: `SUM(${prodCol}${firstDataRow + 1}:${prodCol}${lastDataRow + 1})`, z: FMT_NUM2, bold: true })
      const totalProdCell = `${colLetter(1 + nCrops + i)}${r + 1}`
      const totalAcresCell = `${colLetter(1 + i)}${r + 1}`
      setCell(ws, XLSX, r, 1 + 2 * nCrops + i, '', { f: `IFERROR(${totalProdCell}/${totalAcresCell},"")`, z: FMT_YIELD, bold: true })
    }
  }
  const totalsRow = r

  ensureRange(ws, XLSX, totalsRow, totalCols - 1)
  setColWidths(ws, [28, ...Array(3 * nCrops).fill(14)])
  setMerges(ws, merges)

  XLSX.utils.book_append_sheet(wb, ws, safeSheetName('Summary'))
}

function buildDetailSheet(
  XLSX: XlsxModule,
  wb: ReturnType<XlsxModule['utils']['book_new']>,
  sheet: DetailSheet,
  args: ExportArgs,
): void {
  const sheetCrops = cropsForSheet(sheet, args.reportCrops)
  const nCrops = sheetCrops.length
  if (nCrops === 0) return

  const practice = sheet.practice === 'irrigated' ? 'Irrigated' : 'Dryland'
  const ws: Worksheet = {}
  // Layout: col 0 = Farm Name, col 1 = Farm #, then 3 × nCrops crop cols.
  const totalCols = 2 + 3 * nCrops
  const subtitle = `${args.entityName ? args.entityName + ' · ' : ''}${args.cropYear ?? ''} crop year · ${sheet.sheetName}`

  let r = headerRows(XLSX, ws, `${args.title} — ${sheet.sheetName}`, subtitle, totalCols)
  // Group header row.
  setCell(ws, XLSX, r, 0, 'Farm Name', { bold: true, align: 'left' })
  setCell(ws, XLSX, r, 1, 'Farm #', { bold: true, align: 'left' })
  setCell(ws, XLSX, r, 2, `Certified ${practice} Acres`, { bold: true, align: 'center' })
  setCell(ws, XLSX, r, 2 + nCrops, `${practice} Production (Bu. Or Lbs.)`, { bold: true, align: 'center' })
  setCell(ws, XLSX, r, 2 + 2 * nCrops, 'Yield/Acre (Bu. Or Lbs.)', { bold: true, align: 'center' })
  const groupHeaderRow = r
  const merges: Range[] = [
    ...(ws['!merges'] as Range[] ?? []),
    { s: { r: groupHeaderRow, c: 0 }, e: { r: groupHeaderRow + 1, c: 0 } },
    { s: { r: groupHeaderRow, c: 1 }, e: { r: groupHeaderRow + 1, c: 1 } },
    { s: { r: groupHeaderRow, c: 2 }, e: { r: groupHeaderRow, c: 1 + nCrops } },
    { s: { r: groupHeaderRow, c: 2 + nCrops }, e: { r: groupHeaderRow, c: 1 + 2 * nCrops } },
    { s: { r: groupHeaderRow, c: 2 + 2 * nCrops }, e: { r: groupHeaderRow, c: 1 + 3 * nCrops } },
  ]
  r++
  for (let i = 0; i < nCrops; i++) {
    setCell(ws, XLSX, r, 2 + i, sheetCrops[i].name, { bold: true, align: 'center' })
    setCell(ws, XLSX, r, 2 + nCrops + i, sheetCrops[i].name, { bold: true, align: 'center' })
    setCell(ws, XLSX, r, 2 + 2 * nCrops + i, sheetCrops[i].name, { bold: true, align: 'center' })
  }
  r++
  const firstDataRow = r

  const farmRows = [...sheet.farms.values()].sort((a, b) => a.farmName.localeCompare(b.farmName))
  for (const farm of farmRows) {
    setCell(ws, XLSX, r, 0, farm.farmName, { align: 'left' })
    setCell(ws, XLSX, r, 1, farm.fsaNumber ?? '', { align: 'left' })
    for (let i = 0; i < nCrops; i++) {
      const c = sheetCrops[i]
      const cell = farm.byCrop.get(c.id)
      const acres = cell?.acres ?? 0
      const bu = cell?.bu ?? 0
      if (acres > 0) setCell(ws, XLSX, r, 2 + i, acres, { z: FMT_NUM2 })
      if (bu > 0) setCell(ws, XLSX, r, 2 + nCrops + i, bu, { z: FMT_NUM2 })
      if (acres > 0 && bu > 0) {
        const prodCell = `${colLetter(2 + nCrops + i)}${r + 1}`
        const acresCell = `${colLetter(2 + i)}${r + 1}`
        setCell(ws, XLSX, r, 2 + 2 * nCrops + i, '', { f: `IFERROR(${prodCell}/${acresCell},"")`, z: FMT_YIELD })
      }
    }
    r++
  }
  const lastDataRow = r - 1

  // Total row.
  setCell(ws, XLSX, r, 0, 'Total', { bold: true, align: 'left' })
  for (let i = 0; i < nCrops; i++) {
    const acresCol = colLetter(2 + i)
    const prodCol = colLetter(2 + nCrops + i)
    if (lastDataRow >= firstDataRow) {
      setCell(ws, XLSX, r, 2 + i, '', { f: `SUM(${acresCol}${firstDataRow + 1}:${acresCol}${lastDataRow + 1})`, z: FMT_NUM2, bold: true })
      setCell(ws, XLSX, r, 2 + nCrops + i, '', { f: `SUM(${prodCol}${firstDataRow + 1}:${prodCol}${lastDataRow + 1})`, z: FMT_NUM2, bold: true })
      const totalProdCell = `${colLetter(2 + nCrops + i)}${r + 1}`
      const totalAcresCell = `${colLetter(2 + i)}${r + 1}`
      setCell(ws, XLSX, r, 2 + 2 * nCrops + i, '', { f: `IFERROR(${totalProdCell}/${totalAcresCell},"")`, z: FMT_YIELD, bold: true })
    }
  }
  const totalsRow = r

  ensureRange(ws, XLSX, totalsRow, totalCols - 1)
  setColWidths(ws, [26, 14, ...Array(3 * nCrops).fill(14)])
  setMerges(ws, merges)

  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sheet.sheetName))
}

// ---------- PDF ----------

export async function exportCropInsurancePdf(args: ExportArgs): Promise<void> {
  const [{ default: JsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autoTable = ((autoTableMod as any).default ?? autoTableMod) as any
  const doc = new JsPDF({ orientation: 'landscape', unit: 'pt' })
  const pageWidth = doc.internal.pageSize.getWidth()

  // First page: Summary
  drawPdfPage(doc, autoTable, pageWidth, args, {
    sheetTitle: 'Summary',
    nCrops: args.reportCrops.length,
    cropNames: args.reportCrops.map((c) => c.name),
    rowLabelHeader: 'County / Practice',
    rows: args.summaryRows.map((row) => ({
      label: row.sheetName,
      cells: args.reportCrops.map((c) => row.byCrop.get(c.id) ?? null),
    })),
    totalsCells: args.reportCrops.map((c) => args.summaryTotals.get(c.id) ?? null),
    practice: null,
  })

  for (const sheet of args.detailSheets) {
    doc.addPage()
    const sheetCrops = cropsForSheet(sheet, args.reportCrops)
    const practice = sheet.practice === 'irrigated' ? 'Irrigated' : 'Dryland'
    const farmRows = [...sheet.farms.values()].sort((a, b) => a.farmName.localeCompare(b.farmName))
    // Totals for the in-PDF total row.
    const totals = new Map<string, FarmCropCell>()
    for (const farm of farmRows) {
      for (const [cid, cell] of farm.byCrop) {
        const t = totals.get(cid) ?? { acres: 0, bu: 0 }
        t.acres += cell.acres
        t.bu += cell.bu
        totals.set(cid, t)
      }
    }
    drawPdfPage(doc, autoTable, pageWidth, args, {
      sheetTitle: sheet.sheetName,
      nCrops: sheetCrops.length,
      cropNames: sheetCrops.map((c) => c.name),
      rowLabelHeader: 'Farm Name',
      practice,
      rows: farmRows.map((farm) => ({
        label: farm.farmName,
        fsaNumber: farm.fsaNumber,
        cells: sheetCrops.map((c) => farm.byCrop.get(c.id) ?? null),
      })),
      totalsCells: sheetCrops.map((c) => totals.get(c.id) ?? null),
    })
  }

  const filename = `${slug(args.title || 'crop-insurance-production-report')}-${new Date().toISOString().slice(0, 10)}.pdf`
  doc.save(filename)
}

type PdfRow = {
  label: string
  fsaNumber?: string | null
  cells: Array<FarmCropCell | null>
}

type PdfPageArgs = {
  sheetTitle: string
  nCrops: number
  cropNames: string[]
  rowLabelHeader: string
  practice: string | null
  rows: PdfRow[]
  totalsCells: Array<FarmCropCell | null>
}

function drawPdfPage(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  pageWidth: number,
  args: ExportArgs,
  page: PdfPageArgs,
) {
  const titleLine = `${args.entityName ? args.entityName + ' ' : ''}${args.cropYear ?? ''} Production Report — ${page.sheetTitle}`
  doc.setFontSize(14)
  doc.text(titleLine, 40, 40)
  doc.setFontSize(9)
  doc.setTextColor(110)
  doc.text(`Generated ${new Date().toLocaleString()}`, pageWidth - 40, 40, { align: 'right' })
  doc.setTextColor(0)

  const nCrops = page.nCrops
  const includesFsa = page.rows.some((r) => r.fsaNumber !== undefined)
  const acreLabel = page.practice ? `Certified ${page.practice} Acres` : 'Certified Acres'
  const prodLabel = page.practice ? `${page.practice} Production (Bu. Or Lbs.)` : 'Production (Bu. Or Lbs.)'
  const yldLabel = 'Yield/Acre (Bu. Or Lbs.)'

  // Two-row header — top-level groups + crop sub-columns.
  const head: Array<Array<{ content: string; colSpan?: number; rowSpan?: number; styles?: Record<string, unknown> }>> = [
    [],
    [],
  ]
  head[0].push({ content: page.rowLabelHeader, rowSpan: 2 })
  if (includesFsa) head[0].push({ content: 'Farm #', rowSpan: 2 })
  head[0].push({ content: acreLabel, colSpan: nCrops })
  head[0].push({ content: prodLabel, colSpan: nCrops })
  head[0].push({ content: yldLabel, colSpan: nCrops })
  for (let i = 0; i < nCrops; i++) head[1].push({ content: page.cropNames[i] })
  for (let i = 0; i < nCrops; i++) head[1].push({ content: page.cropNames[i] })
  for (let i = 0; i < nCrops; i++) head[1].push({ content: page.cropNames[i] })

  function fmtNum(n: number, d: number): string {
    return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
  }

  const body: string[][] = []
  for (const r of page.rows) {
    const row: string[] = []
    row.push(r.label)
    if (includesFsa) row.push(r.fsaNumber ?? '')
    for (const c of r.cells) row.push(c && c.acres > 0 ? fmtNum(c.acres, 2) : '')
    for (const c of r.cells) row.push(c && c.bu > 0 ? fmtNum(c.bu, 2) : '')
    for (const c of r.cells) {
      const yld = c && c.acres > 0 && c.bu > 0 ? c.bu / c.acres : null
      row.push(yld != null ? fmtNum(yld, 1) : '')
    }
    body.push(row)
  }
  // Total row.
  const totalRow: string[] = []
  totalRow.push('Total')
  if (includesFsa) totalRow.push('')
  for (const c of page.totalsCells) totalRow.push(c && c.acres > 0 ? fmtNum(c.acres, 2) : '')
  for (const c of page.totalsCells) totalRow.push(c && c.bu > 0 ? fmtNum(c.bu, 2) : '')
  for (const c of page.totalsCells) {
    const yld = c && c.acres > 0 && c.bu > 0 ? c.bu / c.acres : null
    totalRow.push(yld != null ? fmtNum(yld, 1) : '')
  }
  body.push(totalRow)

  // Build a columnStyles map: row label left, everything else right.
  const colCount = 1 + (includesFsa ? 1 : 0) + 3 * nCrops
  const columnStyles: Record<number, Record<string, unknown>> = {}
  for (let i = 0; i < colCount; i++) {
    const isLabel = i === 0 || (includesFsa && i === 1)
    columnStyles[i] = { halign: isLabel ? 'left' : 'right' }
  }

  autoTable(doc, {
    head,
    body,
    startY: 60,
    styles: { fontSize: 8, cellPadding: 3, lineWidth: 0.4, lineColor: [180, 180, 180] },
    headStyles: { fillColor: [22, 101, 52], halign: 'center' },
    columnStyles,
    margin: { left: 40, right: 40 },
    didParseCell: (data: { row: { index: number }; cell: { styles: Record<string, unknown> } }) => {
      // Bold the last row (Total).
      if (data.row.index === body.length - 1) {
        data.cell.styles.fontStyle = 'bold'
        data.cell.styles.fillColor = [241, 245, 249]
      }
    },
    didDrawPage: (data: { pageNumber: number }) => {
      const pageHeight = doc.internal.pageSize.getHeight()
      doc.setFontSize(8)
      doc.setTextColor(140)
      doc.text(`Page ${data.pageNumber}`, pageWidth - 40, pageHeight - 20, { align: 'right' })
      doc.setTextColor(0)
    },
  })
}
