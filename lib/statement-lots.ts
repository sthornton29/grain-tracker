// ONE reconciled trade set per brokerage statement, built BEFORE anything is
// compared to the database (2026-10-13).
//
// The 10/12/2026 StoneX statement taught us what the raw extraction gets
// wrong even when every number on the page is read correctly:
//   * the PURCHASE & SALE block lists the opening lots AND the same-day fills
//     that offset them; read as seven "lots" the DEC 26 cotton group closed
//     46 contracts instead of 23, and the roll opened twice what it closed;
//   * subtotal lines ("23*"), the AVG LONG / AVG SHORT line, the LTD- line and
//     the CLOSE price can slip through as positions;
//   * a same-day fill printed in both CONFIRMATION and OPEN POSITIONS can
//     come back twice.
// reconcileStatementLots turns the extraction into the set of lots the
// statement actually describes — opens, closed groups (opening fills only,
// one weighted close price), the "*" subtotals, the confirmation fills and
// the fees — with a plain-language warning for every row it set aside, so the
// review can show what was dropped and why. Pure: no I/O.

import type {
  BrokerageClosedGroup,
  BrokerageClosingFill,
  BrokerageConfirmationTrade,
  BrokerageOpenPosition,
  BrokerageOpenSubtotal,
  BrokerageStatementExtraction,
} from '@/lib/pdf-upload'
import {
  coercePrice,
  fmtPnl,
  normalizeCommodity,
  pnlSizeFor,
  pricesMatch,
  realizedPnl,
  type Commodity,
  type Side,
} from '@/lib/hedging'
import { normalizeTradeDate } from '@/lib/statement-matching'

export type StatementLot = {
  /** commodity|MONTH|side|date|price — the fill identity (quantity apart). */
  key: string
  commodity: Commodity
  contract_month: string
  side: Side
  num_contracts: number
  /** YYYY-MM-DD */
  trade_date: string
  trade_price: number
  unrealized_pnl: number | null
  execution_code: string | null
}

export type StatementClosedLot = {
  /** YYYY-MM-DD */
  open_date: string
  open_price: number
  contracts: number
}

export type StatementClosingFill = {
  date: string | null
  price: number
  contracts: number
}

export type StatementClosedGroup = {
  commodity: Commodity
  contract_month: string
  side: Side
  /** YYYY-MM-DD */
  close_date: string
  /** The contract-weighted average of the closing fills (or the printed close). */
  close_price: number
  /** Opening fills only. */
  lots: StatementClosedLot[]
  closing_fills: StatementClosingFill[]
  statement_reported_total: number | null
  statement_reported_contracts: number | null
  /** Close-side commission & fees printed for the group (null = none printed). */
  fees: number | null
  close_execution_code: string | null
  /** The extraction's side was flipped because only the other side explains the printed total. */
  sideCorrected: boolean
}

export type StatementSubtotal = {
  key: string
  commodity: Commodity
  contract_month: string
  side: Side
  contracts: number
  close_price: number
  open_trade_equity: number | null
}

export type StatementConfirmationFill = {
  commodity: Commodity
  contract_month: string
  side: 'buy' | 'sell'
  num_contracts: number
  trade_date: string
  trade_price: number
  execution_code: string | null
}

export type StatementFees = {
  /** The summary's TOTAL COMMISSION & FEES. */
  total: number | null
  /** Σ of the closed groups' printed per-side fees. */
  closeSide: number
  /** total − closeSide: what the day's opening fills cost (null when the total is unknown). */
  openSide: number | null
}

export type ReconciledStatement = {
  statement_date: string | null
  opens: StatementLot[]
  closes: StatementClosedGroup[]
  subtotals: StatementSubtotal[]
  confirmationFills: StatementConfirmationFill[]
  fees: StatementFees
  warnings: string[]
}

const up = (s: string | null | undefined) => (s ?? '').trim().toUpperCase()

/** "MAR 27 Cotton" — how a contract reads in a warning. */
export function describeContract(commodity: string, month: string): string {
  return `${up(month)} ${commodity}`
}

/** True when the extraction returned a quantity that still carries the "*". */
function quantityHasStar(v: unknown): boolean {
  return typeof v === 'string' && v.includes('*')
}

function toCount(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null
  const n = Number(String(v).replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** Round a price the way the DB stores it (6 decimals) — only for the key. */
const keyPx = (p: number) => String(Math.round(p * 1e6) / 1e6)

export function lotKey(l: { commodity: string; contract_month: string; side: Side; trade_date: string; trade_price: number }): string {
  return `${l.commodity}|${up(l.contract_month)}|${l.side}|${l.trade_date}|${keyPx(l.trade_price)}`
}

/** Contract-weighted average price of a set of fills, at full precision. */
export function weightedPrice(fills: ReadonlyArray<{ price: number; contracts: number }>): number | null {
  const n = fills.reduce((s, f) => s + f.contracts, 0)
  if (n <= 0) return null
  const sum = fills.reduce((s, f) => s + f.price * f.contracts, 0)
  // 1e-7 keeps the exact 1850.52 / 23 = 80.4573913 — rounding to the DB's
  // six places would move the DEC 26 realized total off the statement's
  // 13,410.00 by two cents.
  return Math.round((sum / n) * 1e7) / 1e7
}

function buildSubtotals(raw: BrokerageOpenSubtotal[] | null | undefined, warnings: string[]): StatementSubtotal[] {
  const out: StatementSubtotal[] = []
  const seen = new Set<string>()
  for (const s of raw ?? []) {
    const commodity = normalizeCommodity(s.commodity)
    const contracts = toCount(s.contracts)
    const close_price = coercePrice(s.close_price)
    if (!commodity || !s.contract_month || (s.side !== 'long' && s.side !== 'short') || contracts == null) continue
    if (close_price == null) {
      warnings.push(`${describeContract(commodity, s.contract_month)}: the statement's subtotal has no close price, so its open trade equity can't be checked.`)
    }
    const key = `${commodity}|${up(s.contract_month)}|${s.side}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, commodity, contract_month: up(s.contract_month), side: s.side, contracts, close_price: close_price ?? 0, open_trade_equity: s.open_trade_equity ?? null })
  }
  return out
}

function buildConfirmationFills(raw: BrokerageConfirmationTrade[] | null | undefined): StatementConfirmationFill[] {
  const out: StatementConfirmationFill[] = []
  for (const t of raw ?? []) {
    const commodity = normalizeCommodity(t.commodity)
    const trade_date = normalizeTradeDate(t.trade_date)
    const trade_price = coercePrice(t.trade_price)
    const n = toCount(t.num_contracts)
    if (!commodity || !t.contract_month || (t.side !== 'buy' && t.side !== 'sell') || !trade_date || trade_price == null || n == null) continue
    if (quantityHasStar(t.num_contracts)) continue
    out.push({ commodity, contract_month: up(t.contract_month), side: t.side, num_contracts: n, trade_date, trade_price, execution_code: t.execution_code ? up(String(t.execution_code)) : null })
  }
  return out
}

function buildOpens(
  raw: BrokerageOpenPosition[],
  subtotals: StatementSubtotal[],
  fills: StatementConfirmationFill[],
  warnings: string[],
): StatementLot[] {
  const candidates: StatementLot[] = []
  for (const p of raw ?? []) {
    const commodity = normalizeCommodity(p.commodity)
    const label = commodity && p.contract_month ? describeContract(commodity, p.contract_month) : 'A line'
    if (quantityHasStar(p.num_contracts)) {
      warnings.push(`${label}: a "${String(p.num_contracts).trim()}" subtotal line was read as a position and set aside.`)
      continue
    }
    const trade_price = coercePrice(p.trade_price)
    const n = toCount(p.num_contracts)
    const trade_date = normalizeTradeDate(p.trade_date)
    if (!commodity || !p.contract_month || (p.side !== 'long' && p.side !== 'short') || n == null || trade_price == null) continue
    if (!trade_date) {
      const sub = subtotals.find((s) => s.commodity === commodity && s.contract_month === up(p.contract_month) && pricesMatch(s.close_price, trade_price))
      if (sub) warnings.push(`${label}: a line at the statement's close price ${trade_price} with no trade date was read as a position and set aside (it is the subtotal's CLOSE).`)
      else warnings.push(`${label}: a line with no trade date (${n} @ ${trade_price}) was set aside — the statement's AVG / LTD lines are not positions.`)
      continue
    }
    const month = up(p.contract_month)
    candidates.push({
      key: lotKey({ commodity, contract_month: month, side: p.side, trade_date, trade_price }),
      commodity,
      contract_month: month,
      side: p.side,
      num_contracts: n,
      trade_date,
      trade_price,
      unrealized_pnl: p.unrealized_pnl ?? null,
      execution_code: p.execution_code ? up(String(p.execution_code)) : null,
    })
  }

  // Collapse per fill key: the same commodity+month+side+date+price listed
  // twice is ONE fill read twice (CONFIRMATION + OPEN POSITIONS) — unless the
  // confirmation shows that many separate fills of that exact key.
  const byKey = new Map<string, StatementLot[]>()
  for (const c of candidates) {
    const list = byKey.get(c.key) ?? []
    list.push(c)
    byKey.set(c.key, list)
  }
  const out: StatementLot[] = []
  const emitted = new Set<string>()
  for (const c of candidates) {
    if (emitted.has(c.key)) continue
    emitted.add(c.key)
    const dupes = byKey.get(c.key)!
    if (dupes.length === 1) { out.push(c); continue }
    const fillSide: 'buy' | 'sell' = c.side === 'long' ? 'buy' : 'sell'
    const confirmed = fills.filter(
      (f) => f.commodity === c.commodity && f.contract_month === c.contract_month && f.side === fillSide && f.trade_date === c.trade_date && pricesMatch(f.trade_price, c.trade_price),
    ).length
    const keep = Math.max(1, Math.min(dupes.length, confirmed))
    out.push(...dupes.slice(0, keep))
    if (keep < dupes.length) {
      warnings.push(`${describeContract(c.commodity, c.contract_month)}: ${c.num_contracts} @ ${c.trade_price} on ${c.trade_date} was listed ${dupes.length} times and kept once.`)
    }
  }
  return out
}

