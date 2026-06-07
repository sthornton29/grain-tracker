import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { nearbyContractSymbol, commodityToTraded } from '@/lib/government-payments'

export const runtime = 'nodejs'
export const maxDuration = 30

const BARCHART_URL = 'https://ondemand.websol.barchart.com/getQuote.json'

// Estimates the Marketing Year Average price for each tradeable commodity using
// the nearby futures price as a proxy for the current level. Corn/Soybeans/Wheat
// have Barchart data; other commodities (seed cotton, sorghum, oats, barley,
// peanuts) return no estimate and the user enters the MYA manually.
type Estimate = {
  commodity_id: string
  name: string
  symbol: string | null
  price: number | null // dollars per bushel
  price_date: string | null
  stale: boolean
  tradeable: boolean
}

type CommodityInput = { commodity_id: string; name: string }

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
  let body: { crop_year?: unknown; commodities?: unknown; force?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const cropYear = Number(body.crop_year)
  if (!Number.isFinite(cropYear)) {
    return NextResponse.json({ error: 'crop_year is required.' }, { status: 400 })
  }
  const commodities: CommodityInput[] = Array.isArray(body.commodities)
    ? (body.commodities as unknown[])
        .map((c) => {
          const o = c as { commodity_id?: unknown; name?: unknown }
          return { commodity_id: String(o.commodity_id ?? ''), name: String(o.name ?? '') }
        })
        .filter((c) => c.commodity_id && c.name)
    : []
  const force = body.force === true

  const withSymbol = commodities.map((c) => ({ ...c, symbol: nearbyContractSymbol(c.name), tradeable: !!commodityToTraded(c.name) }))
  const symbols = Array.from(new Set(withSymbol.map((c) => c.symbol).filter((s): s is string => !!s)))

  const supabase = createClient()
  const today = todayISO()

  const cachedToday = new Map<string, { price: number; price_date: string }>()
  if (symbols.length > 0) {
    const { data: todaysRows } = await supabase
      .from('market_prices')
      .select('contract_symbol, price, price_date')
      .in('contract_symbol', symbols)
      .eq('price_date', today)
    for (const r of todaysRows ?? []) cachedToday.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date as string })
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
        const price = Math.round((cents / 100) * 1e6) / 1e6 // cents/bu -> $/bu
        const price_date = dateFromTimestamp(r?.tradeTimestamp ?? r?.serverTimestamp, today)
        fetched.set(sym, { price, price_date })
        marketUpserts.push({ contract_symbol: sym, price, price_date })
      }
      if (marketUpserts.length > 0) {
        await supabase.from('market_prices').upsert(marketUpserts, { onConflict: 'contract_symbol,price_date' })
      }
      if (results.length === 0) note = 'Barchart returned no quotes (market closed or contract not yet listed) — showing the most recent cached estimate.'
    } catch (e: any) {
      note = `Could not reach Barchart (${e?.message ?? 'network error'}) — showing the most recent cached estimate.`
    }
  } else if (needFetch.length > 0 && !apiKey) {
    note = 'BARCHART_API_KEY is not configured — showing the most recent cached estimate only.'
  }

  // Fall back to most-recent cached price for any symbol not refreshed.
  const stillMissing = symbols.filter((s) => !cachedToday.has(s) && !fetched.has(s))
  const fallback = new Map<string, { price: number; price_date: string }>()
  if (stillMissing.length > 0) {
    const { data: recent } = await supabase
      .from('market_prices')
      .select('contract_symbol, price, price_date')
      .in('contract_symbol', stillMissing)
      .order('price_date', { ascending: false })
    for (const r of recent ?? []) {
      if (!fallback.has(r.contract_symbol)) fallback.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date as string })
    }
  }

  // Persist the estimate per commodity/year so the PLC engine and reports can
  // read it even before a refresh, without clobbering a manually-entered MYA.
  const priceUpserts: Array<{ commodity_id: string; crop_year: number; mya_price_estimate: number; source: string; updated_at: string }> = []
  const estimates: Estimate[] = withSymbol.map((c) => {
    const hit = c.symbol ? cachedToday.get(c.symbol) ?? fetched.get(c.symbol) ?? fallback.get(c.symbol) : undefined
    if (hit) priceUpserts.push({ commodity_id: c.commodity_id, crop_year: cropYear, mya_price_estimate: hit.price, source: 'barchart', updated_at: new Date().toISOString() })
    return {
      commodity_id: c.commodity_id,
      name: c.name,
      symbol: c.symbol,
      price: hit ? hit.price : null,
      price_date: hit ? hit.price_date : null,
      stale: hit ? hit.price_date < today : true,
      tradeable: c.tradeable,
    }
  })

  if (priceUpserts.length > 0) {
    // Only update the estimate + source for rows whose MYA hasn't been finalized
    // or manually overridden; a fresh row is created when none exists yet.
    for (const up of priceUpserts) {
      const { data: existing } = await supabase
        .from('arc_plc_price_data')
        .select('id, source')
        .eq('commodity_id', up.commodity_id)
        .eq('crop_year', up.crop_year)
        .maybeSingle()
      if (!existing) {
        await supabase.from('arc_plc_price_data').insert(up)
      } else if ((existing as { source: string }).source !== 'manual') {
        await supabase.from('arc_plc_price_data').update({ mya_price_estimate: up.mya_price_estimate, source: 'barchart', updated_at: up.updated_at }).eq('id', (existing as { id: string }).id)
      }
    }
  }

  const priceDate = estimates.reduce<string | null>((max, p) => (p.price_date && (!max || p.price_date > max) ? p.price_date : max), null)
  return NextResponse.json({ priceDate, estimates, note })
}
