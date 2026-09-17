// GET /api/farm-link/v1/land/snapshot?season_years=2025,2026 — everything Grain
// holds for the land tables so Turnrow Farm can match before it writes:
// entities, landowners, farms, fields, crops, plantings (for the requested
// season years; all years when omitted), each with updated_at and the farm_uid
// from the id map when already linked. Archived rows are omitted.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, loadLandState } from '@/lib/farm-link-server'
import { buildLandSnapshot } from '@/lib/farm-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'land:write')
  if (denied) return denied
  const raw = req.nextUrl.searchParams.get('season_years') ?? req.nextUrl.searchParams.get('season_year')
  const years = raw ? raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n)) : null
  try {
    const state = await loadLandState(supabase, ctx.org)
    const snapshot = buildLandSnapshot(state, years)
    const counts = {
      entities: snapshot.entities.length, landowners: snapshot.landowners.length, farms: snapshot.farms.length,
      fields: snapshot.fields.length, crops: snapshot.crops.length, field_plantings: snapshot.field_plantings.length,
    }
    const res = NextResponse.json({ data: snapshot, season_years: years, generated_at: new Date().toISOString() })
    return finish(supabase, ctx, res, { endpoint: 'land/snapshot', method: 'GET', counts })
  } catch (e) {
    return errorResponse(e)
  }
}
