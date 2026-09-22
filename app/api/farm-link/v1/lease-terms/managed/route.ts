// POST /api/farm-link/v1/lease-terms/managed {grain_id, farm_lease_uid} — see
// docs/FARM_LINK_API.md. Scope landowners:write (089).
//
// Marks a lease as managed in Turnrow Farm: read-only in Grain's UI from then
// on, with a link to the lease over there, and no longer offered as a proposal
// by GET /lease-terms.

import { NextRequest, NextResponse } from 'next/server'
import {
  createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope,
  farmLinkRateLimited, rateLimitedResponse, finish, readJson,
} from '@/lib/farm-link-server'

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
  const farmLeaseUid = typeof body.farm_lease_uid === 'string' ? body.farm_lease_uid.trim() : ''
  if (!grainId || !farmLeaseUid) {
    return NextResponse.json({ error: 'grain_id and farm_lease_uid are required.' }, { status: 400 })
  }

  try {
    const { data, error } = await supabase
      .from('lease_terms')
      .update({ managed_by: 'turnrow_farm', farm_lease_uid: farmLeaseUid })
      .eq('id', grainId)
      .eq('org_id', ctx.org)
      .select('id')
    if (error) {
      if (/managed_by|farm_lease_uid/.test(error.message)) {
        return NextResponse.json(
          { error: 'Turnrow Grain needs a database update before leases can be managed in Turnrow Farm.', code: 'needs_migration' },
          { status: 500 },
        )
      }
      throw new Error(error.message)
    }
    if (!data || data.length === 0) {
      const res = NextResponse.json({ error: 'That lease is not in this organization.', code: 'not_found' }, { status: 404 })
      return finish(supabase, ctx, res, { endpoint: 'lease-terms/managed', method: 'POST' })
    }
    const res = NextResponse.json({ grain_id: grainId, farm_lease_uid: farmLeaseUid, action: 'managed' })
    return finish(supabase, ctx, res, { endpoint: 'lease-terms/managed', method: 'POST', counts: { managed: 1 }, direction: 'inbound' })
  } catch (e) {
    return errorResponse(e)
  }
}
