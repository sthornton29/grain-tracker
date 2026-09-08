// Futures quotes — the ONE shape every consumer reads, and the pure rules
// around it (082):
//
//   * a quote is `live` (Barchart, via the market_prices day-cache) or
//     `manual` (typed by the org where a price was missing — ICE Cotton has
//     no live coverage in the CME Ag package). Resolution order lives in
//     lib/quote-resolution.ts and is always live → manual → none; the client
//     never decides, it only READS the source it was handed;
//   * a manual quote is never mistaken for market data: `quoteProvenance`
//     yields the chip ("manual · 9/2"), escalating amber past 7 days and red
//     past 30;
//   * prices travel in the commodity's NATIVE stored unit ($/bu grains, ¢/lb
//     cotton) — the same unit market_prices holds — and manual ENTRY converts
//     at the established boundary (parseCottonPriceInput: 0.7265 and 72.65
//     both land as 72.65¢).

import { fmtCommodityPrice, parseCottonPriceInput, parsePrice } from '@/lib/hedging'

export type QuoteSource = 'live' | 'manual'

export type Quote = {
  symbol: string
  /** Native stored unit: $/bu for grains, ¢/lb for cotton. */
  price: number
  /** The trade date (live) or the entry date (manual), YYYY-MM-DD. */
  priceDate: string | null
  /** Older than today. */
  stale: boolean
  source: QuoteSource
  /** Manual only: when it was typed (ISO timestamp). */
  enteredAt: string | null
}

/** The /api/market-prices wire row (also what lib/quote-resolution returns). */
export type QuoteWireRow = {
  symbol: string
  price: number | null
  price_date: string | null
  stale: boolean
  source?: QuoteSource | null
  entered_at?: string | null
}

/** Wire row → Quote (null when the symbol resolved to no price at all). */
export function quoteFromWire(row: QuoteWireRow | null | undefined): Quote | null {
  if (!row || row.price == null || !Number.isFinite(Number(row.price))) return null
  return {
    symbol: row.symbol.toUpperCase(),
    price: Number(row.price),
    priceDate: row.price_date ?? null,
    stale: !!row.stale,
    source: row.source === 'manual' ? 'manual' : 'live',
    enteredAt: row.entered_at ?? null,
  }
}

/** A map keyed by symbol from the route's `prices` array. */
export function quoteMapFromWire(rows: ReadonlyArray<QuoteWireRow> | null | undefined): Map<string, Quote> {
  const m = new Map<string, Quote>()
  for (const r of rows ?? []) {
    const q = quoteFromWire(r)
    if (q) m.set(q.symbol, q)
  }
  return m
}

// ---------------------------------------------------------------------------
// Staleness + provenance chip
// ---------------------------------------------------------------------------

export const MANUAL_QUOTE_WEEK_DAYS = 7
export const MANUAL_QUOTE_MONTH_DAYS = 30

/** Whole days between the manual entry and `today` (YYYY-MM-DD or Date). */
export function manualQuoteAgeDays(enteredAt: string | null | undefined, today: string | Date = new Date()): number | null {
  if (!enteredAt) return null
  const t = Date.parse(enteredAt)
  if (!Number.isFinite(t)) return null
  const now = typeof today === 'string' ? Date.parse(`${today}T00:00:00`) : today.getTime()
  if (!Number.isFinite(now)) return null
  const entered = new Date(t)
  const enteredDay = Date.UTC(entered.getFullYear(), entered.getMonth(), entered.getDate())
  const nowD = new Date(now)
  const nowDay = Date.UTC(nowD.getFullYear(), nowD.getMonth(), nowD.getDate())
  return Math.max(0, Math.round((nowDay - enteredDay) / 86_400_000))
}

export type QuoteTone = 'neutral' | 'amber' | 'red'
export type QuoteProvenance = {
  /** Short chip text: "manual · 9/2" (live quotes get no chip). */
  chip: string | null
  tone: QuoteTone
  /** Longer hover/explainer text. */
  title: string
  /** Set when a manual quote has aged past a threshold. */
  warning: string | null
  ageDays: number | null
}

const mdy = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${Number(m[2])}/${Number(m[3])}` : ''
}

/** How to present a quote's origin. Live quotes are unmarked; a manual quote
 *  always carries the amber "manual · M/D" chip, turning red after a month. */
export function quoteProvenance(q: Pick<Quote, 'source' | 'priceDate' | 'enteredAt'> | null | undefined, today: string | Date = new Date()): QuoteProvenance {
  if (!q || q.source !== 'manual') {
    return { chip: null, tone: 'neutral', title: 'Live market quote', warning: null, ageDays: null }
  }
  const date = q.enteredAt ?? q.priceDate
  const ageDays = manualQuoteAgeDays(date, today)
  const when = mdy(date)
  const chip = `manual · ${when || 'today'}`
  let tone: QuoteTone = 'amber'
  let warning: string | null = null
  if (ageDays != null && ageDays > MANUAL_QUOTE_MONTH_DAYS) {
    tone = 'red'
    warning = `This manual quote is over a month old (${ageDays} days) — update it.`
  } else if (ageDays != null && ageDays > MANUAL_QUOTE_WEEK_DAYS) {
    tone = 'amber'
    warning = `This manual quote is a week old (${ageDays} days) — update it if the market has moved.`
  }
  const title = `Not a live market price: entered by hand${when ? ` on ${when}` : ''}. Live coverage, when available, replaces it automatically.`
  return { chip, tone, title, warning, ageDays }
}

// ---------------------------------------------------------------------------
// Manual entry — the unit boundary
// ---------------------------------------------------------------------------

/** Parse what a user typed for a manual quote into the commodity's stored
 *  unit: cotton accepts $/lb (0.7265) or ¢/lb (72.65) and stores ¢; grains
 *  accept $/bu (incl. fractional "4'50" via parsePrice) and store $/bu.
 *  Null when unparseable or not positive. */
export function parseManualQuoteInput(commodity: string | null | undefined, raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null
  const v = commodity === 'Cotton' ? parseCottonPriceInput(raw) : parsePrice(raw)
  if (v == null || !Number.isFinite(v) || v <= 0) return null
  return v
}

/** Display a stored quote in the commodity's convention ($0.7265 for cotton
 *  ¢ storage; $4.50 for grains). */
export function fmtQuote(commodity: string | null | undefined, price: number | null | undefined): string {
  return fmtCommodityPrice(commodity, price)
}

/** The commodity of a contract symbol ('CTZ26' → 'Cotton', 'ZCZ26' → 'Corn'). */
export function commodityForSymbol(symbol: string | null | undefined): 'Corn' | 'Soybeans' | 'Chicago Wheat' | 'Cotton' | null {
  const s = (symbol ?? '').toUpperCase()
  if (s.startsWith('CT')) return 'Cotton'
  if (s.startsWith('ZC')) return 'Corn'
  if (s.startsWith('ZS')) return 'Soybeans'
  if (s.startsWith('ZW')) return 'Chicago Wheat'
  return null
}

/** Commodities the live feed does not cover — their symbols show the manual
 *  entry control even before a fetch has failed. */
export const NO_LIVE_COVERAGE_COMMODITIES: ReadonlySet<string> = new Set(['Cotton'])

export function hasLiveCoverage(symbol: string | null | undefined): boolean {
  const c = commodityForSymbol(symbol)
  return c != null && !NO_LIVE_COVERAGE_COMMODITIES.has(c)
}
