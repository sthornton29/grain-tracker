// GET /api/ops/data (2026-11-08): the datasets an agent may read from
// Turnrow Grain (no dataset: the index; ?dataset=<name>&<param>=<value>: up
// to 500 rows). The shared ops contract, turnrow-farm docs/OPS_API.md.
// Bearer OPS_TOKEN; the organization OPS_ORG names; read only.

import { NextRequest, NextResponse } from 'next/server'
import { opsContext, opsJson } from '@/lib/ops/context'
import { BadParam, DATASETS, datasetIndex, readDataset } from '@/lib/ops/data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const ctx = await opsContext(req)
  if (ctx instanceof NextResponse) return ctx
  const params = Object.fromEntries(req.nextUrl.searchParams.entries())
  const { dataset, ...args } = params
  if (!dataset) return opsJson(datasetIndex())
  try {
    return opsJson(await readDataset(ctx.supabase, ctx.orgId, dataset, args))
  } catch (e) {
    if (e instanceof BadParam) return opsJson({ error: e.message, datasets: DATASETS.map((d) => d.name) }, 400)
    return opsJson({ error: e instanceof Error ? e.message : 'The read failed.' }, 500)
  }
}

const notAllowed = () => opsJson({ error: 'The ops API is read only (GET).' }, 405)
export { notAllowed as POST, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE }
