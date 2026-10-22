import { describe, it, expect } from 'vitest'
import {
  applyFilters, buildBaleRows, classWeekOf, colorGrid, comparisonRows, contractView, distribution, EMPTY_FILTERS, factorAverage, factorDetail,
  groupRows, kpis, rowsInBin, varietyOfPlanting, committedElsewhere, type BaleQualityInputs, type BaleRow,
} from '@/lib/bale-quality-report'
import { buildBaleQualityPdfPayload, buildBaleQualityWorkbook, buildQualifyingBalesWorkbook, SECTION, SPEC_ROW, kpiCards } from '@/lib/bale-quality-export'
import { evaluatePayload, formulaTextOf, payloadHasFormulas, formulaLayout, type ExportPayload } from '@/lib/exports'
import { toExcelFormula } from '@/lib/formula'
import { g, VS_SPEC } from '@/lib/cotton-contract-spec.test'
import type { GradeLike } from '@/lib/cotton-quality'

// The hand-verified VS&Co fixture, wired through the real chain: bale → gin
// receipt → farm / field / entity / gin → planting (practice, varieties) →
// classing row → disposition.

const grade = (id: string, gr: GradeLike): BaleQualityInputs['grades'][number] => ({ ...gr, bale_id: id, class_date: '2026-10-14', loan_value_total: Number(gr.loan_value_cents_per_lb) * 5 })

export function fixture(): BaleQualityInputs {
  return {
    cropYear: 2026,
    entities: [{ id: 'E1', name: 'Turnrow' }, { id: 'E2', name: 'Two Seasons Farm, LLC' }, { id: 'E3', name: 'Somebody Else' }],
    farms: [
      { id: 'F1', name: 'Lamon', entity_id: 'E1', fsa_number: '5824' },
      { id: 'F2', name: 'Ashford South', entity_id: 'E2', fsa_number: '260' },
      { id: 'F3', name: 'Far Away', entity_id: 'E3', fsa_number: '9999' },
    ],
    fields: [
      { id: 'FL1', farm_id: 'F1', name_or_number: 'Wheeler Pivot' },
      { id: 'FL2', farm_id: 'F2', name_or_number: 'Ashford Sherrill' },
      { id: 'FL3', farm_id: 'F3', name_or_number: 'Back 40' },
    ],
    crops: [{ id: 'C1', name: 'Cotton' }, { id: 'C2', name: 'Corn' }],
    plantings: [
      { id: 'P1', field_id: 'FL1', crop_id: 'C1', season_year: 2026, irrigated_acres: 205, dryland_acres: 44.88 },
      { id: 'P2', field_id: 'FL2', crop_id: 'C1', season_year: 2026, irrigated_acres: 0, dryland_acres: 36.1 },
      { id: 'P3', field_id: 'FL3', crop_id: 'C2', season_year: 2026, irrigated_acres: 0, dryland_acres: 100 }, // corn — not the cotton planting
    ],
    varieties: [
      { planting_id: 'P1', variety: 'DP 2239' }, { planting_id: 'P1', variety: 'DP 2131' },
      { planting_id: 'P2', variety: 'DP 1646' },
    ],
    gins: [{ id: 'G1', name: 'Servico, Inc.' }],
    receipts: [
      { id: 'R1', gin_id: 'G1', receipt_number: '40614-20261010-5824-PIVOT', receipt_date: '2026-10-10', entity_id: 'E1', farm_id: 'F1', field_id: 'FL1' },
      { id: 'R2', gin_id: 'G1', receipt_number: 'NA-NODATE-260-SHERRILL', receipt_date: null, entity_id: null, farm_id: 'F2', field_id: 'FL2' },
      { id: 'R3', gin_id: null, receipt_number: 'X', receipt_date: '2026-10-12', entity_id: null, farm_id: 'F3', field_id: 'FL3' },
    ],
    bales: [
      { id: 'B1', gin_receipt_id: 'R1', crop_year: 2026, pbi_number: '181001', net_weight_lbs: 500 },
      { id: 'B2', gin_receipt_id: 'R1', crop_year: 2026, pbi_number: '181002', net_weight_lbs: 480 },
      { id: 'B3', gin_receipt_id: 'R1', crop_year: 2026, pbi_number: '181003', net_weight_lbs: 495 },
      { id: 'B4', gin_receipt_id: 'R1', crop_year: 2026, pbi_number: '181004', net_weight_lbs: 510 },
      { id: 'B5', gin_receipt_id: 'R2', crop_year: 2026, pbi_number: '181005', net_weight_lbs: 490 },
      { id: 'B6', gin_receipt_id: 'R2', crop_year: 2026, pbi_number: '181006', net_weight_lbs: 505 },
      { id: 'B7', gin_receipt_id: 'R2', crop_year: 2026, pbi_number: '181007', net_weight_lbs: 485 },
      { id: 'B8', gin_receipt_id: 'R2', crop_year: 2026, pbi_number: '181008', net_weight_lbs: 470 },
      { id: 'B9', gin_receipt_id: 'R3', crop_year: 2026, pbi_number: '181009', net_weight_lbs: 500 },
      { id: 'B10', gin_receipt_id: 'R2', crop_year: 2026, pbi_number: '181010', net_weight_lbs: 490 },
      { id: 'B0', gin_receipt_id: 'R2', crop_year: 2025, pbi_number: '170001', net_weight_lbs: 490 }, // another crop year
    ],
    grades: [
      grade('B1', g('31', 2, 38, 4.4, 30.1, 81.5)),
      grade('B2', g('41', 3, 37, 4.0, 29.0, 80.0)),
      grade('B3', g('42', 3, 37, 4.3, 30.0, 81.0)),
      grade('B4', g('32', 2, 38, 4.5, 31.0, 82.0)),
      grade('B5', g('31', 4, 37, 4.5, 29.5, 81.0)),
      grade('B6', g('21', 2, 36, 4.2, 30.0, 82.0)),
      grade('B7', g('31', 3, 38, 4.8, 29.2, 80.5)),
      grade('B8', g('31', 3, 38, 3.9, 28.9, 79.9)),
      grade('B9', g('31', 2, 38, 4.4, 30.0, 81.0)),
    ],
    dispositions: [{ bale_id: 'B5', disposition: 'ccc_loan', contract_id: null, loan_id: 'L1' }, { bale_id: 'B6', disposition: 'contract_delivery', contract_id: 'OTHER', loan_id: null }],
    loanBales: [{ bale_id: 'B5', loan_id: 'L1' }],
  }
}

