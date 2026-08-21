// Per-entity marketing prices for the partner API: the rows must equal the
// Marketing dashboard with that entity selected in its filter, to the cent,
// for a fixture org whose marketing-agent entity holds the paper (contracts +
// a closed hedge) while one farming entity also markets in its own name.
// Also: the agent never appears, an undefined per-entity price is omitted
// (never guessed), only entities with SHARED fields appear, and the payload
// carries nothing beyond the aggregate price + the entity key.

import { describe, expect, it } from 'vitest'
import {
  computeMarketing,
  expectedProductionFromBreakout,
  headlineAvgPrice,
  segmentAcresByCrop,
} from '@/lib/marketing'
import { buildEntityScope } from '@/lib/entity-scope'
import { computeEntityMarketingRows, type EntityMarketingInputs } from '@/lib/entity-marketing'
import { fieldEntityMap } from '@/lib/partner-api'
import { buildEntityMarketingPriceRecords, buildProjectedYieldRecords } from '@/lib/partner-marketing'
import type { ExclusionReason, FieldCropAgg } from '@/lib/yields'
import type { Contract, Crop, CropAssumption, FieldPlanting, FuturesPosition } from '@/lib/types'

const crop = (id: string, name: string): Crop => ({ id, name }) as Crop

function assumption(over: Partial<CropAssumption> & Pick<CropAssumption, 'crop_id'>): CropAssumption {
  return {
    id: `a-${over.crop_id}`, crop_year: 2026,
    expected_yield: null, expected_yield_irr: null, expected_yield_dry: null,
    expected_yield_dc_irr: null, expected_yield_dc_dry: null,
    harvest_complete: false, assumed_basis: 0, assumed_futures: null, reference_contract_month: null,
    cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null,
    notes: null, created_at: '', updated_at: '',
    ...over,
  } as CropAssumption
}

function contract(over: Partial<Contract> & Pick<Contract, 'id' | 'crop_id'>): Contract {
  return {
    contract_number: 'X', buyer_id: null, entity_id: null, crop_year: 2026, contracted_bushels: 0,
    price_per_bushel: null, notes: null, delivery_type: 'delivered', delivery_location_id: null,
    delivery_start_date: null, delivery_end_date: null, completed_at: null, date_sold: null, created_at: '',
    contract_month: null, contract_type: 'forward', futures_price: null, basis: null, cash_price: null,
    service_fee: 0, futures_set_date: null, basis_set_date: null, pricing_status: 'fully_priced',
    ...over,
  } as Contract
}

const fp = (id: string, field_id: string, crop_id: string, acres: number): FieldPlanting =>
  ({ id, field_id, crop_id, season_year: 2026, planted_acres: acres, irrigated_acres: 0, dryland_acres: acres, yield_include_override: null }) as unknown as FieldPlanting

const corn = crop('corn', 'Corn')
const soy = crop('soy', 'Soybeans')
const fields = [
  { id: 'fA1', farm_id: 'farmA' },
  { id: 'fB1', farm_id: 'farmB' },
  { id: 'fB2', farm_id: 'farmB' },
]
const farms = [
  { id: 'farmA', entity_id: 'A' },
  { id: 'farmB', entity_id: 'B' },
]
const entities: EntityMarketingInputs['entities'] = [
  { id: 'A', name: 'Alpha Farms LLC', entity_role: 'farming' },
  { id: 'B', name: 'Bravo Farms LP', entity_role: 'farming' },
  { id: 'AG', name: 'Turnrow Marketing', entity_role: 'marketing_agent' },
]
// Corn: A farms 100 ac (25%), B farms 300 ac (75%). Soybeans only on B, with
// no assumption → no price is computable for it.
const plantings = [fp('p1', 'fA1', 'corn', 100), fp('p2', 'fB1', 'corn', 200), fp('p3', 'fB2', 'corn', 100), fp('p4', 'fB2', 'soy', 50)]
const contracts = [
  // Agent-held: flows down pro rata (A 25% / B 75%).
  contract({ id: 'k-agent', entity_id: 'AG', crop_id: 'corn', contracted_bushels: 10000, cash_price: 5.0 }),
  // B's own-name book: stays wholly B's.
  contract({ id: 'k-own-b', entity_id: 'B', crop_id: 'corn', contracted_bushels: 5000, cash_price: 5.5 }),
]
const closedHedge: FuturesPosition = {
  id: 'fut-1', entity_id: 'AG', commodity: 'Corn', contract_month: 'Dec 2026', contract_symbol: 'ZCZ26',
  crop_year: 2026, side: 'short', num_contracts: 2, trade_price: 4.8, trade_date: '2026-03-01',
  status: 'closed', close_price: 4.4, close_date: '2026-06-01', realized_pnl: 4000, commission: 40,
  notes: null, source: 'manual', created_at: '',
}
const assumptions = [assumption({ crop_id: 'corn', expected_yield: 200, assumed_futures: 4.5, assumed_basis: -0.25 })]
const base: EntityMarketingInputs = {
  cropYear: 2026,
  crops: [corn, soy],
  plantings,
  fields,
  farms,
  entities,
  contracts,
  futures: [],
  options: [],
  assumptions,
  doubleCropIds: new Set(),
  aggByKey: new Map(),
  ginReceipts: [],
  cottonBales: [],
  cottonPhysicalInputs: null,
  currentFuturesByCrop: new Map(),
}
const salesStatus = [{ crop_id: 'corn', physical_sales_complete: false }]

