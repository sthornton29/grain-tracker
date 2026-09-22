// The Turnrow Farm link (087) — PURE logic for /api/farm-link/v1/* and the
// /settings/farm-link page. No I/O here: lib/farm-link-server.ts does the
// Supabase reads and the transactional farm_link_apply RPC call, the route
// handlers wire the two together, and this file is where every rule lives so
// it can be unit-tested (lib/farm-link.test.ts).
//
// Turnrow Farm is the MASTER for entities, farms, fields, and plantings; Grain
// is the master for everything harvested, stored, sold, hedged, insured, and
// paid. The link is per organization (one active pairing), authenticated by a
// long-lived bearer token issued at the handshake, scoped per direction, and
// keyed through an id map (farm_link_ids) — never through farm_uid columns on
// the core tables.

import { normalizeCountyName } from '@/lib/fsa-benchmark-file'

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export const FARM_LINK_SCOPES = [
  'land:write',
  'production:read',
  'marketing:read',
  'income:read',
  'bins:read',
  'insurance:read',
  'landowners:write',
  'assumptions:write',
  'settlements:write',
] as const
export type FarmLinkScope = (typeof FARM_LINK_SCOPES)[number]

/** Farmer-facing copy for the scope toggles on /settings/farm-link. */
export const FARM_LINK_SCOPE_LABELS: Record<FarmLinkScope, { title: string; blurb: string; direction: 'in' | 'out' }> = {
  'land:write': {
    title: 'Land records from Turnrow Farm',
    blurb: 'Entities, farms, fields, and plantings come from Turnrow Farm. Once synced, they are edited there, not here.',
    direction: 'in',
  },
  'production:read': {
    title: 'Production to Turnrow Farm',
    blurb: 'Harvest progress, bushels or pounds, and yields per field — the same numbers the Yields pages show.',
    direction: 'out',
  },
  'marketing:read': {
    title: 'Marketing to Turnrow Farm',
    blurb: 'Average sale prices, projected prices with basis, percent sold, and realized hedging results by crop.',
    direction: 'out',
  },
  'income:read': {
    title: 'Income to Turnrow Farm',
    blurb: 'Crop revenue, government payments, and crop insurance by crop and entity.',
    direction: 'out',
  },
  'bins:read': {
    title: 'Bins to Turnrow Farm',
    blurb: 'Bushels on hand and bushels in for the year, per bin and crop.',
    direction: 'out',
  },
  'insurance:read': {
    title: 'Crop insurance premiums to Turnrow Farm',
    blurb: 'Producer-paid premiums by entity, crop, and irrigated or dryland, so you do not enter them again over there.',
    direction: 'out',
  },
  'landowners:write': {
    title: 'Landowners shared with Turnrow Farm',
    blurb: 'Names, contacts, and mailing addresses stay the same on both sides. Either side can edit them; a change you both made at once is shown to you rather than overwritten.',
    direction: 'in',
  },
  'assumptions:write': {
    title: 'Cost assumptions from Turnrow Farm',
    blurb: 'Cost per acre by crop, with the irrigated, dryland, and double-crop breakouts, feeding the Marketing and Budget pages.',
    direction: 'in',
  },
  'settlements:write': {
    title: 'Landowner statements from Turnrow Farm',
    blurb: 'Finalized landowner rent statements, kept here for the landowner shares that opt into them.',
    direction: 'in',
  },
}

export function isFarmLinkScope(s: unknown): s is FarmLinkScope {
  return typeof s === 'string' && (FARM_LINK_SCOPES as readonly string[]).includes(s)
}

/** Unknown or duplicate entries drop out; order follows FARM_LINK_SCOPES. */
export function normalizeScopes(input: unknown): FarmLinkScope[] {
  const set = new Set<string>(Array.isArray(input) ? input.filter((s) => typeof s === 'string') : [])
  return FARM_LINK_SCOPES.filter((s) => set.has(s))
}

export type ScopeDenied = { error: string; code: 'missing_scope'; scope: FarmLinkScope }

/** The 403 body when a link lacks a scope, or null when allowed. */
export function scopeDenied(granted: readonly string[], required: FarmLinkScope): ScopeDenied | null {
  if (granted.includes(required)) return null
  return {
    error: `This link does not include ${FARM_LINK_SCOPE_LABELS[required].title.toLowerCase()}. Turn it on under Settings > Turnrow Farm link in Turnrow Grain.`,
    code: 'missing_scope',
    scope: required,
  }
}

// ---------------------------------------------------------------------------
// Pairing codes and tokens
// ---------------------------------------------------------------------------

export const PAIRING_CODE_PREFIX = 'fl_'
export const LINK_TOKEN_PREFIX = 'flt_'
export const PAIRING_CODE_TTL_DAYS = 7

/** Builds the secret from caller-supplied random hex (pure — the caller draws
 *  the bytes: crypto.getRandomValues in the browser, randomBytes on the
 *  server). The plaintext is shown once; only its sha256 is stored. */
export function formatFarmLinkSecret(kind: 'code' | 'token', randomHex: string): string {
  const hex = randomHex.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (hex.length < 32) throw new Error('farm link secret needs at least 16 random bytes')
  return `${kind === 'code' ? PAIRING_CODE_PREFIX : LINK_TOKEN_PREFIX}${hex}`
}

export function looksLikePairingCode(s: unknown): s is string {
  return typeof s === 'string' && /^fl_[0-9a-f]{32,}$/.test(s.trim())
}
export function looksLikeLinkToken(s: unknown): s is string {
  return typeof s === 'string' && /^flt_[0-9a-f]{32,}$/.test(s.trim())
}

export type FarmLinkStatus = 'pending' | 'active' | 'revoked'

export type FarmLinkRow = {
  id: string
  org_id: string
  code_hash: string
  code_expires_at: string
  token_hash: string | null
  token_rotated_at: string | null
  farm_org_id: string | null
  farm_org_name: string | null
  scopes: string[]
  status: FarmLinkStatus
  created_by: string | null
  redeemed_at: string | null
  revoked_at: string | null
  last_seen_at: string | null
  last_sync: FarmLinkLastSync
  created_at: string
  updated_at: string
}

export type FarmLinkLastSync = {
  inbound?: { at: string; endpoint: string; counts: Record<string, number>; conflicts?: number } | null
  outbound?: { at: string; endpoint: string; count: number } | null
  [k: string]: unknown
}

export type HandshakeVerdict =
  | { ok: true }
  | { ok: false; status: number; error: string; code: 'invalid_code' | 'link_revoked' | 'code_used' | 'code_expired' }

/** Redemption rules for a pairing code: unknown → 404, revoked → 403, already
 *  redeemed → 409 (one-time), expired → 410. */
export function evaluateHandshake(link: Pick<FarmLinkRow, 'status' | 'redeemed_at' | 'code_expires_at'> | null, now: Date): HandshakeVerdict {
  if (!link) return { ok: false, status: 404, error: 'That pairing code is not valid. Generate a new one in Turnrow Grain under Settings > Turnrow Farm link.', code: 'invalid_code' }
  if (link.status === 'revoked') return { ok: false, status: 403, error: 'This link was revoked in Turnrow Grain.', code: 'link_revoked' }
  if (link.redeemed_at) return { ok: false, status: 409, error: 'That pairing code was already used. Generate a new one in Turnrow Grain.', code: 'code_used' }
  if (new Date(link.code_expires_at).getTime() < now.getTime()) {
    return { ok: false, status: 410, error: 'That pairing code has expired. Generate a new one in Turnrow Grain.', code: 'code_expired' }
  }
  return { ok: true }
}

export type TokenVerdict = { ok: true } | { ok: false; status: 401; error: string; code: 'unknown_token' | 'link_revoked' | 'link_pending' }

/** Bearer-token rules: unknown → 401, revoked → 401 (a revoked link is as
 *  good as no link), a pending link whose token was never issued → 401. */
export function evaluateToken(link: Pick<FarmLinkRow, 'status' | 'token_hash'> | null): TokenVerdict {
  if (!link || !link.token_hash) return { ok: false, status: 401, error: 'Unauthorized', code: 'unknown_token' }
  if (link.status === 'revoked') return { ok: false, status: 401, error: 'This link was revoked in Turnrow Grain.', code: 'link_revoked' }
  if (link.status !== 'active') return { ok: false, status: 401, error: 'This link has not completed its handshake.', code: 'link_pending' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Cursor paging — (updated_at, id) ordering, opaque base64url cursor
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_LIMIT = 500
export const MAX_PAGE_LIMIT = 1000

export function parseLimit(raw: string | null | undefined, def = DEFAULT_PAGE_LIMIT, max = MAX_PAGE_LIMIT): number {
  if (raw == null || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return def
  return Math.min(n, max)
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function b64urlDecode(s: string): string | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
}

export type Cursor = { updatedAt: string; id: string }

export function encodeCursor(c: Cursor): string {
  return b64urlEncode(`${c.updatedAt}|${c.id}`)
}
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null
  const s = b64urlDecode(raw)
  if (!s) return null
  const i = s.indexOf('|')
  if (i <= 0) return null
  return { updatedAt: s.slice(0, i), id: s.slice(i + 1) }
}

type Pageable = { id: string; updated_at: string | null }

function afterCursor(r: Pageable, c: Cursor): boolean {
  const u = r.updated_at ?? ''
  if (u !== c.updatedAt) return u > c.updatedAt
  return r.id > c.id
}

/** Stable (updated_at, id) ordering; `since` keeps records updated on/after
 *  it; the cursor resumes strictly after the last record served. */
export function pageRecords<T extends Pageable>(
  records: readonly T[],
  opts: { limit: number; cursor?: Cursor | null; since?: string | null },
): { data: T[]; next_cursor: string | null } {
  let rows = [...records].sort((a, b) => (a.updated_at ?? '').localeCompare(b.updated_at ?? '') || a.id.localeCompare(b.id))
  if (opts.since) rows = rows.filter((r) => r.updated_at != null && r.updated_at >= opts.since!)
  if (opts.cursor) rows = rows.filter((r) => afterCursor(r, opts.cursor!))
  const data = rows.slice(0, opts.limit)
  const last = data[data.length - 1]
  const next_cursor = rows.length > opts.limit && last ? encodeCursor({ updatedAt: last.updated_at ?? '', id: last.id }) : null
  return { data, next_cursor }
}

/** ?since= must be an ISO date or timestamp; returns null when absent, or an
 *  error string when malformed. */
export function validateSince(raw: string | null | undefined): { since: string | null; error?: string } {
  if (!raw) return { since: null }
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return { since: null, error: '?since= must be an ISO date or timestamp (e.g. 2026-01-31 or 2026-01-31T00:00:00Z).' }
  return { since: raw }
}

// ---------------------------------------------------------------------------
// The id map
// ---------------------------------------------------------------------------

export const GRAIN_LINK_TABLES = ['entities', 'farms', 'fields', 'field_plantings', 'field_planting_varieties', 'crops', 'landowners'] as const
export type GrainLinkTable = (typeof GRAIN_LINK_TABLES)[number]
export function isGrainLinkTable(s: unknown): s is GrainLinkTable {
  return typeof s === 'string' && (GRAIN_LINK_TABLES as readonly string[]).includes(s)
}

export type IdMapRow = { grain_table: string; grain_id: string; farm_uid: string; linked_by?: string; linked_at?: string }

/** Two-way lookup over farm_link_ids for one organization. */
export class IdMap {
  private byGrain = new Map<string, string>()
  private byFarm = new Map<string, string>()
  constructor(rows: readonly IdMapRow[] = []) {
    for (const r of rows) this.add(r.grain_table, r.grain_id, r.farm_uid)
  }
  add(table: string, grainId: string, farmUid: string) {
    this.byGrain.set(`${table}|${grainId}`, farmUid)
    this.byFarm.set(`${table}|${farmUid}`, grainId)
  }
  farmUid(table: string, grainId: string | null | undefined): string | null {
    return grainId ? this.byGrain.get(`${table}|${grainId}`) ?? null : null
  }
  grainId(table: string, farmUid: string | null | undefined): string | null {
    return farmUid ? this.byFarm.get(`${table}|${farmUid}`) ?? null : null
  }
}

export type LinkRequest = { grain_table: string; grain_id: string; farm_uid: string }
export type LinkVerdict = LinkRequest & { action: 'linked' | 'unchanged' | 'rejected'; reason?: string }

/** Validates a batch of confirmed matches against the existing map: a
 *  grain_id or farm_uid already mapped to something else is rejected (never
 *  silently re-pointed); an identical existing pair is 'unchanged'. Duplicates
 *  inside the batch reject too. */
export function validateLinkRequests(
  requests: readonly LinkRequest[],
  map: IdMap,
  existingGrainIds: ReadonlyMap<string, ReadonlySet<string>>,
): LinkVerdict[] {
  const seenGrain = new Set<string>()
  const seenFarm = new Set<string>()
  return requests.map((r) => {
    const table = String(r.grain_table ?? '')
    const grainId = String(r.grain_id ?? '').trim()
    const farmUid = String(r.farm_uid ?? '').trim()
    const base = { grain_table: table, grain_id: grainId, farm_uid: farmUid }
    if (!isGrainLinkTable(table)) return { ...base, action: 'rejected', reason: `unknown grain_table "${table}"` }
    if (!grainId || !farmUid) return { ...base, action: 'rejected', reason: 'grain_id and farm_uid are required' }
    if (!existingGrainIds.get(table)?.has(grainId)) return { ...base, action: 'rejected', reason: `no ${table} row with id ${grainId}` }
    const currentFarm = map.farmUid(table, grainId)
    const currentGrain = map.grainId(table, farmUid)
    if (currentFarm && currentFarm !== farmUid) return { ...base, action: 'rejected', reason: `grain_id ${grainId} is already linked to farm_uid ${currentFarm}` }
    if (currentGrain && currentGrain !== grainId) return { ...base, action: 'rejected', reason: `farm_uid ${farmUid} is already linked to grain_id ${currentGrain}` }
    const gKey = `${table}|${grainId}`
    const fKey = `${table}|${farmUid}`
    if (seenGrain.has(gKey) || seenFarm.has(fKey)) return { ...base, action: 'rejected', reason: 'duplicate within this request' }
    seenGrain.add(gKey)
    seenFarm.add(fKey)
    if (currentFarm === farmUid && currentGrain === grainId) return { ...base, action: 'unchanged' }
    return { ...base, action: 'linked' }
  })
}

// ---------------------------------------------------------------------------
// Grain-side land state (what the planner and the snapshot read)
// ---------------------------------------------------------------------------

export type ManagedBy = 'turnrow_farm' | null

export type EntityState = { id: string; name: string; entity_role: string | null; managed_by?: ManagedBy; archived_at?: string | null; updated_at: string | null }
export type LandownerState = { id: string; name: string; updated_at?: string | null }
export type FarmState = {
  id: string; name: string; entity_id: string | null; fsa_number: string | null; county_id: string | null
  landowner_id: string | null; is_share_rent: boolean; landlord_share_percentage: number | string | null
  cash_rent_per_acre: number | string | null; managed_by?: ManagedBy; archived_at?: string | null; updated_at: string | null
}
export type FieldState = {
  id: string; farm_id: string | null; name_or_number: string; total_acres: number | string | null
  irrigated_acres: number | string | null; county_id: string | null; managed_by?: ManagedBy; archived_at?: string | null; updated_at: string | null
}
export type CropState = { id: string; name: string; harvest_category: 'fall' | 'spring'; double_crop: boolean; updated_at?: string | null }
export type PlantingState = {
  id: string; field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null
  planting_date: string | null; paired_planting_id: string | null; irrigated_acres: number | string | null
  managed_by?: ManagedBy; archived_at?: string | null; updated_at: string | null
}
export type VarietyState = { id: string; planting_id: string; variety: string; acres: number | string | null; bushels: number | string | null }
export type CountyState = { id: string; name: string; state_code: string }

export type LandState = {
  entities: readonly EntityState[]
  landowners: readonly LandownerState[]
  farms: readonly FarmState[]
  fields: readonly FieldState[]
  crops: readonly CropState[]
  plantings: readonly PlantingState[]
  varieties: readonly VarietyState[]
  counties: readonly CountyState[]
  idMap: IdMap
  /** Fields that carry loads, splits, combine entries, or gin receipts. */
  fieldIdsWithData: ReadonlySet<string>
  /** `${field_id}|${crop_id}|${season_year}` keys that carry harvest data. */
  plantingKeysWithData: ReadonlySet<string>
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

// ---------------------------------------------------------------------------
// GET /land/snapshot
// ---------------------------------------------------------------------------

export type SnapshotVariety = { id: string; variety: string; acres: number; bushels: number | null; farm_uid: string | null }

export function buildLandSnapshot(state: LandState, seasonYears: readonly number[] | null) {
  const countyById = new Map(state.counties.map((c) => [c.id, c]))
  const county = (id: string | null) => {
    const c = id ? countyById.get(id) : null
    return c ? { county: c.name, state: c.state_code } : { county: null, state: null }
  }
  const varietiesByPlanting = new Map<string, SnapshotVariety[]>()
  for (const v of state.varieties) {
    const list = varietiesByPlanting.get(v.planting_id) ?? []
    list.push({ id: v.id, variety: v.variety, acres: num(v.acres) ?? 0, bushels: num(v.bushels), farm_uid: state.idMap.farmUid('field_planting_varieties', v.id) })
    varietiesByPlanting.set(v.planting_id, list)
  }
  const live = <T extends { archived_at?: string | null }>(rows: readonly T[]) => rows.filter((r) => !r.archived_at)
  const years = seasonYears && seasonYears.length > 0 ? new Set(seasonYears) : null
  return {
    entities: live(state.entities).map((e) => ({
      id: e.id, name: e.name, entity_role: e.entity_role ?? 'farming', managed_by: e.managed_by ?? null,
      farm_uid: state.idMap.farmUid('entities', e.id), updated_at: e.updated_at,
    })),
    landowners: state.landowners.map((l) => ({
      id: l.id, name: l.name, farm_uid: state.idMap.farmUid('landowners', l.id), updated_at: l.updated_at ?? null,
    })),
    farms: live(state.farms).map((f) => ({
      id: f.id, name: f.name, entity_id: f.entity_id, farm_code: f.fsa_number, ...county(f.county_id),
      landowner_id: f.landowner_id, is_share_rent: !!f.is_share_rent,
      landlord_share_percentage: num(f.landlord_share_percentage), cash_rent_per_acre: num(f.cash_rent_per_acre),
      managed_by: f.managed_by ?? null, farm_uid: state.idMap.farmUid('farms', f.id), updated_at: f.updated_at,
    })),
    fields: live(state.fields).map((f) => ({
      id: f.id, farm_id: f.farm_id, name_or_number: f.name_or_number, total_acres: num(f.total_acres),
      irrigated_acres: num(f.irrigated_acres) ?? 0, ...county(f.county_id),
      managed_by: f.managed_by ?? null, farm_uid: state.idMap.farmUid('fields', f.id), updated_at: f.updated_at,
    })),
    crops: state.crops.map((c) => ({
      id: c.id, name: c.name, harvest_category: c.harvest_category, double_crop: !!c.double_crop,
      farm_uid: state.idMap.farmUid('crops', c.id), updated_at: c.updated_at ?? null,
    })),
    field_plantings: live(state.plantings)
      .filter((p) => years == null || years.has(p.season_year))
      .map((p) => ({
        id: p.id, field_id: p.field_id, crop_id: p.crop_id, season_year: p.season_year,
        planted_acres: num(p.planted_acres) ?? 0, planting_date: p.planting_date, paired_planting_id: p.paired_planting_id,
        irrigated_acres: num(p.irrigated_acres) ?? 0, varieties: varietiesByPlanting.get(p.id) ?? [],
        managed_by: p.managed_by ?? null, farm_uid: state.idMap.farmUid('field_plantings', p.id), updated_at: p.updated_at,
      })),
  }
}
export type LandSnapshot = ReturnType<typeof buildLandSnapshot>

// ---------------------------------------------------------------------------
// POST /land/sync — the planner
// ---------------------------------------------------------------------------

export type SyncEntity = { farm_uid: string; name: string; entity_role?: string | null; force?: boolean }
export type SyncLandowner = { farm_uid: string; name: string; force?: boolean }
export type SyncCrop = { farm_uid?: string | null; name: string; harvest_category?: string | null; double_crop?: boolean | null }
export type SyncFarm = {
  farm_uid: string; name: string; entity_farm_uid?: string | null; farm_code?: string | null
  county?: string | null; state?: string | null; landowner_farm_uid?: string | null
  is_share_rent?: boolean | null; landlord_share_percentage?: number | string | null; cash_rent_per_acre?: number | string | null
  force?: boolean
}
export type SyncField = {
  farm_uid: string; farm_farm_uid: string; name_or_number: string; total_acres?: number | string | null
  irrigated_acres?: number | string | null; county?: string | null; state?: string | null; force?: boolean
}
export type SyncVariety = { variety: string; acres?: number | string | null; bushels?: number | string | null } | string
export type SyncPlanting = {
  farm_uid: string; field_farm_uid: string; crop: string; season_year: number | string
  planted_acres?: number | string | null; planting_date?: string | null; irrigated_acres?: number | string | null
  preceding_farm_uid?: string | null; varieties?: SyncVariety[] | null; force?: boolean
}
export type SyncDeletion = { grain_table: string; farm_uid: string }

export type SyncBatch = {
  entities?: SyncEntity[]
  landowners?: SyncLandowner[]
  crops?: SyncCrop[]
  farms?: SyncFarm[]
  fields?: SyncField[]
  plantings?: SyncPlanting[]
  deletions?: SyncDeletion[]
}

export const SYNC_BATCH_MAX = 500

export function countBatchRecords(b: SyncBatch): number {
  return (b.entities?.length ?? 0) + (b.landowners?.length ?? 0) + (b.crops?.length ?? 0) + (b.farms?.length ?? 0)
    + (b.fields?.length ?? 0) + (b.plantings?.length ?? 0) + (b.deletions?.length ?? 0)
}

export type SyncAction = 'created' | 'updated' | 'unchanged' | 'conflict' | 'refused' | 'archived'

export type SyncRecordResult = {
  grain_table: GrainLinkTable
  farm_uid: string
  /** Null for a created row until the apply step fills it (the route does). */
  grain_id: string | null
  action: SyncAction
  reason?: string
  /** On 'conflict': Grain's current values for the fields Farm sent. */
  grain_values?: Record<string, unknown>
  /** Internal: the $ref key for a created row (the route resolves grain_id). */
  ref?: string
}

/** One op for farm_link_apply (see the 087 migration). */
export type ApplyOp =
  | { op: 'insert'; table: string; ref: string; values: Record<string, unknown> }
  | { op: 'update'; table: string; id: string | { $ref: string }; values: Record<string, unknown> }
  | { op: 'archive'; table: string; id: string }
  | { op: 'replace_varieties'; planting: string | { $ref: string }; varieties: Array<{ variety: string; acres: number; bushels: number | null }> }
  | { op: 'link'; grain_table: GrainLinkTable; grain_id: string | { $ref: string }; farm_uid: string; linked_by: 'sync' | 'match' }

export type SyncPlan = {
  ops: ApplyOp[]
  results: SyncRecordResult[]
  counts: Record<SyncAction, number>
}

type Ref = string | { $ref: string }

/** The conflict rule: an unmanaged Grain row edited after the last sync (or
 *  never synced) whose values differ from Farm's is a conflict — Grain's
 *  values are returned, never overwritten silently. Once managed_by is set,
 *  Farm's values win. `force` on the record overrides the conflict. */
export function isConflict(row: { managed_by?: ManagedBy; updated_at: string | null }, lastSyncAt: string | null, force?: boolean): boolean {
  if (force) return false
  if (row.managed_by === 'turnrow_farm') return false
  if (lastSyncAt == null) return true
  return (row.updated_at ?? '') > lastSyncAt
}

function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (typeof a === 'number' || typeof b === 'number') return num(a) === num(b)
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b)
  return norm(str(a)) === norm(str(b))
}

/** Which of Farm's values differ from Grain's row. */
function diff(target: Record<string, unknown>, current: Record<string, unknown>): { changed: Record<string, unknown>; grain: Record<string, unknown> } {
  const changed: Record<string, unknown> = {}
  const grain: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(target)) {
    if (!same(v, current[k])) { changed[k] = v; grain[k] = current[k] ?? null }
  }
  return { changed, grain }
}

