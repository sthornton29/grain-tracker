// Landowners over the Turnrow Farm link (089) — PURE logic, no I/O.
// lib/farm-link-server.ts does the Supabase reads and the transactional
// farm_link_landowner_apply RPC; the routes wire the two together.
//
// Landowners are the ONE exception to "Farm is the master for the land
// tables". Grain is where the rent settlement, the partner share, and the
// payee name live, so the farmer edits landowners on both sides. A landowner
// is therefore merged FIELD BY FIELD, not row by row:
//
//   Farm sends, per row, the fields it wants to write plus a `base` map of
//   {field: synced_at} — when Farm last saw Grain's value for that field.
//   Grain applies a field UNLESS its own change log shows a change to that
//   field AFTER that base AND to a different value than Farm is now sending.
//   Those fields come back as conflicts carrying Grain's value and when it
//   changed; every other field in the row still applies.
//
// Two rules make that safe:
//   * A change the LINK wrote is stamped changed_by 'turnrow_farm' and never
//     counts as a Grain change, so Farm's own writes cannot echo back at it
//     as conflicts on the next sync.
//   * A field with no base is treated as base = epoch, so ANY Grain change to
//     a different value conflicts. Missing information surfaces; it never
//     silently overwrites.

import { findLandownerMatches, landownerNameKey, type LandownerCandidate } from '@/lib/landowner-match'

// ---------------------------------------------------------------------------
// The shared fields
// ---------------------------------------------------------------------------

/** Mirrors the `shared` array in 089's log_landowner_field_changes trigger and
 *  the allowlist in farm_link_landowner_apply. Changing this list means
 *  changing all three. */
export const LANDOWNER_SHARED_FIELDS = [
  'name',
  'kind',
  'contact_name',
  'phone',
  'email',
  'address_street',
  'address_city',
  'address_state',
  'address_zip',
  'payee_name',
  'notes',
] as const
export type LandownerSharedField = (typeof LANDOWNER_SHARED_FIELDS)[number]

export function isLandownerSharedField(s: unknown): s is LandownerSharedField {
  return typeof s === 'string' && (LANDOWNER_SHARED_FIELDS as readonly string[]).includes(s)
}

export const LANDOWNER_KINDS = ['individual', 'family', 'company', 'trust', 'estate', 'government', 'other'] as const
export type LandownerKind = (typeof LANDOWNER_KINDS)[number]
export function isLandownerKind(s: unknown): s is LandownerKind {
  return typeof s === 'string' && (LANDOWNER_KINDS as readonly string[]).includes(s)
}

// ---------------------------------------------------------------------------
// State in
// ---------------------------------------------------------------------------

export type LandownerRow = {
  id: string
  name: string
  kind?: string | null
  contact_name?: string | null
  phone?: string | null
  email?: string | null
  address_street?: string | null
  address_city?: string | null
  address_state?: string | null
  address_zip?: string | null
  payee_name?: string | null
  notes?: string | null
  archived_at?: string | null
  merged_into_id?: string | null
  updated_at?: string | null
}

export type FieldChangeRow = {
  landowner_id: string
  field: string
  old_value: string | null
  new_value: string | null
  changed_at: string
  changed_by: string
}

/** What a landowner share tells the Farm side, for display only. */
export type ShareFacts = {
  landowner_id: string
  active: boolean
  scopes: string[]
  last_viewed_at: string | null
}

// ---------------------------------------------------------------------------
// GET /landowners — the outbound record
// ---------------------------------------------------------------------------

export type FarmLinkLandownerRecord = {
  id: string
  farm_uid: string | null
  name: string
  kind: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  payee_name: string | null
  notes: string | null
  archived_at: string | null
  /** Set when this landowner was merged away; the id it was merged into. */
  merged_into_id: string | null
  merged_into_farm_uid: string | null
  /** Read-only facts about the landowner's Turnrow Landowner share. */
  share_active: boolean
  share_scopes: string[]
  share_last_viewed_at: string | null
  /** Grain's own field changes since ?since= (a Farm write is never listed). */
  changes: Array<{ field: string; old: string | null; new: string | null; changed_at: string; changed_by: string }>
  updated_at: string
}

const s = (v: unknown): string | null => {
  if (v == null) return null
  const t = String(v).trim()
  return t === '' ? null : t
}

