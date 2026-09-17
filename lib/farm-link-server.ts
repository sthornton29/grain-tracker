// Server-side plumbing for the Turnrow Farm link (/api/farm-link/v1/*):
// bearer-token resolution, scope gates, the per-link rate limit, the rolling
// call log, the org-scoped land-state loader, and the transactional apply
// (farm_link_apply RPC). Like the partner API, the service role BYPASSES RLS,
// so every query here scopes .eq('org_id', link.org_id) explicitly.

import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { bearerTokenFrom } from '@/lib/partner-api'
import { fetchAll, sha256Hex } from '@/lib/partner-api-server'
import { fetchAllCounties } from '@/lib/counties'
import {
  IdMap,
  dataBearingKeys,
  evaluateToken,
  formatFarmLinkSecret,
  scopeDenied,
  type ApplyOp,
  type FarmLinkRow,
  type FarmLinkScope,
  type LandState,
} from '@/lib/farm-link'

export { createServiceClient, serviceClientMissingResponse, errorResponse, fetchAll, sha256Hex } from '@/lib/partner-api-server'

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function mintLinkToken(): string {
  return formatFarmLinkSecret('token', randomBytes(24).toString('hex'))
}
export function mintPairingCode(): string {
  return formatFarmLinkSecret('code', randomBytes(16).toString('hex'))
}

// ---------------------------------------------------------------------------
// Token → link
// ---------------------------------------------------------------------------

export type LinkContext = { link: FarmLinkRow; org: string; startedAt: number }

/** Resolves the bearer token to its farm_links row (401 on unknown, revoked,
 *  or never-redeemed). Touches last_seen_at. */
export async function resolveFarmLink(req: NextRequest, supabase: SupabaseClient): Promise<LinkContext | NextResponse> {
  const token = bearerTokenFrom(req.headers.get('authorization'))
  if (!token) return NextResponse.json({ error: 'Unauthorized', code: 'unknown_token' }, { status: 401 })
  const { data, error } = await supabase.from('farm_links').select('*').eq('token_hash', sha256Hex(token)).maybeSingle()
  if (error) {
    return NextResponse.json({ error: `The Turnrow Farm link needs a database update in Turnrow Grain (${error.message}).` }, { status: 500 })
  }
  const link = (data as FarmLinkRow | null) ?? null
  const verdict = evaluateToken(link)
  if (!verdict.ok) return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status })
  // Fire-and-forget presence stamp (never blocks the response).
  void supabase.from('farm_links').update({ last_seen_at: new Date().toISOString() }).eq('id', link!.id)
  return { link: link!, org: link!.org_id, startedAt: Date.now() }
}

export function requireScope(ctx: LinkContext, scope: FarmLinkScope): NextResponse | null {
  const denied = scopeDenied(ctx.link.scopes ?? [], scope)
  return denied ? NextResponse.json(denied, { status: 403 }) : null
}

// ---------------------------------------------------------------------------
// Rate limit — per link, per server instance (the partner API's convention
// for AI routes; a sliding minute window generous enough for a full sync).
// ---------------------------------------------------------------------------

export const FARM_LINK_RATE_LIMIT = 240 // calls per link per minute (per instance)
const rateLog = new Map<string, number[]>()

export function farmLinkRateLimited(linkId: string, now = Date.now(), limit = FARM_LINK_RATE_LIMIT): boolean {
  const cutoff = now - 60 * 1000
  const seen = (rateLog.get(linkId) ?? []).filter((t) => t > cutoff)
  if (seen.length >= limit) { rateLog.set(linkId, seen); return true }
  seen.push(now)
  rateLog.set(linkId, seen)
  return false
}

export function rateLimitedResponse(): NextResponse {
  return NextResponse.json({ error: 'Too many requests for this link — wait a minute and try again.', code: 'rate_limited' }, { status: 429 })
}

// ---------------------------------------------------------------------------
// Call log (farm_link_calls) — every call, counts only; trimmed to 30 days at
// most once a day per server instance.
// ---------------------------------------------------------------------------

export const CALL_LOG_RETENTION_DAYS = 30
let lastTrimAt = 0

