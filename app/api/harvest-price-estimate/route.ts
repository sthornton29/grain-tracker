import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { harvestContractSymbol, harvestContractLabel } from '@/lib/crop-insurance'
import { resolveQuotes } from '@/lib/quote-resolution'

export const runtime = 'nodejs'
export const maxDuration = 30

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
  source: 'live' | 'manual' | null // manual = typed by the org (no live coverage)
  entered_at: string | null
}

type CropInput = { crop_id: string; crop_name: string }

function todayISO(): string {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
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

  // THE quote seam (lib/quote-resolution): live day-cache → Barchart → most
  // recent live → the org's MANUAL quote → none. Each estimate carries its
  // `source` so a manual cotton price is labeled downstream.
  const { prices, note } = await resolveQuotes({ supabase, symbols, force, today })
  const bySymbol = new Map(prices.map((p) => [p.symbol, p]))

  // Mirror today's LIVE quotes into harvest_price_estimates for history (the
  // resolvers read them as 'Barchart estimate'); manual quotes are the org's
  // own and are not written as market history.
  const estimateUpserts = withSymbol
    .map((c) => {
      const hit = bySymbol.get(c.symbol)
      if (!hit || hit.price == null || hit.source !== 'live' || hit.price_date !== today) return null
      return { crop_id: c.crop_id, crop_year: cropYear, price_type: 'harvest_estimate' as const, price: hit.price, source: 'Barchart estimate', price_date: hit.price_date }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
  if (estimateUpserts.length > 0) {
    await supabase.from('harvest_price_estimates').upsert(estimateUpserts, { onConflict: 'crop_id,crop_year,price_type,price_date' })
  }

  const estimates: Estimate[] = withSymbol.map((c) => {
    const hit = bySymbol.get(c.symbol)
    if (!hit || hit.price == null) return { crop_id: c.crop_id, symbol: c.symbol, label: c.label, price: null, price_date: null, stale: true, source: null, entered_at: null }
    return { crop_id: c.crop_id, symbol: c.symbol, label: c.label, price: hit.price, price_date: hit.price_date, stale: hit.stale, source: hit.source ?? 'live', entered_at: hit.entered_at ?? null }
  })

  const priceDate = estimates.reduce<string | null>(
    (max, p) => (p.price_date && (!max || p.price_date > max) ? p.price_date : max),
    null,
  )

  return NextResponse.json({ priceDate, estimates, note })
}
