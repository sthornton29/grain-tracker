// The statement import's save plan and the reconciliation gate (2026-10-13).
//
// buildSavePlan is the ONE place the review's rows become the buckets the
// save writes: rolls (close + open legs in one RPC), new opens, closes of
// matched positions, closed trades to import — and what is already in
// Turnrow and therefore saved again never. A lot can live in one bucket
// only; a repeat is flagged and the save refuses.
//
// projectOpenPositions folds that plan into the stored positions and
// reconcileWithStatement compares the result to what the statement says the
// account holds (the "*" subtotals, open trade equity at the statement's
// closes, the day's realized total). A contract count that would not match
// the statement BLOCKS the save — the 10/12 StoneX import that opened 46
// MAR 27 cotton against a statement showing 23 would have stopped here.
// Pure: no I/O.

import { pnlSizeFor, unrealizedPnl, fmtCommodityPrice, type Side } from '@/lib/hedging'
import type { RollCandidate } from '@/lib/roll-detection'
import type { StatementSubtotal } from '@/lib/statement-lots'

// ---------- the save plan ----------

export type PlanOpenRow = {
  /** Unique within the review (the detector's open key). */
  key: string
  commodity: string
  contract_month: string
  side: Side
  num_contracts: number
  trade_date: string
  trade_price: number
  include: boolean
  /** Matched a stored position (any status) — never saved again. */
  existing: boolean
  existingId: string | null
  manualMatchId: string | null
  execution_code: string | null
  crop_year: string
}

export type PlanClosedLot = {
  /** Unique within the review. */
  key: string
  /** The detector's group key this lot belongs to. */
  groupKey: string
  commodity: string
  contract_month: string
  side: Side
  open_trade_date: string
  open_price: number
  num_contracts: number
  close_trade_date: string
  close_price: number
  realized_pnl: number
  matchedOpenId: string | null
  heldContracts: number | null
  alreadyImported: boolean
  closedRowId: string | null
  include: boolean
  crop_year: string
}

export type PlanRoll<O extends PlanOpenRow, L extends PlanClosedLot> = {
  candidate: RollCandidate
  /** Every open leg of the roll (statement order). */
  opens: O[]
  /** Every closed lot of the group. */
  closedLots: L[]
}

export type SavePlan<O extends PlanOpenRow, L extends PlanClosedLot> = {
  rolls: PlanRoll<O, L>[]
  newOpens: O[]
  closesMatched: L[]
  closedToImport: L[]
  alreadyImported: { opens: O[]; closedLots: L[]; rolls: RollCandidate[] }
  /** Keys that landed in more than one bucket — the save must refuse. */
  conflicts: string[]
  /** Nothing to write. */
  isEmpty: boolean
}

export function buildSavePlan<O extends PlanOpenRow, L extends PlanClosedLot>(args: {
  opens: readonly O[]
  lots: readonly L[]
  rolls: readonly RollCandidate[]
  isRollOn: (c: RollCandidate) => boolean
}): SavePlan<O, L> {
  const openByKey = new Map(args.opens.map((o) => [o.key, o]))
  const activeRolls = args.rolls.filter((c) => !c.alreadyRecorded && args.isRollOn(c))
  const rollOpenKeys = new Set<string>()
  const rollGroupKeys = new Set<string>()
  const rolls: PlanRoll<O, L>[] = []
  for (const c of activeRolls) {
    const opens = c.openKeys.map((k) => openByKey.get(k)).filter((o): o is O => o != null)
    const closedLots = args.lots.filter((l) => l.groupKey === c.closedKey)
    if (opens.length === 0 || closedLots.length === 0) continue
    for (const k of c.openKeys) rollOpenKeys.add(k)
    rollGroupKeys.add(c.closedKey)
    rolls.push({ candidate: c, opens, closedLots })
  }

  const newOpens = args.opens.filter((o) => o.include && !o.existing && !o.manualMatchId && !rollOpenKeys.has(o.key))
  const closesMatched = args.lots.filter((l) => l.include && l.matchedOpenId != null && !l.alreadyImported && !rollGroupKeys.has(l.groupKey))
  const closedToImport = args.lots.filter((l) => l.include && l.matchedOpenId == null && !l.alreadyImported && !rollGroupKeys.has(l.groupKey))

  // No lot twice: every key the plan writes, counted across buckets.
  const seen = new Map<string, number>()
  const count = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1)
  for (const r of rolls) {
    for (const o of r.opens) count(o.key)
    for (const l of r.closedLots) count(l.key)
  }
  for (const o of newOpens) count(o.key)
  for (const l of closesMatched) count(l.key)
  for (const l of closedToImport) count(l.key)
  const conflicts = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)

  return {
    rolls,
    newOpens,
    closesMatched,
    closedToImport,
    alreadyImported: {
      opens: args.opens.filter((o) => o.existing),
      closedLots: args.lots.filter((l) => l.alreadyImported),
      rolls: args.rolls.filter((c) => c.alreadyRecorded),
    },
    conflicts,
    isEmpty: rolls.length === 0 && newOpens.length === 0 && closesMatched.length === 0 && closedToImport.length === 0,
  }
}

/** Throws when the plan would write the same lot twice. */
export function assertSavePlan(plan: SavePlan<PlanOpenRow, PlanClosedLot>): void {
  if (plan.conflicts.length > 0) {
    throw new Error(`The import would save the same trade twice (${plan.conflicts.join(', ')}).`)
  }
}

// ---------- projection ----------

export type ProjectionPosition = {
  id: string
  commodity: string
  contract_month: string
  side: Side
  num_contracts: number
  trade_price: number
  trade_date: string
  status: string
  entity_id?: string | null
}

/**
 * Every stored position this statement's rows point at: open rows matched
 * automatically or paired by hand, and the positions its closed lots (roll
 * legs included) close.
 */
export function statementReferencedIds(args: {
  opens: readonly Pick<PlanOpenRow, 'existingId' | 'manualMatchId'>[]
  lots: readonly Pick<PlanClosedLot, 'matchedOpenId'>[]
}): Set<string> {
  const ids = new Set<string>()
  for (const o of args.opens) {
    if (o.existingId) ids.add(o.existingId)
    if (o.manualMatchId) ids.add(o.manualMatchId)
  }
  for (const l of args.lots) if (l.matchedOpenId) ids.add(l.matchedOpenId)
  return ids
}

/**
 * The stored positions the gate projects. The account-entity scope keeps a
 * position held in ANOTHER account out of the comparison — but a position's
 * entity is an attribution tag (lib/entity-scope), not proof of which
 * brokerage account holds it. A position this very statement lists — matched
 * by one of its open rows, paired by hand, or closed by one of its lots — is
 * in this account whatever it is tagged, so it always counts. Without this
 * the 10/29 StoneX statement blocked on "MAR 27 Corn short 26, Turnrow would
 * have 12": the 14-lot was stored, open and already matched, but tagged with
 * an entity while the import's account entity was "none".
 */
export function scopeGatePositions<P extends { id: string; entity_id?: string | null }>(
  positions: readonly P[],
  args: { inScope: (entityId: string | null) => boolean; referencedIds: ReadonlySet<string> },
): P[] {
  return positions.filter((p) => args.referencedIds.has(p.id) || args.inScope(p.entity_id ?? null))
}

export type ProjectedLot = {
  commodity: string
  contract_month: string
  side: Side
  contracts: number
  trade_price: number
  trade_date: string
  /** 'stored' = already in Turnrow; 'statement' = this import adds it. */
  origin: 'stored' | 'statement'
  /** "short 12 MAR 27 Cotton @ $0.8364 on 10/12 — from this statement" */
  description: string
}

export type ProjectedPosition = {
  /** commodity|MONTH|side */
  key: string
  commodity: string
  contract_month: string
  side: Side
  contracts: number
  lots: ProjectedLot[]
}

