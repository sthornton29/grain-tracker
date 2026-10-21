import { describe, it, expect } from 'vitest'
import {
  bandOf, bandsFor, baseOrBetterOnLoanFactors, bucketOf, coarseBuckets, colorCodesAndBetter, colorGradeInfo, colorGridCode,
  colorQuadrant, extraneousInfo, factorBuckets, factorText, factorValue, lengthCategory, loanPoints, PRICE_BANDS, remarksInfo,
  stapleInches, strengthCategory, uniformityCategory, COLOR_GRID_ROWS, COLOR_GRID_COLUMNS, type GradeLike,
} from '@/lib/cotton-quality'

// The ONE quality reference: codes, categories and the 2026 price bands —
// hand-checked against the 2026-crop FSA loan schedule (page 3) and the
// USDA classing code lists.

const grade = (over: Partial<GradeLike> = {}): GradeLike => ({
  color_grade: '31', leaf_grade: '3', staple_32nds: 37, micronaire: 4.3, strength_g_tex: 29.5, uniformity_pct: 81.0,
  extraneous: null, remarks: null, rd: 77.7, plus_b: 8.7, composite_grade: '31-2', trash_pct: 3, length_100ths: 113, loan_value_cents_per_lb: 59.9,
  ...over,
})

describe('color grades', () => {
  it('maps codes to names, groups and grid positions', () => {
    expect(colorGradeInfo('41')).toMatchObject({ name: 'Strict Low Middling', symbol: 'SLM', group: 'white', row: 4, column: 1 })
    expect(colorGradeInfo('32')).toMatchObject({ group: 'light_spotted', row: 3, column: 2 })
    expect(colorGradeInfo('24')).toMatchObject({ group: 'tinged', row: 2, column: 4 })
    expect(colorGradeInfo('35')).toMatchObject({ group: 'yellow_stained', row: 3, column: 5 })
    expect(colorGradeInfo('83')).toMatchObject({ group: 'below_grade', row: 8, column: 3 })
    expect(colorGradeInfo('97')).toMatchObject({ name: 'Fire damaged', group: 'special', row: null })
    expect(colorGradeInfo('31-2')?.code).toBe('31') // composite grades carry the code first
    expect(colorGradeInfo('14')).toBeNull() // no tinged grade 1
    expect(colorGradeInfo(null)).toBeNull()
  })
  it('the grid has 8 rows × 5 columns with holes where USDA has no grade', () => {
    expect(COLOR_GRID_ROWS).toHaveLength(8)
    expect(COLOR_GRID_COLUMNS).toHaveLength(5)
    expect(colorGridCode(1, 1)).toBe('11')
    expect(colorGridCode(1, 4)).toBeNull()
    expect(colorGridCode(2, 5)).toBe('25')
    expect(colorGridCode(4, 5)).toBeNull()
    expect(colorGridCode(7, 2)).toBeNull()
    expect(colorGridCode(8, 5)).toBe('85')
  })
  it('"41 and better" = the white grades 11/21/31/41; "31 and better" = 11/21/31', () => {
    expect(colorCodesAndBetter('41')).toEqual(['11', '21', '31', '41'])
    expect(colorCodesAndBetter('31')).toEqual(['11', '21', '31'])
    expect(colorCodesAndBetter('22')).toEqual(['12', '22'])
    expect(colorCodesAndBetter('81')).toEqual([])
  })
  it('the color quadrant is the composite grade suffix', () => {
    expect(colorQuadrant('31-2')).toBe(2)
    expect(colorQuadrant('41-1')).toBe(1)
    expect(colorQuadrant('31')).toBeNull()
  })
})

describe('leaf, staple, length, strength, uniformity, extraneous, remarks', () => {
  it('staple in 32nds reads as the trade writes inches', () => {
    expect(stapleInches(34)).toBe('1-1/16')
    expect(stapleInches(36)).toBe('1-1/8')
    expect(stapleInches(37)).toBe('1-5/32')
    expect(stapleInches(38)).toBe('1-3/16')
    expect(stapleInches(40)).toBe('1-1/4')
    expect(stapleInches(32)).toBe('1')
    expect(stapleInches(31)).toBe('31/32')
  })
  it('UHML categories', () => {
    expect(lengthCategory(98)).toBe('short')
    expect(lengthCategory(99)).toBe('medium')
    expect(lengthCategory(110)).toBe('medium')
    expect(lengthCategory(111)).toBe('long')
    expect(lengthCategory(126)).toBe('long')
    expect(lengthCategory(127)).toBe('extra_long')
  })
  it('USDA strength and uniformity categories at tenths', () => {
    expect(strengthCategory(23.4)).toBe('weak')
    expect(strengthCategory(23.5)).toBe('intermediate')
    expect(strengthCategory(25.5)).toBe('average')
    expect(strengthCategory(28.5)).toBe('strong')
    expect(strengthCategory(30.4)).toBe('strong')
    expect(strengthCategory(30.5)).toBe('very_strong')
    expect(uniformityCategory(76.4)).toBe('very_low')
    expect(uniformityCategory(76.5)).toBe('low')
    expect(uniformityCategory(79.5)).toBe('average')
    expect(uniformityCategory(82.5)).toBe('high')
    expect(uniformityCategory(85.5)).toBe('very_high')
  })
  it('extraneous matter and remarks codes', () => {
    expect(extraneousInfo('11')).toMatchObject({ kind: 'bark', level: 1, label: 'Bark (level 1)' })
    expect(extraneousInfo('72')).toMatchObject({ kind: 'plastic', level: 2 })
    expect(extraneousInfo('02')).toMatchObject({ kind: 'prep', level: 2 })
    expect(extraneousInfo('2')).toMatchObject({ kind: 'prep', level: 2 }) // an unpadded "02"
    expect(extraneousInfo('')).toBeNull()
    expect(extraneousInfo('0')).toBeNull()
    expect(remarksInfo('76')?.label).toBe('Reginned')
    expect(remarksInfo('77')?.label).toBe('Repacked')
    expect(remarksInfo(null)).toBeNull()
  })
})

describe('2026 price bands (FSA loan schedule, page 3)', () => {
  it('mic: ≤3.4 discount · 3.5–3.6 base · 3.7–4.2 premium (+10) · 4.3–4.9 base · ≥5.0 discount', () => {
    expect(bandOf('mic', 3.4, 2026)).toBe('discount')
    expect(bandOf('mic', 3.5, 2026)).toBe('base')
    expect(bandOf('mic', 3.7, 2026)).toBe('premium')
    expect(bandOf('mic', 4.2, 2026)).toBe('premium')
    expect(bandOf('mic', 4.3, 2026)).toBe('base')
    expect(bandOf('mic', 4.9, 2026)).toBe('base')
    expect(bandOf('mic', 5.0, 2026)).toBe('discount')
    expect(loanPoints('mic', 4.0, 2026)).toBe(10)
    expect(loanPoints('mic', 5.1, 2026)).toBe(-280)
    expect(loanPoints('mic', 2.4, 2026)).toBe(-1785)
    expect(coarseBuckets(bandsFor(2026).mic, 'mic').map((b) => [b.label, b.band])).toEqual([
      ['≤ 3.4', 'discount'], ['3.5–3.6', 'base'], ['3.7–4.2', 'premium'], ['4.3–4.9', 'base'], ['≥ 5.0', 'discount'],
    ])
  })
  it('strength: <26.0 discount · 26.0–28.9 base · ≥29.0 premium with the 29 / 30 / 31–32.9 / 33+ sub-bands', () => {
    expect(bandOf('strength', 25.9, 2026)).toBe('discount')
    expect(bandOf('strength', 26.0, 2026)).toBe('base')
    expect(bandOf('strength', 28.9, 2026)).toBe('base')
    expect(bandOf('strength', 29.0, 2026)).toBe('premium')
    expect(loanPoints('strength', 29.5, 2026)).toBe(5)
    expect(loanPoints('strength', 30.1, 2026)).toBe(20)
    expect(loanPoints('strength', 31.0, 2026)).toBe(40)
    expect(loanPoints('strength', 33.0, 2026)).toBe(40)
    expect(loanPoints('strength', 17.9, 2026)).toBe(-700)
    expect(loanPoints('strength', 25.0, 2026)).toBe(-510)
    expect(factorBuckets('strength', 2026, 'fine')).toHaveLength(16)
  })
  it('uniformity: <80.0 discount · 80.0–81.9 base · ≥82.0 premium', () => {
    expect(bandOf('uniformity', 79.9, 2026)).toBe('discount')
    expect(bandOf('uniformity', 80.0, 2026)).toBe('base')
    expect(bandOf('uniformity', 81.9, 2026)).toBe('base')
    expect(bandOf('uniformity', 82.0, 2026)).toBe('premium')
    expect(loanPoints('uniformity', 77.9, 2026)).toBe(-100)
    expect(loanPoints('uniformity', 79.0, 2026)).toBe(-70)
    expect(loanPoints('uniformity', 83.5, 2026)).toBe(15)
    expect(loanPoints('uniformity', 86.0, 2026)).toBe(35)
  })
  it('color / leaf / staple band against the loan base 41-4-34', () => {
    expect(bandOf('color', '31', 2026)).toBe('premium')
    expect(bandOf('color', '41', 2026)).toBe('base')
    expect(bandOf('color', '42', 2026)).toBe('discount')
    expect(bandOf('color', '51', 2026)).toBe('discount')
    expect(bandOf('leaf', 3, 2026)).toBe('premium')
    expect(bandOf('leaf', 4, 2026)).toBe('base')
    expect(bandOf('leaf', 5, 2026)).toBe('discount')
    expect(bandOf('staple', 35, 2026)).toBe('premium')
    expect(bandOf('staple', 34, 2026)).toBe('base')
    expect(bandOf('staple', 33, 2026)).toBe('discount')
    expect(bandOf('extraneous', '11', 2026)).toBe('discount')
    expect(bandOf('extraneous', null, 2026)).toBeNull()
  })
  it('readings compare at tenths; a stored 4.25 lands where 4.3 would', () => {
    expect(bucketOf('mic', 4.25, 2026)?.label).toBe('4.3–4.9')
    expect(bucketOf('mic', 4.24, 2026)?.label).toBe('3.7–4.2')
    expect(bucketOf('strength', 28.95, 2026)?.band).toBe('premium')
  })
  it('a crop year without its own entry reads the newest schedule at or before it', () => {
    expect(bandsFor(2027).cropYear).toBe(2026)
    expect(bandsFor(2025).cropYear).toBe(2026) // nothing earlier is entered
    PRICE_BANDS[2027] = { ...PRICE_BANDS[2026], cropYear: 2027, mic: PRICE_BANDS[2026].mic.map((b) => (b.key === 'mic_37_42' ? { ...b, band: 'base' as const, points: 0 } : b)) }
    try {
      expect(bandsFor(2027).cropYear).toBe(2027)
      expect(bandOf('mic', 4.0, 2027)).toBe('base') // the new year's entry decides, nothing else changed
      expect(bandOf('mic', 4.0, 2026)).toBe('premium')
    } finally {
      delete PRICE_BANDS[2027]
    }
  })
})

