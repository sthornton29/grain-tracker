// POST /api/ops/actions/apply (2026-11-09): make one ops action's change in
// Turnrow Grain after a person confirmed it in Turnrow Farm (turnrow-farm
// docs/OPS_ACTIONS.md). Replays by key; 409 when the records moved since the
// preview; every call is logged to ops_action_log. Bearer OPS_WRITE_TOKEN.

import { NextRequest, NextResponse } from 'next/server'
import { opsJson, opsWriteContext } from '@/lib/ops/context'
import { applyAction, type ApplyBody } from '@/lib/ops/actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const ctx = await opsWriteContext(req)
  if (ctx instanceof NextResponse) return ctx
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return opsJson({ error: 'A JSON body {action, params, fingerprint, key, approved_by} is needed.' }, 400)
  try {
    const answer = await applyAction(ctx.supabase, ctx.orgId, body as ApplyBody)
    return opsJson(answer.body, answer.status)
  } catch (e) {
    return opsJson({ error: e instanceof Error ? e.message : 'The change failed.' }, 500)
  }
}

const notAllowed = () => opsJson({ error: 'POST only.' }, 405)
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE }
