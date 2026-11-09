// POST /api/ops/actions/preview (2026-11-09): what one ops action would
// change in Turnrow Grain, and its fingerprint (turnrow-farm
// docs/OPS_ACTIONS.md). Reads only. Bearer OPS_WRITE_TOKEN.

import { NextRequest, NextResponse } from 'next/server'
import { opsJson, opsWriteContext } from '@/lib/ops/context'
import { ActionError, ACTIONS, previewAction } from '@/lib/ops/actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const ctx = await opsWriteContext(req)
  if (ctx instanceof NextResponse) return ctx
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return opsJson({ error: 'A JSON body {action, params} is needed.' }, 400)
  try {
    return opsJson(await previewAction(ctx.supabase, ctx.orgId, body as { action?: unknown; params?: unknown }))
  } catch (e) {
    if (e instanceof ActionError) return opsJson({ error: e.message, ...(e.status === 400 ? { actions: ACTIONS.map((a) => a.name) } : {}) }, e.status)
    return opsJson({ error: e instanceof Error ? e.message : 'The preview failed.' }, 500)
  }
}

const notAllowed = () => opsJson({ error: 'POST only.' }, 405)
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE }
