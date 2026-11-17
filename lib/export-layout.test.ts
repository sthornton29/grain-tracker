import { describe, it, expect, vi } from 'vitest'
import JSZip from 'jszip'
import { buildExcelWorkbook, buildPdfDocument, excelFileBytes, excelNumFmt, formatNumber, pdfSafe, MAX_FROZEN_ROWS, MAX_FROZEN_WIDTH, type ExportPayload, type ExportSection } from '@/lib/exports'
import { cell, sum, rows as rowsRange } from '@/lib/formula'
import { buildInventoryPayload, type InventoryCsvRow } from '@/components/export-inventory-csv'
import { buildProductionAuditPayload } from '@/lib/production-audit-workbook'
import { sampleAuditInput, sampleCottonAuditInput, sampleReportPayload, sampleStackedPayload } from '@/lib/export-sample-fixtures'

// THE EXCEL LAYOUT CONTRACT (lib/exports.ts) — what a person sees when the
// file opens. These pin the rules that went wrong before: a Summary sheet
// whose title block, KPI strip and contents list froze 19 rows (one row of
// data left to scroll on a laptop), stacked sheets frozen at the LAST table's
// header, a six-row title block frozen on every ordinary report, group
// headings that would not center, integers printed "88,320.", notes cut off
// at the column edge, filter buttons over the labels.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The frozen strip a sheet opens with: rows above the data, and the summed width of the frozen columns. */
function frozen(ws: any): { rows: number; cols: number; width: number } {
  const v = ws.views?.[0] ?? {}
  if (v.state !== 'frozen') return { rows: 0, cols: 0, width: 0 }
  const cols = v.xSplit ?? 0
  let width = 0
  for (let c = 1; c <= cols; c++) width += ws.getColumn(c).width ?? 0
  return { rows: v.ySplit ?? 0, cols, width }
}

/** Every rule that holds for every sheet of every workbook. */
function expectContract(wb: any): void {
  for (const ws of wb.worksheets) {
    const f = frozen(ws)
    expect(f.rows, `${ws.name}: frozen rows`).toBeLessThanOrEqual(MAX_FROZEN_ROWS)
    expect(f.width, `${ws.name}: frozen column width`).toBeLessThanOrEqual(MAX_FROZEN_WIDTH)
    expect(ws.model.merges ?? [], `${ws.name}: merged cells`).toEqual([])
    expect(ws.views[0].showGridLines, `${ws.name}: gridlines`).toBe(false)
    ws.eachRow((row: any) => row.eachCell({ includeEmpty: true }, (cell: any) => {
      // A blank is an empty cell — never an empty string (it would stop text
      // running on, stop a group heading centering, and count in COUNTA).
      expect(cell.value, `${ws.name}!${cell.address}`).not.toBe('')
    }))
  }
}

const simple = (over: Partial<ExportSection> = {}, payloadOver: Partial<ExportPayload> = {}): ExportPayload => ({
  title: 'Sample Report',
  filters: '2026 Crop Year · All Entities',
  sections: [{
    columns: [{ label: 'Farm' }, { label: 'Acres', format: 'acres' }, { label: 'Revenue', format: 'usd0' }],
    rows: [['Home Place', 60.4, 51624], ['Pruitt Farm', 97.4, 86398], ['Total', 157.8, 138022]],
    rowMeta: ['data', 'data', 'total'],
    ...over,
  }],
  ...payloadOver,
})

