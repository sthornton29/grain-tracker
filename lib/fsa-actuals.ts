// Received vs projected government payments (0099) — the ONE seam that lays
// the ACTUAL ARC/PLC payments read off FSA Payment Statements over the
// engine's projections.
//
// Actuals live in fsa_payment_lines + fsa_payment_crop_amounts (a PLC /
// ARC-CO line's crop amounts are the payment per farm × commodity × program
// year). Nothing is written to arc_plc_payments: every consumer that used to
// read the projection alone — the Tracker, Cash Flow, Revenue Projections,
// Income Sensitivity, Ask Turnrow — merges here, so a paid farm × commodity
// counts ONCE (the actual replaces the projection; an unpaid one keeps its
// projection) and the same rows explain the variance:
//
//   PLC    implied payment rate   = actual ÷ ((1 − sequester) × 0.85 × base acres × PLC yield)
//   ARC-CO implied rate per acre  = actual ÷ ((1 − sequester) × 0.85 × base acres)
//
// against the projected rate, attributed to PROGRAM (the other program paid),
// SEQUESTER (the statement's percent differs from the parameter the
// projection used and that alone closes the gap), ACRES / YIELD (the implied
// rate is outside what the program can pay on our base data, so FSA's base
// acres or yield differ) or RATE (the price / county revenue came in
// different — the rest). Pure; tested in lib/fsa-actuals.test.ts.

import type { ArcPlcElectionType, FsaProgramCode } from '@/lib/types'
import type { ProjectedPayment } from '@/lib/government-payments'
import { PAYMENT_FACTOR } from '@/lib/government-payments'

export type ReceivedLineLike = {
  id: string
  statement_id: string
  fsa_payment_id: string
  program_code: FsaProgramCode
  program_year: number | null
  farm_id: string | null
  payment_date: string | null
  sequester_pct: number | null
}
export type ReceivedCropLike = { line_id: string; commodity_id: string | null; amount: number | string }

export type ReceivedPayment = {
  farmId: string
  commodityId: string
  programYear: number
  amount: number
  /** The program(s) the lines paid under — normally one. */
  programs: Array<'PLC' | 'ARC_CO' | 'ARC_IC'>
  /** Payment (ACH) dates, earliest first. */
  paymentDates: string[]
  /** The sequester % printed on the line(s) (fraction, 0.057), null when none printed. */
  sequesterPct: number | null
  lines: Array<{ lineId: string; statementId: string; fsaPaymentId: string; program: 'PLC' | 'ARC_CO' | 'ARC_IC'; amount: number; paymentDate: string | null }>
}

const key = (farmId: string, commodityId: string, programYear: number) => `${farmId}|${commodityId}|${programYear}`

/**
 * The ARC/PLC actuals: PLC / ARC-CO / ARC-IC crop amounts summed per farm ×
 * commodity × program year. Lines with no farm, no program year, or an OTHER
 * program, and crop rows with no commodity, are left out (they are not
 * ARC/PLC actuals — OTHER lines land in other_government_payments).
 */
export function receivedArcPlc(args: {
  lines: ReadonlyArray<ReceivedLineLike>
  cropAmounts: ReadonlyArray<ReceivedCropLike>
}): Map<string, ReceivedPayment> {
  const lineById = new Map(args.lines.map((l) => [l.id, l]))
  const out = new Map<string, ReceivedPayment>()
  for (const c of args.cropAmounts) {
    const l = lineById.get(c.line_id)
    if (!l || !l.farm_id || l.program_year == null || !c.commodity_id) continue
    if (l.program_code === 'OTHER') continue
    const k = key(l.farm_id, c.commodity_id, l.program_year)
    let r = out.get(k)
    if (!r) {
      r = { farmId: l.farm_id, commodityId: c.commodity_id, programYear: l.program_year, amount: 0, programs: [], paymentDates: [], sequesterPct: null, lines: [] }
      out.set(k, r)
    }
    const amount = Number(c.amount) || 0
    r.amount = round2(r.amount + amount)
    if (!r.programs.includes(l.program_code)) r.programs.push(l.program_code)
    if (l.payment_date && !r.paymentDates.includes(l.payment_date)) r.paymentDates.push(l.payment_date)
    if (l.sequester_pct != null && r.sequesterPct == null) r.sequesterPct = Number(l.sequester_pct)
    r.lines.push({ lineId: l.id, statementId: l.statement_id, fsaPaymentId: l.fsa_payment_id, program: l.program_code, amount, paymentDate: l.payment_date })
  }
  for (const r of out.values()) r.paymentDates.sort()
  return out
}

