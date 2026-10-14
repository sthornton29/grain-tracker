import { describe, it, expect } from 'vitest'
import {
  abs, add, cell, col, columnLetters, div, eq, evaluateData, evaluateFormula, FormulaError, iferror, iff, le, lt, mul, num,
  round, rows, self, str, sub, sum, sumifs, toExcelFormula,
  type FormulaData, type FormulaLayout,
} from '@/lib/formula'

// The formula seam: one expression tree renders to a bounded A1 formula AND
// evaluates in TypeScript, so an audit workbook's numbers can be proven equal
// to the app's before Excel ever opens the file.

const layout: FormulaLayout = {
  loads: { sheetName: 'Load Data', firstRow: 2, rowCount: 3, columns: { key: 'A', net: 'B', pct: 'C', dry: 'D', practice: 'E' } },
  fields: { sheetName: 'Field Production', firstRow: 2, rowCount: 2, columns: { key: 'A', bu: 'B', acres: 'C', yield: 'D' } },
}

describe('columnLetters', () => {
  it('maps 1-based indexes to Excel letters', () => {
    expect(columnLetters(1)).toBe('A')
    expect(columnLetters(26)).toBe('Z')
    expect(columnLetters(27)).toBe('AA')
    expect(columnLetters(29)).toBe('AC')
    expect(columnLetters(52)).toBe('AZ')
    expect(columnLetters(53)).toBe('BA')
  })
})

describe('toExcelFormula — bounded, key-resolved references', () => {
  it('SUMIFS over another sheet resolves to absolute ranges sized to the rows', () => {
    const f = sumifs(col('loads', 'dry'), [col('loads', 'key'), self('key')])
    expect(toExcelFormula(f, { layout, at: { s: 'fields', r: 0 } }))
      .toBe("SUMIFS('Load Data'!$D$2:$D$4,'Load Data'!$A$2:$A$4,A2)")
  })
  it('same-sheet row references are relative and unqualified; literals are quoted', () => {
    const f = iff(le(self('net'), num(0)), str('none'), div(self('net'), num(56)))
    expect(toExcelFormula(f, { layout, at: { s: 'loads', r: 2 } })).toBe('IF(B4<=0,"none",B4/56)')
  })
  it('row slices and cross-sheet cells are absolute', () => {
    expect(toExcelFormula(sum(rows('fields', 'bu', 0, 1)), { layout, at: { s: 'fields', r: 1 } })).toBe('SUM($B$2:$B$3)')
    expect(toExcelFormula(cell('fields', 'bu', 1), { layout, at: { s: 'loads', r: 0 } })).toBe("'Field Production'!$B$3")
  })
  it('parenthesizes by precedence only where needed', () => {
    const wet = div(self('net'), num(56))
    const shrink = div(mul(wet, sub(num(100), self('pct'))), sub(num(100), num(15.5)))
    expect(toExcelFormula(shrink, { layout, at: { s: 'loads', r: 0 } })).toBe('B2/56*(100-C2)/(100-15.5)')
    expect(toExcelFormula(sub(num(1), sub(num(2), num(3))), { layout, at: { s: 'loads', r: 0 } })).toBe('1-(2-3)')
    expect(toExcelFormula(sub(sub(num(1), num(2)), num(3)), { layout, at: { s: 'loads', r: 0 } })).toBe('1-2-3')
    expect(toExcelFormula(mul(add(num(1), num(2)), num(3)), { layout, at: { s: 'loads', r: 0 } })).toBe('(1+2)*3')
  })
  it('ROUND / IFERROR / ABS render', () => {
    const f = iferror(round(abs(div(self('net'), self('pct'))), 2), num(0))
    expect(toExcelFormula(f, { layout, at: { s: 'loads', r: 0 } })).toBe('IFERROR(ROUND(ABS(B2/C2),2),0)')
  })
  it('a sheet name with an apostrophe is escaped', () => {
    const l: FormulaLayout = { x: { sheetName: "Smith's Farm", firstRow: 2, rowCount: 1, columns: { a: 'A' } }, y: { sheetName: 'Y', firstRow: 1, rowCount: 1, columns: { b: 'B' } } }
    expect(toExcelFormula(cell('x', 'a', 0), { layout: l, at: { s: 'y', r: 0 } })).toBe("'Smith''s Farm'!$A$2")
  })
  it('an unknown key or an out-of-range row throws with the key named', () => {
    expect(() => toExcelFormula(self('nope'), { layout, at: { s: 'loads', r: 0 } })).toThrow(/unknown column "nope"/)
    expect(() => toExcelFormula(col('nowhere', 'a'), { layout, at: { s: 'loads', r: 0 } })).toThrow(/unknown section "nowhere"/)
    expect(() => toExcelFormula(cell('fields', 'bu', 2), { layout, at: { s: 'loads', r: 0 } })).toThrow(/outside section/)
  })
})

