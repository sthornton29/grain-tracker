// GET /api/partner/v1/marketing-prices?year= — the operation's projected
// average price per crop (072 lease-projection scope). ONE aggregate number
// per crop: the Marketing dashboard's headline price (priced production at
// its prices, unpriced at the standing assumptions, realized hedge P&L
// counted once). Deliberately shaped so the tenant's marketing position
// cannot leak: no components, no priced/unpriced split, no bushels, no
// cost/profit — see lib/partner-marketing.ts. Share tokens require the
// share_projected_prices scope (403 naming the scope otherwise) and see only
// the crops planted on their shared fields. `data` is the whole operation's
// average; `by_entity` (additive) carries the same number per FARMING entity
// with shared fields, computed through the reports' entity attribution seam
// (lib/entity-marketing.ts). Read-only.

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerAccess,
  sharedFieldIds,
  createServiceClient,
  serviceClientMissingResponse,
  requireYearParam,
  errorResponse,
} from '@/lib/partner-api-server'
import { buildMarketingPricesPayload } from '@/lib/partner-marketing-server'
import { shareScopeError } from '@/lib/partner-marketing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30 // may fetch missing quotes from Barchart

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const access = await resolvePartnerAccess(req, supabase)
  if (access instanceof NextResponse) return access
  const denied = shareScopeError(access.share, 'projected_prices')
  if (denied) return NextResponse.json(denied, { status: 403 })
  const year = requireYearParam(req)
  if (year instanceof NextResponse) return year

  try {
    const fields = access.share ? await sharedFieldIds(supabase, access.org, access.share.landownerId) : null
    const { data, by_entity } = await buildMarketingPricesPayload(supabase, access.org, year, fields)
    return NextResponse.json({ data, by_entity })
  } catch (e) {
    return errorResponse(e)
  }
}
