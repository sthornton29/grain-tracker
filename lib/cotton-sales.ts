// Physical cotton marketing engine — sales contracts (spot / fixed / on-call /
// pool), CCC marketing-assistance loans, LDP, equity sales, fees, and the
// bale-disposition board. Pure functions over pre-fetched rows; every ¢ figure
// is CENTS PER POUND (55.00 = 55¢/lb), every dollar figure is dollars.
//
// Program-dollar policy (documented in the report methodology panels): LDP
// payments and marketing loan gains are SALE-LINKED program dollars — they are
// counted ONCE, inside the cotton marketing row's revenue, and are NOT part of
// the government-payments pool, so the Revenue-Projections − Marketing =
// insurance + government identity keeps holding.

import type {
  AwpWeekly, CccLoan, CottonBale, CottonBaleDisposition, CottonBaleGrade,
  CottonDisposition, CottonFee, CottonFeeSchedule, CottonLdpRecord,
  CottonPoolPayment, CottonSalesContract,
} from '@/lib/types'

const r2 = (n: number) => Math.round(n * 100) / 100

/** Standard bale weight used only when a commitment has no actual bales yet. */
export const STANDARD_BALE_LBS = 480

// ---------- CCC loan math ----------

/** One bale's loan principal ($): its classing loan value (¢/lb) × net lbs.
 *  509 lbs at 55.1¢ → $280.46. Bales not yet classed use the base rate. */
export function baleLoanPrincipal(
  netWeightLbs: number,
  loanValueCentsPerLb: number | null | undefined,
  baseRateCents: number,
): { principal: number; pendingClassing: boolean } {
  const cents = loanValueCentsPerLb ?? baseRateCents
  return { principal: r2((cents * netWeightLbs) / 100), pendingClassing: loanValueCentsPerLb == null }
}

/** A loan group's principal: Σ per-bale values; pending_classing while any bale
 *  lacks a classing loan value (recompute when grades import). */
export function computeLoanPrincipal(
  bales: Array<{ net_weight_lbs: number; loan_value_cents_per_lb: number | null }>,
  baseRateCents: number,
): { principalTotal: number; lbs: number; pendingClassing: boolean } {
  let principalTotal = 0
  let lbs = 0
  let pendingClassing = false
  for (const b of bales) {
    const p = baleLoanPrincipal(Number(b.net_weight_lbs), b.loan_value_cents_per_lb, baseRateCents)
    principalTotal += p.principal
    lbs += Number(b.net_weight_lbs)
    pendingClassing = pendingClassing || p.pendingClassing
  }
  return { principalTotal: r2(principalTotal), lbs, pendingClassing }
}

/** LDP rate and MLG-per-lb are the same number: loan rate − AWP, zero-floored
 *  (no payment when the AWP is at/above the loan rate). ¢/lb. */
export function ldpRateCents(loanRateCents: number, awpCents: number): number {
  return r2(Math.max(0, loanRateCents - awpCents))
}

/** Redeeming a loan when AWP < loan rate: repay at the AWP (interest waived) —
 *  the difference is the marketing loan gain. Loan 55.00 / AWP 51.40 → 3.60¢
 *  MLG per lb; payoff = principal − MLG total. */
export function redemptionOutcome(args: {
  principalTotal: number
  lbs: number
  loanRateBaseCents: number
  awpCents: number
}): { mlgRateCents: number; mlgTotal: number; payoffTotal: number } {
  const mlgRateCents = ldpRateCents(args.loanRateBaseCents, args.awpCents)
  const mlgTotal = r2((mlgRateCents * args.lbs) / 100)
  return { mlgRateCents, mlgTotal, payoffTotal: r2(Math.max(0, args.principalTotal - mlgTotal)) }
}

/** Selling loan equity: the merchant pays equity ¢/lb over the banked loan
 *  value and takes the bales. Effective sale price = banked loan + equity. */
export function equityOutcome(args: {
  principalTotal: number
  lbs: number
  equityCentsPerLb: number
}): { equityTotal: number; effectiveCentsPerLb: number } {
  const equityTotal = r2((args.equityCentsPerLb * args.lbs) / 100)
  return {
    equityTotal,
    effectiveCentsPerLb: args.lbs > 0 ? r2(((args.principalTotal + equityTotal) * 100) / args.lbs) : 0,
  }
}

/** The AWP row effective on a date (announced Thursdays, effective Fri–Thu):
 *  the most recent week_effective ≤ the date. */
export function awpOn(rows: AwpWeekly[], dateIso: string): AwpWeekly | null {
  let best: AwpWeekly | null = null
  for (const r of rows) {
    if (r.week_effective <= dateIso && (!best || r.week_effective > best.week_effective)) best = r
  }
  return best
}

// ---------- Contract pricing ----------

/** A contract's locked cash price (¢/lb), null while unpriced. On-call cash =
 *  basis + FIXED futures — an on-call still awaiting futures is null and must
 *  stay out of the priced buckets. Pools have no locked price. */
export function contractPricedCents(c: CottonSalesContract): number | null {
  if (c.contract_type === 'spot' || c.contract_type === 'fixed_price') {
    return c.price_cents_per_lb != null ? Number(c.price_cents_per_lb) : null
  }
  if (c.contract_type === 'on_call') {
    if (c.basis_cents != null && c.futures_fixed_cents != null) {
      return r2(Number(c.basis_cents) + Number(c.futures_fixed_cents))
    }
    return null
  }
  return null // pool
}

// ---------- Disposition board ----------

export type DispositionBoard = {
  byDisposition: Record<CottonDisposition, { bales: number; lbs: number }>
  totalBales: number
  totalLbs: number
}

/** "Where is my cotton": counts + lbs per disposition. A bale without a
 *  disposition row counts as held, so held + loan + sold + pool + delivered
 *  always conserves the bale total. */
export function dispositionBoard(
  bales: Array<{ id: string; net_weight_lbs: number }>,
  dispositions: Array<{ bale_id: string; disposition: CottonDisposition }>,
): DispositionBoard {
  const dispByBale = new Map(dispositions.map((d) => [d.bale_id, d.disposition]))
  const byDisposition: DispositionBoard['byDisposition'] = {
    sold_spot: { bales: 0, lbs: 0 },
    contract_delivery: { bales: 0, lbs: 0 },
    pool: { bales: 0, lbs: 0 },
    ccc_loan: { bales: 0, lbs: 0 },
    held: { bales: 0, lbs: 0 },
  }
  let totalBales = 0
  let totalLbs = 0
  for (const b of bales) {
    const d = dispByBale.get(b.id) ?? 'held'
    byDisposition[d].bales += 1
    byDisposition[d].lbs += Number(b.net_weight_lbs)
    totalBales += 1
    totalLbs += Number(b.net_weight_lbs)
  }
  return { byDisposition, totalBales, totalLbs }
}

// ---------- Fees ----------

/** Whole storage months from entry to as-of (30.44-day months, rounded up,
 *  min 1 — a bale group in the warehouse accrues its first month at entry). */
export function storageMonths(entryDateIso: string, asOfIso: string): number {
  const ms = new Date(asOfIso).getTime() - new Date(entryDateIso).getTime()
  const days = Math.max(0, ms / 86_400_000)
  return Math.max(1, Math.ceil(days / 30.44))
}

/** Projected carrying fees for a loan's bale group: storage months × rate ×
 *  bales, plus simple interest on principal (waived at redemption when an MLG
 *  applies — the projection is the accrual while open). */
export function projectLoanFees(args: {
  bales: number
  principalTotal: number
  entryDate: string
  asOf: string
  schedule: CottonFeeSchedule
}): { months: number; storage: number; interest: number; total: number } {
  const months = storageMonths(args.entryDate, args.asOf)
  const storage = r2(months * Number(args.schedule.storage_per_bale_month) * args.bales)
  const days = Math.max(0, (new Date(args.asOf).getTime() - new Date(args.entryDate).getTime()) / 86_400_000)
  const interest = r2(args.principalTotal * Number(args.schedule.loan_interest_apr) * (days / 365))
  return { months, storage, interest, total: r2(storage + interest) }
}

/** Checkoff on a sale: $/bale + supplemental % of gross value. */
export function projectSaleCheckoff(args: {
  bales: number
  valueDollars: number
  schedule: CottonFeeSchedule
}): number {
  return r2(args.bales * Number(args.schedule.checkoff_per_bale) + args.valueDollars * Number(args.schedule.checkoff_supplemental_pct))
}

/** One-time per-bale handling for the year's bales (warehouse receiving +
 *  classing). */
export function projectBaleHandlingFees(bales: number, schedule: CottonFeeSchedule): number {
  return r2(bales * (Number(schedule.receiving_per_bale) + Number(schedule.classing_per_bale)))
}

/** Net fee dollars for the marketing row: ACTUAL rows win per (type, applied-to)
 *  slot; projected rows count only where no actual covers the same slot. */
export function netFees(fees: CottonFee[]): number {
  const slot = (f: CottonFee) => `${f.fee_type}|${f.loan_id ?? ''}|${f.contract_id ?? ''}`
  const actualSlots = new Set(fees.filter((f) => f.status === 'actual').map(slot))
  let total = 0
  for (const f of fees) {
    if (f.status === 'actual' || !actualSlots.has(slot(f))) total += Number(f.amount_total)
  }
  return r2(total)
}

// ---------- The physical summary (feeds computeCottonRow) ----------

export type CottonSoldSource = { label: string; lbs: number; cents: number }

export type CottonPhysicalSummary = {
  /** Priced physical sales: fixed/spot + on-call-with-futures-fixed contract
   *  lbs at their cash prices, plus equity-sold loan lbs at banked+equity. */
  soldLbs: number
  soldDollars: number
  soldSources: CottonSoldSource[]
  /** On-call lbs still awaiting their futures leg — unpriced, tracked so the
   *  UI can say why they're excluded. */
  awaitingCallLbs: number
  /** Pool commitments: dollars received so far + the estimate for the rest. */
  poolLbs: number
  poolReceivedDollars: number
  poolEstCents: number | null
  /** Open CCC loans: the banked principal is the revenue floor. */
  inLoanLbs: number
  loanBankedDollars: number
  loanFloorCents: number | null
  /** Bales on hand with no fate yet (disposition 'held' or no row). */
  heldLbs: number
  /** Sale-linked program dollars counted ONCE here (never in the gov pool):
   *  LDP payments + realized marketing loan gains from redeemed loans. */
  programDollars: number
  programLabel: string
  /** Net fees (actuals win over projections) — subtracts from revenue. */
  feeDollars: number
  board: DispositionBoard
}

export type CottonPhysicalInputs = {
  cropYear: number
  bales: CottonBale[]
  gradesByBale: Map<string, CottonBaleGrade>
  dispositions: CottonBaleDisposition[]
  contracts: CottonSalesContract[]
  poolPayments: CottonPoolPayment[]
  loans: CccLoan[]
  loanBales: Array<{ loan_id: string; bale_id: string }>
  ldps: CottonLdpRecord[]
  fees: CottonFee[]
}

export function buildCottonPhysicalSummary(inputs: CottonPhysicalInputs): CottonPhysicalSummary {
  const { bales, dispositions, contracts, poolPayments, loans, loanBales, ldps, fees } = inputs
  const baleById = new Map(bales.map((b) => [b.id, b]))
  const board = dispositionBoard(bales, dispositions)
  const avgBaleLbs = board.totalBales > 0 ? board.totalLbs / board.totalBales : STANDARD_BALE_LBS

  // Lbs assigned to each contract via dispositions.
  const lbsByContract = new Map<string, number>()
  for (const d of dispositions) {
    if (!d.contract_id) continue
    const b = baleById.get(d.bale_id)
    if (!b) continue
    lbsByContract.set(d.contract_id, (lbsByContract.get(d.contract_id) ?? 0) + Number(b.net_weight_lbs))
  }
  const contractLbs = (c: CottonSalesContract): number => {
    const assigned = lbsByContract.get(c.id) ?? 0
    if (assigned > 0) return assigned
    // Commitment not yet delivered: bales-basis commitments estimate at the
    // year's average bale weight. Acres-basis commitments carry no lbs until
    // bales are assigned (their lbs would need a yield assumption).
    if (c.commitment_basis === 'bales' && c.committed_bales != null) return Number(c.committed_bales) * avgBaleLbs
    return 0
  }

  // Sold bucket: priced contracts + equity-sold loans.
  let soldLbs = 0
  let soldDollars = 0
  let awaitingCallLbs = 0
  const soldSources: CottonSoldSource[] = []
  for (const c of contracts) {
    if (c.contract_type === 'pool') continue
    const lbs = contractLbs(c)
    if (lbs <= 0) continue
    const cents = contractPricedCents(c)
    if (cents == null) {
      if (c.contract_type === 'on_call') awaitingCallLbs += lbs
      continue
    }
    soldLbs += lbs
    soldDollars += (cents * lbs) / 100
    const label = c.contract_type === 'on_call'
      ? `On-call ${c.contract_number ?? ''} (basis ${c.basis_cents}¢ + ${c.futures_fixed_cents}¢)`.trim()
      : `${c.contract_type === 'spot' ? 'Spot' : 'Fixed'} ${c.contract_number ?? ''}`.trim()
    soldSources.push({ label, lbs, cents })
  }

  const lbsByLoan = new Map<string, number>()
  for (const lb of loanBales) {
    const b = baleById.get(lb.bale_id)
    if (!b) continue
    lbsByLoan.set(lb.loan_id, (lbsByLoan.get(lb.loan_id) ?? 0) + Number(b.net_weight_lbs))
  }

  let inLoanLbs = 0
  let loanBankedDollars = 0
  let mlgDollars = 0
  for (const loan of loans) {
    const lbs = lbsByLoan.get(loan.id) ?? 0
    if (loan.status === 'open') {
      inLoanLbs += lbs
      loanBankedDollars += Number(loan.principal_total)
    } else if (loan.status === 'equity_sold') {
      const equityTotal = Number(loan.equity_total ?? 0)
      const dollars = Number(loan.principal_total) + equityTotal
      soldLbs += lbs
      soldDollars += dollars
      if (lbs > 0) {
        soldSources.push({
          label: `Loan equity ${loan.loan_number ?? ''}`.trim(),
          lbs,
          cents: r2((dollars * 100) / lbs),
        })
      }
    } else if (loan.status === 'redeemed') {
      // Bales return to held (the app updates dispositions); the realized MLG
      // is a program gain counted once here.
      mlgDollars += Number(loan.mlg_total ?? 0)
    }
    // forfeited: producer keeps the principal, cotton is gone — principal
    // stays as the sale proceeds.
    if (loan.status === 'forfeited') {
      soldLbs += lbs
      soldDollars += Number(loan.principal_total)
      if (lbs > 0) soldSources.push({ label: `Forfeited ${loan.loan_number ?? ''}`.trim(), lbs, cents: r2((Number(loan.principal_total) * 100) / lbs) })
    }
  }

  // Pool: lbs from dispositions (or committed), dollars received so far, and
  // the latest per-lb estimate any payment carried.
  let poolLbs = 0
  let poolReceivedDollars = 0
  let poolEstCents: number | null = null
  const poolContracts = contracts.filter((c) => c.contract_type === 'pool')
  for (const c of poolContracts) poolLbs += contractLbs(c)
  const poolIds = new Set(poolContracts.map((c) => c.id))
  let latestDate = ''
  for (const p of poolPayments) {
    if (!poolIds.has(p.contract_id)) continue
    if (p.status === 'received') poolReceivedDollars += Number(p.amount)
    if (p.cents_per_lb_equivalent != null && (p.payment_date ?? '') >= latestDate) {
      latestDate = p.payment_date ?? ''
      poolEstCents = Number(p.cents_per_lb_equivalent)
    }
  }

  const ldpDollars = ldps.reduce((s, l) => s + Number(l.total_payment), 0)
  const heldLbs = board.byDisposition.held.lbs

  const programDollars = r2(ldpDollars + mlgDollars)
  const programLabel = [
    ldpDollars > 0 ? `LDP $${r2(ldpDollars).toLocaleString()}` : null,
    mlgDollars > 0 ? `MLG $${r2(mlgDollars).toLocaleString()}` : null,
  ].filter(Boolean).join(' + ')

  return {
    soldLbs: r2(soldLbs),
    soldDollars: r2(soldDollars),
    soldSources,
    awaitingCallLbs: r2(awaitingCallLbs),
    poolLbs: r2(poolLbs),
    poolReceivedDollars: r2(poolReceivedDollars),
    poolEstCents,
    inLoanLbs: r2(inLoanLbs),
    loanBankedDollars: r2(loanBankedDollars),
    loanFloorCents: inLoanLbs > 0 ? r2((loanBankedDollars * 100) / inLoanLbs) : null,
    heldLbs: r2(heldLbs),
    programDollars,
    programLabel: programLabel || 'LDP/MLG',
    feeDollars: netFees(fees),
    board,
  }
}

