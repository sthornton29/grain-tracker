// Landowners shared both ways over the Turnrow Farm link (089): the shared
// name normalization, the FIELD-LEVEL conflict rule (a Grain change after the
// base to a DIFFERENT value conflicts; the same value does not; a Farm write
// never echoes back), the create gate with Grain's closest names, the merge
// that moves every dependent, the archive refusals, withdrawn settlements
// never reaching a share, and the scope gate.

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadActiveShareLandownerIds, loadLandownerChanges, loadLandowners,
  loadSettlementYearsByLandowner, loadShareFacts,
} from '@/lib/farm-link-server'
import {
  findLandownerMatches, landownerNameKey, normalizeLandownerName, sameLandownerName,
} from '@/lib/landowner-match'
import {
  LANDOWNER_SHARED_FIELDS, landownerDuplicateSearch, planLandownerArchive, planLandownerMerge,
  planLandownerSync, shapeLandownerRecords, shapeLeaseTermRecords,
  type FieldChangeRow, type LandownerRow, type LandownerSyncRow,
} from '@/lib/farm-link-landowners'
import { FARM_LINK_SCOPES, landownerSettlementsForShare, normalizeLandownerSettlement, scopeDenied, IdMap, type LandownerSettlementRecord } from '@/lib/farm-link'

// ---------------------------------------------------------------------------
// The shared normalization
// ---------------------------------------------------------------------------

describe('landowner name normalization', () => {
  it('ignores case, punctuation, the legal form, and the Farms descriptor', () => {
    expect(sameLandownerName('Smith Family Farms, LLC', 'Smith Family Farm LLC')).toBe(true)
    expect(sameLandownerName('Smith Family Farms', 'SMITH FAMILY FARMS LLC')).toBe(true)
    expect(sameLandownerName('Smith Farms LLC', 'Smith Farms Inc')).toBe(true)
    expect(sameLandownerName("Smith's Farm", 'Smith Farm')).toBe(true)
  })

  it('reads & as and, and a slash as a separator, in either order', () => {
    expect(sameLandownerName('Smith & Sons', 'Smith and Sons')).toBe(true)
    expect(sameLandownerName('Smith/Jones', 'Jones Smith')).toBe(true)
    expect(sameLandownerName('Jones & Smith', 'Smith and Jones')).toBe(true)
  })

  it('reads "Estate of J Smith" as J Smith', () => {
    expect(sameLandownerName('Estate of J Smith', 'J Smith')).toBe(true)
    expect(sameLandownerName('The Estate of J Smith', 'J. Smith')).toBe(true)
  })

  it('does NOT collapse names that are different legal payees', () => {
    // A trust is not the person; a family entity is not the individual's.
    expect(sameLandownerName('Mary Smith Trust', 'Mary Smith')).toBe(false)
    expect(sameLandownerName('Smith Family Farms', 'Smith Farms')).toBe(false)
    expect(sameLandownerName('Smith Brothers', 'Smith Sisters')).toBe(false)
  })

  it('an all-noise name still matches itself and not every other all-noise name', () => {
    expect(normalizeLandownerName('The Farm LLC')).toBe('')
    expect(sameLandownerName('The Farm LLC', 'The Farm LLC')).toBe(true)
    expect(sameLandownerName('The Farm LLC', 'The Farms Inc')).toBe(false)
    expect(landownerNameKey('')).toBe('')
  })

  it('offers near matches best-first without calling them the same landowner', () => {
    const candidates = [
      { id: 'a', name: 'Smith Family Farms LLC' },
      { id: 'b', name: 'Smith Brothers' },
      { id: 'c', name: 'Delta Land Company' },
    ]
    const hits = findLandownerMatches('Smith Family Farm', candidates)
    expect(hits[0]).toMatchObject({ kind: 'exact', candidate: { id: 'a' } })
    expect(hits.some((h) => h.candidate.id === 'c')).toBe(false)
  })

  it('the duplicate search skips archived and merged landowners', () => {
    const rows: LandownerRow[] = [
      { id: 'live', name: 'Smith Farms' },
      { id: 'gone', name: 'Smith Farms LLC', archived_at: '2026-01-01T00:00:00Z' },
      { id: 'merged', name: 'Smith Farms Inc', merged_into_id: 'live' },
    ]
    expect(landownerDuplicateSearch('Smith Farms, LLC', rows).exact?.id).toBe('live')
  })
})