describe('factors', () => {
  it('reads every factor off a classing row and formats it', () => {
    const g = grade()
    expect(factorValue(g, 'color')).toBe('31')
    expect(factorValue(g, 'leaf')).toBe(3)
    expect(factorValue(g, 'quadrant')).toBe('2')
    expect(factorValue(g, 'loan')).toBe(59.9)
    expect(factorValue(grade({ extraneous: '11' }), 'extraneous')).toBe('11')
    expect(factorText('color', '31')).toBe('31 M')
    expect(factorText('staple', 37)).toBe('37 (1-5/32")')
    expect(factorText('length', 113)).toBe('1.13"')
    expect(factorText('mic', 4.3)).toBe('4.30')
    expect(factorText('mic', null)).toBe('—')
  })
  it('base-or-better on all loan factors', () => {
    expect(baseOrBetterOnLoanFactors(grade(), 2026)).toBe(true)
    expect(baseOrBetterOnLoanFactors(grade({ leaf_grade: '5' }), 2026)).toBe(false)
    expect(baseOrBetterOnLoanFactors(grade({ micronaire: 5.0 }), 2026)).toBe(false)
    expect(baseOrBetterOnLoanFactors(grade({ micronaire: null }), 2026)).toBe(false)
  })
  it('non-banded factors distribute over descriptive ranges with no band', () => {
    expect(bucketOf('length', 113, 2026)).toMatchObject({ label: 'Long (1.11–1.26")', band: null })
    expect(bucketOf('rd', 77.7, 2026)?.label).toBe('75–79.9')
    expect(bucketOf('loan', 59.9, 2026)?.label).toBe('55–59.99¢')
    expect(bucketOf('remarks', '77', 2026)?.label).toBe('Repacked')
  })
})
