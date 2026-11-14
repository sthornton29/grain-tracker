import { describe, expect, it } from 'vitest'
import { parseGradeCsv, planGradeImport, gradeDiffs, type GradeValues } from './cotton-grades'

// The 2026-11-14 shape: the Servico "2nd run" export repeats the 1st run's bales.
const HEAD = 'Date Classing Imported: 2026-11-14 Producer: 25 TWO SEASO\r\n\r\nBale #,NetWt,Prod,Farm,Field ID,Date Ginned,Pk,Gr,Lf,St,Mic,Ex,Rm,Str,Cgr,Rd,_B,Tr,Unif,Len,Total Value\r\n'
const line = (pbi: string, mic = '4.4', wt = '523') => `${pbi},${wt},25 TWO SEASO,406,BOOTLEGGERS,11/04/2026,1,31,4,39,${mic},,,30.8,31-3,74.7,9.2,7,82.9,123,306.22\r\n`
const rowsOf = (body: string) => parseGradeCsv(HEAD + body + 'Total Bales: 9,Total lbs: 1\r\n').rows
const bale = (id: string, pbi: string, crop_year = 2026) => ({ id, pbi_number: pbi, net_weight_lbs: 523, crop_year })
const savedOf = (r: ReturnType<typeof rowsOf>[number], over: Partial<GradeValues> = {}): GradeValues => ({ ...r, ...over })

describe('classing import plan — one bucket per row, keyed by the bale', () => {
  const bales = [bale('a', '192848'), bale('b', '192849'), bale('c', '192850'), bale('d', '192851')]

  it('new bales save; a bale already graded with the same values is skipped, even with a newer class date', () => {
    const rows = rowsOf(line('192848') + line('192849'))
    const saved = new Map([['b', savedOf(rows[1], { /* first run */ })]])
    const p = planGradeImport(rows, bales, saved)
    expect(p.new.map((m) => m.bale.id)).toEqual(['a'])
    expect(p.unchanged.map((m) => m.bale.id)).toEqual(['b'])
    expect(p.changed).toEqual([])
  })

  it('a saved grade that differs is "changed" with the differing fields named', () => {
    const rows = rowsOf(line('192848', '4.6'))
    const p = planGradeImport(rows, bales, new Map([['a', savedOf(rows[0], { micronaire: 4.4 })]]))
    expect(p.changed).toHaveLength(1)
    expect(p.changed[0].diffs).toEqual(['Mic 4.4 → 4.6'])
  })

  it('a bale repeated in the file: identical copies keep one; conflicting copies are all held out', () => {
    const p = planGradeImport(rowsOf(line('192848') + line('192848') + line('192849') + line('0192849', '3.9')), bales, new Map())
    expect(p.new.map((m) => m.bale.id)).toEqual(['a'])
    expect(p.repeatedSame).toHaveLength(1)
    expect(p.repeatedConflict).toHaveLength(1)
    expect(p.repeatedConflict[0].rows).toHaveLength(2)
  })

  it('the 12-digit tag and the bale number are the same bale', () => {
    const p = planGradeImport(rowsOf(line('192850') + line('406140192850')), [{ ...bales[2], gin_code: '40614' }], new Map())
    expect(p.new).toHaveLength(1)
    expect(p.repeatedSame).toHaveLength(1)
  })

  it('no bale this crop year: unmatched, or named as another year when that year has it; unmatched repeats collapse', () => {
    const p = planGradeImport(rowsOf(line('555') + line('555') + line('192851')), [], new Map(), [bale('d', '192851', 2025)])
    expect(p.otherYear).toEqual([expect.objectContaining({ cropYear: 2025 })])
    expect(p.unmatched.map((r) => r.pbi_number)).toEqual(['555'])
    expect(p.repeatedSame).toHaveLength(1)
  })

  it('every row lands in exactly one bucket', () => {
    const rows = rowsOf(line('192848') + line('192848') + line('192849', '4.0') + line('192850') + line('9'))
    const p = planGradeImport(rows, bales, new Map([['c', savedOf(rows[3])], ['b', savedOf(rows[2], { micronaire: 4.1 })]]))
    const n = p.new.length + p.unchanged.length + p.changed.length + p.repeatedSame.length + p.repeatedConflict.reduce((s, c) => s + c.rows.length, 0) + p.unmatched.length + p.otherYear.length
    expect(n).toBe(rows.length)
  })

  it('gradeDiffs: numbers compare by value, text ignores case, blanks match blanks', () => {
    expect(gradeDiffs({ micronaire: '4.40', color_grade: '31', remarks: null }, { micronaire: 4.4, color_grade: '31 ', remarks: '' })).toEqual([])
  })
})
