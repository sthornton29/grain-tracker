// The one client seam for executing a roll (083): builds the payload the
// hedge_execute_roll RPC expects and calls it. Close + open + linkage happen
// in ONE database transaction; the ledger events are appended by the
// futures_positions trigger inside that same transaction.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildContractSymbol, pnlSizeFor, realizedPnl, type Side } from '@/lib/hedging'

export type RollSource = 'roll_action' | 'statement_import'

export type RollClosedLegInput =
  | {
      /** An existing position: open → closed here; already closed → linked only. */
      positionId: string
      /** Contracts closing; fewer than held = partial roll. */
      quantity: number
      side: Side
      commodity: string
      tradePrice: number
    }
  | {
      positionId?: undefined
      /** Not held in the app yet: the closed lot's own facts get recorded. */
      row: {
        entity_id: string | null
        commodity: string
        contract_month: string
        crop_year: number
        side: Side
        num_contracts: number
        trade_price: number
        trade_date: string
        notes?: string | null
        execution_code?: string | null
      }
    }

export type RollOpenLegInput =
  | { positionId: string }
  | {
      positionId?: undefined
      row: {
        contract_month: string
        num_contracts: number
        trade_price: number
        trade_date: string
        commission?: number
        notes?: string | null
        commodity?: string
        side?: Side
      }
    }

export type RollRequest = {
  source: RollSource
  statementDate?: string | null
  statementRef?: string | null
  executionCode?: string | null
  /** Shared by every closed leg (one offset group closes at one price). */
  closePrice: number
  closeDate: string
  /** Close-side commission for the whole roll (charged once, on the first leg). */
  fees?: number
  /** One or more closed legs; the FIRST is the lineage anchor and the crop-year / entity source. */
  closedLegs: RollClosedLegInput[]
  open: RollOpenLegInput
}

export type RollPayload = Record<string, unknown>

/** Realized P&L (gross) for the closing quantity — the app's one P&L seam. */
export function rollRealized(args: { side: Side; commodity: string; tradePrice: number; closePrice: number; quantity: number }): number {
  return realizedPnl({
    side: args.side,
    tradePrice: args.tradePrice,
    closePrice: args.closePrice,
    numContracts: args.quantity,
    contractSizeBu: pnlSizeFor(args.commodity),
  }).gross
}

export function buildRollPayload(req: RollRequest): RollPayload {
  if (req.closedLegs.length === 0) throw new Error('A roll needs at least one closed leg.')
  const close = req.closedLegs.map((c, i) => {
    const leg: Record<string, unknown> = {
      close_price: req.closePrice,
      close_date: req.closeDate,
      fees: i === 0 ? (req.fees ?? 0) : 0,
    }
    if (c.positionId !== undefined) {
      leg.position_id = c.positionId
      leg.quantity = c.quantity
      leg.realized_pnl = rollRealized({ side: c.side, commodity: c.commodity, tradePrice: c.tradePrice, closePrice: req.closePrice, quantity: c.quantity })
    } else {
      const r = c.row
      leg.quantity = r.num_contracts
      leg.realized_pnl = rollRealized({ side: r.side, commodity: r.commodity, tradePrice: r.trade_price, closePrice: req.closePrice, quantity: r.num_contracts })
      leg.row = { ...r, contract_symbol: buildContractSymbol(r.commodity, r.contract_month) }
    }
    return leg
  })
  const first = req.closedLegs[0]
  const firstCommodity = first.positionId !== undefined ? first.commodity : first.row.commodity
  const o = req.open
  const open: Record<string, unknown> = {}
  if (o.positionId !== undefined) open.position_id = o.positionId
  else {
    const commodity = o.row.commodity ?? firstCommodity
    open.row = { ...o.row, commodity, contract_symbol: buildContractSymbol(commodity, o.row.contract_month) }
  }
  return {
    source: req.source,
    statement_date: req.statementDate ?? null,
    statement_ref: req.statementRef ?? null,
    execution_code: req.executionCode ?? null,
    close,
    open,
  }
}

export type RollResult = { roll_group_id: string; closed_position_id: string; opened_position_id: string }

/** Turn a database error into what the farmer should read. */
export function friendlyRollError(message: string | null | undefined): string {
  const m = (message ?? '').toLowerCase()
  if (m.includes('could not find the function') || (m.includes('hedge_execute_roll') && m.includes('does not exist'))) {
    return 'Rolling positions needs a database update — contact support.'
  }
  if (m.includes('sign in required')) return 'Please sign in again.'
  if (m.includes('cannot roll')) return 'More contracts than the position holds.'
  return message ? `Could not record the roll: ${message}` : 'Could not record the roll.'
}

export async function executeRoll(
  supabase: SupabaseClient,
  req: RollRequest,
): Promise<{ data: RollResult | null; error: string | null }> {
  let payload: RollPayload
  try { payload = buildRollPayload(req) } catch (e) { return { data: null, error: (e as Error).message } }
  const { data, error } = await supabase.rpc('hedge_execute_roll', { payload })
  if (error) return { data: null, error: friendlyRollError(error.message) }
  return { data: (data ?? null) as RollResult | null, error: null }
}
