import { NextRequest, NextResponse } from 'next/server'
import { aiWebSearchJson, AiLookupError } from '@/lib/ai-web-search'
import { normalizeAwpResult } from '@/lib/ai-lookups'

export const runtime = 'nodejs'
export const maxDuration = 60

// AI web-search lookup for the CURRENT USDA upland cotton Adjusted World Price
// (announced Thursdays, effective Fri–Thu). Confirm-before-save: this route
// never writes awp_weekly — the Cotton Marketing page shows the result and the
// user confirms. Cached 6 h in-process (one announcement per week).
export async function POST(req: NextRequest) {
  try {
    await req.json().catch(() => ({})) // no inputs needed; tolerate empty body
    const prompt = `Find the CURRENT USDA upland cotton Adjusted World Price (AWP), announced by USDA FSA every Thursday and effective Friday through Thursday. Search fsa.usda.gov and cotton trade press for the latest announcement.

Respond ONLY with JSON, no prose:
{
  "awp_cents_per_lb": <number, e.g. 51.43>,
  "week_effective": "<YYYY-MM-DD of the Friday the price became effective, or null>",
  "source": "<where you found it>",
  "confidence": "high" | "medium" | "low"
}`
    const raw = await aiWebSearchJson({
      prompt,
      cacheKey: 'awp-current',
      cacheTtlMs: 6 * 60 * 60 * 1000,
      maxSearches: 6,
      maxTokens: 2048,
    })
    const data = normalizeAwpResult(raw)
    if (!data) {
      return NextResponse.json({ error: 'The lookup returned an unusable AWP — enter it manually from the FSA announcement.' }, { status: 502 })
    }
    return NextResponse.json({ data })
  } catch (e) {
    if (e instanceof AiLookupError) {
      return NextResponse.json({ error: e.message }, { status: 500 })
    }
    throw e
  }
}
