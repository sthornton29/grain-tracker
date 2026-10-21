// Bale Quality exports (2026-10-20) — through lib/exports.ts, with the Excel
// design defaults of the production workbook.
//
//   buildBaleQualityPdfPayload   mirrors the screen: KPI cards, the factor
//                                distributions, the color grid, the
//                                comparison table, the contract view and the
//                                bale list for the current filters, factors
//                                and grouping.
//   buildBaleQualityWorkbook     Excel: a Bales tab (every classed bale in
//                                the filter, inputs in blue), a Summary tab
//                                whose distributions and averages are LIVE
//                                formulas over the Bales tab (COUNTIFS per
//                                bucket, AVERAGEIFS, SUMPRODUCT for the
//                                lbs-weighted averages), a By Group tab of
//                                AVERAGEIFS per group, and — with a contract
//                                — a Contract Spec tab of blue threshold
//                                cells that the Bales tab's "Meets spec"
//                                formula reads, so a buyer can change a
//                                threshold and watch the counts move.
//   buildQualifyingBalesWorkbook the PBI list + full classing data of the
//                                bales that meet the spec (what the contract
//                                says we provide).

import type { ExportCell, ExportColumn, ExportPayload, ExportSection, NumFmt, PreludeRow, SummaryCard } from './exports'
import {
  and, averageifs, cell, col, concat, countif, countifs, div, eq, ge, gt, iferror, iff, le, mul, ne, num, or, round, str, sum, sumifs, sumproduct, type FormulaNode, type RangeNode,
} from './formula'
import { factorText, factorValue, FACTORS, BAND_LABEL, COLOR_GRID_COLUMNS, COLOR_GRID_ROWS, colorGridCode, bandsFor, type FactorKey, type Band } from './cotton-quality'
import { EVALUATION_LABEL, EXTRANEOUS_RULE_LABEL, specSummaryLine, type ContractQualitySpec } from './cotton-contract-spec'
import {
  colorGrid, comparisonRows, distribution, groupRows, kpis, occupiedBuckets, GROUP_BY_LABEL,
  type BaleRow, type ContractView, type GroupBy, type Weighting,
} from './bale-quality-report'

const BRAND_GREEN = 'FF36B449'
const TAB_GRAY = 'FF9CA3AF'
const TAB_BLUE = 'FF2563EB'

const input = (v: number | string | null, format?: NumFmt): ExportCell => ({ v, input: true, format })
const formula = (f: FormulaNode, format?: NumFmt): ExportCell => ({ v: null, f, format })
const pct = (v: number | null | undefined): ExportCell => (v == null ? '' : { v: Math.round(v * 1000) / 10, format: 'pct1' })
const n1 = (v: number | null | undefined, d: number): ExportCell => (v == null ? '' : Math.round(v * Math.pow(10, d)) / Math.pow(10, d))

export type BaleQualityExportInput = {
  cropYear: number
  rows: BaleRow[]
  factors: FactorKey[]
  groupBy: GroupBy
  weighting: Weighting
  filterSummary: string
  contract: { id: string; label: string; spec: ContractQualitySpec; view: ContractView } | null
  generatedAt?: Date
}

const factorFormat = (key: FactorKey): NumFmt => (key === 'loan' ? 'cents' : key === 'mic' ? 'dec2' : FACTORS[key].kind === 'number' ? (FACTORS[key].decimals === 0 ? 'int' : 'dec1') : 'text')

function factorCellValue(r: BaleRow, key: FactorKey): string | number {
  if (!r.grade) return ''
  const v = factorValue(r.grade, key)
  if (v == null) return ''
  if (FACTORS[key].kind === 'number') return typeof v === 'number' ? v : Number(v)
  return String(v)
}

// ---------------------------------------------------------------------------
// PDF (and the screen's summary cards)
// ---------------------------------------------------------------------------

export function kpiCards(input0: BaleQualityExportInput): SummaryCard[] {
  const k = kpis(input0.rows, input0.cropYear)
  const cards: SummaryCard[] = [
    { label: 'Bales classed', value: k.classed.toLocaleString(), sub: k.notClassed > 0 ? `${k.notClassed.toLocaleString()} not yet classed` : `${k.bales.toLocaleString()} bales` },
    { label: 'Lint lbs', value: Math.round(k.lintLbs).toLocaleString(), sub: k.notClassed > 0 ? `${Math.round(k.classedLbs).toLocaleString()} classed` : undefined },
    { label: 'Avg loan value', value: k.avgLoanCents != null ? `${k.avgLoanCents.toFixed(2)}¢/lb` : '—', sub: 'lbs-weighted' },
    { label: 'Base or better', value: k.baseOrBetterPct != null ? `${(k.baseOrBetterPct * 100).toFixed(1)}%` : '—', sub: 'all loan factors', tone: k.baseOrBetterPct != null && k.baseOrBetterPct >= 0.5 ? 'favorable' : 'neutral' },
  ]
  if (input0.contract) {
    const s = input0.contract.view.summary
    cards.push({ label: `Meets ${input0.contract.label}`, value: s.passRate != null ? `${(s.passRate * 100).toFixed(1)}%` : '—', sub: `${s.meets.toLocaleString()} of ${s.eligibleClassed.toLocaleString()} eligible classed`, tone: s.passRate != null && s.passRate >= 0.5 ? 'favorable' : s.passRate != null ? 'warning' : 'neutral' })
  }
  return cards
}

