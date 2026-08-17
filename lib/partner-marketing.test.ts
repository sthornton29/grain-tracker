// Tests for the partner API's lease-projection payloads (072): the
// marketing-prices record must equal the Marketing dashboard's headline price
// to the cent, is_final must follow the crop_year_sales_status flag, the
// share-scope gate must name the scope it denies, and projected-yields must
// honor the practice breakout, the actual-replacement precedence, and —
// critically — the share's field boundary (a field outside the share never
// appears in any payload).

import { describe, expect, it } from 'vitest'
import {
  breakevenAvgPrice,
  computeMarketing,
  expectedProductionFromBreakout,
  headlineAvgPrice,
  segmentAcresByCrop,
  type MarketingRow,
} from '@/lib/marketing'
import {
  buildMarketingPriceRecords,
  buildProjectedYieldRecords,
  shareScopeError,
  type ProjectedYieldPlanting,
} from '@/lib/partner-marketing'
import type { ExclusionReason, FieldCropAgg } from '@/lib/yields'
import type { Contract, Crop, CropAssumption } from '@/lib/types'

// ---------------------------------------------------------------------------
// Fixture factories (the revenue-marketing-reconciliation.test.ts style)
// ---------------------------------------------------------------------------

function crop(id: string, name: string): Crop {
  return { id, name } as Crop
}

function assumption(over: Partial<CropAssumption> & Pick<CropAssumption, 'crop_id'>): CropAssumption {
  return {
    id: `a-${over.crop_id}`,
    crop_year: 2026,
    expected_yield: null,
    expected_yield_irr: null,
    expected_yield_dry: null,
    expected_yield_dc_irr: null,
    expected_yield_dc_dry: null,
    harvest_complete: false,
    assumed_basis: 0,
    assumed_futures: null,
    reference_contract_month: null,
    cost_per_acre: null,
    cost_per_acre_irr: null,
    cost_per_acre_dry: null,
    cost_per_acre_dc_irr: null,
    cost_per_acre_dc_dry: null,
    notes: null,
    created_at: '',
    updated_at: '',
    ...over,
  } as CropAssumption
}

function contract(over: Partial<Contract> & Pick<Contract, 'crop_id'>): Contract {
  return {
    id: `c-${Math.random()}`,
    contract_number: 'X',
    buyer_id: null,
    entity_id: null,
    crop_year: 2026,
    contracted_bushels: 0,
    price_per_bushel: null,
    notes: null,
    delivery_type: 'delivered',
    delivery_location_id: null,
    delivery_start_date: null,
    delivery_end_date: null,
    completed_at: null,
    date_sold: null,
    created_at: '',
    contract_month: null,
    contract_type: 'forward',
    futures_price: null,
    basis: null,
    cash_price: null,
    service_fee: 0,
    futures_set_date: null,
    basis_set_date: null,
    pricing_status: 'fully_priced',
    ...over,
  } as Contract
}

function planting(over: Partial<ProjectedYieldPlanting> & Pick<ProjectedYieldPlanting, 'id' | 'field_id' | 'crop_id'>): ProjectedYieldPlanting {
  return {
    season_year: 2026,
    planted_acres: 100,
    irrigated_acres: 0,
    dryland_acres: 100,
    irrigated_bushels: null,
    dryland_bushels: null,
    yield_breakout_entered: false,
    ...over,
  }
}

// A fixture org: corn partly forward-sold with a standing assumed-futures
// price, soybeans with nothing priced. Mirrors how the dashboard feeds the
// engine (no live quote in the test — the assumed futures values unpriced bu).
const corn = crop('corn', 'Corn')
const soy = crop('soy', 'Soybeans')
const FIXTURE = {
  cropYear: 2026,
  crops: [corn, soy],
  plantings: [
    { crop_id: 'corn', season_year: 2026, planted_acres: 100 },
    { crop_id: 'soy', season_year: 2026, planted_acres: 50 },
  ],
  contracts: [
    contract({ crop_id: 'corn', contracted_bushels: 10000, cash_price: 5.0, pricing_status: 'fully_priced' }),
  ],
  futures: [],
  options: [],
  assumptions: [
    assumption({ crop_id: 'corn', expected_yield: 200, assumed_futures: 4.5, assumed_basis: -0.25 }),
    assumption({ crop_id: 'soy', expected_yield: 55, assumed_futures: 10.8 }),
  ],
  actualProductionByCrop: new Map<string, number>(),
}