const rowsOf = () => buildBaleRows(fixture())
const byId = (rows: BaleRow[], id: string) => rows.find((r) => r.id === id)!

describe('buildBaleRows — the chain', () => {
  it('joins receipt → farm / field / entity / gin and the planting’s practice and variety; the other crop year is left out', () => {
    const rows = rowsOf()
    expect(rows).toHaveLength(10)
    const b1 = byId(rows, 'B1')
    expect(b1).toMatchObject({ pbi: '181001', lbs: 500, farmName: 'Lamon', fsa: '5824', fieldName: 'Wheeler Pivot', entityName: 'Turnrow', ginName: 'Servico, Inc.', practice: 'mixed', variety: 'Mixed (DP 2131 / DP 2239)', varietyMixed: true })
    expect(b1.receiptLabel).toBe('Servico, Inc. · 10/10 · Wheeler Pivot')
    const b5 = byId(rows, 'B5')
    expect(b5).toMatchObject({ practice: 'dryland', variety: 'DP 1646', varietyMixed: false, entityName: 'Two Seasons Farm, LLC', disposition: 'ccc_loan', loanId: 'L1' })
    expect(b5.entityId).toBe('E2') // the receipt has no entity; the farm's entity stands in
    const b9 = byId(rows, 'B9')
    expect(b9).toMatchObject({ practice: null, variety: null, ginName: 'No gin', fsa: '9999' })
    expect(byId(rows, 'B10').grade).toBeNull()
    expect(byId(rows, 'B10').classWeek).toBe('No class date')
    expect(byId(rows, 'B1').classWeek).toBe('Week of Oct 12')
    expect(byId(rows, 'B6').disposition).toBe('contract_delivery')
  })
  it('variety rule and class week', () => {
    expect(varietyOfPlanting([])).toEqual({ label: null, mixed: false })
    expect(varietyOfPlanting([{ variety: 'DP 1646' }])).toEqual({ label: 'DP 1646', mixed: false })
    expect(varietyOfPlanting([{ variety: 'DP 2239' }, { variety: 'DP 2131' }, { variety: 'DP 2239' }])).toEqual({ label: 'Mixed (DP 2131 / DP 2239)', mixed: true })
    expect(classWeekOf('2026-10-14')).toEqual({ key: '2026-10-12', label: 'Week of Oct 12' })
    expect(classWeekOf('2026-10-12')).toEqual({ key: '2026-10-12', label: 'Week of Oct 12' })
    expect(classWeekOf(null).label).toBe('No class date')
  })
})

describe('filters and grouping', () => {
  it('multi-select chips narrow by entity, farm, field, variety, gin, receipt, practice, disposition, class date', () => {
    const rows = rowsOf()
    expect(applyFilters(rows, { ...EMPTY_FILTERS, entityIds: ['E2'] }).map((r) => r.id)).toEqual(['B5', 'B6', 'B7', 'B8', 'B10'])
    expect(applyFilters(rows, { ...EMPTY_FILTERS, farmIds: ['F1', 'F3'] })).toHaveLength(5)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, varieties: ['DP 1646'] })).toHaveLength(5)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, varieties: ['No variety'] }).map((r) => r.id)).toEqual(['B9'])
    expect(applyFilters(rows, { ...EMPTY_FILTERS, ginIds: ['G1'] })).toHaveLength(9)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, receiptIds: ['R1'] })).toHaveLength(4)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, practices: ['mixed'] })).toHaveLength(4)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, practices: ['unknown'] })).toHaveLength(1)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, dispositions: ['held'] })).toHaveLength(8)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, classFrom: '2026-10-14', classTo: '2026-10-14' })).toHaveLength(9) // the unclassed bale has no date
    expect(applyFilters(rows, { ...EMPTY_FILTERS, classFrom: '2026-10-15' })).toHaveLength(0)
  })
  it('"exclude bales committed elsewhere" drops loan / sold / pool / other-contract bales only with a contract selected', () => {
    const rows = rowsOf()
    expect(committedElsewhere(byId(rows, 'B5'), 'VS')).toBe(true)
    expect(committedElsewhere(byId(rows, 'B6'), 'VS')).toBe(true)
    expect(committedElsewhere(byId(rows, 'B6'), 'OTHER')).toBe(false)
    expect(committedElsewhere(byId(rows, 'B1'), 'VS')).toBe(false)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, contractId: 'VS', excludeCommitted: true })).toHaveLength(8)
    expect(applyFilters(rows, { ...EMPTY_FILTERS, contractId: '', excludeCommitted: true })).toHaveLength(10)
  })
  it('groups by farm, field, variety, receipt, week', () => {
    const rows = rowsOf()
    expect(groupRows(rows, 'farm').map((gr) => [gr.label, gr.rows.length])).toEqual([['Ashford South', 5], ['Far Away', 1], ['Lamon', 4]])
    expect(groupRows(rows, 'variety').map((gr) => gr.label)).toEqual(['DP 1646', 'Mixed (DP 2131 / DP 2239)', 'No variety'])
    expect(groupRows(rows, 'week').map((gr) => [gr.label, gr.rows.length])).toEqual([['Week of Oct 12', 9], ['No class date', 1]])
    expect(groupRows(rows, 'overall')).toHaveLength(1)
  })
})

