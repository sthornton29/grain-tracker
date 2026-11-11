import { describe, expect, it } from 'vitest'
import { computeMarketing, type Planting } from '@/lib/marketing'
import { buildSpotInputs } from '@/lib/spot-contracts'
import { keptForSeedByCrop, keptForSeedContracts, toKeptForSeedContract, type KeptForSeedRow } from './kept-for-seed'
import type { Crop, Contract, CropAssumption } from '@/lib/types'

const kept: KeptForSeedRow = { id: 'k1', crop_id: 'wheat', crop_year: 2026, entity_id: null, bushels: '1462.67', price_per_bu: '5.737', kept_on: '2026-06-04', reference: 'turnrow-farm:saved_seed_lot:x', label: '26R59' }

const crop: Crop = { id: 'wheat', name: 'Wheat', base_moisture_pct: 13.5, base_lb_per_bushel: 60, harvest_category: 'summer', double_crop: false, combine_adjustment_bu_per_acre: null, rma_type_override: null }
const planting: Planting = { crop_id: 'wheat', season_year: 2026, planted_acres: 100 }
const assumption = { id: 'a', crop_id: 'wheat', crop_year: 2026, expected_yield: 100, expected_yield_irr: null, expected_yield_dry: null, expected_yield_dc_irr: null, expected_yield_dc_dry: null, harvest_complete: false, assumed_basis: 0, assumed_futures: 6, reference_contract_month: null, assumed_acres: null, assumed_acres_irr: null, assumed_acres_dry: null, assumed_acres_dc_irr: null, assumed_acres_dc_dry: null, cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null, notes: null, created_at: '', updated_at: '' } as CropAssumption
const sold: Contract = { id: 'c', contract_number: 'CN', buyer_id: null, entity_id: null, crop_id: 'wheat', crop_year: 2026, contracted_bushels: 8000, price_per_bushel: null, notes: null, delivery_type: 'pickup', delivery_location_id: null, delivery_start_date: null, delivery_end_date: null, date_sold: null, completed_at: null, created_at: '', contract_month: null, contract_type: 'forward', futures_price: null, basis: null, cash_price: 6.1, service_fee: 0, futures_set_date: null, basis_set_date: null, pricing_status: 'fully_priced' }

describe('grain kept for seed', () => {
  it('is a fully priced flat-cash sale at the kept price', () => {
    const c = toKeptForSeedContract(kept)
    expect(c).toMatchObject({ id: 'kept-seed:k1', contracted_bushels: 1462.67, cash_price: 5.737, pricing_status: 'fully_priced', virtual: 'kept_for_seed' })
    expect(keptForSeedContracts([kept], 2027)).toHaveLength(0)
  })
  it('sums by crop for the settled figures', () => {
    const m = keptForSeedByCrop([kept, { ...kept, id: 'k2', bushels: 721.67 }], 2026).get('wheat')!
    expect(m.quantity).toBeCloseTo(2184.34, 2)
    expect(m.revenue).toBeCloseTo(2184.34 * 5.737, 2)
  })
  it('leaves unsold and lands in the blended revenue once, through the spot seam', () => {
    const spot = buildSpotInputs({ loads: [], sales: [], crops: [], entities: [], keptForSeed: [{ ...kept, bushels: 1000, price_per_bu: 5.5 }] })
    const run = (contracts: Contract[]) => computeMarketing({ cropYear: 2026, crops: [crop], plantings: [planting], contracts, futures: [], options: [], assumptions: [assumption], actualProductionByCrop: new Map() })[0]
    const before = run([sold])
    const after = run(spot.contractsWithSpot([sold]))
    // 10,000 bu: 8,000 sold at 6.10, the rest unpriced at 6.00 before; 1,000 of it kept at 5.50 after.
    expect(before.blendedRevenue).toBeCloseTo(8000 * 6.1 + 2000 * 6, 2)
    expect(after.blendedRevenue).toBeCloseTo(8000 * 6.1 + 1000 * 5.5 + 1000 * 6, 2)
    expect(after.contractedBu).toBe(9000)
  })
})
