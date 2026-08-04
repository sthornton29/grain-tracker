import { describe, it, expect } from 'vitest'
import { buildEntityScope } from '@/lib/entity-scope'
import { segmentAcresByCrop, expectedProductionFromBreakout } from '@/lib/marketing'
import type { CottonPhysicalInputs } from '@/lib/cotton-sales'
import type { CropAssumption } from '@/lib/types'

// The shared entity-scoping layer used by Season Summary, Marketing, Revenue
// Projections, Income Sensitivity, and Cash Flow. Key invariants:
//   * acreage/production narrow via fields → farms → entity;
//   * entity-keyed rows (contracts, futures, policies) match strictly on their
//     own entity_id (null-entity rows drop out under a filter — same rule as
//     the Contracts page / Hedging Summary);
//   * other USDA payments attribute farm-first (farm's entity), else entity_id;
//   * the OPERATION-WIDE assumptions are never scoped — they apply to the
//     narrowed acres unchanged (no per-entity assumption store);
//   * '' (All entities) is an exact pass-through.

const farms = [
  { id: 'F1', entity_id: 'E1' },
  { id: 'F2', entity_id: 'E2' },
  { id: 'F3', entity_id: null },
]
const fields = [
  { id: 'A', farm_id: 'F1' },
  { id: 'B', farm_id: 'F2' },
  { id: 'C', farm_id: 'F3' },
  { id: 'D', farm_id: null },
]

const scopeE1 = () => buildEntityScope({ entityId: 'E1', farms, fields })
const scopeAll = () => buildEntityScope({ entityId: '', farms, fields })

function assumption(over: Partial<CropAssumption> & Pick<CropAssumption, 'crop_id'>): CropAssumption {
  return {
    id: `a-${over.crop_id}`, crop_year: 2026,
    expected_yield: null, expected_yield_irr: null, expected_yield_dry: null,
    expected_yield_dc_irr: null, expected_yield_dc_dry: null, harvest_complete: false,
    assumed_basis: 0, assumed_futures: null, cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null,
    cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null, notes: null,
    created_at: '', updated_at: '', ...over,
  }
}