describe('distributions and averages over the nine classed bales', () => {
  const rows = rowsOf()
  it('mic premium (3.7–4.2) 3 bales = 33.3%, base 6 = 66.7%; strength premium 8 / base 1; uniformity premium 2 / base 6 / discount 1', () => {
    const mic = distribution(rows, 'mic', 2026, 'bales')
    expect(mic.classed).toBe(9)
    expect(mic.byBand.premium.bales).toBe(3)
    expect(mic.byBand.premium.pct).toBeCloseTo(1 / 3, 9)
    expect(mic.byBand.base.bales).toBe(6)
    expect(mic.byBand.discount.bales).toBe(0)
    const str = distribution(rows, 'strength', 2026, 'bales')
    expect(str.byBand.premium.bales).toBe(8)
    expect(str.byBand.base.bales).toBe(1)
    const unif = distribution(rows, 'uniformity', 2026, 'bales')
    expect(unif.byBand.premium.bales).toBe(2)
    expect(unif.byBand.base.bales).toBe(6)
    expect(unif.byBand.discount.bales).toBe(1)
    expect(unif.buckets.find((b) => b.label === '≥ 82.0')?.bales).toBe(2)
  })
  it('bale-weighted averages: mic 4.33, strength 29.7, uniformity 81.0, staple 37.4, leaf 2.7; lbs-weighted mic 4.34 / strength 29.8 / uniformity 81.0 over 4,435 lbs', () => {
    expect(factorAverage(rows, 'mic', 'bales')).toBeCloseTo(39.0 / 9, 9)
    expect(Math.round(factorAverage(rows, 'mic', 'bales')! * 100) / 100).toBe(4.33)
    expect(Math.round(factorAverage(rows, 'strength', 'bales')! * 10) / 10).toBe(29.7)
    expect(Math.round(factorAverage(rows, 'uniformity', 'bales')! * 10) / 10).toBe(81.0)
    expect(Math.round(factorAverage(rows, 'staple', 'bales')! * 10) / 10).toBe(37.4)
    expect(Math.round(factorAverage(rows, 'leaf', 'bales')! * 10) / 10).toBe(2.7)
    const classedLbs = rows.filter((r) => r.grade).reduce((s, r) => s + r.lbs, 0)
    expect(classedLbs).toBe(4435)
    expect(Math.round(factorAverage(rows, 'mic', 'lbs')! * 100) / 100).toBe(4.34)
    expect(Math.round(factorAverage(rows, 'strength', 'lbs')! * 10) / 10).toBe(29.8)
    expect(Math.round(factorAverage(rows, 'uniformity', 'lbs')! * 10) / 10).toBe(81.0)
    // Loan ¢/lb is lbs-weighted whichever weighting is picked.
    expect(factorAverage(rows, 'loan', 'bales')).toBe(factorAverage(rows, 'loan', 'lbs'))
  })
  it('color grid: 31 = 5, 21 = 1, 41 = 1, 32 = 1, 42 = 1', () => {
    const grid = colorGrid(rows, 'bales')
    expect(grid.classed).toBe(9)
    expect(Object.fromEntries(Array.from(grid.cells.values()).map((c) => [c.code, c.bales]))).toEqual({ '31': 5, '21': 1, '41': 1, '32': 1, '42': 1 })
    expect(grid.cells.get('31')!.pct).toBeCloseTo(5 / 9, 9)
  })
  it('KPIs: 9 classed of 10, lint lbs, base-or-better on all loan factors', () => {
    const k = kpis(rows, 2026)
    expect(k).toMatchObject({ bales: 10, classed: 9, notClassed: 1, lintLbs: 4925, classedLbs: 4435 })
    // B5 (leaf 4 = base) counts; B8 (mic 3.9 premium but strength 28.9 base, unif 79.9 discount) does not; B3/B4 spotted colors do not.
    expect(k.baseOrBetter).toBe(6)
    expect(k.avgLoanCents).toBeCloseTo(58, 9)
  })
})

describe('contract view and comparison rows', () => {
  const rows = rowsOf()
  const view = contractView(rows, VS_SPEC, null)
  it('headline 2 of 8 (25.0%), 1 not eligible, 1 not classed, projection 1,706 vs 4,250', () => {
    expect(view.summary).toMatchObject({ eligibleClassed: 8, meets: 2, fails: 6, notEligible: 1, notClassed: 1, cap: 4250 })
    expect(view.summary.projection).toEqual({ estimatedBales: 6825, estimateSource: 'contract', projected: 1706 })
    expect(view.evaluationOf('B9')?.status).toBe('not_eligible')
  })
  it('% meets contract per group and a totals row', () => {
    const cmp = comparisonRows(groupRows(rows, 'farm'), ['mic', 'color'], 2026, 'bales', VS_SPEC)
    const lamon = cmp.rows.find((r) => r.label === 'Lamon')!
    expect(lamon).toMatchObject({ bales: 4, classed: 4, meets: 2, eligibleClassed: 4, meetsPct: 0.5 })
    expect(Math.round(lamon.cells.mic.average! * 100) / 100).toBe(4.3)
    expect(lamon.cells.color.premium).toBeCloseTo(0.25, 9) // only B1's 31 is better than base
    const ashford = cmp.rows.find((r) => r.label === 'Ashford South')!
    expect(ashford).toMatchObject({ bales: 5, classed: 4, meets: 0, eligibleClassed: 4, meetsPct: 0 })
    const far = cmp.rows.find((r) => r.label === 'Far Away')!
    expect(far.meetsPct).toBeNull() // nothing eligible
    expect(cmp.total).toMatchObject({ bales: 10, classed: 9, meets: 2, eligibleClassed: 8 })
    expect(cmp.total.meetsPct).toBeCloseTo(0.25, 9)
  })
  it('the KPI cards and the PDF payload carry the contract headline', () => {
    const input = { cropYear: 2026, rows, factors: ['color', 'mic', 'strength', 'uniformity', 'loan'] as const, groupBy: 'farm' as const, weighting: 'bales' as const, filterSummary: '2026 Crop Year · All entities', contract: { id: 'VS', label: 'VS&Co', spec: VS_SPEC, view } }
    const cards = kpiCards({ ...input, factors: [...input.factors] })
    expect(cards.map((c) => c.label)).toEqual(['Bales classed', 'Lint lbs', 'Avg loan value', 'Base or better', 'Meets VS&Co'])
    expect(cards[4].value).toBe('25.0%')
    const pdf = buildBaleQualityPdfPayload({ ...input, factors: [...input.factors] })
    expect(pdf.sections.map((s) => s.title)).toEqual(['Factor distributions', 'Color grade grid (bales · % of classed)', 'By farm', 'Contract: VS&Co', 'Bales'])
    const contractRows = pdf.sections[3].rows.map((r) => r[0])
    expect(contractRows).toContain('Fails Color grade')
    expect(pdf.sections[4].rows).toHaveLength(10)
    expect(pdf.sections[4].columns.map((c) => c.label)).toContain('Failing factors')
  })
})

