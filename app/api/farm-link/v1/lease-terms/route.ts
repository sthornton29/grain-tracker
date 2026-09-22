// GET /api/farm-link/v1/lease-terms?since= — see docs/FARM_LINK_API.md. Scope
// landowners:write (089).
//
// Every lease_terms row Turnrow Farm has NOT yet adopted, as PROPOSALS: Farm
// reads these once, builds the lease over there, and then calls
// POST /lease-terms/managed, after which Grain shows the row read-only and
// stops offering it. Terms go out exactly as Grain stores them (share,
// expense, pricing, cash, flex json), with the uploaded lease document as a
// SHORT-LIVED signed URL — the link never hands out a durable link to a file.

import { NextRequest, NextResponse } from 'next/server'
import {
  createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope,
  farmLinkRateLimited, rateLimitedResponse, finish, loadIdMap,
  loadLandowners, loadLeaseTerms, signLeaseDocuments,
} from '@/lib/farm-link-server'
import { decodeCursor, pageRecords, parseLimit, validateSince } from '@/lib/farm-link'
import { shapeLeaseTermRecords } from '@/lib/farm-link-landowners'

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
    const [idMap, leases, landowners] = await Promise.all([
      loadIdMap(supabase, ctx.org),
      loadLeaseTerms(supabase, ctx.org),
      loadLandowners(supabase, ctx.org),
    ])
    const unmanaged = leases.filter((l) => l.managed_by !== 'turnrow_farm')
    const signed = await signLeaseDocuments(supabase, unmanaged.map((l) => l.source_file_path ?? '').filter(Boolean))
    const records = shapeLeaseTermRecords({
      leases,
      landowners,
      farmUidFor: (table, id) => idMap.farmUid(table, id),
      signedUrlFor: (path) => (path ? signed.get(path) ?? null : null),
      asOf: new Date().toISOString(),
    })
    const page = pageRecords(records, { limit, cursor, since: since.since })
    const res = NextResponse.json({
      data: page.data, rows: page.data, next_cursor: page.next_cursor, generated_at: new Date().toISOString(),
    })
    return finish(supabase, ctx, res, {
      endpoint: 'lease-terms', method: 'GET',
      counts: { records: records.length, served: page.data.length },
      direction: cursor ? undefined : 'outbound', sync: { count: records.length },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
