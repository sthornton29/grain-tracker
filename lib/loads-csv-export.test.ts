import { describe, expect, it } from 'vitest'
import { buildCsv, csvCellText, type ExportPayload } from '@/lib/exports'

// The CSV renderer rides the same ExportPayload as Excel/PDF — the Loads page
// and Bin Inventory hand it the payload they already build, so there is no
// bespoke CSV path to drift.

describe('csvCellText', () => {
  it('numbers are plain (no commas, no $ or %), rounded to the format', () => {
    expect(csvCellText(45000.4, 'bu')).toBe('45000')
    expect(csvCellText(15.25, 'dec1')).toBe('15.3')
    expect(csvCellText(4.9325, 'price')).toBe('4.93')
    expect(csvCellText(1234.5, undefined)).toBe('1234.5')
    expect(csvCellText(2026, 'text')).toBe('2026')
    expect(csvCellText(72.65, 'cents')).toBe('0.7265')
  })
  it('strings are quoted only when they need it', () => {
    expect(csvCellText('Field A')).toBe('Field A')
    expect(csvCellText('Smith, Jr.')).toBe('"Smith, Jr."')
    expect(csvCellText('12" tire')).toBe('"12"" tire"')
    expect(csvCellText(null)).toBe('')
  })
})

describe('buildCsv', () => {
  const payload: ExportPayload = {
    title: 'Load Log',
    sections: [{
      columns: [{ label: 'Date' }, { label: 'Truck' }, { label: 'Net lb', format: 'int' }, { label: 'Dry bu', format: 'bu' }],
      rows: [
        ['9/24/2026', 'Kenworth, 12', 50000, 892.857],
        ['Total', '', 50000, 892.857],
      ],
      rowMeta: ['data', 'total'],
    }],
  }
  it('writes a header row, CRLF lines, and a trailing newline', () => {
    expect(buildCsv(payload)).toBe(
      'Date,Truck,Net lb,Dry bu\r\n9/24/2026,"Kenworth, 12",50000,893\r\nTotal,,50000,893\r\n',
    )
  })
  it('a subhead row collapses to its label; later sections get a blank line and a title', () => {
    const multi: ExportPayload = {
      title: 'Two',
      sections: [
        { title: 'A', columns: [{ label: 'X' }], rows: [['group', ''], ['1']], rowMeta: ['subhead', 'data'] },
        { title: 'B', columns: [{ label: 'Y' }], rows: [['2']] },
      ],
    }
    expect(buildCsv(multi)).toBe('A\r\nX\r\ngroup\r\n1\r\n\r\nB\r\nY\r\n2\r\n')
  })
})
