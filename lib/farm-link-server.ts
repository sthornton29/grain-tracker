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
import { PDF_BUCKET } from '@/lib/pdf-upload'
import type {
  FieldChangeRow,
  LandownerApplyOp,
  LandownerRow,
  LeaseTermRow,
  ShareFacts,
} from '@/lib/farm-link-landowners'
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

// ---------------------------------------------------------------------------
// Landowners (089)
// ---------------------------------------------------------------------------

/** The landowner columns the link reads. select('*') would break the moment
 *  089 is unapplied on some database, so the list is explicit and the caller
 *  tolerates a missing column. */
const LANDOWNER_COLUMNS =
  'id, name, kind, contact_name, phone, email, address_street, address_city, address_state, address_zip, payee_name, notes, archived_at, merged_into_id, updated_at'

/** Every landowner in the org, archived and merged rows included: the Farm
 *  side needs to see an archive to mirror it. Degrades to the pre-089 columns
 *  when the migration is not applied yet. */
export async function loadLandowners(supabase: SupabaseClient, org: string): Promise<LandownerRow[]> {
  try {
    return await fetchAll<LandownerRow>((f, t) =>
      supabase.from('landowners').select(LANDOWNER_COLUMNS).eq('org_id', org).order('id').range(f, t))
  } catch {
    return await fetchAll<LandownerRow>((f, t) =>
      supabase.from('landowners').select('id, name, phone, email, notes, updated_at').eq('org_id', org).order('id').range(f, t))
  }
}

/** The change log from `since` (all of it when since is null). Empty until 089
 *  is applied, which simply makes every field look unchanged since the base -
 *  Farm's writes then all apply, which is the pre-089 behavior. */
export async function loadLandownerChanges(
  supabase: SupabaseClient,
  org: string,
  since: string | null,
): Promise<FieldChangeRow[]> {
  try {
    return await fetchAll<FieldChangeRow>((f, t) => {
      let q = supabase
        .from('landowner_field_changes')
        .select('landowner_id, field, old_value, new_value, changed_at, changed_by')
        .eq('org_id', org)
      if (since) q = q.gte('changed_at', since)
      return q.order('id').range(f, t)
    })
  } catch {
    return []
  }
}

/** The share facts the landowners pull reports for display: is the share live,
 *  what did the farmer switch on, and has the landowner ever opened it. */
export async function loadShareFacts(supabase: SupabaseClient, org: string): Promise<ShareFacts[]> {
  const rows = await fetchAll<{
    landowner_id: string
    revoked_at: string | null
    redeemed_at: string | null
    include_yields: boolean | null
    share_projected_prices?: boolean | null
    share_projected_yields?: boolean | null
    share_settlements?: boolean | null
    last_viewed_at?: string | null
  }>((f, t) => supabase.from('partner_shares').select('*').eq('org_id', org).order('id').range(f, t)).catch(() => [])
  const byLandowner = new Map<string, ShareFacts>()
  for (const r of rows) {
    const scopes: string[] = []
    if (r.include_yields) scopes.push('yields')
    if (r.share_projected_prices) scopes.push('projected_prices')
    if (r.share_projected_yields) scopes.push('projected_yields')
    if (r.share_settlements) scopes.push('settlements')
    const active = r.revoked_at == null
    const prev = byLandowner.get(r.landowner_id)
    // A landowner can hold more than one share; report the live one, and the
    // newest view across them.
    const merged: ShareFacts = {
      landowner_id: r.landowner_id,
      active: (prev?.active ?? false) || active,
      scopes: active ? scopes : prev?.scopes ?? [],
      last_viewed_at: maxIso(prev?.last_viewed_at ?? null, r.last_viewed_at ?? null),
    }
    byLandowner.set(r.landowner_id, merged)
  }
  return Array.from(byLandowner.values())
}

const maxIso = (a: string | null, b: string | null): string | null => (a && b ? (a > b ? a : b) : a ?? b)

