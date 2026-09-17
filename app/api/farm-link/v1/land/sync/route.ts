// POST /api/farm-link/v1/land/sync {entities, landowners, crops, farms, fields,
// plantings, deletions} — idempotent upserts keyed on farm_uid through the id
// map (create when unmapped, update when mapped), planned in dependency order
// by lib/farm-link.ts planLandSync and applied in ONE transaction per batch
// (farm_link_apply). Up to 500 records per batch. Deletions arrive as archive
// requests; Grain refuses to archive a field or planting that carries loads,
// yields, or settlements. Conflict rule: an unmanaged Grain row edited since
// the last sync comes back as a conflict with Grain's values (force: true on
// the record overrides); once managed_by is set, Farm's values win.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, loadLandState, applyOps, readJson } from '@/lib/farm-link-server'
import { SYNC_BATCH_MAX, countBatchRecords, planLandSync, resolveCreatedIds, type SyncBatch } from '@/lib/farm-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'land:write')
  if (denied) return denied
  const body = await readJson(req)
  if (body instanceof NextResponse) return body
  const batch = body as SyncBatch
  for (const k of ['entities', 'landowners', 'crops', 'farms', 'fields', 'plantings', 'deletions'] as const) {
    if (batch[k] != null && !Array.isArray(batch[k])) return NextResponse.json({ error: `${k} must be an array.` }, { status: 400 })
  }
  const total = countBatchRecords(batch)
  if (total === 0) return NextResponse.json({ error: 'Nothing to sync — send at least one record.' }, { status: 400 })
  if (total > SYNC_BATCH_MAX) return NextResponse.json({ error: `At most ${SYNC_BATCH_MAX} records per batch (got ${total}).` }, { status: 400 })

  try {
    const state = await loadLandState(supabase, ctx.org)
    const lastSyncAt = ctx.link.last_sync?.inbound?.at ?? null
    const plan = planLandSync(batch, state, { lastSyncAt })
    let refs: Record<string, string> = {}
    try {
      refs = await applyOps(supabase, ctx.org, plan.ops)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'apply failed'
      const res = NextResponse.json({ error: `The batch was rolled back: ${message}`, code: 'batch_rolled_back', results: plan.results }, { status: 409 })
      return finish(supabase, ctx, res, { endpoint: 'land/sync', method: 'POST', counts: { ...plan.counts, records: total, rolled_back: 1 } })
    }
    const results = resolveCreatedIds(plan.results, refs)
    const counts = { ...plan.counts, records: total }
    const res = NextResponse.json({ data: results, counts, synced_at: new Date().toISOString() })
    return finish(supabase, ctx, res, {
      endpoint: 'land/sync', method: 'POST', counts, direction: 'inbound',
      sync: { conflicts: plan.counts.conflict, refused: plan.counts.refused },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
