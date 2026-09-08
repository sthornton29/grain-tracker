'use client'

import { COMMODITIES, type Commodity, contractMonthSortKey, fmtCommodityPrice } from '@/lib/hedging'
import type { FuturesPosition } from '@/lib/types'
import type { Quote } from '@/lib/quotes'
import ManualQuoteControl, { QuoteChip } from '@/components/quote-chip'

/** One quote per symbol as the seam returned it (null price = no quote). */
export type PriceInfo = { price: number | null; price_date: string | null; stale: boolean; source?: 'live' | 'manual' | null; entered_at?: string | null }
export type PriceMap = Map<string, PriceInfo>

export function infoToQuote(symbol: string, info: PriceInfo | undefined): Quote | null {
  if (!info || info.price == null) return null
  return { symbol, price: info.price, priceDate: info.price_date, stale: info.stale, source: info.source === 'manual' ? 'manual' : 'live', enteredAt: info.entered_at ?? null }
}

// Compact board of current futures prices for the contract months the user
// actually holds open positions in, grouped by commodity.
export default function PriceBoard({
  positions,
  prices,
  priceDate,
  onManualSaved,
}: {
  positions: FuturesPosition[]
  prices: PriceMap
  priceDate: string | null
  /** A manual quote was entered/edited on the board — the page refetches. */
  onManualSaved?: (q: Quote) => void
}) {
  // Distinct (symbol, contract_month) per commodity from OPEN positions.
  const byCommodity = new Map<Commodity, Array<{ symbol: string; month: string }>>()
  for (const c of COMMODITIES) byCommodity.set(c, [])
  const seen = new Set<string>()
  for (const p of positions) {
    if (p.status !== 'open') continue
    const list = byCommodity.get(p.commodity as Commodity)
    if (!list) continue
    if (seen.has(p.contract_symbol)) continue
    seen.add(p.contract_symbol)
    list.push({ symbol: p.contract_symbol, month: p.contract_month })
  }
  for (const list of byCommodity.values()) {
    list.sort((a, b) => contractMonthSortKey(a.month) - contractMonthSortKey(b.month))
  }

  const anything = Array.from(byCommodity.values()).some((l) => l.length > 0)
  if (!anything) return null

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex items-baseline gap-3 mb-3">
        <h2 className="font-semibold">Price Board</h2>
        <span className="text-xs text-slate-500">
          {priceDate ? `Prices as of ${priceDate}` : 'No prices yet'}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {COMMODITIES.map((c) => {
          const list = byCommodity.get(c) ?? []
          return (
            <div key={c}>
              <div className="text-sm font-semibold text-slate-700 mb-1">{c}</div>
              {list.length === 0 ? (
                <div className="text-xs text-slate-400">No open positions</div>
              ) : (
                <ul className="space-y-1">
                  {list.map(({ symbol }) => {
                    const info = prices.get(symbol)
                    const q = infoToQuote(symbol, info)
                    return (
                      <li key={symbol} className="flex justify-between items-center gap-2 text-sm">
                        <span className="font-mono text-slate-600">{symbol}</span>
                        <span className="font-mono inline-flex items-center gap-1.5">
                          {q ? fmtCommodityPrice(c, q.price) : null}
                          {q?.source === 'live' && q.stale && <span className="text-amber-600 text-xs" title={`as of ${q.priceDate}`}>*</span>}
                          {q?.source === 'manual' && <QuoteChip quote={q} />}
                          {/* No live price (ICE cotton, a dropped month, a feed outage):
                              the blank becomes an "enter price" box; a manual quote
                              gets "edit". Saved once, used everywhere. */}
                          {onManualSaved && q?.source !== 'live' && (
                            <ManualQuoteControl symbol={symbol} quote={q} onSaved={onManualSaved} compact />
                          )}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
      <p className="text-xs text-slate-400 mt-2">* price is from an earlier day (market closed or not yet refreshed). A <span className="rounded-full bg-amber-100 text-amber-800 px-1 font-semibold">manual</span> chip marks a price you entered because there is no live quote for that contract.</p>
    </div>
  )
}
