// THE quote-resolution seam (server side). Every current futures price the
// app shows — the /api/market-prices route the pages call, and the partner
// API's service-role assembly — comes through here, so the order is decided
// once:
//
//   1. today's LIVE row in the market_prices day-cache;
//   2. a fresh Barchart fetch for what's missing (upserted back into the cache
//      as source 'live'), unless the key is unset or the fetch fails;
//   3. the most recent LIVE cached row (yesterday's close, a weekend, a
//      contract Barchart stopped returning);
//   4. the org's MANUAL quote for the symbol (082 manual_market_quotes —
//      ICE Cotton has no live coverage in the CME Ag package; a typed price
//      fills the hole, clearly labeled downstream);
//   5. nothing — the caller's existing no-quote handling.
//
// Live therefore outranks manual by construction: the moment coverage returns
// for a symbol, step 1–3 answer first and the manual row simply stops being
// reached (it stays on file as the fallback).

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeBarchartPrice } from '@/lib/hedging'
import type { QuoteWireRow } from '@/lib/quotes'

const BARCHART_URL = 'https://ondemand.websol.barchart.com/getQuote.json'

export function todayISO(d = new Date()): string {
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

// Barchart timestamps look like "2026-05-22T16:14:00-05:00"; take the date part.
function dateFromTimestamp(ts: unknown, fallback: string): string {
  if (typeof ts === 'string') {
    const m = ts.match(/^(\d{4}-\d{2}-\d{2})/)
    if (m) return m[1]
  }
  return fallback
}

type Hit = { price: number; price_date: string }
type ManualHit = { price: number; entered_at: string }

/** The Barchart call, isolated so tests can stub it. Returns what it could
 *  quote (normalized to the app's unit) or throws on a network failure. */
export async function fetchBarchart(symbols: readonly string[], apiKey: string, today: string): Promise<Map<string, Hit>> {
  const url = `${BARCHART_URL}?apikey=${encodeURIComponent(apiKey)}&symbols=${encodeURIComponent(symbols.join(','))}`
  const resp = await fetch(url, { cache: 'no-store' })
  const json: unknown = await resp.json().catch(() => null)
  const results = Array.isArray((json as { results?: unknown[] } | null)?.results)
    ? ((json as { results: unknown[] }).results as Array<Record<string, unknown>>)
    : []
  const out = new Map<string, Hit>()
  for (const r of results) {
    const sym = typeof r?.symbol === 'string' ? r.symbol.toUpperCase() : null
    // lastPrice is the EOD/last trade; fall back to close (prior settlement).
    const raw = r?.lastPrice ?? r?.close ?? r?.settlement
    const cents = typeof raw === 'number' ? raw : Number(raw)
    if (!sym || !Number.isFinite(cents)) continue
    out.set(sym, { price: normalizeBarchartPrice(sym, cents), price_date: dateFromTimestamp(r?.tradeTimestamp ?? r?.serverTimestamp, today) })
  }
  return out
}

export type ResolveQuotesArgs = {
  supabase: SupabaseClient
  symbols: readonly string[]
  /** Refetch even when today's cache has the symbol. */
  force?: boolean
  /** Service-role callers MUST pass the org (they bypass RLS); session
   *  clients leave it undefined and RLS scopes the manual rows. */
  orgId?: string | null
  today?: string
  /** Injectable for tests: the live fetch (default fetchBarchart) and the key. */
  live?: ((symbols: readonly string[], today: string) => Promise<Map<string, Hit>>) | null
  apiKey?: string | null
}

export type ResolveQuotesResult = {
  prices: QuoteWireRow[]
  priceDate: string | null
  note?: string
}

/** Pure ordering over already-gathered candidates — the rule the tests pin. */
export function pickQuote(args: {
  symbol: string
  today: string
  cachedToday?: Hit | null
  fetched?: Hit | null
  recentLive?: Hit | null
  manual?: ManualHit | null
}): QuoteWireRow {
  const live = args.cachedToday ?? args.fetched ?? args.recentLive ?? null
  if (live) return { symbol: args.symbol, price: live.price, price_date: live.price_date, stale: live.price_date < args.today, source: 'live', entered_at: null }
  if (args.manual) {
    const day = args.manual.entered_at.slice(0, 10)
    return { symbol: args.symbol, price: args.manual.price, price_date: day, stale: day < args.today, source: 'manual', entered_at: args.manual.entered_at }
  }
  return { symbol: args.symbol, price: null, price_date: null, stale: true, source: null, entered_at: null }
}

export async function resolveQuotes(args: ResolveQuotesArgs): Promise<ResolveQuotesResult> {
  const { supabase } = args
  const symbols = Array.from(new Set(args.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)))
  if (symbols.length === 0) return { prices: [], priceDate: null }
  const today = args.today ?? todayISO()
  const force = args.force === true

  // 1. Today's live cache.
  const { data: todaysRows } = await supabase
    .from('market_prices')
    .select('contract_symbol, price, price_date')
    .in('contract_symbol', symbols)
    .eq('price_date', today)
  const cachedToday = new Map<string, Hit>()
  for (const r of (todaysRows ?? []) as Array<{ contract_symbol: string; price: number; price_date: string }>) {
    cachedToday.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date })
  }

  // 2. Barchart for what's missing.
  const needFetch = force ? symbols : symbols.filter((s) => !cachedToday.has(s))
  const apiKey = args.apiKey === undefined ? process.env.BARCHART_API_KEY : args.apiKey
  const live = args.live === undefined ? (s: readonly string[], t: string) => fetchBarchart(s, apiKey!, t) : args.live
  const fetched = new Map<string, Hit>()
  let note: string | undefined
  if (needFetch.length > 0 && apiKey && live) {
    try {
      const got = await live(needFetch, today)
      for (const [sym, hit] of got) fetched.set(sym, hit)
      if (got.size > 0) {
        await supabase
          .from('market_prices')
          .upsert([...got].map(([contract_symbol, h]) => ({ contract_symbol, price: h.price, price_date: h.price_date })), { onConflict: 'contract_symbol,price_date' })
      } else {
        note = 'Barchart returned no quotes (market closed or symbols not yet listed) — showing most recent cached prices.'
      }
    } catch (e) {
      note = `Could not reach Barchart (${e instanceof Error ? e.message : 'network error'}) — showing most recent cached prices.`
    }
  } else if (needFetch.length > 0 && !apiKey) {
    note = 'BARCHART_API_KEY is not configured — showing most recent cached prices only.'
  }

  // 3. Most recent live cache for the rest.
  const stillMissing = symbols.filter((s) => !cachedToday.has(s) && !fetched.has(s))
  const recentLive = new Map<string, Hit>()
  if (stillMissing.length > 0) {
    const { data: recent } = await supabase
      .from('market_prices')
      .select('contract_symbol, price, price_date')
      .in('contract_symbol', stillMissing)
      .order('price_date', { ascending: false })
    for (const r of (recent ?? []) as Array<{ contract_symbol: string; price: number; price_date: string }>) {
      if (!recentLive.has(r.contract_symbol)) recentLive.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date })
    }
  }

  // 4. Manual quotes — for EVERY requested symbol (so the client can offer
  //    "edit" on a manual row even when live has since taken over), but they
  //    only answer when no live candidate exists. Missing table (082 not
  //    applied) degrades to none.
  const manual = new Map<string, ManualHit>()
  try {
    let q = supabase.from('manual_market_quotes').select('contract_symbol, price, entered_at').in('contract_symbol', symbols)
    if (args.orgId) q = q.eq('org_id', args.orgId)
    const { data: manualRows, error } = await q
    if (!error) {
      for (const r of (manualRows ?? []) as Array<{ contract_symbol: string; price: number; entered_at: string }>) {
        manual.set(r.contract_symbol.toUpperCase(), { price: Number(r.price), entered_at: r.entered_at })
      }
    }
  } catch { /* 082 not applied — no manual tier */ }

  const prices = symbols.map((s) => pickQuote({
    symbol: s, today,
    cachedToday: cachedToday.get(s), fetched: fetched.get(s), recentLive: recentLive.get(s), manual: manual.get(s),
  }))
  const priceDate = prices.reduce<string | null>((max, p) => (p.price_date && (!max || p.price_date > max) ? p.price_date : max), null)
  return { prices, priceDate, note }
}