describe('freeze panes — the header and the identifying columns, never the window', () => {
  it('an ordinary report freezes a compact block: title, one context line, a thin spacer, the header', async () => {
    const wb = await buildExcelWorkbook(simple())
    const ws = wb.worksheets[0]
    expect(ws.getCell('A1').value).toBe('Sample Report')
    expect(String(ws.getCell('A2').value)).toMatch(/^2026 Crop Year · All Entities · Generated \d+\/\d+\/\d{4} \d+:\d\d [AP]M · Turnrow$/)
    expect(ws.getRow(3).height).toBe(6)
    expect(ws.getCell('A4').value).toBe('Farm')
    // Four rows above the data, the cursor on the first data cell; a table this
    // narrow fits one screen, so no column is frozen.
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 4, xSplit: 0, topLeftCell: 'A5', activeCell: 'A5' })
    expectContract(wb)
  })

  it('a grouped header adds exactly one frozen row, and its headings center across empty cells', async () => {
    const wb = await buildExcelWorkbook(sampleReportPayload())
    const ws = wb.getWorksheet('By Farm')
    expect(ws.getCell('A1').value).toBe('Revenue Projections — By Farm')
    // Row 4 the group row, row 5 the header; the wide table freezes its first column.
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 5, xSplit: 1, activeCell: 'B6' })
    expect(ws.getCell('C4').value).toBe('Production')
    expect(ws.getCell('C4').alignment.horizontal).toBe('centerContinuous')
    expect(ws.getCell('D4').value).toBeNull() // centered across: must be truly empty
    expect(ws.getCell('E4').value).toBeNull()
    expect(ws.pageSetup.printTitlesRow).toBe('4:5') // both header rows repeat on every printed page
    expectContract(wb)
  })

  it('a table that fits one screen freezes no column; a wide one freezes only its first', async () => {
    const wb = await buildExcelWorkbook(sampleReportPayload())
    expect(frozen(wb.getWorksheet('By Crop'))).toMatchObject({ rows: 4, cols: 0 })
    expect(frozen(wb.getWorksheet('By Farm'))).toMatchObject({ rows: 5, cols: 1 })
  })

  it('a frozen column is never a long-text column: the freeze backs off to what fits', async () => {
    const wide = Array.from({ length: 14 }, (_, i) => ({ label: `Metric ${i + 1}`, format: 'usd0' as const }))
    const long = 'A very long description of the line item that runs well past any sensible frozen width'
    const wb = await buildExcelWorkbook(simple({
      freezeColumns: 2,
      columns: [{ label: 'Farm' }, { label: 'Description', wrap: false, width: 60 }, ...wide],
      rows: [['Home Place', long, ...wide.map((_, i) => 1000 + i)]],
      rowMeta: ['data'],
    }))
    // Farm + a 60-character column would freeze 70+ characters: only Farm stays.
    expect(frozen(wb.worksheets[0])).toMatchObject({ cols: 1 })
    expectContract(wb)
  })

  it('several tables stacked on one sheet freeze nothing, and every column fits its widest table', async () => {
    const wb = await buildExcelWorkbook(sampleStackedPayload())
    expect(wb.worksheets).toHaveLength(1)
    const ws = wb.worksheets[0]
    expect(ws.views[0].state).toBeUndefined()
    expect(frozen(ws)).toEqual({ rows: 0, cols: 0, width: 0 })
    // Column A holds "Destination" (table 1) and "Barton Farm" (table 2): wide enough for both.
    expect(ws.getColumn(1).width).toBeGreaterThanOrEqual('Destination'.length + 2)
    expect(ws.getColumn(1).width).toBeGreaterThanOrEqual('Barton Farm'.length + 2)
    expect(ws.pageSetup.printTitlesRow).toBeUndefined()
    expectContract(wb)
  })

  it('too much above a table is refused under test (and left unfrozen for a customer)', async () => {
    const tall: ExportPayload = simple({ plain: true, key: 's', prelude: Array.from({ length: 8 }, (_, i) => ({ kind: 'text' as const, cells: [`line ${i + 1}`] })) })
    await expect(buildExcelWorkbook(tall)).rejects.toThrow(/at most 6 rows may sit above the data/)
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const wb = await buildExcelWorkbook(tall)
      expect(frozen(wb.worksheets[0]).rows).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rows under the table (postlude) never move the header or the freeze', async () => {
    const wb = await buildExcelWorkbook(simple({
      plain: true, key: 's',
      prelude: [{ kind: 'title', cells: ['Farms'] }, { kind: 'text', cells: ['2026 crop'] }],
      postlude: [{ kind: 'subtitle', cells: ['In this workbook'] }, { kind: 'links', cells: [{ v: 'Farms', link: "#'Farms'!A1" }] }],
    }))
    const ws = wb.worksheets[0]
    expect(ws.getCell('A4').value).toBe('Farm') // title, text, spacer, header
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 })
    expect(ws.getCell('A9').value).toBe('In this workbook') // 3 data rows, a blank, then the postlude
    expect(ws.getCell('A10').value).toMatchObject({ text: 'Farms', hyperlink: "#'Farms'!A1" })
    expect(ws.autoFilter).toEqual({ from: { row: 4, column: 1 }, to: { row: 7, column: 3 } }) // the filter stops at the data
  })
})