export function shapeLandownerRecords(args: {
  landowners: readonly LandownerRow[]
  /** grain id -> Farm uid, from the id map. */
  farmUidFor: (grainId: string) => string | null
  shares: readonly ShareFacts[]
  /** Already filtered to changed_at >= since by the caller. */
  changes: readonly FieldChangeRow[]
  asOf: string
}): FarmLinkLandownerRecord[] {
  const shareBy = new Map(args.shares.map((x) => [x.landowner_id, x]))
  const changesBy = new Map<string, FieldChangeRow[]>()
  for (const c of args.changes) {
    // A Farm write is not a Grain change; listing it would invite the Farm
    // side to treat its own edit as ours.
    if (c.changed_by === 'turnrow_farm') continue
    const list = changesBy.get(c.landowner_id) ?? []
    list.push(c)
    changesBy.set(c.landowner_id, list)
  }
  return args.landowners
    .map((l) => {
      const share = shareBy.get(l.id) ?? null
      const own = (changesBy.get(l.id) ?? []).slice().sort((a, b) => a.changed_at.localeCompare(b.changed_at))
      return {
        id: l.id,
        farm_uid: args.farmUidFor(l.id),
        name: l.name,
        kind: s(l.kind),
        contact_name: s(l.contact_name),
        phone: s(l.phone),
        email: s(l.email),
        address_street: s(l.address_street),
        address_city: s(l.address_city),
        address_state: s(l.address_state),
        address_zip: s(l.address_zip),
        payee_name: s(l.payee_name),
        notes: s(l.notes),
        archived_at: l.archived_at ?? null,
        merged_into_id: l.merged_into_id ?? null,
        merged_into_farm_uid: l.merged_into_id ? args.farmUidFor(l.merged_into_id) : null,
        share_active: share?.active ?? false,
        share_scopes: share?.scopes ?? [],
        share_last_viewed_at: share?.last_viewed_at ?? null,
        changes: own.map((c) => ({ field: c.field, old: c.old_value, new: c.new_value, changed_at: c.changed_at, changed_by: c.changed_by })),
        updated_at: l.updated_at ?? args.asOf,
      }
    })
    .sort((a, b) => (a.updated_at ?? '').localeCompare(b.updated_at ?? '') || a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// POST /landowners/sync — the field-level merge
// ---------------------------------------------------------------------------

export type LandownerSyncRow = {
  farm_uid?: string | null
  grain_id?: string | null
  fields?: Record<string, unknown> | null
  /** {field: synced_at} — when Farm last saw Grain's value for that field. */
  base?: Record<string, string> | null
  /** Farm has run its duplicate search and means it. */
  create?: boolean
}

export type LandownerConflict = {
  field: LandownerSharedField
  /** What Grain holds now, and would have been overwritten. */
  grain_value: string | null
  /** What Farm asked for. */
  farm_value: string | null
  changed_at: string
  changed_by: string
}

export type LandownerSyncResult = {
  farm_uid: string | null
  grain_id: string | null
  action: 'created' | 'updated' | 'unchanged' | 'conflict' | 'unmatched' | 'refused'
  reason?: string
  /** Fields written by this call. */
  applied?: LandownerSharedField[]
  conflicts?: LandownerConflict[]
  /** On `unmatched`: Grain's closest names, so Farm can offer a link. */
  candidates?: Array<{ grain_id: string; name: string; score: number; kind: 'exact' | 'near' }>
}

export type LandownerApplyOp =
  | { op: 'insert'; ref: string; values: Record<string, string | null> }
  | { op: 'update'; id: string; values: Record<string, string | null> }
  | { op: 'link'; grain_id: string | { $ref: string }; farm_uid: string; linked_by?: string }
  | { op: 'merge'; survivor: string; merged: string; move_share: boolean }
  | { op: 'archive'; id: string }

export type LandownerSyncPlan = {
  ops: LandownerApplyOp[]
  results: LandownerSyncResult[]
  counts: { rows: number; created: number; updated: number; unchanged: number; conflict: number; unmatched: number; refused: number }
}

export const LANDOWNER_SYNC_MAX = 500

/** The last Grain change to a field, ignoring the link's own writes. */
function lastGrainChange(
  changes: readonly FieldChangeRow[],
  landownerId: string,
  field: string,
): FieldChangeRow | null {
  let best: FieldChangeRow | null = null
  for (const c of changes) {
    if (c.landowner_id !== landownerId || c.field !== field) continue
    if (c.changed_by === 'turnrow_farm') continue
    if (!best || c.changed_at > best.changed_at) best = c
  }
  return best
}

const eq = (a: string | null, b: string | null) => (a ?? '') === (b ?? '')

export function planLandownerSync(args: {
  rows: readonly LandownerSyncRow[]
  landowners: readonly LandownerRow[]
  changes: readonly FieldChangeRow[]
  /** farm_uid -> grain id, and grain id -> farm_uid. */
  grainIdFor: (farmUid: string) => string | null
  farmUidFor: (grainId: string) => string | null
}): LandownerSyncPlan {
  const byId = new Map(args.landowners.map((l) => [l.id, l]))
  const ops: LandownerApplyOp[] = []
  const results: LandownerSyncResult[] = []
  const counts = { rows: args.rows.length, created: 0, updated: 0, unchanged: 0, conflict: 0, unmatched: 0, refused: 0 }
  const seen = new Set<string>()

  const push = (r: LandownerSyncResult) => {
    results.push(r)
    counts[r.action] += 1
  }

  for (const row of args.rows) {
    const farmUid = s(row.farm_uid)
    const sent = row.fields ?? {}
    const base = row.base ?? {}

    // Only known shared fields, normalized to trimmed strings or null.
    const values: Partial<Record<LandownerSharedField, string | null>> = {}
    let badField: string | null = null
    for (const [k, v] of Object.entries(sent)) {
      if (!isLandownerSharedField(k)) { badField = badField ?? k; continue }
      if (k === 'kind' && v != null && s(v) !== null && !isLandownerKind(s(v))) { badField = badField ?? 'kind'; continue }
      values[k] = s(v)
    }
    const fields = Object.keys(values) as LandownerSharedField[]

    // Resolve the target: explicit grain_id, then the id map.
    let target: LandownerRow | null = null
    const explicit = s(row.grain_id)
    if (explicit) {
      target = byId.get(explicit) ?? null
      if (!target) { push({ farm_uid: farmUid, grain_id: explicit, action: 'refused', reason: 'grain_id is not a landowner in this organization' }); continue }
    } else if (farmUid) {
      const mapped = args.grainIdFor(farmUid)
      target = mapped ? byId.get(mapped) ?? null : null
    }

    if (!farmUid && !target) { push({ farm_uid: null, grain_id: null, action: 'refused', reason: 'farm_uid is required' }); continue }

    // --- no match: create only when Farm says so ---------------------------
    if (!target) {
      const name = values.name ?? null
      if (!row.create) {
        const matches = findLandownerMatches(name, args.landowners.filter((l) => !l.archived_at && !l.merged_into_id))
        push({
          farm_uid: farmUid, grain_id: null, action: 'unmatched',
          reason: name
            ? 'no landowner is linked to this farm_uid; send create: true to add one, or link it to one of the candidates'
            : 'no landowner is linked to this farm_uid and no name was sent',
          candidates: matches.map((m) => ({ grain_id: m.candidate.id, name: m.candidate.name, score: Math.round(m.score * 100) / 100, kind: m.kind })),
        })
        continue
      }
      if (!name) { push({ farm_uid: farmUid, grain_id: null, action: 'refused', reason: 'name is required to create a landowner' }); continue }
      if (badField) { push({ farm_uid: farmUid, grain_id: null, action: 'refused', reason: `unknown or invalid field "${badField}"` }); continue }
      if (seen.has(`uid:${farmUid}`)) { push({ farm_uid: farmUid, grain_id: null, action: 'refused', reason: 'duplicate farm_uid in this request' }); continue }
      seen.add(`uid:${farmUid}`)
      const ref = `lo:${farmUid}`
      ops.push({ op: 'insert', ref, values: values as Record<string, string | null> })
      ops.push({ op: 'link', grain_id: { $ref: ref }, farm_uid: farmUid!, linked_by: 'sync' })
      push({ farm_uid: farmUid, grain_id: null, action: 'created', applied: fields })
      continue
    }

    // --- matched: merge field by field -------------------------------------
    if (seen.has(`id:${target.id}`)) { push({ farm_uid: farmUid, grain_id: target.id, action: 'refused', reason: 'duplicate landowner in this request' }); continue }
    seen.add(`id:${target.id}`)

    if (target.merged_into_id) {
      push({ farm_uid: farmUid, grain_id: target.id, action: 'refused', reason: 'this landowner was merged into another; send the survivor' })
      continue
    }
    if (badField) { push({ farm_uid: farmUid, grain_id: target.id, action: 'refused', reason: `unknown or invalid field "${badField}"` }); continue }

    const current = target as Record<string, unknown>
    const applied: LandownerSharedField[] = []
    const conflicts: LandownerConflict[] = []
    const write: Record<string, string | null> = {}

    for (const field of fields) {
      const want = values[field] ?? null
      const have = s(current[field])
      if (eq(want, have)) continue // already agrees: never a conflict, never a write
      // No base for the field means Farm has never seen Grain's value for it,
      // so treat it as the beginning of time: any Grain change conflicts.
      const baseAt = s(base[field]) ?? ''
      const change = lastGrainChange(args.changes, target.id, field)
      if (change && change.changed_at > baseAt && !eq(s(change.new_value), want)) {
        conflicts.push({
          field, grain_value: have, farm_value: want,
          changed_at: change.changed_at, changed_by: change.changed_by,
        })
        continue
      }
      write[field] = want
      applied.push(field)
    }

    if (applied.length > 0) ops.push({ op: 'update', id: target.id, values: write })
    // Link an unmapped farm_uid even when nothing else changed, so the next
    // sync resolves by id map rather than guessing again.
    if (farmUid && !args.farmUidFor(target.id)) ops.push({ op: 'link', grain_id: target.id, farm_uid: farmUid, linked_by: 'sync' })

    if (conflicts.length > 0) {
      push({ farm_uid: farmUid, grain_id: target.id, action: 'conflict', applied, conflicts })
    } else if (applied.length > 0) {
      push({ farm_uid: farmUid, grain_id: target.id, action: 'updated', applied })
    } else {
      push({ farm_uid: farmUid, grain_id: target.id, action: 'unchanged', applied: [] })
    }
  }

  return { ops, results, counts }
}

// ---------------------------------------------------------------------------
// POST /landowners/merge
// ---------------------------------------------------------------------------

export type MergeVerdict =
  | { ok: true; ops: LandownerApplyOp[] }
  | { ok: false; status: 400 | 409; error: string; code: 'not_found' | 'same_landowner' | 'already_merged' | 'share_active' }

export function planLandownerMerge(args: {
  survivorId: string
  mergedId: string
  landowners: readonly LandownerRow[]
  /** Active (unrevoked) shares, by landowner. */
  activeShareLandownerIds: ReadonlySet<string>
  moveShare?: boolean
}): MergeVerdict {
  if (args.survivorId === args.mergedId) {
    return { ok: false, status: 400, error: 'A landowner cannot be merged into itself.', code: 'same_landowner' }
  }
  const byId = new Map(args.landowners.map((l) => [l.id, l]))
  const survivor = byId.get(args.survivorId)
  const merged = byId.get(args.mergedId)
  if (!survivor || !merged) {
    return { ok: false, status: 400, error: 'Both landowners must belong to this organization.', code: 'not_found' }
  }
  if (survivor.merged_into_id) {
    return { ok: false, status: 409, error: 'The surviving landowner was itself merged into another; merge into that one instead.', code: 'already_merged' }
  }
  if (merged.merged_into_id) {
    return { ok: false, status: 409, error: 'That landowner has already been merged.', code: 'already_merged' }
  }
  if (args.activeShareLandownerIds.has(args.mergedId) && !args.moveShare) {
    return {
      ok: false, status: 409, code: 'share_active',
      error: 'That landowner has an active Turnrow Landowner share. Send move_share: true to move the share to the surviving landowner, or end the share first.',
    }
  }
  return {
    ok: true,
    ops: [{ op: 'merge', survivor: args.survivorId, merged: args.mergedId, move_share: !!args.moveShare }],
  }
}

// ---------------------------------------------------------------------------
// POST /landowners/archive
// ---------------------------------------------------------------------------

export type ArchiveVerdict =
  | { ok: true; ops: LandownerApplyOp[] }
  | { ok: false; status: 400 | 409; error: string; code: 'not_found' | 'already_archived' | 'share_active' | 'open_settlement' }

/** The crop year a rent settlement is still "open" from. Grain has no season
 *  close, so the current calendar year is the line: last year's settlements
 *  are history, this year's are live. */
export function openSettlementFromYear(now = new Date()): number {
  return now.getUTCFullYear()
}

/** A settlement is "open" while its crop year is the current one or later:
 *  archiving a landowner Stuart is still settling with would hide them from
 *  the Rent Settlement report mid-season. */
export function planLandownerArchive(args: {
  grainId: string
  landowners: readonly LandownerRow[]
  activeShareLandownerIds: ReadonlySet<string>
  /** Crop years with a rent settlement, per landowner. */
  settlementYearsByLandowner: ReadonlyMap<string, readonly number[]>
  openFromYear: number
}): ArchiveVerdict {
  const row = args.landowners.find((l) => l.id === args.grainId)
  if (!row) return { ok: false, status: 400, error: 'That landowner is not in this organization.', code: 'not_found' }
  if (row.archived_at) return { ok: false, status: 409, error: 'That landowner is already archived.', code: 'already_archived' }
  if (args.activeShareLandownerIds.has(args.grainId)) {
    return { ok: false, status: 409, code: 'share_active', error: 'That landowner has an active Turnrow Landowner share. End the share before archiving them.' }
  }
  const years = (args.settlementYearsByLandowner.get(args.grainId) ?? []).filter((y) => y >= args.openFromYear)
  if (years.length > 0) {
    const list = Array.from(new Set(years)).sort().join(', ')
    return { ok: false, status: 409, code: 'open_settlement', error: `That landowner has a rent settlement for ${list}. Archive them after that crop year is closed.` }
  }
  return { ok: true, ops: [{ op: 'archive', id: args.grainId }] }
}

// ---------------------------------------------------------------------------
// GET /lease-terms — the proposals Farm reads once
// ---------------------------------------------------------------------------

export type LeaseTermRow = {
  id: string
  landowner_id: string
  farm_ids: string[] | null
  lease_type: string
  share_terms: unknown
  expense_terms: unknown
  pricing_method: unknown
  cash_terms: unknown
  flex_terms: unknown
  payment_timing: string | null
  notes: string | null
  source_file_name: string | null
  source_file_path: string | null
  managed_by?: string | null
  farm_lease_uid?: string | null
  updated_at: string | null
}

export type FarmLinkLeaseTermRecord = {
  id: string
  landowner_grain_id: string
  landowner_farm_uid: string | null
  landowner_name: string | null
  farm_grain_ids: string[]
  farm_farm_uids: Array<string | null>
  lease_type: string
  share_terms: unknown
  expense_terms: unknown
  pricing_method: unknown
  cash_terms: unknown
  flex_terms: unknown
  payment_timing: string | null
  notes: string | null
  /** Short-lived signed URL for the uploaded lease, null when there is none. */
  source_document_url: string | null
  source_document_name: string | null
  updated_at: string
}

/** Only leases Farm has NOT yet adopted. Once a lease is managed there, Grain
 *  stops offering it as a proposal and shows it read-only. */
export function shapeLeaseTermRecords(args: {
  leases: readonly LeaseTermRow[]
  landowners: readonly LandownerRow[]
  farmUidFor: (table: 'landowners' | 'farms', grainId: string) => string | null
  signedUrlFor: (path: string | null) => string | null
  asOf: string
}): FarmLinkLeaseTermRecord[] {
  const nameById = new Map(args.landowners.map((l) => [l.id, l.name]))
  return args.leases
    .filter((l) => l.managed_by !== 'turnrow_farm')
    .map((l) => {
      const farmIds = Array.isArray(l.farm_ids) ? l.farm_ids : []
      return {
        id: l.id,
        landowner_grain_id: l.landowner_id,
        landowner_farm_uid: args.farmUidFor('landowners', l.landowner_id),
        landowner_name: nameById.get(l.landowner_id) ?? null,
        farm_grain_ids: farmIds,
        farm_farm_uids: farmIds.map((f) => args.farmUidFor('farms', f)),
        lease_type: l.lease_type,
        share_terms: l.share_terms ?? null,
        expense_terms: l.expense_terms ?? null,
        pricing_method: l.pricing_method ?? null,
        cash_terms: l.cash_terms ?? null,
        flex_terms: l.flex_terms ?? null,
        payment_timing: l.payment_timing,
        notes: l.notes,
        source_document_url: args.signedUrlFor(l.source_file_path),
        source_document_name: l.source_file_name,
        updated_at: l.updated_at ?? args.asOf,
      }
    })
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// Duplicate search shared with the Grain UI and the importers
// ---------------------------------------------------------------------------

/** What the Add form, the CSV importer, and the AI importer all ask before
 *  creating: is this already a landowner? Archived and merged rows are
 *  excluded — offering to reuse an archived landowner would undo an archive
 *  by the back door. */
export function landownerDuplicateSearch<T extends LandownerCandidate & { archived_at?: string | null; merged_into_id?: string | null }>(
  name: string | null | undefined,
  landowners: readonly T[],
): { exact: T | null; near: T[] } {
  const live = landowners.filter((l) => !l.archived_at && !l.merged_into_id)
  const matches = findLandownerMatches(name, live)
  return {
    exact: matches.find((m) => m.kind === 'exact')?.candidate ?? null,
    near: matches.filter((m) => m.kind === 'near').map((m) => m.candidate),
  }
}

export { landownerNameKey }
