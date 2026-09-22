// POST /api/farm-link/v1/landowners/merge {survivor_grain_id, merged_grain_id,
// move_share?} — see docs/FARM_LINK_API.md. Scope landowners:write (089).
//
// Moves farms, partner shares (only with move_share), lease_terms,
// rent_settlements, and landowner_settlements to the survivor, then sets
// merged_into_id and archived_at on the other. One transaction. Refuses when
// the merged landowner has an active Turnrow Landowner share unless
// move_share: true — silently moving someone's live share is not a merge, it
// is a surprise.

import { NextRequest, NextResponse } from 'next/server'
import {
  createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope,
  farmLinkRateLimited, rateLimitedResponse, finish, readJson,
  loadLandowners, loadActiveShareLandownerIds, applyLandownerOps,
} from '@/lib/farm-link-server'
import { planLandownerMerge } from '@/lib/farm-link-landowners'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  const survivorId = typeof body.survivor_grain_id === 'string' ? body.survivor_grain_id.trim() : ''
  const mergedId = typeof body.merged_grain_id === 'string' ? body.merged_grain_id.trim() : ''
  if (!survivorId || !mergedId) {
    return NextResponse.json({ error: 'survivor_grain_id and merged_grain_id are required.' }, { status: 400 })
  }

  try {
    const [landowners, activeShares] = await Promise.all([
      loadLandowners(supabase, ctx.org),
      loadActiveShareLandownerIds(supabase, ctx.org),
    ])
    const verdict = planLandownerMerge({
      survivorId, mergedId, landowners,
      activeShareLandownerIds: activeShares,
      moveShare: body.move_share === true,
    })
    if (!verdict.ok) {
      const res = NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status })
      return finish(supabase, ctx, res, { endpoint: 'landowners/merge', method: 'POST' })
    }
    const { counts } = await applyLandownerOps(supabase, ctx.org, verdict.ops)
    const moved = {
      farms: counts.farms ?? 0,
      lease_terms: counts.lease_terms ?? 0,
      rent_settlements: counts.rent_settlements ?? 0,
      landowner_settlements: counts.landowner_settlements ?? 0,
      partner_shares: counts.partner_shares ?? 0,
    }
    const res = NextResponse.json({
      survivor_grain_id: survivorId, merged_grain_id: mergedId, moved,
    })
    return finish(supabase, ctx, res, { endpoint: 'landowners/merge', method: 'POST', counts: moved, direction: 'inbound' })
  } catch (e) {
    return errorResponse(e)
  }
}
