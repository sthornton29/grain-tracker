// The outbound shapers for the Turnrow Farm link on a seeded organization:
// production (Farm uuids, source precedence, actual yield only once complete,
// weighted moisture), marketing (grain $/bu vs cotton ¢/lb + lbs, settled
// averages, entity acre shares, percent sold, realized hedging), income
// (blended revenue + government allocation by acre share with the FSA farm's
// Farm uuid + insurance by entity), and bins (on hand vs. in-for-the-year with
// an as-of cutoff).

import { describe, expect, it } from 'vitest'
import { IdMap } from '@/lib/farm-link'
import type { MarketingRow } from '@/lib/marketing'
import type { PartnerProduction } from '@/lib/partner-api'
import type { ProjectedYieldRecord } from '@/lib/partner-marketing'
import { assembleBinInventory, shapeIncomeRecords, shapeMarketingRecord, shapeProductionRecords } from '@/lib/farm-link-outbound'

const idMap = new IdMap([
  { grain_table: 'fields', grain_id: 'field-1', farm_uid: 'F-FIELD-1' },
  { grain_table: 'field_plantings', grain_id: 'pl-1', farm_uid: 'F-PL-1' },
  { grain_table: 'entities', grain_id: 'ent-1', farm_uid: 'F-ENT-1' },
  { grain_table: 'farms', grain_id: 'farm-1', farm_uid: 'F-FARM-1' },
])

function mkRow(over: Partial<MarketingRow>): MarketingRow {
  const base = {
    cropId: 'corn', cropName: 'Corn', unit: 'bu', cottonBales: null, productionBales: null, baleWeightLbs: null, cottonPhysical: null, seed: null,
    acres: 100, acresSource: 'plantings', yield: 180, yieldLabel: 'Est.', totalProduction: 18000, contractedBu: 9000, remaining: 9000,
    avgCashPrice: 4.5, excludedAwaitingBu: 0, futuresPricedBu: 9000, physicalFuturesBu: 9000, physicalFuturesAvg: 4.6, openHedgeBu: 0, openHedgeAvg: null,
    rawAvgFutures: 4.6, hedgeRealizedPnl: 1250, hedgeAdjPerBu: 0.0694, avgFutures: 4.67, avgBasis: -0.3, avgBasisAssumed: false, assumedBasis: -0.35,
    assumedFutures: null, basisLockedBu: 9000, basisLockedAvg: -0.3, basisAssumedBu: 9000, basisState: 'blended', totalAvgPrice: 4.37,
    unpricedBu: 9000, blendedRevenue: 78660, unpricedFuturesPrice: 4.4, costPerAcre: 600, costPerBu: 3.33, revenuePerAcre: 786.6, profitPerAcre: 186.6,
    totalProfit: 18660, openFuturesHedgedBu: 0, futuresSources: [], lockedPriceBu: 0, futuresAssumedBu: 9000,
  }
  return { ...base, ...over } as unknown as MarketingRow
}

describe('shapeMarketingRecord', () => {
  it('grain: $/bu + bu, settled average from settlement revenue ÷ units, percent sold from contracted bushels, realized hedging net', () => {
    const r = shapeMarketingRecord({ row: mkRow({}), cropYear: 2026, entity: null, settled: { quantity: 4000, revenue: 17400, share: 1 }, isFinal: false, asOf: '2026-09-17T12:00:00Z' })
    expect(r).toMatchObject({
      id: 'corn|all', crop: 'Corn', unit: 'usd_per_bu', quantity_unit: 'bu', entity_id: null,
      settled_average_price: 4.35, settled_quantity: 4000, settled_revenue: 17400, settled_attribution: 'operation',
      percent_sold: 50, sold_quantity: 9000, total_production: 18000, production_basis: 'estimated', price_is_final: false,
      hedging_realized: { net: 1250, per_unit: 0.0694 },
      basis: { average: -0.3, state: 'blended', assumed: -0.35, locked_quantity: 9000, assumed_quantity: 9000 },
      updated_at: '2026-09-17T12:00:00Z',
    })
    expect(r.projected_average_price).toBeCloseTo(78660 / 18000, 4)
    expect(r.basis_notes).toContain('basis blends locked contracts with the assumed basis on unpriced bushels')
  })

  it('entity rows carry the acre share of settled sales and the Farm uuid, attribution by_acres', () => {
    const r = shapeMarketingRecord({ row: mkRow({ acres: 40 }), cropYear: 2026, entity: { id: 'ent-1', name: 'Turnrow Farms LLC', farm_uid: 'F-ENT-1' }, settled: { quantity: 4000, revenue: 17400, share: 0.4 }, isFinal: true, asOf: 'x' })
    expect(r).toMatchObject({ id: 'corn|ent-1', entity_farm_uid: 'F-ENT-1', settled_quantity: 1600, settled_revenue: 6960, settled_average_price: 4.35, settled_attribution: 'by_acres', price_is_final: true })
  })

  it('COTTON: cents per pound as stored, quantities in lbs of lint, settled from sold lbs and dollars, sold = physical sold lbs', () => {
    const row = mkRow({
      cropId: 'cotton', cropName: 'Cotton', unit: 'lbs', totalProduction: 412000, contractedBu: 0, avgCashPrice: 72.5, totalAvgPrice: 71.2, blendedRevenue: 293344,
      cottonPhysical: { summary: { soldLbs: 200000, soldDollars: 145000 }, poolValueDollars: 0, poolEstimated: false, inLoanValueDollars: 0, inLoanFloored: false, unpricedLbs: 212000, hedgedUnsoldLbs: 0 } as never,
    })
    const r = shapeMarketingRecord({ row, cropYear: 2026, entity: null, settled: null, isFinal: false, asOf: 'x' })
    expect(r).toMatchObject({ unit: 'cents_per_lb', quantity_unit: 'lbs', settled_quantity: 200000, settled_revenue: 145000, settled_average_price: 72.5, sold_quantity: 200000, projected_average_price: 71.2 })
    expect(r.percent_sold).toBeCloseTo(48.5, 1)
    // Never a dollars-per-pound number on a cotton row.
    expect(r.settled_average_price).toBeGreaterThan(1)
  })
})

describe('shapeProductionRecords', () => {
  const partner: PartnerProduction[] = [
    { field_id: 'field-1', field_name: 'North 40', entity_id: 'ent-1', entity: 'Turnrow Farms LLC', crop: 'Corn', crop_year: 2026, planted_acres: 40, harvested_acres: 40, harvest_status: 'complete', production_units: 7400, unit: 'bu', updated_at: '2026-09-10T00:00:00Z' },
    { field_id: 'field-2', field_name: 'Bottom 80', entity_id: 'ent-1', entity: 'Turnrow Farms LLC', crop: 'Corn', crop_year: 2026, planted_acres: 80, harvested_acres: 0, harvest_status: 'in_progress', production_units: 3000, unit: 'bu', updated_at: '2026-09-12T00:00:00Z' },
    { field_id: 'field-3', field_name: 'Cotton 60', entity_id: null, entity: null, crop: 'Cotton', crop_year: 2026, planted_acres: 60, harvested_acres: 60, harvest_status: 'complete', production_units: 61000, unit: 'lbs', updated_at: '2026-09-14T00:00:00Z' },
  ]
  const projected: ProjectedYieldRecord[] = [
    { field_id: 'field-1', field_name: 'North 40', entity_id: 'ent-1', crop: 'Corn', crop_year: 2026, planted_acres: 40, yield_per_acre: 185, unit: 'bu_per_ac', basis: 'actual', practices: null },
    { field_id: 'field-2', field_name: 'Bottom 80', entity_id: 'ent-1', crop: 'Corn', crop_year: 2026, planted_acres: 80, yield_per_acre: 180, unit: 'bu_per_ac', basis: 'expected', practices: null },
    { field_id: 'field-3', field_name: 'Cotton 60', entity_id: null, crop: 'Cotton', crop_year: 2026, planted_acres: 60, yield_per_acre: 1016.7, unit: 'lbs_per_ac', basis: 'actual', practices: null },
  ]
  it('keys each record on its planting with the Farm uuids, reports actual yield only once complete, source by precedence, weighted moisture', () => {
    const out = shapeProductionRecords({
      partner, projected,
      plantings: [
        { id: 'pl-1', field_id: 'field-1', crop_id: 'corn', season_year: 2026, updated_at: '2026-09-15T00:00:00Z' },
        { id: 'pl-2', field_id: 'field-2', crop_id: 'corn', season_year: 2026, updated_at: null },
        { id: 'pl-3', field_id: 'field-3', crop_id: 'cotton', season_year: 2026, updated_at: null },
      ],
      crops: [{ id: 'corn', name: 'Corn' }, { id: 'cotton', name: 'Cotton' }],
      fields: [{ id: 'field-1', farm_id: 'farm-1' }, { id: 'field-2', farm_id: 'farm-1' }, { id: 'field-3', farm_id: null }],
      combineKeys: new Set(['field-1|corn|2026']),
      loadKeys: new Set(['field-1|corn|2026', 'field-2|corn|2026']),
      moistureByKey: new Map([['field-1|corn|2026', 16.4], ['field-2|corn|2026', 18.1]]),
      idMap, year: 2026,
    })
    expect(out[0]).toMatchObject({
      id: 'pl-1', planting_id: 'pl-1', planting_farm_uid: 'F-PL-1', field_farm_uid: 'F-FIELD-1', farm_id: 'farm-1', entity_id: 'ent-1',
      crop: 'Corn', harvest_status: 'complete', harvested_acres: 40, production: 7400, unit: 'bu', yield_per_acre: 185, yield_unit: 'bu_per_ac',
      moisture: 16.4, source: 'combine_yield_entries', updated_at: '2026-09-15T00:00:00Z',
    })
    expect(out[1]).toMatchObject({ id: 'pl-2', planting_farm_uid: null, field_farm_uid: null, harvest_status: 'in_progress', harvested_acres: 0, yield_per_acre: null, moisture: 18.1, source: 'loads' })
    expect(out[2]).toMatchObject({ id: 'pl-3', unit: 'lbs', production: 61000, yield_per_acre: 1016.7, yield_unit: 'lbs_per_ac', moisture: null, source: 'gin_receipts' })
  })
})

