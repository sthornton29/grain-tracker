import { describe, expect, it } from 'vitest'
import type { GinReceiptExtraction, GinReceiptPage } from '@/lib/pdf-upload'
import { mergeGinReceipts } from '@/lib/parse-merge'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import {
  classifyStatement, farmYtdCheck, groupStatementPages, isSynthesizedReceiptNumber, rebaseGinReceiptPages, receiptDisplayName,
  statementIdentity, synthesizeReceiptNumber, type GinStatement,
} from '@/lib/gin-statements'
import { canCreateLoad, farmFieldFromMatches, matchStatementLoads, matchSummary, printedVsMatchedNote, type MatchableLoad } from '@/lib/gin-receipt-matching'
import { reconcileBaleCount, lintTurnoutPct } from '@/lib/cotton'
import { numberKey } from '@/lib/number-key'

// ---------------------------------------------------------------------------
// The Servico "Statement of Ginning" PDF (scanned, 18 pages, two statements
// for farm 5824 / Pivot, both printing "Gin 40614" — Servico's USDA gin code):
//   statement 1, pages 1–14, dated 10/10/2026: 22 loads, 645,220 lbs seed
//     cotton, 585 bales, 282,956 lbs lint, turnout 43.85%, Farm YTD 28
//     modules / 828,760 lbs / 745 bales / 361,789 lbs;
//   statement 2, pages 15–18, dated 10/7/2026: 6 loads, 183,540 lbs, 160
//     bales, 78,833 lbs lint, turnout 42.95%, Farm YTD 5 / 153,180 / 133 /
//     65,558 (printed before the statement posted).
// Load numbers and weights are the statement's own (the module list printed
// the same loads with a leading zero: 031633); the bale weights are
// synthetic and foot to the printed lint totals. Modeled as the per-PAGE
// extraction shape the gin_receipt prompt emits, in the 6-page chunks the
// upload sends — chunk 3 (pages 13–18) straddles both statements.
// ---------------------------------------------------------------------------

const TARE = 31_400
// [load_number as the STATEMENT prints it, net]; gross = net + tare; rolls 6 except 32536 (5).
const S1_LOADS: Array<[string, number]> = [
  ['31633', 31_000], ['31632', 31_320], ['31637', 29_600], ['31636', 30_060], ['31635', 29_840], ['31641', 29_580], ['31640', 29_760], ['31638', 29_300],
  ['31644', 30_000], ['31643', 29_120], ['31642', 29_340], ['32529', 30_240], ['31646', 28_960], ['31645', 29_980], ['32532', 29_220], ['32531', 29_340],
  ['32530', 29_420], ['32535', 29_840], ['32534', 28_840], ['32533', 28_620], ['32536', 22_220], ['31639', 29_620],
]
const S2_LOADS: Array<[string, number]> = [['31631', 30_180], ['31628', 30_260], ['31627', 29_860], ['31629', 31_220], ['31630', 31_660], ['31634', 30_360]]

const S1 = { date: '2026-10-10', modules: 22, seed: 645_220, bales: 585, lint: 282_956, seedLbs: 323_769, turnout: 43.85, ytd: { modules: 28, seed_cotton_lbs: 828_760, bales: 745, bale_weight: 361_789 } }
const S2 = { date: '2026-10-07', modules: 6, seed: 183_540, bales: 160, lint: 78_833, seedLbs: 90_340, turnout: 42.95, ytd: { modules: 5, seed_cotton_lbs: 153_180, bales: 133, bale_weight: 65_558 } }

const loadLine = ([n, net]: [string, number]) => ({ load_number: n, rolls: n === '32536' ? 5 : 6, gross: net + TARE, tare: TARE, net })

/** `count` synthetic bales from `firstPbi` that sum exactly to `lint`. */
function bales(firstPbi: number, count: number, lint: number): Array<{ pbi_number: string; net_weight_lbs: number }> {
  const base = Math.floor(lint / count)
  const extra = lint - base * count
  return Array.from({ length: count }, (_, i) => ({ pbi_number: String(firstPbi + i), net_weight_lbs: base + (i < extra ? 1 : 0) }))
}
const S1_BALES = bales(179_122, S1.bales, S1.lint)
const S2_BALES = bales(178_962, S2.bales, S2.lint)

function header(over: Partial<GinReceiptPage> = {}): GinReceiptPage {
  return {
    page: null, statement_date: null, has_totals_block: false,
    gin_name: 'Servico, Inc.', gin_address: '1615 County Road 389, Courtland, AL 35618', gin_phone: '256-637-6565',
    gin_code: '40614', statement_number: null, producer: 'LAMON FARM', farm_number: '5824', farm_name: 'WHEELER', field: 'PIVOT', crop_year: null,
    totals: null, farm_ytd: null, loads: [], bales: [], bale_row_first: null, bale_row_last: null, ...over,
  }
}

/** The 18 pages, in document order, exactly as the model reports them. */
function buildPages(): GinReceiptPage[] {
  const pages: GinReceiptPage[] = []
  const emit = (s: typeof S1, loads: ReturnType<typeof loadLine>[], allBales: typeof S1_BALES, firstPageBales: number, perPage: number) => {
    let row = 0
    let first = true
    while (row < allBales.length) {
      const take = first ? firstPageBales : perPage
      const slice = allBales.slice(row, row + take)
      pages.push(header({
        page: pages.length + 1, statement_date: s.date, has_totals_block: first,
        totals: first ? { modules_count: s.modules, total_seed_cotton_weight: s.seed, bales_count: s.bales, total_bale_weight: s.lint, avg_bale_weight: Math.round(s.lint / s.bales), seed_lbs: s.seedLbs, lint_turnout_pct: s.turnout, lint_lbs_per_bale: null } : null,
        farm_ytd: first ? s.ytd : null,
        loads: first ? loads : [],
        bales: slice, bale_row_first: row + 1, bale_row_last: row + slice.length,
        // chunk 2's pages printed the farm as one field — the grouping splits it.
        farm_number: pages.length >= 6 && pages.length < 12 ? null : '5824',
        farm_name: pages.length >= 6 && pages.length < 12 ? '5824 WHEELER' : 'WHEELER',
      }))
      row += slice.length
      first = false
    }
  }
  emit(S1, S1_LOADS.map(loadLine), S1_BALES, 13, 45) // 13 + 12 × 45 = 553 … + 32 → 14 pages
  emit(S2, S2_LOADS.map(loadLine), S2_BALES, 29, 45) // 29 + 45 + 45 + 41 → 4 pages
  return pages
}
const PAGES = buildPages()

/** The upload: 6 pages per chunk, each chunk numbered from 1 by the model, rebased by parse-chunked. */
function chunks(): GinReceiptExtraction[] {
  const out: GinReceiptExtraction[] = []
  for (let i = 0; i < PAGES.length; i += 6) {
    const part = { pages: PAGES.slice(i, i + 6).map((p, k) => ({ ...p, page: k + 1 })) }
    out.push(rebaseGinReceiptPages(part, i + 1))
  }
  return out
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

describe('Servico statement — the fixture foots', () => {
  it('18 pages; statement 1 nets sum to 645,220, statement 2 to 183,540; bale weights foot to the lint totals', () => {
    expect(PAGES).toHaveLength(18)
    expect(sum(S1_LOADS.map(([, n]) => n))).toBe(S1.seed)
    expect(sum(S2_LOADS.map(([, n]) => n))).toBe(S2.seed)
    expect(sum(S1_BALES.map((b) => b.net_weight_lbs))).toBe(S1.lint)
    expect(sum(S2_BALES.map((b) => b.net_weight_lbs))).toBe(S2.lint)
    expect(S1_BALES).toHaveLength(585)
    expect(S2_BALES).toHaveLength(160)
  })
  it('rolls: statement 1 = 131 (21 × 6 + 5), statement 2 = 36; every gross − 31,400 tare = net', () => {
    const l1 = S1_LOADS.map(loadLine)
    expect(sum(l1.map((l) => l.rolls))).toBe(131)
    expect(sum(S2_LOADS.map(loadLine).map((l) => l.rolls))).toBe(36)
    expect(l1.every((l) => l.gross - l.tare === l.net)).toBe(true)
  })
})

describe('Servico statement — chunk merge + page grouping (Part C)', () => {
  const merged = mergeGinReceipts(chunks())
  const statements = groupStatementPages(merged.pages)

  it('three 6-page chunks come back as 18 pages in order; chunk 3 straddles both statements', () => {
    expect(merged.pages.map((p) => p.page)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    const chunk3 = chunks()[2]
    expect(chunk3.pages.map((p) => p.page)).toEqual([13, 14, 15, 16, 17, 18])
    expect(chunk3.pages.map((p) => p.statement_date)).toEqual(['2026-10-10', '2026-10-10', '2026-10-07', '2026-10-07', '2026-10-07', '2026-10-07'])
  })

  it('two statements: S1 pages 1–14 (10/10, 22 loads, 585 bales), S2 pages 15–18 (10/7, 6 loads, 160 bales); S2 never folds into S1', () => {
    expect(statements).toHaveLength(2)
    const [s1, s2] = statements
    expect(s1.pages).toEqual(Array.from({ length: 14 }, (_, i) => i + 1))
    expect(s1.boundary).toBe('first')
    expect(s1.receipt_date).toBe('2026-10-10')
    expect(s1.loads).toHaveLength(22)
    expect(s1.bales).toHaveLength(585)
    expect(s1.bales_count).toBe(585)
    expect(s1.modules_count).toBe(22)
    expect(s1.total_seed_cotton_weight).toBe(645_220)
    expect(s1.farm_ytd).toEqual(S1.ytd)
    expect(s2.pages).toEqual([15, 16, 17, 18])
    expect(s2.boundary).toBe('totals_block')
    expect(s2.receipt_date).toBe('2026-10-07')
    expect(s2.loads.map((l) => l.load_number)).toEqual(['31631', '31628', '31627', '31629', '31630', '31634'])
    expect(s2.bales).toHaveLength(160)
    expect(s2.bales[0].pbi_number).toBe('178962')
    expect(s2.farm_ytd).toEqual(S2.ytd)
  })

  it('header fields come from each statement\'s own pages: both say Gin 40614, no statement number; "5824 WHEELER" splits into farm # + name; crop year from the date', () => {
    for (const s of statements) {
      expect(s.gin_code).toBe('40614')
      expect(s.statement_number).toBeNull()
      expect(s.farm_number).toBe('5824')
      expect(s.farm_name).toBe('WHEELER')
      expect(s.field).toBe('PIVOT')
      expect(s.crop_year).toBe(2026)
    }
  })

  it('turnout: S1 282,956 / 645,220 = 43.85%; S2 78,833 / 183,540 = 42.95%; reconcileBaleCount passes both', () => {
    const [s1, s2] = statements
    expect(lintTurnoutPct(s1.total_bale_weight!, s1.total_seed_cotton_weight!)).toBe(43.85)
    expect(lintTurnoutPct(s2.total_bale_weight!, s2.total_seed_cotton_weight!)).toBe(42.95)
    expect(reconcileBaleCount(s1.bales_count, s1.bales.length).ok).toBe(true)
    expect(reconcileBaleCount(s2.bales_count, s2.bales.length).ok).toBe(true)
  })

  it('the old "header from page 1" rule would have made one 28-load / 745-bale receipt — the date-change and row-restart signals also split, each on its own', () => {
    // Only the date changes (no totals block read on page 15):
    const noTotals = merged.pages.map((p) => (p.page === 15 ? { ...p, has_totals_block: false } : p))
    expect(groupStatementPages(noTotals).map((s) => [s.pages.length, s.boundary])).toEqual([[14, 'first'], [4, 'date_change']])
    // Only the bale rows restart (same date, no totals block):
    const rowsOnly = merged.pages.map((p) => ((p.page ?? 0) >= 15 ? { ...p, has_totals_block: false, statement_date: '2026-10-10' } : p))
    expect(groupStatementPages(rowsOnly).map((s) => [s.pages.length, s.boundary])).toEqual([[14, 'first'], [4, 'rows_restart']])
  })

  it('parseDocumentChunked rebases per chunk and the merge keeps a page returned twice once', async () => {
    const parts = chunks()
    const twice = [parts[0], { pages: [...parts[1].pages, { ...parts[1].pages[0] }] }, parts[2]]
    expect(mergeGinReceipts(twice).pages).toHaveLength(18)
    void parseDocumentChunked
  })
})

// ---------- Part B: load matching ----------

const saved = (n: string, net: number, over: Partial<MatchableLoad> = {}): MatchableLoad => ({
  id: `L${n}`, load_number: n, crop_year: 2026, net_weight: net, gross_weight: net + TARE, tare_weight: TARE, farm_id: 'farm-5824', field_id: 'field-pivot', ...over,
})
const [S1_STATEMENT, S2_STATEMENT] = groupStatementPages(mergeGinReceipts(chunks()).pages)

describe('Servico statement 2 (10/7/2026) against the module-list loads (Part B, tier 1)', () => {
  const savedLoads = ['031627', '031628', '031629', '031630', '031631', '031634'].map((n) => saved(n, S2_LOADS.find(([m]) => numberKey(m) === numberKey(n))![1]))
  const rows = matchStatementLoads(S2_STATEMENT.loads, savedLoads, { cropYear: 2026 })

  it('every line matches its leading-zero load on key; weights agree; "6 of 6 loads matched · 0 need review · 0 new."', () => {
    expect(rows.map((r) => r.status)).toEqual(['matched', 'matched', 'matched', 'matched', 'matched', 'matched'])
    expect(rows.map((r) => r.load!.load_number)).toEqual(['031631', '031628', '031627', '031629', '031630', '031634'])
    expect(matchSummary(rows).text).toBe('6 of 6 loads matched · 0 need review · 0 new.')
    expect(rows.every((r) => r.note == null)).toBe(true)
  })
  it('nets sum to the stated 183,540 and rolls to 36', () => {
    expect(sum(S2_STATEMENT.loads.map((l) => l.net!))).toBe(S2_STATEMENT.total_seed_cotton_weight)
    expect(sum(S2_STATEMENT.loads.map((l) => l.rolls!))).toBe(36)
  })
  it('the stored numbers are never rewritten — the match row keeps 031631 while the line says 31631', () => {
    expect(rows[0].line.load_number).toBe('31631')
    expect(rows[0].load!.load_number).toBe('031631')
    expect(rows[0].key).toBe('31631')
  })
})

describe('Servico statement 1 (10/10/2026) — 22 lines (Part B)', () => {
  const savedAll = S1_LOADS.map(([n, net]) => saved(`0${n}`, net))
  it('with all 22 saved with a leading zero: "22 of 22 loads matched · 0 need review · 0 new."', () => {
    const rows = matchStatementLoads(S1_STATEMENT.loads, savedAll, { cropYear: 2026 })
    expect(matchSummary(rows)).toMatchObject({ total: 22, matched: 22, review: 0, fresh: 0 })
    expect(matchSummary(rows).text).toBe('22 of 22 loads matched · 0 need review · 0 new.')
    expect(sum(S1_STATEMENT.loads.map((l) => l.net!))).toBe(645_220)
  })

  it('weights: saved 031632 net 31,300 vs line 31,320 agrees (within 20); 31,230 links but goes amber, "differs by 90 lbs"', () => {
    const close = matchStatementLoads(S1_STATEMENT.loads, [saved('031632', 31_300)], { cropYear: 2026 })
    const r = close.find((x) => x.key === '31632')!
    expect(r.status).toBe('matched')
    expect(r.note).toBeNull()
    const far = matchStatementLoads(S1_STATEMENT.loads, [saved('031632', 31_230)], { cropYear: 2026 }).find((x) => x.key === '31632')!
    expect(far.status).toBe('weight_differs')
    expect(far.load!.load_number).toBe('031632')
    expect(far.note).toBe('Net differs: ticket 31,230 vs statement 31,320 (differs by 90 lbs).')
    expect(far.netDiffLbs).toBe(90)
    expect(matchSummary(far ? [far] : []).text).toBe('1 of 1 load matched · 1 needs review · 0 new.')
  })

  it('ambiguous: saved 031633 AND 31633 → line 31633 is not linked, with the merge message', () => {
    const rows = matchStatementLoads(S1_STATEMENT.loads, [saved('031633', 31_000), saved('31633', 31_000, { id: 'dup' })], { cropYear: 2026 })
    const r = rows.find((x) => x.key === '31633')!
    expect(r.status).toBe('ambiguous')
    expect(r.load).toBeNull()
    expect(r.note).toBe('Two saved loads share number 31633 (031633 and 31633). Merge them on Seed Cotton Loads, then re-check.')
    expect(canCreateLoad(r)).toBe(false)
  })

  it('cross-year: 031633 saved only in 2025 → no match for the 2026 receipt', () => {
    const rows = matchStatementLoads(S1_STATEMENT.loads, [saved('031633', 31_000, { crop_year: 2025 })], { cropYear: 2026 })
    expect(rows.find((x) => x.key === '31633')!.status).toBe('new')
  })

  it('already on another saved receipt: flagged, never double-linked', () => {
    const rows = matchStatementLoads(S1_STATEMENT.loads, [saved('031633', 31_000)], { cropYear: 2026, onReceipt: new Map([['L031633', 'Servico, Inc. · 10/2/2026 · farm 5824 · Pivot']]), receiptIdByLoad: new Map([['L031633', 'r-old']]) })
    const r = rows.find((x) => x.key === '31633')!
    expect(r.status).toBe('on_other_receipt')
    expect(r.load).toBeNull()
    expect(r.note).toBe('Load 031633 is already on receipt Servico, Inc. · 10/2/2026 · farm 5824 · Pivot.')
    // Re-scanning THAT receipt: its own links do not count as another receipt.
    const own = matchStatementLoads(S1_STATEMENT.loads, [saved('031633', 31_000)], { cropYear: 2026, onReceipt: new Map([['L031633', 'x']]), receiptIdByLoad: new Map([['L031633', 'r-old']]), thisReceiptId: 'r-old' })
    expect(own.find((x) => x.key === '31633')!.status).toBe('matched')
  })

  it('tick mark: line read as 316411 (net 29,580); saved 031641 on no receipt with the same net + gross → "Possibly 031641", not auto-linked; [Link] links it', () => {
    const lines = S1_STATEMENT.loads.map((l) => (l.load_number === '31641' ? { ...l, load_number: '316411' } : l))
    const savedLoads = [saved('031641', 29_580)]
    const rows = matchStatementLoads(lines, savedLoads, { cropYear: 2026 })
    const r = rows.find((x) => x.line.load_number === '316411')!
    expect(r.status).toBe('suggested')
    expect(r.load).toBeNull()
    expect(r.note).toBe('Possibly 031641 (same 29,580 lbs net).')
    expect(r.candidates.map((c) => c.load_number)).toEqual(['031641'])
    expect(canCreateLoad(r)).toBe(false)
    expect(matchSummary(rows).text).toBe('0 of 22 loads matched · 1 needs review · 21 new.')
    const linked = matchStatementLoads(lines, savedLoads, { cropYear: 2026, linked: new Map([[r.index, 'L031641']]) })
    const lr = linked.find((x) => x.line.load_number === '316411')!
    expect(lr.status).toBe('matched')
    expect(lr.load!.load_number).toBe('031641')
    expect(lr.note).toBe('Linked to 031641 by you.')
  })

  it('two candidates with the same net and gross → both listed, no default; a load on a receipt is never suggested', () => {
    const lines = [{ load_number: '316411', rolls: 6, gross: 60_980, tare: TARE, net: 29_580 }]
    const rows = matchStatementLoads(lines, [saved('031641', 29_580), saved('031699', 29_580)], { cropYear: 2026 })
    expect(rows[0].status).toBe('suggested_many')
    expect(rows[0].candidates.map((c) => c.load_number)).toEqual(['031641', '031699'])
    expect(rows[0].load).toBeNull()
    // Same farm/field preferred when the receipt knows it.
    const pref = matchStatementLoads(lines, [saved('031641', 29_580), saved('031699', 29_580, { field_id: 'other' })], { cropYear: 2026, farmId: 'farm-5824', fieldId: 'field-pivot' })
    expect(pref[0].status).toBe('suggested')
    expect(pref[0].candidates[0].load_number).toBe('031641')
    const busy = matchStatementLoads(lines, [saved('031641', 29_580)], { cropYear: 2026, onReceipt: new Map([['L031641', 'r']]) })
    expect(busy[0].status).toBe('new')
  })

  it('create-missing: line 31639 with 031639 saved → "Create load" is never offered; with nothing saved it is', () => {
    const withSaved = matchStatementLoads(S1_STATEMENT.loads, [saved('031639', 29_620)], { cropYear: 2026 })
    expect(canCreateLoad(withSaved.find((x) => x.key === '31639')!)).toBe(false)
    const none = matchStatementLoads(S1_STATEMENT.loads, [], { cropYear: 2026 })
    expect(none.every((r) => r.status === 'new' && canCreateLoad(r))).toBe(true)
    expect(matchSummary(none).text).toBe('0 of 22 loads matched · 0 need review · 22 new.')
    // The same number twice in one statement's table: the second is never created either.
    const dup = matchStatementLoads([...S1_STATEMENT.loads, { ...S1_STATEMENT.loads[0] }], [], { cropYear: 2026 })
    expect(dup[22].status).toBe('duplicate_line')
    expect(canCreateLoad(dup[22])).toBe(false)
  })

  it('farm/field: all matched loads on farm 5824 / Pivot → the receipt defaults to it; a printed field that disagrees is flagged', () => {
    const rows = matchStatementLoads(S1_STATEMENT.loads, savedAll, { cropYear: 2026 })
    expect(farmFieldFromMatches(rows)).toEqual({ farmId: 'farm-5824', fieldId: 'field-pivot', count: 22 })
    expect(printedVsMatchedNote({ printedFarmNumber: '5824', printedField: 'PIVOT', matchedFarmFsa: '5824', matchedFieldName: 'Pivot' })).toBeNull()
    expect(printedVsMatchedNote({ printedFarmNumber: '5824', printedField: 'EAST 40', matchedFarmFsa: '5824', matchedFieldName: 'Pivot' }))
      .toBe('Check the farm and field: the statement prints field "EAST 40" but the matched loads are on "Pivot".')
    const mixed = matchStatementLoads(S1_STATEMENT.loads, savedAll.map((l, i) => (i === 0 ? { ...l, field_id: 'other' } : l)), { cropYear: 2026 })
    expect(farmFieldFromMatches(mixed)).toBeNull()
  })
})

// ---------- Part D: identity ----------

describe('Servico statement identity (Part D): "Gin 40614" is the gin, not the statement', () => {
  it('both statements print Gin 40614 and are two distinct receipts with deterministic synthesized numbers', () => {
    expect(statementIdentity(S1_STATEMENT)).not.toBe(statementIdentity(S2_STATEMENT))
    expect(synthesizeReceiptNumber(S1_STATEMENT)).toBe('40614-20261010-5824-PIVOT-22-645220-585')
    expect(synthesizeReceiptNumber(S2_STATEMENT)).toBe('40614-20261007-5824-PIVOT-6-183540-160')
    expect(isSynthesizedReceiptNumber(synthesizeReceiptNumber(S2_STATEMENT))).toBe(true)
    expect(isSynthesizedReceiptNumber('40614')).toBe(false)
    expect(isSynthesizedReceiptNumber('S-1234')).toBe(false)
  })
  it('a printed statement number wins the identity and the receipt number', () => {
    const s = { ...S2_STATEMENT, statement_number: 'ST-778' }
    expect(statementIdentity(s)).toBe('S|40614|ST-778')
    expect(synthesizeReceiptNumber(s)).toBe('ST-778')
  })
  it('displayed by gin + date + farm/field, never the synthesized string', () => {
    expect(receiptDisplayName({ gin_name: 'Servico, Inc.', gin_code: '40614', receipt_date: '2026-10-07', farm_label: '5824', field_label: 'Pivot', statement_number: null, receipt_number: '40614-20261007-5824-PIVOT-6-183540-160' }))
      .toBe('Servico, Inc. · 10/7/2026 · farm 5824 · Pivot')
    expect(receiptDisplayName({ gin_name: null, gin_code: '40614', receipt_date: null, statement_number: 'ST-778' })).toBe('Gin 40614 · no date · #ST-778')
  })
  it('the same PDF uploaded again: both statements "already saved"; different date or totals → never a duplicate', () => {
    const savedRows = [S1_STATEMENT, S2_STATEMENT].map((s, i) => ({
      id: `r${i + 1}`, receipt_number: synthesizeReceiptNumber(s), crop_year: 2026, receipt_date: s.receipt_date, gin_code: s.gin_code, statement_number: null,
      printed_farm_number: s.farm_number, printed_field: s.field, modules_count: s.modules_count, total_seed_cotton_weight: s.total_seed_cotton_weight, bales_count: s.bales_count, total_bale_weight: s.total_bale_weight,
    }))
    expect(classifyStatement(S1_STATEMENT, savedRows, 2026)).toEqual({ status: 'saved', existingId: 'r1' })
    expect(classifyStatement(S2_STATEMENT, savedRows, 2026)).toEqual({ status: 'saved', existingId: 'r2' })
    expect(classifyStatement({ ...S2_STATEMENT, receipt_date: '2026-10-08' }, savedRows, 2026).status).toBe('new')
    expect(classifyStatement({ ...S2_STATEMENT, bales_count: 161 }, savedRows, 2026).status).toBe('new')
    expect(classifyStatement(S2_STATEMENT, savedRows, 2025).status).toBe('new')
    // A re-scan of the same statement with a corrected lint total is an update.
    const u = classifyStatement({ ...S2_STATEMENT, total_bale_weight: 78_900 }, savedRows, 2026)
    expect(u).toEqual({ status: 'update', existingId: 'r2', diffs: ['lint 78,833 → 78,900 lbs'] })
  })
  it('a receipt saved before 093 under the gin code as its number is NOT what a new upload matches — only the identity or the synthesized number', () => {
    const legacy = [{ id: 'old', receipt_number: '40614', crop_year: 2026, receipt_date: '2026-10-10', modules_count: 28, total_seed_cotton_weight: 828_760, bales_count: 745, total_bale_weight: 361_789 }]
    expect(classifyStatement(S1_STATEMENT, legacy, 2026).status).toBe('new')
  })
})

// ---------- Part E: Farm YTD ----------

describe('Servico Farm YTD check (Part E) — informational', () => {
  const asOther = (s: GinStatement) => ({ gin_code: s.gin_code, farm_number: s.farm_number, receipt_date: s.receipt_date, modules_count: s.modules_count, total_seed_cotton_weight: s.total_seed_cotton_weight, bales_count: s.bales_count, total_bale_weight: s.total_bale_weight })

  it('S1 alone vs its YTD (28 / 828,760 / 745 / 361,789): short by 6 modules / 183,540 lbs / 160 bales / 78,833 lbs', () => {
    const c = farmYtdCheck(S1_STATEMENT, [])
    expect(c.status).toBe('short')
    expect(c.have).toEqual({ modules: 22, seed_cotton_lbs: 645_220, bales: 585, bale_weight: 282_956 })
    expect(c.printed!.modules! - c.have.modules!).toBe(6)
    expect(c.printed!.seed_cotton_lbs! - c.have.seed_cotton_lbs!).toBe(183_540)
    expect(c.printed!.bales! - c.have.bales!).toBe(160)
    expect(c.printed!.bale_weight! - c.have.bale_weight!).toBe(78_833)
    expect(c.message).toBe('Gin 40614 shows 28 modules / 745 bales YTD for farm 5824. Turnrow has 22 / 585. A statement may not be uploaded yet.')
  })
  it('S1 + S2 → exact: 22 + 6 = 28; 645,220 + 183,540 = 828,760; 585 + 160 = 745; 282,956 + 78,833 = 361,789', () => {
    const c = farmYtdCheck(S1_STATEMENT, [asOther(S2_STATEMENT)])
    expect(c.status).toBe('match')
    expect(c.have).toEqual({ modules: 28, seed_cotton_lbs: 828_760, bales: 745, bale_weight: 361_789 })
    expect(c.message).toBe('Farm YTD matches your statements.')
  })
  it('S2 (YTD 5 / 133 below its own 6 / 160) → check skipped with the muted note', () => {
    const c = farmYtdCheck(S2_STATEMENT, [asOther(S1_STATEMENT)])
    expect(c.status).toBe('printed_before')
    expect(c.message).toBe('Gin YTD was printed before this statement posted.')
  })
  it('only the same gin + farm # dated on or before count; a later statement does not', () => {
    const otherFarm = { ...asOther(S2_STATEMENT), farm_number: '5825' }
    expect(farmYtdCheck(S1_STATEMENT, [otherFarm]).status).toBe('short')
    const later = { ...asOther(S2_STATEMENT), receipt_date: '2026-10-12' }
    expect(farmYtdCheck(S1_STATEMENT, [later]).status).toBe('short')
    expect(farmYtdCheck(S1_STATEMENT, [asOther(S2_STATEMENT), asOther(S2_STATEMENT)]).status).toBe('over')
    expect(farmYtdCheck({ ...S1_STATEMENT, farm_ytd: null }, []).status).toBe('none')
  })
})