/** The Marketing dashboard's own composition with `entityId` selected
 *  (app/reports/marketing/page.tsx), written out independently. */
function dashboardHeadline(inputs: EntityMarketingInputs, entityId: string, cropId: string): number | null {
  const scope = buildEntityScope({ entityId, farms: inputs.farms, fields: inputs.fields, entities: inputs.entities })
  const scoped = scope.plantings(inputs.plantings)
  const attr = scope.attribution({ plantings: inputs.plantings, crops: inputs.crops })
  const seg = segmentAcresByCrop(scoped, 2026, new Set())
  const rows = computeMarketing({
    cropYear: 2026,
    crops: [...inputs.crops],
    plantings: scoped,
    contracts: attr.contracts(inputs.contracts),
    futures: attr.futures(inputs.futures),
    options: attr.options(inputs.options),
    assumptions: [...inputs.assumptions],
    actualProductionByCrop: new Map(),
    expectedProductionByCrop: expectedProductionFromBreakout(seg, [...inputs.assumptions], 2026),
    currentFuturesByCrop: new Map(),
  })
  const row = rows.find((r) => r.cropId === cropId)
  return row ? headlineAvgPrice(row) : null
}

function records(inputs: EntityMarketingInputs, sharedFieldIds: string[] | null) {
  const all = fieldEntityMap({ fields: inputs.fields, farms: inputs.farms })
  const sharedFieldEntity = new Map([...all].filter(([id]) => sharedFieldIds == null || sharedFieldIds.includes(id)))
  return buildEntityMarketingPriceRecords({
    entities: inputs.entities,
    rowsForEntity: (id) => computeEntityMarketingRows(inputs, id),
    sharedFieldEntity,
    plantings: inputs.plantings,
    cropYear: 2026,
    salesStatus,
    asOf: '2026-08-21T00:00:00.000Z',
  })
}

