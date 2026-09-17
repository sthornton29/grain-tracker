// POST /api/farm-link/v1/handshake {code, farm_org_id, farm_org_name} — Turnrow
// Farm redeems the one-time pairing code generated on /settings/farm-link.
// No bearer auth (the code IS the credential; high-entropy, hashed at rest,
// 7-day expiry, one redemption). Issues the long-lived link token (returned
// ONCE, stored sha256) and records Farm's organization on the link.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, sha256Hex, mintLinkToken, readJson } from '@/lib/farm-link-server'
import { evaluateHandshake, looksLikePairingCode, normalizeScopes, type FarmLinkRow } from '@/lib/farm-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const body = await readJson(req)
  if (body instanceof NextResponse) return body
  const code = String(body.code ?? '').trim()
  const farmOrgId = String(body.farm_org_id ?? '').trim()
  const farmOrgName = String(body.farm_org_name ?? '').trim()
  if (!looksLikePairingCode(code)) return NextResponse.json({ error: 'A pairing code from Turnrow Grain is required (it starts with fl_).', code: 'invalid_code' }, { status: 400 })
  if (!UUID_RE.test(farmOrgId)) return NextResponse.json({ error: 'farm_org_id must be the Turnrow Farm organization uuid.' }, { status: 400 })
  if (!farmOrgName) return NextResponse.json({ error: 'farm_org_name is required.' }, { status: 400 })

  try {
    const { data, error } = await supabase.from('farm_links').select('*').eq('code_hash', sha256Hex(code)).maybeSingle()
    if (error) return NextResponse.json({ error: `Turnrow Grain needs a database update before pairing (${error.message}).` }, { status: 500 })
    const link = (data as FarmLinkRow | null) ?? null
    const verdict = evaluateHandshake(link, new Date())
    if (!verdict.ok) return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status })

    const token = mintLinkToken()
    const now = new Date().toISOString()
    const { data: updated, error: updateError } = await supabase
      .from('farm_links')
      .update({ token_hash: sha256Hex(token), redeemed_at: now, status: 'active', farm_org_id: farmOrgId, farm_org_name: farmOrgName, last_seen_at: now })
      .eq('id', link!.id)
      .is('redeemed_at', null) // one-time: a concurrent redeem loses
      .select('id')
    if (updateError) throw new Error(updateError.message)
    if (!updated || updated.length === 0) return NextResponse.json({ error: 'That pairing code was already used. Generate a new one in Turnrow Grain.', code: 'code_used' }, { status: 409 })

    const { data: orgRow } = await supabase.from('organizations').select('name').eq('id', link!.org_id).maybeSingle()
    const base = `${req.nextUrl.protocol}//${req.nextUrl.host}`
    await supabase.from('farm_link_calls').insert({ org_id: link!.org_id, link_id: link!.id, endpoint: 'handshake', method: 'POST', status: 200, counts: {} })
    return NextResponse.json({
      token,
      grain_org_id: link!.org_id,
      grain_org_name: (orgRow as { name: string } | null)?.name ?? 'Turnrow Grain organization',
      scopes: normalizeScopes(link!.scopes),
      api_version: 'v1',
      base_urls: {
        api: `${base}/api/farm-link/v1`,
        land_snapshot: `${base}/api/farm-link/v1/land/snapshot`,
        land_link: `${base}/api/farm-link/v1/land/link`,
        land_sync: `${base}/api/farm-link/v1/land/sync`,
        production: `${base}/api/farm-link/v1/production`,
        marketing: `${base}/api/farm-link/v1/marketing`,
        income: `${base}/api/farm-link/v1/income`,
        bins: `${base}/api/farm-link/v1/bins`,
        assumptions: `${base}/api/farm-link/v1/assumptions`,
        settlements: `${base}/api/farm-link/v1/settlements`,
        status: `${base}/api/farm-link/v1/status`,
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
