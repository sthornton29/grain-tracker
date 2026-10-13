import { describe, expect, it } from 'vitest'
import {
  applyPriceLaterMove, buildPriceLaterPools, buildSpotContracts, parsePriceLaterPoolId, parseSpotContractId, planPriceLaterPricing,
  spotContractId, toMarketingContract, withSpotContracts, type SaleSourceLoad,
} from '@/lib/virtual-contracts'
import type { LoadSale } from '@/lib/load-sales'
import { computeMarketing, type Planting } from '@/lib/marketing'
import { computeRevenueProjections } from '@/lib/revenue-projections'
import { buildEntityScope } from '@/lib/entity-scope'
import type { Contract, Crop, CropAssumption } from '@/lib/types'

// Bunge 0000205995: five spot loads (4,793.900 bu, $65,528.26320, avg
// 13.669093) and 2,059.757 bu on contract 2002960604-10 @ 12.71.

const SPOT = [
  { id: 'L289', date: '2026-09-25', bu: 912.744, price: 13.74, fut: 13.55 },
  { id: 'L302', date: '2026-09-25', bu: 959.926, price: 13.74, fut: 13.55 },
  { id: 'L508', date: '2026-09-26', bu: 1026, price: 13.74, fut: 13.55 },
  { id: 'L509', date: '2026-09-26', bu: 951, price: 13.74, fut: 13.55 },
  { id: 'L084', date: '2026-09-28', bu: 944.23, price: 13.38, fut: 13.2 },
]

function load(over: Partial<SaleSourceLoad> & Pick<SaleSourceLoad, 'id' | 'dryBu'>): SaleSourceLoad {
  return { crop_id: 'soy', crop_year: 2026, to_buyer_id: 'bunge', to_type: 'buyer', date: '2026-09-25', from_field_id: 'fieldA', from_type: 'field', ...over }
}
function sale(over: Partial<LoadSale> & Pick<LoadSale, 'load_id' | 'sale_type' | 'share'>): LoadSale {
  return { id: `s-${over.load_id}-${over.sale_type}`, contract_id: null, buyer_net_bushels: null, spot_price: null, spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null, ...over }
}

const spotLoads = SPOT.map((s) => load({ id: s.id, dryBu: s.bu, date: s.date }))
const spotSales = SPOT.map((s) => sale({ load_id: s.id, sale_type: 'spot', share: 1, spot_price: s.price, spot_price_source: 'settlement', est_futures_price: s.fut, est_futures_symbol: 'ZSX26', est_basis: s.price - s.fut }))
// The split ticket's contract part is NOT spot — only its spot share lands here.
const splitLoad = load({ id: 'L289', dryBu: 971.028 })
const splitSales = [
  sale({ id: 'c289', load_id: 'L289', sale_type: 'contract', contract_id: 'K', share: 0.06002298, spot_price: null }),
  sale({ id: 's289', load_id: 'L289', sale_type: 'spot', share: 0.93997702, spot_price: 13.74, spot_price_source: 'settlement', est_futures_price: 13.55, est_futures_symbol: 'ZSX26', est_basis: 0.19 }),
]

describe('buildSpotContracts', () => {
  it('one virtual contract per crop × year, held by the marketing agent, with per-buyer subtotals', () => {
    const [spot, ...rest] = buildSpotContracts({ loads: spotLoads, sales: spotSales, marketingAgentEntityId: 'TRW' })
    expect(rest).toEqual([])
    expect(spot.id).toBe(spotContractId('soy', 2026, 'TRW'))
    expect(parseSpotContractId(spot.id)).toEqual({ cropId: 'soy', cropYear: 2026, entityId: 'TRW' })
    expect(spot.entity_id).toBe('TRW')
    expect(spot.bushels).toBeCloseTo(4793.9, 6)
    expect(spot.revenue).toBeCloseTo(65528.2632, 4)
    expect(spot.avgPrice).toBeCloseTo(13.669093, 6)
    expect(spot.estimated).toBe(false)
    expect(spot.summary.statusText).toBe('5 of 5 settled')
    expect(spot.buyers).toHaveLength(1)
    expect(spot.buyers[0]).toMatchObject({ buyerId: 'bunge', loadCount: 5 })
    expect(spot.buyers[0].bushels).toBeCloseTo(4793.9, 6)
    expect(spot.rows.map((r) => r.load.id)).toEqual(['L289', 'L302', 'L508', 'L509', 'L084'])
  })

  it('a split load contributes only its spot share', () => {
    const [spot] = buildSpotContracts({ loads: [splitLoad], sales: splitSales, marketingAgentEntityId: 'TRW' })
    expect(spot.bushels).toBeCloseTo(912.744, 3)
    expect(spot.rows[0].alloc.saleType).toBe('spot')
  })

  it('without a marketing agent, each spot load goes to its source field\'s entity (split sources fan out)', () => {
    const fieldEntity = new Map([['fieldA', 'VCF'], ['fieldB', 'TSF']])
    const loads = [load({ id: 'a', dryBu: 1000, from_field_id: 'fieldA' }), load({ id: 'b', dryBu: 500, from_field_id: null }), load({ id: 'bin', dryBu: 200, from_field_id: null, from_type: 'bin' })]
    const sales = [
      sale({ load_id: 'a', sale_type: 'spot', share: 1, spot_price: 13, spot_price_source: 'settlement' }),
      sale({ load_id: 'b', sale_type: 'spot', share: 1, spot_price: 13, spot_price_source: 'settlement' }),
      sale({ load_id: 'bin', sale_type: 'spot', share: 1, spot_price: 13, spot_price_source: 'settlement' }),
    ]
    const splitsByLoad = new Map([['b', [{ field_id: 'fieldA', fraction: 0.4 }, { field_id: 'fieldB', fraction: 0.6 }]]])
    const spots = buildSpotContracts({ loads, sales, marketingAgentEntityId: null, fieldEntity, splitsByLoad })
    const byEntity = Object.fromEntries(spots.map((s) => [s.entity_id ?? 'null', s.bushels]))
    expect(byEntity.VCF).toBeCloseTo(1000 + 200, 6)
    expect(byEntity.TSF).toBeCloseTo(300, 6)
    expect(byEntity.null).toBeCloseTo(200, 6) // the bin load is operation-level
  })

  it('an estimated or unpriced load marks the contract est.', () => {
    const sales = spotSales.map((s, i) => (i === 4 ? { ...s, spot_price_source: 'estimate' as const } : s))
    const [spot] = buildSpotContracts({ loads: spotLoads, sales, marketingAgentEntityId: null })
    expect(spot.estimated).toBe(true)
    expect(spot.summary.statusText).toBe('4 of 5 settled · est. on 1')
  })
})

// ---------- Marketing: the spot contract through the real engine ----------

function crop(id: string, name: string): Crop {
  return { id, name, base_moisture_pct: 13, base_lb_per_bushel: 60, harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null, rma_type_override: null }
}
function assumption(over: Partial<CropAssumption> & Pick<CropAssumption, 'crop_id'>): CropAssumption {
  return {
    id: `a-${over.crop_id}`, crop_year: 2026, expected_yield: null, expected_yield_irr: null, expected_yield_dry: null, expected_yield_dc_irr: null, expected_yield_dc_dry: null,
    harvest_complete: false, assumed_basis: 0, assumed_futures: null, reference_contract_month: null, assumed_acres: null, assumed_acres_irr: null, assumed_acres_dry: null,
    assumed_acres_dc_irr: null, assumed_acres_dc_dry: null, cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null,
    notes: null, created_at: '', updated_at: '', ...over,
  }
}
function contract(over: Partial<Contract> & Pick<Contract, 'crop_id'>): Contract {
  return {
    id: 'K', contract_number: '2002960604-10', buyer_id: 'bunge', entity_id: 'TRW', crop_year: 2026, contracted_bushels: 0, price_per_bushel: null, notes: null,
    delivery_type: 'delivered', delivery_location_id: null, delivery_start_date: null, delivery_end_date: null, date_sold: null, completed_at: null, created_at: '',
    contract_month: null, contract_type: 'forward', futures_price: null, basis: null, cash_price: null, service_fee: 0, futures_set_date: null, basis_set_date: null,
    pricing_status: 'fully_priced', ...over,
  }
}