/** A lot that could only be a closing fill: dated the close date and priced
 *  on the closing side. "On the closing side" = matches one of the printed
 *  closing fills, or (no fills printed) the same-day set as a whole averages
 *  to the group's close or counts the same as the earlier-dated lots. */
function splitClosingFills(
  lots: Array<StatementClosedLot & { isCloseDay: boolean }>,
  closingFills: StatementClosingFill[],
  closePrice: number | null,
  reportedContracts: number | null,
): { opening: StatementClosedLot[]; offsetting: StatementClosedLot[] } {
  const sameDay = lots.filter((l) => l.isCloseDay)
  const earlier = lots.filter((l) => !l.isCloseDay)
  if (sameDay.length === 0) return { opening: lots, offsetting: [] }

  if (closingFills.length > 0) {
    const opening: StatementClosedLot[] = [...earlier]
    const offsetting: StatementClosedLot[] = []
    for (const l of sameDay) {
      const hit = closingFills.some((f) => pricesMatch(f.price, l.open_price) && f.contracts === l.contracts)
      ;(hit ? offsetting : opening).push(l)
    }
    return { opening, offsetting }
  }

  const sameDayCount = sameDay.reduce((s, l) => s + l.contracts, 0)
  const earlierCount = earlier.reduce((s, l) => s + l.contracts, 0)
  const avg = weightedPrice(sameDay.map((l) => ({ price: l.open_price, contracts: l.contracts })))
  const averagesToClose = closePrice != null && avg != null && Math.abs(avg - closePrice) <= 0.01
  const countsLikeClose = earlierCount > 0 && (sameDayCount === earlierCount || (reportedContracts != null && sameDayCount === reportedContracts && earlierCount === reportedContracts))
  if (earlier.length > 0 && (averagesToClose || countsLikeClose)) return { opening: earlier, offsetting: sameDay }
  return { opening: lots, offsetting: [] }
}