export function buildBaleQualityPdfPayload(input0: BaleQualityExportInput): ExportPayload {
  const { cropYear, rows, factors, groupBy, weighting, contract } = input0
  const sections: ExportSection[] = []
  const wLabel = weighting === 'lbs' ? '% of lbs' : '% of bales'

  // Factor distributions.
  const distRows: ExportCell[][] = []
  const distMeta: Array<'data' | 'subhead'> = []
  for (const f of factors) {
    const d = distribution(rows, f, cropYear, weighting)
    const avg = d.average != null ? ` · avg ${factorText(f, d.average)}${f === 'loan' ? ' (lbs-weighted)' : ''}` : ''
    distRows.push([`${FACTORS[f].label}${avg}`, '', '', '', ''])
    distMeta.push('subhead')
    for (const b of occupiedBuckets(d)) {
      distRows.push([b.label, b.band ? BAND_LABEL[b.band] : '', b.bales, Math.round(b.lbs), { v: Math.round(b.pct * 1000) / 10, format: 'pct1', tone: b.band === 'premium' ? 'favorable' : b.band === 'discount' ? 'unfavorable' : 'neutral' }])
      distMeta.push('data')
    }
  }
  sections.push({
    title: 'Factor distributions',
    columns: [{ label: 'Bucket' }, { label: 'Band' }, { label: 'Bales', align: 'right', format: 'int' }, { label: 'Lbs', align: 'right', format: 'lbs' }, { label: wLabel, align: 'right', format: 'pct1' }],
    rows: distRows,
    rowMeta: distMeta,
  })

  // Color grid.
  const grid = colorGrid(rows, weighting)
  sections.push({
    title: 'Color grade grid (bales · % of classed)',
    columns: [{ label: 'Grade' }, ...COLOR_GRID_COLUMNS.map((c) => ({ label: c.label, align: 'right' as const }))],
    rows: COLOR_GRID_ROWS.map((r) => [
      `${r.row} ${r.symbol}`,
      ...COLOR_GRID_COLUMNS.map((c): ExportCell => {
        const code = colorGridCode(r.row, c.column)
        if (!code) return ''
        const cellV = grid.cells.get(code)
        const allowed = contract?.spec.allowed_color_codes?.length ? contract.spec.allowed_color_codes.includes(code) : true
        const text = cellV ? `${code}: ${cellV.bales} (${(cellV.pct * 100).toFixed(1)}%)` : code
        return { v: allowed ? text : `${text} ✕`, tone: cellV && !allowed ? 'unfavorable' : cellV ? 'neutral' : 'muted' }
      }),
    ]),
  })

  // Comparison table.
  const groups = groupRows(rows, groupBy)
  const cmp = comparisonRows(groups, factors, cropYear, weighting, contract?.spec ?? null)
  const cmpColumns: ExportColumn[] = [{ label: GROUP_BY_LABEL[groupBy] }, { label: 'Bales', align: 'right', format: 'int' }, { label: 'Classed', align: 'right', format: 'int' }, { label: 'Lbs', align: 'right', format: 'lbs' }]
  for (const f of factors) {
    if (FACTORS[f].kind === 'number') cmpColumns.push({ label: `${FACTORS[f].short} avg`, align: 'right', format: factorFormat(f) })
    if (FACTORS[f].banded) {
      cmpColumns.push({ label: `${FACTORS[f].short} % prem`, align: 'right', format: 'pct1' })
      cmpColumns.push({ label: `${FACTORS[f].short} % base`, align: 'right', format: 'pct1' })
      cmpColumns.push({ label: `${FACTORS[f].short} % disc`, align: 'right', format: 'pct1' })
    }
  }
  if (contract) cmpColumns.push({ label: '% meets contract', align: 'right', format: 'pct1' })
  const cmpRow = (r: typeof cmp.total): ExportCell[] => {
    const out: ExportCell[] = [r.label, r.bales, r.classed, Math.round(r.lbs)]
    for (const f of factors) {
      const c = r.cells[f]
      if (FACTORS[f].kind === 'number') out.push(c.average == null ? '' : f === 'loan' ? { v: c.average, format: 'cents' } : n1(c.average, FACTORS[f].decimals))
      if (FACTORS[f].banded) out.push(pct(c.classed ? c.premium : null), pct(c.classed ? c.base : null), pct(c.classed ? c.discount : null))
    }
    if (contract) out.push(pct(r.meetsPct))
    return out
  }
  sections.push({
    title: `By ${GROUP_BY_LABEL[groupBy].toLowerCase()}`,
    columns: cmpColumns,
    rows: [...cmp.rows.map(cmpRow), cmpRow(cmp.total)],
    rowMeta: [...cmp.rows.map(() => 'data' as const), 'total'],
  })

  // Contract view.
  if (contract) {
    const s = contract.view.summary
    const lines: ExportCell[][] = [
      ['Specification', specSummaryLine(contract.spec)],
      ['Eligible classed bales', s.eligibleClassed],
      ['Meet the spec', `${s.meets} (${s.passRate != null ? (s.passRate * 100).toFixed(1) : '—'}% by bales · ${s.passRateLbs != null ? (s.passRateLbs * 100).toFixed(1) : '—'}% by lbs) · ${Math.round(s.meetsLbs).toLocaleString()} lbs`],
      ['Fail the spec', s.fails],
      ['Not eligible (farm not on the contract)', s.notEligible],
      ['Not yet classed', s.notClassed],
      ['Cap', s.cap != null ? `${s.meets.toLocaleString()} qualifying of ${s.cap.toLocaleString()}` : 'none'],
      ['Projected qualifying (estimate)', s.projection ? `${s.projection.projected.toLocaleString()} = ${(s.passRate! * 100).toFixed(1)}% × ${s.projection.estimatedBales.toLocaleString()} ${s.projection.estimateSource === 'contract' ? "(the contract's estimate)" : "(the app's expected production)"}` : 'no production estimate'],
      ...s.pareto.map((p): ExportCell[] => [`Fails ${FACTORS[p.factor].label}`, `${p.bales} bales · ${p.onlyThis} fail only this factor`]),
    ]
    sections.push({ title: `Contract: ${contract.label}`, columns: [{ label: 'Item' }, { label: 'Value' }], rows: lines })
  }

  // Bale list.
  const baleColumns: ExportColumn[] = [
    { label: 'PBI' }, { label: 'Receipt' }, { label: 'Farm' }, { label: 'Field' }, { label: 'Variety' }, { label: 'Class date' },
    ...factors.map((f): ExportColumn => ({ label: FACTORS[f].short, align: FACTORS[f].kind === 'number' ? 'right' : 'left', format: factorFormat(f) })),
    { label: 'Lbs', align: 'right', format: 'lbs' }, { label: 'Disposition' },
  ]
  if (contract) baleColumns.push({ label: 'Contract' }, { label: 'Failing factors' })
  sections.push({
    title: 'Bales',
    columns: baleColumns,
    rows: rows.map((r): ExportCell[] => {
      const out: ExportCell[] = [r.pbi, r.receiptLabel, r.farmName, r.fieldName, r.variety ?? '', r.classDate ?? '']
      for (const f of factors) out.push(f === 'loan' && r.grade ? { v: factorCellValue(r, f), format: 'cents' } : factorCellValue(r, f))
      out.push(Math.round(r.lbs), DISPOSITION_TEXT[r.disposition])
      if (contract) {
        const ev = contract.view.evaluationOf(r.id)
        out.push(ev ? EVALUATION_LABEL[ev.status] : '', ev && ev.status === 'fails' ? ev.failures.map((x) => x.text).join('; ') : '')
      }
      return out
    }),
  })

  return {
    title: 'Bale Quality',
    filters: input0.filterSummary,
    summary: kpiCards(input0),
    sections,
    orientation: 'landscape',
    filename: `Turnrow_Bale_Quality_${cropYear}_${dateStamp(input0.generatedAt)}`,
  }
}

