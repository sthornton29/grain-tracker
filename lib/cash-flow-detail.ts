// Cash Flow drill-down: every dollar on the report is the sum of small,
// nameable pieces (a settlement, a contract's undelivered bushels, one
// policy's projected indemnity, one USDA payment). The report collects those
// pieces as CashDetail rows while it buckets the totals, and any number on
// screen opens the rows behind it. This module is the pure part: the row
// shape, the kind labels, and the selection / totaling a cell needs.

export type CashKind = 'received' | 'outstanding' | 'projected' | 'arcPlc' | 'insurance' | 'other' | 'cotton' | 'seed'

export const CASH_KIND_LABEL: Record<CashKind, string> = {
  received: 'Received',
  outstanding: 'Outstanding',
  projected: 'Projected',
  arcPlc: 'ARC/PLC',
  insurance: 'Crop insurance',
  other: 'Other USDA',
  cotton: 'Cotton (net)',
  seed: 'Seed contracts (net)',
}

/** One sentence per kind: what the rows are, in the farmer's words. */
export const CASH_KIND_EXPLAINER: Record<CashKind, string> = {
  received: 'Money already collected — each settlement, in the month it was dated.',
  outstanding: 'Grain delivered but not yet on a settlement, valued at the contract price. Shown in the current month as money still owed to you.',
  projected: 'Contracted bushels not yet delivered, valued at the contract price and spread across the remaining delivery window.',
  arcPlc: 'Projected ARC/PLC by farm and commodity, landing in October of the following crop year.',
  insurance: 'Projected crop insurance indemnity by policy, in the month you chose for proceeds.',
  other: 'Other USDA payments on their entered date (or December of the crop year).',
  cotton: 'Cotton cash lines — loans, sales, LDP, and fees — in their month.',
  seed: 'Seed contract cash — base payments, premiums, storage, and the usage fee — in their month.',
}

export type CashDetail = {
  kind: CashKind
  /** YYYY-MM bucket the amount lands in. */
  month: string
  /** What it is: "Settlement #4471 · Bunge", "Contract #C-12 · ADM". */
  label: string
  /** How it was figured: "1,204 bu × $4.35", "12 loads". */
  sub?: string
  amount: number
  /** Where to go for the record itself. */
  href?: string
  status?: 'received' | 'outstanding' | 'projected'
}

/** A selection on the report: one kind (or every kind) for one month (or
 *  every month). */
export type CashSelection = { kind: CashKind | 'all'; month: string | null }

export function selectCashDetails(rows: readonly CashDetail[], sel: CashSelection): CashDetail[] {
  return rows
    .filter((r) => (sel.kind === 'all' || r.kind === sel.kind) && (sel.month == null || r.month === sel.month))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => {
      if (sel.month == null && a.month !== b.month) return a.month.localeCompare(b.month)
      if (sel.kind === 'all' && a.kind !== b.kind) return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      return Math.abs(b.amount) - Math.abs(a.amount)
    })
}

const KIND_ORDER: CashKind[] = ['received', 'outstanding', 'projected', 'arcPlc', 'insurance', 'other', 'cotton', 'seed']

export function sumCashDetails(rows: readonly CashDetail[]): number {
  return rows.reduce((s, r) => s + r.amount, 0)
}

/** The month keys a projection spreads across: from the later of this month
 *  and the window start, through the window end. Empty when there is no end,
 *  or the end has passed — the caller then books it all in the current month. */
export function projectionMonths(args: { todayKey: string; start: string | null; end: string | null }): string[] {
  const startKey = args.start ? args.start.slice(0, 7) : args.todayKey
  let cursor = startKey > args.todayKey ? startKey : args.todayKey
  if (!args.end) return []
  const endKey = args.end.slice(0, 7)
  if (endKey < cursor) return []
  const out: string[] = []
  for (let i = 0; i < 240 && cursor <= endKey; i++) {
    out.push(cursor)
    const [y, m] = cursor.split('-').map(Number)
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  }
  return out
}
