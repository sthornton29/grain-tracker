// GET /api/ops/brief (2026-11-08): what needs doing in Turnrow Grain, in the
// shared ops envelope (turnrow-farm docs/OPS_API.md) the Turnrow Morning
// Brief and Turnrow Farm's Assignments read. Bearer OPS_TOKEN; the one
// organization OPS_ORG names; read only.

import { NextRequest, NextResponse } from 'next/server'
import { opsContext, opsJson } from '@/lib/ops/context'
import { buildOpsBrief } from '@/lib/ops/brief'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const ctx = await opsContext(req)
  if (ctx instanceof NextResponse) return ctx
  try {
    return opsJson(await buildOpsBrief(ctx.supabase, ctx.orgId))
  } catch (e) {
    return opsJson({ error: e instanceof Error ? e.message : 'The brief failed.' }, 500)
  }
}

const notAllowed = () => opsJson({ error: 'The ops API is read only (GET).' }, 405)
export { notAllowed as POST, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE }
