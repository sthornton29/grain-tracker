// GET /api/farm-link/v1/insurance — see docs/FARM_LINK_API.md. Scope
// insurance:read (088). The crop insurance premiums Grain already allocates by
// entity and crop, so Turnrow Farm's cost per acre does not ask for them a
// second time. One row per entity x crop x practice for the crop year, summed
// from the policies and their riders (lib/farm-link-outbound.ts — the same
// premium and projected-indemnity engine the Claims Monitor and the income
// pull use; nothing is recomputed here). Paging, ?since=, and the sync log
// follow the production route exactly.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, loadIdMap, requireIntParam } from '@/lib/farm-link-server'
import { decodeCursor, pageRecords, parseLimit, validateSince } from '@/lib/farm-link'
import { loadInsurancePayload } from '@/lib/farm-link-outbound'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'insurance:read')
  if (denied) return denied
  const year = requireIntParam(req, 'crop_year')
  if (year instanceof NextResponse) return year
  if (year == null) return NextResponse.json({ error: 'A valid ?crop_year= is required.' }, { status: 400 })
  const since = validateSince(req.nextUrl.searchParams.get('since'))
  if (since.error) return NextResponse.json({ error: since.error }, { status: 400 })
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'))
  const cursor = decodeCursor(req.nextUrl.searchParams.get('cursor'))
  if (req.nextUrl.searchParams.get('cursor') && !cursor) return NextResponse.json({ error: 'cursor is not valid.' }, { status: 400 })
  try {
    const idMap = await loadIdMap(supabase, ctx.org)
    const all = await loadInsurancePayload(supabase, ctx.org, year as number, idMap)
    // Tombstones answer "remove this row" on a delta pull only; a full pull is
    // the current picture, and rows that no longer exist simply are not in it.
    const records = since.since ? all : all.filter((r) => !r.deleted)
    const page = pageRecords(records, { limit, cursor, since: since.since })
    const deleted = page.data.filter((r) => r.deleted).length
    // `rows` is this endpoint's contract with Turnrow Farm; `data` is the same
    // array under the name the other four pulls use, so a generic pager on the
    // Farm side works against this route unchanged.
    const res = NextResponse.json({ crop_year: year, generated_at: new Date().toISOString(), rows: page.data, data: page.data, next_cursor: page.next_cursor })
    return finish(supabase, ctx, res, {
      endpoint: 'insurance', method: 'GET',
      counts: { records: records.length, served: page.data.length, deleted },
      direction: cursor ? undefined : 'outbound', sync: { count: records.length },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