// ---------------------------------------------------------------------------
// The field-level merge
// ---------------------------------------------------------------------------

const LO: LandownerRow = {
  id: 'lo-1', name: 'Smith Farms', kind: 'company', contact_name: 'Ann Smith',
  phone: '555-0100', email: 'ann@smith.test', address_street: '1 Main St',
  address_city: 'Greenville', address_state: 'MS', address_zip: '38701',
  payee_name: 'Smith Farms LLC', notes: null, updated_at: '2026-01-01T00:00:00Z',
}

const idMapFor = (pairs: Array<[string, string]>) =>
  new IdMap(pairs.map(([grainId, farmUid]) => ({ grain_table: 'landowners', grain_id: grainId, farm_uid: farmUid })))

function plan(args: {
  rows: LandownerSyncRow[]
  landowners?: LandownerRow[]
  changes?: FieldChangeRow[]
  map?: Array<[string, string]>
}) {
  const map = idMapFor(args.map ?? [['lo-1', 'F-LO-1']])
  return planLandownerSync({
    rows: args.rows,
    landowners: args.landowners ?? [LO],
    changes: args.changes ?? [],
    grainIdFor: (uid) => map.grainId('landowners', uid),
    farmUidFor: (id) => map.farmUid('landowners', id),
  })
}

const change = (field: string, newValue: string | null, at: string, by = 'user-1'): FieldChangeRow =>
  ({ landowner_id: 'lo-1', field, old_value: null, new_value: newValue, changed_at: at, changed_by: by })

describe('planLandownerSync — the conflict rule', () => {
  it('applies a field when Grain has not touched it since the base', () => {
    const p = plan({
      rows: [{ farm_uid: 'F-LO-1', fields: { phone: '555-0999' }, base: { phone: '2026-02-01T00:00:00Z' } }],
      changes: [change('phone', '555-0100', '2026-01-15T00:00:00Z')],
    })
    expect(p.results[0]).toMatchObject({ action: 'updated', applied: ['phone'] })
    expect(p.ops).toContainEqual({ op: 'update', id: 'lo-1', values: { phone: '555-0999' } })
  })

  it('conflicts when Grain changed the field AFTER the base to a different value, and says what Grain holds', () => {
    const p = plan({
      rows: [{ farm_uid: 'F-LO-1', fields: { phone: '555-0999' }, base: { phone: '2026-02-01T00:00:00Z' } }],
      changes: [change('phone', '555-0100', '2026-03-01T00:00:00Z')],
    })
    expect(p.results[0]).toMatchObject({ action: 'conflict', applied: [] })
    expect(p.results[0].conflicts).toEqual([{
      field: 'phone', grain_value: '555-0100', farm_value: '555-0999',
      changed_at: '2026-03-01T00:00:00Z', changed_by: 'user-1',
    }])
    expect(p.ops).toHaveLength(0)
  })

  it('a Grain change to the SAME value Farm is sending is not a conflict — the two sides simply agree', () => {
    const p = plan({
      rows: [{ farm_uid: 'F-LO-1', fields: { phone: '555-0100' }, base: { phone: '2026-02-01T00:00:00Z' } }],
      changes: [change('phone', '555-0100', '2026-03-01T00:00:00Z')],
    })
    // Already equal to what Grain holds, so nothing to write either.
    expect(p.results[0]).toMatchObject({ action: 'unchanged' })
  })

  it("a change the LINK wrote never echoes back as Grain's", () => {
    const p = plan({
      rows: [{ farm_uid: 'F-LO-1', fields: { phone: '555-0999' }, base: { phone: '2026-02-01T00:00:00Z' } }],
      changes: [change('phone', '555-0100', '2026-03-01T00:00:00Z', 'turnrow_farm')],
    })
    expect(p.results[0]).toMatchObject({ action: 'updated', applied: ['phone'] })
  })

  it('conflicts are PER FIELD — the rest of the row still applies', () => {
    const p = plan({
      rows: [{
        farm_uid: 'F-LO-1',
        fields: { phone: '555-0999', email: 'new@smith.test', contact_name: 'Bob Smith' },
        base: { phone: '2026-02-01T00:00:00Z', email: '2026-02-01T00:00:00Z', contact_name: '2026-02-01T00:00:00Z' },
      }],
      changes: [change('phone', '555-0100', '2026-03-01T00:00:00Z')],
    })
    const r = p.results[0]
    expect(r.action).toBe('conflict')
    expect(r.applied).toEqual(['email', 'contact_name'])
    expect(r.conflicts?.map((c) => c.field)).toEqual(['phone'])
    expect(p.ops).toContainEqual({ op: 'update', id: 'lo-1', values: { email: 'new@smith.test', contact_name: 'Bob Smith' } })
  })

  it('a field with NO base is treated as the beginning of time, so any Grain change conflicts', () => {
    const p = plan({
      rows: [{ farm_uid: 'F-LO-1', fields: { phone: '555-0999' }, base: {} }],
      changes: [change('phone', '555-0100', '2020-01-01T00:00:00Z')],
    })
    expect(p.results[0].action).toBe('conflict')
  })

  it('unknown or invalid fields are refused rather than silently dropped', () => {
    expect(plan({ rows: [{ farm_uid: 'F-LO-1', fields: { nickname: 'Smitty' } }] }).results[0])
      .toMatchObject({ action: 'refused', reason: expect.stringContaining('nickname') })
    expect(plan({ rows: [{ farm_uid: 'F-LO-1', fields: { kind: 'corporation' } }] }).results[0])
      .toMatchObject({ action: 'refused', reason: expect.stringContaining('kind') })
  })

  it('every shared field is accepted', () => {
    const fields: Record<string, string> = {}
    for (const f of LANDOWNER_SHARED_FIELDS) fields[f] = f === 'kind' ? 'trust' : `v-${f}`
    const p = plan({ rows: [{ farm_uid: 'F-LO-1', fields }] })
    expect(p.results[0].action).toBe('updated')
    expect(p.results[0].applied).toEqual([...LANDOWNER_SHARED_FIELDS])
  })
})

describe('planLandownerSync — the create gate', () => {
  it('an unlinked farm_uid answers unmatched with Grain closest names, and writes nothing', () => {
    const p = plan({
      rows: [{ farm_uid: 'F-NEW', fields: { name: 'Smith Farms, LLC' } }],
      map: [],
    })
    expect(p.results[0]).toMatchObject({ action: 'unmatched', farm_uid: 'F-NEW' })
    expect(p.results[0].candidates?.[0]).toMatchObject({ grain_id: 'lo-1', name: 'Smith Farms', kind: 'exact' })
    expect(p.ops).toHaveLength(0)
  })

  it('create: true adds the landowner and links it in the same transaction', () => {
    const p = plan({
      rows: [{ farm_uid: 'F-NEW', create: true, fields: { name: 'Delta Land Co', kind: 'company' } }],
      map: [],
    })
    expect(p.results[0]).toMatchObject({ action: 'created' })
    expect(p.ops).toEqual([
      { op: 'insert', ref: 'lo:F-NEW', values: { name: 'Delta Land Co', kind: 'company' } },
      { op: 'link', grain_id: { $ref: 'lo:F-NEW' }, farm_uid: 'F-NEW', linked_by: 'sync' },
    ])
  })

  it('create: true without a name is refused', () => {
    expect(plan({ rows: [{ farm_uid: 'F-NEW', create: true, fields: { phone: '555' } }], map: [] }).results[0])
      .toMatchObject({ action: 'refused', reason: expect.stringContaining('name is required') })
  })

  it('an explicit grain_id that is not ours is refused, and a merged-away landowner is refused', () => {
    expect(plan({ rows: [{ farm_uid: 'F-X', grain_id: 'other-org-row' }] }).results[0])
      .toMatchObject({ action: 'refused', reason: expect.stringContaining('not a landowner in this organization') })
    const merged: LandownerRow = { ...LO, id: 'lo-2', merged_into_id: 'lo-1' }
    expect(plan({ rows: [{ farm_uid: 'F-LO-2', grain_id: 'lo-2', fields: { phone: '1' } }], landowners: [LO, merged] }).results[0])
      .toMatchObject({ action: 'refused', reason: expect.stringContaining('merged') })
  })

  it('links an unmapped farm_uid onto a landowner matched by grain_id, even with nothing else to write', () => {
    const p = plan({
      rows: [{ farm_uid: 'F-LO-1', grain_id: 'lo-1', fields: { phone: LO.phone! } }],
      map: [],
    })
    expect(p.results[0].action).toBe('unchanged')
    expect(p.ops).toEqual([{ op: 'link', grain_id: 'lo-1', farm_uid: 'F-LO-1', linked_by: 'sync' }])
  })

  it('counts every verdict', () => {
    const p = plan({
      rows: [
        { farm_uid: 'F-LO-1', fields: { phone: '555-0100' } },
        { farm_uid: 'F-NEW', fields: { name: 'Nobody' } },
        { farm_uid: '', fields: {} },
      ],
      map: [['lo-1', 'F-LO-1']],
    })
    expect(p.counts).toMatchObject({ rows: 3, unchanged: 1, unmatched: 1, refused: 1 })
  })
})

