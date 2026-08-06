import { describe, it, expect } from 'vitest'
import { buildEntityScope } from '@/lib/entity-scope'
import { segmentAcresByCrop, expectedProductionFromBreakout } from '@/lib/marketing'
import type { CottonPhysicalInputs } from '@/lib/cotton-sales'
import type { CropAssumption } from '@/lib/types'

// The shared entity-scoping layer used by Season Summary, Marketing, Revenue
// Projections, Income Sensitivity, and Cash Flow. Key invariants:
//   * acreage/production narrow via fields → farms → entity;
//   * insurance policies match strictly on their own entity_id;
//   * contracts/futures/options attribute via scope.attribution(): a row keyed
//     to the entity counts WHOLE, a row keyed to another entity drops, and an
//     operation-level (null-entity) row pro-rates by the entity's acre share
//     of the crop — it must NEVER simply vanish (the strict-drop regression
//     showed filtered entities with full production and zero sales);
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

  it('strictly entity-keyed rows (insurance policies) match on entity_id', () => {
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

  describe('cotton physical marketing attribution', () => {
    // Cotton acres: E1 300 / E2 200 (60% / 40%); TRW is the marketing agent.
    const entities = [
      { id: 'E1', entity_role: 'farming' }, { id: 'E2', entity_role: 'farming' },
      { id: 'TRW', entity_role: 'marketing_agent' },
    ]
    const cottonPlantings = [
      { field_id: 'A', crop_id: 'cotton', season_year: 2026, planted_acres: 300 },
      { field_id: 'B', crop_id: 'cotton', season_year: 2026, planted_acres: 200 },
    ]
    const cottonCrops = [{ id: 'cotton', name: 'Cotton' }]
    const attrFor = (entityId: string) =>
      buildEntityScope({ entityId, farms, fields, entities }).attribution({ plantings: cottonPlantings, crops: cottonCrops })
    // Agent-held LDP + an own-name fee for E2; loans/contracts empty.
    const inputs = {
      cropYear: 2026,
      bales: [], gradesByBale: new Map(), dispositions: [],
      contracts: [], poolPayments: [], loans: [], loanBales: [],
      ldps: [{ id: 'ldp1', entity_id: 'TRW', total_payment: 1000 }],
      fees: [{ id: 'fee1', entity_id: 'E2', fee_type: 'checkoff', loan_id: null, contract_id: null, amount_total: 200, status: 'actual' }],
    } as unknown as CottonPhysicalInputs

    it('agent-held rows flow down by the cotton acre share; own-name rows stay whole', () => {
      const e1 = attrFor('E1').cottonSummary(inputs)!
      expect(e1.programDollars).toBeCloseTo(600, 2)   // 60% of the agent's $1,000 LDP
      expect(e1.feeDollars).toBe(0)                   // E2's own-name fee is not E1's
      const e2 = attrFor('E2').cottonSummary(inputs)!
      expect(e2.programDollars).toBeCloseTo(400, 2)   // 40% share
      expect(e2.feeDollars).toBeCloseTo(200, 2)       // own-name fee whole
      // Entities partition the whole.
      expect(e1.programDollars + e2.programDollars).toBeCloseTo(1000, 2)
      // The agent farms nothing → its own view keeps none of it.
      expect(attrFor('TRW').cottonSummary(inputs)).toBeNull()
    })

    it('unfiltered summary equals the plain build; partition routes pool payments with their contract', () => {
      const all = attrFor('').cottonSummary(inputs)!
      expect(all.programDollars).toBeCloseTo(1000, 2)
      expect(all.feeDollars).toBeCloseTo(200, 2)
      const withPool = {
        ...inputs,
        contracts: [{ id: 'pc', entity_id: 'TRW', contract_type: 'pool', commitment_basis: 'bales', committed_bales: null }],
        poolPayments: [{ id: 'pp', contract_id: 'pc', amount: 500, status: 'received', payment_date: '2026-11-01', payment_type: 'advance', cents_per_lb_equivalent: null }],
      } as unknown as CottonPhysicalInputs
      const { own, flow } = attrFor('E1').cottonPartition(withPool)
      expect(own.poolPayments).toEqual([])            // the pool contract is agent-held…
      expect(flow.poolPayments.length).toBe(1)        // …so its payments ride with the flow group
    })
  })

  describe('attribution (contracts / futures / options)', () => {
    // E1 farms 60% of the corn acres, E2 40%; only E2 grows canola.
    const plantings = [
      { field_id: 'A', crop_id: 'corn', season_year: 2026, planted_acres: 600 },
      { field_id: 'B', crop_id: 'corn', season_year: 2026, planted_acres: 400 },
      { field_id: 'B', crop_id: 'canola', season_year: 2026, planted_acres: 800 },
    ]
    const crops = [{ id: 'corn', name: 'Corn' }, { id: 'canola', name: 'Canola' }]
    const attrE1 = () => scopeE1().attribution({ plantings, crops })
    const attrE2 = () => buildEntityScope({ entityId: 'E2', farms, fields }).attribution({ plantings, crops })
    const attrAll = () => scopeAll().attribution({ plantings, crops })

    it('acre shares per crop and crop year', () => {
      expect(attrE1().shareForCrop('corn', 2026)).toBeCloseTo(0.6, 9)
      expect(attrE2().shareForCrop('corn', 2026)).toBeCloseTo(0.4, 9)
      expect(attrE1().shareForCrop('canola', 2026)).toBe(0)
      expect(attrE2().shareForCrop('canola', 2026)).toBe(1)
      expect(attrE1().shareForCrop('corn', 2025)).toBe(0)   // no acres that year
      expect(attrAll().shareForCrop('corn', 2026)).toBe(1)  // unfiltered: whole
    })

    it('null-entity contracts pro-rate by acre share; entity-keyed go whole to their entity', () => {
      const rows = [
        { id: 'op', entity_id: null, crop_id: 'corn', crop_year: 2026, contracted_bushels: 30000 },
        { id: 'mine', entity_id: 'E1', crop_id: 'corn', crop_year: 2026, contracted_bushels: 5000 },
        { id: 'theirs', entity_id: 'E2', crop_id: 'corn', crop_year: 2026, contracted_bushels: 7000 },
      ]
      const e1 = attrE1().contracts(rows)
      expect(e1.map((c) => c.id).sort()).toEqual(['mine', 'op'])
      expect(e1.find((c) => c.id === 'op')!.contracted_bushels).toBeCloseTo(18000, 6)
      expect(e1.find((c) => c.id === 'mine')!.contracted_bushels).toBe(5000)
      const e2 = attrE2().contracts(rows)
      expect(e2.find((c) => c.id === 'op')!.contracted_bushels).toBeCloseTo(12000, 6)
      // Sum of entity shares of the operation-level contract = the whole.
      expect(18000 + 12000).toBe(30000)
      // Unfiltered: exact pass-through.
      expect(attrAll().contracts(rows)).toEqual(rows)
    })

    it('a contract for a crop the entity doesn’t grow drops; no acreage at all → share 0', () => {
      const rows = [{ id: 'can', entity_id: null, crop_id: 'canola', crop_year: 2026, contracted_bushels: 12000 }]
      expect(attrE1().contracts(rows)).toEqual([])
      expect(attrE2().contracts(rows)[0].contracted_bushels).toBe(12000)
    })

    it('marketing-agent-held rows flow DOWN to farming entities like operation-level rows', () => {
      // Typical setup: TRW is the marketing-agent entity (holds the contracts
      // and the hedge account, income shifted down); E1/E2 farm. E2 also has
      // an own-name contract, which stays wholly its own.
      const entities = [
        { id: 'E1', entity_role: 'farming' }, { id: 'E2', entity_role: 'farming' },
        { id: 'TRW', entity_role: 'marketing_agent' },
      ]
      const attr = (entityId: string) =>
        buildEntityScope({ entityId, farms, fields, entities }).attribution({ plantings, crops })
      const rows = [
        { id: 'agent', entity_id: 'TRW', crop_id: 'corn', crop_year: 2026, contracted_bushels: 30000 },
        { id: 'own', entity_id: 'E2', crop_id: 'corn', crop_year: 2026, contracted_bushels: 7000 },
      ]
      // E1 (60% of corn acres): 60% of the agent's 30,000 bu; none of E2's own.
      const e1 = attr('E1').contracts(rows)
      expect(e1.map((c) => c.id)).toEqual(['agent'])
      expect(e1[0].contracted_bushels).toBeCloseTo(18000, 6)
      // E2: 40% of the agent's contract + its own-name 7,000 bu whole.
      const e2 = attr('E2').contracts(rows)
      expect(e2.find((c) => c.id === 'agent')!.contracted_bushels).toBeCloseTo(12000, 6)
      expect(e2.find((c) => c.id === 'own')!.contracted_bushels).toBe(7000)
      // The agent farms nothing → its own filtered view keeps none of it
      // (the income has been shifted down to the farming entities).
      expect(attr('TRW').contracts(rows)).toEqual([])
      // Agent-held hedge account: realized P&L flows down by the same share.
      const futs = [{ id: 'f', entity_id: 'TRW', commodity: 'Corn', crop_year: 2026, num_contracts: 2, realized_pnl: 5000, commission: 100 }]
      expect(attr('E1').futures(futs)[0].realized_pnl).toBeCloseTo(3000, 6)
      expect(attr('E2').futures(futs)[0].realized_pnl).toBeCloseTo(2000, 6)
    })

    it('null-entity futures/options scale contracts, P&L, and commission by the commodity’s acre share', () => {
      const futures = [{
        id: 'f1', entity_id: null, commodity: 'Corn', crop_year: 2026,
        num_contracts: 2, realized_pnl: 5000, commission: 100,
      }]
      const e1 = attrE1().futures(futures)[0]
      expect(e1.num_contracts).toBeCloseTo(1.2, 9)
      expect(e1.realized_pnl).toBeCloseTo(3000, 6)
      expect(e1.commission).toBeCloseTo(60, 6)
      const e2 = attrE2().futures(futures)[0]
      expect(e1.num_contracts + e2.num_contracts).toBeCloseTo(2, 9)
      expect(e1.realized_pnl! + e2.realized_pnl!).toBeCloseTo(5000, 6)

      const options = [{
        id: 'o1', entity_id: null, commodity: 'Corn', crop_year: 2026,
        num_contracts: 1, realized_pnl: -800, premium_total: 1200,
      }]
      const oE1 = attrE1().options(options)[0]
      expect(oE1.num_contracts).toBeCloseTo(0.6, 9)
      expect(oE1.realized_pnl).toBeCloseTo(-480, 6)
      expect(oE1.premium_total).toBeCloseTo(720, 6)
    })
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

  describe('viewer grants (052 — grantedEntityIds)', () => {
    // Three farming entities + the marketing agent; the viewer is granted
    // E1 + E2 only. E3's own-name book and acres must never leak in.
    const vFarms = [...farms, { id: 'F4', entity_id: 'E3' }]
    const vFields = [...fields, { id: 'E', farm_id: 'F4' }]
    const entities = [
      { id: 'E1', entity_role: 'farming' }, { id: 'E2', entity_role: 'farming' },
      { id: 'E3', entity_role: 'farming' }, { id: 'TRW', entity_role: 'marketing_agent' },
    ]
    // Corn acres: E1 600 (60%... of 1000) — now with E3: E1 600, E2 400, E3 500 → total 1500.
    const plantings = [
      { field_id: 'A', crop_id: 'corn', season_year: 2026, planted_acres: 600 },
      { field_id: 'B', crop_id: 'corn', season_year: 2026, planted_acres: 400 },
      { field_id: 'E', crop_id: 'corn', season_year: 2026, planted_acres: 500 },
    ]
    const crops = [{ id: 'corn', name: 'Corn' }]
    const granted = ['E1', 'E2']
    const viewerScope = (entityId: string) =>
      buildEntityScope({ entityId, farms: vFarms, fields: vFields, entities, grantedEntityIds: granted })

    it("'' means all MY entities combined — active, never the whole operation", () => {
      const s = viewerScope('')
      expect(s.active).toBe(true)
      expect(Array.from(s.selectedEntityIds!).sort()).toEqual(['E1', 'E2'])
      expect(Array.from(s.farmIds!).sort()).toEqual(['F1', 'F2'])
      expect(s.plantings(plantings).map((p) => p.field_id).sort()).toEqual(['A', 'B'])
    })

    it('a granted entity narrows to it; a NON-granted id falls back to the union (URL manipulation)', () => {
      expect(Array.from(viewerScope('E1').selectedEntityIds!)).toEqual(['E1'])
      expect(Array.from(viewerScope('E3').selectedEntityIds!).sort()).toEqual(['E1', 'E2'])
    })

    it("agent flow-down under 'all my entities': ONLY the granted entities' combined share, never the whole book", () => {
      const attr = viewerScope('').attribution({ plantings, crops })
      const rows = [
        { id: 'agent', entity_id: 'TRW', crop_id: 'corn', crop_year: 2026, contracted_bushels: 30000 },
        { id: 'e2own', entity_id: 'E2', crop_id: 'corn', crop_year: 2026, contracted_bushels: 7000 },
        { id: 'e3own', entity_id: 'E3', crop_id: 'corn', crop_year: 2026, contracted_bushels: 9000 },
      ]
      const out = attr.contracts(rows)
      // (600 + 400) / 1500 of the agent's book…
      expect(out.find((c) => c.id === 'agent')!.contracted_bushels).toBeCloseTo(30000 * (1000 / 1500), 6)
      // …granted own-name whole, non-granted own-name GONE.
      expect(out.find((c) => c.id === 'e2own')!.contracted_bushels).toBe(7000)
      expect(out.find((c) => c.id === 'e3own')).toBeUndefined()
      // Agent-held hedge P&L: same combined share.
      const futs = [{ id: 'f', entity_id: 'TRW', commodity: 'Corn', crop_year: 2026, num_contracts: 3, realized_pnl: 9000, commission: 300 }]
      expect(attr.futures(futs)[0].realized_pnl).toBeCloseTo(6000, 6)
    })

    it('strictly entity-keyed and farm/payment filters honor the grant set', () => {
      const s = viewerScope('')
      expect(s.byEntity([{ id: 'p1', entity_id: 'E1' }, { id: 'p2', entity_id: 'E3' }]).map((r) => r.id)).toEqual(['p1'])
      expect(s.byFarm([{ id: 'b1', farm_id: 'F2' }, { id: 'b2', farm_id: 'F4' }]).map((r) => r.id)).toEqual(['b1'])
      expect(s.otherPayments([
        { id: 'o1', farm_id: 'F1', entity_id: null },
        { id: 'o2', farm_id: 'F4', entity_id: 'E1' }, // farm attribution wins → E3: out
        { id: 'o3', farm_id: null, entity_id: 'E2' },
      ]).map((r) => r.id)).toEqual(['o1', 'o3'])
    })

    it('an empty grant list FAILS CLOSED — selects nothing, never everything', () => {
      // Empty grants = not a viewer config the RPC allows, but if it ever
      // happens (partial migration, failed grant insert) the viewer must see
      // ZERO rows, not the whole operation.
      const s = buildEntityScope({ entityId: '', farms: vFarms, fields: vFields, entities, grantedEntityIds: [] })
      expect(s.active).toBe(true)
      expect(s.plantings(plantings)).toEqual([])
      expect(s.byEntity([{ id: 'x', entity_id: 'E1' }])).toEqual([])
      expect(s.attribution({ plantings, crops }).contracts([
        { id: 'op', entity_id: null, crop_id: 'corn', crop_year: 2026, contracted_bushels: 30000 },
      ])).toEqual([])
    })

    it('OWNER INVARIANCE: omitted/null grants produce byte-identical scoping to the pre-052 behavior', () => {
      const rows = [
        { id: 'op', entity_id: null, crop_id: 'corn', crop_year: 2026, contracted_bushels: 30000 },
        { id: 'mine', entity_id: 'E1', crop_id: 'corn', crop_year: 2026, contracted_bushels: 5000 },
      ]
      for (const entityId of ['', 'E1', 'E2']) {
        const before = buildEntityScope({ entityId, farms: vFarms, fields: vFields, entities })
        const after = buildEntityScope({ entityId, farms: vFarms, fields: vFields, entities, grantedEntityIds: null })
        expect(after.active).toBe(before.active)
        expect(after.farmIds).toEqual(before.farmIds)
        expect(after.fieldIds).toEqual(before.fieldIds)
        expect(after.plantings(plantings)).toEqual(before.plantings(plantings))
        const aAttr = after.attribution({ plantings, crops })
        const bAttr = before.attribution({ plantings, crops })
        expect(aAttr.contracts(rows)).toEqual(bAttr.contracts(rows))
        expect(aAttr.shareForCrop('corn', 2026)).toBe(bAttr.shareForCrop('corn', 2026))
      }
    })
  })
})
