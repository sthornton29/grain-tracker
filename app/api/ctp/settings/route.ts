// POST /api/ctp/settings — save the organization's U.S. Cotton Trust
// Protocol connection (0102): the API key and the Regen program code. The
// only write path to ctp_settings: the key column is server-only, so the
// owner's browser never reads it back — the response carries a hint (the
// last four characters) for the screen.
//
// Body: { api_key?: string | null, regen_program?: string | null }
//   api_key omitted / ''  → unchanged;  null → cleared;  a string → replaced.
//   regen_program omitted → unchanged;  null or '' → cleared.

import { NextRequest, NextResponse } from 'next/server'
import { ctpContext } from '@/lib/ctp-server'
import { ctpRegenProgram, CTP_REGEN_PROGRAM_MAX } from '@/lib/ctp-bales'

export const runtime = 'nodejs'

type Body = { api_key?: string | null; regen_program?: string | null }

export async function POST(req: NextRequest) {
  const ctx = await ctpContext()
  if (ctx instanceof NextResponse) return ctx
  const body = ((await req.json().catch(() => null)) ?? {}) as Body

  const patch: Record<string, unknown> = { org_id: ctx.orgId }
  if (body.api_key === null) {
    patch.api_key = null
    patch.api_key_hint = null
  } else if (typeof body.api_key === 'string' && body.api_key.trim()) {
    const key = body.api_key.trim()
    if (key.length < 8 || key.length > 512 || /\s/.test(key)) {
      return NextResponse.json({ error: 'That doesn’t look like an API key — paste it exactly as the Protocol sent it.' }, { status: 400 })
    }
    patch.api_key = key
    patch.api_key_hint = key.slice(-4)
  }
  if (body.regen_program !== undefined) {
    const raw = (body.regen_program ?? '').trim()
    if (raw && !ctpRegenProgram(raw)) {
      return NextResponse.json({ error: `A Regen program code is at most ${CTP_REGEN_PROGRAM_MAX} characters.` }, { status: 400 })
    }
    patch.regen_program = ctpRegenProgram(raw)
  }
  if (Object.keys(patch).length === 1) return NextResponse.json({ error: 'Nothing to save.' }, { status: 400 })

  const { data, error } = await ctx.service
    .from('ctp_settings')
    .upsert(patch, { onConflict: 'org_id' })
    .select('api_key_hint, regen_program, updated_at')
    .single()
  if (error) {
    console.error('[ctp/settings] save failed', error.message)
    return NextResponse.json({ error: 'The connection could not be saved — try again, or contact support.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, settings: data })
}
