import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { harvestContractSymbol, harvestContractLabel } from '@/lib/crop-insurance'
import { normalizeBarchartPrice } from '@/lib/hedging'

export const runtime = 'nodejs'
export const maxDuration = 30

const BARCHART_URL = 'https://ondemand.websol.barchart.com/getQuote.json'

// One crop's running harvest-price estimate: the current price of the futures
// contract whose price discovery period sets the RMA harvest price (DEC corn,
// NOV soybeans, SEP Chicago wheat). Converges toward the final price through
// the discovery month; the user enters the RMA-final value manually afterward.
type Estimate = {
  crop_id: string
  symbol: string | null
  label: string | null
  price: number | null // dollars per bushel
  price_date: string | null
  stale: boolean // true when the cached price is older than today
}

type CropInput = { crop_id: string; crop_name: string }

function todayISO(): string {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

function dateFromTimestamp(ts: unknown, fallback: string): string {
  if (typeof ts === 'string') {
    const m = ts.match(/^(\d{4}-\d{2}-\d{2})/)
    if (m) return m[1]
  }
  return fallback
}

export async function POST(req: NextRequest) {
  let body: { crop_year?: unknown; crops?: unknown; force?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const cropYear = Number(body.crop_year)
  if (!Number.isFinite(cropYear)) {
    return NextResponse.json({ error: 'crop_year is required.' }, { status: 400 })
  }
  const crops: Array<CropInput & { symbol_override?: string | null }> = Array.isArray(body.crops)
    ? (body.crops as unknown[])
        .map((c) => {
          const o = c as { crop_id?: unknown; crop_name?: unknown; symbol_override?: unknown }
          return {
            crop_id: String(o.crop_id ?? ''), crop_name: String(o.crop_name ?? ''),
            symbol_override: typeof o.symbol_override === 'string' && /^[A-Z]{1,3}[FGHJKMNQUVXZ]\d{2}$/.test(o.symbol_override) ? o.symbol_override : null,
          }
        })
        .filter((c) => c.crop_id && c.crop_name)
    : []
  const force = body.force === true

  // Map each crop to its harvest futures symbol. A caller-supplied
  // symbol_override — the RMA offer's BASE CONTRACT (e.g. Alabama corn
  // ZCU26) — beats the hard-coded new-crop month, which is the Midwest CEPP
  // assumption and wrong for Southern offers. Crops with neither (e.g.
  // Canola without an override) drop out.
  const withSymbol = crops
    .map((c) => ({
      ...c,
      symbol: c.symbol_override ?? harvestContractSymbol(c.crop_name, cropYear),
      label: c.symbol_override ?? harvestContractLabel(c.crop_name, cropYear),
    }))
    .filter((c): c is CropInput & { symbol: string; label: string } => !!c.symbol)

  if (withSymbol.length === 0) {
    return NextResponse.json({ priceDate: null, estimates: [] as Estimate[] })
  }

  const supabase = createClient()
  const today = todayISO()
  const symbols = Array.from(new Set(withSymbol.map((c) => c.symbol)))

  // What's cached for today already?
  const { data: todaysRows } = await supabase
    .from('market_prices')
    .select('contract_symbol, price, price_date')
    .in('contract_symbol', symbols)
    .eq('price_date', today)
  const cachedToday = new Map<string, { price: number; price_date: string }>()
  for (const r of todaysRows ?? []) {
    cachedToday.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date as string })
  }

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
      const marketUpserts: Array<{ contract_symbol: string; price: number; price_date: string }> = []
      for (const r of results) {
        const sym = typeof r?.symbol === 'string' ? r.symbol.toUpperCase() : null
        const raw = r?.lastPrice ?? r?.close ?? r?.settlement
        const cents = typeof raw === 'number' ? raw : Number(raw)
        if (!sym || !Number.isFinite(cents)) continue
        // Grains: cents/bu → $/bu. Cotton (CT…): already ¢/lb — pass through.
        const price = Math.round(normalizeBarchartPrice(sym, cents) * 1e6) / 1e6
        const price_date = dateFromTimestamp(r?.tradeTimestamp ?? r?.serverTimestamp, today)
        fetched.set(sym, { price, price_date })
        marketUpserts.push({ contract_symbol: sym, price, price_date })
      }
      if (marketUpserts.length > 0) {
        // Reuse the shared market_prices day-cache (same symbols the hedging
        // page uses), then mirror into harvest_price_estimates for history.
        await supabase.from('market_prices').upsert(marketUpserts, { onConflict: 'contract_symbol,price_date' })
        const estimateUpserts = withSymbol
          .map((c) => {
            const hit = fetched.get(c.symbol)
            if (!hit) return null
            return {
              crop_id: c.crop_id,
              crop_year: cropYear,
              price_type: 'harvest_estimate' as const,
              price: hit.price,
              source: 'Barchart estimate',
              price_date: hit.price_date,
            }
          })
          .filter((x): x is NonNullable<typeof x> => x != null)
        if (estimateUpserts.length > 0) {
          await supabase
            .from('harvest_price_estimates')
            .upsert(estimateUpserts, { onConflict: 'crop_id,crop_year,price_type,price_date' })
        }
      }
      if (results.length === 0) {
        note = 'Barchart returned no quotes (market closed or contract not yet listed) — showing the most recent cached estimate.'
      }
    } catch (e: any) {
      note = `Could not reach Barchart (${e?.message ?? 'network error'}) — showing the most recent cached estimate.`
    }
  } else if (needFetch.length > 0 && !apiKey) {
    note = 'BARCHART_API_KEY is not configured — showing the most recent cached estimate only.'
  }

  // Fall back to the most recent cached price for any symbol we couldn't refresh.
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

  const estimates: Estimate[] = withSymbol.map((c) => {
    const hit = cachedToday.get(c.symbol) ?? fetched.get(c.symbol) ?? fallback.get(c.symbol)
    if (!hit) return { crop_id: c.crop_id, symbol: c.symbol, label: c.label, price: null, price_date: null, stale: true }
    return { crop_id: c.crop_id, symbol: c.symbol, label: c.label, price: hit.price, price_date: hit.price_date, stale: hit.price_date < today }
  })

  const priceDate = estimates.reduce<string | null>(
    (max, p) => (p.price_date && (!max || p.price_date > max) ? p.price_date : max),
    null,
  )

  return NextResponse.json({ priceDate, estimates, note })
}
