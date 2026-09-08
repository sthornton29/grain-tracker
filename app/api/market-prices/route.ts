import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveQuotes } from '@/lib/quote-resolution'

export const runtime = 'nodejs'
export const maxDuration = 30

// The pages' quote endpoint. All ordering lives in lib/quote-resolution.ts
// (live day-cache → Barchart → most recent live → the org's MANUAL quote →
// none); this route only parses the request and hands back the rows, each
// carrying its `source` so a manual price is never shown as market data.
// The session client scopes manual_market_quotes to the caller's org by RLS.
export async function POST(req: NextRequest) {
  let body: { symbols?: unknown; force?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const symbols = Array.isArray(body.symbols)
    ? body.symbols.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : []
  const supabase = createClient()
  const { prices, priceDate, note } = await resolveQuotes({ supabase, symbols, force: body.force === true })
  return NextResponse.json({ priceDate, prices, note })
}