describe('Excel workbook — live formulas prove the app’s numbers', () => {
  const rows = rowsOf()
  const view = contractView(rows, VS_SPEC, null)
  const build = (): ExportPayload => buildBaleQualityWorkbook({
    cropYear: 2026, rows, factors: ['color', 'leaf', 'staple', 'mic', 'strength', 'uniformity', 'loan'], groupBy: 'farm', weighting: 'bales',
    filterSummary: '2026 Crop Year · All entities', contract: { id: 'VS', label: 'VS&Co', spec: VS_SPEC, view },
  })
  const colIndex = (p: ExportPayload, section: string, key: string) => p.sections.find((s) => s.key === section)!.columns.findIndex((c) => c.key === key)
  it('the Bales tab’s Meets spec column equals the evaluator: 2 meets / 6 fails / 1 not eligible, with the failing factors', () => {
    const p = build()
    expect(payloadHasFormulas(p)).toBe(true)
    const grid = evaluatePayload(p)
    const bales = p.sections.find((s) => s.key === SECTION.bales)!
    expect(bales.rows).toHaveLength(9) // classed bales only
    const ri = colIndex(p, SECTION.bales, 'result')
    const fi = colIndex(p, SECTION.bales, 'failing')
    const pi = colIndex(p, SECTION.bales, 'pbi')
    const results = grid[SECTION.bales].map((r) => [r[pi], r[ri], r[fi]])
    expect(results).toEqual([
      ['181001', 'Meets', ''], ['181002', 'Meets', ''], ['181003', 'Fails', 'Color '], ['181004', 'Fails', 'Color '],
      ['181005', 'Fails', 'Leaf '], ['181006', 'Fails', 'Staple '], ['181007', 'Fails', 'Mic '], ['181008', 'Fails', 'Mic Strength Uniformity '],
      ['181009', 'Not eligible', ''],
    ])
    const summary = grid[SECTION.summary]
    const sRows = p.sections.find((s) => s.key === SECTION.summary)!.rows
    const find = (item: string) => summary[sRows.findIndex((r) => r[1] === item)]
    expect(find('Classed bales in the filter')[3]).toBe(9)
    expect(find('Eligible classed bales')[3]).toBe(8)
    expect(find('Meet the spec')[3]).toBe(2)
    expect(find('Meet the spec')[4]).toBe(980)
    expect(find('Meet the spec')[5]).toBeCloseTo(0.25, 9)
    expect(find('Fail the spec')[3]).toBe(6)
    expect(find('Not eligible (farm not on the contract)')[3]).toBe(1)
    expect(find('Projected qualifying = pass rate × estimated bales (estimate)')[3]).toBe(1706)
    expect(find('Bale cap')[3]).toBe(4250)
  })
  it('distributions and averages on the Summary tab are formulas that reproduce the engine', () => {
    const p = build()
    const grid = evaluatePayload(p)
    const summary = grid[SECTION.summary]
    const sRows = p.sections.find((s) => s.key === SECTION.summary)!.rows
    const row = (factor: string, item: string) => summary[sRows.findIndex((r) => r[0] === factor && r[1] === item)]
    expect(row('Micronaire', '3.7–4.2')[3]).toBe(3)
    expect(row('Micronaire', '3.7–4.2')[5]).toBeCloseTo(1 / 3, 9)
    expect(row('Micronaire', '% base')[3]).toBe(6)
    expect(row('Strength (g/tex)', '% premium')[3]).toBe(8)
    expect(row('Uniformity (%)', '% discount')[3]).toBe(1)
    expect(row('Micronaire', 'Average (bale-weighted)')[5]).toBeCloseTo(39.0 / 9, 9)
    expect(row('Micronaire', 'Average (bale-weighted)')[6]).toBeCloseTo(factorAverage(rows, 'mic', 'lbs')!, 9)
    expect(row('Color grade', '31 M')[3]).toBe(5)
    expect(row('Leaf grade', 'Leaf 2')[3]).toBe(4)
    expect(row('Staple (32nds)', '38')[3]).toBe(5)
    expect(row('Loan value (¢/lb)', 'Average (lbs-weighted — loan value always is)')[5]).toBeCloseTo(58, 6)
    // The By Group tab: AVERAGEIFS per farm and % meets.
    const groups = grid[SECTION.groups]
    const gRows = p.sections.find((s) => s.key === SECTION.groups)!.rows
    const lamon = groups[gRows.findIndex((r) => (r[0] as { v: string }).v === 'Lamon')]
    expect(lamon[1]).toBe(4)
    expect(lamon[2]).toBe(1985)
    const micCol = colIndex(p, SECTION.groups, 'avg_mic')
    expect(lamon[micCol]).toBeCloseTo(4.3, 9)
    expect(lamon[colIndex(p, SECTION.groups, 'meets')]).toBeCloseTo(0.5, 9)
  })
  it('changing the strength minimum cell to 28.9 flips B8’s strength failure (B8 still fails on mic and uniformity)', () => {
    const p = build()
    const spec = p.sections.find((s) => s.key === SECTION.spec)!
    const vi = spec.columns.findIndex((c) => c.key === 'value')
    ;(spec.rows[SPEC_ROW.strength_min][vi] as { v: number }).v = 28.9
    const grid = evaluatePayload(p)
    const ri = colIndex(p, SECTION.bales, 'result')
    const fi = colIndex(p, SECTION.bales, 'failing')
    expect(grid[SECTION.bales][7][ri]).toBe('Fails')
    expect(grid[SECTION.bales][7][fi]).toBe('Mic Uniformity ')
    // And ticking 32 as an allowed color lets B4 through: 3 of 8.
    const ci = spec.columns.findIndex((c) => c.key === 'color')
    spec.rows[4][ci] = { v: '32', input: true }
    const grid2 = evaluatePayload(p)
    expect(grid2[SECTION.bales][3][ri]).toBe('Meets')
    const sRows = p.sections.find((s) => s.key === SECTION.summary)!.rows
    expect(grid2[SECTION.summary][sRows.findIndex((r) => r[1] === 'Meet the spec')][3]).toBe(3)
  })
  it('renders bounded A1 formulas that reference the Contract Spec tab', () => {
    const p = build()
    const text = formulaTextOf(p, SECTION.bales, 7, 'result')!
    expect(text).toMatch(/^IF\(/)
    expect(text).toContain("'Contract Spec'!$B$")
    expect(text).toContain("COUNTIF('Contract Spec'!$C$")
    const layout = formulaLayout(p)
    expect(layout[SECTION.bales].sheetName).toBe('Bales')
    const meets = p.sections.find((s) => s.key === SECTION.summary)!.rows.find((r) => r[1] === 'Meet the spec')![3] as { f: NonNullable<unknown> }
    expect(toExcelFormula(meets.f as never, { layout, at: { s: SECTION.summary, r: 0 } })).toMatch(/^COUNTIF\('?Bales'?!\$[A-Z]+\$\d+:\$[A-Z]+\$\d+,"Meets"\)$/)
  })
  it('without a contract: no spec tab, no result columns; the qualifying-bales workbook lists the two meeting bales', () => {
    const p = buildBaleQualityWorkbook({ cropYear: 2026, rows, factors: ['mic'], groupBy: 'overall', weighting: 'lbs', filterSummary: 'x', contract: null })
    expect(p.sections.map((s) => s.key)).toEqual([SECTION.summary, SECTION.groups, SECTION.bales, SECTION.notes])
    expect(p.sections.find((s) => s.key === SECTION.bales)!.columns.map((c) => c.key)).not.toContain('result')
    const grid = evaluatePayload(p)
    const sRows = p.sections[0].rows
    // lbs-weighted: the 3.7–4.2 bucket holds B2 480 + B6 505 + B8 470 = 1,455 of 4,435 lbs.
    expect(grid[SECTION.summary][sRows.findIndex((r) => r[1] === '3.7–4.2')][5]).toBeCloseTo(1455 / 4435, 9)
    const q = buildQualifyingBalesWorkbook({ cropYear: 2026, rows, factors: ['mic'], groupBy: 'overall', weighting: 'bales', filterSummary: 'x', contract: { id: 'VS', label: 'VS&Co', spec: VS_SPEC, view } })
    expect(q.sections[0].rows.map((r) => r[0])).toEqual(['181001', '181002'])
  })
})

describe('factor detail — the panel behind a tile', () => {
  const rows = buildBaleRows(fixture())
  const view = contractView(rows, VS_SPEC, null)

  it('mic bins at tenths from the lowest to the highest reading, colored by band, with the contract range 4.0–4.7 drawn as allowed', () => {
    const d = factorDetail(rows, 'mic', 2026, 'bales', VS_SPEC, view.evaluationOf)
    expect(d.step).toBe(0.1)
    expect(d.classed).toBe(9)
    expect(d.bins[0].min).toBeCloseTo(d.min!, 5)
    expect(d.bins[d.bins.length - 1].min).toBeCloseTo(d.max!, 5)
    expect(d.bins.reduce((s, b) => s + b.bales, 0)).toBe(9)
    expect(d.bins.every((b) => Math.abs((b.max! - b.min!) - 0.1) < 1e-6)).toBe(true)
    expect(d.requirement).toEqual({ min: 4.0, max: 4.7, allowedCodes: null, text: '4.0 – 4.7' })
    const at = (lo: number) => d.bins.find((b) => Math.abs(b.min! - lo) < 1e-6)
    expect(at(4.0)?.allowed).toBe(true)
    expect(at(4.7)?.allowed).toBe(true)
    expect(at(4.8)?.allowed).toBe(false)
    expect(at(4.0)?.band).toBe('premium')
    expect(at(4.3)?.band).toBe('base')
    expect(d.avgBale).toBeCloseTo(4.33, 2)
    expect(d.avgLbs).toBeCloseTo(4.34, 2)
    expect(d.min).toBeLessThanOrEqual(d.median!)
    expect(d.median).toBeLessThanOrEqual(d.max!)
  })

  it('counts the bales failing this factor against the contract, and the near misses', () => {
    const mic = factorDetail(rows, 'mic', 2026, 'bales', VS_SPEC, view.evaluationOf)
    const pareto = view.summary.pareto.find((p) => p.factor === 'mic')
    expect(mic.eligibleClassed).toBe(view.summary.eligibleClassed)
    expect(mic.fails).toBe(pareto?.bales ?? 0)
    expect(mic.onlyThis).toBe(pareto?.onlyThis ?? 0)
    const rd = factorDetail(rows, 'rd', 2026, 'bales', VS_SPEC, view.evaluationOf)
    expect(rd.requirement).toBeNull()
    expect(rd.fails).toBe(0)
  })

  it('color lists each code present in grid order, marked allowed by the contract', () => {
    const d = factorDetail(rows, 'color', 2026, 'bales', VS_SPEC, view.evaluationOf)
    expect(d.step).toBeNull()
    expect(d.bins.map((b) => b.code)).toEqual(['21', '31', '32', '41', '42']) // grid order: grade row, then column
    expect(d.bins.find((b) => b.code === '31')?.bales).toBe(5)
    expect(d.bins.find((b) => b.code === '31')?.allowed).toBe(true)
    expect(d.bins.find((b) => b.code === '32')?.allowed).toBe(false)
    expect(d.requirement?.allowedCodes).toEqual(VS_SPEC.allowed_color_codes)
    expect(d.bins.reduce((s, b) => s + b.pct, 0)).toBeCloseTo(1, 6)
  })

  it('without a contract no bin is marked and no requirement is reported', () => {
    const d = factorDetail(rows, 'strength', 2026, 'lbs', null)
    expect(d.requirement).toBeNull()
    expect(d.bins.every((b) => b.allowed == null)).toBe(true)
    expect(d.step).toBe(0.5)
    expect(d.bins.reduce((s, b) => s + b.lbs, 0)).toBeCloseTo(d.classedLbs, 6)
  })

  it('rowsInBin returns exactly the bales a bin holds (the chart drill)', () => {
    const d = factorDetail(rows, 'mic', 2026, 'bales', null)
    for (const b of d.bins) expect(rowsInBin(rows, 'mic', b).length).toBe(b.bales)
    const c = factorDetail(rows, 'color', 2026, 'bales', null)
    for (const b of c.bins) expect(rowsInBin(rows, 'color', b).length).toBe(b.bales)
  })

  it('widens the step when the readings would need more than 60 bins', () => {
    const wide: BaleRow[] = rows.filter((r) => r.grade).map((r, i) => ({ ...r, id: `W${i}`, grade: { ...r.grade!, strength_g_tex: 10 + i * 5 } }))
    const d = factorDetail(wide, 'strength', 2026, 'bales', null)
    expect(d.bins.length).toBeLessThanOrEqual(60)
    expect(d.step).toBeGreaterThan(0.5)
    expect(d.bins.reduce((s, b) => s + b.bales, 0)).toBe(wide.length)
  })
})
