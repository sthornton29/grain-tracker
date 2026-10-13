import { describe, it, expect } from 'vitest'
import type { BrokerageStatementExtraction, BrokerageOpenPosition } from '@/lib/pdf-upload'
import { reconcileStatementLots } from '@/lib/statement-lots'
import { matchExistingOpenPosition, matchClosedGroupLots, resolveClosedGroupSide } from '@/lib/statement-matching'
import { detectRolls, type RollCandidate } from '@/lib/roll-detection'
import { buildRollPayload } from '@/lib/hedge-roll'
import { buildSavePlan, projectOpenPositions, reconcileWithStatement, type PlanClosedLot, type PlanOpenRow } from '@/lib/import-reconciliation'
import { expandClosedGroup, pnlSizeFor, type Side } from '@/lib/hedging'

// The 10/12/2026 StoneX daily statement (account 490JP046), hand-verified:
//   CONFIRMATION  five BUY fills DEC 26 ICE Cotton 2 (3 @ 80.44, 12 @ 80.45,
//                 3 @ 80.46, 3 @ 80.48, 2 @ 80.49) and five SELL fills MAR 27
//                 (3 @ 83.63, 12 @ 83.64, 3 @ 83.65, 3 @ 83.67, 2 @ 83.68), all SE
//   P&S           DEC 26 cotton: 10 sold 3/18 @ 72.65 and 13 sold 8/10 @ 84.40,
//                 bought back 10/12 by the five fills — "23* 23*", AVG LONG
//                 80.45739, GROSS PROFIT/LOSS 13,410.00DR, fees 531.53 per side
//   OPEN          corn MAR 27 14 @ 5.585 + 12 @ 5.4825 (26*, close 4.9725, +73,475)
//                 soybeans NOV 26 2 @ 12.035 (2*, close 12.8775, −8,425)
//                 wheat JUL 27 2 @ 7.0025, 7.1875, 6.99, 7.31 (8*, close 6.95, +6,900)
//                 cotton MAR 27 the five fills (23*, close 83.81, −1,870)
//   SUMMARY       open trade equity 70,080; gross P&L −13,410; fees 1,063.06

const COTTON_CLOSING_FILLS = [
  { date: '2026-10-12', price: 80.44, contracts: 3 },
  { date: '2026-10-12', price: 80.45, contracts: 12 },
  { date: '2026-10-12', price: 80.46, contracts: 3 },
  { date: '2026-10-12', price: 80.48, contracts: 3 },
  { date: '2026-10-12', price: 80.49, contracts: 2 },
]
const MAR_FILLS: Array<[number, number]> = [[3, 83.63], [12, 83.64], [3, 83.65], [3, 83.67], [2, 83.68]]

const openRow = (o: Partial<BrokerageOpenPosition> & Pick<BrokerageOpenPosition, 'trade_date' | 'num_contracts' | 'commodity' | 'contract_month' | 'trade_price'>): BrokerageOpenPosition => ({
  side: 'short', unrealized_pnl: null, execution_code: 'E', ...o,
})

const OPEN_POSITIONS: BrokerageOpenPosition[] = [
  openRow({ trade_date: '2026-09-03', num_contracts: 14, commodity: 'Corn', contract_month: 'MAR 27', trade_price: 5.585, unrealized_pnl: 42875, execution_code: 'S' }),
  openRow({ trade_date: '2026-09-11', num_contracts: 12, commodity: 'Corn', contract_month: 'MAR 27', trade_price: 5.4825, unrealized_pnl: 30600 }),
  openRow({ trade_date: '2026-05-19', num_contracts: 2, commodity: 'Soybeans', contract_month: 'NOV 26', trade_price: 12.035, unrealized_pnl: -8425 }),
  openRow({ trade_date: '2026-04-29', num_contracts: 2, commodity: 'Chicago Wheat', contract_month: 'JUL 27', trade_price: 7.0025, unrealized_pnl: 525 }),
  openRow({ trade_date: '2026-05-19', num_contracts: 2, commodity: 'Chicago Wheat', contract_month: 'JUL 27', trade_price: 7.1875, unrealized_pnl: 2375 }),
  openRow({ trade_date: '2026-07-15', num_contracts: 2, commodity: 'Chicago Wheat', contract_month: 'JUL 27', trade_price: 6.99, unrealized_pnl: 400 }),
  openRow({ trade_date: '2026-07-23', num_contracts: 2, commodity: 'Chicago Wheat', contract_month: 'JUL 27', trade_price: 7.31, unrealized_pnl: 3600 }),
  ...MAR_FILLS.map(([n, px]) => openRow({ trade_date: '2026-10-12', num_contracts: n, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: px, execution_code: 'SE' })),
]