describe('the crop insurance workbook opens on the report', () => {
  it('every sheet keeps to the contract; the Summary shows its table at once', async () => {
    const payload = buildProductionAuditPayload(sampleAuditInput())
    const wb = await buildExcelWorkbook(payload)
    expectContract(wb)
    const names = wb.worksheets.map((w: any) => w.name)
    expect(names.slice(0, 7)).toEqual(['Summary', 'Colbert County Dryland', 'Colbert County Irrigated', 'Lawrence County Dryland', 'Lawrence County Irrigated', 'Limestone County Dryland', 'Limestone County Irrigated'])
    expect(names.slice(7)).toEqual(['Field Production', 'Load Data', 'Notes'])
    // Before: 19 rows frozen above the Summary table. Now 5 (title, context,
    // spacer, group row, header) with County / State / Practice beside the data.
    expect(frozen(wb.getWorksheet('Summary'))).toMatchObject({ rows: 5, cols: 3 })
    for (const ws of wb.worksheets) {
      expect(ws.views[0].state, `${ws.name} is frozen at its header`).toBe('frozen')
      expect(frozen(ws).rows, `${ws.name}`).toBeGreaterThanOrEqual(4)
    }
    // The county pages list each farm with its FSA number, as the screen does.
    const ws = wb.getWorksheet('Lawrence County Irrigated')
    expect([ws.getCell('A5').value, ws.getCell('B5').value]).toEqual(['Farm', 'FSA farm #'])
    expect([ws.getCell('A6').value, ws.getCell('B6').value]).toEqual(['Home Place', '1234'])
    expect([ws.getCell('A7').value, ws.getCell('A8').value]).toEqual(['Wheeler Farm', 'Total'])
  })
})

describe('cotton in the crop insurance workbook', () => {
  it('the lint reaches the Summary, and Gin Data sits beside Load Data with the bales behind it', async () => {
    const input = sampleCottonAuditInput()
    const payload = buildProductionAuditPayload(input)
    const wb = await buildExcelWorkbook(payload)
    expectContract(wb)
    const names = wb.worksheets.map((w: any) => w.name)
    expect(names.slice(-5)).toEqual(['Field Production', 'Load Data', 'Gin Data', 'Bales', 'Notes'])
    // The Summary's cotton columns carry pounds of lint, not a blank.
    const sm = wb.getWorksheet('Summary')
    const header = (sm.getRow(5).values as unknown[]).map((v) => String(v ?? ''))
    const lintCol = header.indexOf('Cotton (lbs)')
    expect(lintCol).toBeGreaterThan(0)
    let total = 0
    sm.eachRow((row: any) => { if (row.getCell(1).value === 'Total') total = Number(row.getCell(lintCol).value?.result ?? 0) })
    const onScreen = input.report.summaryTotals.get('cotton')!.bu
    expect(onScreen).toBeGreaterThan(800000)
    expect(total).toBeCloseTo(onScreen, 3) // the workbook's formulas land on the screen's lint
    // Gin Data: frozen under Date + Statement like Load Data; a statement the
    // gin printed no number on is named for its field and date.
    const gd = wb.getWorksheet('Gin Data')
    expect(frozen(gd)).toMatchObject({ rows: 4, cols: 2 })
    expect([gd.getCell('A4').value, gd.getCell('B4').value, gd.getCell('C4').value, gd.getCell('D4').value]).toEqual(['Date', 'Statement', 'Statement record', 'Status'])
    const statements: string[] = []
    gd.eachRow((row: any, n: number) => { if (n > 4) statements.push(String(row.getCell(2).value)) })
    expect(statements).toContain('Wheeler Big Field · 10/22/2026')
    expect(statements).toContain('7741')
    expect(statements).toContain('Cedar Lane Bottom · no date')
    expect(statements).toContain('Cedar Lane Bottom · not ginned yet')
    expect(statements.some((x) => /40614|NODATE/.test(x))).toBe(false) // never the made-up record key
    expect(frozen(wb.getWorksheet('Bales'))).toMatchObject({ rows: 4 })
  })
})