describe('the spot contract in the marketing engine', () => {
  const crops = [crop('soy', 'Soybean')]
  const plantings: Planting[] = [{ crop_id: 'soy', season_year: 2026, planted_acres: 200 }] // 200 ac × 50 = 10,000 bu
  const assumptions = [assumption({ crop_id: 'soy', expected_yield: 50, assumed_basis: -0.4, cost_per_acre: 300 })]
  const real = contract({ crop_id: 'soy', contracted_bushels: 2059.757, cash_price: 12.71, price_per_bushel: 12.71 })
  const [spot] = buildSpotContracts({ loads: spotLoads, sales: spotSales, marketingAgentEntityId: 'TRW' })

  it('toMarketingContract: a fully priced forward at the weighted average, with futures + basis when every load has a settle', () => {
    const m = toMarketingContract(spot)
    expect(m).toMatchObject({ contract_type: 'forward', pricing_status: 'fully_priced', entity_id: 'TRW', crop_year: 2026, source_label: 'Spot (5 loads)', virtual: 'spot' })
    expect(m.contracted_bushels).toBeCloseTo(4793.9, 2)
    expect(m.cash_price).toBeCloseTo(13.669093, 6)
    expect(m.futures_price).not.toBeNull()
    expect(m.futures_price! + m.basis!).toBeCloseTo(13.669093, 5)
  })

  it('priced 6,853.657 bu; the spot source line is 4,793.900 @ 13.669093; blended revenue includes 65,528.26', () => {
    const contracts = withSpotContracts([real], [spot])
    const currentFuturesByCrop = new Map([['soy', 13.0]])
    const [row] = computeMarketing({ cropYear: 2026, crops, plantings, contracts, futures: [], options: [], assumptions, actualProductionByCrop: new Map(), currentFuturesByCrop })
    expect(row.lockedPriceBu).toBeCloseTo(6853.657, 2)
    expect(row.contractedBu).toBeCloseTo(6853.657, 2)
    const spotLine = row.futuresSources.find((s) => s.label === 'Spot (5 loads)')!
    expect(spotLine.bushels).toBeCloseTo(4793.9, 2)
    expect(spotLine.avgPrice + spot.summary.futures!.avgBasis).toBeCloseTo(13.669093, 5)
    // Revenue = the contract's 26,179.51 + spot 65,528.26 + unpriced 3,146.343 × (13.00 − 0.40).
    const unpriced = 10000 - 6853.657
    expect(row.blendedRevenue).toBeCloseTo(26179.51147 + 65528.2632 + unpriced * 12.6, 1)
  })

  it('a spot contract with NO futures on its rows takes the engine\'s flat-cash path with the same revenue', () => {
    const flat = buildSpotContracts({ loads: spotLoads, sales: spotSales.map((s) => ({ ...s, est_futures_price: null, est_basis: null })), marketingAgentEntityId: 'TRW' })
    const m = toMarketingContract(flat[0])
    expect(m.futures_price).toBeNull()
    const [row] = computeMarketing({ cropYear: 2026, crops, plantings, contracts: withSpotContracts([real], flat), futures: [], options: [], assumptions, actualProductionByCrop: new Map(), currentFuturesByCrop: new Map([['soy', 13.0]]) })
    expect(row.futuresSources).toEqual([])
    expect(row.blendedRevenue).toBeCloseTo(26179.51147 + 65528.2632 + (10000 - 6853.657) * 12.6, 1)
  })

  it('the identity Revenue Projections − Marketing = insurance + government holds with spot and price-later present', () => {
    // A price-later load is UNPRICED: it is simply absent from the contract inputs.
    const contracts = withSpotContracts([real], [spot])
    const marketingRows = computeMarketing({ cropYear: 2026, crops, plantings, contracts, futures: [], options: [], assumptions, actualProductionByCrop: new Map(), currentFuturesByCrop: new Map([['soy', 13.0]]) })
    const insuranceByCrop = new Map([['soy', { netPnl: 1500, totalIndemnity: 4000, premium: 2500 }]])
    const govtByCrop = new Map([['soy', { arcPlc: 900, cropSpecificOther: 100, allocatedOther: 50 }]])
    const { rows } = computeRevenueProjections({ marketingRows, contracts, cropYear: 2026, marketPriceByCrop: new Map(), insuranceByCrop, govtByCrop })
    expect(rows[0].cropSalesRevenue).toBeCloseTo(marketingRows[0].blendedRevenue, 2)
    expect(rows[0].profit! - marketingRows[0].totalProfit!).toBeCloseTo(1500 + 1050, 2)
    expect(rows[0].pricedBu).toBeCloseTo(6853.657, 2)
  })

  it('entity flow-down: VCF 60% / TSF 40% of soybean acres → 2,876.340 bu ($39,316.96) / 1,917.560 bu ($26,211.31)', () => {
    const entities = [{ id: 'VCF', entity_role: 'farming' }, { id: 'TSF', entity_role: 'farming' }, { id: 'TRW', entity_role: 'marketing_agent' }]
    const farms = [{ id: 'F-V', entity_id: 'VCF' }, { id: 'F-T', entity_id: 'TSF' }]
    const fields = [{ id: 'fv', farm_id: 'F-V' }, { id: 'ft', farm_id: 'F-T' }]
    const allPlantings = [{ field_id: 'fv', crop_id: 'soy', season_year: 2026, planted_acres: 120 }, { field_id: 'ft', crop_id: 'soy', season_year: 2026, planted_acres: 80 }]
    const spotOnly = withSpotContracts([], [spot])
    const share = (entityId: string) => {
      const scope = buildEntityScope({ entityId, farms, fields, entities })
      const attribution = scope.attribution({ plantings: allPlantings, crops })
      const [c] = attribution.contracts(spotOnly)
      return { bu: c.contracted_bushels, dollars: c.contracted_bushels * Number(c.cash_price) }
    }
    const vcf = share('VCF'), tsf = share('TSF')
    expect(vcf.bu).toBeCloseTo(2876.34, 3)
    expect(vcf.dollars).toBeCloseTo(39316.96, 2)
    expect(tsf.bu).toBeCloseTo(1917.56, 3)
    expect(tsf.dollars).toBeCloseTo(26211.31, 2)
    expect(vcf.bu + tsf.bu).toBeCloseTo(4793.9, 3)
    expect(vcf.dollars + tsf.dollars).toBeCloseTo(65528.26, 2)
  })
})

// ---------- Price later ----------

describe('price-later pools and FIFO pricing', () => {
  const loads = [
    load({ id: 'p1', dryBu: 1000, date: '2026-09-20' }),
    load({ id: 'p2', dryBu: 900, date: '2026-09-22' }),
    load({ id: 'p3', dryBu: 1100, date: '2026-09-24' }),
  ]
  const sales = loads.map((l) => sale({ load_id: l.id, sale_type: 'price_later', share: 1 }))

  it('one pool per crop × year × buyer: 3,000 bu, 3 loads, oldest 9/20', () => {
    const [pool, ...rest] = buildPriceLaterPools(loads, sales)
    expect(rest).toEqual([])
    expect(parsePriceLaterPoolId(pool.id)).toEqual({ cropId: 'soy', cropYear: 2026, buyerId: 'bunge' })
    expect(pool).toMatchObject({ bushels: 3000, loadCount: 3, oldestDate: '2026-09-20', newestDate: '2026-09-24' })
  })

  it('"Price bushels" 2,500 → 1,000 + 900 whole, 600 of the third (split 600 contract / 500 price later), 500 left', () => {
    const [pool] = buildPriceLaterPools(loads, sales)
    const plan = planPriceLaterPricing(pool, 2500, 'NEW')
    expect(plan.priced).toBe(2500)
    expect(plan.leftover).toBe(500)
    expect(plan.moves.map((m) => [m.loadId, m.bushels, m.split])).toEqual([['p1', 1000, false], ['p2', 900, false], ['p3', 600, true]])
    expect(plan.moves[2].rows.map((r) => [r.sale_type, r.contract_id])).toEqual([['contract', 'NEW'], ['price_later', null]])
    expect(plan.moves[2].rows[0].share).toBeCloseTo(600 / 1100, 9)
    expect(plan.moves[2].rows[1].share).toBeCloseTo(500 / 1100, 9)
    expect(plan.moves[2].rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 12)
    // Applying the third move keeps nothing else (the load had only the price-later row).
    const rows = applyPriceLaterMove(sales.filter((s) => s.load_id === 'p3'), plan.moves[2])
    expect(rows.map((r) => r.sale_type)).toEqual(['contract', 'price_later'])
    expect(rows[0].share).toBeCloseTo(600 / 1100, 9)
    expect(rows[0].share + rows[1].share).toBe(1)
  })

  it('pricing more than the pool prices everything; a load with a prior spot part keeps it', () => {
    const [pool] = buildPriceLaterPools(loads, sales)
    const plan = planPriceLaterPricing(pool, 5000, 'NEW')
    expect(plan.priced).toBe(3000)
    expect(plan.leftover).toBe(0)
    expect(plan.moves.every((m) => !m.split)).toBe(true)
    const mixed = [sale({ id: 'x-spot', load_id: 'x', sale_type: 'spot', share: 0.25, spot_price: 13, spot_price_source: 'entered' }), sale({ id: 'x-pl', load_id: 'x', sale_type: 'price_later', share: 0.75 })]
    const rows = applyPriceLaterMove(mixed, { loadId: 'x', bushels: 1, split: false, rows: [{ sale_type: 'contract', contract_id: 'NEW', share: 0.75 }] })
    expect(rows.map((r) => [r.sale_type, r.share])).toEqual([['spot', 0.25], ['contract', 0.75]])
  })
})