export function planLandSync(batch: SyncBatch, state: LandState, opts: { lastSyncAt: string | null }): SyncPlan {
  const ops: ApplyOp[] = []
  const results: SyncRecordResult[] = []
  const counts: Record<SyncAction, number> = { created: 0, updated: 0, unchanged: 0, conflict: 0, refused: 0, archived: 0 }
  const map = state.idMap
  const lastSyncAt = opts.lastSyncAt

  // Refs for rows created in this batch, so later records can point at them.
  const created = new Map<string, Ref>() // `${table}|${farm_uid}` → $ref
  const refFor = (table: GrainLinkTable, farmUid: string): Ref | null => {
    const existing = map.grainId(table, farmUid)
    if (existing) return existing
    return created.get(`${table}|${farmUid}`) ?? null
  }
  const push = (r: SyncRecordResult) => { results.push(r); counts[r.action]++ }

  const entityById = new Map(state.entities.map((e) => [e.id, e]))
  const landownerById = new Map(state.landowners.map((l) => [l.id, l]))
  const farmById = new Map(state.farms.map((f) => [f.id, f]))
  const fieldById = new Map(state.fields.map((f) => [f.id, f]))
  const cropById = new Map(state.crops.map((c) => [c.id, c]))
  const plantingById = new Map(state.plantings.map((p) => [p.id, p]))
  const cropByName = new Map(state.crops.map((c) => [norm(c.name), c]))
  const countyByKey = new Map(state.counties.map((c) => [`${normalizeCountyName(c.name)}|${c.state_code.toUpperCase()}`, c]))
  const varietiesByPlanting = new Map<string, VarietyState[]>()
  for (const v of state.varieties) {
    const list = varietiesByPlanting.get(v.planting_id) ?? []
    list.push(v)
    varietiesByPlanting.set(v.planting_id, list)
  }

  const resolveCounty = (countyName: string | null | undefined, stateCode: string | null | undefined): { id: string | null; error?: string } => {
    const c = str(countyName)
    if (!c) return { id: null }
    const s = str(stateCode)
    if (!s) return { id: null, error: `county "${c}" needs a state` }
    const hit = countyByKey.get(`${normalizeCountyName(c)}|${s.toUpperCase()}`)
    return hit ? { id: hit.id } : { id: null, error: `county "${c}, ${s}" not found` }
  }

  // Generic upsert of one record onto one table.
  function upsert<TRow extends { id: string; managed_by?: ManagedBy; updated_at: string | null }>(args: {
    table: GrainLinkTable
    farmUid: string
    force?: boolean
    current: TRow | null
    /** Farm's values (already resolved to Grain ids / refs). */
    target: Record<string, unknown>
    /** Values compared for change detection (refs excluded). */
    comparable: Record<string, unknown>
    /** Extra ops to emit after the row exists (varieties). */
    after?: (rowRef: Ref) => void
    /** Match found by name rather than the id map (link with 'match'). */
    matchedByName?: boolean
    managed?: boolean
  }): Ref | null {
    const { table, farmUid, current, target } = args
    const managedValues = args.managed === false ? {} : { managed_by: 'turnrow_farm' }
    if (!current) {
      const ref = `${table}:${farmUid}`
      ops.push({ op: 'insert', table, ref, values: { ...target, ...managedValues } })
      ops.push({ op: 'link', grain_table: table, grain_id: { $ref: ref }, farm_uid: farmUid, linked_by: 'sync' })
      created.set(`${table}|${farmUid}`, { $ref: ref })
      push({ grain_table: table, farm_uid: farmUid, grain_id: null, action: 'created', ref })
      args.after?.({ $ref: ref })
      return { $ref: ref }
    }
    const currentRec = current as unknown as Record<string, unknown>
    const { changed, grain } = diff(args.comparable, currentRec)
    if (args.matchedByName) {
      ops.push({ op: 'link', grain_table: table, grain_id: current.id, farm_uid: farmUid, linked_by: 'match' })
    }
    // Later records in this batch resolve the parent by farm_uid whether it
    // was mapped before, matched by name just now, or even left in conflict
    // (the link itself stands; only the values are held back).
    created.set(`${table}|${farmUid}`, current.id)
    const needsManaged = args.managed !== false && current.managed_by !== 'turnrow_farm'
    if (Object.keys(changed).length === 0) {
      if (needsManaged) ops.push({ op: 'update', table, id: current.id, values: managedValues })
      push({ grain_table: table, farm_uid: farmUid, grain_id: current.id, action: 'unchanged' })
      args.after?.(current.id)
      return current.id
    }
    if (isConflict(current, lastSyncAt, args.force)) {
      push({
        grain_table: table, farm_uid: farmUid, grain_id: current.id, action: 'conflict',
        reason: 'edited in Turnrow Grain since the last sync; send force: true to overwrite with Turnrow Farm\'s values',
        grain_values: grain,
      })
      return current.id
    }
    // Only the changed fields (and any ref-valued fields that changed) go in
    // the update, so an untouched Grain column never gets clobbered.
    const values: Record<string, unknown> = {}
    for (const k of Object.keys(changed)) if (!k.startsWith('__')) values[k] = target[k]
    ops.push({ op: 'update', table, id: current.id, values: { ...values, ...managedValues } })
    push({ grain_table: table, farm_uid: farmUid, grain_id: current.id, action: 'updated' })
    args.after?.(current.id)
    return current.id
  }

  // 1. entities -------------------------------------------------------------
  for (const e of batch.entities ?? []) {
    const farmUid = str(e.farm_uid)
    const name = str(e.name)
    if (!farmUid || !name) { push({ grain_table: 'entities', farm_uid: farmUid ?? '', grain_id: null, action: 'refused', reason: 'farm_uid and name are required' }); continue }
    const role = e.entity_role === 'marketing_agent' ? 'marketing_agent' : 'farming'
    const mappedId = map.grainId('entities', farmUid)
    let current = mappedId ? entityById.get(mappedId) ?? null : null
    let matchedByName = false
    if (!current) {
      const byName = state.entities.find((x) => norm(x.name) === norm(name) && !map.farmUid('entities', x.id))
      if (byName) { current = byName; matchedByName = true }
    }
    const target = { name, entity_role: role }
    upsert({ table: 'entities', farmUid, force: e.force, current, target, comparable: target, matchedByName })
  }

  // 2. landowners -----------------------------------------------------------
  for (const l of batch.landowners ?? []) {
    const farmUid = str(l.farm_uid)
    const name = str(l.name)
    if (!farmUid || !name) { push({ grain_table: 'landowners', farm_uid: farmUid ?? '', grain_id: null, action: 'refused', reason: 'farm_uid and name are required' }); continue }
    const mappedId = map.grainId('landowners', farmUid)
    let current = mappedId ? landownerById.get(mappedId) ?? null : null
    let matchedByName = false
    if (!current) {
      const byName = state.landowners.find((x) => norm(x.name) === norm(name) && !map.farmUid('landowners', x.id))
      if (byName) { current = byName; matchedByName = true }
    }
    const target = { name }
    upsert({
      table: 'landowners', farmUid, force: l.force,
      current: current ? { ...current, updated_at: current.updated_at ?? null } : null,
      target, comparable: target, matchedByName, managed: false,
    })
  }

  // 3. crops ----------------------------------------------------------------
  // Farm's crops are slug-keyed; farm_uid is optional (the name is the key
  // when absent). A name Grain lacks (Sunflower) becomes a per-org crop.
  // `quiet`: a planting naming an existing crop is not a crop record in the
  // response (only creates and updates are reported for it).
  const ensureCrop = (c: SyncCrop, reasonNote?: string, quiet = false): Ref | null => {
    const name = str(c.name)
    if (!name) return null
    const farmUid = str(c.farm_uid) ?? `crop:${norm(name)}`
    const mappedId = c.farm_uid ? map.grainId('crops', farmUid) : null
    let current = mappedId ? cropById.get(mappedId) ?? null : cropByName.get(norm(name)) ?? null
    const matchedByName = !mappedId && !!current && !!c.farm_uid
    const target: Record<string, unknown> = { name }
    if (c.harvest_category === 'fall' || c.harvest_category === 'spring') target.harvest_category = c.harvest_category
    if (typeof c.double_crop === 'boolean') target.double_crop = c.double_crop
    if (!current) {
      const already = created.get(`crops|${farmUid}`)
      if (already) return already
      const ref = `crops:${farmUid}`
      ops.push({ op: 'insert', table: 'crops', ref, values: { name, harvest_category: target.harvest_category ?? 'fall', double_crop: target.double_crop ?? false } })
      if (c.farm_uid) ops.push({ op: 'link', grain_table: 'crops', grain_id: { $ref: ref }, farm_uid: farmUid, linked_by: 'sync' })
      created.set(`crops|${farmUid}`, { $ref: ref })
      cropByName.set(norm(name), { id: ref, name, harvest_category: (target.harvest_category as 'fall' | 'spring') ?? 'fall', double_crop: Boolean(target.double_crop) })
      push({ grain_table: 'crops', farm_uid: farmUid, grain_id: null, action: 'created', ref, reason: reasonNote })
      return { $ref: ref }
    }
    if (current.id.startsWith('crops:')) return { $ref: current.id } // created earlier in this batch
    if (matchedByName) ops.push({ op: 'link', grain_table: 'crops', grain_id: current.id, farm_uid: farmUid, linked_by: 'match' })
    created.set(`crops|${farmUid}`, current.id)
    const { changed } = diff(target, current as unknown as Record<string, unknown>)
    if (Object.keys(changed).length > 0) {
      ops.push({ op: 'update', table: 'crops', id: current.id, values: changed })
      push({ grain_table: 'crops', farm_uid: farmUid, grain_id: current.id, action: 'updated' })
    } else if (!quiet) {
      push({ grain_table: 'crops', farm_uid: farmUid, grain_id: current.id, action: 'unchanged' })
    }
    return current.id
  }
  for (const c of batch.crops ?? []) ensureCrop(c)

  // 4. farms ----------------------------------------------------------------
  for (const f of batch.farms ?? []) {
    const farmUid = str(f.farm_uid)
    const name = str(f.name)
    if (!farmUid || !name) { push({ grain_table: 'farms', farm_uid: farmUid ?? '', grain_id: null, action: 'refused', reason: 'farm_uid and name are required' }); continue }
    const entityRef = f.entity_farm_uid ? refFor('entities', String(f.entity_farm_uid)) : null
    if (f.entity_farm_uid && !entityRef) { push({ grain_table: 'farms', farm_uid: farmUid, grain_id: null, action: 'refused', reason: `entity ${f.entity_farm_uid} is not linked — send it in the same batch or link it first` }); continue }
    const landownerRef = f.landowner_farm_uid ? refFor('landowners', String(f.landowner_farm_uid)) : null
    if (f.landowner_farm_uid && !landownerRef) { push({ grain_table: 'farms', farm_uid: farmUid, grain_id: null, action: 'refused', reason: `landowner ${f.landowner_farm_uid} is not linked — send it in the same batch or link it first` }); continue }
    const county = resolveCounty(f.county, f.state)
    if (county.error) { push({ grain_table: 'farms', farm_uid: farmUid, grain_id: null, action: 'refused', reason: county.error }); continue }
    const shareRent = Boolean(f.is_share_rent)
    const sharePct = shareRent ? num(f.landlord_share_percentage) : null
    if (shareRent && sharePct == null) { push({ grain_table: 'farms', farm_uid: farmUid, grain_id: null, action: 'refused', reason: 'is_share_rent needs landlord_share_percentage' }); continue }

    const mappedId = map.grainId('farms', farmUid)
    let current = mappedId ? farmById.get(mappedId) ?? null : null
    let matchedByName = false
    if (!current) {
      // Farm's documented key: name + FSA number (when both sides carry one).
      // The entity only breaks a tie between same-named candidates — a farm
      // Grain filed under a different entity is still the same farm, and the
      // entity difference then surfaces through the conflict rule.
      const entityId = typeof entityRef === 'string' ? entityRef : null
      const candidates = state.farms.filter((x) =>
        norm(x.name) === norm(name) && !map.farmUid('farms', x.id) && !x.archived_at
        && (str(f.farm_code) == null || str(x.fsa_number) == null || norm(x.fsa_number) === norm(str(f.farm_code))))
      const byName = candidates.length <= 1 ? candidates[0] : (candidates.find((x) => x.entity_id === entityId) ?? candidates[0])
      if (byName) { current = byName; matchedByName = true }
    }
    const refValues: Record<string, unknown> = {}
    const comparable: Record<string, unknown> = {
      name, fsa_number: str(f.farm_code), county_id: county.id, is_share_rent: shareRent,
      landlord_share_percentage: sharePct, cash_rent_per_acre: num(f.cash_rent_per_acre),
    }
    if (f.entity_farm_uid !== undefined) {
      comparable.entity_id = typeof entityRef === 'string' ? entityRef : null
      if (entityRef && typeof entityRef !== 'string') refValues.entity_id = entityRef
    }
    if (f.landowner_farm_uid !== undefined) {
      comparable.landowner_id = typeof landownerRef === 'string' ? landownerRef : null
      if (landownerRef && typeof landownerRef !== 'string') refValues.landowner_id = landownerRef
    }
    // A $ref'd parent is by definition new, so the field counts as changed.
    const comparableForDiff = { ...comparable }
    for (const k of Object.keys(refValues)) comparableForDiff[k] = `__new__${k}`
    upsert({ table: 'farms', farmUid, force: f.force, current, target: { ...comparable, ...refValues }, comparable: comparableForDiff, matchedByName })
  }

  // 5. fields ---------------------------------------------------------------
  for (const fl of batch.fields ?? []) {
    const farmUid = str(fl.farm_uid)
    const name = str(fl.name_or_number)
    if (!farmUid || !name) { push({ grain_table: 'fields', farm_uid: farmUid ?? '', grain_id: null, action: 'refused', reason: 'farm_uid and name_or_number are required' }); continue }
    const farmRef = fl.farm_farm_uid ? refFor('farms', String(fl.farm_farm_uid)) : null
    if (!farmRef) { push({ grain_table: 'fields', farm_uid: farmUid, grain_id: null, action: 'refused', reason: `farm ${fl.farm_farm_uid ?? '(missing)'} is not linked — send it in the same batch or link it first` }); continue }
    const county = resolveCounty(fl.county, fl.state)
    if (county.error) { push({ grain_table: 'fields', farm_uid: farmUid, grain_id: null, action: 'refused', reason: county.error }); continue }
    const total = num(fl.total_acres)
    const irr = num(fl.irrigated_acres) ?? 0
    if (total != null && irr > total + 1e-9) { push({ grain_table: 'fields', farm_uid: farmUid, grain_id: null, action: 'refused', reason: 'irrigated_acres exceeds total_acres' }); continue }

    const mappedId = map.grainId('fields', farmUid)
    let current = mappedId ? fieldById.get(mappedId) ?? null : null
    let matchedByName = false
    if (!current && typeof farmRef === 'string') {
      const byName = state.fields.find((x) => x.farm_id === farmRef && norm(x.name_or_number) === norm(name) && !map.farmUid('fields', x.id) && !x.archived_at)
      if (byName) { current = byName; matchedByName = true }
    }
    const comparable: Record<string, unknown> = { name_or_number: name, total_acres: total, irrigated_acres: irr, farm_id: typeof farmRef === 'string' ? farmRef : '__new__farm' }
    if (fl.county !== undefined) comparable.county_id = county.id
    const target: Record<string, unknown> = { ...comparable, farm_id: farmRef }
    upsert({ table: 'fields', farmUid, force: fl.force, current, target, comparable, matchedByName })
  }

  // 6. plantings ------------------------------------------------------------
  // Two passes: rows first (pairing omitted), then paired_planting_id once
  // every planting in the batch has a ref, so a pair created in the same
  // batch resolves regardless of order.
  const plantingRefs = new Map<string, Ref>() // farm_uid → ref/id
  const pairingWanted: Array<{ farmUid: string; precedingUid: string; rowRef: Ref; currentPair: string | null }> = []
  const normVarieties = (vs: SyncVariety[] | null | undefined) => (vs ?? [])
    .map((v) => (typeof v === 'string' ? { variety: v, acres: 0, bushels: null } : { variety: str(v.variety) ?? '', acres: num(v.acres) ?? 0, bushels: num(v.bushels) }))
    .filter((v) => v.variety !== '')
  const varietyKey = (vs: Array<{ variety: string; acres: number; bushels: number | null }>) =>
    [...vs].map((v) => `${norm(v.variety)}|${v.acres}|${v.bushels ?? ''}`).sort().join(';')

  for (const p of batch.plantings ?? []) {
    const farmUid = str(p.farm_uid)
    if (!farmUid) { push({ grain_table: 'field_plantings', farm_uid: '', grain_id: null, action: 'refused', reason: 'farm_uid is required' }); continue }
    const fieldRef = p.field_farm_uid ? refFor('fields', String(p.field_farm_uid)) : null
    if (!fieldRef) { push({ grain_table: 'field_plantings', farm_uid: farmUid, grain_id: null, action: 'refused', reason: `field ${p.field_farm_uid ?? '(missing)'} is not linked — send it in the same batch or link it first` }); continue }
    const year = num(p.season_year)
    if (year == null || !Number.isInteger(year)) { push({ grain_table: 'field_plantings', farm_uid: farmUid, grain_id: null, action: 'refused', reason: 'season_year is required' }); continue }
    const cropName = str(p.crop)
    if (!cropName) { push({ grain_table: 'field_plantings', farm_uid: farmUid, grain_id: null, action: 'refused', reason: 'crop is required' }); continue }
    const cropRef = ensureCrop({ name: cropName }, 'created because a planting named it', true)
    if (!cropRef) { push({ grain_table: 'field_plantings', farm_uid: farmUid, grain_id: null, action: 'refused', reason: `crop "${cropName}" could not be resolved` }); continue }
    const planted = num(p.planted_acres)
    const irr = num(p.irrigated_acres) ?? 0
    if (planted != null && irr > planted + 1e-9) { push({ grain_table: 'field_plantings', farm_uid: farmUid, grain_id: null, action: 'refused', reason: 'irrigated_acres exceeds planted_acres' }); continue }

    const mappedId = map.grainId('field_plantings', farmUid)
    let current = mappedId ? plantingById.get(mappedId) ?? null : null
    let matchedByName = false
    if (!current && typeof fieldRef === 'string' && typeof cropRef === 'string') {
      const byKey = state.plantings.find((x) => x.field_id === fieldRef && x.crop_id === cropRef && x.season_year === year && !map.farmUid('field_plantings', x.id) && !x.archived_at)
      if (byKey) { current = byKey; matchedByName = true }
    }
    const vs = p.varieties === undefined ? null : normVarieties(p.varieties)
    const comparable: Record<string, unknown> = {
      field_id: typeof fieldRef === 'string' ? fieldRef : '__new__field',
      crop_id: typeof cropRef === 'string' ? cropRef : '__new__crop',
      season_year: year,
      planted_acres: planted ?? 0,
      irrigated_acres: irr,
    }
    if (p.planting_date !== undefined) comparable.planting_date = str(p.planting_date)
    const target: Record<string, unknown> = { ...comparable, field_id: fieldRef, crop_id: cropRef }
    // Varieties count toward "changed" when they differ as a set.
    const currentVarieties = current ? normVarieties((varietiesByPlanting.get(current.id) ?? []).map((v) => ({ variety: v.variety, acres: v.acres, bushels: v.bushels }))) : []
    const varietiesChanged = vs != null && (!current || varietyKey(vs) !== varietyKey(currentVarieties))
    if (varietiesChanged && current) comparable.__varieties = varietyKey(vs!)
    const rowRef = upsert({
      table: 'field_plantings', farmUid, force: p.force, current, target,
      comparable: current && varietiesChanged ? { ...comparable } : comparable, matchedByName,
      after: (ref) => { if (vs != null && (varietiesChanged || !current)) ops.push({ op: 'replace_varieties', planting: ref, varieties: vs }) },
    })
    if (rowRef) {
      plantingRefs.set(farmUid, rowRef)
      if (p.preceding_farm_uid !== undefined) {
        const last = results[results.length - 1]
        if (last.action !== 'conflict') {
          pairingWanted.push({ farmUid, precedingUid: str(p.preceding_farm_uid) ?? '', rowRef, currentPair: current?.paired_planting_id ?? null })
        }
      }
    }
  }
  for (const w of pairingWanted) {
    let pairRef: Ref | null = null
    if (w.precedingUid) {
      pairRef = plantingRefs.get(w.precedingUid) ?? map.grainId('field_plantings', w.precedingUid)
      if (!pairRef) {
        const r = results.find((x) => x.grain_table === 'field_plantings' && x.farm_uid === w.farmUid)
        if (r) r.reason = `preceding planting ${w.precedingUid} is not linked; pairing left as is`
        continue
      }
    }
    const currentPair = w.currentPair
    const unchanged = typeof pairRef === 'string' ? pairRef === currentPair : pairRef == null && currentPair == null
    if (unchanged) continue
    if (typeof w.rowRef === 'string') ops.push({ op: 'update', table: 'field_plantings', id: w.rowRef, values: { paired_planting_id: pairRef } })
    else {
      // Row created in this batch: the RPC resolves the $ref'd id from the
      // insert it ran earlier in the same call.
      ops.push({ op: 'update', table: 'field_plantings', id: w.rowRef, values: { paired_planting_id: pairRef } })
    }
  }

  // 7. deletions → archive (never delete) ----------------------------------
  const archivingFieldIds = new Set<string>()
  const archivingFarmIds = new Set<string>()
  for (const d of batch.deletions ?? []) {
    const table = String(d.grain_table ?? '')
    const farmUid = str(d.farm_uid) ?? ''
    if (!isGrainLinkTable(table) || !['entities', 'farms', 'fields', 'field_plantings'].includes(table)) {
      push({ grain_table: (isGrainLinkTable(table) ? table : 'fields'), farm_uid: farmUid, grain_id: null, action: 'refused', reason: `${table || '(missing)'} rows cannot be archived through the link` })
      continue
    }
    const grainId = map.grainId(table, farmUid)
    if (!grainId) { push({ grain_table: table, farm_uid: farmUid, grain_id: null, action: 'refused', reason: 'not linked — nothing to archive' }); continue }
    if (table === 'fields') {
      const f = fieldById.get(grainId)
      if (f?.archived_at) { push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'unchanged', reason: 'already archived' }); continue }
      if (state.fieldIdsWithData.has(grainId)) { push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'refused', reason: 'field has loads, yields, or settlements in Turnrow Grain' }); continue }
      archivingFieldIds.add(grainId)
    } else if (table === 'field_plantings') {
      const p = plantingById.get(grainId)
      if (p?.archived_at) { push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'unchanged', reason: 'already archived' }); continue }
      if (p && state.plantingKeysWithData.has(`${p.field_id}|${p.crop_id}|${p.season_year}`)) { push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'refused', reason: 'planting has loads, yields, or settlements in Turnrow Grain' }); continue }
    } else if (table === 'farms') {
      const f = farmById.get(grainId)
      if (f?.archived_at) { push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'unchanged', reason: 'already archived' }); continue }
      const liveFields = state.fields.filter((x) => x.farm_id === grainId && !x.archived_at && !archivingFieldIds.has(x.id))
      if (liveFields.length > 0) { push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'refused', reason: `farm still has ${liveFields.length} active field(s); archive them first` }); continue }
      archivingFarmIds.add(grainId)
    } else if (table === 'entities') {
      const e = entityById.get(grainId)
      if (e?.archived_at) { push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'unchanged', reason: 'already archived' }); continue }
      const liveFarms = state.farms.filter((x) => x.entity_id === grainId && !x.archived_at && !archivingFarmIds.has(x.id))
      if (liveFarms.length > 0) { push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'refused', reason: `entity still has ${liveFarms.length} active farm(s); archive them first` }); continue }
    }
    ops.push({ op: 'archive', table, id: grainId })
    push({ grain_table: table, farm_uid: farmUid, grain_id: grainId, action: 'archived' })
  }

  return { ops, results, counts }
}

