// The request side of the ops API: the token gate, the service-role client
// (no user session here; the service role bypasses RLS, so every query in
// lib/ops scopes .eq('org_id', orgId) explicitly), and the organization
// OPS_ORG names.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/partner-api-server'
import { checkOpsAuth, checkOpsWriteAuth, orgFilter, type OpsAuthResult } from './auth'

export const OPS_HEADERS = { 'Cache-Control': 'no-store' }

export function opsJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: OPS_HEADERS })
}

export async function opsContext(req: NextRequest): Promise<{ supabase: SupabaseClient; orgId: string } | NextResponse> {
  return contextFor(checkOpsAuth(req.headers.get('authorization')))
}

/** The ops actions (docs/OPS_ACTIONS.md): the same organization, behind the
 *  WRITE token. */
export async function opsWriteContext(req: NextRequest): Promise<{ supabase: SupabaseClient; orgId: string } | NextResponse> {
  return contextFor(checkOpsWriteAuth(req.headers.get('authorization')))
}

async function contextFor(auth: OpsAuthResult): Promise<{ supabase: SupabaseClient; orgId: string } | NextResponse> {
  if (!auth.ok) return opsJson({ error: auth.error }, auth.status)
  const supabase = createServiceClient()
  if (!supabase) return opsJson({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server.' }, 500)
  const f = orgFilter(process.env.OPS_ORG)
  if (!f) return opsJson({ error: 'OPS_ORG is not set: name the organization (its id or slug).' }, 503)
  const { data, error } = await supabase.from('organizations').select('id').eq(f.column, f.value).maybeSingle()
  if (error) return opsJson({ error: error.message }, 500)
  if (!data) return opsJson({ error: `No organization ${f.value}.` }, 503)
  return { supabase, orgId: (data as { id: string }).id }
}

export const APP = { app: 'grain', label: 'Turnrow Grain', base: 'https://turnrowgrain.com' } as const
export const url = (path: string) => `${APP.base}${path}`
