import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { formatNumber, excelNumFmt, defaultFilename, pdfSafe, exportToExcel, buildExcelWorkbook, evaluatePayload, formulaLayout, formulaTextOf, payloadHasFormulas, buildCsv, type NumFmt, type ExportPayload } from '@/lib/exports'
import { col, div, iferror, num, self, sumifs } from '@/lib/formula'

// The shared export number formatting is the single source of truth for every
// report's PDF/Excel. Conventions (hand-verified against the spec):
//   - thousands separators everywhere
//   - decimals by type: int/bu 0; acres/yield/dec1 1; dec2/usd2/price 2
//   - currency shows $, percent shows literal %
//   - negatives in parentheses (financial convention), no leading minus
// Tests assert the en-US grouping; the app runs with the default (US) locale.

describe('formatNumber — positive values by type', () => {
  it('int / bu: thousands separator, 0 decimals', () => {
    expect(formatNumber(45000, 'int')).toBe('45,000')
    expect(formatNumber(45000, 'bu')).toBe('45,000')
    expect(formatNumber(1234.7, 'bu')).toBe('1,235') // rounds to whole bushels
  })
  it('acres / yield / dec1: 1 decimal', () => {
    expect(formatNumber(1250, 'acres')).toBe('1,250.0')
    expect(formatNumber(182.46, 'yield')).toBe('182.5')
    expect(formatNumber(1234.5, 'dec1')).toBe('1,234.5')
  })
  it('dec2: 2 decimals', () => {
    expect(formatNumber(1234.5, 'dec2')).toBe('1,234.50')
  })
  it('usd0 / usd2 / price: $ with 0 or 2 decimals', () => {
    expect(formatNumber(1234567, 'usd0')).toBe('$1,234,567')
    expect(formatNumber(1234567.89, 'usd2')).toBe('$1,234,567.89')
    expect(formatNumber(4.9325, 'price')).toBe('$4.93') // $/bu to 2 decimals
  })
  it('pct0 / pct1: literal % (value is already a percent)', () => {
    expect(formatNumber(86, 'pct0')).toBe('86%')
    expect(formatNumber(86.5, 'pct1')).toBe('86.5%')
  })
})

describe('formatNumber — negatives in parentheses, no leading minus', () => {
  it('currency', () => {
    expect(formatNumber(-1234.56, 'usd2')).toBe('($1,234.56)')
    expect(formatNumber(-500, 'usd0')).toBe('($500)')
  })
  it('plain numbers and percents', () => {
    expect(formatNumber(-50, 'int')).toBe('(50)')
    expect(formatNumber(-12.5, 'pct1')).toBe('(12.5%)')
    expect(formatNumber(-1250, 'acres')).toBe('(1,250.0)')
  })
  it('zero is not parenthesized', () => {
    expect(formatNumber(0, 'usd2')).toBe('$0.00')
  })
})

describe('formatNumber — inference (no format) and edge cases', () => {
  it('inference adds commas and up to 2 decimals', () => {
    expect(formatNumber(45000)).toBe('45,000')
    expect(formatNumber(1234.56)).toBe('1,234.56')
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatNumber(-1234.5)).toBe('(1,234.5)')
  })
  it("'text' passes the number through unformatted", () => {
    expect(formatNumber(2026, 'text')).toBe('2026')
  })
  it('non-finite → empty string', () => {
    expect(formatNumber(NaN, 'usd2')).toBe('')
    expect(formatNumber(Infinity, 'int')).toBe('')
  })
})

describe('excelNumFmt — real-number formats with parenthesized negatives', () => {
  const cases: Array<[NumFmt, string]> = [
    ['int', '#,##0;(#,##0)'],
    ['bu', '#,##0;(#,##0)'],
    ['acres', '#,##0.0;(#,##0.0)'],
    ['yield', '#,##0.0;(#,##0.0)'],
    ['dec2', '#,##0.00;(#,##0.00)'],
    ['usd0', '$#,##0;($#,##0)'],
    ['usd2', '$#,##0.00;($#,##0.00)'],
    ['price', '$#,##0.00;($#,##0.00)'],
    ['pct0', '#,##0"%";(#,##0"%")'],
    ['pct1', '#,##0.0"%";(#,##0.0"%")'],
  ]
  it.each(cases)('%s → %s', (fmt, code) => {
    expect(excelNumFmt(fmt)).toBe(code)
  })
  it("'text' has no number format; inference uses up-to-2-decimals", () => {
    expect(excelNumFmt('text')).toBeUndefined()
    expect(excelNumFmt(undefined)).toBe('#,##0.##;(#,##0.##)')
  })
})