export type ReceivedStatus = 'paid' | 'not_yet_paid' | 'paid_no_projection' | 'projected_not_on_statement'

export const RECEIVED_STATUS_LABEL: Record<ReceivedStatus, string> = {
  paid: 'Paid',
  not_yet_paid: 'Not yet paid',
  paid_no_projection: 'Paid with no projection',
  projected_not_on_statement: 'Projected but not on any statement yet',
}

export type VarianceCause = 'RATE' | 'ACRES_YIELD' | 'SEQUESTER' | 'PROGRAM'

export const VARIANCE_CAUSE_LABEL: Record<VarianceCause, string> = {
  RATE: 'Rate (price / county revenue)',
  ACRES_YIELD: 'Acres / yield / share (base data)',
  SEQUESTER: 'Sequester',
  PROGRAM: 'Program (which program paid)',
}

export type ImpliedRate = {
  program: 'PLC' | 'ARC_CO' | 'ARC_IC'
  /** PLC: $/unit payment rate; ARC-CO / ARC-IC: $ per base acre. */
  implied: number
  /** The projection's rate on the same basis (null when the projection was under the other program). */
  projected: number | null
  /** The rate FSA paid the OTHER farms on the statements for the same
   *  commodity and program (dollar-weighted median; ARC per county, since
   *  county revenue sets the ARC rate). Null when this is the only such line. */
  statementRate: number | null
  /** The denominator the actual was divided by (on the producer's share of the base). */
  denominator: number
  sequesterPct: number
}

export type ReceivedVsProjected = {
  farmId: string
  commodityId: string
  programYear: number
  projected: number
  received: number | null
  /** received − projected (null until paid). */
  variance: number | null
  variancePct: number | null
  status: ReceivedStatus
  /** The program the projection pays under (null without a projection). */
  projectedProgram: ArcPlcElectionType | null
  /** The program the statement paid under (null until paid). */
  paidProgram: 'PLC' | 'ARC_CO' | 'ARC_IC' | null
  paymentDates: string[]
  implied: ImpliedRate | null
  cause: VarianceCause | null
  /** What goes into every revenue view: the actual once paid, else the projection. */
  effective: number
  /** The farm's base acres on file; the projection and the implied rate run on baseAcres × producerShare. */
  baseAcres: number
  plcYield: number
  producerShare: number
  /** Paid: the actual ÷ what the farm would pay at the statement rate. Below
   *  1 by more than rounding, FSA paid on fewer acres / a lower yield / a
   *  smaller share than the base data says; null without a statement rate. */
  shareOfFarmPaid: number | null
  projection: ProjectedPayment | null
  receivedDetail: ReceivedPayment | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 1e4) / 1e4

/** The implied rate behind an actual, on the paid program's basis. */
export function impliedRate(args: {
  program: 'PLC' | 'ARC_CO' | 'ARC_IC'
  actual: number
  baseAcres: number
  plcYield: number
  sequesterPct: number
  paymentFactor?: number
  projectedRate?: number | null
  statementRate?: number | null
}): ImpliedRate | null {
  const pf = args.paymentFactor ?? PAYMENT_FACTOR
  const base = (1 - args.sequesterPct) * (args.program === 'ARC_IC' ? 0.65 : pf) * args.baseAcres
  const denominator = args.program === 'PLC' ? base * args.plcYield : base
  if (!(denominator > 0)) return null
  return {
    program: args.program,
    implied: round4(args.actual / denominator),
    projected: args.projectedRate ?? null,
    statementRate: args.statementRate ?? null,
    denominator: round2(denominator),
    sequesterPct: args.sequesterPct,
  }
}