const up = (s: string) => s.trim().toUpperCase()
const mdy = (d: string) => d.replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1/$2')

export function positionKey(p: { commodity: string; contract_month: string; side: Side }): string {
  return `${p.commodity}|${up(p.contract_month)}|${p.side}`
}

function describeLot(l: { side: Side; contracts: number; contract_month: string; commodity: string; trade_price: number; trade_date: string }, origin: ProjectedLot['origin']): string {
  return `${l.side} ${l.contracts} ${up(l.contract_month)} ${l.commodity} @ ${fmtCommodityPrice(l.commodity, l.trade_price)} on ${mdy(l.trade_date)} — ${origin === 'stored' ? 'already in Turnrow' : 'from this statement'}`
}

/**
 * The account's open lots AFTER the plan is saved, per commodity + month +
 * side. `positions` must already be scoped to the statement's account
 * (entity) — only open rows count. Rolls close their closed legs (matched
 * positions lose the rolled contracts) and open their open legs; new opens
 * are added; matched closes reduce or remove the matched position; closed
 * trades to import add nothing open.
 */
export function projectOpenPositions<O extends PlanOpenRow, L extends PlanClosedLot>(
  positions: readonly ProjectionPosition[],
  plan: SavePlan<O, L>,
): ProjectedPosition[] {
  const remaining = new Map<string, number>()
  for (const p of positions) if (p.status === 'open') remaining.set(p.id, p.num_contracts)
  const take = (id: string | null, n: number) => {
    if (!id || !remaining.has(id)) return
    remaining.set(id, Math.max(0, (remaining.get(id) ?? 0) - n))
  }

  const added: ProjectedLot[] = []
  const addOpen = (o: PlanOpenRow) => {
    added.push({
      commodity: o.commodity, contract_month: up(o.contract_month), side: o.side, contracts: o.num_contracts,
      trade_price: o.trade_price, trade_date: o.trade_date, origin: 'statement',
      description: describeLot({ side: o.side, contracts: o.num_contracts, contract_month: o.contract_month, commodity: o.commodity, trade_price: o.trade_price, trade_date: o.trade_date }, 'statement'),
    })
  }

  for (const r of plan.rolls) {
    for (const l of r.closedLots) take(l.matchedOpenId, l.num_contracts)
    for (const o of r.opens) if (!o.existingId && !o.manualMatchId) addOpen(o)
  }
  for (const o of plan.newOpens) addOpen(o)
  for (const l of plan.closesMatched) take(l.matchedOpenId, l.num_contracts)

  const byKey = new Map<string, ProjectedPosition>()
  const put = (lot: ProjectedLot) => {
    if (lot.contracts <= 0) return
    const key = positionKey(lot)
    const cur = byKey.get(key) ?? { key, commodity: lot.commodity, contract_month: lot.contract_month, side: lot.side, contracts: 0, lots: [] }
    cur.contracts += lot.contracts
    cur.lots.push(lot)
    byKey.set(key, cur)
  }
  for (const p of positions) {
    if (p.status !== 'open') continue
    const n = remaining.get(p.id) ?? 0
    put({
      commodity: p.commodity, contract_month: up(p.contract_month), side: p.side, contracts: n,
      trade_price: Number(p.trade_price), trade_date: p.trade_date, origin: 'stored',
      description: describeLot({ side: p.side, contracts: n, contract_month: p.contract_month, commodity: p.commodity, trade_price: Number(p.trade_price), trade_date: p.trade_date }, 'stored'),
    })
  }
  for (const lot of added) put(lot)
  return [...byKey.values()]
}

// ---------- the gate ----------

export type CountMismatch = {
  commodity: string
  month: string
  side: Side
  statement: number
  projected: number
  /** The lots behind the projected count. */
  rows: string[]
  /** "Statement shows MAR 27 ICE Cotton short 23. After this import Turnrow would have 46." */
  message: string
}

export type DollarCheck = {
  projected: number | null
  statement: number | null
  /** null when the statement did not print the figure. */
  ok: boolean | null
  diff: number | null
}

