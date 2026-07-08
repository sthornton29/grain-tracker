import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { commodityToTraded } from '@/lib/government-payments'
import {
  estimateMyaBlend,
  futuresSymbolsForBlend,
  type MyaBlendResult,
} from '@/lib/mya-estimate'

export const runtime = 'nodejs'
export const maxDuration = 30

const BARCHART_URL = 'https://ondemand.websol.barchart.com/getQuote.json'

// Estimates the Marketing Year Average price for each commodity as a
// month-by-month blend over the marketing year: operator-entered USDA/NASS
// monthly farm prices for the months that have them, futures-implied prices
// (nearest contract + per-commodity basis adjustment) for the rest, weighted
// by typical monthly marketing weights. See lib/mya-estimate.ts. A single
// day's futures quote is NOT an MYA — this replaces the old nearby-quote
// proxy. Untraded commodities (seed cotton, sorghum, …) still get an estimate
// when monthly prices have been entered; otherwise the user enters the MYA
// manually.
type Estimate = {
  commodity_id: string
  name: string
  price: number | null // blended MYA estimate, $/bu (or $/lb for pound units)
  price_date: string | null // most recent futures quote date used
  stale: boolean // true when any futures month used a non-today quote
  tradeable: boolean
  composition: {
    publishedCount: number
    futuresCount: number
    missingCount: number
    basisAdj: number
    months: MyaBlendResult['months']
  } | null
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
  const inputs: CommodityInput[] = Array.isArray(body.commodities)
    ? (body.commodities as unknown[])
        .map((c) => {
          const o = c as { commodity_id?: unknown; name?: unknown }
          return { commodity_id: String(o.commodity_id ?? ''), name: String(o.name ?? '') }
        })
        .filter((c) => c.commodity_id && c.name)
    : []
  const force = body.force === true

  const supabase = createClient()
  const today = todayISO()
  const ids = inputs.map((c) => c.commodity_id)

  // Full commodity rows (marketing-year start, basis adj, weights) + the
  // entered monthly prices for this marketing year.
  const [{ data: ccRows }, { data: monthlyRows }] = await Promise.all([
    supabase.from('covered_commodities').select('*').in('id', ids),
    supabase.from('mya_monthly_prices').select('commodity_id, month, price').in('commodity_id', ids).eq('crop_year', cropYear),
  ])
  const ccById = new Map((ccRows ?? []).map((c) => [c.id as string, c]))
  const monthlyByCommodity = new Map<string, Array<{ month: number; price: number }>>()
  for (const r of monthlyRows ?? []) {
    const list = monthlyByCommodity.get(r.commodity_id as string) ?? []
    list.push({ month: Number(r.month), price: Number(r.price) })
    monthlyByCommodity.set(r.commodity_id as string, list)
  }

  // Every futures symbol any commodity's blend needs (months without a
  // published price), resolved through the usual quote pipeline: today's
  // cache → Barchart → most recent cached.
  const perCommodity = inputs.map((c) => {
    const cc = ccById.get(c.commodity_id)
    const startMonth = Number(cc?.marketing_year_start_month ?? 9)
    const monthly = monthlyByCommodity.get(c.commodity_id) ?? []
    return {
      ...c,
      tradeable: !!commodityToTraded(c.name),
      startMonth,
      monthly,
      basisAdj: cc?.mya_basis_adj != null ? Number(cc.mya_basis_adj) : null,
      weights: Array.isArray(cc?.mya_month_weights) ? (cc!.mya_month_weights as number[]) : null,
      symbols: futuresSymbolsForBlend({
        commodityName: c.name,
        marketingYearStartMonth: startMonth,
        cropYear,
        monthlyPrices: monthly,
      }),
    }
  })
  const symbols = Array.from(new Set(perCommodity.flatMap((c) => c.symbols)))

  const quotes = new Map<string, { price: number; price_date: string }>()
  if (symbols.length > 0) {
    const { data: todaysRows } = await supabase
      .from('market_prices')
      .select('contract_symbol, price, price_date')
      .in('contract_symbol', symbols)
      .eq('price_date', today)
    for (const r of todaysRows ?? []) quotes.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date as string })
  }

  const needFetch = force ? symbols : symbols.filter((s) => !quotes.has(s))
  const apiKey = process.env.BARCHART_API_KEY
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
        quotes.set(sym, { price, price_date })
        marketUpserts.push({ contract_symbol: sym, price, price_date })
      }
      if (marketUpserts.length > 0) {
        await supabase.from('market_prices').upsert(marketUpserts, { onConflict: 'contract_symbol,price_date' })
      }
      if (results.length === 0) note = 'Barchart returned no quotes (market closed or contract not yet listed) — using the most recent cached quotes.'
    } catch (e: any) {
      note = `Could not reach Barchart (${e?.message ?? 'network error'}) — using the most recent cached quotes.`
    }
  } else if (needFetch.length > 0 && !apiKey) {
    note = 'BARCHART_API_KEY is not configured — using cached quotes and published months only.'
  }

  // Fall back to the most recent cached price for any symbol still missing.
  const stillMissing = symbols.filter((s) => !quotes.has(s))
  if (stillMissing.length > 0) {
    const { data: recent } = await supabase
      .from('market_prices')
      .select('contract_symbol, price, price_date')
      .in('contract_symbol', stillMissing)
      .order('price_date', { ascending: false })
    for (const r of recent ?? []) {
      if (!quotes.has(r.contract_symbol)) quotes.set(r.contract_symbol, { price: Number(r.price), price_date: r.price_date as string })
    }
  }

  // Blend per commodity and persist the estimate (without clobbering a manual
  // override or a finalized MYA).
  const estimates: Estimate[] = []
  for (const c of perCommodity) {
    const blend = estimateMyaBlend({
      commodityName: c.name,
      marketingYearStartMonth: c.startMonth,
      cropYear,
      monthlyPrices: c.monthly,
      futuresPriceForSymbol: (sym) => quotes.get(sym)?.price ?? null,
      basisAdj: c.basisAdj,
      weights: c.weights,
    })
    const usedQuoteDates = blend.months
      .filter((m) => m.source === 'futures' && m.symbol)
      .map((m) => quotes.get(m.symbol!)?.price_date)
      .filter((d): d is string => !!d)
    const priceDate = usedQuoteDates.length ? usedQuoteDates.reduce((a, b) => (a > b ? a : b)) : null
    estimates.push({
      commodity_id: c.commodity_id,
      name: c.name,
      price: blend.estimate,
      price_date: priceDate,
      stale: usedQuoteDates.some((d) => d < today),
      tradeable: c.tradeable,
      composition: {
        publishedCount: blend.publishedCount,
        futuresCount: blend.futuresCount,
        missingCount: blend.missingCount,
        basisAdj: blend.basisAdj,
        months: blend.months,
      },
    })

    if (blend.estimate != null) {
      const { data: existing } = await supabase
        .from('arc_plc_price_data')
        .select('id, source, mya_price_final')
        .eq('commodity_id', c.commodity_id)
        .eq('crop_year', cropYear)
        .maybeSingle()
      const stamp = new Date().toISOString()
      if (!existing) {
        await supabase.from('arc_plc_price_data').insert({
          commodity_id: c.commodity_id, crop_year: cropYear,
          mya_price_estimate: blend.estimate, source: 'barchart', updated_at: stamp,
        })
      } else if ((existing as { source: string }).source !== 'manual') {
        await supabase
          .from('arc_plc_price_data')
          .update({ mya_price_estimate: blend.estimate, source: 'barchart', updated_at: stamp })
          .eq('id', (existing as { id: string }).id)
      }
    }
  }

  const priceDate = estimates.reduce<string | null>((max, p) => (p.price_date && (!max || p.price_date > max) ? p.price_date : max), null)
  return NextResponse.json({ priceDate, estimates, note })
}
