'use client'

import { COMMODITIES, type Commodity, contractMonthSortKey, fmtCommodityPrice } from '@/lib/hedging'
import type { FuturesPosition } from '@/lib/types'

export type PriceInfo = { price: number | null; price_date: string | null; stale: boolean }
export type PriceMap = Map<string, PriceInfo>

// Compact board of current futures prices for the contract months the user
// actually holds open positions in, grouped by commodity.
export default function PriceBoard({
  positions,
  prices,
  priceDate,
}: {
  positions: FuturesPosition[]
  prices: PriceMap
  priceDate: string | null
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
                    return (
                      <li key={symbol} className="flex justify-between text-sm">
                        <span className="font-mono text-slate-600">{symbol}</span>
                        <span className="font-mono">
                          {info?.price != null ? fmtCommodityPrice(c, info.price) : '—'}
                          {info?.stale && <span className="text-amber-600 text-xs ml-1" title={`as of ${info.price_date}`}>*</span>}
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
      <p className="text-xs text-slate-400 mt-2">* price is from an earlier day (market closed or not yet refreshed).</p>
    </div>
  )
}