// ---------- Cash-flow events ----------

export type CottonCashEvent = {
  date: string // YYYY-MM-DD
  label: string
  amount: number // + inflow, − outflow
  status: 'received' | 'projected'
}

/** Dated cotton cash events for the Cash Flow report. Loan principal lands at
 *  entry (the big fall inflow); redemption payoff is an OUTFLOW at outcome;
 *  equity lands at outcome; pool payments on their dates; priced contract
 *  proceeds at the delivery window's end (projected); LDP at ldp_date; fees
 *  as outflows on their dates. */
export function cottonCashFlowEvents(inputs: CottonPhysicalInputs): CottonCashEvent[] {
  const { contracts, poolPayments, loans, ldps, fees, bales, dispositions } = inputs
  const events: CottonCashEvent[] = []
  const summary = buildCottonPhysicalSummary(inputs) // for contract lbs reuse
  void summary
  const baleById = new Map(bales.map((b) => [b.id, b]))
  const lbsByContract = new Map<string, number>()
  for (const d of dispositions) {
    if (!d.contract_id) continue
    const b = baleById.get(d.bale_id)
    if (b) lbsByContract.set(d.contract_id, (lbsByContract.get(d.contract_id) ?? 0) + Number(b.net_weight_lbs))
  }
  const totalLbs = bales.reduce((s, b) => s + Number(b.net_weight_lbs), 0)
  const avgBaleLbs = bales.length > 0 ? totalLbs / bales.length : STANDARD_BALE_LBS

  for (const loan of loans) {
    events.push({
      date: loan.entry_date,
      label: `CCC loan proceeds ${loan.loan_number ?? ''}`.trim(),
      amount: Number(loan.principal_total),
      status: 'received',
    })
    if (loan.status === 'redeemed' && loan.outcome_date) {
      events.push({
        date: loan.outcome_date,
        label: `Loan redemption payoff ${loan.loan_number ?? ''}`.trim(),
        amount: -Number(loan.redemption_payoff_total ?? 0),
        status: 'received',
      })
    }
    if (loan.status === 'equity_sold' && loan.outcome_date) {
      events.push({
        date: loan.outcome_date,
        label: `Loan equity sale ${loan.loan_number ?? ''}`.trim(),
        amount: Number(loan.equity_total ?? 0),
        status: 'received',
      })
    }
  }

  for (const p of poolPayments) {
    if (!p.payment_date) continue
    events.push({
      date: p.payment_date,
      label: `Pool ${p.payment_type.replace('_', ' ')}`,
      amount: Number(p.amount),
      status: p.status,
    })
  }

  for (const c of contracts) {
    if (c.contract_type === 'pool') continue
    const cents = contractPricedCents(c)
    if (cents == null) continue
    const lbs = lbsByContract.get(c.id) ?? (c.commitment_basis === 'bales' && c.committed_bales != null ? Number(c.committed_bales) * avgBaleLbs : 0)
    if (lbs <= 0) continue
    const date = c.delivery_end ?? c.delivery_start ?? c.contract_date
    if (!date) continue
    events.push({
      date,
      label: `Cotton contract ${c.contract_number ?? ''} delivery`.trim(),
      amount: r2((cents * lbs) / 100),
      status: 'projected',
    })
  }

  for (const l of ldps) {
    events.push({ date: l.ldp_date, label: 'LDP payment', amount: Number(l.total_payment), status: l.status })
  }

  for (const f of fees) {
    if (!f.fee_date) continue
    events.push({
      date: f.fee_date,
      label: `Cotton fee — ${f.fee_type.replace(/_/g, ' ')}`,
      amount: -Number(f.amount_total),
      status: f.status === 'actual' ? 'received' : 'projected',
    })
  }

  return events.sort((a, b) => a.date.localeCompare(b.date))
}