/** After farm_link_apply returns its ref → id map, fill grain_id on created
 *  rows and drop the internal ref. */
export function resolveCreatedIds(results: readonly SyncRecordResult[], refs: Record<string, string>): SyncRecordResult[] {
  return results.map((r) => {
    const { ref, ...rest } = r
    if (ref && refs[ref]) return { ...rest, grain_id: refs[ref] }
    return rest
  })
}

// ---------------------------------------------------------------------------
// Data-bearing fields / plantings (for the archive refusals)
// ---------------------------------------------------------------------------

export function dataBearingKeys(args: {
  loads: ReadonlyArray<{ from_type: string | null; from_field_id: string | null; crop_id: string | null; crop_year: number | null }>
  splits: ReadonlyArray<{ field_id: string; crop_id: string; load_id: string }>
  loadYearById?: ReadonlyMap<string, number | null>
  combineEntries: ReadonlyArray<{ field_id: string; crop_id: string; crop_year: number }>
  ginReceipts: ReadonlyArray<{ field_id: string | null; crop_year: number }>
  cottonCropIds?: ReadonlySet<string>
  plantingsWithBreakout?: ReadonlyArray<{ field_id: string; crop_id: string; season_year: number; irrigated_bushels: number | string | null; dryland_bushels: number | string | null }>
}): { fieldIdsWithData: Set<string>; plantingKeysWithData: Set<string> } {
  const fieldIds = new Set<string>()
  const keys = new Set<string>()
  for (const l of args.loads) {
    if (l.from_type === 'field' && l.from_field_id) {
      fieldIds.add(l.from_field_id)
      if (l.crop_id && l.crop_year != null) keys.add(`${l.from_field_id}|${l.crop_id}|${l.crop_year}`)
    }
  }
  for (const s of args.splits) {
    fieldIds.add(s.field_id)
    const y = args.loadYearById?.get(s.load_id)
    if (y != null) keys.add(`${s.field_id}|${s.crop_id}|${y}`)
  }
  for (const c of args.combineEntries) { fieldIds.add(c.field_id); keys.add(`${c.field_id}|${c.crop_id}|${c.crop_year}`) }
  for (const g of args.ginReceipts) {
    if (!g.field_id) continue
    fieldIds.add(g.field_id)
    for (const cropId of args.cottonCropIds ?? []) keys.add(`${g.field_id}|${cropId}|${g.crop_year}`)
  }
  for (const p of args.plantingsWithBreakout ?? []) {
    if (num(p.irrigated_bushels) != null || num(p.dryland_bushels) != null) keys.add(`${p.field_id}|${p.crop_id}|${p.season_year}`)
  }
  return { fieldIdsWithData: fieldIds, plantingKeysWithData: keys }
}

