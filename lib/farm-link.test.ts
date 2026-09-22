// The Turnrow Farm link (087) — the pure rules in lib/farm-link.ts: pairing
// code + token verdicts, scope gates, cursor paging, the snapshot shape, id
// map uniqueness, the sync planner (dependency order, conflict rule, archive
// refusals, crop creation, planting pairing, varieties), the assumptions plan
// with the manual override, settlement normalization, and the landowner-share
// isolation filter.

import { describe, expect, it } from 'vitest'
import {
  FARM_LINK_SCOPES,
  IdMap,
  budgetCellCost,
  buildLandSnapshot,
  countBatchRecords,
  dataBearingKeys,
  decodeCursor,
  encodeCursor,
  evaluateHandshake,
  evaluateToken,
  formatFarmLinkSecret,
  isConflict,
  landImportBlockedMessage,
  landManagedByFarm,
  landRowEditable,
  landownerSettlementsForShare,
  looksLikeLinkToken,
  looksLikePairingCode,
  normalizeLandownerSettlement,
  normalizeScopes,
  pageRecords,
  parseLimit,
  planAssumptionsWrite,
  planLandSync,
  resolveCreatedIds,
  scopeDenied,
  validateLinkRequests,
  validateSince,
  type ApplyOp,
  type FarmLinkRow,
  type LandState,
} from '@/lib/farm-link'

const NOW = new Date('2026-09-17T12:00:00Z')

const linkRow = (patch: Partial<FarmLinkRow> = {}): FarmLinkRow => ({
  id: 'link-1', org_id: 'org-1', code_hash: 'h', code_expires_at: '2026-09-24T00:00:00Z', token_hash: 'th', token_rotated_at: null,
  farm_org_id: null, farm_org_name: null, scopes: [...FARM_LINK_SCOPES], status: 'active', created_by: null,
  redeemed_at: '2026-09-17T00:00:00Z', revoked_at: null, last_seen_at: null, last_sync: {}, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-17T00:00:00Z',
  ...patch,
})

// ---------------------------------------------------------------------------

describe('pairing codes and tokens', () => {
  it('formats secrets with the fl_ / flt_ prefixes and recognizes them', () => {
    const hex = 'a'.repeat(48)
    expect(formatFarmLinkSecret('code', hex)).toBe(`fl_${hex}`)
    expect(formatFarmLinkSecret('token', hex)).toBe(`flt_${hex}`)
    expect(looksLikePairingCode(`fl_${hex}`)).toBe(true)
    expect(looksLikeLinkToken(`fl_${hex}`)).toBe(false)
    expect(looksLikeLinkToken(`flt_${hex}`)).toBe(true)
    expect(() => formatFarmLinkSecret('code', 'abc')).toThrow()
  })

  it('handshake: unknown 404, revoked 403, used 409, expired 410, fresh ok', () => {
    expect(evaluateHandshake(null, NOW)).toMatchObject({ ok: false, status: 404, code: 'invalid_code' })
    expect(evaluateHandshake({ status: 'revoked', redeemed_at: null, code_expires_at: '2026-09-24T00:00:00Z' }, NOW)).toMatchObject({ ok: false, status: 403, code: 'link_revoked' })
    expect(evaluateHandshake({ status: 'active', redeemed_at: '2026-09-17T01:00:00Z', code_expires_at: '2026-09-24T00:00:00Z' }, NOW)).toMatchObject({ ok: false, status: 409, code: 'code_used' })
    expect(evaluateHandshake({ status: 'pending', redeemed_at: null, code_expires_at: '2026-09-10T00:00:00Z' }, NOW)).toMatchObject({ ok: false, status: 410, code: 'code_expired' })
    expect(evaluateHandshake({ status: 'pending', redeemed_at: null, code_expires_at: '2026-09-24T00:00:00Z' }, NOW)).toEqual({ ok: true })
  })

  it('token: unknown, revoked, and never-redeemed links are all 401', () => {
    expect(evaluateToken(null)).toMatchObject({ ok: false, status: 401, code: 'unknown_token' })
    expect(evaluateToken({ status: 'revoked', token_hash: 'x' })).toMatchObject({ ok: false, status: 401, code: 'link_revoked' })
    expect(evaluateToken({ status: 'pending', token_hash: null })).toMatchObject({ ok: false, status: 401, code: 'unknown_token' })
    expect(evaluateToken({ status: 'pending', token_hash: 'x' })).toMatchObject({ ok: false, status: 401, code: 'link_pending' })
    expect(evaluateToken({ status: 'active', token_hash: 'x' })).toEqual({ ok: true })
  })
})

describe('scopes', () => {
  it('normalizes unknown and duplicate scopes away, in canonical order', () => {
    expect(normalizeScopes(['bins:read', 'land:write', 'nope', 'bins:read'])).toEqual(['land:write', 'bins:read'])
    expect(normalizeScopes('land:write')).toEqual([])
  })
  it('scopeDenied is a 403 body naming the scope, null when granted', () => {
    expect(scopeDenied(['land:write'], 'land:write')).toBeNull()
    expect(scopeDenied(['land:write'], 'income:read')).toMatchObject({ code: 'missing_scope', scope: 'income:read' })
  })
})

