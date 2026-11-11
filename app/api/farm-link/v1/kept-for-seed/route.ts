// POST /api/farm-link/v1/kept-for-seed {crop_year, crop, bushels, price_per_bu,
// kept_on, reference, label?, entity_farm_uid?} — Turnrow Farm's saved seed
// lot took these bushels of the crop year as next year's seed at the year's
// average (turnrow-farm docs/GRAIN_KEPT_FOR_SEED.md, 0105). Upserted by
// reference ("turnrow-farm:saved_seed_lot:<id>"): a second POST is the lot
// edited. DELETE ?reference= removes it (the lot voided). Scope
// settlements:write, the scope Farm already writes its statements with.
// The marketing engine counts the bushels as sold at price_per_bu
// (lib/kept-for-seed.ts).

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, readJson, loadIdMap } from '@/lib/farm-link-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function context(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'settlements:write')
  if (denied) return denied
  return { supabase, ctx }
}

export async function POST(req: NextRequest) {
  const c = await context(req)
  if (c instanceof NextResponse) return c
  const { supabase, ctx } = c
  const body = await readJson(req)
  if (body instanceof NextResponse) return body
  const year = Number(body.crop_year)
  const bushels = Number(body.bushels)
  const price = Number(body.price_per_bu)
  const reference = typeof body.reference === 'string' ? body.reference.trim() : ''
  const keptOn = typeof body.kept_on === 'string' ? body.kept_on.slice(0, 10) : ''
  const cropName = typeof body.crop === 'string' ? body.crop.trim().toLowerCase() : ''
  if (!Number.isInteger(year)) return NextResponse.json({ error: 'crop_year must be a year.' }, { status: 400 })
  if (!(bushels > 0)) return NextResponse.json({ error: 'bushels must be more than zero.' }, { status: 400 })
  if (!(price >= 0)) return NextResponse.json({ error: 'price_per_bu must be a price.' }, { status: 400 })
  if (!reference || reference.length > 200) return NextResponse.json({ error: 'reference is required.' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(keptOn)) return NextResponse.json({ error: 'kept_on must be a date (2026-06-04).' }, { status: 400 })
  if (!cropName) return NextResponse.json({ error: 'crop is required (wheat).' }, { status: 400 })
  try {
    const org = ctx.org
    const { data: crops, error: ce } = await supabase.from('crops').select('id, name').eq('org_id', org)
    if (ce) throw new Error(ce.message)
    const crop = (crops ?? []).find((x) => String(x.name).trim().toLowerCase() === cropName)
    if (!crop) return NextResponse.json({ error: `No crop named "${body.crop}" in Turnrow Grain.` }, { status: 422 })
    let entityId: string | null = null
    if (typeof body.entity_farm_uid === 'string' && body.entity_farm_uid) {
      const idMap = await loadIdMap(supabase, org)
      entityId = idMap.grainId('entities', body.entity_farm_uid) ?? null
    }
    const row = { org_id: org, crop_id: crop.id, crop_year: year, entity_id: entityId, bushels, price_per_bu: price, kept_on: keptOn, reference, label: typeof body.label === 'string' ? body.label.slice(0, 200) : null, source: 'turnrow_farm', updated_at: new Date().toISOString() }
    const { data, error } = await supabase.from('kept_for_seed').upsert(row, { onConflict: 'org_id,reference' }).select('id, crop_id, crop_year, entity_id, bushels, price_per_bu, kept_on, reference, label').single()
    if (error) throw new Error(error.message)
    const res = NextResponse.json({ data })
    return finish(supabase, ctx, res, { endpoint: 'kept-for-seed', method: 'POST', counts: { upserted: 1 }, direction: 'inbound' })
  } catch (e) {
    return errorResponse(e)
  }
}

export async function DELETE(req: NextRequest) {
  const c = await context(req)
  if (c instanceof NextResponse) return c
  const { supabase, ctx } = c
  const reference = req.nextUrl.searchParams.get('reference')?.trim() ?? ''
  if (!reference) return NextResponse.json({ error: '?reference= is required.' }, { status: 400 })
  try {
    const { data, error } = await supabase.from('kept_for_seed').delete().eq('org_id', ctx.org).eq('reference', reference).select('id')
    if (error) throw new Error(error.message)
    const res = NextResponse.json({ deleted: (data ?? []).length })
    return finish(supabase, ctx, res, { endpoint: 'kept-for-seed', method: 'DELETE', counts: { deleted: (data ?? []).length }, direction: 'inbound' })
  } catch (e) {
    return errorResponse(e)
  }
}
