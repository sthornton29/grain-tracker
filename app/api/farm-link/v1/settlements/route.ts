// POST /api/farm-link/v1/settlements {settlements: [{farm_uid, landowner_name,
// landowner_farm_uid, crop_year, lease_type, statement, finalized_at}]} —
// upserts landowner_settlements by farm_uid (Turnrow Farm's lease year id).
// Grain's landowner resolves through the id map, then by exact name; an
// unresolved landowner is stored but never served to a landowner share.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, readJson, fetchAll, loadIdMap } from '@/lib/farm-link-server'
import { normalizeLandownerSettlement, type LandownerSettlementInput } from '@/lib/farm-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'settlements:write')
  if (denied) return denied
  const body = await readJson(req)
  if (body instanceof NextResponse) return body
  const inputs = Array.isArray(body.settlements) ? (body.settlements as LandownerSettlementInput[]) : null
  if (!inputs) return NextResponse.json({ error: 'settlements must be an array.' }, { status: 400 })
  if (inputs.length > 500) return NextResponse.json({ error: 'At most 500 settlements per request.' }, { status: 400 })

  try {
    const org = ctx.org
    const [idMap, landowners] = await Promise.all([
      loadIdMap(supabase, org),
      fetchAll<{ id: string; name: string }>((f, t) => supabase.from('landowners').select('id, name').eq('org_id', org).order('id').range(f, t)),
    ])
    const now = new Date().toISOString()
    const results: Array<{ farm_uid: string; action: 'upserted' | 'refused'; grain_id?: string; landowner_id?: string | null; reason?: string }> = []
    for (const input of inputs) {
      const n = normalizeLandownerSettlement(input, { idMap, landowners, now })
      if ('error' in n) { results.push({ farm_uid: String(input?.farm_uid ?? ''), action: 'refused', reason: n.error }); continue }
      const { data, error } = await supabase
        .from('landowner_settlements')
        .upsert({ ...n.row, org_id: org }, { onConflict: 'org_id,farm_uid' })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      results.push({ farm_uid: n.row.farm_uid, action: 'upserted', grain_id: (data as { id: string }).id, landowner_id: n.row.landowner_id })
    }
    const counts = { settlements: inputs.length, upserted: results.filter((r) => r.action === 'upserted').length, refused: results.filter((r) => r.action === 'refused').length }
    const res = NextResponse.json({ data: results, counts })
    return finish(supabase, ctx, res, { endpoint: 'settlements', method: 'POST', counts, direction: 'inbound' })
  } catch (e) {
    return errorResponse(e)
  }
}
