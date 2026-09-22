// POST /api/farm-link/v1/landowners/archive {grain_id} — see
// docs/FARM_LINK_API.md. Scope landowners:write (089).
//
// Archives the landowner (Grain archives, never deletes, exactly as the land
// sync does). Refuses when they hold an active Turnrow Landowner share, or
// when they have a rent settlement in an open crop year: archiving someone
// Stuart is still settling with would drop them out of the Rent Settlement
// report mid-season.

import { NextRequest, NextResponse } from 'next/server'
import {
  createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope,
  farmLinkRateLimited, rateLimitedResponse, finish, readJson,
  loadLandowners, loadActiveShareLandownerIds, loadSettlementYearsByLandowner, applyLandownerOps,
} from '@/lib/farm-link-server'
import { openSettlementFromYear, planLandownerArchive } from '@/lib/farm-link-landowners'

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
  const grainId = typeof body.grain_id === 'string' ? body.grain_id.trim() : ''
  if (!grainId) return NextResponse.json({ error: 'grain_id is required.' }, { status: 400 })

  try {
    const [landowners, activeShares, settlementYears] = await Promise.all([
      loadLandowners(supabase, ctx.org),
      loadActiveShareLandownerIds(supabase, ctx.org),
      loadSettlementYearsByLandowner(supabase, ctx.org),
    ])
    const verdict = planLandownerArchive({
      grainId, landowners,
      activeShareLandownerIds: activeShares,
      settlementYearsByLandowner: settlementYears,
      openFromYear: openSettlementFromYear(),
    })
    if (!verdict.ok) {
      const res = NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status })
      return finish(supabase, ctx, res, { endpoint: 'landowners/archive', method: 'POST' })
    }
    await applyLandownerOps(supabase, ctx.org, verdict.ops)
    const res = NextResponse.json({ grain_id: grainId, action: 'archived' })
    return finish(supabase, ctx, res, { endpoint: 'landowners/archive', method: 'POST', counts: { archived: 1 }, direction: 'inbound' })
  } catch (e) {
    return errorResponse(e)
  }
}