/**
 * Lay the actuals over the projections for one program year. `projected` is
 * projectPayments' output for that year; `received` is receivedArcPlc's map.
 * `statementsExist` says whether ANY statement line for the program year is
 * on file — it separates "not yet paid" (no statement yet) from "projected
 * but not on any statement" (statements came in and this one was not on
 * them).
 *
 * Two passes. The first works out, per commodity × program (× county for
 * ARC), the rate FSA actually paid — the dollar-weighted median of the
 * implied rates across the paid farms. The second lays each actual over its
 * projection and attributes the variance against that statement rate: a farm
 * paid the statement rate on fewer dollars than its base data says was paid
 * on fewer acres / a lower yield / a smaller share, not a different price.
 */
export function mergeProjectedWithReceived(args: {
  programYear: number
  projected: ReadonlyArray<ProjectedPayment>
  received: ReadonlyMap<string, ReceivedPayment>
  /** The sequester the projections were computed with (program_year_config). */
  sequesterPct: number
  paymentFactor?: number
  /** Optional: the max PLC rate per commodity (ERP − loan floor) and the
   *  ARC-CO cap per farm × commodity, for the ACRES / YIELD call when no
   *  statement rate exists. */
  maxPlcRateByCommodity?: ReadonlyMap<string, number>
  /** Farm → county key, so ARC rates are only compared within a county. */
  countyByFarm?: ReadonlyMap<string, string | null>
  statementsExist?: boolean
}): ReceivedVsProjected[] {
  const statementsExist = args.statementsExist ?? [...args.received.values()].some((r) => r.programYear === args.programYear)

  // Pass 1: the implied rate of every paid line, grouped for the statement rate.
  const impliedByKey = new Map<string, ImpliedRate | null>()
  const groups = new Map<string, Array<{ value: number; weight: number }>>()
  const groupKeyOf = (p: ProjectedPayment, program: 'PLC' | 'ARC_CO' | 'ARC_IC') => {
    if (program === 'PLC') return `${p.commodityId}|PLC`
    const county = args.countyByFarm?.get(p.farmId) ?? null
    return `${p.commodityId}|${program}|${county ?? `farm:${p.farmId}`}`
  }
  for (const p of args.projected) {
    const k = key(p.farmId, p.commodityId, args.programYear)
    const r = args.received.get(k)
    const paidProgram = r?.programs[0] ?? null
    if (!r || !paidProgram) continue
    const implied = impliedRate({
      program: paidProgram, actual: r.amount, baseAcres: p.baseAcres * p.producerShare, plcYield: p.plcYield,
      sequesterPct: r.sequesterPct ?? args.sequesterPct, paymentFactor: args.paymentFactor,
      projectedRate: paidProgram === p.election ? p.result.paymentRatePerUnit : null,
    })
    impliedByKey.set(k, implied)
    if (implied) {
      const g = groupKeyOf(p, paidProgram)
      const list = groups.get(g) ?? []
      list.push({ value: implied.implied, weight: r.amount })
      groups.set(g, list)
    }
  }
  const statementRateByGroup = new Map<string, number>()
  for (const [g, list] of groups) {
    if (list.length < 2) continue
    const m = weightedMedian(list)
    if (m != null) statementRateByGroup.set(g, m)
  }

  // Pass 2: the rows.
  const out: ReceivedVsProjected[] = []
  const seen = new Set<string>()
  for (const p of args.projected) {
    const k = key(p.farmId, p.commodityId, args.programYear)
    seen.add(k)
    const r = args.received.get(k) ?? null
    const projectedNet = p.result.net
    if (!r) {
      out.push({
        farmId: p.farmId, commodityId: p.commodityId, programYear: args.programYear,
        projected: projectedNet, received: null, variance: null, variancePct: null,
        status: statementsExist ? 'projected_not_on_statement' : 'not_yet_paid',
        projectedProgram: p.election, paidProgram: null, paymentDates: [], implied: null, cause: null,
        effective: projectedNet, baseAcres: p.baseAcres, plcYield: p.plcYield, producerShare: p.producerShare,
        shareOfFarmPaid: null, projection: p, receivedDetail: null,
      })
      continue
    }
    const paidProgram = r.programs[0] ?? null
    const base = impliedByKey.get(k) ?? null
    const statementRate = base && paidProgram ? statementRateByGroup.get(groupKeyOf(p, paidProgram)) ?? null : null
    const implied: ImpliedRate | null = base ? { ...base, statementRate } : null
    const expectedAtStatementRate = implied && statementRate != null ? implied.denominator * statementRate : null
    const shareOfFarmPaid = expectedAtStatementRate != null && expectedAtStatementRate > 0 ? round4(r.amount / expectedAtStatementRate) : null
    const variance = round2(r.amount - projectedNet)
    out.push({
      farmId: p.farmId, commodityId: p.commodityId, programYear: args.programYear,
      projected: projectedNet, received: r.amount, variance,
      variancePct: projectedNet !== 0 ? variance / projectedNet : null,
      status: 'paid', projectedProgram: p.election, paidProgram, paymentDates: r.paymentDates, implied,
      cause: attributeVariance({
        variance, projectedNet, received: r.amount, projectedProgram: p.election, paidProgram,
        projectedSequester: args.sequesterPct, statementSequester: r.sequesterPct,
        implied, maxPlcRate: args.maxPlcRateByCommodity?.get(p.commodityId) ?? null,
        arcCap: p.result.arcDetail?.maxRatePerAcre ?? null,
      }),
      effective: r.amount, baseAcres: p.baseAcres, plcYield: p.plcYield, producerShare: p.producerShare,
      shareOfFarmPaid, projection: p, receivedDetail: r,
    })
  }
  for (const [k, r] of args.received) {
    if (r.programYear !== args.programYear || seen.has(k)) continue
    out.push({
      farmId: r.farmId, commodityId: r.commodityId, programYear: r.programYear,
      projected: 0, received: r.amount, variance: r.amount, variancePct: null,
      status: 'paid_no_projection', projectedProgram: null, paidProgram: r.programs[0] ?? null,
      paymentDates: r.paymentDates, implied: null, cause: null,
      effective: r.amount, baseAcres: 0, plcYield: 0, producerShare: 1, shareOfFarmPaid: null, projection: null, receivedDetail: r,
    })
  }
  return out
}