// ---------------------------------------------------------------------------
// POST /assumptions
// ---------------------------------------------------------------------------

export type AssumptionRow = {
  crop: string
  cost_per_acre?: number | string | null
  cost_per_acre_irrigated?: number | string | null
  cost_per_acre_dryland?: number | string | null
  cost_per_acre_dc_irrigated?: number | string | null
  cost_per_acre_dc_dryland?: number | string | null
  source?: string | null
  computed_at?: string | null
}

export type AssumptionUpsert = {
  crop_id: string
  crop_year: number
  cost_per_acre: number | null
  cost_per_acre_irr: number | null
  cost_per_acre_dry: number | null
  cost_per_acre_dc_irr: number | null
  cost_per_acre_dc_dry: number | null
  cost_source: 'turnrow_farm'
  cost_source_updated_at: string
  /** 088: Turnrow Farm's cost per acre already carries the crop insurance
   *  premium (the push's `includes_insurance`), so Grain must not subtract its
   *  own premium again in any margin built on this row. */
  cost_includes_insurance: boolean
}

export type BudgetLineUpdate = { id: string; cost_per_acre: number | null; cost_source: 'turnrow_farm'; cost_source_updated_at: string }

export type AssumptionsPlan = {
  upserts: AssumptionUpsert[]
  budgetLineUpdates: BudgetLineUpdate[]
  results: Array<{ crop: string; action: 'updated' | 'skipped'; reason?: string; budget_lines_updated: number }>
}

