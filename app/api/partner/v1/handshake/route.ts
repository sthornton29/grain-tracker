// GET /api/partner/v1/handshake — who am I and what may I see. Used by
// consumers to re-check scopes and detect farmer-side revocation (which
// returns 403 code 'share_revoked' from the access resolver). Carries the
// share's entity structure: the FARMING entities operating the shared fields
// with each one's shared field count (marketing-agent entities never appear —
// they hold paper, not ground).

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerAccess,
  sharedFieldIds,
  createServiceClient,
  serviceClientMissingResponse,
  fetchAll,
  errorResponse,
} from '@/lib/partner-api-server'
import { loadShareEntities } from '@/lib/partner-marketing-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const access = await resolvePartnerAccess(req, supabase)
  if (access instanceof NextResponse) return access

  try {
    const { data: orgRow } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', access.org)
      .maybeSingle()
    const operationName = (orgRow as { name: string } | null)?.name ?? 'Farm operation'

    if (!access.share) {
      const [fields, entities] = await Promise.all([
        fetchAll<{ id: string }>((f, t) =>
          supabase.from('fields').select('id').eq('org_id', access.org).order('id').range(f, t),
        ),
        loadShareEntities(supabase, access.org, null),
      ])
      return NextResponse.json({
        operation_name: operationName,
        landowner_name: null,
        scopes: {
          fields: true,
          plantings: true,
          harvest: true,
          yields: true,
          projected_prices: true,
          projected_yields: true,
        },
        field_count: fields.length,
        entities,
        api_version: 'v1',
      })
    }

    const [{ data: landownerRow }, fieldIds] = await Promise.all([
      supabase.from('landowners').select('name').eq('id', access.share.landownerId).maybeSingle(),
      sharedFieldIds(supabase, access.org, access.share.landownerId),
    ])
    const entities = await loadShareEntities(supabase, access.org, fieldIds)
    return NextResponse.json({
      operation_name: operationName,
      landowner_name: (landownerRow as { name: string } | null)?.name ?? null,
      scopes: {
        fields: true,
        plantings: true,
        harvest: true,
        yields: access.share.includeYields,
        projected_prices: access.share.sharesProjectedPrices,
        projected_yields: access.share.sharesProjectedYields,
      },
      field_count: fieldIds.size,
      entities,
      api_version: 'v1',
    })
  } catch (e) {
    return errorResponse(e)
  }
}