export type ReconciliationLevel = 'block' | 'warn' | 'ok'

export type ReconciliationResult = {
  countMismatches: CountMismatch[]
  ote: DollarCheck
  realized: DollarCheck
  level: ReconciliationLevel
}

/** How the statement names a commodity: cotton is "ICE Cotton" on StoneX. */
export function statementCommodityLabel(commodity: string): string {
  return commodity === 'Cotton' ? 'ICE Cotton' : commodity
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function reconcileWithStatement(args: {
  projected: readonly ProjectedPosition[]
  subtotals: readonly StatementSubtotal[]
  /** Realized (gross) of every close this plan writes — rolls included. */
  closesRealized: number
  grossProfitLoss: number | null | undefined
  openTradeEquity: number | null | undefined
  /** Dollar tolerance for the two money checks. */
  tolerance?: number
}): ReconciliationResult {
  const tol = args.tolerance ?? 1
  const projectedByKey = new Map(args.projected.map((p) => [p.key, p]))
  const statementCommodities = new Set<string>(args.subtotals.map((s) => s.commodity))
  const countMismatches: CountMismatch[] = []
  const mismatch = (commodity: string, month: string, side: Side, statement: number, projected: number, rows: string[]) => {
    countMismatches.push({
      commodity, month, side, statement, projected, rows,
      message: `Statement shows ${month} ${statementCommodityLabel(commodity)} ${side} ${statement}. After this import Turnrow would have ${projected}.`,
    })
  }
  const seenKeys = new Set<string>()
  for (const s of args.subtotals) {
    seenKeys.add(s.key)
    const p = projectedByKey.get(s.key)
    const projected = p?.contracts ?? 0
    if (projected !== s.contracts) mismatch(s.commodity, s.contract_month, s.side, s.contracts, projected, p?.lots.map((l) => l.description) ?? [])
  }
  // A month Turnrow would hold that the statement does not list, within the
  // commodities the statement covers (another account's corn is not ours to
  // judge, but a cotton month missing from a cotton statement is).
  for (const p of args.projected) {
    if (seenKeys.has(p.key) || !statementCommodities.has(p.commodity) || p.contracts <= 0) continue
    mismatch(p.commodity, p.contract_month, p.side, 0, p.contracts, p.lots.map((l) => l.description))
  }

  // Open trade equity at the statement's close prices.
  let oteProjected: number | null = null
  const priced = args.subtotals.filter((s) => s.close_price > 0)
  if (priced.length > 0) {
    let sum = 0
    for (const s of priced) {
      const p = projectedByKey.get(s.key)
      if (!p) continue
      for (const l of p.lots) {
        sum += unrealizedPnl({ side: l.side, tradePrice: l.trade_price, currentPrice: s.close_price, numContracts: l.contracts, contractSizeBu: pnlSizeFor(l.commodity) }) ?? 0
      }
    }
    oteProjected = round2(sum)
  }
  const oteStatement = args.openTradeEquity != null ? round2(Number(args.openTradeEquity)) : null
  const ote: DollarCheck = {
    projected: oteProjected,
    statement: oteStatement,
    diff: oteProjected != null && oteStatement != null ? round2(oteProjected - oteStatement) : null,
    ok: oteProjected != null && oteStatement != null ? Math.abs(oteProjected - oteStatement) <= tol : null,
  }

  const realizedComputed = round2(args.closesRealized)
  const realizedStatement = args.grossProfitLoss != null ? round2(Number(args.grossProfitLoss)) : null
  const realized: DollarCheck = {
    projected: realizedComputed,
    statement: realizedStatement,
    diff: realizedStatement != null ? round2(realizedComputed - realizedStatement) : null,
    ok: realizedStatement != null ? Math.abs(realizedComputed - realizedStatement) <= tol : null,
  }

  const level: ReconciliationLevel =
    countMismatches.length > 0 ? 'block' : ote.ok === false || realized.ok === false ? 'warn' : 'ok'
  return { countMismatches, ote, realized, level }
}