export const DISPOSITION_TEXT: Record<BaleRow['disposition'], string> = {
  held: 'Held', ccc_loan: 'In CCC loan', sold_spot: 'Sold (spot)', contract_delivery: 'On contract', pool: 'Pool',
}

function dateStamp(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Excel workbook — live formulas
// ---------------------------------------------------------------------------

export const SECTION = { summary: 'summary', groups: 'groups', bales: 'bales', spec: 'spec', notes: 'notes' } as const

/** Contract Spec tab layout: item rows (key → row index) so the Bales tab's
 *  formulas can point at the threshold cells. */
export const SPEC_ITEMS = ['leaf_max', 'staple_min', 'mic_min', 'mic_max', 'strength_min', 'uniformity_min', 'extraneous_rule', 'bale_cap', 'estimated_bales'] as const
export type SpecItem = (typeof SPEC_ITEMS)[number]
export const SPEC_ITEM_LABEL: Record<SpecItem, string> = {
  leaf_max: 'Leaf — maximum', staple_min: 'Staple — minimum (32nds)', mic_min: 'Micronaire — minimum', mic_max: 'Micronaire — maximum',
  strength_min: 'Strength — minimum (g/tex)', uniformity_min: 'Uniformity — minimum (%)', extraneous_rule: 'Extraneous matter rule',
  bale_cap: 'Bale cap', estimated_bales: 'Estimated eligible bales',
}
export const SPEC_ROW: Record<SpecItem, number> = Object.fromEntries(SPEC_ITEMS.map((k, i) => [k, i])) as Record<SpecItem, number>

const BALE_FACTOR_COLS: Array<{ key: FactorKey; col: string }> = [
  { key: 'color', col: 'color' }, { key: 'leaf', col: 'leaf' }, { key: 'staple', col: 'staple' }, { key: 'mic', col: 'mic' },
  { key: 'strength', col: 'strength' }, { key: 'uniformity', col: 'uniformity' }, { key: 'extraneous', col: 'extraneous' }, { key: 'remarks', col: 'remarks' },
  { key: 'rd', col: 'rd' }, { key: 'plus_b', col: 'plus_b' }, { key: 'quadrant', col: 'quadrant' }, { key: 'trash', col: 'trash' }, { key: 'length', col: 'length' }, { key: 'loan', col: 'loan' },
]

export function buildBaleQualityWorkbook(input0: BaleQualityExportInput): ExportPayload {
  const { cropYear, rows: allRows, factors, groupBy, weighting, contract } = input0
  const rows = allRows.filter((r) => r.grade)
  const B = (c: string): RangeNode => col(SECTION.bales, c)
  const S = (item: SpecItem): FormulaNode => cell(SECTION.spec, 'value', SPEC_ROW[item])
  const hasFarms = (contract?.spec.eligible_fsa_farms?.length ?? 0) > 0
  const hasColors = (contract?.spec.allowed_color_codes?.length ?? 0) > 0
  const bands = bandsFor(cropYear)
  const fmtPctRatio: NumFmt = 'ratio'

  // ---- Bales tab -----------------------------------------------------------
  const baleColumns: Array<ExportColumn & { key: string }> = [
    { key: 'pbi', label: 'PBI', note: 'Bale (PBI) number from the gin receipt.' },
    { key: 'receipt', label: 'Receipt' },
    { key: 'gin', label: 'Gin' },
    { key: 'entity', label: 'Entity' },
    { key: 'farm', label: 'Farm' },
    { key: 'fsa', label: 'FSA #', note: 'The farm’s FSA number — eligibility under a contract’s farm schedule.' },
    { key: 'field', label: 'Field' },
    { key: 'variety', label: 'Variety' },
    { key: 'practice', label: 'Practice' },
    { key: 'class_date', label: 'Class date' },
    { key: 'color', label: 'Color', align: 'right' },
    { key: 'leaf', label: 'Leaf', align: 'right', format: 'int' },
    { key: 'staple', label: 'Staple', align: 'right', format: 'dec1' },
    { key: 'mic', label: 'Mic', align: 'right', format: 'dec2' },
    { key: 'strength', label: 'Strength', align: 'right', format: 'dec1' },
    { key: 'uniformity', label: 'Uniformity', align: 'right', format: 'dec1' },
    { key: 'extraneous', label: 'Ex', align: 'right' },
    { key: 'remarks', label: 'Rm', align: 'right' },
    { key: 'rd', label: 'Rd', align: 'right', format: 'dec1' },
    { key: 'plus_b', label: '+b', align: 'right', format: 'dec1' },
    { key: 'quadrant', label: 'Quad', align: 'right' },
    { key: 'trash', label: 'Trash', align: 'right', format: 'dec1' },
    { key: 'length', label: 'Length', align: 'right', format: 'int' },
    { key: 'loan', label: 'Loan $/lb', align: 'right', format: 'cents', note: 'Classing loan value, written as $/lb (59.9¢ = $0.5990).' },
    { key: 'loan_total', label: 'Loan $', align: 'right', format: 'usd2' },
    { key: 'lbs', label: 'Lbs', align: 'right', format: 'lbs' },
    { key: 'disposition', label: 'Disposition' },
    { key: 'group', label: GROUP_BY_LABEL[groupBy], note: 'The report’s grouping; the By Group tab reads this column.' },
  ]
  if (contract) {
    baleColumns.push({ key: 'eligible', label: 'Eligible', note: 'Yes when the farm is on the Contract Spec tab’s farm list (or the list is empty).' })
    baleColumns.push({ key: 'result', label: 'Meets spec', note: 'Meets / Fails / Not eligible — a formula over the Contract Spec tab’s thresholds.' })
    baleColumns.push({ key: 'failing', label: 'Failing factors' })
  }

  // Per-factor pass tests against the spec cells, written per bale row: a
  // blank threshold is no rule; a blank reading under a rule fails it; every
  // bound is inclusive at the value written.
  const blank = (item: SpecItem) => eq(S(item), str(''))
  const tests = (r: number): Array<{ label: string; ok: FormulaNode }> => {
    const own = (c: string) => cell(SECTION.bales, c, r)
    const hasReading = (c: string) => ne(own(c), str('')) // cell <> "" (never (cell="")=0: Excel does not read FALSE as 0 in a comparison)
    const t: Array<{ label: string; ok: FormulaNode }> = []
    if (hasColors) t.push({ label: 'Color', ok: gt(countif(col(SECTION.spec, 'color'), own('color')), num(0)) })
    t.push({ label: 'Leaf', ok: or(blank('leaf_max'), and(hasReading('leaf'), le(own('leaf'), S('leaf_max')))) })
    t.push({ label: 'Staple', ok: or(blank('staple_min'), and(hasReading('staple'), ge(own('staple'), S('staple_min')))) })
    t.push({ label: 'Mic', ok: and(or(blank('mic_min'), and(hasReading('mic'), ge(own('mic'), S('mic_min')))), or(blank('mic_max'), and(hasReading('mic'), le(own('mic'), S('mic_max'))))) })
    t.push({ label: 'Strength', ok: or(blank('strength_min'), and(hasReading('strength'), ge(own('strength'), S('strength_min')))) })
    t.push({ label: 'Uniformity', ok: or(blank('uniformity_min'), and(hasReading('uniformity'), ge(own('uniformity'), S('uniformity_min')))) })
    return t
  }

  const baleRows: ExportCell[][] = rows.map((r, i) => {
    const out: ExportCell[] = [
      input(r.pbi), input(r.receiptLabel), input(r.ginName), input(r.entityName), input(r.farmName), input(r.fsa ?? ''), input(r.fieldName),
      input(r.variety ?? ''), input(r.practice ?? ''), input(r.classDate ?? ''),
      ...BALE_FACTOR_COLS.map(({ key }) => input(factorCellValue(r, key) as string | number, key === 'loan' ? 'cents' : undefined)),
      input(r.loanTotal, 'usd2'), input(Math.round(r.lbs), 'lbs'), input(DISPOSITION_TEXT[r.disposition]), input(groupLabelOf(r, groupBy)),
    ]
    if (contract) {
      const eligible: FormulaNode = hasFarms ? iff(gt(countif(col(SECTION.spec, 'farm'), cell(SECTION.bales, 'fsa', i)), num(0)), str('Yes'), str('No')) : str('Yes')
      const t = tests(i)
      const allOk = and(...t.map((x) => x.ok))
      const result = iff(eq(cell(SECTION.bales, 'eligible', i), str('No')), str('Not eligible'), iff(allOk, str('Meets'), str('Fails')))
      const failing = iff(eq(cell(SECTION.bales, 'result', i), str('Fails')), concat(...t.map((x) => iff(x.ok, str(''), str(`${x.label} `)))), str(''))
      out.push(formula(eligible), formula(result), formula(failing))
    }
    return out
  })

  const balesSection: ExportSection = {
    key: SECTION.bales, title: 'Bales', plain: true, columns: baleColumns, rows: baleRows, freezeColumns: 1,
    note: `${rows.length.toLocaleString()} classed bale${rows.length === 1 ? '' : 's'} in the filter (${input0.filterSummary}). Blue = from Turnrow records; black = formulas.`,
  }

  // ---- Contract Spec tab -----------------------------------------------------
  let specSection: ExportSection | null = null
  if (contract) {
    const spec = contract.spec
    const items: Array<[SpecItem, ExportCell]> = [
      ['leaf_max', input(spec.leaf_max)], ['staple_min', input(spec.staple_min)], ['mic_min', input(spec.mic_min, 'dec1')], ['mic_max', input(spec.mic_max, 'dec1')],
      ['strength_min', input(spec.strength_min, 'dec1')], ['uniformity_min', input(spec.uniformity_min, 'dec1')],
      ['extraneous_rule', input(EXTRANEOUS_RULE_LABEL[spec.extraneous_rule])], ['bale_cap', input(spec.bale_cap)], ['estimated_bales', input(spec.estimated_bales)],
    ]
    const colors = spec.allowed_color_codes ?? []
    const farms = spec.eligible_fsa_farms ?? []
    const n = Math.max(items.length, colors.length, farms.length, 1)
    const specRows: ExportCell[][] = []
    for (let i = 0; i < n; i++) {
      specRows.push([
        i < items.length ? SPEC_ITEM_LABEL[items[i][0]] : '',
        i < items.length ? items[i][1] : '',
        i < colors.length ? input(colors[i]) : '',
        i < farms.length ? input(farms[i]) : '',
      ])
    }
    specSection = {
      key: SECTION.spec, title: 'Contract Spec', plain: true, tabColor: TAB_BLUE,
      prelude: [
        { kind: 'title', cells: [`Contract quality specification — ${contract.label}`] },
        { kind: 'text', cells: ['Blue cells are the contract’s thresholds. Change one and the Bales tab’s "Meets spec" column and the Summary counts recompute. A blank threshold means no requirement.'] },
        { kind: 'text', cells: [spec.source_clause ? `Contract wording: ${spec.source_clause}` : ''] },
        { kind: 'blank', cells: [] },
      ],
      columns: [
        { key: 'item', label: 'Threshold', width: 30 }, { key: 'value', label: 'Value', align: 'right', width: 14 },
        { key: 'color', label: 'Allowed color codes', align: 'right', width: 20, note: 'A bale’s color grade must be one of these codes. Add or delete codes here.' },
        { key: 'farm', label: 'Eligible FSA farms', align: 'right', width: 20, note: 'Bales from farms not listed are "Not eligible". Leave empty for every farm.' },
      ],
      rows: specRows,
    }
  }

  // ---- Summary tab -----------------------------------------------------------
  const total: FormulaNode = countif(B('pbi'), str('<>'))
  const totalLbs: FormulaNode = sumifs(B('lbs'), [B('pbi'), str('<>')])
  const summaryRows: ExportCell[][] = []
  const summaryMeta: Array<'data' | 'subhead' | 'total'> = []
  const push = (cells: ExportCell[], kind: 'data' | 'subhead' | 'total' = 'data') => { summaryRows.push(cells); summaryMeta.push(kind) }

  push(['Bales', 'Classed bales in the filter', '', formula(total, 'int'), '', '', ''], 'data')
  push(['Bales', 'Lint lbs (classed)', '', '', formula(totalLbs, 'lbs'), '', ''], 'data')
  if (contract) {
    push([`Contract: ${contract.label}`, '', '', '', '', '', ''], 'subhead')
    const meets = countif(B('result'), str('Meets'))
    const fails = countif(B('result'), str('Fails'))
    const notEligible = countif(B('result'), str('Not eligible'))
    const eligible = countif(B('eligible'), str('Yes'))
    push(['Contract', 'Eligible classed bales', '', formula(eligible, 'int'), '', '', ''])
    push(['Contract', 'Meet the spec', '', formula(meets, 'int'), formula(sumifs(B('lbs'), [B('result'), str('Meets')]), 'lbs'), formula(iferror(div(meets, eligible), num(0)), fmtPctRatio), ''])
    push(['Contract', 'Fail the spec', '', formula(fails, 'int'), formula(sumifs(B('lbs'), [B('result'), str('Fails')]), 'lbs'), formula(iferror(div(fails, eligible), num(0)), fmtPctRatio), ''])
    push(['Contract', 'Not eligible (farm not on the contract)', '', formula(notEligible, 'int'), '', '', ''])
    const passRate = iferror(div(meets, eligible), num(0))
    push(['Contract', 'Projected qualifying = pass rate × estimated bales (estimate)', '', formula(round(mul(passRate, S('estimated_bales')), 0), 'int'), '', formula(passRate, fmtPctRatio), ''])
    push(['Contract', 'Bale cap', '', formula(S('bale_cap'), 'int'), '', '', ''])
  }
  const classedCount = (c: string): FormulaNode => countif(B(c), str('<>'))
  for (const f of factors) {
    const def = FACTORS[f]
    const colKey = BALE_FACTOR_COLS.find((x) => x.key === f)?.col ?? f
    push([def.label, '', '', '', '', '', ''], 'subhead')
    if (def.kind === 'number') {
      const avg: FormulaNode = f === 'loan'
        ? iferror(div(sumproduct(B('loan'), B('lbs')), sumifs(B('lbs'), [B('loan'), str('<>')])), str('—'))
        : iferror(averageifs(B(colKey), [B(colKey), str('<>')]), str('—'))
      const lbsAvg: FormulaNode = iferror(div(sumproduct(B(colKey), B('lbs')), sumifs(B('lbs'), [B(colKey), str('<>')])), str('—'))
      const avgFmt: NumFmt = f === 'loan' ? 'cents' : f === 'mic' ? 'dec2' : def.decimals === 0 ? 'int' : 'dec1'
      push([def.label, f === 'loan' ? 'Average (lbs-weighted — loan value always is)' : 'Average (bale-weighted)', '', formula(classedCount(colKey), 'int'), '', formula(avg, avgFmt), f === 'loan' ? '' : formula(lbsAvg, avgFmt)])
    }
    // Distribution buckets as COUNTIFS. Code factors count exact codes per bucket
    // (color: each code; extraneous: by kind prefix; quadrant: digit).
    const d = distribution(rows, f, cropYear, weighting)
    const denomCount = classedCount(colKey)
    const denomLbs = sumifs(B('lbs'), [B(colKey), str('<>')])
    for (const b of d.buckets) {
      if (b.bales === 0 && def.kind === 'code') continue
      let countF: FormulaNode
      let lbsF: FormulaNode
      if (def.kind === 'number') {
        const crit: Array<[RangeNode, FormulaNode]> = [[B(colKey), str('<>')]]
        if (b.min != null) crit.push([B(colKey), str(`>=${b.min}`)])
        if (b.max != null) crit.push([B(colKey), str(`<=${b.max}`)])
        countF = countifs(...crit)
        lbsF = sumifs(B('lbs'), ...crit)
      } else if (f === 'extraneous') {
        const kindPrefix = b.key === 'ex_none' ? null : String(Object.keys(EXTRANEOUS_PREFIX).find((k) => EXTRANEOUS_PREFIX[k] === b.key.slice(3)) ?? '')
        countF = kindPrefix == null ? countif(B(colKey), str('')) : countif(B(colKey), str(`${kindPrefix}?`))
        lbsF = kindPrefix == null ? sumifs(B('lbs'), [B(colKey), str('')]) : sumifs(B('lbs'), [B(colKey), str(`${kindPrefix}?`)])
      } else if (f === 'remarks') {
        const codes = b.key === 'rm_none' ? [''] : b.key === 'rm_reginned' ? ['75', '76'] : b.key === 'rm_repacked' ? ['77'] : null
        if (!codes) continue
        countF = codes.length === 1 ? countif(B(colKey), str(codes[0])) : sum(...codes.map((c) => countif(B(colKey), str(c))))
        lbsF = codes.length === 1 ? sumifs(B('lbs'), [B(colKey), str(codes[0])]) : sum(...codes.map((c) => sumifs(B('lbs'), [B(colKey), str(c)])))
      } else {
        const code = f === 'color' ? b.key.slice(6) : b.key.slice(2)
        countF = countif(B(colKey), str(code))
        lbsF = sumifs(B('lbs'), [B(colKey), str(code)])
      }
      push([def.label, b.label, b.band ? BAND_LABEL[b.band] : '', formula(countF, 'int'), formula(lbsF, 'lbs'), formula(iferror(div(weighting === 'lbs' ? lbsF : countF, weighting === 'lbs' ? denomLbs : denomCount), num(0)), fmtPctRatio), ''])
    }
    if (def.banded) {
      for (const band of ['premium', 'base', 'discount'] as Band[]) {
        const parts = d.buckets.filter((b) => b.band === band)
        if (parts.length === 0) continue
        const countParts: FormulaNode[] = []
        const lbsParts: FormulaNode[] = []
        for (const b of parts) {
          if (def.kind === 'number') {
            const crit: Array<[RangeNode, FormulaNode]> = [[B(colKey), str('<>')]]
            if (b.min != null) crit.push([B(colKey), str(`>=${b.min}`)])
            if (b.max != null) crit.push([B(colKey), str(`<=${b.max}`)])
            countParts.push(countifs(...crit)); lbsParts.push(sumifs(B('lbs'), ...crit))
          } else if (f === 'color') {
            const code = b.key.slice(6)
            countParts.push(countif(B(colKey), str(code))); lbsParts.push(sumifs(B('lbs'), [B(colKey), str(code)]))
          } else if (f === 'extraneous') {
            if (b.key === 'ex_none') { countParts.push(countif(B(colKey), str(''))); lbsParts.push(sumifs(B('lbs'), [B(colKey), str('')])) }
            else { const p = Object.keys(EXTRANEOUS_PREFIX).find((k) => EXTRANEOUS_PREFIX[k] === b.key.slice(3)) ?? ''; countParts.push(countif(B(colKey), str(`${p}?`))); lbsParts.push(sumifs(B('lbs'), [B(colKey), str(`${p}?`)])) }
          }
        }
        if (countParts.length === 0) continue
        const countF: FormulaNode = countParts.length === 1 ? countParts[0] : sum(...countParts)
        const lbsF: FormulaNode = lbsParts.length === 1 ? lbsParts[0] : sum(...lbsParts)
        push([def.label, `% ${BAND_LABEL[band].toLowerCase()}`, BAND_LABEL[band], formula(countF, 'int'), formula(lbsF, 'lbs'), formula(iferror(div(weighting === 'lbs' ? lbsF : countF, weighting === 'lbs' ? denomLbs : denomCount), num(0)), fmtPctRatio), ''], 'total')
      }
    }
  }

  const summarySection: ExportSection = {
    key: SECTION.summary, title: 'Summary', plain: true, tabColor: BRAND_GREEN,
    prelude: [
      { kind: 'title', cells: [`Bale Quality — ${cropYear} crop`] },
      { kind: 'subtitle', cells: [input0.filterSummary] },
      { kind: 'kpi', cells: ['Classed bales', formula(total, 'int'), 'Lint lbs', formula(totalLbs, 'lbs'), 'Avg loan $/lb', formula(iferror(div(sumproduct(B('loan'), B('lbs')), sumifs(B('lbs'), [B('loan'), str('<>')])), num(0)), 'cents')] },
      { kind: 'text', cells: [`Price bands: ${bands.source}. Distributions are ${weighting === 'lbs' ? 'lbs' : 'bale'}-weighted; averages are bale-weighted except loan value (always lbs-weighted). Every figure is a formula over the Bales tab.`] },
      { kind: 'blank', cells: [] },
    ],
    columns: [
      { key: 'factor', label: 'Factor', width: 20 }, { key: 'item', label: 'Bucket / item', width: 44 }, { key: 'band', label: 'Band', width: 10 },
      { key: 'bales', label: 'Bales', align: 'right', format: 'int' }, { key: 'lbs', label: 'Lbs', align: 'right', format: 'lbs' },
      { key: 'pct', label: weighting === 'lbs' ? '% of lbs' : '% of bales', align: 'right', format: 'ratio' }, { key: 'alt', label: 'Lbs-weighted avg', align: 'right' },
    ],
    rows: summaryRows,
    rowMeta: summaryMeta,
  }

  // ---- By Group tab ----------------------------------------------------------
  const groups = groupRows(rows, groupBy)
  const groupColumns: Array<ExportColumn & { key: string }> = [
    { key: 'group', label: GROUP_BY_LABEL[groupBy], width: 32 },
    { key: 'bales', label: 'Bales', align: 'right', format: 'int' },
    { key: 'lbs', label: 'Lbs', align: 'right', format: 'lbs' },
  ]
  for (const f of factors) {
    if (FACTORS[f].kind !== 'number') continue
    groupColumns.push({ key: `avg_${f}`, label: `${FACTORS[f].short} avg`, align: 'right', format: f === 'loan' ? 'cents' : f === 'mic' ? 'dec2' : FACTORS[f].decimals === 0 ? 'int' : 'dec1' })
  }
  if (contract) groupColumns.push({ key: 'meets', label: '% meets contract', align: 'right', format: 'ratio' })
  const groupRowsOut: ExportCell[][] = groups.map((g) => {
    const crit: [RangeNode, FormulaNode] = [B('group'), str('=' + g.label.replace(/~/g, '~~').replace(/\*/g, '~*').replace(/\?/g, '~?'))]
    const out: ExportCell[] = [input(g.label), formula(countifs(crit), 'int'), formula(sumifs(B('lbs'), crit), 'lbs')]
    for (const f of factors) {
      if (FACTORS[f].kind !== 'number') continue
      const colKey = BALE_FACTOR_COLS.find((x) => x.key === f)?.col ?? f
      // Loan ¢/lb per group is lbs-weighted: Σ loan $ ÷ Σ lbs × 100 (SUMPRODUCT takes no criterion).
      const avg = f === 'loan'
        ? iferror(mul(div(sumifs(B('loan_total'), crit), sumifs(B('lbs'), crit, [B('loan'), str('<>')])), num(100)), str('—'))
        : iferror(averageifs(B(colKey), crit, [B(colKey), str('<>')]), str('—'))
      out.push(formula(avg, f === 'loan' ? 'cents' : f === 'mic' ? 'dec2' : FACTORS[f].decimals === 0 ? 'int' : 'dec1'))
    }
    if (contract) out.push(formula(iferror(div(countifs(crit, [B('result'), str('Meets')]), countifs(crit, [B('eligible'), str('Yes')])), num(0)), 'ratio'))
    return out
  })
  const groupsSection: ExportSection = {
    key: SECTION.groups, title: 'By Group', plain: true, columns: groupColumns, rows: groupRowsOut,
    note: `One row per ${GROUP_BY_LABEL[groupBy].toLowerCase()}; every figure is a formula over the Bales tab (AVERAGEIFS is bale-weighted; loan $/lb is lbs-weighted).`,
  }

  const notesSection: ExportSection = {
    key: SECTION.notes, title: 'Notes', plain: true, tabColor: TAB_GRAY,
    columns: [{ key: 'note', label: 'Notes', width: 120 }],
    rows: [
      ['Bale Quality workbook — every figure on the Summary and By Group tabs is a live formula over the Bales tab.'],
      [`Price bands: ${bands.source}. Mic 3.7–4.2 premium, 3.5–3.6 and 4.3–4.9 base, ≤3.4 and ≥5.0 discount; strength ≥29.0 premium, 26.0–28.9 base, <26.0 discount; uniformity ≥82.0 premium, 80.0–81.9 base, <80.0 discount; color / leaf / staple better than, at, or worse than the loan base ${bands.loanBase.color}-${bands.loanBase.leaf}-${bands.loanBase.staple}.`],
      ['Averages are bale-weighted (how a classing recap is read) except loan value, which is always lbs-weighted. The Summary’s lbs-weighted column shows the other weighting.'],
      ['Blue cells came straight from Turnrow records (the classing import and gin receipts). Black cells are formulas.'],
      ...(contract ? [
        [`Contract Spec tab: ${specSummaryLine(contract.spec)}. Change a blue threshold cell, or add / delete a color code or FSA farm number, and the Bales tab’s Meets spec column and the Summary’s contract counts move. A blank threshold is no requirement.`],
        ['Meets spec tests each factor inclusively at the value written; a bale with a blank reading for a tested factor fails that factor. Not eligible = the bale’s farm is not on the farm list; such bales are left out of the pass rate.'],
      ] : []),
      ['Column guide — PBI: bale number · FSA #: the farm’s FSA number · Color / Leaf / Staple / Mic / Strength / Uniformity / Ex / Rm / Rd / +b / Quad / Trash / Length: the USDA classing data as imported · Loan $/lb and Loan $: the classing loan value · Lbs: bale net weight from the gin receipt · Disposition: held / in CCC loan / sold / on contract / pool.'],
    ],
  }

  const sections: ExportSection[] = [summarySection]
  if (specSection) sections.push(specSection)
  sections.push(groupsSection, balesSection, notesSection)
  return {
    title: 'Bale Quality',
    filters: input0.filterSummary,
    sections,
    fullCalcOnLoad: true,
    excel: { title: `Bale Quality ${cropYear}`, subject: 'Cotton bale quality — classing data with live formulas', company: 'Turnrow', zeroAsDash: false },
    filename: `Turnrow_Bale_Quality_${cropYear}_${contract ? 'Contract_' : ''}${dateStamp(input0.generatedAt)}`,
  }
}

const EXTRANEOUS_PREFIX: Record<string, string> = { '0': 'prep', '1': 'bark', '2': 'grass', '3': 'seed_coat', '4': 'oil', '5': 'spindle_twist', '6': 'other', '7': 'plastic' }

function groupLabelOf(r: BaleRow, by: GroupBy): string {
  switch (by) {
    case 'overall': return 'All bales'
    case 'entity': return r.entityName
    case 'farm': return r.farmName
    case 'field': return `${r.farmName} · ${r.fieldName}`
    case 'variety': return r.variety ?? 'No variety'
    case 'gin': return r.ginName
    case 'receipt': return r.receiptLabel
    case 'week': return r.classWeek
  }
}

// ---------------------------------------------------------------------------
// Qualifying bales (buyer-facing)
// ---------------------------------------------------------------------------

export function buildQualifyingBalesWorkbook(input0: BaleQualityExportInput): ExportPayload {
  const contract = input0.contract
  if (!contract) throw new Error('a contract must be selected')
  const rows = input0.rows.filter((r) => contract.view.evaluationOf(r.id)?.status === 'meets')
  const columns: ExportColumn[] = [
    { label: 'PBI' }, { label: 'Gin' }, { label: 'Class date' }, { label: 'Lbs', align: 'right', format: 'lbs' },
    { label: 'Color', align: 'right' }, { label: 'Leaf', align: 'right', format: 'int' }, { label: 'Staple', align: 'right', format: 'dec1' },
    { label: 'Mic', align: 'right', format: 'dec2' }, { label: 'Strength', align: 'right', format: 'dec1' }, { label: 'Uniformity', align: 'right', format: 'dec1' },
    { label: 'Rd', align: 'right', format: 'dec1' }, { label: '+b', align: 'right', format: 'dec1' }, { label: 'Trash', align: 'right', format: 'dec1' },
    { label: 'Length', align: 'right', format: 'int' }, { label: 'Ex', align: 'right' }, { label: 'Rm', align: 'right' },
    { label: 'FSA farm #' }, { label: 'Farm' }, { label: 'Field' },
  ]
  const keys: FactorKey[] = ['color', 'leaf', 'staple', 'mic', 'strength', 'uniformity', 'rd', 'plus_b', 'trash', 'length', 'extraneous', 'remarks']
  const prelude: PreludeRow[] = [
    { kind: 'title', cells: [`Bales meeting the ${contract.label} specification — ${input0.cropYear} crop`] },
    { kind: 'subtitle', cells: [specSummaryLine(contract.spec)] },
    { kind: 'kpi', cells: ['Bales', rows.length, 'Lint lbs', Math.round(rows.reduce((s, r) => s + r.lbs, 0))] },
    { kind: 'blank', cells: [] },
  ]
  return {
    title: `Qualifying bales — ${contract.label}`,
    filters: input0.filterSummary,
    sections: [{
      title: 'Qualifying bales', plain: true, prelude, columns,
      rows: rows.map((r): ExportCell[] => [
        r.pbi, r.ginName, r.classDate ?? '', Math.round(r.lbs),
        ...keys.map((k) => factorCellValue(r, k)),
        r.fsa ?? '', r.farmName, r.fieldName,
      ]),
    }],
    excel: { title: `Qualifying bales ${input0.cropYear}`, subject: `Bales meeting ${contract.label}`, company: 'Turnrow' },
    filename: `Turnrow_Qualifying_Bales_${input0.cropYear}_${dateStamp(input0.generatedAt)}`,
  }
}
