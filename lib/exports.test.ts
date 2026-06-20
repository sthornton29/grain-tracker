import { describe, it, expect } from 'vitest'
import { formatNumber, excelNumFmt, defaultFilename, type NumFmt } from '@/lib/exports'

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

describe('defaultFilename', () => {
  it('slugs the title and appends an ISO date', () => {
    expect(defaultFilename('Crop Insurance Claims Monitor')).toMatch(/^crop-insurance-claims-monitor-\d{4}-\d{2}-\d{2}$/)
    expect(defaultFilename('ARC/PLC Decision Aid')).toMatch(/^arc-plc-decision-aid-\d{4}-\d{2}-\d{2}$/)
  })
})
