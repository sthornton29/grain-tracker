// GET /api/ops/actions (2026-11-09): the fixes Turnrow Farm's Assignments
// may propose in Turnrow Grain (turnrow-farm docs/OPS_ACTIONS.md). Bearer
// OPS_WRITE_TOKEN (the read token never opens it); the organization OPS_ORG
// names.

import { NextRequest, NextResponse } from 'next/server'
import { opsJson, opsWriteContext } from '@/lib/ops/context'
import { actionIndex } from '@/lib/ops/actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await opsWriteContext(req)
  if (ctx instanceof NextResponse) return ctx
  return opsJson(actionIndex())
}

const notAllowed = () => opsJson({ error: 'GET lists the actions; POST to /api/ops/actions/preview or /api/ops/actions/apply.' }, 405)
export { notAllowed as POST, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE }
