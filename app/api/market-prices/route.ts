import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { normalizeBarchartPrice } from '@/lib/hedging'

export const runtime = 'nodejs'
export const maxDuration = 30

const BARCHART_URL = 'https://ondemand.websol.barchart.com/getQuote.json'

type PriceResult = {
  symbol: string
  price: number | null // dollars per bushel
  price_date: string | null // YYYY-MM-DD
  stale: boolean // true when the price is older than today (weekend/holiday/no fetch)
}

function todayISO(): string {
  const d = new Date()
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

export async function POST(req: NextRequest) {
  let body: { symbols?: unknown; force?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const symbols = Array.isArray(body.symbols)
    ? Array.from(new Set(body.symbols.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().toUpperCase())))
    : []
  const force = body.force === true

  if (symbols.length === 0) {
    return NextResponse.json({ priceDate: null, prices: [] as PriceResult[] })
  }

  const supabase = createClient()
  const today = todayISO()

  // What do we already have cached for today?
  const { data: todaysRows } = await supabase
    .from('market_prices')
    .select('contract_symbol, price, price_date')
    .in('contract_symbol', symbols)
    .eq('price_date', today)
  const cachedToday = new Map<string, { price: number; price_date: string }>()
  for (const r of todaysRows ?? []) {
    cachedToday.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date as string })
  }

  // Only fetch symbols we don't already have for today (unless forced).
  const needFetch = force ? symbols : symbols.filter((s) => !cachedToday.has(s))

  const apiKey = process.env.BARCHART_API_KEY
  const fetched = new Map<string, { price: number; price_date: string }>()
  let note: string | undefined

  if (needFetch.length > 0 && apiKey) {
    try {
      const url = `${BARCHART_URL}?apikey=${encodeURIComponent(apiKey)}&symbols=${encodeURIComponent(needFetch.join(','))}`
      const resp = await fetch(url, { cache: 'no-store' })
      const json = await resp.json().catch(() => null)
      const results: any[] = Array.isArray(json?.results) ? json.results : []
      const upserts: Array<{ contract_symbol: string; price: number; price_date: string }> = []
      for (const r of results) {
        const sym = typeof r?.symbol === 'string' ? r.symbol.toUpperCase() : null
        // lastPrice is the EOD/last trade; fall back to close (prior settlement).
        const raw = r?.lastPrice ?? r?.close ?? r?.settlement
        const cents = typeof raw === 'number' ? raw : Number(raw)
        if (!sym || !Number.isFinite(cents)) continue
        const price = normalizeBarchartPrice(sym, cents)
        const price_date = dateFromTimestamp(r?.tradeTimestamp ?? r?.serverTimestamp, today)
        fetched.set(sym, { price, price_date })
        upserts.push({ contract_symbol: sym, price, price_date })
      }
      if (upserts.length > 0) {
        // One row per (symbol, date); refresh the price if we fetch again same day.
        await supabase
          .from('market_prices')
          .upsert(upserts, { onConflict: 'contract_symbol,price_date' })
      }
      if (results.length === 0) {
        note = 'Barchart returned no quotes (market closed or symbols not yet listed) — showing most recent cached prices.'
      }
    } catch (e: any) {
      note = `Could not reach Barchart (${e?.message ?? 'network error'}) — showing most recent cached prices.`
    }
  } else if (needFetch.length > 0 && !apiKey) {
    note = 'BARCHART_API_KEY is not configured — showing most recent cached prices only.'
  }

  // For any symbol still without a price (no today cache, no fresh fetch), fall
  // back to the most recent cached price.
  const stillMissing = symbols.filter((s) => !cachedToday.has(s) && !fetched.has(s))
  const fallback = new Map<string, { price: number; price_date: string }>()
  if (stillMissing.length > 0) {
    const { data: recent } = await supabase
      .from('market_prices')
      .select('contract_symbol, price, price_date')
      .in('contract_symbol', stillMissing)
      .order('price_date', { ascending: false })
    for (const r of recent ?? []) {
      if (!fallback.has(r.contract_symbol)) {
        fallback.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date as string })
      }
    }
  }

  const prices: PriceResult[] = symbols.map((s) => {
    const hit = cachedToday.get(s) ?? fetched.get(s) ?? fallback.get(s)
    if (!hit) return { symbol: s, price: null, price_date: null, stale: true }
    return { symbol: s, price: hit.price, price_date: hit.price_date, stale: hit.price_date < today }
  })

  const priceDate =
    prices.reduce<string | null>((max, p) => (p.price_date && (!max || p.price_date > max) ? p.price_date : max), null)

  return NextResponse.json({ priceDate, prices, note })
}
