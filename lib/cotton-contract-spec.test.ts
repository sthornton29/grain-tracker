import { describe, it, expect } from 'vitest'
import {
  EMPTY_SPEC, evaluateBale, matchEligibleFarms, parseColorWording, parseExtraneousWording, parseMaxWording, parseMinWording,
  parseRangeWording, rulesFromWording, specFromRow, specSummaryLine, summarizeSpec,
  type ContractQualitySpec, type QualityTermsExtract, type SpecSummaryBale,
} from '@/lib/cotton-contract-spec'
import type { GradeLike } from '@/lib/cotton-quality'

// The VS&Co fixture (hand-verified): colors 11/21/31/41, leaf ≤ 3, staple
// ≥ 37, mic 4.0–4.7, strength ≥ 29.0, uniformity ≥ 80.0, the 16 Schedule A
// farms. Ten bales B1–B10.

export const VS_FARMS = ['252', '260', '280', '360', '366', '397', '406', '3309', '3910', '7282', '7283', '7557', '7558', '7559', '7560', '5824']

export const VS_SPEC: ContractQualitySpec = {
  ...EMPTY_SPEC,
  allowed_color_codes: ['11', '21', '31', '41'],
  leaf_max: 3, staple_min: 37, mic_min: 4.0, mic_max: 4.7, strength_min: 29.0, uniformity_min: 80.0,
  eligible_fsa_farms: VS_FARMS, bale_cap: 4250, estimated_bales: 6825, base_grade: '41-3-37', base_price_cents: 86,
}

export function g(color: string, leaf: number, staple: number, mic: number, strength: number, uniformity: number, over: Partial<GradeLike> = {}): GradeLike {
  return {
    color_grade: color, leaf_grade: String(leaf), staple_32nds: staple, micronaire: mic, strength_g_tex: strength, uniformity_pct: uniformity,
    extraneous: null, remarks: null, rd: 77, plus_b: 8.5, composite_grade: `${color}-1`, trash_pct: 3, length_100ths: 115, loan_value_cents_per_lb: 58,
    ...over,
  }
}

export const VS_BALES: SpecSummaryBale[] = [
  { id: 'B1', fsaNumber: '5824', practice: 'dryland', lbs: 500, grade: g('31', 2, 38, 4.4, 30.1, 81.5) },
  { id: 'B2', fsaNumber: '5824', practice: 'dryland', lbs: 480, grade: g('41', 3, 37, 4.0, 29.0, 80.0) },
  { id: 'B3', fsaNumber: '5824', practice: 'dryland', lbs: 495, grade: g('42', 3, 37, 4.3, 30.0, 81.0) },
  { id: 'B4', fsaNumber: '5824', practice: 'dryland', lbs: 510, grade: g('32', 2, 38, 4.5, 31.0, 82.0) },
  { id: 'B5', fsaNumber: '260', practice: 'dryland', lbs: 490, grade: g('31', 4, 37, 4.5, 29.5, 81.0) },
  { id: 'B6', fsaNumber: '260', practice: 'dryland', lbs: 505, grade: g('21', 2, 36, 4.2, 30.0, 82.0) },
  { id: 'B7', fsaNumber: '260', practice: 'dryland', lbs: 485, grade: g('31', 3, 38, 4.8, 29.2, 80.5) },
  { id: 'B8', fsaNumber: '260', practice: 'dryland', lbs: 470, grade: g('31', 3, 38, 3.9, 28.9, 79.9) },
  { id: 'B9', fsaNumber: '9999', practice: 'dryland', lbs: 500, grade: g('31', 2, 38, 4.4, 30.0, 81.0) },
  { id: 'B10', fsaNumber: '260', practice: 'dryland', lbs: 0, grade: null },
]

describe('evaluateBale — the VS&Co fixture', () => {
  const ev = (id: string) => evaluateBale(VS_SPEC, VS_BALES.find((b) => b.id === id)!)
  it('B1 meets; B2 meets on every inclusive boundary', () => {
    expect(ev('B1').status).toBe('meets')
    expect(ev('B2').status).toBe('meets')
  })
  it('B3 and B4 fail color (light spotted, strict reading)', () => {
    expect(ev('B3')).toEqual({ status: 'fails', failures: [{ factor: 'color', text: 'Color 42: strict low middling light spotted (needs 11/21/31/41)' }] })
    expect(ev('B4').failures.map((f) => f.factor)).toEqual(['color'])
  })
  it('B5 leaf, B6 staple, B7 mic, B8 mic + strength + uniformity', () => {
    expect(ev('B5').failures).toEqual([{ factor: 'leaf', text: 'Leaf 4 (needs 3 or better)' }])
    expect(ev('B6').failures).toEqual([{ factor: 'staple', text: 'Staple 36 (needs 37 or longer)' }])
    expect(ev('B7').failures).toEqual([{ factor: 'mic', text: 'Mic 4.8 (needs 4.0-4.7)' }])
    expect(ev('B8').failures).toEqual([
      { factor: 'mic', text: 'Mic 3.9 (needs 4.0-4.7)' },
      { factor: 'strength', text: 'Strength 28.9 (needs 29.0 or better)' },
      { factor: 'uniformity', text: 'Uniformity 79.9 (needs 80.0 or better)' },
    ])
  })
  it('B9 is not eligible (FSA 9999 not on Schedule A); B10 is not classed', () => {
    expect(ev('B9')).toEqual({ status: 'not_eligible', failures: [], reason: "farm 9999 not on the contract's farm list" })
    expect(ev('B10')).toEqual({ status: 'not_classed', failures: [] })
  })
  it('a missing value on a classed bale fails with "missing <factor>"', () => {
    const r = evaluateBale(VS_SPEC, { fsaNumber: '260', practice: 'dryland', grade: g('31', 2, 38, 4.4, 30, 81, { micronaire: null, uniformity_pct: null }) })
    expect(r.failures.map((f) => f.text)).toEqual(['missing micronaire', 'missing uniformity'])
  })
  it('eligibility ignores leading zeros; no farm list = every farm eligible; dryland rule only when switched on', () => {
    expect(evaluateBale(VS_SPEC, { fsaNumber: '0260', practice: 'irrigated', grade: g('31', 2, 38, 4.4, 30, 81) }).status).toBe('meets')
    expect(evaluateBale({ ...VS_SPEC, eligible_fsa_farms: null }, { fsaNumber: '9999', practice: null, grade: g('31', 2, 38, 4.4, 30, 81) }).status).toBe('meets')
    expect(evaluateBale({ ...VS_SPEC, require_dryland: true }, { fsaNumber: '260', practice: 'irrigated', grade: g('31', 2, 38, 4.4, 30, 81) }))
      .toEqual({ status: 'not_eligible', failures: [], reason: 'irrigated (contract requires dryland)' })
    expect(evaluateBale({ ...VS_SPEC, require_dryland: true }, { fsaNumber: '260', practice: 'mixed', grade: g('31', 2, 38, 4.4, 30, 81) }).status).toBe('not_eligible')
  })
  it('extraneous-matter rules and excluded remarks', () => {
    const bark1 = g('31', 2, 38, 4.4, 30, 81, { extraneous: '11' })
    const bark2 = g('31', 2, 38, 4.4, 30, 81, { extraneous: '12' })
    expect(evaluateBale(VS_SPEC, { fsaNumber: '260', practice: null, grade: bark2 }).status).toBe('meets') // rule 'any'
    expect(evaluateBale({ ...VS_SPEC, extraneous_rule: 'level1_ok' }, { fsaNumber: '260', practice: null, grade: bark1 }).status).toBe('meets')
    expect(evaluateBale({ ...VS_SPEC, extraneous_rule: 'level1_ok' }, { fsaNumber: '260', practice: null, grade: bark2 }).failures[0].text).toBe('Bark (level 2) (level 2 not allowed)')
    expect(evaluateBale({ ...VS_SPEC, extraneous_rule: 'none' }, { fsaNumber: '260', practice: null, grade: bark1 }).failures[0].factor).toBe('extraneous')
    const repacked = g('31', 2, 38, 4.4, 30, 81, { remarks: '77' })
    expect(evaluateBale({ ...VS_SPEC, excluded_remarks: ['77'] }, { fsaNumber: '260', practice: null, grade: repacked }).failures[0].text).toBe('Repacked (remark 77 excluded)')
  })
})

describe('summarizeSpec — headline, Pareto, projection', () => {
  it('eligible classed 8; meets 2 = 25.0% by bales, 24.9% by lbs; 1 not eligible; 1 not classed', () => {
    const s = summarizeSpec(VS_SPEC, VS_BALES)
    expect(s.eligibleClassed).toBe(8)
    expect(s.meets).toBe(2)
    expect(s.fails).toBe(6)
    expect(s.notEligible).toBe(1)
    expect(s.notClassed).toBe(1)
    expect(s.passRate).toBeCloseTo(0.25, 9)
    expect(s.meetsLbs).toBe(980)
    expect(s.eligibleClassedLbs).toBe(3935)
    expect(Math.round(s.passRateLbs! * 1000) / 10).toBe(24.9)
  })
  it('Pareto: color 2, mic 2, leaf 1, staple 1, strength 1, uniformity 1; fails only one factor: 5', () => {
    const s = summarizeSpec(VS_SPEC, VS_BALES)
    expect(s.pareto.map((p) => [p.factor, p.bales, p.onlyThis])).toEqual([
      ['color', 2, 2], ['mic', 2, 1], ['leaf', 1, 1], ['staple', 1, 1], ['strength', 1, 0], ['uniformity', 1, 0],
    ])
    expect(s.singleFactorFails).toBe(5)
  })
  it('ticking 12 / 22 / 32 lets B4 through: 3 of 8 = 37.5%', () => {
    const s = summarizeSpec({ ...VS_SPEC, allowed_color_codes: [...VS_SPEC.allowed_color_codes!, '12', '22', '32'] }, VS_BALES)
    expect(s.meets).toBe(3)
    expect(s.passRate).toBeCloseTo(0.375, 9)
    expect(s.evaluations.get('B4')?.status).toBe('meets')
    expect(s.evaluations.get('B3')?.status).toBe('fails')
  })
  it('projection: 25.0% × 6,825 = 1,706 vs the 4,250 cap; the app estimate is the fallback', () => {
    const s = summarizeSpec(VS_SPEC, VS_BALES)
    expect(s.projection).toEqual({ estimatedBales: 6825, estimateSource: 'contract', projected: 1706 })
    expect(s.cap).toBe(4250)
    const noEstimate = summarizeSpec({ ...VS_SPEC, estimated_bales: null }, VS_BALES, { appEstimatedBales: 5000.4 })
    expect(noEstimate.projection).toEqual({ estimatedBales: 5000, estimateSource: 'app', projected: 1250 })
    expect(summarizeSpec({ ...VS_SPEC, estimated_bales: null }, VS_BALES).projection).toBeNull()
  })
})

describe('wording → rules (code, never the model)', () => {
  const vs: QualityTermsExtract = {
    quality_clause: 'Acceptable cotton is cotton grown with approved practices with fiber quality as follows: Color 41 and better, leaf 3 and better, staple 37 and longer, micronaire 4.0-4.7, strength 29 grams per tex and better, uniformity 80 and better.',
    color: 'Color 41 and better', leaf: 'leaf 3 and better', staple: 'staple 37 and longer', micronaire: 'micronaire 4.0-4.7',
    strength: 'strength 29 grams per tex and better', uniformity: 'uniformity 80 and better', extraneous_matter: null,
    eligible_farms: VS_FARMS.map((f) => ({ fsa_number: f, county: 'Lawrence', planted_acres: null, aph_yield: null, aph_est_bales: null, trendline_est_bales: null })),
    bale_cap: 4250, estimated_bales: 6825, base_grade: '41-3-37', base_price_cents_per_lb: 86,
    off_spec_terms: 'BUYER may, at their discretion, agree to accept bales outside of these specifications at a lower price.',
    other_deliverables: 'rain-fed cotton, from women-owned farms, using regenerative practices', practice_requirement: null,
  }
  it('the six VS&Co phrases map to the fixture spec', () => {
    const { spec, notUnderstood } = rulesFromWording(vs)
    expect(notUnderstood).toEqual([])
    expect(spec.allowed_color_codes).toEqual(['11', '21', '31', '41'])
    expect(spec.leaf_max).toBe(3)
    expect(spec.staple_min).toBe(37)
    expect(spec.mic_min).toBe(4.0)
    expect(spec.mic_max).toBe(4.7)
    expect(spec.strength_min).toBe(29)
    expect(spec.uniformity_min).toBe(80)
    expect(spec.extraneous_rule).toBe('any')
    expect(spec.eligible_fsa_farms).toEqual(VS_FARMS)
    expect(spec.schedule).toHaveLength(16)
    expect(spec.bale_cap).toBe(4250)
    expect(spec.estimated_bales).toBe(6825)
    expect(spec.base_price_cents).toBe(86)
    expect(spec.require_dryland).toBe(false)
    expect(spec.other_terms).toContain('rain-fed')
    expect(spec.source_clause).toContain('Acceptable cotton')
  })
  it('"31 and better" → 11/21/31; an explicit list is taken as written', () => {
    expect(parseColorWording('31 and better')).toEqual(['11', '21', '31'])
    expect(parseColorWording('Color grades 11, 21, 31, 41 and 32')).toEqual(['11', '21', '31', '41', '32'])
    expect(parseColorWording('white grades only')).toEqual(['11', '21', '31', '41', '51', '61', '71'])
  })
  it('an unknown phrase lands as "not understood" with the verbatim text', () => {
    const r = rulesFromWording({ ...vs, color: 'bright and clean', micronaire: 'as classed by USDA', strength: 'good' })
    expect(r.notUnderstood).toEqual([
      { factor: 'Color', text: 'bright and clean' },
      { factor: 'Micronaire', text: 'as classed by USDA' },
      { factor: 'Strength', text: 'good' },
    ])
    expect(r.spec.allowed_color_codes).toBeNull()
    expect(r.spec.mic_min).toBeNull()
    expect(r.spec.strength_min).toBeNull()
    expect(r.spec.leaf_max).toBe(3) // the understood ones still land
  })
  it('a practice requirement is reported, never switched on from wording', () => {
    const r = rulesFromWording({ ...vs, practice_requirement: 'rain-fed (dryland) cotton only' })
    expect(r.spec.require_dryland).toBe(false)
    expect(r.notUnderstood[0].text).toBe('rain-fed (dryland) cotton only')
  })
  it('the individual parsers', () => {
    expect(parseMaxWording('leaf 3 and better')).toBe(3)
    expect(parseMaxWording('maximum leaf 4')).toBe(4)
    expect(parseMaxWording('3')).toBe(3)
    expect(parseMaxWording('clean')).toBeNull()
    expect(parseMinWording('staple 37 and longer')).toBe(37)
    expect(parseMinWording('minimum 36')).toBe(36)
    expect(parseMinWording('80%')).toBe(80)
    expect(parseMinWording('30 and below')).toBeNull()
    expect(parseRangeWording('4.0-4.7')).toEqual({ min: 4.0, max: 4.7 })
    expect(parseRangeWording('3.5 to 4.9')).toEqual({ min: 3.5, max: 4.9 })
    expect(parseRangeWording('micronaire 3.7 and above')).toEqual({ min: 3.7, max: null })
    expect(parseRangeWording('4.9 and below')).toEqual({ min: null, max: 4.9 })
    expect(parseRangeWording('normal')).toBeNull()
    expect(parseExtraneousWording('no extraneous matter')).toBe('none')
    expect(parseExtraneousWording('level 1 bark allowed')).toBe('level1_ok')
    expect(parseExtraneousWording('reasonable')).toBeNull()
  })
})

describe('eligible farms ↔ Turnrow farms, row ↔ spec, summary line', () => {
  it('matches by FSA number (digits, leading zeros ignored), lists unmatched numbers, both farms on a shared number', () => {
    const farms = [
      { id: 'a', name: 'Lamon', fsa_number: '5824' }, { id: 'b', name: 'Wheeler', fsa_number: '5824' },
      { id: 'c', name: 'Goode Farm', fsa_number: '0252' }, { id: 'd', name: 'Old', fsa_number: '260', archived_at: '2026-01-01' },
    ]
    const r = matchEligibleFarms(['252', '260', '5824', '9999'], farms)
    expect(r.matched.map((m) => [m.fsa, m.farms.map((f) => f.name)])).toEqual([['252', ['Goode Farm']], ['5824', ['Lamon', 'Wheeler']]])
    expect(r.unmatched).toEqual(['260', '9999'])
  })
  it('specFromRow tolerates numeric strings and nulls', () => {
    const s = specFromRow({ allowed_color_codes: ['41'], leaf_max: '3', mic_min: '4.0', mic_max: null, extraneous_rule: 'bogus', require_dryland: null, schedule: [{ fsa_number: '252' }] })!
    expect(s.leaf_max).toBe(3)
    expect(s.mic_min).toBe(4)
    expect(s.mic_max).toBeNull()
    expect(s.extraneous_rule).toBe('any')
    expect(s.require_dryland).toBe(false)
    expect(s.schedule).toHaveLength(1)
    expect(specFromRow(null)).toBeNull()
  })
  it('the one-line summary', () => {
    expect(specSummaryLine(VS_SPEC)).toBe('Color 11/21/31/41 · leaf ≤ 3 · staple ≥ 37 · mic 4.0–4.7 · strength ≥ 29.0 · uniformity ≥ 80.0')
  })
})
