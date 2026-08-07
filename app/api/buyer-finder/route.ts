// POST /api/buyer-finder — AI web-search for grain buyers and delivery points
// near a zip code, tailored to the org's crops. Confirm-before-save: this
// route never writes anything — Settings → Buyers shows the results as a
// checklist and only ticked entries are created, through the same insert path
// as manual adds. Session required; per-user rate limit protects spend.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiWebSearchJson, AiLookupError } from '@/lib/ai-web-search'
import { parseBuyerFinderRequest, normalizeBuyerFinderResult } from '@/lib/ai-lookups'

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

// Buyer types worth asking for, keyed off the org's crop names.
function buyerTypeGuidance(crops: string[]): string {
  const has = (re: RegExp) => crops.some((c) => re.test(c))
  const lines: string[] = []
  if (has(/corn|sorghum|milo|wheat|soy|bean|oat|barley/i)) {
    lines.push('- Grain elevators, river/rail terminals, and feed mills that buy grain from farmers')
  }
  if (has(/corn/i)) lines.push('- Ethanol plants that buy corn directly from farmers')
  if (has(/soy/i)) lines.push('- Soybean processors/crush plants')
  if (has(/cotton/i)) lines.push('- Cotton gins, cotton merchants/buyers, and cotton warehouses')
  if (has(/canola/i)) lines.push('- Canola crushers/processors')
  if (lines.length === 0) lines.push('- Grain elevators and crop buyers that purchase from farmers')
  return lines.join('\n')
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 })
  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: 'You’ve run several searches in a row — give it a little while and try again.' },
      { status: 429 },
    )
  }

  const body = await req.json().catch(() => null)
  const parsed = parseBuyerFinderRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { zip, radiusMiles, crops } = parsed.value

  const prompt = `Find grain buyers and crop delivery points within about ${radiusMiles} miles of US zip code ${zip} that a farmer could sell or deliver these crops to: ${crops.join(', ')}.

Look for:
${buyerTypeGuidance(crops)}

Search for real, currently-operating businesses (company sites, USDA/state licensed-warehouse and grain-dealer lists, co-op location pages, local directories). Rural areas may genuinely have only a handful — return what you actually find, and NEVER invent or pad the list with businesses you are not confident exist. Skip brokers with no physical delivery point unless they are a well-known crop merchant.

For each result:
- name: the business name farmers know it by (e.g. "Tennessee Valley Co-op", not a parent holding company)
- location: the city/town of the delivery point
- address: street address if found, else null
- buyer_type: one of elevator, river terminal, rail terminal, feed mill, ethanol plant, soybean processor, cotton gin, cotton merchant, cotton warehouse, canola crusher, other
- crops: which of the farmer's crops it likely handles
- distance_miles: rough road distance from ${zip}, or null
- confidence: "high" only if you found a current, direct source (the business's own site or an official directory); otherwise "low"

Respond ONLY with JSON, no other text, no markdown fences:
{"results": [{"name": "...", "location": "..." or null, "address": "..." or null, "buyer_type": "...", "crops": ["..."], "distance_miles": number or null, "confidence": "high" or "low"}], "source_description": "one sentence on where these came from"}`

  try {
    const raw = await aiWebSearchJson({
      prompt,
      cacheKey: `buyer-finder|${zip}|${radiusMiles}|${[...crops].sort().join(',').toLowerCase()}`,
      cacheTtlMs: 6 * 60 * 60 * 1000,
      maxSearches: 8,
      maxTokens: 3072,
    })
    return NextResponse.json({ data: normalizeBuyerFinderResult(raw) })
  } catch (e) {
    if (e instanceof AiLookupError) {
      const msg = e.kind === 'parse'
        ? 'The search came back in a form we couldn’t read — try again, or add your buyers manually below.'
        : e.message
      return NextResponse.json({ error: msg }, { status: 500 })
    }
    throw e
  }
}