// ---------------------------------------------------------------------------
// Merge and archive
// ---------------------------------------------------------------------------

describe('planLandownerMerge', () => {
  const rows: LandownerRow[] = [{ ...LO, id: 'keep' }, { ...LO, id: 'drop' }]

  it('plans one merge op that moves every dependent', () => {
    const v = planLandownerMerge({ survivorId: 'keep', mergedId: 'drop', landowners: rows, activeShareLandownerIds: new Set() })
    expect(v.ok).toBe(true)
    expect(v.ok && v.ops).toEqual([{ op: 'merge', survivor: 'keep', merged: 'drop', move_share: false }])
  })

  it('refuses an active share unless move_share is set', () => {
    const shares = new Set(['drop'])
    const refused = planLandownerMerge({ survivorId: 'keep', mergedId: 'drop', landowners: rows, activeShareLandownerIds: shares })
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'share_active' })
    const allowed = planLandownerMerge({ survivorId: 'keep', mergedId: 'drop', landowners: rows, activeShareLandownerIds: shares, moveShare: true })
    expect(allowed.ok).toBe(true)
    expect(allowed.ok && allowed.ops[0]).toMatchObject({ move_share: true })
  })

  it('refuses a self-merge, an unknown landowner, and an already-merged one', () => {
    expect(planLandownerMerge({ survivorId: 'keep', mergedId: 'keep', landowners: rows, activeShareLandownerIds: new Set() }))
      .toMatchObject({ ok: false, code: 'same_landowner' })
    expect(planLandownerMerge({ survivorId: 'keep', mergedId: 'ghost', landowners: rows, activeShareLandownerIds: new Set() }))
      .toMatchObject({ ok: false, code: 'not_found' })
    const already: LandownerRow[] = [{ ...LO, id: 'keep' }, { ...LO, id: 'drop', merged_into_id: 'keep' }]
    expect(planLandownerMerge({ survivorId: 'keep', mergedId: 'drop', landowners: already, activeShareLandownerIds: new Set() }))
      .toMatchObject({ ok: false, code: 'already_merged' })
  })
})

describe('planLandownerArchive', () => {
  const rows: LandownerRow[] = [{ ...LO, id: 'lo-1' }]
  const base = { landowners: rows, activeShareLandownerIds: new Set<string>(), settlementYearsByLandowner: new Map<string, number[]>(), openFromYear: 2026 }

  it('archives a landowner with no share and no open settlement', () => {
    expect(planLandownerArchive({ grainId: 'lo-1', ...base }))
      .toEqual({ ok: true, ops: [{ op: 'archive', id: 'lo-1' }] })
  })

  it('refuses an active share', () => {
    expect(planLandownerArchive({ grainId: 'lo-1', ...base, activeShareLandownerIds: new Set(['lo-1']) }))
      .toMatchObject({ ok: false, code: 'share_active' })
  })

  it('refuses a settlement in an open crop year, and allows one that is closed', () => {
    expect(planLandownerArchive({ grainId: 'lo-1', ...base, settlementYearsByLandowner: new Map([['lo-1', [2026]]]) }))
      .toMatchObject({ ok: false, code: 'open_settlement', error: expect.stringContaining('2026') })
    expect(planLandownerArchive({ grainId: 'lo-1', ...base, settlementYearsByLandowner: new Map([['lo-1', [2024, 2025]]]) }).ok)
      .toBe(true)
  })

  it('refuses an unknown landowner and one already archived', () => {
    expect(planLandownerArchive({ grainId: 'ghost', ...base })).toMatchObject({ ok: false, code: 'not_found' })
    expect(planLandownerArchive({ grainId: 'lo-1', ...base, landowners: [{ ...LO, archived_at: '2026-01-01T00:00:00Z' }] }))
      .toMatchObject({ ok: false, code: 'already_archived' })
  })
})

// ---------------------------------------------------------------------------
// The outbound records
// ---------------------------------------------------------------------------

describe('shapeLandownerRecords', () => {
  const map = idMapFor([['lo-1', 'F-LO-1']])
  const shape = (over: Partial<Parameters<typeof shapeLandownerRecords>[0]> = {}) =>
    shapeLandownerRecords({
      landowners: [LO],
      farmUidFor: (id) => map.farmUid('landowners', id),
      shares: [],
      changes: [],
      asOf: '2026-09-21T12:00:00Z',
      ...over,
    })

  it('carries the shared fields, the Farm uid, and the share facts', () => {
    const rows = shape({ shares: [{ landowner_id: 'lo-1', active: true, scopes: ['yields', 'settlements'], last_viewed_at: '2026-09-01T00:00:00Z' }] })
    expect(rows[0]).toMatchObject({
      id: 'lo-1', farm_uid: 'F-LO-1', name: 'Smith Farms', payee_name: 'Smith Farms LLC',
      address_city: 'Greenville', address_state: 'MS',
      share_active: true, share_scopes: ['yields', 'settlements'], share_last_viewed_at: '2026-09-01T00:00:00Z',
    })
  })

  it("lists Grain's own changes and never the link's", () => {
    const rows = shape({
      changes: [
        change('phone', '555-0100', '2026-03-01T00:00:00Z'),
        change('email', 'x@y.test', '2026-03-02T00:00:00Z', 'turnrow_farm'),
      ],
    })
    expect(rows[0].changes).toEqual([
      { field: 'phone', old: null, new: '555-0100', changed_at: '2026-03-01T00:00:00Z', changed_by: 'user-1' },
    ])
  })

  it('reports an archive and a merge so the Farm side can mirror them', () => {
    const rows = shape({
      landowners: [{ ...LO, id: 'lo-2', archived_at: '2026-05-01T00:00:00Z', merged_into_id: 'lo-1' }],
    })
    expect(rows[0]).toMatchObject({ archived_at: '2026-05-01T00:00:00Z', merged_into_id: 'lo-1', merged_into_farm_uid: 'F-LO-1' })
  })
})