describe('shapeIncomeRecords', () => {
  it('reports blended crop revenue with its components, government payments allocated by acre share with the FSA farm Farm uuid, and insurance by entity', () => {
    const rows = [mkRow({ cropId: 'corn', cropName: 'Corn', acres: 300 }), mkRow({ cropId: 'soy', cropName: 'Soybean', acres: 100, totalProduction: 5000, blendedRevenue: 50000, hedgeRealizedPnl: 0 })]
    const out = shapeIncomeRecords({
      cropYear: 2026, rows, scopedContracts: [], entity: null,
      settled: new Map([['corn', { quantity: 4000, revenue: 17400, updatedAt: null }]]),
      settledShareForCrop: () => 1,
      checkoff: new Map([['corn', 40]]), fees: new Map([['corn', 12.5]]),
      insuranceByCrop: new Map([['corn', { netPnl: -3000, totalIndemnity: 2000, premium: 5000 }]]),
      projectedPayments: [{ farmId: 'farm-1', commodityId: 'cc-corn', election: 'PLC', baseAcres: 200, plcYield: 150, arcRatePerAcre: null, result: { net: 8000 } as never }],
      otherPayments: [
        { id: 'o1', entity_id: null, program_name: 'ELAP', crop_year: 2026, crop_id: null, farm_id: null, amount: 1000, payment_date: null, payment_status: 'received', notes: null, created_at: 'x' },
        { id: 'o2', entity_id: null, program_name: 'Seed cost share', crop_year: 2026, crop_id: 'soy', farm_id: 'farm-1', amount: 500, payment_date: null, payment_status: 'received', notes: null, created_at: 'x' },
      ],
      farms: [{ id: 'farm-1', fsa_number: '1234' }], commodities: [{ id: 'cc-corn', name: 'Corn' }], idMap, asOf: 'now',
    })
    const corn = out.find((r) => r.crop === 'Corn')!
    expect(corn.crop_revenue).toEqual({ total: 78660, components: { settled_revenue: 17400, hedging_realized: 1250, checkoff: 40, fees: 12.5 }, attribution: 'operation' })
    expect(corn.government_payments).toMatchObject({ total: 6750, arc_plc: 6000, other_allocated: 750, other_crop_specific: 0, attribution: 'by_acres' })
    expect(corn.government_payments.by_program_farm).toEqual([
      { program: 'PLC', farm_id: 'farm-1', farm_code: '1234', farm_farm_uid: 'F-FARM-1', commodity: 'Corn', net: 6000 },
      { program: 'ELAP', farm_id: null, farm_code: null, farm_farm_uid: null, commodity: null, net: 750 },
    ])
    expect(corn.crop_insurance).toEqual({ indemnities: 2000, premium: 5000, net: -3000, attribution: 'by_entity' })
    expect(corn.total_revenue).toBe(78660 - 3000 + 6750)
    const soy = out.find((r) => r.crop === 'Soybean')!
    expect(soy.government_payments).toMatchObject({ arc_plc: 2000, other_allocated: 250, other_crop_specific: 500, total: 2750 })
    expect(soy.government_payments.by_program_farm.find((p) => p.program === 'Seed cost share')).toMatchObject({ net: 500, farm_farm_uid: 'F-FARM-1' })
  })
})