describe('cells read the way a person expects', () => {
  it('a number with no declared format shows whole when it is whole (never "88,320.")', async () => {
    const wb = await buildExcelWorkbook(simple({ columns: [{ label: 'Item' }, { label: 'Value' }], rows: [['Gross', 88320], ['Moisture', 13.5]], rowMeta: undefined }))
    const ws = wb.worksheets[0]
    expect(ws.getCell('B5').numFmt).toBe('#,##0;(#,##0)')
    expect(ws.getCell('B6').numFmt).toBe('#,##0.##;(#,##0.##)')
  })

  it("a 'date' column writes real dates shown m/d/yyyy, left-aligned like the labels they are", async () => {
    const wb = await buildExcelWorkbook(simple({ columns: [{ label: 'Date', format: 'date' }, { label: 'Ticket #' }, { label: 'Net (lb)', format: 'lbs' }], rows: [['2026-09-24', '48262', 57120], ['', '48263', 55280]], rowMeta: undefined }))
    const ws = wb.worksheets[0]
    expect(ws.getCell('A5').value).toEqual(new Date(Date.UTC(2026, 8, 24)))
    expect(ws.getCell('A5').numFmt).toBe('m/d/yyyy')
    expect(ws.getCell('A5').alignment.horizontal).toBe('left')
    expect(ws.getCell('A6').value).toBeNull()
    expect(ws.getCell('B5').value).toBe('48262') // a ticket number stays text
  })

  it("a numeric column's header sits over its numbers; a text column's stays left", async () => {
    const wb = await buildExcelWorkbook(simple())
    const ws = wb.worksheets[0]
    expect(ws.getCell('A4').alignment.horizontal).toBe('left')
    expect(ws.getCell('B4').alignment.horizontal).toBe('right')
    expect(ws.getCell('C4').alignment.horizontal).toBe('right')
    expect(ws.getCell('C5').alignment.horizontal).toBe('right')
  })

  it('long text wraps inside its column and the row grows; a group label never widens a column', async () => {
    const note = 'Landlord share 25% of the crop, delivered to the elevator at harvest, with the hauling split by the same share as the crop.'
    const wb = await buildExcelWorkbook(simple({
      columns: [{ label: 'Farm' }, { label: 'Acres', format: 'acres' }, { label: 'Notes' }],
      rows: [['Corn — 2026 — every farm in the operation, irrigated and dryland together'], ['Home Place', 60.4, note], ['Pruitt Farm', 97.4, '']],
      rowMeta: ['subhead', 'data', 'data'],
    }))
    const ws = wb.worksheets[0]
    expect(ws.getColumn(1).width).toBeLessThan(20) // fitted to "Pruitt Farm", not to the group label
    expect(ws.getColumn(3).width).toBe(50)
    expect(ws.getCell('C6').alignment.wrapText).toBe(true)
    expect(ws.getRow(6).height).toBeGreaterThanOrEqual(45) // three lines
    expect(ws.getRow(7).height ?? 15).toBeLessThanOrEqual(15)
    expect(ws.getCell('C7').value).toBeNull()
  })

  it('filter buttons get room: a filtered header is wider and its right-aligned labels are nudged clear', async () => {
    const plain = await buildExcelWorkbook(simple({ plain: true, key: 's', rowMeta: undefined }))
    const titled = await buildExcelWorkbook(simple())
    const a = plain.worksheets[0]
    const b = titled.worksheets[0]
    expect(a.autoFilter).toBeTruthy()
    expect(b.autoFilter).toBeFalsy()
    expect(a.getColumn(3).width).toBeGreaterThan(b.getColumn(3).width)
    expect(a.getCell('C1').alignment).toMatchObject({ horizontal: 'right', indent: 2 })
  })

  it('banding skips subtotal, total and group-label rows so their own fills show', async () => {
    const wb = await buildExcelWorkbook(sampleReportPayload())
    const ws = wb.getWorksheet('By Farm')
    const refs = (ws.conditionalFormattings as any[]).filter((cf) => cf.rules.some((r: any) => r.type === 'expression')).map((cf) => cf.ref)
    // Three crops: three runs of eleven farm rows; the label and subtotal rows between them are left out.
    expect(refs).toEqual(['A7:N17', 'A20:N30', 'A33:N43'])
    expect(ws.getCell('A18').fill.fgColor.argb).toBe('FFE8F5E9') // Corn subtotal keeps its light green
  })
})

