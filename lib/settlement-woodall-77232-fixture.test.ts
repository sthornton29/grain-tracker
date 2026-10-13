import { describe, expect, it } from 'vitest'
import { parseDocumentChunked, type ParseAttempt } from '@/lib/parse-chunked'
import { mergeSettlements } from '@/lib/parse-merge'
import { normalizeSettlementExtraction, ParseTimeoutError, ParseTooLongError, type ParseImage, type ParseOptions, type SettlementExtraction } from '@/lib/pdf-upload'
import { flagSummaryLines, reconcileLines, settlementCompleteness } from '@/lib/settlement-lines'
import { expectedOutputTokens, outputBudget, planChunks } from '@/lib/chunk-plan'
import { countSettlementRows } from '@/lib/pdf-text'

// ---------------------------------------------------------------------------
// Woodall Grain settlement 77232 (10/5/2026): 8 landscape pages, 94 tickets
// on contract 93115 Flat $4.70250 (100,000 bu priced, 99,451.424 settled,
// 548.576 remaining), tickets per page 11/14/14/14/14/14/13/0 (page 8 is the
// Deduction Summary). Totals: 99,451.424 bu, gross $467,670.35, Checkoff\SPARC
// $994.57, net $466,675.78. First ticket 211065 (8/27/2026) 1,006.429 bu;
// last 215602 (9/24/2026) 1,075.357 bu.
//
// The production failure (2026-10-13): the first 6-page chunk (81 tickets)
// hit max_tokens (8192) and the JSON was cut mid-ticket; 13 tickets were
// saved as the whole settlement. Per-ticket figures here are SYNTHETIC
// (the real PDF is never in the repo) and sum exactly to the printed totals.
// Everything after the model is under test: the adaptive splitter, the
// nested-block flatten, the merge, the totals guard and the completeness
// guard the review page shows.
// ---------------------------------------------------------------------------

const PRICE = 4.7025
const TICKETS_PER_PAGE = [11, 14, 14, 14, 14, 14, 13, 0]
const TICKET_COUNT = 94
const SETTLED_BU = 99_451.424
const GROSS = 467_670.35
const CHECKOFF = 994.57
const NET = 466_675.78
const FIRST_TICKET = 211065
const LAST_TICKET = 215602

type Ticket = { page: number; ticket: string; date: string; vehicle: string; bu: number; lb: number; gross: number; checkoff: number }

const r3 = (x: number) => Math.round(x * 1000) / 1000
const r2 = (x: number) => Math.round(x * 100) / 100

function buildTickets(): Ticket[] {
  expect(TICKETS_PER_PAGE.reduce((s, n) => s + n, 0)).toBe(TICKET_COUNT)
  // Bushels: first and last as printed; the 92 between follow a plausible
  // pattern and index 50 absorbs the remainder so the sum is exact.
  const bu: number[] = []
  for (let i = 0; i < TICKET_COUNT; i++) {
    if (i === 0) bu.push(1006.429)
    else if (i === TICKET_COUNT - 1) bu.push(1075.357)
    else bu.push(r3(1000 + ((i * 37) % 117) + ((i * 7) % 1000) / 1000))
  }
  const ADJ = 50
  bu[ADJ] = r3(SETTLED_BU - bu.reduce((s, b, i) => (i === ADJ ? s : s + b), 0))
  expect(bu[ADJ]).toBeGreaterThan(900)
  expect(bu[ADJ]).toBeLessThan(1200)
  expect(r3(bu.reduce((s, b) => s + b, 0))).toBe(SETTLED_BU)

  const out: Ticket[] = []
  let i = 0
  for (let p = 0; p < TICKETS_PER_PAGE.length; p++) {
    for (let k = 0; k < TICKETS_PER_PAGE[p]; k++, i++) {
      // Gross = bushels × $4.70250 rounded per ticket; checkoff 1¢ a bushel.
      const gross = r2(bu[i] * PRICE)
      const ck = r2(bu[i] * 0.01)
      // 8/27 → 9/24: four weeks of hauling, ascending.
      const day = new Date(Date.UTC(2026, 7, 27) + Math.floor((i * 28) / (TICKET_COUNT - 1)) * 86_400_000)
      out.push({
        page: p + 1,
        ticket: String(FIRST_TICKET + Math.round((i * (LAST_TICKET - FIRST_TICKET)) / (TICKET_COUNT - 1))),
        date: day.toISOString().slice(0, 10),
        vehicle: i % 3 === 0 ? 'Green/Tinus' : i % 3 === 1 ? 'White/Avery' : 'Red/Tinus',
        bu: bu[i],
        lb: Math.round(bu[i] * 56),
        gross,
        checkoff: ck,
      })
    }
  }
  // The per-ticket rounding leaves a few cents against the printed totals;
  // the same middle ticket absorbs them (the first and last stay as printed).
  out[ADJ].gross = r2(out[ADJ].gross + (GROSS - r2(out.reduce((s, t) => s + t.gross, 0))))
  out[ADJ].checkoff = r2(out[ADJ].checkoff + (CHECKOFF - r2(out.reduce((s, t) => s + t.checkoff, 0))))
  return out
}