/** Active (unrevoked) shares by landowner - the merge and archive guards. */
export async function loadActiveShareLandownerIds(supabase: SupabaseClient, org: string): Promise<Set<string>> {
  const rows = await fetchAll<{ landowner_id: string; revoked_at: string | null }>((f, t) =>
    supabase.from('partner_shares').select('landowner_id, revoked_at').eq('org_id', org).order('id').range(f, t)).catch(() => [])
  return new Set(rows.filter((r) => r.revoked_at == null).map((r) => r.landowner_id))
}

/** Crop years with a rent settlement, per landowner - the archive guard. */
export async function loadSettlementYearsByLandowner(
  supabase: SupabaseClient,
  org: string,
): Promise<Map<string, number[]>> {
  const rows = await fetchAll<{ landowner_id: string; crop_year: number }>((f, t) =>
    supabase.from('rent_settlements').select('landowner_id, crop_year').eq('org_id', org).order('id').range(f, t)).catch(() => [])
  const out = new Map<string, number[]>()
  for (const r of rows) {
    const list = out.get(r.landowner_id) ?? []
    list.push(r.crop_year)
    out.set(r.landowner_id, list)
  }
  return out
}

export async function loadLeaseTerms(supabase: SupabaseClient, org: string): Promise<LeaseTermRow[]> {
  try {
    return await fetchAll<LeaseTermRow>((f, t) =>
      supabase.from('lease_terms')
        .select('id, landowner_id, farm_ids, lease_type, share_terms, expense_terms, pricing_method, cash_terms, flex_terms, payment_timing, notes, source_file_name, source_file_path, managed_by, farm_lease_uid, updated_at')
        .eq('org_id', org).order('id').range(f, t))
  } catch {
    return await fetchAll<LeaseTermRow>((f, t) =>
      supabase.from('lease_terms')
        .select('id, landowner_id, farm_ids, lease_type, share_terms, expense_terms, pricing_method, cash_terms, flex_terms, payment_timing, notes, source_file_name, source_file_path, updated_at')
        .eq('org_id', org).order('id').range(f, t))
  }
}

/** A short-lived signed URL for a lease document. The Farm side reads the
 *  lease once as a proposal, so the link never hands out a durable URL. */
export const LEASE_DOCUMENT_URL_TTL_SECONDS = 15 * 60

export async function signLeaseDocuments(
  supabase: SupabaseClient,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const wanted = Array.from(new Set(paths.filter(Boolean)))
  if (wanted.length === 0) return out
  try {
    const { data, error } = await supabase.storage.from(PDF_BUCKET).createSignedUrls(wanted, LEASE_DOCUMENT_URL_TTL_SECONDS)
    if (error || !data) return out
    for (const row of data as Array<{ path?: string | null; signedUrl?: string | null }>) {
      if (row.path && row.signedUrl) out.set(row.path, row.signedUrl)
    }
  } catch {
    // A missing object is not a reason to fail the whole pull.
  }
  return out
}

/** The ONE transactional writer for the landowner endpoints (089). Mirrors
 *  applyOps: one RPC call, one transaction, service role only. */
export async function applyLandownerOps(
  supabase: SupabaseClient,
  org: string,
  ops: readonly LandownerApplyOp[],
): Promise<{ refs: Record<string, string>; counts: Record<string, number> }> {
  if (ops.length === 0) return { refs: {}, counts: {} }
  const { data, error } = await supabase.rpc('farm_link_landowner_apply', { p_org: org, p_ops: ops })
  if (error) throw new Error(error.message)
  const out = (data as { refs?: Record<string, string>; counts?: Record<string, number> } | null) ?? {}
  return { refs: out.refs ?? {}, counts: out.counts ?? {} }
}

/** 90-day retention on the change log, at most once a day per instance (the
 *  farm_link_calls pattern). Never fails a call. */
let lastChangeTrimAt = 0
export const LANDOWNER_CHANGE_RETENTION_DAYS = 90

export async function trimLandownerChanges(supabase: SupabaseClient): Promise<void> {
  const now = Date.now()
  if (now - lastChangeTrimAt < 24 * 60 * 60 * 1000) return
  lastChangeTrimAt = now
  try {
    await supabase.rpc('trim_landowner_field_changes', { p_days: LANDOWNER_CHANGE_RETENTION_DAYS })
  } catch {
    // The trim never fails a call.
  }
}
