// The spot-price ESTIMATE, wired to the database (094, 2026-10-13).
//
// lib/spot-price decides the price (settled > typed bid > estimate); this
// helper gathers what the estimate needs and runs it from the browser:
//
//   futures   — the market_prices settle for the delivery date's bid month
//               (deliveryFuturesSymbol), newest row dated on/before the
//               delivery; with none on file at all, today's quote from
//               POST /api/market-prices (and the chip says so).
//   basis     — this buyer's implied spot basis from its SETTLED spot loads
//               of the same crop (settled price − that day's futures settle,
//               impliedBuyerBasis), else the crop's assumed basis from
//               Marketing assumptions (crop_assumptions.assumed_basis), else 0.
//
// Every lookup is best-effort: a failed or missing source degrades to "no
// price yet" (price null) rather than blocking the load's save. The pure
// pieces (settleOnOrBefore, historyFromSettledRows) and the whole helper
// against a fake client are tested in lib/spot-estimate.test.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  deliveryFuturesSymbol, impliedBuyerBasis, resolveSpotPrice,
  type SettledSpotPoint, type SpotPriceDecision,
} from '@/lib/spot-price'

export type SpotEstimateArgs = {
  cropName: string | null | undefined
  cropId: string | null | undefined
  cropYear: number | null | undefined
  buyerId: string | null | undefined
  buyerName?: string | null
  /** ISO date the load was (or will be) delivered. */
  deliveryDate: string
}

export type MarketPriceRow = { contract_symbol?: string; price: number | string; price_date: string }

/** The newest settle dated on or before `date` among the rows (any order). */
export function settleOnOrBefore(rows: ReadonlyArray<MarketPriceRow>, date: string): { price: number; priceDate: string } | null {
  let best: MarketPriceRow | null = null
  for (const r of rows) {
    if (r.price_date > date) continue
    const p = Number(r.price)
    if (!Number.isFinite(p)) continue
    if (!best || r.price_date > best.price_date) best = r
  }
  return best ? { price: Number(best.price), priceDate: best.price_date } : null
}

/** A settled spot row joined to its load (what the history query returns). */
export type SettledSpotRow = {
  spot_price: number | string | null
  load: { date: string; crop_id?: string | null; to_buyer_id?: string | null } | null
}

/** Settled spot rows → basis history points, skipping any row whose
 *  delivery-date futures settle is unknown. */
export function historyFromSettledRows(
  rows: ReadonlyArray<SettledSpotRow>,
  cropName: string | null | undefined,
  settleFor: (symbol: string, date: string) => { price: number } | null,
): SettledSpotPoint[] {
  const out: SettledSpotPoint[] = []
  for (const r of rows) {
    if (!r.load?.date || r.spot_price == null) continue
    const price = Number(r.spot_price)
    if (!Number.isFinite(price)) continue
    const fut = deliveryFuturesSymbol(cropName, r.load.date)
    if (!fut) continue
    const settle = settleFor(fut.symbol, r.load.date)
    if (!settle) continue
    out.push({ date: r.load.date, settledPrice: price, futuresSettle: settle.price })
  }
  return out
}

/** Today's quote for a symbol via the pages' quote endpoint (browser only). */
export async function fetchTodaysQuote(symbol: string): Promise<{ price: number; priceDate: string | null } | null> {
  if (typeof fetch !== 'function') return null
  try {
    const res = await fetch('/api/market-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: [symbol] }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { prices?: Array<{ symbol: string; price: number | null; price_date: string | null }> }
    const hit = (body.prices ?? []).find((p) => p.symbol === symbol && p.price != null)
    return hit && hit.price != null ? { price: Number(hit.price), priceDate: hit.price_date ?? null } : null
  } catch {
    return null
  }
}

const HISTORY_LIMIT = 300

/**
 * Estimate a spot load's price. Returns the resolveSpotPrice decision; when
 * nothing usable is on file the decision's price is null ("no price yet").
 */
export async function estimateSpotPrice(
  supabase: SupabaseClient,
  args: SpotEstimateArgs,
  opts: { fetchQuote?: (symbol: string) => Promise<{ price: number; priceDate: string | null } | null> } = {},
): Promise<SpotPriceDecision> {
  const none = resolveSpotPrice({})
  const fut = deliveryFuturesSymbol(args.cropName, args.deliveryDate)
  if (!fut) return none

  // 1. The futures settle on/just before the delivery date — else today's quote.
  let futures: { price: number; symbol: string; priceDate: string | null; isToday: boolean } | null = null
  try {
    const { data } = await supabase
      .from('market_prices')
      .select('contract_symbol, price, price_date')
      .eq('contract_symbol', fut.symbol)
      .lte('price_date', args.deliveryDate)
      .order('price_date', { ascending: false })
      .limit(1)
    const hit = settleOnOrBefore((data ?? []) as MarketPriceRow[], args.deliveryDate)
    if (hit) futures = { price: hit.price, symbol: fut.symbol, priceDate: hit.priceDate, isToday: false }
  } catch {
    /* fall through to today's quote */
  }
  if (!futures) {
    const q = await (opts.fetchQuote ?? fetchTodaysQuote)(fut.symbol).catch(() => null)
    if (q) futures = { price: q.price, symbol: fut.symbol, priceDate: q.priceDate, isToday: true }
  }
  if (!futures) return none

  // 2. The buyer's implied basis from its settled spot loads of this crop.
  let buyerBasis: ReturnType<typeof impliedBuyerBasis> = null
  if (args.cropId && args.buyerId) {
    try {
      const { data, error } = await supabase
        .from('load_sales')
        .select('spot_price, load:loads!inner(date, crop_id, to_buyer_id)')
        .eq('sale_type', 'spot')
        .eq('spot_price_source', 'settlement')
        .eq('load.crop_id', args.cropId)
        .eq('load.to_buyer_id', args.buyerId)
        .limit(HISTORY_LIMIT)
      if (!error && data && data.length > 0) {
        const rows = (data as unknown as SettledSpotRow[]).filter((r) => r.load?.date)
        // One market_prices read per bid month covering every delivery date.
        const bySymbol = new Map<string, { maxDate: string; minDate: string }>()
        for (const r of rows) {
          const f = deliveryFuturesSymbol(args.cropName, r.load!.date)
          if (!f) continue
          const cur = bySymbol.get(f.symbol)
          const d = r.load!.date
          if (!cur) bySymbol.set(f.symbol, { maxDate: d, minDate: d })
          else { if (d > cur.maxDate) cur.maxDate = d; if (d < cur.minDate) cur.minDate = d }
        }
        const settles = new Map<string, MarketPriceRow[]>()
        for (const [symbol, span] of bySymbol) {
          const { data: mp } = await supabase
            .from('market_prices')
            .select('contract_symbol, price, price_date')
            .eq('contract_symbol', symbol)
            .lte('price_date', span.maxDate)
            .gte('price_date', shiftDays(span.minDate, -14))
            .order('price_date', { ascending: false })
            .limit(400)
          settles.set(symbol, (mp ?? []) as MarketPriceRow[])
        }
        const history = historyFromSettledRows(rows, args.cropName, (symbol, date) => settleOnOrBefore(settles.get(symbol) ?? [], date))
        buyerBasis = impliedBuyerBasis(history, args.deliveryDate)
      }
    } catch {
      buyerBasis = null
    }
  }

  // 3. The crop's assumed basis (Marketing assumptions) when the buyer has no history.
  let assumedBasis = 0
  if (!buyerBasis && args.cropId && args.cropYear != null) {
    try {
      const { data } = await supabase
        .from('crop_assumptions')
        .select('assumed_basis')
        .eq('crop_id', args.cropId)
        .eq('crop_year', args.cropYear)
        .maybeSingle()
      const b = (data as { assumed_basis?: number | string | null } | null)?.assumed_basis
      if (b != null && Number.isFinite(Number(b))) assumedBasis = Number(b)
    } catch {
      assumedBasis = 0
    }
  }

  return resolveSpotPrice({ estimate: { futures, buyerBasis, assumedBasis, buyerName: args.buyerName ?? null } })
}

/** Apply the estimate to a spot row that has no price yet (helper for the
 *  load form, scan review, import and the bulk tool). */
export function withSpotEstimate<R extends { sale_type: string; spot_price?: number | null }>(row: R, d: SpotPriceDecision): R {
  if (row.sale_type !== 'spot' || row.spot_price != null || d.price == null) return row
  return {
    ...row,
    spot_price: d.price,
    spot_price_source: d.source,
    est_futures_price: d.est_futures_price,
    est_futures_symbol: d.est_futures_symbol,
    est_basis: d.est_basis,
  }
}

function shiftDays(iso: string, days: number): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return iso
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days))
  return d.toISOString().slice(0, 10)
}
