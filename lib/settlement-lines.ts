// Settlement line-item GUARD — belt and suspenders under the extraction
// prompt. Settlement packets end with a check stub / remittance page that
// restates the grand total ("58118.929 bu of yel corn REF 16936 —
// 289,432.26"), and settlement sheets print TOTAL rows after the ticket
// lines. Either can come back from the model as one more "ticket". This
// pure pass flags a line as a summary, not a load, when:
//
//   (1) its bushels OR its dollars ≈ the sum of all the OTHER lines (within
//       1%) — a total restated as a row;
//   (2) its "ticket number" equals the settlement's own reference / check /
//       settlement number — a stub line carrying the REF;
//   (3) its bushels exceed ~3× the largest other line — a total dwarfing
//       every real load.
//
// Rules (1) and (3) need at least two OTHER lines to compare against; a
// one-ticket settlement plus its stub is caught by (2). A flagged line is
// shown excluded on the review screen (amber, unchecked, one click to
// re-include if the guard misfires); the reconciliation then compares the
// INCLUDED lines' total against the statement's captured grand total.

import { fmtInt, fmtUsd } from '@/components/reports/report-format'

export type SettlementLineLike = {
  ticket_number: string | null | undefined
  net_bushels: number | string | null | undefined
  gross_revenue: number | string | null | undefined
  discounts: number | string | null | undefined
}

export type LineGuard = { flagged: boolean; reason: string | null }