describe('evaluateFormula — spreadsheet semantics', () => {
  const data: FormulaData = {
    loads: {
      columns: ['key', 'net', 'pct', 'dry', 'practice'],
      rows: [
        ['Home', 56000, 100, { f: div(mul(self('net'), self('pct')), num(5600)) }, 'Irrigated'],
        ['Home', 28000, 100, { f: div(mul(self('net'), self('pct')), num(5600)) }, 'dryland'],
        ['Moore', 5600, 50, { f: div(mul(self('net'), self('pct')), num(5600)) }, null],
      ],
    },
    fields: {
      columns: ['key', 'bu', 'acres', 'yield'],
      rows: [
        ['home', { f: sumifs(col('loads', 'dry'), [col('loads', 'key'), self('key')]) }, 10, { f: iferror(div(self('bu'), self('acres')), num(0)) }],
        ['Moore', { f: sumifs(col('loads', 'dry'), [col('loads', 'key'), self('key')]) }, 0, { f: iferror(div(self('bu'), self('acres')), num(0)) }],
      ],
    },
  }
  it('SUMIFS matches text case-insensitively and follows formula cells across sections', () => {
    const grid = evaluateData(data)
    expect(grid.loads[0][3]).toBe(1000)
    expect(grid.loads[2][3]).toBe(50)
    expect(grid.fields[0][1]).toBe(1500) // 'home' matches both 'Home' rows
    expect(grid.fields[1][1]).toBe(50)
  })
  it('a division by zero is an error that IFERROR catches', () => {
    const grid = evaluateData(data)
    expect(grid.fields[0][3]).toBe(150)
    expect(grid.fields[1][3]).toBe(0)
    const raw = evaluateFormula(div(num(1), num(0)), data, { s: 'loads', r: 0 })
    expect(raw).toBeInstanceOf(FormulaError)
    expect((raw as FormulaError).code).toBe('#DIV/0!')
  })
  it('blank cells read as 0 in arithmetic and comparisons', () => {
    const d: FormulaData = { s: { columns: ['a', 'b'], rows: [[null, 15.5]] } }
    expect(evaluateFormula(le(self('a'), self('b')), d, { s: 's', r: 0 })).toBe(true)
    expect(evaluateFormula(add(self('a'), num(2)), d, { s: 's', r: 0 })).toBe(2)
  })
  it('SUMIFS with a practice criterion only counts matching rows; SUM over a slice', () => {
    const f = sumifs(col('loads', 'dry'), [col('loads', 'key'), str('Home')], [col('loads', 'practice'), str('Irrigated')])
    expect(evaluateFormula(f, data, { s: 'fields', r: 0 })).toBe(1000)
    expect(evaluateFormula(sum(rows('loads', 'net', 0, 1)), data, { s: 'fields', r: 0 })).toBe(84000)
  })
  it('ROUND rounds half away from zero to the given decimals', () => {
    const d: FormulaData = { s: { columns: ['a'], rows: [[1.005], [-1.005], [2.5]] } }
    expect(evaluateFormula(round(self('a'), 2), d, { s: 's', r: 0 })).toBe(1.01)
    expect(evaluateFormula(round(self('a'), 2), d, { s: 's', r: 1 })).toBe(-1.01)
    expect(evaluateFormula(round(self('a'), 0), d, { s: 's', r: 2 })).toBe(3)
  })
  it('IF with text comparison and ABS', () => {
    const d: FormulaData = { s: { columns: ['a', 'b'], rows: [['ok', -3]] } }
    expect(evaluateFormula(iff(eq(self('a'), str('OK')), abs(self('b')), num(0)), d, { s: 's', r: 0 })).toBe(3)
    expect(evaluateFormula(iff(lt(abs(self('b')), num(0.5)), str('OK'), str('CHECK')), d, { s: 's', r: 0 })).toBe('CHECK')
  })
  it('a circular reference is reported, not looped', () => {
    const d: FormulaData = { s: { columns: ['a', 'b'], rows: [[{ f: self('b') }, { f: self('a') }]] } }
    expect(() => evaluateData(d)).toThrow(/circular/)
  })
})
