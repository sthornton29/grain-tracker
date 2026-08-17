// GET /api/partner/v1/projected-yields?year= — pre-harvest projected yield
// per shared field × crop (072 lease-projection scope; distinct from the
// include_yields opt-in, which covers harvested actuals on /production).
// Expectation comes from the same crop_assumptions the marketing engine uses
// (irrigated/dryland breakout where the planting carries a practice); once a
// field's harvest is complete, actual production replaces the expectation and
// the row flags basis:'actual'. Share tokens require the
// share_projected_yields scope (403 naming the scope otherwise) and see only
// the share's fields. Read-only.

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerAccess,
  sharedFieldIds,
  createServiceClient,
  serviceClientMissingResponse,
  requireYearParam,
  errorResponse,
} from '@/lib/partner-api-server'
import { loadProductionInputs } from '@/lib/marketing-inputs'
import { buildProjectedYieldRecords, shareScopeError } from '@/lib/partner-marketing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const access = await resolvePartnerAccess(req, supabase)
  if (access instanceof NextResponse) return access
  const denied = shareScopeError(access.share, 'projected_yields')
  if (denied) return NextResponse.json(denied, { status: 403 })
  const year = requireYearParam(req)
  if (year instanceof NextResponse) return year

  try {
    const production = await loadProductionInputs(supabase, access.org, year)
    const allowedFieldIds = access.share
      ? await sharedFieldIds(supabase, access.org, access.share.landownerId)
      : null

    const records = buildProjectedYieldRecords({
      cropYear: year,
      plantings: production.plantings,
      fields: production.fields,
      crops: production.crops,
      assumptions: production.assumptions,
      doubleCropIds: production.doubleCropIds,
      aggByKey: production.aggByKey,
      cottonLbsByField: production.cottonLbsByField,
      excluded: production.excluded,
      cropCompleteKeys: production.cropCompleteKeys,
      allowedFieldIds,
    })
    return NextResponse.json({ data: records })
  } catch (e) {
    return errorResponse(e)
  }
}