function buildCloses(raw: BrokerageClosedGroup[], warnings: string[]): StatementClosedGroup[] {
  const out: StatementClosedGroup[] = []
  for (const g of raw ?? []) {
    const commodity = normalizeCommodity(g.commodity)
    const close_date = normalizeTradeDate(g.close_date)
    const printedClose = coercePrice(g.close_price)
    if (!commodity || !g.contract_month || (g.side !== 'long' && g.side !== 'short') || !close_date) continue
    const month = up(g.contract_month)
    const label = describeContract(commodity, month)
    const reportedContracts = toCount(g.statement_reported_contracts)

    const closingFills: StatementClosingFill[] = []
    for (const f of (g.closing_fills ?? []) as BrokerageClosingFill[]) {
      const price = coercePrice(f.price)
      const contracts = toCount(f.contracts)
      if (price == null || contracts == null) continue
      closingFills.push({ date: normalizeTradeDate(f.date), price, contracts })
    }

    const readLots: Array<StatementClosedLot & { isCloseDay: boolean }> = []
    for (const l of g.lots ?? []) {
      if (quantityHasStar(l.contracts)) {
        warnings.push(`${label}: a "${String(l.contracts).trim()}" subtotal line was read as a lot and set aside.`)
        continue
      }
      const open_price = coercePrice(l.open_price)
      const contracts = toCount(l.contracts)
      const open_date = normalizeTradeDate(l.open_date)
      if (open_price == null || contracts == null) continue
      if (!open_date) {
        warnings.push(`${label}: a lot with no open date (${contracts} @ ${open_price}) was set aside — the AVG line is the close price, not a lot.`)
        continue
      }
      readLots.push({ open_date, open_price, contracts, isCloseDay: open_date === close_date })
    }

    const { opening, offsetting } = splitClosingFills(readLots, closingFills, printedClose, reportedContracts)
    if (offsetting.length > 0 && closingFills.length === 0) {
      for (const l of offsetting) closingFills.push({ date: close_date, price: l.open_price, contracts: l.contracts })
    }
    if (opening.length === 0) {
      warnings.push(`${label}: no opening lots could be read for the offset closed ${close_date} — it was set aside.`)
      continue
    }

    const readCount = readLots.reduce((s, l) => s + l.contracts, 0)
    const openingCount = opening.reduce((s, l) => s + l.contracts, 0)
    const subtotal = reportedContracts ?? openingCount
    if (offsetting.length > 0) {
      const mdy = close_date.replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1/$2')
      warnings.push(
        `${label}: ${readLots.length} lots read, ${readCount} contracts, but the statement subtotal is ${subtotal} — the ${offsetting.length === 1 ? 'one' : numberWord(offsetting.length)} ${mdy} fill${offsetting.length === 1 ? '' : 's'} ${offsetting.length === 1 ? 'was' : 'were'} the closing side and ${offsetting.length === 1 ? 'was' : 'were'} set aside.`,
      )
    } else if (reportedContracts != null && reportedContracts !== openingCount) {
      warnings.push(`${label}: the lots read add up to ${openingCount} contracts but the statement subtotal is ${reportedContracts} — check this group before saving.`)
    }

    const weighted = closingFills.length > 0 ? weightedPrice(closingFills) : null
    let close_price = weighted ?? printedClose
    if (close_price == null) {
      warnings.push(`${label}: no close price could be read for the offset closed ${close_date} — it was set aside.`)
      continue
    }
    if (weighted != null && printedClose != null && !pricesMatch(weighted, printedClose, 0.001)) {
      warnings.push(`${label}: the printed close ${printedClose} differs from the closing fills' average ${weighted} — the average was used.`)
    }
    close_price = Math.round(close_price * 1e7) / 1e7

    // The side the printed total can only mean: when the extracted side's
    // math is the exact opposite of the statement total, the side is flipped.
    let side: Side = g.side
    let sideCorrected = false
    const reportedTotal = g.statement_reported_total ?? null
    if (reportedTotal != null && Math.abs(reportedTotal) > 1) {
      const size = pnlSizeFor(commodity)
      const totalFor = (s: Side) =>
        opening.reduce((sum, l) => sum + realizedPnl({ side: s, tradePrice: l.open_price, closePrice: close_price, numContracts: l.contracts, contractSizeBu: size }).gross, 0)
      const asRead = totalFor(g.side)
      const flipped: Side = g.side === 'short' ? 'long' : 'short'
      if (Math.abs(asRead - reportedTotal) > 1 && Math.abs(totalFor(flipped) - reportedTotal) <= 1) {
        side = flipped
        sideCorrected = true
        warnings.push(`${label}: read as ${g.side}, but the statement's ${reportedTotal < 0 ? 'loss' : 'gain'} of ${fmtPnl(Math.abs(reportedTotal))} only works as a ${flipped} — corrected.`)
      }
    }

    out.push({
      commodity,
      contract_month: month,
      side,
      close_date,
      close_price,
      lots: opening.map(({ open_date, open_price, contracts }) => ({ open_date, open_price, contracts })),
      closing_fills: closingFills,
      statement_reported_total: reportedTotal,
      statement_reported_contracts: reportedContracts,
      fees: g.fees != null && Number.isFinite(Number(g.fees)) ? Math.abs(Number(g.fees)) : null,
      close_execution_code: g.close_execution_code ? up(String(g.close_execution_code)) : null,
      sideCorrected,
    })
  }
  return out
}

