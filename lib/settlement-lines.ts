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

/** One guard verdict per line, in order. */
export function flagSummaryLines(
  lines: ReadonlyArray<SettlementLineLike>,
  ctx: { settlementNumber?: string | null },
): LineGuard[] {
  const ref = digits(ctx.settlementNumber)
  return lines.map((line, i) => {
    const others = lines.filter((_, j) => j !== i)
    const reasons: string[] = []
    // (2) the stub line carrying the settlement's own reference number.
    const tk = digits(line.ticket_number)
    if (ref && tk && tk === ref) reasons.push('its ticket number is the settlement reference number')
    if (others.length >= 2) {
      const otherBu = others.reduce((s, o) => s + n(o.net_bushels), 0)
      const otherDollars = others.reduce((s, o) => s + netDollars(o), 0)
      const otherGross = others.reduce((s, o) => s + n(o.gross_revenue), 0)
      const bu = n(line.net_bushels)
      const dollars = netDollars(line)
      const gross = n(line.gross_revenue)
      // (1) bushels or dollars restate the sum of everything else.
      if (bu > 0 && within(bu, otherBu, 0.01)) reasons.push('its bushels equal the other lines added together')
      else if ((dollars > 0 && within(dollars, otherDollars, 0.01)) || (gross > 0 && within(gross, otherGross, 0.01))) reasons.push('its dollars equal the other lines added together')
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
