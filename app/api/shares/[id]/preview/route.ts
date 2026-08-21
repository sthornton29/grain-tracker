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
import type { ProductionInputs } from '@/lib/marketing-inputs'
import {
  buildMarketingPricesPayload,
  buildProjectedYieldsPayload,
  loadShareEntities,
  type MarketingPricesPayload,
} from '@/lib/partner-marketing-server'
import { shareScopeError, type ProjectedYieldRecord } from '@/lib/partner-marketing'

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

    const entities = await loadShareEntities(service, share.org_id, fields)

    // Load the shared production assembly at most once for both panels.
    let production: ProductionInputs | null = null

    let marketingPrices:
      | { records: MarketingPricesPayload['data']; by_entity: MarketingPricesPayload['by_entity'] }
      | { denied: string }
    if (pricesDenied) {
      marketingPrices = { denied: pricesDenied.error }
    } else {
      const payload = await buildMarketingPricesPayload(service, share.org_id, year, fields)
      production = payload.production
      marketingPrices = { records: payload.data, by_entity: payload.by_entity }
    }

    let projectedYields: { records: ProjectedYieldRecord[] } | { denied: string }
    if (yieldsDenied) {
      projectedYields = { denied: yieldsDenied.error }
    } else {
      projectedYields = { records: await buildProjectedYieldsPayload(service, share.org_id, year, fields, production) }
    }

    return NextResponse.json({
      landowner_name: (landownerRow as { name: string } | null)?.name ?? null,
      label: share.label,
      revoked: share.revoked_at != null,
      field_count: fields.size,
      entities,
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
