import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { formatNumber, excelNumFmt, defaultFilename, pdfSafe, exportToExcel, type NumFmt, type ExportPayload } from '@/lib/exports'

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