function numberWord(n: number): string {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n)
}

/** The legacy per-line closed_trades shape wrapped as one-lot groups. */
function legacyGroups(data: BrokerageStatementExtraction): BrokerageClosedGroup[] {
  return (data.closed_trades ?? []).map((t) => ({
    commodity: t.commodity,
    contract_month: t.contract_month,
    side: t.side,
    close_date: t.close_trade_date,
    close_price: t.close_price,
    lots: [{ open_date: t.open_trade_date, open_price: t.open_price, contracts: t.num_contracts }],
    statement_reported_total: t.realized_pnl ?? null,
    close_execution_code: null,
  }))
}

/**
 * The statement's trade set: what it actually says, with the subtotal / AVG /
 * LTD / closing-fill rows set aside and explained. Run this on the merged
 * extraction before matching anything to the database.
 */
export function reconcileStatementLots(data: BrokerageStatementExtraction): ReconciledStatement {
  const warnings: string[] = []
  const subtotals = buildSubtotals(data.open_position_subtotals, warnings)
  const confirmationFills = buildConfirmationFills(data.confirmation_trades)
  const opens = buildOpens(data.open_positions ?? [], subtotals, confirmationFills, warnings)
  const closes = buildCloses(data.closed_groups?.length ? data.closed_groups : legacyGroups(data), warnings)

  // The statement's open count per contract vs what we read — the review
  // shows it; the gate (lib/import-reconciliation) blocks on it after the
  // database is folded in.
  for (const s of subtotals) {
    const read = opens.filter((o) => o.commodity === s.commodity && o.contract_month === s.contract_month && o.side === s.side).reduce((n, o) => n + o.num_contracts, 0)
    if (read !== s.contracts) {
      warnings.push(`${describeContract(s.commodity, s.contract_month)}: the statement shows ${s.side} ${s.contracts}, but ${read} were read from its open positions.`)
    }
  }

  const closeSide = Math.round(closes.reduce((s, g) => s + (g.fees ?? 0), 0) * 100) / 100
  const total = data.account_summary?.total_commissions_and_fees != null ? Math.abs(Number(data.account_summary.total_commissions_and_fees)) : null
  const fees: StatementFees = {
    total,
    closeSide,
    openSide: total != null && total >= closeSide ? Math.round((total - closeSide) * 100) / 100 : null,
  }

  return {
    statement_date: normalizeTradeDate(data.statement_date),
    opens,
    closes,
    subtotals,
    confirmationFills,
    fees,
    warnings,
  }
}