/** Maps a budget line's practice × cropping cell to the cost breakout it
 *  follows (null/null = the blended overall figure). */
export function budgetCellCost(line: { practice: string | null; cropping: string | null }, row: AssumptionUpsert): number | null {
  const dc = line.cropping === 'double_crop'
  if (line.practice === 'irrigated') return (dc ? row.cost_per_acre_dc_irr : row.cost_per_acre_irr) ?? row.cost_per_acre
  if (line.practice === 'non_irrigated') return (dc ? row.cost_per_acre_dc_dry : row.cost_per_acre_dry) ?? row.cost_per_acre
  return row.cost_per_acre
}

export function planAssumptionsWrite(args: {
  cropYear: number
  rows: readonly AssumptionRow[]
  /** The push's `includes_insurance`: Turnrow Farm's cost per acre already
   *  carries the crop insurance premium. Absent = false = behave as before. */
  includesInsurance?: boolean
  crops: ReadonlyArray<{ id: string; name: string }>
  existing: ReadonlyArray<{ crop_id: string; crop_year: number; cost_manual_override?: boolean | null }>
  scenarios: ReadonlyArray<{ id: string; budget_crop_year: number; follow_farm_costs?: boolean | null }>
  budgetLines: ReadonlyArray<{ id: string; scenario_id: string; crop_id: string; practice: string | null; cropping: string | null }>
  now: string
}): AssumptionsPlan {
  const cropByName = new Map(args.crops.map((c) => [norm(c.name), c]))
  const existingByCrop = new Map(args.existing.filter((e) => e.crop_year === args.cropYear).map((e) => [e.crop_id, e]))
  const followingScenarioIds = new Set(args.scenarios.filter((s) => s.budget_crop_year === args.cropYear && s.follow_farm_costs).map((s) => s.id))
  const upserts: AssumptionUpsert[] = []
  const budgetLineUpdates: BudgetLineUpdate[] = []
  const results: AssumptionsPlan['results'] = []
  const seen = new Set<string>()
  for (const r of args.rows) {
    const name = str(r.crop)
    if (!name) { results.push({ crop: '', action: 'skipped', reason: 'crop is required', budget_lines_updated: 0 }); continue }
    const crop = cropByName.get(norm(name))
    if (!crop) { results.push({ crop: name, action: 'skipped', reason: `no crop named "${name}" in Turnrow Grain — sync land first`, budget_lines_updated: 0 }); continue }
    if (seen.has(crop.id)) { results.push({ crop: name, action: 'skipped', reason: 'duplicate crop in this request', budget_lines_updated: 0 }); continue }
    seen.add(crop.id)
    if (existingByCrop.get(crop.id)?.cost_manual_override) {
      results.push({ crop: name, action: 'skipped', reason: 'manual override is on in Turnrow Grain for this crop year', budget_lines_updated: 0 })
      continue
    }
    const stamp = str(r.computed_at) ?? args.now
    const up: AssumptionUpsert = {
      crop_id: crop.id, crop_year: args.cropYear,
      cost_per_acre: num(r.cost_per_acre),
      cost_per_acre_irr: num(r.cost_per_acre_irrigated),
      cost_per_acre_dry: num(r.cost_per_acre_dryland),
      cost_per_acre_dc_irr: num(r.cost_per_acre_dc_irrigated),
      cost_per_acre_dc_dry: num(r.cost_per_acre_dc_dryland),
      cost_source: 'turnrow_farm', cost_source_updated_at: stamp,
      cost_includes_insurance: !!args.includesInsurance,
    }
    upserts.push(up)
    let n = 0
    for (const line of args.budgetLines) {
      if (line.crop_id !== crop.id || !followingScenarioIds.has(line.scenario_id)) continue
      budgetLineUpdates.push({ id: line.id, cost_per_acre: budgetCellCost(line, up), cost_source: 'turnrow_farm', cost_source_updated_at: stamp })
      n++
    }
    results.push({ crop: name, action: 'updated', budget_lines_updated: n })
  }
  return { upserts, budgetLineUpdates, results }
}

