// Server-side plumbing for the read-only partner API (/api/partner/v1/*):
// bearer-token gate, the service-role Supabase client (the partner API has no
// user session, and RLS grants only `authenticated`, so it reads with the
// service role — server-only, never exposed to the browser), and a pager that
// walks past PostgREST's 1,000-row page cap.
//
// MULTI-TENANT (054): the service role BYPASSES RLS, so every partner query
// must scope by org explicitly. The bearer token resolves to an org:
//   * the legacy PARTNER_API_TOKEN env var maps to the Turnrow org (the
//     'turnrow-farm' slug — the secret lives in Vercel, not in SQL);
//   * additional tokens live in partner_api_tokens (sha256 at rest, per-org,
//     revocable) — inserted by hand in the SQL editor for now.
// Routes call resolvePartnerOrg() and add .eq('org_id', org) to every query.

import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import { bearerTokenFrom, checkPartnerAuth } from '@/lib/partner-api'

// Returns the 401 response to send, or null when the request is authorized.
// An unconfigured PARTNER_API_TOKEN fails closed (401 for every request).
export function partnerAuthGate(req: NextRequest): NextResponse | null {
  const result = checkPartnerAuth(req.headers.get('authorization'), process.env.PARTNER_API_TOKEN)
  if (result === 'ok') return null
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export function sha256Hex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** The org the request's bearer token belongs to, or a 401/500 response.
 *  Checks the legacy env token first (→ Turnrow), then partner_api_tokens.
 *  Routes MUST scope every query with .eq('org_id', <result>). */
export async function resolvePartnerOrg(
  req: NextRequest,
  supabase: SupabaseClient,
): Promise<string | NextResponse> {
  const unauthorized = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const token = bearerTokenFrom(req.headers.get('authorization'))
  if (!token) return unauthorized

  if (checkPartnerAuth(req.headers.get('authorization'), process.env.PARTNER_API_TOKEN) === 'ok') {
    const { data, error } = await supabase
      .from('organizations').select('id').eq('slug', 'turnrow-farm').maybeSingle()
    if (error || !data) {
      return NextResponse.json({ error: 'Organization for the legacy partner token is missing — run migration 053.' }, { status: 500 })
    }
    return (data as { id: string }).id
  }

  const { data } = await supabase
    .from('partner_api_tokens')
    .select('org_id, revoked_at')
    .eq('token_sha256', sha256Hex(token))
    .maybeSingle()
  const row = data as { org_id: string; revoked_at: string | null } | null
  if (!row || row.revoked_at != null) return unauthorized
  return row.org_id
}

export function createServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function serviceClientMissingResponse(): NextResponse {
  return NextResponse.json(
    { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server.' },
    { status: 500 },
  )
}

// Pages through a query 1,000 rows at a time. Callers build the query inside
// the factory (a PostgREST builder is single-use) and MUST include a stable
// .order(...) for deterministic paging.
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const size = 1000
  const out: T[] = []
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < size) break
  }
  return out
}

// Required integer ?year= — returns the parsed year or a 400 response.
export function requireYearParam(req: NextRequest): number | NextResponse {
  const raw = req.nextUrl.searchParams.get('year')
  const year = Number(raw)
  if (!raw || !Number.isInteger(year) || year < 1900 || year > 2200) {
    return NextResponse.json({ error: 'A valid ?year= is required (e.g. ?year=2026).' }, { status: 400 })
  }
  return year
}

export function errorResponse(e: unknown): NextResponse {
  const message = e instanceof Error ? e.message : 'Unexpected error'
  return NextResponse.json({ error: message }, { status: 500 })
}
