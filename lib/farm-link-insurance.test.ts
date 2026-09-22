// The crop insurance pull for the Turnrow Farm link (088): the aggregation to
// entity x crop x practice, the premium / subsidy arithmetic, indemnity_received
// only once the harvest price is final, the tombstones (a removed rider moves a
// surviving row, a removed policy raises a `deleted: true` row once nothing
// covers the key), the paging + ?since= contract the route rides, the 403 for a
// pairing without insurance:read, and the organization guard: a token for one
// organization never sees another's policies.

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { IdMap, pageRecords, scopeDenied, FARM_LINK_SCOPES } from '@/lib/farm-link'
import { loadInsurancePayload, shapeInsuranceRecords, type FarmLinkInsuranceRecord, type InsuranceDeletionRow } from '@/lib/farm-link-outbound'
import type { ProjectedPolicy } from '@/lib/crop-insurance'
import type { CropInsurancePolicy } from '@/lib/types'

const idMap = new IdMap([
  { grain_table: 'entities', grain_id: 'ent-1', farm_uid: 'F-ENT-1' },
  { grain_table: 'entities', grain_id: 'ent-2', farm_uid: 'F-ENT-2' },
])
const ENTITIES = [{ id: 'ent-1', name: 'Turnrow Farms LLC' }, { id: 'ent-2', name: 'Bayou Land Co' }]
const CROPS = [{ id: 'corn', name: 'Corn' }, { id: 'beans', name: 'Soybeans' }]

function policy(over: Partial<CropInsurancePolicy> & { id: string }): CropInsurancePolicy {
  return {
    entity_id: 'ent-1', crop_id: 'corn', crop_year: 2026, county_id: null, policy_number: null,
    plan_type: 'RP', practice: 'irrigated', coverage_level: 0.8, unit_structure: 'enterprise',
    aph_yield: 200, projected_price: 4.5, harvest_price: null, volatility_factor: null,
    insured_acres: 100, premium_per_acre: null, total_premium: null, premium_subsidy_pct: null,
    notes: null, covers_all_planted_acres: false, coverage_note: null,
    expected_county_yield: null, expected_county_revenue: null, protection_factor: null,
    source: 'manual', created_at: '2026-02-01T00:00:00Z',
    ...over,
  } as CropInsurancePolicy
}

/** Only the fields the shaper reads. */
function projected(p: CropInsurancePolicy, o: { premium: number; basePremium?: number; indemnity?: number; final?: boolean }): ProjectedPolicy {
  return {
    policy: p,
    base: {} as ProjectedPolicy['base'],
    sco: null, eco: null, stax: null, mco: null,
    basePremium: o.basePremium ?? o.premium,
    comp: { premiumPaid: o.premium, totalIndemnity: o.indemnity ?? 0 } as ProjectedPolicy['comp'],
    harvest: { source: o.final ? 'final' : 'estimate' } as ProjectedPolicy['harvest'],
    assumedYield: 0,
  }
}

function shape(over: {
  projected: readonly ProjectedPolicy[]
  touchedAt?: Record<string, string>
  deletions?: readonly InsuranceDeletionRow[]
}): FarmLinkInsuranceRecord[] {
  return shapeInsuranceRecords({
    cropYear: 2026, projected: over.projected, entities: ENTITIES, crops: CROPS,
    touchedAt: new Map(Object.entries(over.touchedAt ?? {})), deletions: over.deletions ?? [],
    idMap, asOf: '2026-09-21T12:00:00Z',
  })
}

describe('insurance:read scope', () => {
  it('is one of the link scopes and denies with its own name so the Farm side can say "re-pair to add insurance"', () => {
    expect(FARM_LINK_SCOPES).toContain('insurance:read')
    expect(scopeDenied(['production:read', 'income:read'], 'insurance:read')).toMatchObject({
      code: 'missing_scope', scope: 'insurance:read',
    })
    expect(scopeDenied(['insurance:read'], 'insurance:read')).toBeNull()
  })
})

describe('shapeInsuranceRecords — aggregation to entity x crop x practice', () => {
  // Two entities and a split policy: entity 1 carries irrigated + dryland corn
  // (the split), entity 2 carries one dryland corn policy; entity 1's irrigated
  // corn is written as TWO county policies that must sum into one row.
  const P = {
    irrA: policy({ id: 'p1', entity_id: 'ent-1', practice: 'irrigated', insured_acres: 400, premium_subsidy_pct: 60, coverage_level: 0.8 }),
    irrB: policy({ id: 'p2', entity_id: 'ent-1', practice: 'irrigated', insured_acres: 240, premium_subsidy_pct: 60, coverage_level: 0.85 }),
    dryA: policy({ id: 'p3', entity_id: 'ent-1', practice: 'non_irrigated', insured_acres: 300, premium_subsidy_pct: null }),
    dry2: policy({ id: 'p4', entity_id: 'ent-2', practice: 'non_irrigated', insured_acres: 150, premium_subsidy_pct: 55 }),
    beans: policy({ id: 'p5', entity_id: 'ent-1', crop_id: 'beans', practice: 'irrigated', insured_acres: 200, plan_type: 'YP', unit_structure: 'basic' }),
  }
  const rows = shape({
    projected: [
      projected(P.irrA, { premium: 12000 }),
      projected(P.irrB, { premium: 6240 }),
      projected(P.dryA, { premium: 4500, indemnity: 9000 }),
      projected(P.dry2, { premium: 2250, indemnity: 0 }),
      projected(P.beans, { premium: 3000 }),
    ],
    touchedAt: { p1: '2026-03-01T00:00:00Z', p2: '2026-06-15T00:00:00Z', p3: '2026-04-01T00:00:00Z', p4: '2026-05-01T00:00:00Z', p5: '2026-03-10T00:00:00Z' },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))

  it('one row per entity, crop, and practice — two counties of the same key sum', () => {
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.id).sort()).toEqual([
      'ent-1|beans|irrigated|2026', 'ent-1|corn|dryland|2026', 'ent-1|corn|irrigated|2026', 'ent-2|corn|dryland|2026',
    ])
    const irr = byId.get('ent-1|corn|irrigated|2026')!
    expect(irr).toMatchObject({
      entity_code: 'F-ENT-1', entity_farm_uid: 'F-ENT-1', entity_name: 'Turnrow Farms LLC',
      crop: 'Corn', practice: 'irrigated', plan: 'RP', unit_structure: 'enterprise',
      acres_insured: 640, producer_premium: 18240, allocation_basis: 'entity_crop', policy_count: 2,
    })
    // Acre-weighted coverage: (0.80 x 400 + 0.85 x 240) / 640.
    expect(irr.coverage_level).toBeCloseTo(0.8188, 4)
  })

  it('the split policy stays two rows, and each entity keeps its own', () => {
    expect(byId.get('ent-1|corn|dryland|2026')).toMatchObject({ entity_id: 'ent-1', acres_insured: 300, producer_premium: 4500 })
    expect(byId.get('ent-2|corn|dryland|2026')).toMatchObject({ entity_id: 'ent-2', entity_code: 'F-ENT-2', entity_name: 'Bayou Land Co', acres_insured: 150, producer_premium: 2250 })
    expect(byId.get('ent-1|beans|irrigated|2026')).toMatchObject({ crop: 'Soybeans', plan: 'YP', unit_structure: 'basic', producer_premium: 3000 })
  })

  it('subsidy and total_premium come off premium_subsidy_pct (the stored premium is AFTER subsidy); no percentage returns null, never zero', () => {
    // 18,240 producer-paid at a 60% subsidy: gross 45,600, subsidy 27,360.
    expect(byId.get('ent-1|corn|irrigated|2026')).toMatchObject({ subsidy: 27360, total_premium: 45600 })
    expect(byId.get('ent-1|corn|dryland|2026')).toMatchObject({ subsidy: null, total_premium: null })
  })

  it("a row's updated_at is the newest change across its policies", () => {
    expect(byId.get('ent-1|corn|irrigated|2026')!.updated_at).toBe('2026-06-15T00:00:00Z')
  })

  it('allocation_basis is always entity_crop and effective_date is null — Grain keeps nothing per field and no policy date', () => {
    for (const r of rows) {
      expect(r.allocation_basis).toBe('entity_crop')
      expect(r.effective_date).toBeNull()
    }
  })
})

describe('shapeInsuranceRecords — practice, plan, and operation-level rows', () => {
  it("maps Grain's non_irrigated to dryland, AYP to other, and mixed plans or unit structures to other/mixed", () => {
    const rows = shape({
      projected: [
        projected(policy({ id: 'a', plan_type: 'AYP', practice: 'non_irrigated' }), { premium: 100 }),
        projected(policy({ id: 'b', crop_id: 'beans', plan_type: 'RP', unit_structure: 'basic' }), { premium: 100 }),
        projected(policy({ id: 'c', crop_id: 'beans', plan_type: 'YP', unit_structure: 'optional' }), { premium: 100 }),
      ],
    })
    expect(rows.find((r) => r.id === 'ent-1|corn|dryland|2026')).toMatchObject({ practice: 'dryland', plan: 'other' })
    expect(rows.find((r) => r.id === 'ent-1|beans|irrigated|2026')).toMatchObject({ plan: 'other', unit_structure: 'mixed' })
  })

  it('a policy with no entity rolls up to one operation row with a null entity_code', () => {
    const rows = shape({ projected: [projected(policy({ id: 'x', entity_id: null }), { premium: 500 })] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'operation|corn|irrigated|2026', entity_id: null, entity_code: null, entity_farm_uid: null, entity_name: null, producer_premium: 500 })
  })
})