describe('cursor paging', () => {
  const rows = [
    { id: 'b', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'a', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'c', updated_at: '2026-02-01T00:00:00Z' },
    { id: 'd', updated_at: null },
  ]
  it('orders by (updated_at, id), resumes strictly after the cursor, and honors since', () => {
    const p1 = pageRecords(rows, { limit: 2 })
    expect(p1.data.map((r) => r.id)).toEqual(['d', 'a'])
    expect(p1.next_cursor).not.toBeNull()
    const p2 = pageRecords(rows, { limit: 2, cursor: decodeCursor(p1.next_cursor) })
    expect(p2.data.map((r) => r.id)).toEqual(['b', 'c'])
    expect(p2.next_cursor).toBeNull()
    expect(pageRecords(rows, { limit: 10, since: '2026-02-01' }).data.map((r) => r.id)).toEqual(['c'])
  })
  it('round-trips the cursor and rejects garbage', () => {
    const c = { updatedAt: '2026-01-01T00:00:00Z', id: 'x|y' }
    expect(decodeCursor(encodeCursor(c))).toEqual({ updatedAt: c.updatedAt, id: 'x|y' })
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('!!!')).toBeNull()
  })
  it('parses limit within bounds and validates since', () => {
    expect(parseLimit(null)).toBe(500)
    expect(parseLimit('5000')).toBe(1000)
    expect(parseLimit('-3')).toBe(500)
    expect(validateSince('2026-01-31')).toEqual({ since: '2026-01-31' })
    expect(validateSince('yesterday').error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// A seeded Grain organization for the planner + snapshot.
// ---------------------------------------------------------------------------

function seededState(patch: Partial<LandState> = {}): LandState {
  const idMap = new IdMap([
    { grain_table: 'entities', grain_id: 'ent-1', farm_uid: 'F-ENT-1' },
    { grain_table: 'farms', grain_id: 'farm-1', farm_uid: 'F-FARM-1' },
    { grain_table: 'fields', grain_id: 'field-1', farm_uid: 'F-FIELD-1' },
    { grain_table: 'field_plantings', grain_id: 'pl-1', farm_uid: 'F-PL-1' },
  ])
  return {
    entities: [
      { id: 'ent-1', name: 'Turnrow Farms LLC', entity_role: 'farming', managed_by: 'turnrow_farm', archived_at: null, updated_at: '2026-09-01T00:00:00Z' },
      { id: 'ent-2', name: 'Valley Creek', entity_role: 'farming', managed_by: null, archived_at: null, updated_at: '2026-09-10T00:00:00Z' },
    ],
    landowners: [{ id: 'lo-1', name: 'Smith Family Trust', updated_at: '2026-08-01T00:00:00Z' }],
    farms: [
      { id: 'farm-1', name: 'Home Place', entity_id: 'ent-1', fsa_number: '1234', county_id: 'cty-law-al', landowner_id: null, is_share_rent: false, landlord_share_percentage: null, cash_rent_per_acre: null, managed_by: 'turnrow_farm', archived_at: null, updated_at: '2026-09-01T00:00:00Z' },
      { id: 'farm-2', name: 'River Bottom', entity_id: 'ent-2', fsa_number: null, county_id: null, landowner_id: 'lo-1', is_share_rent: true, landlord_share_percentage: 33.33, cash_rent_per_acre: null, managed_by: null, archived_at: null, updated_at: '2026-09-12T00:00:00Z' },
    ],
    fields: [
      { id: 'field-1', farm_id: 'farm-1', name_or_number: 'North 40', total_acres: 40, irrigated_acres: 0, county_id: 'cty-law-al', managed_by: 'turnrow_farm', archived_at: null, updated_at: '2026-09-01T00:00:00Z' },
      { id: 'field-2', farm_id: 'farm-2', name_or_number: 'Bottom 80', total_acres: 80, irrigated_acres: 80, county_id: null, managed_by: null, archived_at: null, updated_at: '2026-09-12T00:00:00Z' },
    ],
    crops: [
      { id: 'corn', name: 'Corn', harvest_category: 'fall', double_crop: false, updated_at: null },
      { id: 'wheat', name: 'Wheat', harvest_category: 'spring', double_crop: false, updated_at: null },
      { id: 'soy', name: 'Soybean', harvest_category: 'fall', double_crop: true, updated_at: null },
    ],
    plantings: [
      { id: 'pl-1', field_id: 'field-1', crop_id: 'corn', season_year: 2026, planted_acres: 40, planting_date: '2026-04-10', paired_planting_id: null, irrigated_acres: 0, managed_by: 'turnrow_farm', archived_at: null, updated_at: '2026-09-01T00:00:00Z' },
      { id: 'pl-2', field_id: 'field-2', crop_id: 'wheat', season_year: 2026, planted_acres: 80, planting_date: '2025-10-20', paired_planting_id: null, irrigated_acres: 80, managed_by: null, archived_at: null, updated_at: '2026-09-12T00:00:00Z' },
    ],
    varieties: [{ id: 'v-1', planting_id: 'pl-1', variety: 'DKC 68-35', acres: 40, bushels: null }],
    counties: [
      { id: 'cty-law-al', name: 'Lawrence', state_code: 'AL' },
      { id: 'cty-law-tn', name: 'Lawrence', state_code: 'TN' },
    ],
    idMap,
    fieldIdsWithData: new Set(['field-1']),
    plantingKeysWithData: new Set(['field-1|corn|2026']),
    ...patch,
  }
}

const opsOf = (plan: { ops: ApplyOp[] }, op: ApplyOp['op'], table?: string) =>
  plan.ops.filter((o) => o.op === op && (table == null || ('table' in o && o.table === table) || ('grain_table' in o && o.grain_table === table)))

describe('land snapshot', () => {
  it('carries every table with farm_uid from the id map, county name + state, and only the requested years', () => {
    const snap = buildLandSnapshot(seededState(), [2026])
    expect(snap.entities.map((e) => e.farm_uid)).toEqual(['F-ENT-1', null])
    expect(snap.farms[0]).toMatchObject({ farm_code: '1234', county: 'Lawrence', state: 'AL', farm_uid: 'F-FARM-1', managed_by: 'turnrow_farm' })
    expect(snap.farms[1]).toMatchObject({ is_share_rent: true, landlord_share_percentage: 33.33, landowner_id: 'lo-1', farm_uid: null })
    expect(snap.fields[1]).toMatchObject({ irrigated_acres: 80, county: null, state: null })
    expect(snap.field_plantings).toHaveLength(2)
    expect(snap.field_plantings[0].varieties).toEqual([{ id: 'v-1', variety: 'DKC 68-35', acres: 40, bushels: null, farm_uid: null }])
    expect(buildLandSnapshot(seededState(), [2025]).field_plantings).toHaveLength(0)
    expect(buildLandSnapshot(seededState(), null).field_plantings).toHaveLength(2)
  })
  it('omits archived rows', () => {
    let state = seededState()
    state = { ...state, fields: state.fields.map((f, i) => (i === 1 ? { ...f, archived_at: '2026-09-15T00:00:00Z' } : f)) }
    expect(buildLandSnapshot(state, null).fields.map((f) => f.id)).toEqual(['field-1'])
  })
})

describe('id map link requests', () => {
  const existing = new Map<string, Set<string>>([['farms', new Set(['farm-1', 'farm-2'])], ['fields', new Set(['field-1'])]])
  it('links new pairs, reports identical pairs unchanged, and rejects anything already mapped elsewhere', () => {
    const v = validateLinkRequests(
      [
        { grain_table: 'farms', grain_id: 'farm-2', farm_uid: 'F-FARM-2' },
        { grain_table: 'farms', grain_id: 'farm-1', farm_uid: 'F-FARM-1' },
        { grain_table: 'farms', grain_id: 'farm-1', farm_uid: 'F-FARM-9' },
        { grain_table: 'fields', grain_id: 'field-1', farm_uid: 'F-FIELD-1' },
        { grain_table: 'fields', grain_id: 'field-9', farm_uid: 'F-FIELD-9' },
        { grain_table: 'bins', grain_id: 'x', farm_uid: 'y' },
      ],
      seededState().idMap,
      existing,
    )
    expect(v.map((x) => x.action)).toEqual(['linked', 'unchanged', 'rejected', 'unchanged', 'rejected', 'rejected'])
    expect(v[2].reason).toMatch(/already linked to farm_uid F-FARM-1/)
    expect(v[4].reason).toMatch(/no fields row/)
  })
  it('rejects a farm_uid already mapped to another row and duplicates within the batch', () => {
    const v = validateLinkRequests(
      [
        { grain_table: 'farms', grain_id: 'farm-2', farm_uid: 'F-FARM-1' },
        { grain_table: 'farms', grain_id: 'farm-2', farm_uid: 'F-FARM-3' },
        { grain_table: 'farms', grain_id: 'farm-2', farm_uid: 'F-FARM-4' },
      ],
      seededState().idMap,
      existing,
    )
    expect(v[0]).toMatchObject({ action: 'rejected' })
    expect(v[0].reason).toMatch(/already linked to grain_id farm-1/)
    expect(v[1].action).toBe('linked')
    expect(v[2]).toMatchObject({ action: 'rejected', reason: 'duplicate within this request' })
  })
})

describe('planLandSync', () => {
  it('counts a batch and refuses records missing their keys', () => {
    expect(countBatchRecords({ entities: [{ farm_uid: 'a', name: 'x' }], deletions: [{ grain_table: 'farms', farm_uid: 'b' }] })).toBe(2)
    const plan = planLandSync({ entities: [{ farm_uid: '', name: 'x' }], farms: [{ farm_uid: 'F', name: '' }] }, seededState(), { lastSyncAt: null })
    expect(plan.results.map((r) => r.action)).toEqual(['refused', 'refused'])
    expect(plan.ops).toHaveLength(0)
  })

  it('creates in dependency order (entity → landowner → crop → farm → field → planting) with $refs and links every created row', () => {
    const plan = planLandSync(
      {
        entities: [{ farm_uid: 'F-ENT-3', name: 'Hilltop Partners', entity_role: 'farming' }],
        landowners: [{ farm_uid: 'F-LO-2', name: 'Jones Estate' }],
        crops: [{ farm_uid: 'sunflower', name: 'Sunflower', harvest_category: 'fall', double_crop: false }],
        farms: [{ farm_uid: 'F-FARM-3', name: 'Hilltop', entity_farm_uid: 'F-ENT-3', farm_code: '777', county: 'Lawrence County', state: 'tn', landowner_farm_uid: 'F-LO-2', is_share_rent: false, cash_rent_per_acre: 150 }],
        fields: [{ farm_uid: 'F-FIELD-3', farm_farm_uid: 'F-FARM-3', name_or_number: 'Ridge', total_acres: 60, irrigated_acres: 20, county: 'Lawrence', state: 'TN' }],
        plantings: [{ farm_uid: 'F-PL-3', field_farm_uid: 'F-FIELD-3', crop: 'Sunflower', season_year: 2026, planted_acres: 60, irrigated_acres: 20, planting_date: '2026-05-01', varieties: [{ variety: 'Clearfield 1', acres: 60 }] }],
      },
      seededState(),
      { lastSyncAt: null },
    )
    expect(plan.counts).toMatchObject({ created: 6, refused: 0, conflict: 0 })
    const inserts = opsOf(plan, 'insert').map((o) => (o as { table: string }).table)
    expect(inserts).toEqual(['entities', 'landowners', 'crops', 'farms', 'fields', 'field_plantings'])
    const farmInsert = opsOf(plan, 'insert', 'farms')[0] as Extract<ApplyOp, { op: 'insert' }>
    expect(farmInsert.values).toMatchObject({
      name: 'Hilltop', fsa_number: '777', county_id: 'cty-law-tn', entity_id: { $ref: 'entities:F-ENT-3' }, landowner_id: { $ref: 'landowners:F-LO-2' },
      cash_rent_per_acre: 150, managed_by: 'turnrow_farm',
    })
    const fieldInsert = opsOf(plan, 'insert', 'fields')[0] as Extract<ApplyOp, { op: 'insert' }>
    expect(fieldInsert.values).toMatchObject({ farm_id: { $ref: 'farms:F-FARM-3' }, total_acres: 60, irrigated_acres: 20, county_id: 'cty-law-tn' })
    const plInsert = opsOf(plan, 'insert', 'field_plantings')[0] as Extract<ApplyOp, { op: 'insert' }>
    expect(plInsert.values).toMatchObject({ field_id: { $ref: 'fields:F-FIELD-3' }, crop_id: { $ref: 'crops:sunflower' }, season_year: 2026, planted_acres: 60 })
    expect(opsOf(plan, 'replace_varieties')).toEqual([{ op: 'replace_varieties', planting: { $ref: 'field_plantings:F-PL-3' }, varieties: [{ variety: 'Clearfield 1', acres: 60, bushels: null }] }])
    // Every created row is linked with linked_by 'sync' (landowners are not managed_by-marked).
    expect(opsOf(plan, 'link')).toHaveLength(6)
    expect((opsOf(plan, 'insert', 'landowners')[0] as Extract<ApplyOp, { op: 'insert' }>).values).not.toHaveProperty('managed_by')
    // Insert before its link, and the entity before the farm that refs it.
    const idx = (pred: (o: ApplyOp) => boolean) => plan.ops.findIndex(pred)
    expect(idx((o) => o.op === 'insert' && o.table === 'entities')).toBeLessThan(idx((o) => o.op === 'insert' && o.table === 'farms'))
    expect(idx((o) => o.op === 'link' && o.grain_table === 'entities')).toBeGreaterThan(idx((o) => o.op === 'insert' && o.table === 'entities'))
    // resolveCreatedIds fills grain_id from the RPC's refs.
    const resolved = resolveCreatedIds(plan.results, { 'farms:F-FARM-3': 'new-farm-id' })
    expect(resolved.find((r) => r.farm_uid === 'F-FARM-3')).toMatchObject({ grain_id: 'new-farm-id', action: 'created' })
    expect(resolved.find((r) => r.farm_uid === 'F-FARM-3')).not.toHaveProperty('ref')
  })

  it('refuses a farm whose county has no state or is unknown, and a field whose farm is not linked', () => {
    const plan = planLandSync(
      {
        farms: [
          { farm_uid: 'F-A', name: 'A', county: 'Lawrence' },
          { farm_uid: 'F-B', name: 'B', county: 'Nowhere', state: 'AL' },
        ],
        fields: [{ farm_uid: 'F-FIELD-X', farm_farm_uid: 'F-FARM-MISSING', name_or_number: 'X' }],
      },
      seededState(),
      { lastSyncAt: null },
    )
    expect(plan.results[0]).toMatchObject({ action: 'refused', reason: 'county "Lawrence" needs a state' })
    expect(plan.results[1]).toMatchObject({ action: 'refused', reason: 'county "Nowhere, AL" not found' })
    expect(plan.results[2].reason).toMatch(/farm F-FARM-MISSING is not linked/)
    expect(plan.ops).toHaveLength(0)
  })

  it('updates only the changed columns on a managed row (Farm wins) and reports unchanged when nothing differs', () => {
    const plan = planLandSync(
      { fields: [{ farm_uid: 'F-FIELD-1', farm_farm_uid: 'F-FARM-1', name_or_number: 'North 40', total_acres: 42, irrigated_acres: 0 }] },
      seededState(),
      { lastSyncAt: '2026-08-01T00:00:00Z' },
    )
    expect(plan.results[0]).toMatchObject({ action: 'updated', grain_id: 'field-1' })
    expect(opsOf(plan, 'update', 'fields')).toEqual([{ op: 'update', table: 'fields', id: 'field-1', values: { total_acres: 42, managed_by: 'turnrow_farm' } }])
    const same = planLandSync(
      { fields: [{ farm_uid: 'F-FIELD-1', farm_farm_uid: 'F-FARM-1', name_or_number: 'north 40', total_acres: '40', irrigated_acres: 0 }] },
      seededState(),
      { lastSyncAt: '2026-08-01T00:00:00Z' },
    )
    expect(same.results[0].action).toBe('unchanged')
    expect(same.ops).toHaveLength(0)
  })

  it('CONFLICT RULE: an unmanaged Grain row edited after the last sync comes back with Grain values, never overwritten; force overrides; older edits let Farm win', () => {
    // farm-2 is unmanaged and updated 2026-09-12; matched by name.
    const batch = { farms: [{ farm_uid: 'F-FARM-2', name: 'River Bottom', entity_farm_uid: 'F-ENT-1', is_share_rent: true, landlord_share_percentage: 25 }] }
    const conflict = planLandSync(batch, seededState(), { lastSyncAt: '2026-09-11T00:00:00Z' })
    expect(conflict.results[0]).toMatchObject({ action: 'conflict', grain_id: 'farm-2' })
    expect(conflict.results[0].grain_values).toEqual({ entity_id: 'ent-2', landlord_share_percentage: 33.33 })
    expect(opsOf(conflict, 'update')).toHaveLength(0)
    // The by-name match itself is still recorded so Farm's next sync keys on it.
    expect(opsOf(conflict, 'link')).toEqual([{ op: 'link', grain_table: 'farms', grain_id: 'farm-2', farm_uid: 'F-FARM-2', linked_by: 'match' }])

    const noSyncYet = planLandSync(batch, seededState(), { lastSyncAt: null })
    expect(noSyncYet.results[0].action).toBe('conflict')

    const older = planLandSync(batch, seededState(), { lastSyncAt: '2026-09-13T00:00:00Z' })
    expect(older.results[0].action).toBe('updated')
    expect((opsOf(older, 'update', 'farms')[0] as Extract<ApplyOp, { op: 'update' }>).values).toEqual({ entity_id: 'ent-1', landlord_share_percentage: 25, managed_by: 'turnrow_farm' })

    const forced = planLandSync({ farms: [{ ...batch.farms[0], force: true }] }, seededState(), { lastSyncAt: null })
    expect(forced.results[0].action).toBe('updated')
  })

  it('isConflict follows the rule exactly', () => {
    expect(isConflict({ managed_by: 'turnrow_farm', updated_at: '2026-09-16T00:00:00Z' }, null)).toBe(false)
    expect(isConflict({ managed_by: null, updated_at: '2026-09-16T00:00:00Z' }, null)).toBe(true)
    expect(isConflict({ managed_by: null, updated_at: '2026-09-16T00:00:00Z' }, '2026-09-15T00:00:00Z')).toBe(true)
    expect(isConflict({ managed_by: null, updated_at: '2026-09-14T00:00:00Z' }, '2026-09-15T00:00:00Z')).toBe(false)
    expect(isConflict({ managed_by: null, updated_at: '2026-09-16T00:00:00Z' }, null, true)).toBe(false)
  })

  it('marks an unchanged unmanaged match as managed so Farm wins from then on', () => {
    const plan = planLandSync(
      { entities: [{ farm_uid: 'F-ENT-2', name: 'valley creek', entity_role: 'farming' }] },
      seededState(),
      { lastSyncAt: null },
    )
    expect(plan.results[0]).toMatchObject({ action: 'unchanged', grain_id: 'ent-2' })
    expect(plan.ops).toEqual([
      { op: 'link', grain_table: 'entities', grain_id: 'ent-2', farm_uid: 'F-ENT-2', linked_by: 'match' },
      { op: 'update', table: 'entities', id: 'ent-2', values: { managed_by: 'turnrow_farm' } },
    ])
  })

  it('creates a crop Grain lacks when a planting names it, and matches existing crops by name', () => {
    const plan = planLandSync(
      {
        plantings: [
          { farm_uid: 'F-PL-4', field_farm_uid: 'F-FIELD-1', crop: 'Sunflower', season_year: 2027, planted_acres: 40 },
          { farm_uid: 'F-PL-5', field_farm_uid: 'F-FIELD-1', crop: 'soybean', season_year: 2027, planted_acres: 40 },
        ],
      },
      seededState(),
      { lastSyncAt: '2026-09-15T00:00:00Z' },
    )
    const cropInsert = opsOf(plan, 'insert', 'crops')[0] as Extract<ApplyOp, { op: 'insert' }>
    expect(cropInsert.values).toEqual({ name: 'Sunflower', harvest_category: 'fall', double_crop: false })
    expect(plan.results.find((r) => r.grain_table === 'crops')).toMatchObject({ action: 'created', reason: 'created because a planting named it' })
    const soyInsert = opsOf(plan, 'insert', 'field_plantings')[1] as Extract<ApplyOp, { op: 'insert' }>
    expect(soyInsert.values.crop_id).toBe('soy')
    // A crop without a farm_uid never gets an id-map row (nothing to key on).
    expect(opsOf(plan, 'link', 'crops')).toHaveLength(0)
  })

  it('pairs a double-crop planting to its preceding planting, whether existing or created in the same batch, in any order', () => {
    const plan = planLandSync(
      {
        plantings: [
          // Soybeans first, wheat second: the pairing pass still resolves.
          { farm_uid: 'F-PL-SOY', field_farm_uid: 'F-FIELD-1', crop: 'Soybean', season_year: 2027, planted_acres: 40, preceding_farm_uid: 'F-PL-WHEAT' },
          { farm_uid: 'F-PL-WHEAT', field_farm_uid: 'F-FIELD-1', crop: 'Wheat', season_year: 2027, planted_acres: 40, preceding_farm_uid: null },
          // Existing wheat pl-2 (unmanaged, older than last sync) precedes a new soybean row on field-2.
          { farm_uid: 'F-PL-SOY2', field_farm_uid: 'F-FIELD-2', crop: 'Soybean', season_year: 2026, planted_acres: 80, preceding_farm_uid: 'F-PL-2' },
        ],
        fields: [{ farm_uid: 'F-FIELD-2', farm_farm_uid: 'F-FARM-2', name_or_number: 'Bottom 80', total_acres: 80, irrigated_acres: 80 }],
        farms: [{ farm_uid: 'F-FARM-2', name: 'River Bottom', entity_farm_uid: 'F-ENT-1', is_share_rent: true, landlord_share_percentage: 33.33 }],
      },
      (() => {
        const s = seededState()
        s.idMap.add('field_plantings', 'pl-2', 'F-PL-2')
        return s
      })(),
      { lastSyncAt: '2026-09-15T00:00:00Z' },
    )
    const pairing = plan.ops.filter((o): o is Extract<ApplyOp, { op: 'update' }> => o.op === 'update' && 'paired_planting_id' in o.values)
    expect(pairing).toEqual([
      { op: 'update', table: 'field_plantings', id: { $ref: 'field_plantings:F-PL-SOY' }, values: { paired_planting_id: { $ref: 'field_plantings:F-PL-WHEAT' } } },
      { op: 'update', table: 'field_plantings', id: { $ref: 'field_plantings:F-PL-SOY2' }, values: { paired_planting_id: 'pl-2' } },
    ])
    // Pairing ops come after every planting insert.
    const lastInsert = plan.ops.map((o) => o.op).lastIndexOf('insert')
    const firstPairing = plan.ops.indexOf(pairing[0])
    expect(firstPairing).toBeGreaterThan(lastInsert)
  })

  it('leaves the pairing alone (with a reason) when the preceding planting is unknown', () => {
    const plan = planLandSync(
      { plantings: [{ farm_uid: 'F-PL-1', field_farm_uid: 'F-FIELD-1', crop: 'Corn', season_year: 2026, planted_acres: 40, planting_date: '2026-04-10', preceding_farm_uid: 'F-PL-GHOST' }] },
      seededState(),
      { lastSyncAt: '2026-09-15T00:00:00Z' },
    )
    expect(plan.results[0]).toMatchObject({ action: 'unchanged' })
    expect(plan.results[0].reason).toMatch(/preceding planting F-PL-GHOST is not linked/)
  })

  it('replaces varieties as a set and counts a variety-only change as an update', () => {
    const plan = planLandSync(
      { plantings: [{ farm_uid: 'F-PL-1', field_farm_uid: 'F-FIELD-1', crop: 'Corn', season_year: 2026, planted_acres: 40, planting_date: '2026-04-10', varieties: ['DKC 68-35', { variety: 'P1197', acres: 10 }] }] },
      seededState(),
      { lastSyncAt: '2026-09-15T00:00:00Z' },
    )
    expect(plan.results[0].action).toBe('updated')
    expect(opsOf(plan, 'replace_varieties')).toEqual([
      { op: 'replace_varieties', planting: 'pl-1', varieties: [{ variety: 'DKC 68-35', acres: 0, bushels: null }, { variety: 'P1197', acres: 10, bushels: null }] },
    ])
    const same = planLandSync(
      { plantings: [{ farm_uid: 'F-PL-1', field_farm_uid: 'F-FIELD-1', crop: 'Corn', season_year: 2026, planted_acres: 40, planting_date: '2026-04-10', varieties: [{ variety: 'dkc 68-35', acres: 40 }] }] },
      seededState(),
      { lastSyncAt: '2026-09-15T00:00:00Z' },
    )
    expect(same.results[0].action).toBe('unchanged')
    expect(opsOf(same, 'replace_varieties')).toHaveLength(0)
  })

  it('ARCHIVE RULES: refuses fields/plantings with harvest data, archives clean ones, never emits a delete, and orders farms after their fields', () => {
    const state = seededState()
    state.idMap.add('fields', 'field-2', 'F-FIELD-2')
    state.idMap.add('field_plantings', 'pl-2', 'F-PL-2')
    state.idMap.add('farms', 'farm-2', 'F-FARM-2')
    state.idMap.add('entities', 'ent-2', 'F-ENT-2')
    const plan = planLandSync(
      {
        deletions: [
          { grain_table: 'fields', farm_uid: 'F-FIELD-1' },          // has loads → refused
          { grain_table: 'field_plantings', farm_uid: 'F-PL-1' },    // has loads → refused
          { grain_table: 'field_plantings', farm_uid: 'F-PL-2' },    // clean → archived
          { grain_table: 'fields', farm_uid: 'F-FIELD-2' },          // clean → archived
          { grain_table: 'farms', farm_uid: 'F-FARM-2' },            // its only field archives in this batch → archived
          { grain_table: 'entities', farm_uid: 'F-ENT-2' },          // its only farm archives in this batch → archived
          { grain_table: 'farms', farm_uid: 'F-FARM-1' },            // field-1 still active → refused
          { grain_table: 'crops', farm_uid: 'corn' },                // never archivable
          { grain_table: 'fields', farm_uid: 'F-NOPE' },             // not linked
        ],
      },
      state,
      { lastSyncAt: '2026-09-15T00:00:00Z' },
    )
    expect(plan.results.map((r) => r.action)).toEqual(['refused', 'refused', 'archived', 'archived', 'archived', 'archived', 'refused', 'refused', 'refused'])
    expect(plan.results[0].reason).toMatch(/loads, yields, or settlements/)
    expect(plan.results[6].reason).toMatch(/still has 1 active field/)
    expect(plan.ops.every((o) => o.op === 'archive')).toBe(true)
    expect(opsOf(plan, 'archive').map((o) => (o as { table: string; id: string }).id)).toEqual(['pl-2', 'field-2', 'farm-2', 'ent-2'])
    expect(JSON.stringify(plan.ops)).not.toMatch(/delete/)
  })

  it('dataBearingKeys collects fields and plantings from loads, splits, combine entries, gin receipts, and yield breakouts', () => {
    const k = dataBearingKeys({
      loads: [{ from_type: 'field', from_field_id: 'f1', crop_id: 'corn', crop_year: 2026 }, { from_type: 'bin', from_field_id: null, crop_id: 'corn', crop_year: 2026 }],
      splits: [{ load_id: 'L9', field_id: 'f2', crop_id: 'soy' }],
      loadYearById: new Map([['L9', 2025]]),
      combineEntries: [{ field_id: 'f3', crop_id: 'wheat', crop_year: 2026 }],
      ginReceipts: [{ field_id: 'f4', crop_year: 2026 }, { field_id: null, crop_year: 2026 }],
      cottonCropIds: new Set(['cotton']),
      plantingsWithBreakout: [{ field_id: 'f5', crop_id: 'corn', season_year: 2026, irrigated_bushels: 100, dryland_bushels: null }],
    })
    expect([...k.fieldIdsWithData].sort()).toEqual(['f1', 'f2', 'f3', 'f4'])
    expect([...k.plantingKeysWithData].sort()).toEqual(['f1|corn|2026', 'f2|soy|2025', 'f3|wheat|2026', 'f4|cotton|2026', 'f5|corn|2026'])
  })
})

describe('assumptions write', () => {
  const base = {
    cropYear: 2026,
    crops: [{ id: 'corn', name: 'Corn' }, { id: 'soy', name: 'Soybean' }],
    existing: [{ crop_id: 'soy', crop_year: 2026, cost_manual_override: true }],
    scenarios: [{ id: 'sc-1', budget_crop_year: 2026, follow_farm_costs: true }, { id: 'sc-2', budget_crop_year: 2026, follow_farm_costs: false }],
    budgetLines: [
      { id: 'bl-1', scenario_id: 'sc-1', crop_id: 'corn', practice: null, cropping: null },
      { id: 'bl-2', scenario_id: 'sc-1', crop_id: 'corn', practice: 'irrigated', cropping: 'full_season' },
      { id: 'bl-3', scenario_id: 'sc-1', crop_id: 'corn', practice: 'non_irrigated', cropping: 'double_crop' },
      { id: 'bl-4', scenario_id: 'sc-2', crop_id: 'corn', practice: null, cropping: null },
    ],
    now: '2026-09-17T12:00:00Z',
  }
  it('writes costs with source + timestamp, follows only scenarios marked to follow, and skips a manual override', () => {
    const plan = planAssumptionsWrite({
      ...base,
      rows: [
        { crop: 'corn', cost_per_acre: 600, cost_per_acre_irrigated: 700, cost_per_acre_dryland: 500, cost_per_acre_dc_dryland: 350, computed_at: '2026-09-16T08:00:00Z' },
        { crop: 'Soybean', cost_per_acre: 400 },
        { crop: 'Sunflower', cost_per_acre: 300 },
        { crop: 'corn', cost_per_acre: 1 },
      ],
    })
    expect(plan.upserts).toEqual([{
      crop_id: 'corn', crop_year: 2026, cost_per_acre: 600, cost_per_acre_irr: 700, cost_per_acre_dry: 500, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: 350,
      cost_source: 'turnrow_farm', cost_source_updated_at: '2026-09-16T08:00:00Z', cost_includes_insurance: false,
    }])
    expect(plan.budgetLineUpdates).toEqual([
      { id: 'bl-1', cost_per_acre: 600, cost_source: 'turnrow_farm', cost_source_updated_at: '2026-09-16T08:00:00Z' },
      { id: 'bl-2', cost_per_acre: 700, cost_source: 'turnrow_farm', cost_source_updated_at: '2026-09-16T08:00:00Z' },
      { id: 'bl-3', cost_per_acre: 350, cost_source: 'turnrow_farm', cost_source_updated_at: '2026-09-16T08:00:00Z' },
    ])
    expect(plan.results).toEqual([
      { crop: 'corn', action: 'updated', budget_lines_updated: 3 },
      { crop: 'Soybean', action: 'skipped', reason: 'manual override is on in Turnrow Grain for this crop year', budget_lines_updated: 0 },
      { crop: 'Sunflower', action: 'skipped', reason: 'no crop named "Sunflower" in Turnrow Grain — sync land first', budget_lines_updated: 0 },
      { crop: 'corn', action: 'skipped', reason: 'duplicate crop in this request', budget_lines_updated: 0 },
    ])
  })
  it('budget cells fall back to the blended cost when the breakout is blank', () => {
    const row = { crop_id: 'c', crop_year: 2026, cost_per_acre: 500, cost_per_acre_irr: null, cost_per_acre_dry: 450, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null, cost_source: 'turnrow_farm' as const, cost_source_updated_at: 'x', cost_includes_insurance: false }
    expect(budgetCellCost({ practice: 'irrigated', cropping: null }, row)).toBe(500)
    expect(budgetCellCost({ practice: 'non_irrigated', cropping: 'full_season' }, row)).toBe(450)
    expect(budgetCellCost({ practice: 'non_irrigated', cropping: 'double_crop' }, row)).toBe(500)
  })
})

describe('landowner settlements', () => {
  const ctx = {
    idMap: new IdMap([{ grain_table: 'landowners', grain_id: 'lo-1', farm_uid: 'F-LO-1' }]),
    landowners: [{ id: 'lo-1', name: 'Smith Family Trust' }, { id: 'lo-2', name: 'Jones Estate' }],
    now: '2026-09-17T12:00:00Z',
  }
  const uid = '11111111-2222-3333-4444-555555555555'
  it('normalizes a statement, resolving the landowner by id map then by name', () => {
    const a = normalizeLandownerSettlement({ farm_uid: uid, landowner_name: 'Whoever', landowner_farm_uid: 'F-LO-1', crop_year: '2026', lease_type: 'crop_share', statement: { sections: [] }, finalized_at: '2026-09-01' }, ctx)
    expect('row' in a && a.row).toMatchObject({ farm_uid: uid, landowner_id: 'lo-1', crop_year: 2026, lease_type: 'crop_share', received_at: ctx.now })
    const b = normalizeLandownerSettlement({ farm_uid: uid, landowner_name: 'jones estate', crop_year: 2026, statement: {} }, ctx)
    expect('row' in b && b.row.landowner_id).toBe('lo-2')
    const c = normalizeLandownerSettlement({ farm_uid: uid, landowner_name: 'Nobody', crop_year: 2026, statement: {} }, ctx)
    expect('row' in c && c.row.landowner_id).toBeNull()
  })
  it('refuses bad input', () => {
    expect(normalizeLandownerSettlement({ farm_uid: 'lease-1', landowner_name: 'x', crop_year: 2026, statement: {} }, ctx)).toMatchObject({ error: expect.stringMatching(/uuid/) })
    expect(normalizeLandownerSettlement({ farm_uid: uid, landowner_name: '', crop_year: 2026, statement: {} }, ctx)).toMatchObject({ error: 'landowner_name is required' })
    expect(normalizeLandownerSettlement({ farm_uid: uid, landowner_name: 'x', crop_year: 'soon', statement: {} }, ctx)).toMatchObject({ error: 'crop_year is required' })
    expect(normalizeLandownerSettlement({ farm_uid: uid, landowner_name: 'x', crop_year: 2026, statement: 'rows' }, ctx)).toMatchObject({ error: 'statement must be an object' })
  })
  it('PARTNER SCOPE ISOLATION: a share sees only its own landowner\'s statements, never an unresolved or another landowner\'s, and never the landowner_id key', () => {
    const rows = [
      { id: 's1', farm_uid: 'u1', landowner_id: 'lo-1', landowner_name: 'Smith Family Trust', crop_year: 2026, lease_type: 'crop_share', statement: { total_rent: 100 }, finalized_at: null, updated_at: '2026-09-01T00:00:00Z' },
      { id: 's2', farm_uid: 'u2', landowner_id: 'lo-2', landowner_name: 'Jones Estate', crop_year: 2026, lease_type: 'cash', statement: { total_rent: 200 }, finalized_at: null, updated_at: '2026-09-01T00:00:00Z' },
      { id: 's3', farm_uid: 'u3', landowner_id: null, landowner_name: 'Smith Family Trust', crop_year: 2026, lease_type: 'cash', statement: { total_rent: 300 }, finalized_at: null, updated_at: '2026-09-01T00:00:00Z' },
      { id: 's0', farm_uid: 'u0', landowner_id: 'lo-1', landowner_name: 'Smith Family Trust', crop_year: 2025, lease_type: 'crop_share', statement: { total_rent: 90 }, finalized_at: null, updated_at: '2025-09-01T00:00:00Z' },
    ]
    const mine = landownerSettlementsForShare(rows, 'lo-1', null)
    expect(mine.map((r) => r.id)).toEqual(['s1', 's0'])
    expect(mine[0]).not.toHaveProperty('landowner_id')
    expect(landownerSettlementsForShare(rows, 'lo-1', 2026).map((r) => r.id)).toEqual(['s1'])
    expect(landownerSettlementsForShare(rows, 'lo-3', null)).toEqual([])
    expect(JSON.stringify(mine)).not.toContain('200')
    expect(JSON.stringify(mine)).not.toContain('300')
  })
})

describe('managed-land predicate', () => {
  it('land is managed only by an ACTIVE link with land:write that has completed an inbound sync', () => {
    expect(landManagedByFarm(null)).toBe(false)
    expect(landManagedByFarm(linkRow({ status: 'pending' }))).toBe(false)
    expect(landManagedByFarm(linkRow({ last_sync: {} }))).toBe(false)
    expect(landManagedByFarm(linkRow({ last_sync: { inbound: { at: '2026-09-17T10:00:00Z', endpoint: 'land/sync', counts: {} } } }))).toBe(true)
    expect(landManagedByFarm(linkRow({ scopes: ['production:read'], last_sync: { inbound: { at: 'x', endpoint: 'land/sync', counts: {} } } }))).toBe(false)
    expect(landManagedByFarm(linkRow({ status: 'revoked', last_sync: { inbound: { at: 'x', endpoint: 'land/sync', counts: {} } } }))).toBe(false)
  })
  it('managed rows are read-only; unmanaged rows stay editable; nothing is read-only before the link manages land', () => {
    expect(landRowEditable({ managed_by: 'turnrow_farm' }, true)).toBe(false)
    expect(landRowEditable({ managed_by: null }, true)).toBe(true)
    expect(landRowEditable({ managed_by: 'turnrow_farm' }, false)).toBe(true)
    expect(landImportBlockedMessage('farms')).toMatch(/^Land records are managed in Turnrow Farm\./)
    expect(landImportBlockedMessage('buyers')).toBeNull()
  })
})