const SUBTOTALS = [
  { commodity: 'Corn', contract_month: 'MAR 27', side: 'short' as const, contracts: 26, close_price: 4.9725, open_trade_equity: 73475 },
  { commodity: 'Soybeans', contract_month: 'NOV 26', side: 'short' as const, contracts: 2, close_price: 12.8775, open_trade_equity: -8425 },
  { commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short' as const, contracts: 8, close_price: 6.95, open_trade_equity: 6900 },
  { commodity: 'Cotton', contract_month: 'MAR 27', side: 'short' as const, contracts: 23, close_price: 83.81, open_trade_equity: -1870 },
]

const CONFIRMATION = [
  ...COTTON_CLOSING_FILLS.map((f) => ({ trade_date: f.date, side: 'buy' as const, num_contracts: f.contracts, commodity: 'Cotton', contract_month: 'DEC 26', trade_price: f.price, execution_code: 'SE' })),
  ...MAR_FILLS.map(([n, px]) => ({ trade_date: '2026-10-12', side: 'sell' as const, num_contracts: n, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: px, execution_code: 'SE' })),
]

const SUMMARY = {
  beginning_balance: 130741.36, ending_balance: 116268.3, open_trade_equity: 70080, total_equity: 186348.3,
  margin_requirement: 92355, excess_equity: 93993.3, gross_profit_loss_from_trades: -13410, total_commissions_and_fees: 1063.06,
}

/** The statement as the NEW prompt shape returns it. */
export const STONEX_1012: BrokerageStatementExtraction = {
  statement_date: '2026-10-12',
  broker: 'StoneX',
  open_positions: OPEN_POSITIONS,
  closed_groups: [{
    commodity: 'Cotton', contract_month: 'DEC 26', side: 'short', close_date: '2026-10-12', close_price: 80.45739,
    lots: [{ open_date: '2026-03-18', open_price: 72.65, contracts: 10 }, { open_date: '2026-08-10', open_price: 84.4, contracts: 13 }],
    closing_fills: COTTON_CLOSING_FILLS,
    statement_reported_contracts: 23,
    statement_reported_total: -13410,
    fees: 531.53,
    close_execution_code: 'SE',
  }],
  open_position_subtotals: SUBTOTALS,
  confirmation_trades: CONFIRMATION,
  open_options: [],
  closed_options: [],
  account_summary: SUMMARY,
}

/** The statement as today's real parse returned it (scratchpad/stonex-1-3.json):
 *  the five offsetting BUYs read as lots (7 lots, 46 contracts, side "long"),
 *  the MAR fills listed twice (CONFIRMATION + OPEN POSITIONS), plus a "23*"
 *  subtotal, the AVG LONG line and an LTD line read as positions. */
export const STONEX_1012_BUGGY: BrokerageStatementExtraction = {
  statement_date: '2026-10-12',
  broker: 'StoneX',
  open_positions: [
    ...OPEN_POSITIONS,
    ...MAR_FILLS.map(([n, px]) => openRow({ trade_date: '2026-10-12', num_contracts: n, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: px, execution_code: 'SE' })),
    { trade_date: null, side: 'short', num_contracts: '23*' as unknown as number, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: 83.81, unrealized_pnl: -1870, execution_code: null },
    { trade_date: null, side: 'long', num_contracts: 23, commodity: 'Cotton', contract_month: 'DEC 26', trade_price: 80.45739, unrealized_pnl: null, execution_code: null },
    { trade_date: null, side: 'short', num_contracts: 1, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: 0, unrealized_pnl: null, execution_code: null },
  ],
  closed_groups: [{
    commodity: 'Cotton', contract_month: 'DEC 26', side: 'long', close_date: '2026-10-12', close_price: 80.45739,
    lots: [
      { open_date: '2026-03-18', open_price: 72.65, contracts: 10 },
      { open_date: '2026-08-10', open_price: 84.4, contracts: 13 },
      ...COTTON_CLOSING_FILLS.map((f) => ({ open_date: f.date, open_price: f.price, contracts: f.contracts })),
    ],
    statement_reported_total: -13410,
    close_execution_code: 'SE',
  }],
  open_options: [],
  closed_options: [],
  account_summary: { ...SUMMARY, gross_profit_loss_from_trades: null, total_commissions_and_fees: null },
}

// ---------- the database before the import ----------

type DbRow = {
  id: string; entity_id: string | null; commodity: string; contract_month: string; side: Side; num_contracts: number
  trade_price: number; trade_date: string; status: 'open' | 'closed'; close_price: number | null; close_date: string | null
  crop_year: number; roll_group_id: string | null; import_statement_date: string | null; import_statement_ref: string | null
}
const db = (id: string, commodity: string, month: string, n: number, px: number, date: string, over: Partial<DbRow> = {}): DbRow => ({
  id, entity_id: null, commodity, contract_month: month, side: 'short', num_contracts: n, trade_price: px, trade_date: date,
  status: 'open', close_price: null, close_date: null, crop_year: 2026, roll_group_id: null, import_statement_date: null, import_statement_ref: null, ...over,
})
const DB_BEFORE: DbRow[] = [
  db('dec-10', 'Cotton', 'DEC 26', 10, 72.65, '2026-03-18'),
  db('dec-13', 'Cotton', 'DEC 26', 13, 84.4, '2026-08-10'),
  db('corn-14', 'Corn', 'MAR 27', 14, 5.585, '2026-09-03'),
  db('corn-12', 'Corn', 'MAR 27', 12, 5.4825, '2026-09-11'),
  db('soy-2', 'Soybeans', 'NOV 26', 2, 12.035, '2026-05-19'),
  db('w1', 'Chicago Wheat', 'JUL 27', 2, 7.0025, '2026-04-29'),
  db('w2', 'Chicago Wheat', 'JUL 27', 2, 7.1875, '2026-05-19'),
  db('w3', 'Chicago Wheat', 'JUL 27', 2, 6.99, '2026-07-15'),
  db('w4', 'Chicago Wheat', 'JUL 27', 2, 7.31, '2026-07-23'),
]
/** The database AFTER a correct import: DEC closed into roll group rg1, the five MAR fills open in it. */
const DB_AFTER: DbRow[] = [
  ...DB_BEFORE.map((p) =>
    p.contract_month === 'DEC 26'
      ? { ...p, status: 'closed' as const, close_price: 80.45739, close_date: '2026-10-12', roll_group_id: 'rg1', import_statement_date: '2026-10-12', import_statement_ref: 'StoneX' }
      : p,
  ),
  ...MAR_FILLS.map(([n, px], i) => db(`mar-${i}`, 'Cotton', 'MAR 27', n, px, '2026-10-12', { roll_group_id: 'rg1', import_statement_date: '2026-10-12', import_statement_ref: 'StoneX' })),
]

// ---------- the review, as the import component builds it ----------

type OpenReviewRow = PlanOpenRow & { idx: number; existingRollGroupId: string | null }
type LotReviewRow = PlanClosedLot & { gi: number }

function review(extraction: BrokerageStatementExtraction, positions: DbRow[], opts?: { skipReconcile?: boolean }) {
  const rec = reconcileStatementLots(extraction)
  const openLots = opts?.skipReconcile
    ? (extraction.open_positions ?? []).map((p) => ({
        commodity: p.commodity as 'Cotton', contract_month: p.contract_month!, side: p.side!, num_contracts: p.num_contracts!,
        trade_date: p.trade_date!, trade_price: p.trade_price!, execution_code: p.execution_code ?? null,
      }))
    : rec.opens
  const opens: OpenReviewRow[] = openLots.map((o, i) => {
    const { match } = matchExistingOpenPosition(o, positions)
    return {
      key: `o${i}`, idx: i, commodity: o.commodity, contract_month: o.contract_month, side: o.side, num_contracts: o.num_contracts,
      trade_date: o.trade_date, trade_price: o.trade_price, include: match == null, existing: match != null, existingId: match?.id ?? null,
      existingRollGroupId: match?.roll_group_id ?? null, manualMatchId: null, execution_code: o.execution_code, crop_year: '2026',
    }
  })
  const used = new Set<string>()
  const groups = rec.closes.map((g, gi) => {
    const m = matchClosedGroupLots(g, positions, used)
    const side = resolveClosedGroupSide(g.side, m.matchedSides).side
    const expanded = expandClosedGroup({
      contractSizeBu: pnlSizeFor(g.commodity), commodity: g.commodity, contract_month: g.contract_month, side, close_date: g.close_date, close_price: g.close_price,
      lots: m.lots.map((l) => ({ open_date: l.open_trade_date, open_price: l.open_price, contracts: l.num_contracts })),
    })
    const lots: LotReviewRow[] = m.lots.map((l, li) => ({
      ...l, key: `g${gi}l${li}`, groupKey: `g${gi}`, gi, commodity: g.commodity, contract_month: g.contract_month, side,
      close_trade_date: g.close_date, close_price: g.close_price, realized_pnl: expanded[li].realized_pnl, include: !l.alreadyImported,
      crop_year: l.crop_year || '2026',
    }))
    return { ...g, side, lots }
  })
  const rolls = detectRolls(
    groups.map((g, gi) => ({
      key: `g${gi}`, commodity: g.commodity, contract_month: g.contract_month, side: g.side, close_date: g.close_date, close_price: g.close_price,
      close_execution_code: g.close_execution_code,
      lots: g.lots.map((l) => ({ contracts: l.num_contracts, open_price: l.open_price, open_date: l.open_trade_date, matchedOpenId: l.matchedOpenId, heldContracts: l.heldContracts, alreadyImported: l.alreadyImported, crop_year: l.crop_year || null })),
    })),
    opens.map((o) => ({ key: o.key, commodity: o.commodity, contract_month: o.contract_month, side: o.side, num_contracts: o.num_contracts, trade_date: o.trade_date, trade_price: o.trade_price, execution_code: o.execution_code, existingId: o.existingId, existingRollGroupId: o.existingRollGroupId })),
  )
  const lots = groups.flatMap((g) => g.lots)
  const plan = buildSavePlan({ opens, lots, rolls, isRollOn: (c: RollCandidate) => c.defaultOn })
  // The statement's gross P&L covers every close it lists — already-imported
  // ones included — so the realized check sums all of the groups' lots.
  const closesRealized = lots.reduce((s, l) => s + l.realized_pnl, 0)
  const projected = projectOpenPositions(positions, plan)
  const gate = reconcileWithStatement({
    projected, subtotals: rec.subtotals, closesRealized,
    grossProfitLoss: extraction.account_summary?.gross_profit_loss_from_trades ?? null,
    openTradeEquity: extraction.account_summary?.open_trade_equity ?? null,
  })
  return { rec, opens, groups, rolls, plan, projected, gate, closesRealized }
}

// =====================================================================

describe('reconcileStatementLots — the 10/12 statement', () => {
  it('new shape: 12 opens, one closed group of two lots / 23 contracts, closing fills set apart', () => {
    const rec = reconcileStatementLots(STONEX_1012)
    expect(rec.opens).toHaveLength(12)
    expect(rec.opens.filter((o) => o.commodity === 'Cotton').reduce((s, o) => s + o.num_contracts, 0)).toBe(23)
    expect(rec.closes).toHaveLength(1)
    const g = rec.closes[0]
    expect(g.side).toBe('short')
    expect(g.lots).toHaveLength(2)
    expect(g.lots.reduce((s, l) => s + l.contracts, 0)).toBe(23)
    expect(g.closing_fills).toHaveLength(5)
    expect(g.close_price).toBeCloseTo(80.4573913, 7)
    expect(g.statement_reported_contracts).toBe(23)
    expect(g.fees).toBe(531.53)
    expect(rec.subtotals.map((s) => `${s.commodity} ${s.contract_month} ${s.side} ${s.contracts}`)).toEqual([
      'Corn MAR 27 short 26', 'Soybeans NOV 26 short 2', 'Chicago Wheat JUL 27 short 8', 'Cotton MAR 27 short 23',
    ])
    expect(rec.confirmationFills).toHaveLength(10)
    expect(rec.fees).toEqual({ total: 1063.06, closeSide: 531.53, openSide: 531.53 })
    expect(rec.warnings).toEqual([])
  })

  it('buggy shape: the five MAR fills collapse to 5 lots / 23 (not 10 / 46); the close group keeps 2 lots / 23 with a warning; "23*", AVG and LTD rows produce nothing', () => {
    const rec = reconcileStatementLots(STONEX_1012_BUGGY)
    const mar = rec.opens.filter((o) => o.commodity === 'Cotton' && o.contract_month === 'MAR 27')
    expect(mar).toHaveLength(5)
    expect(mar.reduce((s, o) => s + o.num_contracts, 0)).toBe(23)
    expect(rec.opens).toHaveLength(12)
    expect(rec.opens.some((o) => o.contract_month === 'DEC 26')).toBe(false)
    const g = rec.closes[0]
    expect(g.lots).toHaveLength(2)
    expect(g.lots.reduce((s, l) => s + l.contracts, 0)).toBe(23)
    expect(g.closing_fills).toHaveLength(5)
    expect(g.close_price).toBeCloseTo(80.4573913, 7)
    expect(g.side).toBe('short') // read as long; only a short explains the 13,410 loss
    expect(g.sideCorrected).toBe(true)
    expect(rec.warnings).toContain('DEC 26 Cotton: 7 lots read, 46 contracts, but the statement subtotal is 23 — the five 10/12 fills were the closing side and were set aside.')
    expect(rec.warnings.some((w) => w.includes('"23*" subtotal line'))).toBe(true)
    expect(rec.warnings.some((w) => w.includes('no trade date'))).toBe(true)
  })

  it('cotton prices stay ¢/lb: 83.64 vs 83.6400 is one fill, 83.64 vs 83.65 is not', () => {
    const stored = [db('x', 'Cotton', 'MAR 27', 12, 83.64, '2026-10-12')]
    const row = { commodity: 'Cotton', contract_month: 'MAR 27', side: 'short' as const, num_contracts: 12, trade_date: '2026-10-12' }
    expect(matchExistingOpenPosition({ ...row, trade_price: 83.64 }, stored).match?.id).toBe('x')
    expect(matchExistingOpenPosition({ ...row, trade_price: 83.6400 }, stored).match?.id).toBe('x')
    expect(matchExistingOpenPosition({ ...row, trade_price: 83.65 }, stored).match).toBeNull()
  })
})

describe('the import against the database before 10/12', () => {
  const r = review(STONEX_1012, DB_BEFORE)

  it('detects ONE high-confidence spread roll DEC 26 → MAR 27 whose open legs are the five MAR fills', () => {
    expect(r.rolls).toHaveLength(1)
    const roll = r.rolls[0]
    expect(roll.confidence).toBe('high')
    expect(roll.spreadCode).toBe(true)
    expect(roll.fromMonth).toBe('DEC 26')
    expect(roll.toMonth).toBe('MAR 27')
    expect(roll.openKeys).toEqual(r.opens.filter((o) => o.commodity === 'Cotton').map((o) => o.key))
    expect(roll.openKeys).toHaveLength(5)
    expect(roll.closedContracts).toBe(23)
    expect(roll.openContracts).toBe(23)
    expect(roll.openPrice).toBeCloseTo(83.6473913, 7)
    expect(roll.spreadPerUnit).toBeCloseTo(3.19, 5)
    expect(roll.inheritedCropYear).toBe(2026)
    expect(roll.alreadyRecorded).toBe(false)
    expect(roll.defaultOn).toBe(true)
  })

  it('the plan opens 23 MAR once and closes 23 DEC once — nothing else to write', () => {
    expect(r.plan.conflicts).toEqual([])
    expect(r.plan.rolls).toHaveLength(1)
    expect(r.plan.rolls[0].opens.reduce((s, o) => s + o.num_contracts, 0)).toBe(23)
    expect(r.plan.rolls[0].closedLots.reduce((s, l) => s + l.num_contracts, 0)).toBe(23)
    expect(r.plan.rolls[0].closedLots.map((l) => l.matchedOpenId)).toEqual(['dec-10', 'dec-13'])
    expect(r.plan.newOpens).toEqual([])
    expect(r.plan.closesMatched).toEqual([])
    expect(r.plan.closedToImport).toEqual([])
    expect(r.plan.alreadyImported.opens.map((o) => o.existingId)).toEqual(['corn-14', 'corn-12', 'soy-2', 'w1', 'w2', 'w3', 'w4'])
  })

  it('realized on the DEC close is −13,410.00 exactly: −39,036.96 on the 10-lot and +25,626.96 on the 13-lot', () => {
    const lots = r.plan.rolls[0].closedLots
    expect(lots.map((l) => l.realized_pnl)).toEqual([-39036.96, 25626.96])
    expect(Math.round(r.closesRealized * 100) / 100).toBe(-13410)
  })

  it('the roll payload carries every MAR fill as an open leg, the close fees once, the open fees pro-rata, and the override note', () => {
    const roll = r.plan.rolls[0]
    const g = r.groups[0]
    const payload = buildRollPayload({
      source: 'statement_import', statementDate: '2026-10-12', statementRef: 'StoneX', executionCode: 'SE',
      closePrice: g.close_price, closeDate: g.close_date, fees: g.fees ?? 0, openFees: 531.53,
      closedLegs: roll.closedLots.map((l) => ({ positionId: l.matchedOpenId!, quantity: l.num_contracts, side: 'short', commodity: 'Cotton', tradePrice: l.open_price })),
      opens: roll.opens.map((o) => ({ row: { contract_month: o.contract_month, num_contracts: o.num_contracts, trade_price: o.trade_price, trade_date: o.trade_date, commission: 0 } })),
      note: 'Saved with a position mismatch, checked by hand',
    })
    const close = payload.close as Array<Record<string, unknown>>
    expect(close.map((l) => l.realized_pnl)).toEqual([-39036.96, 25626.96])
    expect(close.map((l) => l.fees)).toEqual([531.53, 0])
    const open = payload.open as Array<{ row: { num_contracts: number; commission: number; contract_symbol: string } }>
    expect(Array.isArray(open)).toBe(true)
    expect(open).toHaveLength(5)
    expect(open.map((o) => o.row.num_contracts)).toEqual([3, 12, 3, 3, 2])
    expect(open.every((o) => o.row.contract_symbol === 'CTH27')).toBe(true)
    expect(Math.round(open.reduce((s, o) => s + o.row.commission, 0) * 100) / 100).toBe(531.53)
    expect(payload.note).toBe('Saved with a position mismatch, checked by hand')
  })

  it('the gate passes: projected cotton 23 / corn 26 / soybeans 2 / wheat 8, open trade equity $70,080.00 at the closes, realized ties', () => {
    const by = Object.fromEntries(r.projected.map((p) => [p.key, p.contracts]))
    expect(by).toEqual({ 'Corn|MAR 27|short': 26, 'Soybeans|NOV 26|short': 2, 'Chicago Wheat|JUL 27|short': 8, 'Cotton|MAR 27|short': 23 })
    expect(r.gate.countMismatches).toEqual([])
    expect(r.gate.ote.projected).toBe(70080)
    expect(r.gate.ote.ok).toBe(true)
    expect(r.gate.realized.projected).toBe(-13410)
    expect(r.gate.realized.ok).toBe(true)
    expect(r.gate.level).toBe('ok')
  })

  it('the buggy plan (46 MAR) is blocked with the exact message', () => {
    // Today's raw parse, fed straight to the review without the statement
    // reconciliation: the MAR fills twice over → the roll takes five, five
    // more are "new" → 46.
    const buggy = review({ ...STONEX_1012_BUGGY, open_positions: STONEX_1012_BUGGY.open_positions.filter((p) => p.trade_date != null), open_position_subtotals: SUBTOTALS }, DB_BEFORE, { skipReconcile: true })
    expect(buggy.projected.find((p) => p.key === 'Cotton|MAR 27|short')?.contracts).toBe(46)
    expect(buggy.gate.level).toBe('block')
    expect(buggy.gate.countMismatches).toHaveLength(1)
    expect(buggy.gate.countMismatches[0].message).toBe('Statement shows MAR 27 ICE Cotton short 23. After this import Turnrow would have 46.')
    expect(buggy.gate.countMismatches[0].rows).toHaveLength(10)
    expect(buggy.gate.countMismatches[0].rows[0]).toMatch(/short 3 MAR 27 Cotton @ \$0\.8363 on 10\/12 — from this statement/)
  })

  it('the buggy EXTRACTION through the statement reconciliation lands the same as the clean one', () => {
    const fixed = review(STONEX_1012_BUGGY, DB_BEFORE)
    expect(fixed.rolls).toHaveLength(1)
    expect(fixed.rolls[0].openKeys).toHaveLength(5)
    expect(fixed.plan.newOpens).toEqual([])
    expect(fixed.projected.find((p) => p.key === 'Cotton|MAR 27|short')?.contracts).toBe(23)
    expect(fixed.gate.countMismatches).toEqual([])
    expect(fixed.closesRealized).toBeCloseTo(-13410, 2)
  })
})

describe('the same statement against the database AFTER the import', () => {
  const r = review(STONEX_1012, DB_AFTER)

  it('everything is already imported — the plan is empty and the roll is "already recorded"', () => {
    expect(r.opens.every((o) => o.existing)).toBe(true)
    expect(r.groups[0].lots.every((l) => l.alreadyImported)).toBe(true)
    expect(r.rolls).toHaveLength(1)
    expect(r.rolls[0].alreadyRecorded).toBe(true)
    expect(r.rolls[0].defaultOn).toBe(false)
    expect(r.plan.isEmpty).toBe(true)
    expect(r.plan.rolls).toEqual([])
    expect(r.plan.alreadyImported.rolls).toHaveLength(1)
    expect(r.plan.alreadyImported.closedLots).toHaveLength(2)
    expect(r.plan.alreadyImported.opens).toHaveLength(12)
  })

  it('and the gate still ties: the stored positions alone match the statement', () => {
    expect(r.gate.countMismatches).toEqual([])
    expect(r.gate.ote.projected).toBe(70080)
    expect(r.gate.level).toBe('ok')
  })
})