describe('assembleBinInventory', () => {
  const crops = [{ id: 'corn', name: 'Corn', base_moisture_pct: 15, base_lb_per_bushel: 56 }]
  const bins = [{ id: 'b1', name_or_number: 'Bin 1', crop_id: 'corn', bin_site_id: 's1', capacity_bushels: 20000 }, { id: 'b2', name_or_number: 'Bin 2', crop_id: null, bin_site_id: 's1', capacity_bushels: null }]
  const sites = [{ id: 's1', name: 'Home', entity_id: 'ent-1' }]
  const load = (id: string, date: string, year: number, to: string | null, from: string | null, lbs: number) => ({
    id, date, net_weight: lbs, moisture: 15, crop_id: 'corn', crop_year: year, dry_bushels_override: null,
    from_type: from ? 'bin' : 'field', from_field_id: from ? null : 'f1', from_bin_id: from, to_type: to ? 'bin' : 'buyer', to_bin_id: to,
  })
  it('on hand = loads in − loads out ± adjustments ± transfers; in-for-year counts only the crop year’s inbound loads on or before as_of', () => {
    const out = assembleBinInventory({
      bins, sites, crops,
      loads: [
        load('l1', '2025-10-01', 2025, 'b1', null, 56000),   // 1,000 bu last year
        load('l2', '2026-09-01', 2026, 'b1', null, 112000),  // 2,000 bu this year
        load('l3', '2026-09-10', 2026, null, 'b1', 28000),   // 500 bu out to a buyer
        load('l4', '2026-09-20', 2026, 'b1', null, 56000),   // after as_of: ignored
      ],
      splits: [], combineEntries: [],
      adjustments: [{ bin_id: 'b1', crop_id: 'corn', adjustment_type: 'beginning_inventory', bushels: 100, as_of_date: '2025-09-01' }],
      transfers: [{ from_bin_id: 'b1', to_bin_id: 'b2', crop_id: 'corn', bushels: 300, transfer_date: '2026-09-05' }],
      cropYear: 2026, asOf: '2026-09-15T00:00:00Z', idMap,
    })
    expect(out).toEqual([
      { id: 'b1|corn', bin_id: 'b1', bin_name: 'Bin 1', site_id: 's1', site_name: 'Home', entity_id: 'ent-1', entity_farm_uid: 'F-ENT-1', capacity_bushels: 20000, crop_id: 'corn', crop: 'Corn', crop_year: 2026, as_of: '2026-09-15T00:00:00Z', bushels_on_hand: 2300, bushels_in_for_year: 2000, updated_at: '2026-09-15T00:00:00Z' },
      { id: 'b2|corn', bin_id: 'b2', bin_name: 'Bin 2', site_id: 's1', site_name: 'Home', entity_id: 'ent-1', entity_farm_uid: 'F-ENT-1', capacity_bushels: null, crop_id: 'corn', crop: 'Corn', crop_year: 2026, as_of: '2026-09-15T00:00:00Z', bushels_on_hand: 300, bushels_in_for_year: 0, updated_at: '2026-09-15T00:00:00Z' },
    ])
  })
})
