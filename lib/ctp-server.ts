// Server side of the U.S. Cotton Trust Protocol link (0102) — shared by the
// /api/ctp/* routes. The caller is identified by their SESSION (cookie
// client): an OWNER of an organization. The API key lives in a server-only
// column of ctp_settings, so it is read here with the service role and never
// leaves the server; every outbound call carries it as X-API-KEY.
//
// Server-only: never import from a client component (lib/server-client-
// imports.test.ts keeps the seam honest).

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient, serviceClientMissingResponse } from '@/lib/partner-api-server'
import { coerceAppRole } from '@/lib/app-role'
import { CTP_API_BASE } from '@/lib/ctp-bales'

export type CtpContext = {
  userId: string
  orgId: string
  /** RLS-bypassing client, already the caller's org — every read MUST scope `.eq('org_id', orgId)`. */
  service: SupabaseClient
  apiKey: string | null
  regenProgram: string | null
}

/** The signed-in owner's org + the service client, or the response that says why not. */
export async function ctpContext(): Promise<CtpContext | NextResponse> {
  const session = createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 })
  const [{ data: membership }, { data: profile }] = await Promise.all([
    session.from('organization_members').select('org_id').eq('user_id', user.id).limit(1).maybeSingle(),
    session.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle(),
  ])
  const orgId = (membership as { org_id?: string } | null)?.org_id ?? null
  if (!orgId) return NextResponse.json({ error: 'Your login isn’t attached to an operation yet — contact support.' }, { status: 400 })
  if (coerceAppRole((profile as { role?: string } | null)?.role) !== 'owner') {
    return NextResponse.json({ error: 'Only an owner can work with the Trust Protocol.' }, { status: 403 })
  }
  const service = createServiceClient()
  if (!service) return serviceClientMissingResponse()
  const { data: settings, error } = await service.from('ctp_settings').select('api_key, regen_program').eq('org_id', orgId).maybeSingle()
  if (error) return NextResponse.json({ error: 'The Trust Protocol connection isn’t set up on this server yet — contact support.' }, { status: 500 })
  const row = settings as { api_key?: string | null; regen_program?: string | null } | null
  return { userId: user.id, orgId, service, apiKey: row?.api_key?.trim() || null, regenProgram: row?.regen_program ?? null }
}

export const ctpKeyMissingResponse = () =>
  NextResponse.json({ error: 'Save your Trust Protocol API key first (the Connection card on this page).' }, { status: 400 })

export type CtpCallResult = { status: number; json: unknown; ok: boolean }

/** One call to the Partners API. Non-JSON bodies come back as a string. */
export async function ctpCall(apiKey: string, path: string, init: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<CtpCallResult> {
  const url = new URL(path, CTP_API_BASE)
  for (const [k, v] of Object.entries(init.query ?? {})) if (v != null && v !== '') url.searchParams.set(k, String(v))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  try {
    const res = await fetch(url, {
      method: init.method ?? (init.body != null ? 'POST' : 'GET'),
      headers: {
        'X-API-KEY': apiKey,
        Accept: 'application/json',
        ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body != null ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
    const text = await res.text()
    let json: unknown = text
    try { json = text ? JSON.parse(text) : null } catch { /* keep the text */ }
    return { status: res.status, json, ok: res.ok }
  } finally {
    clearTimeout(timer)
  }
}

/** The farmer sentence for a failed call (401/403 = the key; 5xx = their side). */
export function ctpFailureMessage(r: CtpCallResult): string {
  if (r.status === 401 || r.status === 403) return 'The Protocol did not accept the API key — check it on the Connection card.'
  if (r.status === 404) return 'The Protocol’s bale service was not found at the usual address — contact support.'
  if (r.status >= 500) return 'The Protocol’s service is not answering right now — try again in a few minutes.'
  const body = r.json
  const detail = typeof body === 'string' ? body.trim()
    : body && typeof body === 'object' ? String((body as { error?: string; message?: string; title?: string }).error ?? (body as { message?: string }).message ?? (body as { title?: string }).title ?? '')
    : ''
  return detail ? `The Protocol answered: ${detail}` : `The Protocol answered with status ${r.status}.`
}

/** A valid-looking crop year from a request, or null. */
export function readCropYear(raw: unknown): number | null {
  const y = Number(raw)
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : null
}

/** UUID-looking ids only (the service client bypasses RLS; org scoping happens on every read). */
export function readIdList(raw: unknown, max = 20_000): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) out.push(v)
    if (out.length >= max) break
  }
  return Array.from(new Set(out))
}
