// GET /api/ctp/producers?year=2026 — the producers the Protocol lists for
// this member in a crop year (getProducers), so an owner can pick each
// entity's Protocol ID from a list instead of typing it, and see the Regen
// program code the Protocol has them under. Also the "test the key" call.

import { NextRequest, NextResponse } from 'next/server'
import { ctpCall, ctpContext, ctpFailureMessage, ctpKeyMissingResponse, readCropYear } from '@/lib/ctp-server'
import { readProducers } from '@/lib/ctp-bales'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const ctx = await ctpContext()
  if (ctx instanceof NextResponse) return ctx
  if (!ctx.apiKey) return ctpKeyMissingResponse()
  const year = readCropYear(req.nextUrl.searchParams.get('year')) ?? new Date().getFullYear()
  let r
  try {
    r = await ctpCall(ctx.apiKey, '/api/BaleRegistration/getProducers', { query: { CropYear: year } })
  } catch (e) {
    console.error('[ctp/producers] call failed', e)
    return NextResponse.json({ error: 'Could not reach the Protocol — check the connection and try again.' }, { status: 502 })
  }
  if (!r.ok) return NextResponse.json({ error: ctpFailureMessage(r) }, { status: r.status === 401 || r.status === 403 ? 400 : 502 })
  return NextResponse.json({ ok: true, cropYear: year, producers: readProducers(r.json) })
}
