// GET /api/partner/v1/marketing-prices?year= — the operation's projected
// average price per crop (072 lease-projection scope). ONE aggregate number
// per crop: the Marketing dashboard's headline price (priced production at
// its prices, unpriced at the standing assumptions, realized hedge P&L
// counted once). Deliberately shaped so the tenant's marketing position
// cannot leak: no components, no priced/unpriced split, no bushels, no
// cost/profit — see lib/partner-marketing.ts. Share tokens require the
// share_projected_prices scope (403 naming the scope otherwise) and see only
// the crops planted on their shared fields; the price itself is always the
// whole operation's average. Read-only.

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerAccess,
  sharedFieldIds,
  createServiceClient,
  serviceClientMissingResponse,
  requireYearParam,
  errorResponse,
} from '@/lib/partner-api-server'
import { loadMarketingInputs } from '@/lib/marketing-inputs'
import { buildMarketingPriceRecords, shareScopeError } from '@/lib/partner-marketing'

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
    const { production, rows } = await loadMarketingInputs(supabase, access.org, year)

    let allowedCropIds: Set<string> | null = null
    if (access.share) {
      const fields = await sharedFieldIds(supabase, access.org, access.share.landownerId)
      allowedCropIds = new Set(
        production.plantings.filter((p) => fields.has(p.field_id)).map((p) => p.crop_id),
      )
    }

    // Manual "physical sales complete" flags (050). A missing table simply
    // means no crop is final yet.
    let salesStatus: Array<{ crop_id: string; physical_sales_complete: boolean }> = []
    const statusResult = await supabase
      .from('crop_year_sales_status')
      .select('crop_id, physical_sales_complete')
      .eq('org_id', access.org)
      .eq('crop_year', year)
    if (!statusResult.error) {
      salesStatus = (statusResult.data ?? []) as typeof salesStatus
    }

    const records = buildMarketingPriceRecords({
      rows,
      cropYear: year,
      salesStatus,
      allowedCropIds,
      asOf: new Date().toISOString(),
    })
    return NextResponse.json({ data: records })
  } catch (e) {
    return errorResponse(e)
  }
}
