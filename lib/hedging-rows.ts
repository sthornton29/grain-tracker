// The open-position row model: what the Hedging page, the Hedging Summary
// report, and the assistant all compute per open futures position from ONE
// quote — the current price, its provenance, and the mark-to-market P&L.
// Pure, so the manual-quote path (a CT close typed by hand) is tested exactly
// as the live path.

import { pnlSizeFor, unrealizedPnl } from '@/lib/hedging'
import { quoteProvenance, type Quote, type QuoteProvenance } from '@/lib/quotes'

export type OpenPositionMark = {
  currentPrice: number | null
  /** Null when there is no quote at all. */
  unrealized: number | null
  quote: Quote | null
  provenance: QuoteProvenance
  /** The chip text for the P&L row ("manual · 9/2"), null for live. */
  chip: string | null
}

export function markOpenPosition(args: {
  position: { side: 'long' | 'short'; trade_price: number | string; num_contracts: number | string; commodity: string; contract_symbol: string }
  quote: Quote | null | undefined
  today?: string | Date
}): OpenPositionMark {
  const { position } = args
  const quote = args.quote ?? null
  const currentPrice = quote?.price ?? null
  const unrealized = unrealizedPnl({
    side: position.side,
    tradePrice: Number(position.trade_price),
    currentPrice,
    numContracts: Number(position.num_contracts),
    contractSizeBu: pnlSizeFor(position.commodity),
  })
  const provenance = quoteProvenance(quote, args.today)
  return { currentPrice, unrealized, quote, provenance, chip: provenance.chip }
}

/** Sum of unrealized over rows, plus how many rows had NO quote — so a
 *  subtotal never silently understates when a price is missing. */
export function sumUnrealized(marks: ReadonlyArray<Pick<OpenPositionMark, 'unrealized'>>): { total: number; unpriced: number } {
  let total = 0, unpriced = 0
  for (const m of marks) {
    if (m.unrealized == null) unpriced += 1
    else total += m.unrealized
  }
  return { total, unpriced }
}