describe('sheets and their names', () => {
  it('headline cards get a Summary sheet of their own, first — for a one-table report too', async () => {
    const wb = await buildExcelWorkbook(simple({ title: 'By Unit' }, { title: 'Claim Check', summary: [{ label: 'Units checked', value: '12', sub: 'using your agent’s trigger yields' }, { label: 'Below trigger', value: '2', tone: 'unfavorable' }] }))
    expect(wb.worksheets.map((w: any) => w.name)).toEqual(['Summary', 'By Unit'])
    const cover = wb.getWorksheet('Summary')
    expect(cover.getCell('A1').value).toBe('Claim Check')
    expect([cover.getCell('A4').value, cover.getCell('B4').value]).toEqual(['Metric', 'Value'])
    expect([cover.getCell('A5').value, cover.getCell('B5').value]).toEqual(['Units checked (using your agent’s trigger yields)', '12'])
    expect(cover.getCell('B6').font.color.argb).toBe('FFB91C1C') // the card's red
    expect(frozen(cover)).toEqual({ rows: 0, cols: 0, width: 0 })
    // The table sheet is titled for the report alone; its section title only names the tab.
    expect(wb.getWorksheet('By Unit').getCell('A1').value).toBe('Claim Check')
    expectContract(wb)
  })

  it('a lone untitled table is named for its report, never "Sheet 1"', async () => {
    const wb = await buildExcelWorkbook(simple({}, { title: 'Bundled Settlement Statements' }))
    expect(wb.worksheets.map((w: any) => w.name)).toEqual(['Bundled Settlement Statements'])
  })

  it('a tab name cut at 31 characters never ends on a dangling separator', async () => {
    const wb = await buildExcelWorkbook({ title: 'Yields', sections: [
      { title: 'North Forty Bottom · Soybeans · 2026 loads', columns: [{ label: 'Date' }], rows: [['x']] },
      { title: 'By Field', columns: [{ label: 'Field' }], rows: [['x']] },
    ] })
    const name = wb.worksheets[0].name
    expect(name.length).toBeLessThanOrEqual(31)
    expect(name).toBe('North Forty Bottom · Soybeans')
  })

  it('a document title too long for a tab is cut at a word, never mid-word', async () => {
    const doc = (title: string) => ({ ...sampleStackedPayload(), title })
    expect((await buildExcelWorkbook(doc('Rent Settlement — 2026 Crop Year'))).worksheets[0].name).toBe('Rent Settlement — 2026 Crop')
    expect((await buildExcelWorkbook(doc('Gin Receipt — Servico, Inc. · 40614'))).worksheets[0].name).toBe('Gin Receipt — Servico, Inc.')
    expect((await buildExcelWorkbook(doc('Load 48262 — Wheat'))).worksheets[0].name).toBe('Load 48262 — Wheat')
  })

  it('a stacked table with no column labels (a signature block) draws no header bar', async () => {
    const p = sampleStackedPayload()
    p.sections.push({ title: 'Acknowledgment', columns: [{ label: '' }, { label: '' }], rows: [['Landowner signature: ____________', 'Date: ________']], banded: false })
    const wb = await buildExcelWorkbook(p)
    const ws = wb.worksheets[0]
    let headingRow = 0
    ws.eachRow((row: any, n: number) => { if (row.getCell(1).value === 'Acknowledgment') headingRow = n })
    expect(headingRow).toBeGreaterThan(0)
    // The signature line follows its heading directly: no empty green header row between them.
    expect(ws.getCell(`A${headingRow + 1}`).value).toBe('Landowner signature: ____________')
    expect(ws.getCell(`A${headingRow + 1}`).fill?.fgColor?.argb).not.toBe('FF0B4A24')
    expectContract(wb)
  })

  it('a formula written under a table is calculated and cached like any other', async () => {
    const p: ExportPayload = {
      title: 'Bales', sections: [{
        key: 'bales', title: 'Bales', plain: true,
        prelude: [{ kind: 'title', cells: ['Bales'] }],
        columns: [{ key: 'pbi', label: 'PBI' }, { key: 'lbs', label: 'Net (lb)', format: 'lbs' }],
        rows: [['181001', { v: 498, input: true }], ['181002', { v: 502, input: true }]],
        postlude: [{ kind: 'kpi', cells: ['Lint lbs', { v: null, f: sum(rowsRange('bales', 'lbs', 0, 1)), format: 'lbs' }, 'First bale', { v: null, f: cell('bales', 'lbs', 0), format: 'lbs' }] }],
      }],
    }
    const wb = await buildExcelWorkbook(p)
    const ws = wb.worksheets[0]
    expect(ws.getCell('A3').value).toBe('PBI') // title, spacer, header
    expect(ws.getCell('B7').value).toEqual({ formula: 'SUM($B$4:$B$5)', result: 1000 })
    expect(ws.getCell('D7').value).toMatchObject({ result: 498 })
  })

  it('a stacked document leads with its headline figures', async () => {
    const wb = await buildExcelWorkbook({ ...sampleStackedPayload(), summary: [{ label: 'Dry bushels', value: '952 bu' }, { label: 'Payment', value: 'Paid', tone: 'favorable' }] })
    const ws = wb.worksheets[0]
    expect([ws.getCell('A4').value, ws.getCell('B4').value]).toEqual(['Metric', 'Value'])
    expect([ws.getCell('A5').value, ws.getCell('B5').value]).toEqual(['Dry bushels', '952 bu'])
    expect(ws.getCell('A8').value).toBe('Ticket') // a blank row, then the first table's heading
    expect(frozen(ws)).toEqual({ rows: 0, cols: 0, width: 0 })
    expectContract(wb)
  })

  it("'price4' keeps a contract's quarter cents: $4.8525", () => {
    expect(formatNumber(4.8525, 'price4')).toBe('$4.8525')
    expect(formatNumber(-0.3525, 'price4')).toBe('($0.3525)')
    expect(excelNumFmt('price4')).toBe('$#,##0.0000;($#,##0.0000)')
  })
})

describe('bin inventory', () => {
  const row = (siteName: string, binName: string, cropName: string, totalBu: number, over: Partial<InventoryCsvRow> = {}): InventoryCsvRow => ({
    siteName, binName, cropName, loadBackedBu: totalBu, transferNetBu: 0, beginningBu: 0, totalBu, capacityBu: 40000, pctFull: (totalBu / 40000) * 100, beginningNotes: '', ...over,
  })
  it('names the bin site (two sites can each have a "Bin 1"), subtotals each site, and keeps % full a number', () => {
    const p = buildInventoryPayload([
      row('Home Bins', 'Bin 1', 'Corn', 30000),
      row('Home Bins', 'Bin 2', 'Soybeans', 38000),
      row('River Bins', 'Bin 1', 'Corn', 42000),
      row('', 'Old Crib', 'Corn', 1000, { capacityBu: null, pctFull: null }),
    ], 'All Entities · All Bin Sites · All Crops')
    const sec = p.sections[0]
    expect(sec.columns.map((c) => c.label).slice(0, 3)).toEqual(['Bin site', 'Bin', 'Crop'])
    expect(sec.rows.map((r) => r[0])).toEqual(['Home Bins', 'Home Bins', 'Home Bins total', 'River Bins', 'River Bins total', 'No bin site', 'No bin site total', 'Total'])
    expect(sec.rowMeta).toEqual(['data', 'data', 'subtotal', 'data', 'subtotal', 'data', 'subtotal', 'total'])
    expect(sec.rows[0][8]).toBe(75) // 30,000 of 40,000: a plain number
    expect(sec.rows[1][8]).toEqual({ v: 95, tone: 'warning' }) // nearly full: amber
    expect(sec.rows[3][8]).toEqual({ v: 105, tone: 'unfavorable' }) // over its capacity: red, and still a number
    expect(sec.rows[5][8]).toBe('') // no capacity set
    expect(sec.rows[7][6]).toBe(111000)
    expect(p.filters).toBe('All Entities · All Bin Sites · All Crops')
    expect(p.summary).toEqual([{ label: 'Corn on hand', value: '73,000 bu' }, { label: 'Soybeans on hand', value: '38,000 bu' }])
  })
  it('one site needs no subtotal row', () => {
    const p = buildInventoryPayload([row('Home Bins', 'Bin 1', 'Corn', 30000), row('Home Bins', 'Bin 2', 'Corn', 10000)])
    expect(p.sections[0].rows.map((r) => r[0])).toEqual(['Home Bins', 'Home Bins', 'Total'])
  })
})