describe('per-entity marketing prices (entity attribution seam)', () => {
  it("agent-held contracts flow down by acre share; an own-name book stays its entity's (explicit arithmetic)", () => {
    const out = records(base, null)
    // A: 25% of the agent's 10,000 bu @ $5.00 = 2,500 bu; 17,500 unpriced @ (4.50 − 0.25).
    //    (12,500 + 74,375) / 20,000 = 4.34375 → 4.34
    // B: 7,500 agent bu @ $5.00 + 5,000 own @ $5.50; 47,500 unpriced @ 4.25.
    //    (37,500 + 27,500 + 201,875) / 60,000 = 4.4479 → 4.45
    expect(out.find((r) => r.entity_id === 'A' && r.crop === 'Corn')!.projected_avg_price).toBe(4.34)
    expect(out.find((r) => r.entity_id === 'B' && r.crop === 'Corn')!.projected_avg_price).toBe(4.45)
    // Whole operation for reference: (50,000 + 27,500 + 276,250) / 80,000 = 4.421875.
    const whole = computeMarketing({
      cropYear: 2026, crops: [corn, soy], plantings, contracts, futures: [], options: [], assumptions,
      actualProductionByCrop: new Map(),
      expectedProductionByCrop: expectedProductionFromBreakout(segmentAcresByCrop(plantings, 2026, new Set()), assumptions, 2026),
    })
    expect(headlineAvgPrice(whole.find((r) => r.cropId === 'corn')!)).toBeCloseTo(4.421875, 10)
  })

  it('matches the entity-filtered Marketing dashboard to the cent — with a closed agent-held hedge flowing down too', () => {
    const inputs: EntityMarketingInputs = { ...base, futures: [closedHedge] }
    const out = records(inputs, null)
    for (const entityId of ['A', 'B']) {
      const rec = out.find((r) => r.entity_id === entityId && r.crop === 'Corn')!
      const dash = dashboardHeadline(inputs, entityId, 'corn')!
      expect(rec.projected_avg_price).toBe(Math.round(dash * 100) / 100)
    }
    // The hedge moved the numbers (realized P&L counted once, pro rata).
    expect(out.find((r) => r.entity_id === 'A' && r.crop === 'Corn')!.projected_avg_price).not.toBe(4.34)
  })

  it('never emits the marketing-agent entity, and omits a crop whose per-entity price is undefined', () => {
    const out = records(base, null)
    expect(out.some((r) => r.entity_id === 'AG')).toBe(false)
    // Soybeans: planted on B but nothing priced and no assumption → no row (not a null).
    expect(out.some((r) => r.crop === 'Soybeans')).toBe(false)
    expect(out.every((r) => r.projected_avg_price != null)).toBe(true)
  })

  it('carries ONLY the aggregate fields plus the entity key — no acres, shares, or components', () => {
    const [rec] = records(base, null)
    expect(Object.keys(rec).sort()).toEqual(
      ['as_of', 'crop', 'crop_year', 'entity_id', 'entity_name', 'is_final', 'projected_avg_price', 'unit'].sort(),
    )
    expect(rec.unit).toBe('usd_per_bu')
    expect(rec.is_final).toBe(false)
  })

  it('only entities with SHARED fields appear, and only their crops on those fields', () => {
    // A share covering just fB1 (B's corn field): A is absent; B shows corn
    // but not soybeans (fB2 is outside the share) — and B's corn price is
    // still its whole-entity price, not a per-field slice.
    const out = records(base, ['fB1'])
    expect(out.map((r) => [r.entity_id, r.crop])).toEqual([['B', 'Corn']])
    expect(out[0].projected_avg_price).toBe(4.45)
  })

  it('is_final follows the physical_sales_complete flag per crop', () => {
    const out = buildEntityMarketingPriceRecords({
      entities,
      rowsForEntity: (id) => computeEntityMarketingRows(base, id),
      sharedFieldEntity: fieldEntityMap({ fields, farms }),
      plantings,
      cropYear: 2026,
      salesStatus: [{ crop_id: 'corn', physical_sales_complete: true }],
      asOf: 'now',
    })
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((r) => r.is_final)).toBe(true)
  })
})

describe('projected-yield rows carry the field entity id', () => {
  it('joins to /fields.entity_id; null when no entity map is given', () => {
    const common = {
      cropYear: 2026,
      plantings: [{ id: 'p1', field_id: 'f1', crop_id: 'corn', season_year: 2026, planted_acres: 100, irrigated_acres: 0, dryland_acres: 100, irrigated_bushels: null, dryland_bushels: null, yield_breakout_entered: false }],
      fields: [{ id: 'f1', name_or_number: 'North 40' }],
      crops: [corn],
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 180 })],
      doubleCropIds: new Set<string>(),
      aggByKey: new Map<string, FieldCropAgg>(),
      cottonLbsByField: new Map<string, number>(),
      excluded: new Map<string, ExclusionReason>(),
      cropCompleteKeys: new Set<string>(),
      allowedFieldIds: null,
    }
    expect(buildProjectedYieldRecords({ ...common, fieldEntity: new Map([['f1', 'e-north']]) })[0].entity_id).toBe('e-north')
    expect(buildProjectedYieldRecords(common)[0].entity_id).toBeNull()
  })
})
