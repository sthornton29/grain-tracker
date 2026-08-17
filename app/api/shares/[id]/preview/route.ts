// GET /api/shares/:id/preview?year= — the farmer-facing "What the landowner
// sees" panel on /settings/shares. Session-authenticated (owner role); the
// share row is read through the caller's own session client, so the 070 org
// policy proves membership before anything is built. The payloads themselves
// are produced by the SAME lib/partner-marketing.ts builders the partner
// endpoints use, over the same service-role assembly — which is the
// structural guarantee that this preview shows exactly the payload the
// landowner's software receives (the share's bearer token is stored hashed,
// so calling the real endpoints on the farmer's behalf is impossible by
// design). A scope that is off previews the same "not shared" answer the
// landowner gets.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient, serviceClientMissingResponse, sharedFieldIds } from '@/lib/partner-api-server'
import { loadMarketingInputs, loadProductionInputs } from '@/lib/marketing-inputs'
import {
  buildMarketingPriceRecords,
  buildProjectedYieldRecords,
  shareScopeError,
  type MarketingPriceRecord,
  type ProjectedYieldRecord,
} from '@/lib/partner-marketing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

type ShareRow = {
  id: string
  org_id: string
  landowner_id: string
  label: string | null
  include_yields: boolean
  share_projected_prices?: boolean | null
  share_projected_yields?: boolean | null
  revoked_at: string | null
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = createClient()
  const { data: userData } = await session.auth.getUser()
  if (!userData?.user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  const { data: profile } = await session
    .from('user_profiles')
    .select('role')
    .eq('user_id', userData.user.id)
    .maybeSingle()
  const role = (profile as { role?: string } | null)?.role ?? 'owner'
  if (role !== 'owner') {
    return NextResponse.json({ error: 'Only owners can view shares.' }, { status: 403 })
  }

  // The org policy on partner_shares scopes this read — a share outside the
  // caller's org simply doesn't exist here.
  const { data: shareData, error: shareError } = await session
    .from('partner_shares')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()
  if (shareError) return NextResponse.json({ error: shareError.message }, { status: 500 })
  const share = shareData as ShareRow | null
  if (!share) return NextResponse.json({ error: 'Share not found.' }, { status: 404 })

  const yearRaw = req.nextUrl.searchParams.get('year')
  const year = Number(yearRaw)
  if (!yearRaw || !Number.isInteger(year) || year < 1900 || year > 2200) {
    return NextResponse.json({ error: 'A valid ?year= is required.' }, { status: 400 })
  }

  const service = createServiceClient()
  if (!service) return serviceClientMissingResponse()

  const scopeFlags = {
    sharesProjectedPrices: share.share_projected_prices ?? false,
    sharesProjectedYields: share.share_projected_yields ?? false,
  }

  try {
    const fields = await sharedFieldIds(service, share.org_id, share.landowner_id)
    const { data: landownerRow } = await session
      .from('landowners')
      .select('name')
      .eq('id', share.landowner_id)
      .maybeSingle()

    const pricesDenied = shareScopeError(scopeFlags, 'projected_prices')
    const yieldsDenied = shareScopeError(scopeFlags, 'projected_yields')

    // Load the shared production assembly at most once for both panels.
    let production: Awaited<ReturnType<typeof loadProductionInputs>> | null = null

    let marketingPrices: { records: MarketingPriceRecord[] } | { denied: string }
    if (pricesDenied) {
      marketingPrices = { denied: pricesDenied.error }
    } else {
      const mi = await loadMarketingInputs(service, share.org_id, year)
      production = mi.production
      const allowedCropIds = new Set(
        mi.production.plantings.filter((p) => fields.has(p.field_id)).map((p) => p.crop_id),
      )
      let salesStatus: Array<{ crop_id: string; physical_sales_complete: boolean }> = []
      const statusResult = await service
        .from('crop_year_sales_status')
        .select('crop_id, physical_sales_complete')
        .eq('org_id', share.org_id)
        .eq('crop_year', year)
      if (!statusResult.error) salesStatus = (statusResult.data ?? []) as typeof salesStatus
      marketingPrices = {
        records: buildMarketingPriceRecords({
          rows: mi.rows,
          cropYear: year,
          salesStatus,
          allowedCropIds,
          asOf: new Date().toISOString(),
        }),
      }
    }

    let projectedYields: { records: ProjectedYieldRecord[] } | { denied: string }
    if (yieldsDenied) {
      projectedYields = { denied: yieldsDenied.error }
    } else {
      if (!production) production = await loadProductionInputs(service, share.org_id, year)
      projectedYields = {
        records: buildProjectedYieldRecords({
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
          allowedFieldIds: fields,
        }),
      }
    }

    return NextResponse.json({
      landowner_name: (landownerRow as { name: string } | null)?.name ?? null,
      label: share.label,
      revoked: share.revoked_at != null,
      field_count: fields.size,
      scopes: {
        yields: share.include_yields,
        projected_prices: scopeFlags.sharesProjectedPrices,
        projected_yields: scopeFlags.sharesProjectedYields,
      },
      marketing_prices: marketingPrices,
      projected_yields: projectedYields,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unexpected error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
