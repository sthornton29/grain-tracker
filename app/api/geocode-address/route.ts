import { NextRequest, NextResponse } from 'next/server'
import { aiWebSearchJson, AiLookupError } from '@/lib/ai-web-search'

export const runtime = 'nodejs'
export const maxDuration = 60

// Geocode a small batch of addresses (bin sites + delivery locations) for the
// Freight Math distance estimates — the AI-web-search lookup pattern (like
// /api/arc-benchmark-lookup): Claude with web search returns approximate
// coordinates for USER CONFIRMATION; nothing is saved here. The client
// computes haversine × 1.25 road miles, shows the estimates, and only after
// the user confirms saves freight_distances rows and caches the coordinates
// back onto bin_sites / delivery_locations (078) so a geocode runs once per
// address. In-process cached per normalized address.

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // addresses don't move

type Target = { key: string; name: string; address: string }

function parseBody(body: unknown): Target[] | null {
  if (typeof body !== 'object' || body == null) return null
  const targets = (body as { targets?: unknown }).targets
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 40) return null
  const out: Target[] = []
  for (const t of targets) {
    if (typeof t !== 'object' || t == null) return null
    const { key, name, address } = t as Record<string, unknown>
    if (typeof key !== 'string' || typeof name !== 'string' || typeof address !== 'string' || !address.trim()) return null
    out.push({ key, name, address: address.trim() })
  }
  return out
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const targets = parseBody(body)
  if (!targets) return NextResponse.json({ error: 'Send { targets: [{ key, name, address }] } (1–40 items).' }, { status: 400 })

  const results: Array<{ key: string; latitude: number | null; longitude: number | null; note: string | null }> = []
  for (const t of targets) {
    const prompt = `Find the approximate geographic coordinates (latitude, longitude in decimal degrees, WGS84) of this U.S. location:

- Name: ${t.name}
- Address: ${t.address}

This is a grain facility (a farm bin site or a grain elevator/delivery point). If the exact street address can't be pinned down, coordinates for the named town/community are acceptable — these feed a ROAD-DISTANCE ESTIMATE, so town-level precision is fine. If you cannot locate it at all, return nulls — never guess a different state.

Respond ONLY with JSON, no other text, no markdown fences:
{"latitude": number or null, "longitude": number or null, "note": "one short sentence on what was matched (town-level vs exact), or why it couldn't be found"}`
    try {
      const raw = await aiWebSearchJson({
        prompt,
        cacheKey: `geocode:${t.address.toLowerCase().replace(/\s+/g, ' ')}`,
        cacheTtlMs: CACHE_TTL_MS,
        maxSearches: 3,
        maxTokens: 400,
      })
      const r = (typeof raw === 'object' && raw != null ? raw : {}) as Record<string, unknown>
      const lat = typeof r.latitude === 'number' && Number.isFinite(r.latitude) && Math.abs(r.latitude) <= 90 ? r.latitude : null
      const lon = typeof r.longitude === 'number' && Number.isFinite(r.longitude) && Math.abs(r.longitude) <= 180 ? r.longitude : null
      results.push({
        key: t.key,
        latitude: lat != null && lon != null ? lat : null,
        longitude: lat != null && lon != null ? lon : null,
        note: typeof r.note === 'string' ? r.note : null,
      })
    } catch (e) {
      if (e instanceof AiLookupError) {
        results.push({ key: t.key, latitude: null, longitude: null, note: e.message })
      } else {
        throw e
      }
    }
  }
  return NextResponse.json({ data: results })
}
