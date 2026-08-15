// GET /api/partner/v1/handshake — who am I and what may I see. Used by
// consumers to re-check scopes and detect farmer-side revocation (which
// returns 403 code 'share_revoked' from the access resolver).

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerAccess,
  sharedFieldIds,
  createServiceClient,
  serviceClientMissingResponse,
  fetchAll,
  errorResponse,
} from '@/lib/partner-api-server'

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
      const fields = await fetchAll<{ id: string }>((f, t) =>
        supabase.from('fields').select('id').eq('org_id', access.org).order('id').range(f, t),
      )
      return NextResponse.json({
        operation_name: operationName,
        landowner_name: null,
        scopes: { fields: true, plantings: true, harvest: true, yields: true },
        field_count: fields.length,
        api_version: 'v1',
      })
    }

    const [{ data: landownerRow }, fieldIds] = await Promise.all([
      supabase.from('landowners').select('name').eq('id', access.share.landownerId).maybeSingle(),
      sharedFieldIds(supabase, access.org, access.share.landownerId),
    ])
    return NextResponse.json({
      operation_name: operationName,
      landowner_name: (landownerRow as { name: string } | null)?.name ?? null,
      scopes: {
        fields: true,
        plantings: true,
        harvest: true,
        yields: access.share.includeYields,
      },
      field_count: fieldIds.size,
      api_version: 'v1',
    })
  } catch (e) {
    return errorResponse(e)
  }
}