describe('the finished file', () => {
  it('tells Excel not to flag ticket numbers and per-row formulas with green corner triangles', async () => {
    const bytes = await excelFileBytes(simple({ columns: [{ label: 'Ticket #' }, { label: 'FSA farm #' }], rows: [['48262', '0871']], rowMeta: undefined }))
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).toMatch(/<ignoredErrors><ignoredError sqref="A1:B5" numberStoredAsText="1" formula="1"/)
    // Schema order: after the print settings, before the closing tag.
    expect(xml.indexOf('<ignoredErrors>')).toBeGreaterThan(xml.indexOf('<headerFooter'))
    // Still a valid workbook exceljs itself can read back.
    const ExcelJS = (await import('exceljs')).default
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(bytes as unknown as ArrayBuffer)
    expect(back.worksheets[0].getCell('A5').value).toBe('48262')
  })

  it('prints portrait when the table fits a page, landscape when it is wide', async () => {
    const wb = await buildExcelWorkbook(sampleReportPayload())
    expect(wb.getWorksheet('By Crop').pageSetup.orientation).toBe('portrait')
    expect(wb.getWorksheet('By Farm').pageSetup.orientation).toBe('landscape')
    expect(wb.getWorksheet('By Farm').pageSetup.fitToWidth).toBe(1)
  })
})

