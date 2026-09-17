// GET /api/farm-link/v1/production — see docs/FARM_LINK_API.md. Scope production:read.
// The same numbers Grain's own pages show (lib/farm-link-outbound.ts re-keys
// the existing engines; nothing is recomputed). Cursor paging on
// (updated_at, id); every record carries the Farm uuids from the id map.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, loadIdMap, requireIntParam } from '@/lib/farm-link-server'
import { decodeCursor, pageRecords, parseLimit, validateSince } from '@/lib/farm-link'
import { loadProductionPayload } from '@/lib/farm-link-outbound'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'production:read')
  if (denied) return denied
  const seasonYear = requireIntParam(req, 'season_year', { optional: true })
  if (seasonYear instanceof NextResponse) return seasonYear
  const year = seasonYear ?? requireIntParam(req, 'crop_year')
  if (year instanceof NextResponse) return year
  if (year == null) return NextResponse.json({ error: 'A valid ?season_year= (or ?crop_year=) is required.' }, { status: 400 })
  const since = validateSince(req.nextUrl.searchParams.get('since'))
  if (since.error) return NextResponse.json({ error: since.error }, { status: 400 })
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'))
  const cursor = decodeCursor(req.nextUrl.searchParams.get('cursor'))
  if (req.nextUrl.searchParams.get('cursor') && !cursor) return NextResponse.json({ error: 'cursor is not valid.' }, { status: 400 })
  try {
    const idMap = await loadIdMap(supabase, ctx.org)
    const records = await loadProductionPayload(supabase, ctx.org, year as number, idMap)
    const page = pageRecords(records, { limit, cursor, since: since.since })
    const res = NextResponse.json({ data: page.data, next_cursor: page.next_cursor, crop_year: year, generated_at: new Date().toISOString() })
    return finish(supabase, ctx, res, { endpoint: 'production', method: 'GET', counts: { records: records.length, served: page.data.length }, direction: cursor ? undefined : 'outbound', sync: { count: records.length } })
  } catch (e) {
    return errorResponse(e)
  }
}