// ---------------------------------------------------------------------------
// POST /settlements (landowner statements) + the partner share scope
// ---------------------------------------------------------------------------

export type LandownerSettlementInput = {
  farm_uid: string
  landowner_name: string
  landowner_farm_uid?: string | null
  crop_year: number | string
  lease_type?: string | null
  statement: unknown
  finalized_at?: string | null
  /** 089: 'withdrawn' is how Turnrow Farm deletes a statement. Grain keeps the
   *  row (a landowner may already have seen it) and stops serving it. */
  status?: string | null
}

export type LandownerSettlementUpsert = {
  farm_uid: string
  landowner_name: string
  landowner_farm_uid: string | null
  landowner_id: string | null
  crop_year: number
  lease_type: string | null
  statement: unknown
  finalized_at: string | null
  received_at: string
  status: LandownerSettlementStatus
}

export const LANDOWNER_SETTLEMENT_STATUSES = ['final', 'withdrawn'] as const
export type LandownerSettlementStatus = (typeof LANDOWNER_SETTLEMENT_STATUSES)[number]
export function isLandownerSettlementStatus(v: unknown): v is LandownerSettlementStatus {
  return v === 'final' || v === 'withdrawn'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validates one statement and resolves Grain's landowner: the id map first
 *  (landowners × landowner_farm_uid), then an exact name match. Unresolved
 *  stays null — and a null landowner_id is never served to a share. */
export function normalizeLandownerSettlement(
  input: LandownerSettlementInput,
  ctx: { idMap: IdMap; landowners: ReadonlyArray<{ id: string; name: string }>; now: string },
): { row: LandownerSettlementUpsert } | { error: string } {
  const farmUid = str(input.farm_uid)
  if (!farmUid || !UUID_RE.test(farmUid)) return { error: 'farm_uid (the lease year id) must be a uuid' }
  const name = str(input.landowner_name)
  if (!name) return { error: 'landowner_name is required' }
  const year = num(input.crop_year)
  if (year == null || !Number.isInteger(year)) return { error: 'crop_year is required' }
  const status = input.status == null ? 'final' : str(input.status)
  if (!isLandownerSettlementStatus(status)) return { error: "status must be 'final' or 'withdrawn'" }
  // A withdrawn statement is a tombstone: Farm deleted it, so its body is not
  // required (and is kept as an empty object when absent).
  if (status === 'final' && (input.statement == null || typeof input.statement !== 'object')) {
    return { error: 'statement must be an object' }
  }
  const loUid = str(input.landowner_farm_uid)
  let landownerId = loUid ? ctx.idMap.grainId('landowners', loUid) : null
  if (!landownerId) landownerId = ctx.landowners.find((l) => norm(l.name) === norm(name))?.id ?? null
  return {
    row: {
      farm_uid: farmUid, landowner_name: name, landowner_farm_uid: loUid, landowner_id: landownerId,
      crop_year: year, lease_type: str(input.lease_type), statement: input.statement,
      finalized_at: str(input.finalized_at), received_at: ctx.now, status,
    },
  }
}

export type LandownerSettlementRecord = {
  id: string
  farm_uid: string
  landowner_id: string | null
  landowner_name: string
  crop_year: number
  lease_type: string | null
  statement: unknown
  finalized_at: string | null
  updated_at: string | null
  /** 089. Absent on a pre-089 database, which reads as 'final'. */
  status?: string | null
}

/** The partner-share view: only the statements bound to THIS landowner (by
 *  Grain landowner id); an unresolved landowner is never another's, and a
 *  statement Farm has WITHDRAWN is never served (089). The statement rows pass
 *  through exactly as Farm finalized them for that landowner — Grain adds
 *  nothing and strips nothing. */
export function landownerSettlementsForShare(
  rows: readonly LandownerSettlementRecord[],
  landownerId: string,
  cropYear: number | null,
): Array<Omit<LandownerSettlementRecord, 'landowner_id'>> {
  return rows
    .filter((r) => r.landowner_id != null && r.landowner_id === landownerId && (cropYear == null || r.crop_year === cropYear))
    // 089: a statement Turnrow Farm withdrew is kept here but never served.
    .filter((r) => (r.status ?? 'final') === 'final')
    .map(({ landowner_id: _lo, ...rest }) => { void _lo; return rest })
    .sort((a, b) => b.crop_year - a.crop_year || a.landowner_name.localeCompare(b.landowner_name) || a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// Managed-land predicate (UI + importers)
// ---------------------------------------------------------------------------

export const LAND_TABLES = ['entities', 'farms', 'fields', 'field_plantings'] as const
export type LandTable = (typeof LAND_TABLES)[number]

/** Land records are managed in Turnrow Farm once the link is active and has
 *  completed one inbound land sync. Before that (pending link, or active but
 *  nothing pushed yet) Grain's own forms and importers keep working. */
export function landManagedByFarm(link: Pick<FarmLinkRow, 'status' | 'scopes' | 'last_sync'> | null | undefined): boolean {
  if (!link || link.status !== 'active') return false
  if (!link.scopes.includes('land:write')) return false
  return Boolean(link.last_sync?.inbound?.at)
}

export const LAND_MANAGED_MESSAGE = 'Land records are managed in Turnrow Farm.'

/** A row is read-only in Grain when it is managed by Farm; unmanaged rows
 *  (created here, never matched) stay editable and show "not linked". */
export function landRowEditable(row: { managed_by?: ManagedBy | null }, managed: boolean): boolean {
  if (!managed) return true
  return row.managed_by !== 'turnrow_farm'
}

/** The importer's message for a linked organization. */
export function landImportBlockedMessage(table: string): string | null {
  if (!(LAND_TABLES as readonly string[]).includes(table)) return null
  return `${LAND_MANAGED_MESSAGE} Make the change in Turnrow Farm and it syncs here.`
}