describe('buildEntityScope', () => {
  it('narrows plantings to fields on the entity’s farms', () => {
    const plantings = [
      { id: 'p1', field_id: 'A' }, { id: 'p2', field_id: 'B' },
      { id: 'p3', field_id: 'C' }, { id: 'p4', field_id: 'D' },
    ]
    expect(scopeE1().plantings(plantings).map((p) => p.id)).toEqual(['p1'])
    expect(scopeAll().plantings(plantings)).toEqual(plantings)
  })

  it('entity-keyed rows (contracts / futures / policies) match strictly on entity_id', () => {
    const rows = [
      { id: 'c1', entity_id: 'E1' }, { id: 'c2', entity_id: 'E2' }, { id: 'c3', entity_id: null },
    ]
    expect(scopeE1().byEntity(rows).map((r) => r.id)).toEqual(['c1'])
    expect(scopeAll().byEntity(rows)).toEqual(rows)
  })

  it('farm-keyed rows (base acres / elections / ARC-PLC payments) follow the farm’s entity', () => {
    const rows = [
      { id: 'b1', farm_id: 'F1' }, { id: 'b2', farm_id: 'F2' }, { id: 'b3', farm_id: 'F3' },
    ]
    expect(scopeE1().byFarm(rows).map((r) => r.id)).toEqual(['b1'])
    expect(scopeE1().farmInEntity('F1')).toBe(true)
    expect(scopeE1().farmInEntity('F2')).toBe(false)
    expect(scopeE1().farmInEntity(null)).toBe(false)
    expect(scopeAll().farmInEntity(null)).toBe(true)
  })

  it('other USDA payments attribute farm-first, else by entity_id', () => {
    const rows = [
      { id: 'o1', farm_id: 'F1', entity_id: null },   // farm → E1: in
      { id: 'o2', farm_id: 'F2', entity_id: 'E1' },   // farm attribution wins → E2: out
      { id: 'o3', farm_id: null, entity_id: 'E1' },   // entity-keyed: in
      { id: 'o4', farm_id: null, entity_id: null },   // unattributable: out under a filter
    ]
    expect(scopeE1().otherPayments(rows).map((r) => r.id)).toEqual(['o1', 'o3'])
    expect(scopeAll().otherPayments(rows)).toEqual(rows)
  })

  it('filters field-keyed aggregate maps by field, and passes through unfiltered', () => {
    const agg = new Map([
      ['A|corn|2026', { dryBu: 100 }],
      ['B|corn|2026', { dryBu: 200 }],
      ['D|corn|2026', { dryBu: 300 }],
    ])
    const scoped = scopeE1().fieldAgg(agg)
    expect([...scoped.keys()]).toEqual(['A|corn|2026'])
    const all = scopeAll().fieldAgg(agg)
    expect(all).toEqual(agg)
    expect(all).not.toBe(agg) // a copy — callers can't mutate the source
  })

  it('gin receipts attribute by entity_id, then farm, then field', () => {
    const rows = [
      { id: 'g1', entity_id: 'E1', farm_id: null, field_id: null },  // in
      { id: 'g2', entity_id: 'E2', farm_id: 'F1', field_id: null },  // own entity wins: out
      { id: 'g3', entity_id: null, farm_id: 'F1', field_id: null },  // farm → E1: in
      { id: 'g4', entity_id: null, farm_id: null, field_id: 'A' },   // field → F1 → E1: in
      { id: 'g5', entity_id: null, farm_id: null, field_id: null },  // unattributable: out
    ]
    expect(scopeE1().ginReceipts(rows).map((r) => r.id)).toEqual(['g1', 'g3', 'g4'])
    expect(scopeAll().ginReceipts(rows)).toEqual(rows)
  })

  it('cotton physical inputs narrow their four entity-keyed row sets', () => {
    const inputs = {
      cropYear: 2026,
      bales: [{ id: 'bale1' }],
      gradesByBale: new Map(),
      dispositions: [],
      contracts: [{ id: 'sc1', entity_id: 'E1' }, { id: 'sc2', entity_id: 'E2' }],
      poolPayments: [],
      loans: [{ id: 'l1', entity_id: 'E2' }],
      ldps: [{ id: 'ldp1', entity_id: 'E1' }],
      fees: [{ id: 'fee1', entity_id: null }],
    } as unknown as CottonPhysicalInputs
    const scoped = scopeE1().cottonInputs(inputs)
    expect(scoped.contracts.map((c) => c.id)).toEqual(['sc1'])
    expect(scoped.loans).toEqual([])
    expect(scoped.ldps.map((l) => l.id)).toEqual(['ldp1'])
    expect(scoped.fees).toEqual([])
    expect(scoped.bales).toBe(inputs.bales) // production rows ride along
    expect(scopeAll().cottonInputs(inputs)).toBe(inputs)
  })

  it('operation-wide assumptions flow down: one dryland yield applied to each entity’s dryland acres', () => {
    // Two entities' dryland corn; ONE operation-level assumption (165 bu/ac
    // dryland). Scoping narrows the acres, never the assumption.
    const plantings = [
      { id: 'p1', field_id: 'A', crop_id: 'corn', season_year: 2026, irrigated_acres: 0, dryland_acres: 100 },
      { id: 'p2', field_id: 'B', crop_id: 'corn', season_year: 2026, irrigated_acres: 0, dryland_acres: 50 },
    ]
    const assumptions = [assumption({ crop_id: 'corn', expected_yield_dry: 165 })]
    const prodFor = (entityId: string) => {
      const scope = buildEntityScope({ entityId, farms, fields })
      const seg = segmentAcresByCrop(scope.plantings(plantings), 2026, new Set())
      return expectedProductionFromBreakout(seg, assumptions, 2026).get('corn') ?? 0
    }
    expect(prodFor('E1')).toBeCloseTo(165 * 100, 6)   // entity 1's dryland acres
    expect(prodFor('E2')).toBeCloseTo(165 * 50, 6)    // entity 2's dryland acres
    expect(prodFor('')).toBeCloseTo(165 * 150, 6)     // All entities = the sum
  })
})
