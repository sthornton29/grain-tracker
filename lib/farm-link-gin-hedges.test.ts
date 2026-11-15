// Farm Link, 2026-11-15: the statements of ginning summed per field on the
// cotton production records, and the open hedges marked to market on the
// whole-operation marketing rows (the total average price with realized
// and unrealized hedging in).
import { describe, expect, it } from 'vitest'
import { IdMap } from '@/lib/farm-link'
import type { MarketingRow } from '@/lib/marketing'
import type { PartnerProduction } from '@/lib/partner-api'
import { ginByField, openHedgesBlock, shapeMarketingRecord, shapeProductionRecords } from '@/lib/farm-link-outbound'

function mkRow(over: Partial<MarketingRow>): MarketingRow {
  const base = {
    cropId: 'soy', cropName: 'Soybean', unit: 'bu', cottonBales: null, productionBales: null, baleWeightLbs: null, cottonPhysical: null, seed: null,
    acres: 2000, acresSource: 'plantings', yield: 46.3, yieldLabel: 'Actual', totalProduction: 92574.68, contractedBu: 89079.05, remaining: 3495.63,
    avgCashPrice: null, excludedAwaitingBu: 0, futuresPricedBu: 0, physicalFuturesBu: 0, physicalFuturesAvg: null, openHedgeBu: 30000, openHedgeAvg: 10.55,
    rawAvgFutures: 11.9, hedgeRealizedPnl: -20212.5, hedgeAdjPerBu: -0.2183, avgFutures: 11.68, avgBasis: 0.611, avgBasisAssumed: false, assumedBasis: 0.8,
    assumedFutures: null, basisLockedBu: 60000, basisLockedAvg: 0.6, basisAssumedBu: 3495.63, basisState: 'blended', totalAvgPrice: 12.9489,
    unpricedBu: 0, blendedRevenue: 12.9489 * 92574.68, unpricedFuturesPrice: 12.1, costPerAcre: null, costPerBu: null, revenuePerAcre: null, profitPerAcre: null,
    totalProfit: null, openFuturesHedgedBu: 30000, futuresSources: [], lockedPriceBu: 0, futuresAssumedBu: 0,
  }
  return { ...base, ...over } as unknown as MarketingRow
}

describe('ginByField', () => {
  it('sums a field\'s statements, leaves a statement with no field out, and keeps cottonseed null until one states it', () => {
    const by = ginByField([
      { field_id: 'wheeler', modules_count: 20, total_seed_cotton_weight: 640000, bales_count: 510, total_bale_weight: 251000, seed_lbs: 300000, receipt_date: '2026-10-19' },
      { field_id: 'wheeler', modules_count: 12, total_seed_cotton_weight: '371500', bales_count: 296, total_bale_weight: '147089', seed_lbs: '173483', receipt_date: '2026-11-06' },
      { field_id: 'joes', bales_count: 136, total_bale_weight: 68255, seed_lbs: null, receipt_date: null },
      { field_id: null, bales_count: 9, total_bale_weight: 4400, seed_lbs: 5000 },
    ])
    expect(by.get('wheeler')).toEqual({ receipts: 2, modules: 32, seed_cotton_lbs: 1011500, bales: 806, lint_lbs: 398089, cottonseed_lbs: 473483, receipts_without_cottonseed: 0, last_receipt_date: '2026-11-06' })
    expect(by.get('joes')).toEqual({ receipts: 1, modules: null, seed_cotton_lbs: null, bales: 136, lint_lbs: 68255, cottonseed_lbs: null, receipts_without_cottonseed: 1, last_receipt_date: null })
    expect(by.size).toBe(2)
  })

  it('rides on the cotton production records only, null when the field has no statement', () => {
    const partner: PartnerProduction[] = [
      { field_id: 'f-corn', field_name: 'North 40', entity_id: null, entity: null, crop: 'Corn', crop_year: 2026, planted_acres: 40, harvested_acres: 40, harvest_status: 'complete', production_units: 7400, unit: 'bu', updated_at: null },
      { field_id: 'joes', field_name: 'Joes L', entity_id: null, entity: null, crop: 'Cotton', crop_year: 2026, planted_acres: 45.6, harvested_acres: 45.6, harvest_status: 'complete', production_units: 68255, unit: 'lbs', lint_basis: 'actual', turnout_pct: null, updated_at: null },
      { field_id: 'yard', field_name: 'Still On The Yard', entity_id: null, entity: null, crop: 'Cotton', crop_year: 2026, planted_acres: 30, harvested_acres: 0, harvest_status: 'in_progress', production_units: 20000, unit: 'lbs', lint_basis: 'estimated_turnout', turnout_pct: 40, updated_at: null },
    ]
    const out = shapeProductionRecords({
      partner, projected: [], plantings: [], crops: [{ id: 'corn', name: 'Corn' }, { id: 'cotton', name: 'Cotton' }], fields: [],
      combineKeys: new Set(), loadKeys: new Set(), moistureByKey: new Map(), idMap: new IdMap([]), year: 2026,
      ginByField: ginByField([{ field_id: 'joes', modules_count: 6, total_seed_cotton_weight: 173100, bales_count: 136, total_bale_weight: 68255, seed_lbs: 79507, receipt_date: '2026-11-05' }]),
    })
    expect('gin' in out[0]).toBe(false)
    expect(out[1].gin).toEqual({ receipts: 1, modules: 6, seed_cotton_lbs: 173100, bales: 136, lint_lbs: 68255, cottonseed_lbs: 79507, receipts_without_cottonseed: 0, last_receipt_date: '2026-11-05' })
    expect(out[2].gin).toBeNull()
    // A caller that passes no statements leaves the records as they were.
    const bare = shapeProductionRecords({ partner, projected: [], plantings: [], crops: [{ id: 'corn', name: 'Corn' }, { id: 'cotton', name: 'Cotton' }], fields: [], combineKeys: new Set(), loadKeys: new Set(), moistureByKey: new Map(), idMap: new IdMap([]), year: 2026 })
    expect('gin' in bare[1]).toBe(false)
  })
})

describe('openHedgesBlock', () => {
  const quote = (price: number, price_date = '2026-11-13') => ({ price, price_date })

  it('adds the mark on the futures past the unsold bushels, which the projected average does not hold', () => {
    // 30,000 bu short at 10.55 against 3,495.63 unsold; the market is 12.11.
    const { open_hedges: h, total_average_price } = openHedgesBlock({
      row: mkRow({}), sold: 89079.05, projected: 12.9489,
      futures: [{ status: 'open', side: 'short', num_contracts: 6, trade_price: 10.55, contract_symbol: 'ZSX26' }],
      optionContracts: 0, pnlSize: 5000, quotes: new Map([['ZSX26', quote(12.11)]]),
    })
    expect(h.quantity).toBe(30000)
    expect(h.covered_quantity).toBe(3495.63)
    expect(h.unrealized).toBe(-46800)
    expect(h.unrealized_beyond_unsold).toBe(-41346.82)
    expect(h.quote_date).toBe('2026-11-13')
    expect(total_average_price).toBe(12.5023)
  })

  it('adds nothing when the open futures all cover unsold bushels (the projected average already values those at the hedge price)', () => {
    const row = mkRow({ cropId: 'corn', cropName: 'Corn', totalProduction: 706885.51, contractedBu: 500333.21, openHedgeBu: 190000, openHedgeAvg: 5.2684, unpricedBu: 16552.3 })
    const { open_hedges: h, total_average_price } = openHedgesBlock({
      row, sold: 500333.21, projected: 5.3654,
      futures: [{ status: 'open', side: 'short', num_contracts: 38, trade_price: 5.2684, contract_symbol: 'ZCZ26' }, { status: 'closed', side: 'short', num_contracts: 69, trade_price: 4.9061, contract_symbol: 'ZCZ26' }],
      optionContracts: 8, pnlSize: 5000, quotes: new Map([['ZCZ26', quote(4.9)]]),
    })
    expect(h.covered_quantity).toBe(190000)
    expect(h.unpriced_quantity).toBe(16552.3)
    expect(h.unrealized).toBe(69996)
    expect(h.unrealized_beyond_unsold).toBe(0)
    expect(h.open_option_contracts).toBe(8)
    expect(total_average_price).toBe(5.3654)
  })

  it('works cotton in cents a pound, and leaves the total null when a position has no quote', () => {
    const row = mkRow({ cropId: 'cotton', cropName: 'Cotton', unit: 'lbs', totalProduction: 3757508, openHedgeBu: 1350000, openHedgeAvg: 81.9663, unpricedBu: 0, cottonPhysical: { hedgedUnsoldLbs: 1100286.52 } as never })
    const futures = [{ status: 'open', side: 'short', num_contracts: 27, trade_price: 81.9663, contract_symbol: 'CTH27' }]
    const marked = openHedgesBlock({ row, sold: 2657221.48, projected: 84.9401, futures, optionContracts: 0, pnlSize: 500, quotes: new Map([['CTH27', quote(80)]]) })
    // 27 contracts x $500 a cent x 1.9663 cents; 18.5% of the book is past the unsold lint.
    expect(marked.open_hedges.unrealized).toBe(26545.05)
    expect(marked.open_hedges.unrealized_beyond_unsold).toBe(4910.12)
    expect(marked.total_average_price).toBe(85.0708)
    const blind = openHedgesBlock({ row, sold: 2657221.48, projected: 84.9401, futures, optionContracts: 0, pnlSize: 500, quotes: new Map() })
    expect(blind.open_hedges.unrealized).toBeNull()
    expect(blind.open_hedges.unquoted_positions).toBe(1)
    expect(blind.total_average_price).toBeNull()
  })

  it('goes out on the whole-operation row only, and the total is the projected average when nothing is open', () => {
    const none = shapeMarketingRecord({ row: mkRow({ openHedgeBu: 0, openHedgeAvg: null, unpricedBu: 3495.63 }), cropYear: 2026, entity: null, settled: null, isFinal: false, asOf: 'x', hedges: { futures: [], optionContracts: 0, pnlSize: 5000, quotes: new Map() } })
    expect(none.total_average_price).toBe(12.9489)
    expect(none.open_hedges).toMatchObject({ quantity: 0, unrealized: 0, unrealized_beyond_unsold: 0, unpriced_quantity: 3495.63 })
    const entity = shapeMarketingRecord({ row: mkRow({}), cropYear: 2026, entity: { id: 'e', name: 'Two Seasons Farm LLC', farm_uid: null }, settled: null, isFinal: false, asOf: 'x' })
    expect('open_hedges' in entity).toBe(false)
    expect('total_average_price' in entity).toBe(false)
  })
})
