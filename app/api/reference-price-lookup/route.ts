import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiWebSearchJson, AiLookupError } from '@/lib/ai-web-search'

// Reference-price lookup for the Rent Settlement gap interview: when a lease
// names a reference price ("average October cash price at Farmers Elevator"),
// this route asks the web-search AI for a suggested figure. CONFIRM-BEFORE-USE:
// nothing is saved here — the UI shows the suggestion with its source note and
// the operator explicitly accepts (or types their own number) into the gap
// input. A price is never silently invented: low-confidence and not-found
// results say so.

export const runtime = 'nodejs'
export const maxDuration = 60

const RATE_LIMIT = 10 // lookups per user per hour (per server instance)
const rateLog = new Map<string, number[]>()
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const cutoff = now - 60 * 60 * 1000
  const seen = (rateLog.get(userId) ?? []).filter((t) => t > cutoff)
  if (seen.length >= RATE_LIMIT) { rateLog.set(userId, seen); return true }
  seen.push(now)
  rateLog.set(userId, seen)
  return false
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 })
  if (rateLimited(user.id)) {
    return NextResponse.json({ error: 'That’s a lot of price lookups this hour — try again in a bit.' }, { status: 429 })
  }
  const body = (await req.json().catch(() => null)) as { description?: string; crop?: string; crop_year?: number } | null
  const description = typeof body?.description === 'string' ? body.description.slice(0, 300).trim() : ''
  const crop = typeof body?.crop === 'string' ? body.crop.slice(0, 60).trim() : ''
  const cropYear = typeof body?.crop_year === 'number' ? body.crop_year : null
  if (!description || !crop) return NextResponse.json({ error: 'Missing the reference description or crop.' }, { status: 400 })

  try {
    const result = await aiWebSearchJson({
      prompt: `A farm lease prices the landowner's ${crop} share${cropYear ? ` for the ${cropYear} crop year` : ''} using this reference: "${description}".
Find the best figure for that reference price in US dollars per bushel. Prefer the named source itself (an elevator's posted bids, USDA data for the stated period). If the exact source isn't findable, the closest verifiable substitute (nearby elevator bids, USDA state/national average for the stated month) with the substitution stated plainly in source_note.
NEVER invent a number. If nothing verifiable exists, return price null with a source_note explaining what you looked for.
Respond ONLY in JSON, no other text, no markdown fences:
{"price_usd_per_bu": number or null, "as_of": "what period the price covers", "source_note": "where this came from, one sentence", "confidence": "high" | "medium" | "low"}`,
      cacheKey: `reference-price:${crop.toLowerCase()}:${cropYear ?? ''}:${description.toLowerCase()}`,
      cacheTtlMs: 6 * 60 * 60 * 1000,
      maxSearches: 6,
    })
    return NextResponse.json({ data: result })
  } catch (e) {
    const msg = e instanceof AiLookupError ? e.message : 'Lookup failed.'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
