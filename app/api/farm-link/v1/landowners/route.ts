// GET /api/farm-link/v1/landowners — see docs/FARM_LINK_API.md. Scope
// landowners:write (089; one scope covers the pull and the writes, because a
// landowner is shared BOTH ways and reading without writing has no use).
//
// Every landowner in the organization, archived and merged rows included, with
// the shared fields, the Farm uid from the id map, read-only facts about the
// landowner's Turnrow Landowner share, and — since ?since= — Grain's own
// per-field changes, so the Farm side can merge field by field instead of
// clobbering a row. A change the link itself wrote is never listed.

import { NextRequest, NextResponse } from 'next/server'
import {
  createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope,
  farmLinkRateLimited, rateLimitedResponse, finish, loadIdMap,
  loadLandowners, loadLandownerChanges, loadShareFacts, trimLandownerChanges,
} from '@/lib/farm-link-server'
import { decodeCursor, pageRecords, parseLimit, validateSince } from '@/lib/farm-link'
import { shapeLandownerRecords } from '@/lib/farm-link-landowners'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'landowners:write')
  if (denied) return denied
  const since = validateSince(req.nextUrl.searchParams.get('since'))
  if (since.error) return NextResponse.json({ error: since.error }, { status: 400 })
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'))
  const cursor = decodeCursor(req.nextUrl.searchParams.get('cursor'))
  if (req.nextUrl.searchParams.get('cursor') && !cursor) return NextResponse.json({ error: 'cursor is not valid.' }, { status: 400 })
  try {
    const [idMap, landowners, changes, shares] = await Promise.all([
      loadIdMap(supabase, ctx.org),
      loadLandowners(supabase, ctx.org),
      loadLandownerChanges(supabase, ctx.org, since.since),
      loadShareFacts(supabase, ctx.org),
    ])
    const records = shapeLandownerRecords({
      landowners,
      farmUidFor: (id) => idMap.farmUid('landowners', id),
      shares,
      changes,
      asOf: new Date().toISOString(),
    })
    const page = pageRecords(records, { limit, cursor, since: since.since })
    void trimLandownerChanges(supabase)
    const res = NextResponse.json({
      data: page.data, rows: page.data, next_cursor: page.next_cursor, generated_at: new Date().toISOString(),
    })
    return finish(supabase, ctx, res, {
      endpoint: 'landowners', method: 'GET',
      counts: { records: records.length, served: page.data.length, changes: changes.length },
      direction: cursor ? undefined : 'outbound', sync: { count: records.length },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