describe('pdfSafe — replace glyphs jsPDF Latin-1 fonts cannot render', () => {
  it('maps arrows to ASCII (so a date window reads, not tofu)', () => {
    expect(pdfSafe('2026-03-01 → 2026-06-30')).toBe('2026-03-01 -> 2026-06-30')
    expect(pdfSafe('Del → Riverside')).toBe('Del -> Riverside')
  })
  it('maps comparison/approx symbols', () => {
    expect(pdfSafe('≤ 5')).toBe('<= 5')
    expect(pdfSafe('≥ 5')).toBe('>= 5')
    expect(pdfSafe('≈ 100')).toBe('~ 100')
  })
  it('leaves WinAnsi-supported punctuation (em dash, middot, $) intact', () => {
    expect(pdfSafe('2026 crop · Corn — $1,234')).toBe('2026 crop · Corn — $1,234')
  })
})

describe('defaultFilename', () => {
  it('slugs the title and appends an ISO date', () => {
    expect(defaultFilename('Crop Insurance Claims Monitor')).toMatch(/^crop-insurance-claims-monitor-\d{4}-\d{2}-\d{2}$/)
    expect(defaultFilename('ARC/PLC Decision Aid')).toMatch(/^arc-plc-decision-aid-\d{4}-\d{2}-\d{2}$/)
  })
})

// Worksheet names must be unique (case-insensitively) and ≤31 chars, or exceljs
// throws "Worksheet name already exists". These reproduce the report shapes that
// hit that error. exportToExcel builds the workbook and (with no `document` in
// Node) skips the download, so we capture the finished sheet list via writeBuffer.
describe('exportToExcel — worksheet naming never collides', () => {
  async function sheetNamesFor(payload: ExportPayload): Promise<string[]> {
    // Capture the names passed to addWorksheet — the fix resolves uniqueness
    // before this call, and exceljs still throws here on any duplicate/oversize
    // name, so a clean run means every requested name was valid.
    const captured: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto: any = ExcelJS.Workbook.prototype
    const orig = proto.addWorksheet
    proto.addWorksheet = function (this: any, name?: string, ...rest: any[]) {
      captured.push(name as string)
      return orig.call(this, name, ...rest)
    }
    try {
      await exportToExcel(payload)
    } finally {
      proto.addWorksheet = orig
    }
    return captured
  }
  const noDupes = (names: string[]) => new Set(names.map((n) => n.toLowerCase())).size === names.length

  // Crop Insurance Production Report shape: multi-section, first section titled
  // "Summary", filters set, NO summary cards. Previously threw because filters
  // alone spawned an auto "Summary" sheet colliding with the section's "Summary".
  it('a section titled "Summary" (no cards) exports without collision', async () => {
    const names = await sheetNamesFor({
      title: '2026 Production Report',
      filters: '2026 crop · All entities',
      sections: [
        { title: 'Summary', columns: [{ label: 'County' }], rows: [['Bolivar County']] },
        { title: 'Bolivar County Irrigated', columns: [{ label: 'Farm' }], rows: [['Home']] },
        { title: 'Bolivar County Dryland', columns: [{ label: 'Farm' }], rows: [['Home']] },
      ],
    })
    expect(noDupes(names)).toBe(true)
    expect(names).toContain('Summary')
    expect(names.length).toBe(3) // no redundant cover sheet when there are no cards
  })

  // Share Rent Report shape: a "Summary" section AND summary cards + filters, so
  // the auto cover sheet legitimately exists too. Both survive — the section's
  // "Summary" is disambiguated rather than throwing.
  it('a "Summary" section plus the auto cover sheet both survive', async () => {
    const names = await sheetNamesFor({
      title: 'Share Rent Report',
      filters: 'Crop year: 2026',
      summary: [{ label: 'Corn owed', value: '12,345' }],
      sections: [
        { title: 'Summary', columns: [{ label: 'Crop' }], rows: [['Corn']] },
        { title: 'Detail', columns: [{ label: 'Landowner' }], rows: [['Smith']] },
      ],
    })
    expect(noDupes(names)).toBe(true)
    expect(names.length).toBe(3) // cover + Summary(section) + Detail
  })

  // Distinct titles that truncate to the same 31 chars must not collide, and the
  // disambiguated name must itself stay within Excel's 31-char limit.
  it('long titles that truncate identically are disambiguated within 31 chars', async () => {
    const long = (s: string) => `Washington County Production ${s} Practice`
    const names = await sheetNamesFor({
      title: 'Long Titles',
      sections: [
        { title: long('Irrigated'), columns: [{ label: 'A' }], rows: [['x']] },
        { title: long('Dryland'), columns: [{ label: 'A' }], rows: [['x']] },
      ],
    })
    expect(noDupes(names)).toBe(true)
    expect(names.every((n) => n.length <= 31)).toBe(true)
  })
})

