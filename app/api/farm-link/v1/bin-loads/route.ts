// GET /api/farm-link/v1/bin-loads?crop_year=2026[&bin_id=] — see
// docs/FARM_LINK_API.md. Scope bins:read. Every load delivered INTO a bin in
// the crop year, one record each (lib/farm-link-bin-loads.ts): the ticket,
// the field it came from with the varieties planted there, or the bin it was
// moved from, and the dry bushels. Turnrow Farm drafts its saved seed lots
// from the loads into a seed bin. Cursor paging on (updated_at, id).

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, loadIdMap, requireIntParam } from '@/lib/farm-link-server'
import { decodeCursor, pageRecords, parseLimit, validateSince } from '@/lib/farm-link'
import { loadBinLoadsPayload } from '@/lib/farm-link-bin-loads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const binId = req.nextUrl.searchParams.get('bin_id')
  if (binId && !UUID.test(binId)) return NextResponse.json({ error: '?bin_id= must be a bin uuid (the bins pull\'s bin_id).' }, { status: 400 })
  const since = validateSince(req.nextUrl.searchParams.get('since'))
  if (since.error) return NextResponse.json({ error: since.error }, { status: 400 })
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'))
  const cursor = decodeCursor(req.nextUrl.searchParams.get('cursor'))
  if (req.nextUrl.searchParams.get('cursor') && !cursor) return NextResponse.json({ error: 'cursor is not valid.' }, { status: 400 })
  try {
    const idMap = await loadIdMap(supabase, ctx.org)
    const records = await loadBinLoadsPayload(supabase, ctx.org, year as number, binId, idMap)
    const page = pageRecords(records, { limit, cursor, since: since.since })
    const res = NextResponse.json({ data: page.data, next_cursor: page.next_cursor, crop_year: year, bin_id: binId, generated_at: new Date().toISOString() })
    return finish(supabase, ctx, res, { endpoint: 'bin-loads', method: 'GET', counts: { records: records.length, served: page.data.length }, direction: cursor ? undefined : 'outbound', sync: { count: records.length } })
  } catch (e) {
    return errorResponse(e)
  }
}
