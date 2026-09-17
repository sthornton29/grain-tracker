// GET /api/farm-link/v1/status — who am I: the link's organization, scopes,
// and last sync per direction. Turnrow Farm re-checks scopes here rather than
// caching authorization (scope toggles apply on the next call).

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, farmLinkRateLimited, rateLimitedResponse, finish } from '@/lib/farm-link-server'
import { landManagedByFarm, normalizeScopes } from '@/lib/farm-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  try {
    const { data: orgRow } = await supabase.from('organizations').select('name').eq('id', ctx.org).maybeSingle()
    const res = NextResponse.json({
      grain_org_id: ctx.org,
      grain_org_name: (orgRow as { name: string } | null)?.name ?? null,
      farm_org_id: ctx.link.farm_org_id,
      farm_org_name: ctx.link.farm_org_name,
      status: ctx.link.status,
      scopes: normalizeScopes(ctx.link.scopes),
      land_managed_in_farm: landManagedByFarm(ctx.link),
      last_sync: ctx.link.last_sync ?? {},
      api_version: 'v1',
    })
    return finish(supabase, ctx, res, { endpoint: 'status', method: 'GET' })
  } catch (e) {
    return errorResponse(e)
  }
}