const n = (v: number | string | null | undefined): number => {
  if (v == null || v === '') return 0
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const digits = (s: string | null | undefined): string => (s ?? '').replace(/\D+/g, '')
const netDollars = (l: SettlementLineLike): number => n(l.gross_revenue) - n(l.discounts)
const within = (a: number, b: number, pct: number): boolean => b !== 0 && Math.abs(a - b) <= Math.abs(b) * pct

export const SUMMARY_LINE_REASON = 'looks like the settlement total — not a load'

// (4) A "ticket" that is really a labelled total row ("Total From 0498074",
// "Contract Total 2002960604-10", "Settlement Total", "Subtotal", "Grand
// Total") — the Bunge shape prints several such rows, one after another.
// Woodall-shape rows join them: "Totals", "Deduction Summary", "Remit" /
// "Payment Amount", a "Contract Summary" - summaries, never loads.
const TOTAL_LABEL = /\b(sub)?totals?\b|\bgrand\s+total\b|\btotal\s+from\b|\bcontract\s+total\b|\bsettlement\s+total\b|\bsummary\b|\bremit(tance)?\b|\bpayment\s+amount\b|\bdeductions?\s+summary\b/i

/** One guard verdict per line, in order. */
export function flagSummaryLines(
  lines: ReadonlyArray<SettlementLineLike>,
  ctx: { settlementNumber?: string | null },
): LineGuard[] {
  const ref = digits(ctx.settlementNumber)
  return lines.map((line, i) => {
    const others = lines.filter((_, j) => j !== i)
    const reasons: string[] = []
    // (4) the label says total.
    if (TOTAL_LABEL.test(String(line.ticket_number ?? ''))) reasons.push('it is labelled as a total')
    // (2) the stub line carrying the settlement's own reference number.
    const tk = digits(line.ticket_number)
    if (ref && tk && tk === ref) reasons.push('its ticket number is the settlement reference number')
    if (others.length >= 2) {
      const bu = n(line.net_bushels)
      const dollars = netDollars(line)
      const gross = n(line.gross_revenue)
      // (1) bushels or dollars restate the sum of everything else — measured
      // against the lines SMALLER than this one, so a statement that prints
      // several total rows (Total From / Contract Total / Settlement Total /
      // the check stub) flags every one of them, not none.
      const smaller = others.filter((o) => n(o.net_bushels) < bu * 0.99 || (bu === 0 && netDollars(o) < dollars * 0.99))
      const sumBu = smaller.reduce((s, o) => s + n(o.net_bushels), 0)
      const sumDollars = smaller.reduce((s, o) => s + netDollars(o), 0)
      const sumGross = smaller.reduce((s, o) => s + n(o.gross_revenue), 0)
      const otherBu = others.reduce((s, o) => s + n(o.net_bushels), 0)
      const otherDollars = others.reduce((s, o) => s + netDollars(o), 0)
      const otherGross = others.reduce((s, o) => s + n(o.gross_revenue), 0)
      if (bu > 0 && (within(bu, otherBu, 0.01) || (smaller.length >= 2 && within(bu, sumBu, 0.01)))) reasons.push('its bushels equal the other lines added together')
      else if ((dollars > 0 && (within(dollars, otherDollars, 0.01) || (smaller.length >= 2 && within(dollars, sumDollars, 0.01))))
        || (gross > 0 && (within(gross, otherGross, 0.01) || (smaller.length >= 2 && within(gross, sumGross, 0.01))))) reasons.push('its dollars equal the other lines added together')
      // (3) a quantity that dwarfs every real load.
      const largestOther = Math.max(...others.map((o) => n(o.net_bushels)))
      if (bu > 0 && largestOther > 0 && bu > largestOther * 3) reasons.push('its bushels are more than three times the largest load')
    }
    return reasons.length > 0 ? { flagged: true, reason: `${SUMMARY_LINE_REASON} (${reasons.join('; ')})` } : { flagged: false, reason: null }
  })
}

export type LineReconciliation = {
  /** Sum of the INCLUDED lines' net dollars. */
  linesTotal: number
  /** The statement's own grand total, when captured. */
  reportedTotal: number | null
  delta: number | null
  /** Off by more than 0.5% (min $0.50). Null when no total was captured. */
  mismatch: boolean | null
}

/** Ticket-line sum vs the statement's captured grand total. */
export function reconcileLines(
  lines: ReadonlyArray<SettlementLineLike & { excluded?: boolean }>,
  reportedTotal: number | string | null | undefined,
): LineReconciliation {
  const linesTotal = lines.filter((l) => !l.excluded).reduce((s, l) => s + netDollars(l), 0)
  const reported = reportedTotal == null || reportedTotal === '' ? null : Number(reportedTotal)
  if (reported == null || !Number.isFinite(reported)) return { linesTotal, reportedTotal: null, delta: null, mismatch: null }
  const delta = linesTotal - reported
  const tolerance = Math.max(0.5, Math.abs(reported) * 0.005)
  return { linesTotal, reportedTotal: reported, delta, mismatch: Math.abs(delta) > tolerance }
}

// ---------------------------------------------------------------------------
// COMPLETENESS GUARD (2026-10-13). A long statement is read in chunks and a
// chunk can come back cut off; the review must never let 13 of 94 tickets
// save as a whole settlement without saying so. The statement's own
// printed facts — "No. Tickets: 94", total bushels, gross and net — are
// compared with what the lines add up to, and any page range the parser
// gave up on is named. The page shows the verdict as a red banner with a
// "Read those pages again" button and turns Save into a confirmation.
// ---------------------------------------------------------------------------

export type CompletenessInput = {
  capturedTickets: number
  reportedTickets: number | null | undefined
  capturedBushels: number
  reportedBushels: number | null | undefined
  capturedGross: number
  reportedGross: number | null | undefined
  capturedNet: number
  reportedNet: number | null | undefined
  failedRanges: ReadonlyArray<{ from: number; to: number }>
}

export type Completeness = {
  ok: boolean
  /** Printed count minus captured (negative = more lines than printed); null when no count printed. */
  missingTickets: number | null
  /** Captured minus printed; null when the statement prints no figure. */
  bushelsDelta: number | null
  grossDelta: number | null
  netDelta: number | null
  /** The plain sentences for the banner; null when everything agrees. */
  text: string | null
}

const reportedNum = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
// Tighter than reconcileLines' advisory 0.5%: a missing ticket on a long
// statement is well under 1% of the money. Per-line rounding noise (±0.005
// a line) stays inside the $1 / 1 bu floor.
const dollarsOff = (delta: number, reported: number) => Math.abs(delta) > Math.max(1, Math.abs(reported) * 0.0005)
const bushelsOff = (delta: number, reported: number) => Math.abs(delta) > Math.max(1, Math.abs(reported) * 0.0005)

/** "Pages 1 to 6 and 8" / "Page 8". */
export function describeRanges(ranges: ReadonlyArray<{ from: number; to: number }>): string {
  if (ranges.length === 0) return ''
  const parts = ranges.map((r) => (r.from === r.to ? String(r.from) : `${r.from} to ${r.to}`))
  const single = ranges.length === 1 && ranges[0].from === ranges[0].to
  const list = parts.length <= 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${single ? 'Page' : 'Pages'} ${list}`
}

export function settlementCompleteness(input: CompletenessInput): Completeness {
  const reportedTickets = reportedNum(input.reportedTickets)
  const reportedBushels = reportedNum(input.reportedBushels)
  const reportedGross = reportedNum(input.reportedGross)
  const reportedNet = reportedNum(input.reportedNet)
  const missingTickets = reportedTickets != null ? Math.round(reportedTickets) - input.capturedTickets : null
  const bushelsDelta = reportedBushels != null ? input.capturedBushels - reportedBushels : null
  const grossDelta = reportedGross != null ? input.capturedGross - reportedGross : null
  const netDelta = reportedNet != null ? input.capturedNet - reportedNet : null
  const sentences: string[] = []
  if (missingTickets != null && missingTickets !== 0) sentences.push(`Captured ${fmtInt(input.capturedTickets)} of ${fmtInt(reportedTickets)} tickets.`)
  if (input.failedRanges.length > 0) sentences.push(`${describeRanges(input.failedRanges)} returned no tickets.`)
  if (bushelsDelta != null && reportedBushels != null && bushelsOff(bushelsDelta, reportedBushels)) {
    sentences.push(`The lines add up to ${fmtInt(input.capturedBushels)} bu; the statement prints ${fmtInt(reportedBushels)} bu.`)
  }
  if (grossDelta != null && reportedGross != null && dollarsOff(grossDelta, reportedGross)) {
    sentences.push(`Gross on the lines is ${fmtUsd(input.capturedGross, 2)}; the statement prints ${fmtUsd(reportedGross, 2)}.`)
  }
  if (netDelta != null && reportedNet != null && dollarsOff(netDelta, reportedNet)) {
    sentences.push(`Net on the lines is ${fmtUsd(input.capturedNet, 2)}; the statement prints ${fmtUsd(reportedNet, 2)}.`)
  }
  return {
    ok: sentences.length === 0,
    missingTickets,
    bushelsDelta,
    grossDelta,
    netDelta,
    text: sentences.length > 0 ? sentences.join(' ') : null,
  }
}