describe('PDF', () => {
  /** The text drawn on each page, from the content streams. */
  const pageTexts = (doc: any): string[] => {
    const pages: string[] = []
    for (let p = 1; p <= doc.internal.getNumberOfPages(); p++) pages.push((doc.internal.pages[p] as string[]).join('\n'))
    return pages
  }

  it('swaps marks the PDF fonts cannot draw for ones they can', () => {
    expect(pdfSafe('31: 5 \u2715')).toBe('31: 5 ×')
    expect(pdfSafe('Meets \u2713')).toBe('Meets Yes')
    expect(pdfSafe('\u2212$1,500')).toBe('-$1,500')
    expect(pdfSafe('9:16\u202FAM')).toBe('9:16 AM')
  })

  it('numbers its pages "Page n of N"', async () => {
    const doc = await buildPdfDocument(sampleReportPayload())
    const pages = pageTexts(doc)
    expect(pages.length).toBeGreaterThan(1)
    pages.forEach((text, i) => expect(text).toContain(`(Page ${i + 1} of ${pages.length}) Tj`))
  })

  it('never leaves a group label alone at the foot of a page: it moves with its rows', async () => {
    // One group of n rows, then a second group. Stepping n one row at a time
    // walks the second label down the page and across the page break, so one
    // of these puts it on the very last line — where it must not stay.
    const cols = [{ label: 'Farm' }, { label: 'Acres', format: 'acres' as const }, { label: 'Revenue', format: 'usd0' as const }]
    let crossed = 0
    for (let n = 24; n <= 44; n++) {
      const rows: ExportSection['rows'] = [['GROUPA']]
      const meta: NonNullable<ExportSection['rowMeta']> = ['subhead']
      for (let r = 1; r <= n; r++) { rows.push([`A${r}`, 100 + r, 5000 + r]); meta.push('data') }
      rows.push(['GROUPB']); meta.push('subhead')
      for (let r = 1; r <= 4; r++) { rows.push([`B${r}`, 100 + r, 5000 + r]); meta.push('data') }
      const doc = await buildPdfDocument({ title: 'Groups', sections: [{ title: 'By Group', columns: cols, rows, rowMeta: meta }] })
      const pages = pageTexts(doc)
      const page = pages.findIndex((t) => t.includes('(GROUPB) Tj'))
      expect(page, `n=${n}: the label is drawn`).toBeGreaterThanOrEqual(0)
      expect(pages[page].includes('(B1) Tj'), `n=${n}: the label and its first row share page ${page + 1}`).toBe(true)
      if (page > 0) crossed++
    }
    // The walk really did cross the page break (so the last line was visited).
    expect(crossed).toBeGreaterThan(0)
    expect(crossed).toBeLessThan(21)
  })

  it('prints a table\'s note above it and the rows written under it; one table needs no heading bar', async () => {
    const one = await buildPdfDocument(simple({ title: 'By Unit', note: 'One row per insured unit.', postlude: [{ kind: 'text', cells: ['Estimated: final amounts are determined by RMA after harvest.'] }] }))
    const text = pageTexts(one).join('\n')
    expect(text).toContain('(One row per insured unit.) Tj')
    expect(text).toContain('(Estimated: final amounts are determined by RMA after harvest.) Tj')
    expect(text).not.toContain('(By Unit) Tj') // a lone table: the report title is heading enough
    const two = await buildPdfDocument(sampleReportPayload())
    const both = pageTexts(two).join('\n')
    expect(both).toContain('(By Farm) Tj')
    expect(both).toContain('(By Crop) Tj')
  })

  it('keeps a short table whole instead of splitting it across two pages', async () => {
    const filler = Array.from({ length: 30 }, (_, i): ExportSection['rows'][number] => [`Row ${i + 1}`, i, i * 10])
    const short = Array.from({ length: 8 }, (_, i): ExportSection['rows'][number] => [`SHORT${i + 1}`, i, i * 10])
    const cols = [{ label: 'Farm' }, { label: 'Acres', format: 'acres' as const }, { label: 'Revenue', format: 'usd0' as const }]
    const doc = await buildPdfDocument({ title: 'Two tables', orientation: 'landscape', sections: [{ title: 'Long', columns: cols, rows: filler }, { title: 'Short', columns: cols, rows: short }] })
    const pages = pageTexts(doc)
    const withShort = pages.map((t, i) => (short.some((r) => t.includes(`(${r[0]}) Tj`)) ? i : -1)).filter((i) => i >= 0)
    expect(withShort).toHaveLength(1) // all eight rows on one page
    expect(pages[withShort[0]]).toContain('(Short) Tj') // with their heading
  })
})