describe('shapeLeaseTermRecords', () => {
  const lease = {
    id: 'lt-1', landowner_id: 'lo-1', farm_ids: ['farm-1'], lease_type: 'crop_share',
    share_terms: { defaultPct: 25 }, expense_terms: null, pricing_method: null, cash_terms: null, flex_terms: null,
    payment_timing: 'at settlement', notes: null,
    source_file_name: 'lease.pdf', source_file_path: 'org/leases/lease.pdf',
    managed_by: null, farm_lease_uid: null, updated_at: '2026-04-01T00:00:00Z',
  }
  const args = {
    landowners: [LO],
    farmUidFor: (table: 'landowners' | 'farms', id: string) => (table === 'landowners' && id === 'lo-1' ? 'F-LO-1' : id === 'farm-1' ? 'F-FARM-1' : null),
    signedUrlFor: (path: string | null) => (path ? `https://signed.test/${path}` : null),
    asOf: '2026-09-21T12:00:00Z',
  }

  it('offers an unmanaged lease as a proposal with both sides keys and a signed document URL', () => {
    const rows = shapeLeaseTermRecords({ leases: [lease], ...args })
    expect(rows[0]).toMatchObject({
      id: 'lt-1', landowner_grain_id: 'lo-1', landowner_farm_uid: 'F-LO-1', landowner_name: 'Smith Farms',
      farm_grain_ids: ['farm-1'], farm_farm_uids: ['F-FARM-1'], lease_type: 'crop_share',
      share_terms: { defaultPct: 25 }, payment_timing: 'at settlement',
      source_document_url: 'https://signed.test/org/leases/lease.pdf', source_document_name: 'lease.pdf',
    })
  })

  it('stops offering a lease once Turnrow Farm manages it', () => {
    expect(shapeLeaseTermRecords({ leases: [{ ...lease, managed_by: 'turnrow_farm', farm_lease_uid: 'F-LEASE-1' }], ...args })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Withdrawn settlements + the scope gate
// ---------------------------------------------------------------------------

describe('withdrawn landowner settlements (089)', () => {
  const rows: LandownerSettlementRecord[] = [
    { id: 's1', farm_uid: 'u1', landowner_id: 'lo-1', landowner_name: 'Smith Farms', crop_year: 2026, lease_type: 'crop_share', statement: {}, finalized_at: null, updated_at: null, status: 'final' },
    { id: 's2', farm_uid: 'u2', landowner_id: 'lo-1', landowner_name: 'Smith Farms', crop_year: 2026, lease_type: 'crop_share', statement: {}, finalized_at: null, updated_at: null, status: 'withdrawn' },
    { id: 's3', farm_uid: 'u3', landowner_id: 'lo-1', landowner_name: 'Smith Farms', crop_year: 2025, lease_type: 'cash', statement: {}, finalized_at: null, updated_at: null },
  ]

  it('a withdrawn statement is never served to a share; a pre-089 row with no status still is', () => {
    const served = landownerSettlementsForShare(rows, 'lo-1', null)
    expect(served.map((r) => r.id)).toEqual(['s1', 's3'])
  })

  it('accepts status withdrawn on the way in, and defaults to final', () => {
    const ctx = { idMap: idMapFor([['lo-1', 'F-LO-1']]), landowners: [{ id: 'lo-1', name: 'Smith Farms' }], now: '2026-09-21T12:00:00Z' }
    const input = { farm_uid: '11111111-2222-3333-4444-555555555555', landowner_name: 'Smith Farms', crop_year: 2026, statement: { rows: [] } }
    const final = normalizeLandownerSettlement(input, ctx)
    expect('row' in final && final.row.status).toBe('final')
    // A withdrawal is a tombstone, so it needs no statement body.
    const withdrawn = normalizeLandownerSettlement({ ...input, status: 'withdrawn', statement: null }, ctx)
    expect('row' in withdrawn && withdrawn.row.status).toBe('withdrawn')
    expect(normalizeLandownerSettlement({ ...input, status: 'deleted' }, ctx)).toMatchObject({ error: expect.stringContaining('final') })
  })
})

describe('landowners:write scope', () => {
  it('is a link scope and denies by name so the Farm side can say "re-pair to add landowners"', () => {
    expect(FARM_LINK_SCOPES).toContain('landowners:write')
    expect(scopeDenied(['land:write'], 'landowners:write')).toMatchObject({ code: 'missing_scope', scope: 'landowners:write' })
    expect(scopeDenied(['landowners:write'], 'landowners:write')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The organization guard
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

/** A Supabase double backed by seeded tables that HONORS .eq() — a loader that
 *  forgets .eq('org_id', ...) on any table pulls the other org's rows and the
 *  test fails. */
function seededClient(tables: Record<string, Row[]>): SupabaseClient {
  const builder = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const b: Record<string, unknown> = {}
    const self = () => b
    b.select = self
    for (const m of ['order', 'limit', 'neq', 'gt', 'lt', 'is', 'not', 'or', 'filter', 'ilike']) b[m] = self
    b.eq = (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return b }
    b.gte = (col: string, val: string) => { rows = rows.filter((r) => String(r[col]) >= val); return b }
    b.lte = (col: string, val: string) => { rows = rows.filter((r) => String(r[col]) <= val); return b }
    b.in = (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return b }
    b.range = (from: number, to: number) => ({
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }).then(resolve),
    })
    b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
    return b
  }
  return { from: (t: string) => builder(t), rpc: async () => ({ data: {}, error: null }) } as unknown as SupabaseClient
}

describe('the landowner loaders — organization guard', () => {
  const ORG_A = 'org-a'
  const ORG_B = 'org-b'
  const tables: Record<string, Row[]> = {
    landowners: [
      { ...LO, id: 'lo-a', org_id: ORG_A, name: 'Smith Farms' },
      { ...LO, id: 'lo-b', org_id: ORG_B, name: 'Someone Else Farms', payee_name: 'Do Not Leak LLC' },
    ],
    landowner_field_changes: [
      { landowner_id: 'lo-a', org_id: ORG_A, field: 'phone', old_value: null, new_value: '555-0100', changed_at: '2026-03-01T00:00:00Z', changed_by: 'user-1' },
      { landowner_id: 'lo-b', org_id: ORG_B, field: 'phone', old_value: null, new_value: '555-9999', changed_at: '2026-03-01T00:00:00Z', changed_by: 'user-2' },
    ],
    partner_shares: [
      { landowner_id: 'lo-a', org_id: ORG_A, revoked_at: null, include_yields: true, share_settlements: true, last_viewed_at: '2026-09-01T00:00:00Z' },
      { landowner_id: 'lo-b', org_id: ORG_B, revoked_at: null, include_yields: true, last_viewed_at: '2026-09-02T00:00:00Z' },
    ],
    rent_settlements: [
      { landowner_id: 'lo-a', org_id: ORG_A, crop_year: 2026 },
      { landowner_id: 'lo-b', org_id: ORG_B, crop_year: 2026 },
    ],
  }

  it("a token for one organization never reads another's landowners, changes, or shares", async () => {
    const client = seededClient(tables)
    const [landowners, changes, shares, activeShares, years] = await Promise.all([
      loadLandowners(client, ORG_A),
      loadLandownerChanges(client, ORG_A, null),
      loadShareFacts(client, ORG_A),
      loadActiveShareLandownerIds(client, ORG_A),
      loadSettlementYearsByLandowner(client, ORG_A),
    ])
    expect(landowners.map((l) => l.id)).toEqual(['lo-a'])
    expect(changes.map((c) => c.landowner_id)).toEqual(['lo-a'])
    expect(shares.map((s) => s.landowner_id)).toEqual(['lo-a'])
    expect([...activeShares]).toEqual(['lo-a'])
    expect([...years.keys()]).toEqual(['lo-a'])
    const json = JSON.stringify({ landowners, changes, shares })
    for (const leak of ['lo-b', 'Someone Else Farms', 'Do Not Leak LLC', '555-9999']) {
      expect(json).not.toContain(leak)
    }
  })

  it("and the sync planned from that state can only ever touch that organization's rows", async () => {
    const client = seededClient(tables)
    const [landowners, changes] = await Promise.all([
      loadLandowners(client, ORG_A),
      loadLandownerChanges(client, ORG_A, null),
    ])
    // Farm points at the OTHER org's landowner by grain id; Grain has never
    // heard of it, so the row is refused rather than written.
    const p = planLandownerSync({
      rows: [{ farm_uid: 'F-B', grain_id: 'lo-b', fields: { phone: '555-0000' } }],
      landowners, changes,
      grainIdFor: () => null,
      farmUidFor: () => null,
    })
    expect(p.results[0]).toMatchObject({ action: 'refused' })
    expect(p.ops).toHaveLength(0)
  })
})
