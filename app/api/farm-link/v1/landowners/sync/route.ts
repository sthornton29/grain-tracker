// POST /api/farm-link/v1/landowners/sync — see docs/FARM_LINK_API.md. Scope
// landowners:write (089).
//
// {rows: [{farm_uid, grain_id?, fields: {...}, base: {field: synced_at},
//          create?}]}
//
// The FIELD-LEVEL merge. Each field applies unless Grain's own change log
// shows a change to that field after the base Farm sends AND to a different
// value; those fields come back as conflicts carrying Grain's value and when
// it changed, and every other field in the row still applies. A row with no
// grain_id and no id map entry is created only when create: true is set (the
// Farm side has already run its duplicate search); otherwise it answers
// unmatched with Grain's closest names so Farm can offer a link.
//
// Everything this route writes is stamped changed_by 'turnrow_farm' inside
// farm_link_landowner_apply, so a Farm write never echoes back as a Grain
// edit on the next pull. One transaction per batch.

import { NextRequest, NextResponse } from 'next/server'
import {
  createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope,
  farmLinkRateLimited, rateLimitedResponse, finish, readJson, loadIdMap,
  loadLandowners, loadLandownerChanges, applyLandownerOps,
} from '@/lib/farm-link-server'
import { planLandownerSync, LANDOWNER_SYNC_MAX, type LandownerSyncRow } from '@/lib/farm-link-landowners'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'landowners:write')
  if (denied) return denied
  const body = await readJson(req)
  if (body instanceof NextResponse) return body
  const rows = Array.isArray(body.rows) ? (body.rows as LandownerSyncRow[]) : null
  if (!rows) return NextResponse.json({ error: 'rows must be an array.' }, { status: 400 })
  if (rows.length > LANDOWNER_SYNC_MAX) {
    return NextResponse.json({ error: `At most ${LANDOWNER_SYNC_MAX} landowners per request.` }, { status: 400 })
  }

  try {
    const [idMap, landowners, changes] = await Promise.all([
      loadIdMap(supabase, ctx.org),
      loadLandowners(supabase, ctx.org),
      // The whole log: a conflict is judged against the base Farm sends per
      // field, which can be older than any window this route could pick.
      loadLandownerChanges(supabase, ctx.org, null),
    ])
    const plan = planLandownerSync({
      rows,
      landowners,
      changes,
      grainIdFor: (uid) => idMap.grainId('landowners', uid),
      farmUidFor: (id) => idMap.farmUid('landowners', id),
    })
    await applyLandownerOps(supabase, ctx.org, plan.ops)
    const counts = plan.counts
    const res = NextResponse.json({ data: plan.results, counts })
    return finish(supabase, ctx, res, {
      endpoint: 'landowners/sync', method: 'POST', counts, direction: 'inbound',
      sync: { conflicts: counts.conflict, unmatched: counts.unmatched },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