/** The value at which half the weight (dollars) sits below — robust to a few
 *  farms paid on a different share or base. */
export function weightedMedian(items: ReadonlyArray<{ value: number; weight: number }>): number | null {
  const xs = items.filter((i) => i.weight > 0 && Number.isFinite(i.value)).sort((a, b) => a.value - b.value)
  if (xs.length === 0) return null
  const total = xs.reduce((s, i) => s + i.weight, 0)
  let cum = 0
  for (const i of xs) {
    cum += i.weight
    if (cum >= total / 2) return i.value
  }
  return xs[xs.length - 1].value
}

/** Why an actual differs from its projection — one cause, in precedence order. */
export function attributeVariance(args: {
  variance: number
  projectedNet: number
  /** The actual, for the statement-rate test (optional: older callers). */
  received?: number | null
  projectedProgram: ArcPlcElectionType
  paidProgram: 'PLC' | 'ARC_CO' | 'ARC_IC' | null
  projectedSequester: number
  statementSequester: number | null
  implied: ImpliedRate | null
  /** The largest PLC rate the program can pay (ERP − effective-price floor), when known. */
  maxPlcRate: number | null
  /** The ARC-CO rate cap per base acre the projection ran with, when known. */
  arcCap: number | null
}): VarianceCause | null {
  if (Math.abs(args.variance) < 0.5) return null
  if (args.paidProgram && args.paidProgram !== args.projectedProgram) return 'PROGRAM'
  if (args.statementSequester != null && Math.abs(args.statementSequester - args.projectedSequester) > 1e-6) {
    const atStatementSequester = args.projectedNet * (1 - args.statementSequester) / (1 - args.projectedSequester)
    if (Math.abs(args.projectedNet + args.variance - atStatementSequester) < 1) return 'SEQUESTER'
  }
  if (args.implied) {
    // The statement rate is what FSA paid the other farms for this commodity
    // and program. Paid that rate on this farm's base data (within whole-
    // dollar rounding and 2%), the variance is the rate; paid noticeably more
    // or less, FSA's acres / yield / share for this producer differ from ours.
    if (args.implied.statementRate != null && args.received != null) {
      const expected = args.implied.denominator * args.implied.statementRate
      if (Math.abs(args.received - expected) > Math.max(1, 0.02 * expected)) return 'ACRES_YIELD'
      return 'RATE'
    }
    if (args.implied.program === 'PLC' && args.maxPlcRate != null && args.implied.implied > args.maxPlcRate + 1e-6) return 'ACRES_YIELD'
    if (args.implied.program === 'ARC_CO' && args.arcCap != null && args.implied.implied > args.arcCap + 0.01) return 'ACRES_YIELD'
  }
  return 'RATE'
}