describe('shapeInsuranceRecords — indemnities', () => {
  it('indemnity_expected is always the projection; indemnity_received only once EVERY contributing policy has a final harvest price', () => {
    const one = shape({ projected: [projected(policy({ id: 'a' }), { premium: 100, indemnity: 5000, final: true })] })
    expect(one[0]).toMatchObject({ indemnity_expected: 5000, indemnity_received: 5000 })

    const mixed = shape({
      projected: [
        projected(policy({ id: 'a' }), { premium: 100, indemnity: 5000, final: true }),
        projected(policy({ id: 'b' }), { premium: 100, indemnity: 1000, final: false }),
      ],
    })
    expect(mixed[0]).toMatchObject({ indemnity_expected: 6000, indemnity_received: null })
  })
})

describe('shapeInsuranceRecords — deletions', () => {
  const live = policy({ id: 'p1', practice: 'irrigated' })

  it('a removed policy whose key nothing else covers comes back as a deleted row', () => {
    const rows = shape({
      projected: [],
      deletions: [{ crop_year: 2026, entity_id: 'ent-1', crop_id: 'corn', practice: 'irrigated', deleted_at: '2026-09-20T10:00:00Z' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'ent-1|corn|irrigated|2026', deleted: true, updated_at: '2026-09-20T10:00:00Z',
      producer_premium: 0, acres_insured: 0, entity_code: 'F-ENT-1',
    })
  })

  it('a removed policy whose key another policy still covers is NOT deleted — the row survives with the remaining premium', () => {
    const rows = shape({
      projected: [projected(live, { premium: 7000 })],
      touchedAt: { p1: '2026-03-01T00:00:00Z' },
      deletions: [{ crop_year: 2026, entity_id: 'ent-1', crop_id: 'corn', practice: 'irrigated', deleted_at: '2026-09-20T10:00:00Z' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].deleted).toBeUndefined()
    expect(rows[0].producer_premium).toBe(7000)
    // A rider removed off a surviving policy never touches the policy's own
    // updated_at, so the tombstone is what moves the row into a delta pull.
    expect(rows[0].updated_at).toBe('2026-09-20T10:00:00Z')
  })

  it('deletions from another crop year are ignored', () => {
    const rows = shape({
      projected: [],
      deletions: [{ crop_year: 2025, entity_id: 'ent-1', crop_id: 'corn', practice: 'irrigated', deleted_at: '2026-09-20T10:00:00Z' }],
    })
    expect(rows).toHaveLength(0)
  })
})

describe('the route contract: ?since= and paging', () => {
  const rows = shape({
    projected: [
      projected(policy({ id: 'p1', practice: 'irrigated' }), { premium: 100 }),
      projected(policy({ id: 'p2', practice: 'non_irrigated' }), { premium: 200 }),
      projected(policy({ id: 'p3', crop_id: 'beans' }), { premium: 300 }),
    ],
    touchedAt: { p1: '2026-03-01T00:00:00Z', p2: '2026-06-01T00:00:00Z', p3: '2026-09-01T00:00:00Z' },
  })

  it('?since= keeps only the rows changed on or after it', () => {
    expect(pageRecords(rows, { limit: 500, since: '2026-06-01' }).data.map((r) => r.id)).toEqual([
      'ent-1|corn|dryland|2026', 'ent-1|beans|irrigated|2026',
    ])
    expect(pageRecords(rows, { limit: 500, since: '2026-09-02' }).data).toHaveLength(0)
  })

  it('the cursor walks (updated_at, id) and stops with a null next_cursor', () => {
    const first = pageRecords(rows, { limit: 2 })
    expect(first.data.map((r) => r.id)).toEqual(['ent-1|corn|irrigated|2026', 'ent-1|corn|dryland|2026'])
    expect(first.next_cursor).toBeTruthy()
    const second = pageRecords(rows, { limit: 2, cursor: { updatedAt: '2026-06-01T00:00:00Z', id: 'ent-1|corn|dryland|2026' } })
    expect(second.data.map((r) => r.id)).toEqual(['ent-1|beans|irrigated|2026'])
    expect(second.next_cursor).toBeNull()
  })

  it('a full pull (no ?since=) drops the deleted rows the route filters out', () => {
    const withTomb = shape({
      projected: [projected(policy({ id: 'p1' }), { premium: 100 })],
      deletions: [{ crop_year: 2026, entity_id: 'ent-2', crop_id: 'corn', practice: 'non_irrigated', deleted_at: '2026-09-20T10:00:00Z' }],
    })
    expect(withTomb).toHaveLength(2)
    // The route's rule, verbatim: tombstones answer a delta pull only.
    expect(withTomb.filter((r) => !r.deleted)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The organization guard
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

/** A Supabase double backed by seeded tables that HONORS .eq() — so a loader
 *  that forgets .eq('org_id', ...) on any table pulls the other org's rows and
 *  the test fails. */
function seededClient(tables: Record<string, Row[]>): SupabaseClient {
  const builder = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const b: Record<string, unknown> = {}
    const self = () => b
    b.select = self
    for (const m of ['order', 'limit', 'neq', 'gt', 'lt', 'gte', 'lte', 'is', 'not', 'or', 'filter', 'ilike']) b[m] = self
    b.eq = (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return b }
    b.in = (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return b }
    b.range = (from: number, to: number) => {
      const page = rows.slice(from, to + 1)
      return { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: page, error: null }).then(resolve) }
    }
    b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    b.single = async () => ({ data: rows[0] ?? null, error: null })
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
    return b
  }
  return { from: (t: string) => builder(t), rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient
}

describe('loadInsurancePayload — organization guard', () => {
  const ORG_A = 'org-a'
  const ORG_B = 'org-b'
  const tables: Record<string, Row[]> = {
    crops: [
      { id: 'corn', org_id: ORG_A, name: 'Corn', harvest_category: 'fall', double_crop: false, base_moisture_pct: 15, base_lb_per_bushel: 56 },
      { id: 'corn-b', org_id: ORG_B, name: 'Corn', harvest_category: 'fall', double_crop: false, base_moisture_pct: 15, base_lb_per_bushel: 56 },
    ],
    entities: [
      { id: 'ent-1', org_id: ORG_A, name: 'Turnrow Farms LLC', entity_role: 'farming' },
      { id: 'ent-b', org_id: ORG_B, name: 'Someone Else Farms', entity_role: 'farming' },
    ],
    fields: [], farms: [], field_plantings: [], crop_assumptions: [],
    loads: [], load_splits: [], gin_receipts: [], cotton_bales: [], combine_yield_entries: [],
    harvest_price_estimates: [], county_yield_assumptions: [], farm_base_acres: [],
    arc_plc_elections: [], arc_plc_payments: [], other_government_payments: [],
    covered_commodities: [], arc_plc_price_data: [], program_year_config: [],
    crop_insurance_sco: [], crop_insurance_eco: [], crop_insurance_stax: [], crop_insurance_mco: [],
    crop_insurance_deletions: [
      { id: 'd-b', org_id: ORG_B, crop_year: 2026, entity_id: 'ent-b', crop_id: 'corn-b', practice: 'irrigated', deleted_at: '2026-09-01T00:00:00Z' },
    ],
    crop_insurance_policies: [
      { ...policy({ id: 'a-1', entity_id: 'ent-1', crop_id: 'corn' }), org_id: ORG_A, insured_acres: 100, total_premium: 5000, updated_at: '2026-03-01T00:00:00Z' },
      { ...policy({ id: 'b-1', entity_id: 'ent-b', crop_id: 'corn-b' }), org_id: ORG_B, insured_acres: 999, total_premium: 99999, updated_at: '2026-03-01T00:00:00Z' },
    ],
  }

  it("a token for one organization never returns another's policies, entities, or tombstones", async () => {
    const rows = await loadInsurancePayload(seededClient(tables), ORG_A, 2026, idMap)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entity_id: 'ent-1', crop: 'Corn', acres_insured: 100, producer_premium: 5000 })
    const json = JSON.stringify(rows)
    for (const leak of ['ent-b', 'corn-b', 'Someone Else Farms', '99999', 'F-ENT-2']) {
      expect(json).not.toContain(leak)
    }
  })

  it("the other organization sees only its own", async () => {
    const rows = await loadInsurancePayload(seededClient(tables), ORG_B, 2026, idMap)
    expect(rows.filter((r) => !r.deleted)).toHaveLength(1)
    expect(rows.find((r) => !r.deleted)).toMatchObject({ entity_id: 'ent-b', producer_premium: 99999 })
    // Its own tombstone is there, and org A's rows are not.
    expect(JSON.stringify(rows)).not.toContain('ent-1')
  })
})
