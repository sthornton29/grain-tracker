// GET /api/farm-link/v1/bins — see docs/FARM_LINK_API.md. Scope bins:read.
// The same numbers Grain's own pages show (lib/farm-link-outbound.ts re-keys
// the existing engines; nothing is recomputed). Cursor paging on
// (updated_at, id); every record carries the Farm uuids from the id map.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, loadIdMap, requireIntParam } from '@/lib/farm-link-server'
import { decodeCursor, pageRecords, parseLimit, validateSince } from '@/lib/farm-link'
import { loadBinsPayload } from '@/lib/farm-link-outbound'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'bins:read')
  if (denied) return denied
  const year = requireIntParam(req, 'crop_year')
  if (year instanceof NextResponse) return year
  const asOfRaw = req.nextUrl.searchParams.get('as_of')
  if (asOfRaw && !/^\d{4}-\d{2}-\d{2}/.test(asOfRaw)) return NextResponse.json({ error: '?as_of= must be an ISO date (e.g. 2026-09-17).' }, { status: 400 })
  const asOf = asOfRaw ? new Date(asOfRaw).toISOString() : new Date().toISOString()
  const since = validateSince(req.nextUrl.searchParams.get('since'))
  if (since.error) return NextResponse.json({ error: since.error }, { status: 400 })
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'))
  const cursor = decodeCursor(req.nextUrl.searchParams.get('cursor'))
  if (req.nextUrl.searchParams.get('cursor') && !cursor) return NextResponse.json({ error: 'cursor is not valid.' }, { status: 400 })
  try {
    const idMap = await loadIdMap(supabase, ctx.org)
    const records = await loadBinsPayload(supabase, ctx.org, year as number, asOf, idMap)
    const page = pageRecords(records, { limit, cursor, since: since.since })
    const res = NextResponse.json({ data: page.data, next_cursor: page.next_cursor, crop_year: year, as_of: asOf, generated_at: new Date().toISOString() })
    return finish(supabase, ctx, res, { endpoint: 'bins', method: 'GET', counts: { records: records.length, served: page.data.length }, direction: cursor ? undefined : 'outbound', sync: { count: records.length } })
  } catch (e) {
    return errorResponse(e)
  }
}