export async function logFarmLinkCall(
  supabase: SupabaseClient,
  ctx: LinkContext,
  args: { endpoint: string; method: string; status: number; counts?: Record<string, number> },
): Promise<void> {
  try {
    await supabase.from('farm_link_calls').insert({
      org_id: ctx.org,
      link_id: ctx.link.id,
      endpoint: args.endpoint,
      method: args.method,
      status: args.status,
      counts: args.counts ?? {},
      duration_ms: Math.max(0, Date.now() - ctx.startedAt),
    })
    const now = Date.now()
    if (now - lastTrimAt > 24 * 60 * 60 * 1000) {
      lastTrimAt = now
      const cutoff = new Date(now - CALL_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
      await supabase.from('farm_link_calls').delete().lt('called_at', cutoff)
    }
  } catch {
    // The log never fails a call.
  }
}

/** Records the direction's last sync on the link row. */
export async function recordLastSync(
  supabase: SupabaseClient,
  ctx: LinkContext,
  direction: 'inbound' | 'outbound',
  entry: Record<string, unknown>,
): Promise<void> {
  const current = (ctx.link.last_sync ?? {}) as Record<string, unknown>
  const next = { ...current, [direction]: { ...entry, at: new Date().toISOString() } }
  await supabase.from('farm_links').update({ last_sync: next }).eq('id', ctx.link.id)
  ctx.link.last_sync = next
}

/** Log + last-sync in one call; returns the response unchanged. */
export async function finish(
  supabase: SupabaseClient,
  ctx: LinkContext,
  res: NextResponse,
  args: { endpoint: string; method: string; counts?: Record<string, number>; direction?: 'inbound' | 'outbound'; sync?: Record<string, unknown> },
): Promise<NextResponse> {
  await logFarmLinkCall(supabase, ctx, { endpoint: args.endpoint, method: args.method, status: res.status, counts: args.counts })
  if (args.direction && res.status < 300) {
    await recordLastSync(supabase, ctx, args.direction, { endpoint: args.endpoint, counts: args.counts ?? {}, ...(args.sync ?? {}) })
  }
  return res
}

// ---------------------------------------------------------------------------
// Land state
// ---------------------------------------------------------------------------

export async function loadIdMap(supabase: SupabaseClient, org: string): Promise<IdMap> {
  const rows = await fetchAll<{ grain_table: string; grain_id: string; farm_uid: string }>((f, t) =>
    supabase.from('farm_link_ids').select('grain_table, grain_id, farm_uid').eq('org_id', org).order('id').range(f, t))
  return new IdMap(rows)
}

type FieldRowDb = { id: string; farm_id: string | null; name_or_number: string; total_acres: number | string | null; irrigated_acres: number | string | null; county_id: string | null; managed_by: 'turnrow_farm' | null; archived_at: string | null; updated_at: string | null }
type PlantingRowDb = { id: string; field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null; planting_date: string | null; paired_planting_id: string | null; irrigated_acres: number | string | null; irrigated_bushels: number | string | null; dryland_bushels: number | string | null; managed_by: 'turnrow_farm' | null; archived_at: string | null; updated_at: string | null }

/** Everything the planner and the snapshot read, org-scoped and paged. */
export async function loadLandState(supabase: SupabaseClient, org: string): Promise<LandState> {
  const [entities, landowners, farms, fields, crops, plantings, varieties, counties, idMap, loads, splits, combine, gins] = await Promise.all([
    fetchAll<LandState['entities'][number]>((f, t) =>
      supabase.from('entities').select('id, name, entity_role, managed_by, archived_at, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<LandState['landowners'][number]>((f, t) =>
      supabase.from('landowners').select('id, name, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<LandState['farms'][number]>((f, t) =>
      supabase.from('farms').select('id, name, entity_id, fsa_number, county_id, landowner_id, is_share_rent, landlord_share_percentage, cash_rent_per_acre, managed_by, archived_at, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<FieldRowDb>((f, t) =>
      supabase.from('fields').select('id, farm_id, name_or_number, total_acres, irrigated_acres, county_id, managed_by, archived_at, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<LandState['crops'][number]>((f, t) =>
      supabase.from('crops').select('id, name, harvest_category, double_crop, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<PlantingRowDb>((f, t) =>
      supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres, planting_date, paired_planting_id, irrigated_acres, irrigated_bushels, dryland_bushels, managed_by, archived_at, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<LandState['varieties'][number]>((f, t) =>
      supabase.from('field_planting_varieties').select('id, planting_id, variety, acres, bushels').eq('org_id', org).order('id').range(f, t)),
    fetchAllCounties(supabase),
    loadIdMap(supabase, org),
    fetchAll<{ id: string; from_type: string | null; from_field_id: string | null; crop_id: string | null; crop_year: number | null; date: string }>((f, t) =>
      supabase.from('loads').select('id, from_type, from_field_id, crop_id, crop_year, date').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ load_id: string; field_id: string; crop_id: string }>((f, t) =>
      supabase.from('load_splits').select('load_id, field_id, crop_id').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ field_id: string; crop_id: string; crop_year: number }>((f, t) =>
      supabase.from('combine_yield_entries').select('field_id, crop_id, crop_year').eq('org_id', org).order('id').range(f, t)).catch(() => []),
    fetchAll<{ field_id: string | null; crop_year: number }>((f, t) =>
      supabase.from('gin_receipts').select('field_id, crop_year').eq('org_id', org).order('id').range(f, t)).catch(() => []),
  ])
  const loadYearById = new Map(loads.map((l) => [l.id, l.crop_year ?? Number(String(l.date).slice(0, 4)) ?? null]))
  const cottonCropIds = new Set(crops.filter((c) => /cotton/i.test(c.name)).map((c) => c.id))
  const bearing = dataBearingKeys({ loads, splits, loadYearById, combineEntries: combine, ginReceipts: gins, cottonCropIds, plantingsWithBreakout: plantings })
  return {
    entities, landowners, farms, fields, crops, plantings, varieties,
    counties: counties.map((c) => ({ id: c.id, name: c.name, state_code: c.state_code })),
    idMap,
    fieldIdsWithData: bearing.fieldIdsWithData,
    plantingKeysWithData: bearing.plantingKeysWithData,
  }
}

// ---------------------------------------------------------------------------
// Apply — ONE transaction per batch via farm_link_apply
// ---------------------------------------------------------------------------

export async function applyOps(supabase: SupabaseClient, org: string, ops: readonly ApplyOp[]): Promise<Record<string, string>> {
  if (ops.length === 0) return {}
  const { data, error } = await supabase.rpc('farm_link_apply', { p_org: org, p_ops: ops })
  if (error) throw new Error(error.message)
  return (data as Record<string, string> | null) ?? {}
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------

export async function readJson(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = await req.json()
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'The request body must be a JSON object.' }, { status: 400 })
    }
    return body as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'The request body must be valid JSON.' }, { status: 400 })
  }
}

export function requireIntParam(req: NextRequest, name: string, opts?: { optional?: boolean }): number | null | NextResponse {
  const raw = req.nextUrl.searchParams.get(name)
  if (!raw) {
    if (opts?.optional) return null
    return NextResponse.json({ error: `A valid ?${name}= is required (e.g. ?${name}=2026).` }, { status: 400 })
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1900 || n > 2200) return NextResponse.json({ error: `?${name}= must be a four-digit year.` }, { status: 400 })
  return n
}
