import { describe, it, expect } from 'vitest'
import { describeRanges, flagSummaryLines, reconcileLines, settlementCompleteness, SUMMARY_LINE_REASON } from '@/lib/settlement-lines'
import { mergeSettlements } from '@/lib/parse-merge'
import type { SettlementExtraction } from '@/lib/pdf-upload'

// The regression shape: N ticket lines plus a CHECK-STUB line that carries
// the settlement's REF number and restates the grand total. The stub must be
// flagged/excluded and the remaining lines must reconcile to the statement's
// captured grand total.
//
// Worked: four corn tickets net 14,529.73 + 14,530.20 + 14,529.50 + 14,529.50
// = 58,118.93 bu; net dollars 72,358.07 + 72,360.41 + 72,356.89 + 72,356.89
// = 289,432.26. The stub: "58118.929 bu of yel corn REF 16936 — 289,432.26".

const tickets = [
  { ticket_number: '41217', net_bushels: 14529.73, gross_revenue: 72648.65, discounts: 290.58 },
  { ticket_number: '41218', net_bushels: 14530.2, gross_revenue: 72651.0, discounts: 290.59 },
  { ticket_number: '41221', net_bushels: 14529.5, gross_revenue: 72647.5, discounts: 290.61 },
  { ticket_number: '41224', net_bushels: 14529.5, gross_revenue: 72647.5, discounts: 290.61 },
]
const stub = { ticket_number: '16936', net_bushels: 58118.929, gross_revenue: 289432.26, discounts: 0 }

const PACKET: SettlementExtraction = {
  buyer_name: 'River Valley Grain', settlement_date: '2026-09-01', settlement_number: 'REF 16936',
  line_items: [...tickets, stub],
  discount_items: [],
  statement_reported_total: 289432.26,
  statement_reported_bushels: 58118.929,
}

describe('the check-stub line is flagged, the tickets are not', () => {
  const merged = mergeSettlements([PACKET])
  const guards = flagSummaryLines(merged.line_items, { settlementNumber: merged.settlement_number })

  it('flags exactly the stub, for all three reasons', () => {
    expect(guards.map((g) => g.flagged)).toEqual([false, false, false, false, true])
    const reason = guards[4].reason!
    expect(reason.startsWith(SUMMARY_LINE_REASON)).toBe(true)
    expect(reason).toMatch(/settlement reference number/)
    expect(reason).toMatch(/bushels equal the other lines/)
    expect(reason).toMatch(/three times the largest load/)
  })

  it('the remaining ticket lines reconcile to the captured grand total', () => {
    const lines = merged.line_items.map((l, i) => ({ ...l, excluded: guards[i].flagged }))
    const r = reconcileLines(lines, merged.statement_reported_total)
    expect(r.linesTotal).toBeCloseTo(289432.26, 2)
    expect(r.reportedTotal).toBe(289432.26)
    expect(r.mismatch).toBe(false)
  })

  it('had the stub been kept, the lines would double the statement — the reconciliation says so', () => {
    const r = reconcileLines(merged.line_items, merged.statement_reported_total)
    expect(r.linesTotal).toBeCloseTo(2 * 289432.26, 2)
    expect(r.mismatch).toBe(true)
  })
})

describe('each rule on its own', () => {
  it('(2) a stub whose ticket number is the REF, formatted differently, still matches', () => {
    const lines = [tickets[0], { ...stub, ticket_number: 'CK#16936' }]
    const g = flagSummaryLines(lines, { settlementNumber: '16936' })
    expect(g[1].flagged).toBe(true)
    expect(g[0].flagged).toBe(false)
  })
  it('(1) a TOTAL row equal to the sum of the others (no ref match) is flagged; a line that is neither a sum nor outsized is not', () => {
    const total = { ticket_number: 'TOTAL', net_bushels: 43589.43, gross_revenue: 217947.15, discounts: 871.78 }
    const g = flagSummaryLines([...tickets.slice(0, 3), total], { settlementNumber: '99' })
    expect(g[3].flagged).toBe(true)
    expect(g[3].reason).toMatch(/bushels equal the other lines/)
    // Within 1% still counts as the sum (0.6% high on bushels).
    const near = { ...total, net_bushels: 43850, gross_revenue: 219000, discounts: 0 }
    expect(flagSummaryLines([...tickets.slice(0, 3), near], { settlementNumber: '99' })[3].flagged).toBe(true)
    // A big-but-real load: 30,000 bu is neither ≈ the sum (43,589) nor > 3× the largest (43,590).
    const real = { ticket_number: '41230', net_bushels: 30000, gross_revenue: 150000, discounts: 600 }
    expect(flagSummaryLines([...tickets.slice(0, 3), real], { settlementNumber: '99' })[3].flagged).toBe(false)
  })
  it('(3) a line more than three times the largest other load is flagged', () => {
    const big = { ticket_number: '8', net_bushels: 50000, gross_revenue: 100, discounts: 0 }
    const g = flagSummaryLines([...tickets.slice(0, 2), big], { settlementNumber: null })
    expect(g[2].flagged).toBe(true)
    expect(g[2].reason).toMatch(/three times/)
  })
  it('two similar real loads never flag each other (rules 1 and 3 need two OTHER lines)', () => {
    const g = flagSummaryLines([tickets[0], tickets[1]], { settlementNumber: '16936' })
    expect(g.every((x) => !x.flagged)).toBe(true)
  })
  it('a legitimately large load among small ones (2.5×) is left alone', () => {
    const lines = [
      { ticket_number: '1', net_bushels: 400, gross_revenue: 1800, discounts: 0 },
      { ticket_number: '2', net_bushels: 420, gross_revenue: 1890, discounts: 0 },
      { ticket_number: '3', net_bushels: 1000, gross_revenue: 4500, discounts: 0 },
    ]
    expect(flagSummaryLines(lines, { settlementNumber: '7' }).every((x) => !x.flagged)).toBe(true)
  })
})

describe('settlementCompleteness — the review banner and the partial-save guard', () => {
  const whole = { capturedTickets: 94, reportedTickets: 94, capturedBushels: 99451.424, reportedBushels: 99451.424, capturedGross: 467670.35, reportedGross: 467670.35, capturedNet: 466675.78, reportedNet: 466675.78, failedRanges: [] }

  it('everything agrees: ok, no text', () => {
    const c = settlementCompleteness(whole)
    expect(c).toEqual({ ok: true, missingTickets: 0, bushelsDelta: 0, grossDelta: 0, netDelta: 0, text: null })
  })

  it('13 of 94 after the first chunk was lost: the exact banner copy', () => {
    const c = settlementCompleteness({ ...whole, capturedTickets: 13, capturedBushels: 13_800.5, capturedGross: 64_897.35, capturedNet: 64_759.35, failedRanges: [{ from: 1, to: 6 }] })
    expect(c.ok).toBe(false)
    expect(c.missingTickets).toBe(81)
    expect(c.text).toBe(
      'Captured 13 of 94 tickets. Pages 1 to 6 returned no tickets. ' +
      'The lines add up to 13,801 bu; the statement prints 99,451 bu. ' +
      'Gross on the lines is $64,897.35; the statement prints $467,670.35. ' +
      'Net on the lines is $64,759.35; the statement prints $466,675.78.',
    )
  })

  it('a failed range alone is enough to block, even when nothing was printed to compare', () => {
    const c = settlementCompleteness({ capturedTickets: 5, reportedTickets: null, capturedBushels: 0, reportedBushels: null, capturedGross: 0, reportedGross: null, capturedNet: 0, reportedNet: null, failedRanges: [{ from: 8, to: 8 }] })
    expect(c).toMatchObject({ ok: false, missingTickets: null, bushelsDelta: null, text: 'Page 8 returned no tickets.' })
  })

  it('more lines than printed is a disagreement too; rounding noise is not', () => {
    expect(settlementCompleteness({ ...whole, capturedTickets: 95 }).text).toBe('Captured 95 of 94 tickets.')
    expect(settlementCompleteness({ ...whole, capturedBushels: 99451.9, capturedGross: 467670.6, capturedNet: 466675.4 }).ok).toBe(true)
    expect(settlementCompleteness({ ...whole, capturedNet: 466_000 }).text).toBe('Net on the lines is $466,000.00; the statement prints $466,675.78.')
  })

  it('nothing printed and nothing failed: a hand-typed settlement is fine', () => {
    expect(settlementCompleteness({ capturedTickets: 3, reportedTickets: null, capturedBushels: 10, reportedBushels: null, capturedGross: 10, reportedGross: null, capturedNet: 10, reportedNet: undefined, failedRanges: [] }).ok).toBe(true)
  })

  it('describeRanges', () => {
    expect(describeRanges([{ from: 1, to: 6 }])).toBe('Pages 1 to 6')
    expect(describeRanges([{ from: 8, to: 8 }])).toBe('Page 8')
    expect(describeRanges([{ from: 1, to: 6 }, { from: 8, to: 8 }])).toBe('Pages 1 to 6 and 8')
    expect(describeRanges([{ from: 1, to: 2 }, { from: 4, to: 4 }, { from: 7, to: 8 }])).toBe('Pages 1 to 2, 4 and 7 to 8')
    expect(describeRanges([])).toBe('')
  })
})

describe('reconcileLines', () => {
  it('no captured total → nothing to check', () => {
    expect(reconcileLines(tickets, null)).toMatchObject({ reportedTotal: null, delta: null, mismatch: null })
  })
  it('tolerance is 0.5% (min $0.50)', () => {
    expect(reconcileLines(tickets, 289432.26 + 1000).mismatch).toBe(false) // 0.35%
    expect(reconcileLines(tickets, 289432.26 + 2000).mismatch).toBe(true)  // 0.69%
    expect(reconcileLines([{ ticket_number: '1', net_bushels: 10, gross_revenue: 40, discounts: 0 }], 40.4).mismatch).toBe(false)
    expect(reconcileLines([{ ticket_number: '1', net_bushels: 10, gross_revenue: 40, discounts: 0 }], 41).mismatch).toBe(true)
  })
})
