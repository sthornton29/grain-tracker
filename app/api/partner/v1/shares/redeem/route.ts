// POST /api/partner/v1/shares/redeem — a landowner's software redeems the
// one-time share code from their farmer. Mints the bearer token (returned
// once, stored hashed) and returns the handshake: operation name, landowner
// name, scopes, shared field count. No auth (the code IS the credential;
// codes are high-entropy, hashed at rest, and expire).

import { NextRequest, NextResponse } from 'next/server'
import {
  createServiceClient,
  serviceClientMissingResponse,
  sha256Hex,
  sharedFieldIds,
  mintShareToken,
  errorResponse,
} from '@/lib/partner-api-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()

  let code = ''
  try {
    const body = await req.json()
    code = String(body?.code ?? '').trim()
  } catch {
    /* fall through to the validation below */
  }
  if (code.length < 8) {
    return NextResponse.json({ error: 'A share code is required.' }, { status: 400 })
  }

  try {
    const { data } = await supabase
      .from('partner_shares')
      .select('id, org_id, landowner_id, label, include_yields, code_expires_at, redeemed_at, revoked_at')
      .eq('share_code_sha256', sha256Hex(code.toUpperCase()))
      .maybeSingle()
    const share = data as {
      id: string
      org_id: string
      landowner_id: string
      label: string | null
      include_yields: boolean
      code_expires_at: string
      redeemed_at: string | null
      revoked_at: string | null
    } | null

    if (!share) {
      return NextResponse.json(
        { error: 'That code is not valid. Check it with your farmer.' },
        { status: 404 },
      )
    }
    if (share.revoked_at) {
      return NextResponse.json(
        { error: 'Your farmer has ended this share.', code: 'share_revoked' },
        { status: 403 },
      )
    }
    if (share.redeemed_at) {
      return NextResponse.json(
        { error: 'That code was already used. Ask your farmer for a new one.' },
        { status: 409 },
      )
    }
    if (new Date(share.code_expires_at) < new Date()) {
      return NextResponse.json(
        { error: 'That code has expired. Ask your farmer for a new one.' },
        { status: 410 },
      )
    }

    const token = mintShareToken()
    const { error: updateError } = await supabase
      .from('partner_shares')
      .update({ redeemed_at: new Date().toISOString(), token_sha256: sha256Hex(token) })
      .eq('id', share.id)
      .is('redeemed_at', null) // one-time: a concurrent redeem loses
    if (updateError) throw new Error(updateError.message)

    const [{ data: orgRow }, { data: landownerRow }, fieldIds] = await Promise.all([
      supabase.from('organizations').select('name').eq('id', share.org_id).maybeSingle(),
      supabase.from('landowners').select('name').eq('id', share.landowner_id).maybeSingle(),
      sharedFieldIds(supabase, share.org_id, share.landowner_id),
    ])

    return NextResponse.json({
      token,
      handshake: {
        operation_name: (orgRow as { name: string } | null)?.name ?? 'Farm operation',
        landowner_name: (landownerRow as { name: string } | null)?.name ?? null,
        label: share.label,
        scopes: { fields: true, plantings: true, harvest: true, yields: share.include_yields },
        field_count: fieldIds.size,
        api_version: 'v1',
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