export type ReceivedKpis = {
  projected: number
  received: number
  variance: number
  variancePct: number | null
  /** received ÷ projected (null without projections). */
  pctOfProjectedReceived: number | null
  paidRows: number
  unpaidRows: number
  byCause: Record<VarianceCause, number>
}

export function receivedKpis(rows: ReadonlyArray<ReceivedVsProjected>): ReceivedKpis {
  let projected = 0, received = 0, paidRows = 0, unpaidRows = 0
  const byCause: Record<VarianceCause, number> = { RATE: 0, ACRES_YIELD: 0, SEQUESTER: 0, PROGRAM: 0 }
  for (const r of rows) {
    projected += r.projected
    if (r.received != null) { received += r.received; paidRows += 1 } else unpaidRows += 1
    if (r.cause && r.variance != null) byCause[r.cause] = round2(byCause[r.cause] + r.variance)
  }
  const variance = round2(received - projected)
  return {
    projected: round2(projected), received: round2(received), variance,
    variancePct: projected !== 0 ? variance / projected : null,
    pctOfProjectedReceived: projected !== 0 ? received / projected : null,
    paidRows, unpaidRows, byCause,
  }
}

/**
 * Calendar-year totals per payee entity ("FSA payments received in 2026 by
 * Martin Farm") for tax / 1099-G reconciliation: every line's NET, in the
 * year of its payment date (else the statement date).
 */
export function calendarYearTotals(args: {
  statements: ReadonlyArray<{ id: string; statement_date: string; payee_entity_id: string | null; payee_name: string }>
  lines: ReadonlyArray<{ statement_id: string; net_payment: number | string; payment_date: string | null }>
}): Array<{ year: number; payeeEntityId: string | null; payeeName: string; net: number; lines: number }> {
  const byStatement = new Map(args.statements.map((s) => [s.id, s]))
  const out = new Map<string, { year: number; payeeEntityId: string | null; payeeName: string; net: number; lines: number }>()
  for (const l of args.lines) {
    const s = byStatement.get(l.statement_id)
    if (!s) continue
    const year = Number((l.payment_date ?? s.statement_date).slice(0, 4))
    const k = `${year}|${s.payee_entity_id ?? s.payee_name}`
    const cur = out.get(k) ?? { year, payeeEntityId: s.payee_entity_id, payeeName: s.payee_name, net: 0, lines: 0 }
    cur.net = round2(cur.net + (Number(l.net_payment) || 0))
    cur.lines += 1
    out.set(k, cur)
  }
  return [...out.values()].sort((a, b) => b.year - a.year || a.payeeName.localeCompare(b.payeeName))
}