const TICKETS = buildTickets()
const onPages = (from: number, to: number) => TICKETS.filter((t) => t.page >= from && t.page <= to)

/** What the trimmed prompt asks for: nested block, nulls OMITTED. */
function nestedLine(t: Ticket) {
  return {
    ticket_number: t.ticket,
    delivery_date: t.date,
    vehicle_plate: t.vehicle,
    net_weight: t.lb,
    net_bushels: t.bu,
    gross_revenue: t.gross,
    discounts: t.checkoff,
    grade_readings: { grade: '1 US #1', moisture: 15, test_weight: 56 },
  }
}

/** The model's answer for pages from..to of the statement (nested shape). */
function answerFor(from: number, to: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    contract_blocks: [{ contract_number: '93115', price_per_bushel: PRICE, crop: 'Yellow Corn', line_items: onPages(from, to).map(nestedLine) }],
    discount_items: [],
  }
  if (from === 1) {
    Object.assign(out, { buyer_name: 'Woodall Grain Company', settlement_date: '2026-10-05', settlement_number: '77232', contract_number: '93115', statement_reported_ticket_count: TICKET_COUNT })
  }
  if (to === 8) {
    Object.assign(out, {
      statement_reported_total: NET, statement_reported_gross: GROSS, statement_reported_bushels: SETTLED_BU,
      contract_summary: { contract_number: '93115', priced_bushels: 100_000, settled_bushels: SETTLED_BU, remaining_bushels: 548.576 },
      discount_items: [{ category: 'checkoff', description: 'Checkoff\\SPARC — Alabama Dept of Agriculture', deduction_kind: 'price', amount: CHECKOFF }],
      payment_date: '2026-10-05', payment_number: 'ACH',
    })
  }
  return out
}

// ---- the scripted model + fake PDF (no pdf-lib) ----
const WHOLE = '77232.pdf'
const fakePdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], WHOLE, { type: 'application/pdf' })
const slicer = async (_f: File, from: number, to: number) => new File([new Uint8Array([1])], `p${from}-${to}.pdf`, { type: 'application/pdf' })
function rangeOf(input: File | ParseImage[]): { from: number; to: number } {
  const f = input as File
  if (f.name === WHOLE) return { from: 1, to: 8 }
  const m = /^p(\d+)-(\d+)\.pdf$/.exec(f.name)!
  return { from: Number(m[1]), to: Number(m[2]) }
}
type Rule = (r: { from: number; to: number }, opts: ParseOptions) => Error | null
function model(rule: Rule) {
  return async (input: File | ParseImage[], _t: unknown, opts: ParseOptions) => {
    const r = rangeOf(input)
    const err = rule(r, opts)
    if (err) throw err
    const answer = answerFor(r.from, r.to)
    opts.onUsage?.({ input_tokens: 4000, output_tokens: 130 * onPages(r.from, r.to).length + 500, stop_reason: 'end_turn' })
    return answer
  }
}
/** Over 2 pages the answer runs past 8192 tokens — as measured. */
const truncatesOverTwoPages: Rule = (r) => (r.to - r.from + 1 > 2 ? new ParseTooLongError('cut', { stopReason: 'max_tokens', outputTokens: 8192 }) : null)
const log = (a: ParseAttempt[]) => a.map((x) => `${x.from}-${x.to}:${x.outcome}`)

async function read(rule: Rule, extra: Record<string, unknown> = {}) {
  return parseDocumentChunked<SettlementExtraction>(fakePdf(), 'settlement', {
    merge: mergeSettlements, parse: model(rule), slice: slicer, pageCount: async () => 8, textRows: async () => null, ...extra,
  })
}

function completenessOf(data: SettlementExtraction, failedRanges: Array<{ from: number; to: number }>) {
  const guards = flagSummaryLines(data.line_items, { settlementNumber: data.settlement_number })
  const kept = data.line_items.filter((_, i) => !guards[i].flagged)
  return settlementCompleteness({
    capturedTickets: kept.length,
    reportedTickets: data.statement_reported_ticket_count,
    capturedBushels: kept.reduce((s, l) => s + (l.net_bushels ?? 0), 0),
    reportedBushels: data.statement_reported_bushels,
    capturedGross: kept.reduce((s, l) => s + (l.gross_revenue ?? 0), 0),
    reportedGross: data.statement_reported_gross,
    capturedNet: kept.reduce((s, l) => s + (l.gross_revenue ?? 0) - (l.discounts ?? 0), 0),
    reportedNet: data.statement_reported_total,
    failedRanges,
  })
}

describe('Woodall 77232 — the fixture itself', () => {
  it('94 tickets, 211065 … 215602 ascending, bushels / gross / checkoff / net exactly as printed', () => {
    expect(TICKETS).toHaveLength(94)
    expect(TICKETS[0]).toMatchObject({ ticket: '211065', date: '2026-08-27', bu: 1006.429, lb: 56_360, checkoff: 10.06 })
    expect(TICKETS[0].gross).toBe(4732.73)
    expect(TICKETS[93]).toMatchObject({ ticket: '215602', date: '2026-09-24', bu: 1075.357, gross: 5056.87, checkoff: 10.75 })
    for (let i = 1; i < TICKETS.length; i++) expect(Number(TICKETS[i].ticket)).toBeGreaterThan(Number(TICKETS[i - 1].ticket))
    expect(r3(TICKETS.reduce((s, t) => s + t.bu, 0))).toBe(SETTLED_BU)
    expect(r2(TICKETS.reduce((s, t) => s + t.gross, 0))).toBe(GROSS)
    expect(r2(TICKETS.reduce((s, t) => s + t.checkoff, 0))).toBe(CHECKOFF)
    expect(r2(GROSS - CHECKOFF)).toBe(NET)
    expect(TICKETS_PER_PAGE.map((_, p) => onPages(p + 1, p + 1).length)).toEqual(TICKETS_PER_PAGE)
  })

  it('the trimmed shape of one ticket is about 90 tokens by chars/4 (measured untrimmed: 235–245)', () => {
    const pretty = JSON.stringify(nestedLine(TICKETS[0]), null, 2).replace(/^/gm, '        ')
    const estimate = Math.round(pretty.length / 4)
    expect(estimate).toBeGreaterThan(60)
    expect(estimate).toBeLessThan(130)
  })
})

describe('Woodall 77232 — the legacy 6-page chunk truncates; the splitter recovers every ticket', () => {
  it('attempts: 1–6 too_long → 1–3 too_long → 1–2, 3 → 4–6 too_long → 4–5, 6; then 7–8', async () => {
    const res = await read(truncatesOverTwoPages, { pagesPerBatch: 6 })
    expect(log(res.attempts)).toEqual([
      '1-6:too_long', '1-3:too_long', '1-2:ok', '3-3:ok', '4-6:too_long', '4-5:ok', '6-6:ok', '7-8:ok',
    ])
    expect(res.attempts[0].outputTokens).toBe(8192)
    expect(res.failedRanges).toEqual([])
    expect(res.warning).toBeNull()
    expect(res.pagesRead).toBe(8)

    const data = res.data
    const tickets = new Set(data.line_items.map((l) => l.ticket_number))
    expect(tickets.size).toBe(94)
    expect(data.line_items).toHaveLength(94)
    expect(data.line_items[0].ticket_number).toBe('211065')
    expect(data.line_items[93].ticket_number).toBe('215602')
    // The block's contract carried down to every line; nulls filled in.
    expect(data.line_items.every((l) => l.contract_number === '93115')).toBe(true)
    expect(data.line_items[0]).toMatchObject({ secondary_ref: null, gross_weight: null, tare_weight: null, special_discount_codes: null, net_weight: 56_360 })
    expect(data.line_items[0].grade_readings).toEqual({ grade: '1 US #1', moisture: 15, test_weight: 56, foreign_material: null, splits: null, total_damage: null, heat_damage: null, other_color: null, oil: null, protein: null })

    // Header from page 1, totals from page 8, the printed count carried.
    expect(data).toMatchObject({ buyer_name: 'Woodall Grain Company', settlement_number: '77232', contract_number: '93115', statement_reported_ticket_count: 94, statement_reported_total: NET, statement_reported_gross: GROSS, statement_reported_bushels: SETTLED_BU })
    expect(data.contract_summary).toEqual({ contract_number: '93115', priced_bushels: 100_000, settled_bushels: SETTLED_BU, remaining_bushels: 548.576 })

    // Totals reconcile exactly.
    const guards = flagSummaryLines(data.line_items, { settlementNumber: data.settlement_number })
    expect(guards.every((g) => !g.flagged)).toBe(true)
    expect(r3(data.line_items.reduce((s, l) => s + (l.net_bushels ?? 0), 0))).toBe(SETTLED_BU)
    expect(r2(data.line_items.reduce((s, l) => s + (l.gross_revenue ?? 0), 0))).toBe(GROSS)
    expect(r2(data.line_items.reduce((s, l) => s + (l.discounts ?? 0), 0))).toBe(CHECKOFF)
    const rec = reconcileLines(data.line_items.map((l) => ({ ...l, excluded: false })), data.statement_reported_total)
    expect(rec.linesTotal).toBeCloseTo(NET, 2)
    expect(rec.mismatch).toBe(false)
    const c = completenessOf(data, res.failedRanges)
    expect(c.ok).toBe(true)
    expect(c.missingTickets).toBe(0)
    expect(c.text).toBeNull()
    // The checkoff item survives the merge once.
    expect(data.discount_items).toEqual([{ category: 'checkoff', description: 'Checkoff\\SPARC — Alabama Dept of Agriculture', deduction_kind: 'price', amount: CHECKOFF }])
  })

  it('with the density plan (default) the chunks are 2 pages and nothing truncates', async () => {
    const res = await read(truncatesOverTwoPages)
    expect(log(res.attempts)).toEqual(['1-2:ok', '3-4:ok', '5-6:ok', '7-8:ok'])
    expect(res.data.line_items).toHaveLength(94)
  })

  it('with the text layer counted (11/14/14/14/14/14/13/0) the plan is the same four chunks', async () => {
    const textRows = async () => TICKETS_PER_PAGE.map((n, p) => onPages(p + 1, p + 1).flatMap((t) => [t.ticket, t.vehicle, '1 US #1', `${Number(t.date.slice(5, 7))}/${Number(t.date.slice(8, 10))}/2026`]).concat(n === 0 ? ['Deduction Summary'] : []))
    const rows = (await textRows()).map(countSettlementRows)
    expect(rows).toEqual(TICKETS_PER_PAGE)
    expect(planChunks({ documentType: 'settlement', maxTokens: 8192, from: 1, to: 8, rowsByPage: rows })).toEqual([
      { from: 1, to: 2 }, { from: 3, to: 4 }, { from: 5, to: 6 }, { from: 7, to: 8 },
    ])
    const res = await read(truncatesOverTwoPages, { textRows })
    expect(log(res.attempts)).toEqual(['1-2:ok', '3-4:ok', '5-6:ok', '7-8:ok'])
  })

  it('chunk-plan: the first 2-page chunk expects under 60% of 8192; a 6-page chunk would not', () => {
    expect(expectedOutputTokens({ documentType: 'settlement', maxTokens: 8192, rowsByPage: [11, 14] })).toBe(500 + 25 * 130)
    expect(expectedOutputTokens({ documentType: 'settlement', maxTokens: 8192, rowsByPage: [11, 14] })).toBeLessThan(outputBudget(8192))
    expect(expectedOutputTokens({ documentType: 'settlement', maxTokens: 8192, rowsByPage: [11, 14, 14, 14, 14, 14] })).toBeGreaterThan(outputBudget(8192))
  })
})

describe('Woodall 77232 — a page that fails even alone', () => {
  it('page 4 (14 tickets) truncates at every cap: failedRanges names it, 80 of 94 captured, not ok', async () => {
    const rule: Rule = (r) => (r.from <= 4 && r.to >= 4 ? new ParseTooLongError() : truncatesOverTwoPages(r, {}))
    const res = await read(rule, { pagesPerBatch: 6 })
    expect(log(res.attempts)).toEqual([
      '1-6:too_long', '1-3:too_long', '1-2:ok', '3-3:ok', '4-6:too_long', '4-5:too_long', '4-4:too_long', '4-4:too_long', '5-5:ok', '6-6:ok', '7-8:ok',
    ])
    expect(res.failedRanges).toEqual([{ from: 4, to: 4, reason: 'too_long', message: expect.any(String) }])
    expect(res.failedPages).toBe('4')
    expect(res.warning).toBe('Page 4 returned no tickets after several tries.')
    expect(res.pagesRead).toBe(7)
    expect(res.data.line_items).toHaveLength(80)

    const c = completenessOf(res.data, res.failedRanges)
    expect(c.ok).toBe(false)
    expect(c.missingTickets).toBe(14)
    expect(c.text!.startsWith('Captured 80 of 94 tickets. Page 4 returned no tickets.')).toBe(true)
    expect(c.text).toMatch(/the statement prints 99,451 bu/)
    expect(c.bushelsDelta).toBeCloseTo(-onPages(4, 4).reduce((s, t) => s + t.bu, 0), 3)
  })

  it('"Read those pages again": only the failed range is read, merged in, and the settlement is whole', async () => {
    const rule: Rule = (r) => (r.from <= 4 && r.to >= 4 ? new ParseTooLongError() : truncatesOverTwoPages(r, {}))
    const first = await read(rule, { pagesPerBatch: 6 })
    const again = await read((r) => truncatesOverTwoPages(r, {}), { pages: first.failedRanges.map(({ from, to }) => ({ from, to })) })
    expect(log(again.attempts)).toEqual(['4-4:ok'])
    expect(again.data.line_items).toHaveLength(14)
    const merged = mergeSettlements([first.data, again.data])
    expect(merged.line_items).toHaveLength(94)
    expect(new Set(merged.line_items.map((l) => l.ticket_number)).size).toBe(94)
    expect(merged.statement_reported_ticket_count).toBe(94)
    const c = completenessOf(merged, again.failedRanges)
    expect(c.ok).toBe(true)
  })

  it('the review copy when the whole first chunk is lost: "Captured 13 of 94 tickets. Pages 1 to 6 returned no tickets."', () => {
    const data = mergeSettlements([normalizeSettlementExtraction(answerFor(7, 8)), normalizeSettlementExtraction({ statement_reported_ticket_count: 94 })])
    expect(data.line_items).toHaveLength(13)
    const c = completenessOf(data, [{ from: 1, to: 6 }])
    expect(c.text!.startsWith('Captured 13 of 94 tickets. Pages 1 to 6 returned no tickets.')).toBe(true)
    expect(c.ok).toBe(false)
  })
})

describe('Woodall 77232 — a TIMEOUT on a chunk is split, not failed', () => {
  it('1–6 times out → halves read; every ticket recovered', async () => {
    const res = await read((r) => (r.from === 1 && r.to === 6 ? new ParseTimeoutError() : truncatesOverTwoPages(r, {})), { pagesPerBatch: 6 })
    expect(log(res.attempts)[0]).toBe('1-6:timeout')
    expect(res.attempts.filter((a) => a.outcome === 'timeout')).toHaveLength(1)
    expect(res.failedRanges).toEqual([])
    expect(res.data.line_items).toHaveLength(94)
  })
})

describe('Woodall 77232 — the nested shape through normalize + merge', () => {
  it('normalizeSettlementExtraction flattens blocks, carries the contract down, fills nulls, keeps block constants', () => {
    const n = normalizeSettlementExtraction(answerFor(1, 2))
    expect(n.line_items).toHaveLength(25)
    expect(n.line_items[0].contract_number).toBe('93115')
    expect(n.contract_blocks).toEqual([{ contract_number: '93115', price_per_bushel: PRICE, crop: 'Yellow Corn' }])
    expect(n.statement_reported_total).toBeNull()
    expect(n.contract_summary).toBeNull()
    expect(n.payment_number).toBeNull()
    expect(n.statement_reported_ticket_count).toBe(94)
  })

  it('tolerates a flat line_items array beside blocks (both kept, exact repeats dropped) and a block with no contract', () => {
    const flat = { line_items: [{ ticket_number: '1', net_bushels: 1, gross_revenue: 2, discounts: 0 }], contract_blocks: [{ line_items: [{ ticket_number: '1', net_bushels: 1, gross_revenue: 2, discounts: 0 }, { ticket_number: '2', net_bushels: 3, gross_revenue: 4, discounts: 0 }] }] }
    const n = normalizeSettlementExtraction(flat)
    expect(n.line_items.map((l) => l.ticket_number)).toEqual(['1', '2'])
    expect(n.line_items[1].contract_number).toBeNull()
    expect(n.contract_number).toBeNull()
    // The same ticket under two blocks (094) is two lines.
    const split = normalizeSettlementExtraction({ contract_blocks: [
      { contract_number: '2002960604-10', line_items: [{ ticket_number: '0502289', net_bushels: 58.284, gross_revenue: 100, discounts: 0 }] },
      { contract_number: 'SPOT', line_items: [{ ticket_number: '0502289', net_bushels: 912.744, gross_revenue: 1000, discounts: 0 }] },
    ] })
    expect(split.line_items.map((l) => `${l.ticket_number}|${l.contract_number}`)).toEqual(['0502289|2002960604-10', '0502289|SPOT'])
    expect(split.contract_number).toBe('2002960604-10')
  })

  it('mergeSettlements takes the first non-null printed ticket count and merges nested parts', () => {
    const merged = mergeSettlements([answerFor(1, 2) as unknown as SettlementExtraction, answerFor(3, 8) as unknown as SettlementExtraction])
    expect(merged.statement_reported_ticket_count).toBe(94)
    expect(merged.line_items).toHaveLength(94)
    expect(merged.statement_reported_total).toBe(NET)
    expect(mergeSettlements([normalizeSettlementExtraction({}), normalizeSettlementExtraction({ statement_reported_ticket_count: 7 })]).statement_reported_ticket_count).toBe(7)
  })
})