describe('headlineAvgPrice', () => {
  const rows = computeMarketing(FIXTURE)
  const cornRow = rows.find((r) => r.cropName === 'Corn')!
  const soyRow = rows.find((r) => r.cropName === 'Soybeans')!

  it('re-derives from blended revenue when a standing assumed-futures exists (the dashboard scenario at rest)', () => {
    // 10,000 bu at $5.00 cash + 10,000 unpriced at (4.50 − 0.25) = $92,500 over 20,000 bu.
    expect(cornRow.totalProduction).toBe(20000)
    expect(cornRow.blendedRevenue).toBeCloseTo(92500, 6)
    expect(headlineAvgPrice(cornRow)).toBeCloseTo(92500 / 20000, 10)
    expect(headlineAvgPrice(cornRow)).toBe(breakevenAvgPrice(cornRow))
    expect(headlineAvgPrice(soyRow)).toBeCloseTo(soyRow.blendedRevenue / soyRow.totalProduction, 10)
  })

  it('falls back to the futures+basis total when no assumption is set', () => {
    const noAssume = computeMarketing({
      ...FIXTURE,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200, assumed_basis: -0.25 })],
      crops: [corn],
    })
    const row = noAssume[0]
    expect(row.assumedFutures).toBeNull()
    expect(headlineAvgPrice(row)).toBe(row.totalAvgPrice)
  })

  it('cotton rows pass their blended effective ¢/lb through', () => {
    const row = { unit: 'lbs', assumedFutures: 70, totalProduction: 100000, blendedRevenue: 72000, totalAvgPrice: 72 } as MarketingRow
    expect(headlineAvgPrice(row)).toBe(72)
  })
})

describe('buildMarketingPriceRecords', () => {
  const rows = computeMarketing(FIXTURE)
  const asOf = '2026-08-17T12:00:00.000Z'

  it('matches the dashboard headline to the cent and carries ONLY the aggregate fields', () => {
    const records = buildMarketingPriceRecords({
      rows, cropYear: 2026, salesStatus: [], allowedCropIds: null, asOf,
    })
    const cornRec = records.find((r) => r.crop === 'Corn')!
    // The dashboard headline: round2(blendedRevenue / production) = $4.63.
    expect(cornRec.projected_avg_price).toBe(4.63)
    expect(cornRec.unit).toBe('usd_per_bu')
    expect(cornRec.is_final).toBe(false)
    // Leak-proof shape: nothing beyond the six aggregate fields ever leaves.
    expect(Object.keys(cornRec).sort()).toEqual(
      ['as_of', 'crop', 'crop_year', 'is_final', 'projected_avg_price', 'unit'],
    )
  })

  it('is_final follows the physical_sales_complete flag', () => {
    const records = buildMarketingPriceRecords({
      rows,
      cropYear: 2026,
      salesStatus: [
        { crop_id: 'corn', physical_sales_complete: true },
        { crop_id: 'soy', physical_sales_complete: false },
      ],
      allowedCropIds: null,
      asOf,
    })
    expect(records.find((r) => r.crop === 'Corn')!.is_final).toBe(true)
    expect(records.find((r) => r.crop === 'Soybeans')!.is_final).toBe(false)
  })

  it('limits share tokens to the crops on their shared fields', () => {
    const records = buildMarketingPriceRecords({
      rows, cropYear: 2026, salesStatus: [], allowedCropIds: new Set(['soy']), asOf,
    })
    expect(records.map((r) => r.crop)).toEqual(['Soybeans'])
  })
})

describe('shareScopeError', () => {
  it('never gates a full-org token', () => {
    expect(shareScopeError(null, 'projected_prices')).toBeNull()
  })
  it('names the scope it denies (the 403 body)', () => {
    const off = { sharesProjectedPrices: false, sharesProjectedYields: false }
    expect(shareScopeError(off, 'projected_prices')).toEqual({
      error: 'This share does not include projected prices.',
      code: 'not_in_share_scope',
      scope: 'projected_prices',
    })
    expect(shareScopeError(off, 'projected_yields')?.scope).toBe('projected_yields')
  })
  it('passes when the scope is on', () => {
    expect(shareScopeError({ sharesProjectedPrices: true, sharesProjectedYields: false }, 'projected_prices')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Projected yields
// ---------------------------------------------------------------------------

const FIELDS = [
  { id: 'f1', name_or_number: 'North 40' },
  { id: 'f2', name_or_number: 'River Dry' },
  { id: 'f3', name_or_number: 'Outside Place' },
]

const baseYieldArgs = {
  cropYear: 2026,
  fields: FIELDS,
  crops: [corn, soy, crop('cotton', 'Cotton')],
  doubleCropIds: new Set<string>(),
  aggByKey: new Map<string, FieldCropAgg>(),
  cottonLbsByField: new Map<string, number>(),
  excluded: new Map<string, ExclusionReason>(),
  cropCompleteKeys: new Set<string>(),
  allowedFieldIds: null,
}

describe('buildProjectedYieldRecords', () => {
  it('breaks a mixed planting out by practice, each yield falling back to the blend', () => {
    const records = buildProjectedYieldRecords({
      ...baseYieldArgs,
      plantings: [
        planting({ id: 'p1', field_id: 'f1', crop_id: 'corn', planted_acres: 100, irrigated_acres: 60, dryland_acres: 40 }),
      ],
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 180, expected_yield_irr: 220, expected_yield_dry: 130 })],
    })
    expect(records).toHaveLength(1)
    const r = records[0]
    // (220×60 + 130×40) / 100 = 184 bu/ac blended.
    expect(r.yield_per_acre).toBe(184)
    expect(r.basis).toBe('expected')
    expect(r.unit).toBe('bu_per_ac')
    expect(r.practices).toEqual([
      { practice: 'irrigated', acres: 60, yield_per_acre: 220 },
      { practice: 'dryland', acres: 40, yield_per_acre: 130 },
    ])
  })

  it('uses the double-crop yield variants for double-crop plantings', () => {
    const records = buildProjectedYieldRecords({
      ...baseYieldArgs,
      doubleCropIds: new Set(['p1']),
      plantings: [
        planting({ id: 'p1', field_id: 'f1', crop_id: 'soy', planted_acres: 80, irrigated_acres: 0, dryland_acres: 80 }),
      ],
      assumptions: [assumption({ crop_id: 'soy', expected_yield: 55, expected_yield_dc_dry: 40 })],
    })
    expect(records[0].yield_per_acre).toBe(40)
    expect(records[0].practices).toBeNull() // pure-practice field: no breakout
  })

  it('field rows sum exactly to the marketing engine expected production', () => {
    const plantings = [
      planting({ id: 'p1', field_id: 'f1', crop_id: 'corn', planted_acres: 100, irrigated_acres: 60, dryland_acres: 40 }),
      planting({ id: 'p2', field_id: 'f2', crop_id: 'corn', planted_acres: 55, irrigated_acres: 0, dryland_acres: 55 }),
    ]
    const assumptions = [assumption({ crop_id: 'corn', expected_yield: 180, expected_yield_irr: 220, expected_yield_dry: 130 })]
    const records = buildProjectedYieldRecords({ ...baseYieldArgs, plantings, assumptions })
    const fieldSum = records.reduce((s, r) => s + r.yield_per_acre * r.planted_acres, 0)
    const seg = segmentAcresByCrop(
      plantings.map((p) => ({ id: p.id, crop_id: p.crop_id, season_year: p.season_year, irrigated_acres: p.irrigated_acres, dryland_acres: p.dryland_acres })),
      2026,
      new Set(),
    )
    const engine = expectedProductionFromBreakout(seg, assumptions, 2026).get('corn')!
    expect(fieldSum).toBeCloseTo(engine, 6)
  })

  it('omits a crop with no expectation set', () => {
    const records = buildProjectedYieldRecords({
      ...baseYieldArgs,
      plantings: [planting({ id: 'p1', field_id: 'f1', crop_id: 'corn' })],
      assumptions: [],
    })
    expect(records).toHaveLength(0)
  })

  it('replaces the expectation with actuals once harvest is complete, flagged basis:actual', () => {
    const aggByKey = new Map<string, FieldCropAgg>([
      ['f1|corn|2026', { dryBu: 19000, lastLoadDate: '2026-09-20', irrBu: 0, dryLandBu: 0, designatedLoads: 0, totalLoads: 4 }],
    ])
    const records = buildProjectedYieldRecords({
      ...baseYieldArgs,
      aggByKey,
      cropCompleteKeys: new Set(['corn|2026']),
      plantings: [
        planting({
          id: 'p1', field_id: 'f1', crop_id: 'corn', planted_acres: 100, irrigated_acres: 60, dryland_acres: 40,
          irrigated_bushels: 13000, dryland_bushels: 6000, yield_breakout_entered: true,
        }),
      ],
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 180 })],
    })
    const r = records[0]
    expect(r.basis).toBe('actual')
    expect(r.yield_per_acre).toBe(190) // 19,000 ÷ 100
    // Manual practice allocation resolves through resolvePracticeBreakout.
    expect(r.practices).toEqual([
      { practice: 'irrigated', acres: 60, yield_per_acre: 216.7 }, // 13,000 ÷ 60
      { practice: 'dryland', acres: 40, yield_per_acre: 150 },     // 6,000 ÷ 40
    ])
  })

  it('keeps an in-progress field on the expectation', () => {
    const aggByKey = new Map<string, FieldCropAgg>([
      ['f1|corn|2026', { dryBu: 4000, lastLoadDate: '2026-09-20' }],
    ])
    const records = buildProjectedYieldRecords({
      ...baseYieldArgs,
      aggByKey,
      excluded: new Map<string, ExclusionReason>([['p1', 'in_progress']]),
      plantings: [planting({ id: 'p1', field_id: 'f1', crop_id: 'corn' })],
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 180 })],
    })
    expect(records[0].basis).toBe('expected')
    expect(records[0].yield_per_acre).toBe(180)
  })

  it('cotton fields project in lbs of lint per acre and take actuals from gin receipts', () => {
    const records = buildProjectedYieldRecords({
      ...baseYieldArgs,
      cropCompleteKeys: new Set(['cotton|2026']),
      cottonLbsByField: new Map([['f1', 96000]]),
      plantings: [
        planting({ id: 'p1', field_id: 'f1', crop_id: 'cotton', planted_acres: 80, irrigated_acres: 0, dryland_acres: 80 }),
        planting({ id: 'p2', field_id: 'f2', crop_id: 'cotton', planted_acres: 40, irrigated_acres: 0, dryland_acres: 40 }),
      ],
      assumptions: [assumption({ crop_id: 'cotton', expected_yield: 1100 })],
    })
    const done = records.find((r) => r.field_name === 'North 40')!
    expect(done.unit).toBe('lbs_per_ac')
    expect(done.basis).toBe('actual')
    expect(done.yield_per_acre).toBe(1200) // 96,000 ÷ 80
    // No receipts for the second field yet → still the expectation.
    const pending = records.find((r) => r.field_name === 'River Dry')!
    expect(pending.basis).toBe('expected')
    expect(pending.yield_per_acre).toBe(1100)
  })

  it('a field outside the share NEVER appears', () => {
    const records = buildProjectedYieldRecords({
      ...baseYieldArgs,
      allowedFieldIds: new Set(['f1']),
      plantings: [
        planting({ id: 'p1', field_id: 'f1', crop_id: 'corn' }),
        planting({ id: 'p2', field_id: 'f3', crop_id: 'corn' }),
      ],
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 180 })],
    })
    expect(records.map((r) => r.field_name)).toEqual(['North 40'])
  })
})