// Spanning group headers (ExportSection.groups) merge cells above the columns.
// The Crop Insurance Production Report uses three metric groups (Certified Acres /
// Production / Yield-Acre) plus an empty-labelled leading group over the identity
// columns — exercise that exact shape so a bad merge/empty label can't regress.
describe('exportToExcel — grouped sections render without throwing', () => {
  it('handles three metric groups + an empty leading group (crop-insurance shape)', async () => {
    const crops = ['Corn', 'Soybean']
    const metricCols = (fmt: 'acres' | 'bu' | 'yield') => crops.map((c) => ({ label: c, align: 'right' as const, format: fmt }))
    const section: ExportPayload['sections'][number] = {
      title: 'Summary',
      columns: [{ label: 'County' }, { label: 'Practice' }, ...metricCols('acres'), ...metricCols('bu'), ...metricCols('yield')],
      groups: [
        { label: '', span: 2 },
        { label: 'Certified Acres', span: crops.length },
        { label: 'Production (Bu. Or Lbs.)', span: crops.length },
        { label: 'Yield/Acre (Bu. Or Lbs.)', span: crops.length },
      ],
      rows: [
        ['Bolivar County', 'Irrigated', 1250, '', 231000, '', 184.8, ''],
        ['Total', '', 1250, '', 231000, '', 184.8, ''],
      ],
      rowMeta: ['data', 'total'],
    }
    // The whole point: this must resolve, not throw. Group spans (2 + 2 + 2 + 2)
    // sum to the 8 columns; the empty leading group still merges + fills cleanly.
    await expect(exportToExcel({ title: '2026 Production Report', filters: '2026 crop', sections: [section] })).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Cotton $/lb rendering in exports — 'cents' carries ¢-stored values shown as $
// ---------------------------------------------------------------------------
describe("'cents' format — ¢-stored cotton prices render $/lb", () => {
  it('formatNumber: 72.65 → $0.7265 (4 decimals)', () => {
    expect(formatNumber(72.65, 'cents')).toBe('$0.7265')
    expect(formatNumber(70, 'cents')).toBe('$0.7000')
  })
  it('excelNumFmt is a 4-decimal $ format (values are written ÷100)', () => {
    expect(excelNumFmt('cents')).toBe('$#,##0.0000;($#,##0.0000)')
  })
  it('a mixed grain + cotton payload renders $/bu and $/lb side by side', () => {
    // Grain price column stays $4.93; cotton price column shows $0.7265.
    expect(formatNumber(4.93, 'price')).toBe('$4.93')
    expect(formatNumber(72.65, 'cents')).toBe('$0.7265')
    // Negative (a cotton basis) parenthesizes like every other export number.
    expect(formatNumber(-2.5, 'cents')).toBe('($0.0250)')
  })
})

// ---------------------------------------------------------------------------
// Formula cells (lib/formula.ts) through the shared layer: keyed sections,
// bounded ranges sized to the rows, cached results, blue inputs, autofilter,
// full recalculation on open. Any report's audit export builds on this.
// ---------------------------------------------------------------------------
describe('formula seam — keyed sections render bounded formulas with cached results', () => {
  const payload = (): ExportPayload => ({
    title: 'Seam check',
    sections: [
      {
        key: 'totals', title: 'Totals', plain: true,
        columns: [{ key: 'name', label: 'Name' }, { key: 'bu', label: 'Bushels', format: 'bu3' }, { key: 'yield', label: 'Yield', format: 'yield' }, { key: 'acres', label: 'Acres', format: 'acres' }],
        rows: [
          ['Home', { v: null, f: sumifs(col('loads', 'dry'), [col('loads', 'field'), self('name')]) }, { v: null, f: iferror(div(self('bu'), self('acres')), num(0)) }, { v: 10, input: true }],
          ['Moore', { v: null, f: sumifs(col('loads', 'dry'), [col('loads', 'field'), self('name')]) }, { v: null, f: iferror(div(self('bu'), self('acres')), num(0)) }, { v: 0, input: true }],
        ],
      },
      {
        key: 'loads', title: 'Load Data', plain: true, note: 'One row per load.',
        columns: [{ key: 'field', label: 'Field' }, { key: 'net', label: 'Net lbs', format: 'lbs' }, { key: 'dry', label: 'Dry bu', format: 'bu3' }],
        rows: [
          ['Home', { v: 56000, input: true }, { v: null, f: div(self('net'), num(56)) }],
          ['home', { v: 28000, input: true }, { v: null, f: div(self('net'), num(56)) }],
          ['Moore', { v: 5600, input: true }, { v: null, f: div(self('net'), num(56)) }],
        ],
      },
    ],
  })

  it('the layout places plain headers on row 1 (row 2 under a note) and sizes ranges to the rows', () => {
    const p = payload()
    expect(payloadHasFormulas(p)).toBe(true)
    const layout = formulaLayout(p)
    expect(layout.totals).toMatchObject({ sheetName: 'Totals', firstRow: 2, rowCount: 2, columns: { name: 'A', bu: 'B', yield: 'C', acres: 'D' } })
    expect(layout.loads).toMatchObject({ sheetName: 'Load Data', firstRow: 3, rowCount: 3 })
    expect(formulaTextOf(p, 'totals', 0, 'bu')).toBe("SUMIFS('Load Data'!$C$3:$C$5,'Load Data'!$A$3:$A$5,A2)")
    expect(formulaTextOf(p, 'totals', 1, 'yield')).toBe('IFERROR(B3/D3,0)')
    expect(formulaTextOf(p, 'loads', 2, 'dry')).toBe('B5/56')
    expect(formulaTextOf(p, 'totals', 0, 'name')).toBeNull()
  })

  it('evaluatePayload computes every formula and caches the result on the cell', () => {
    const p = payload()
    const grid = evaluatePayload(p)
    expect(grid.loads.map((r) => r[2])).toEqual([1000, 500, 100])
    expect(grid.totals[0][1]).toBe(1500) // case-insensitive SUMIFS: Home + home
    expect(grid.totals[0][2]).toBe(150)
    expect(grid.totals[1][2]).toBe(0) // IFERROR over the 0-acre division
    expect(p.sections[0].rows[0][1]).toMatchObject({ v: 1500 })
    expect(p.sections[1].rows[0][2]).toMatchObject({ v: 1000 })
  })

  it('the workbook writes { formula, result }, blue inputs, an autofilter, and full recalc on open', async () => {
    const p = payload()
    const wb = await buildExcelWorkbook(p)
    expect(wb.calcProperties.fullCalcOnLoad).toBe(true)
    const totals = wb.getWorksheet('Totals')
    expect(totals.getCell('B2').value).toEqual({ formula: "SUMIFS('Load Data'!$C$3:$C$5,'Load Data'!$A$3:$A$5,A2)", result: 1500 })
    expect(totals.getCell('B2').numFmt).toBe('#,##0.000;(#,##0.000)')
    expect(totals.getCell('D2').font?.color?.argb).toBe('FF0000FF')
    expect(totals.getCell('B2').font?.color?.argb).toBeUndefined()
    expect(totals.autoFilter).toEqual({ from: { row: 1, column: 1 }, to: { row: 3, column: 4 } })
    expect(totals.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    const loads = wb.getWorksheet('Load Data')
    expect(loads.getCell('A1').value).toBe('One row per load.')
    expect(loads.getCell('A2').value).toBe('Field')
    expect(loads.getCell('C3').value).toEqual({ formula: 'B3/56', result: 1000 })
  })

  it('a titled (non-plain) section still lines the layout up with the written header row', async () => {
    const p = payload()
    p.filters = '2026 crop'
    p.sections[0].plain = false
    const wb = await buildExcelWorkbook(p)
    const layout = formulaLayout(p)
    const totals = wb.getWorksheet('Totals')
    expect(totals.getCell(layout.totals.firstRow - 1, 1).value).toBe('Name')
    expect(totals.getCell(layout.totals.firstRow, 2).value).toMatchObject({ result: 1500 })
  })

  it('CSV and PDF text paths see the cached value of a formula cell', () => {
    const p = payload()
    evaluatePayload(p)
    const csv = buildCsv({ ...p, sections: [p.sections[0]] })
    expect(csv.split('\r\n')[1]).toBe('Home,1500.000,150.0,10.0')
  })

  it("'bu3' formats with three decimals", () => {
    expect(formatNumber(1000, 'bu3')).toBe('1,000.000')
    expect(excelNumFmt('bu3')).toBe('#,##0.000;(#,##0.000)')
  })
})
