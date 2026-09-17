// POST /api/farm-link/v1/land/link {links: [{grain_table, grain_id, farm_uid}]}
// — writes the id map for matches Turnrow Farm confirmed after reviewing the
// snapshot. A grain_id or farm_uid already mapped elsewhere is rejected (never
// re-pointed silently); the accepted links land in one transaction and every
// linked land row is marked managed_by = 'turnrow_farm'.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, loadLandState, applyOps, readJson } from '@/lib/farm-link-server'
import { validateLinkRequests, LAND_TABLES, type ApplyOp, type GrainLinkTable, type LinkRequest } from '@/lib/farm-link'

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
  const links = Array.isArray(body.links) ? (body.links as LinkRequest[]) : null
  if (!links) return NextResponse.json({ error: 'links must be an array of {grain_table, grain_id, farm_uid}.' }, { status: 400 })
  if (links.length > 2000) return NextResponse.json({ error: 'At most 2,000 links per request.' }, { status: 400 })

  try {
    const state = await loadLandState(supabase, ctx.org)
    const existing = new Map<string, Set<string>>([
      ['entities', new Set(state.entities.map((r) => r.id))],
      ['landowners', new Set(state.landowners.map((r) => r.id))],
      ['farms', new Set(state.farms.map((r) => r.id))],
      ['fields', new Set(state.fields.map((r) => r.id))],
      ['field_plantings', new Set(state.plantings.map((r) => r.id))],
      ['field_planting_varieties', new Set(state.varieties.map((r) => r.id))],
      ['crops', new Set(state.crops.map((r) => r.id))],
    ])
    const verdicts = validateLinkRequests(links, state.idMap, existing)
    const ops: ApplyOp[] = []
    for (const v of verdicts) {
      if (v.action !== 'linked') continue
      ops.push({ op: 'link', grain_table: v.grain_table as GrainLinkTable, grain_id: v.grain_id, farm_uid: v.farm_uid, linked_by: 'match' })
      if ((LAND_TABLES as readonly string[]).includes(v.grain_table)) {
        ops.push({ op: 'update', table: v.grain_table, id: v.grain_id, values: { managed_by: 'turnrow_farm' } })
      }
    }
    await applyOps(supabase, ctx.org, ops)
    const counts = {
      linked: verdicts.filter((v) => v.action === 'linked').length,
      unchanged: verdicts.filter((v) => v.action === 'unchanged').length,
      rejected: verdicts.filter((v) => v.action === 'rejected').length,
    }
    const res = NextResponse.json({ data: verdicts, counts })
    return finish(supabase, ctx, res, { endpoint: 'land/link', method: 'POST', counts })
  } catch (e) {
    return errorResponse(e)
  }
}
