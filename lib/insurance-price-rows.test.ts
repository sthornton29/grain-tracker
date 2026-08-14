import { describe, it, expect } from 'vitest'
import {
  harvestPhase, mergeRmaResults, parseRmaRevenuePrices, pickPrimaryRow,
  rmaCacheMissingContracts, type RmaLookupResult,
} from '@/lib/rma-price-discovery'
import { buildPriceDiscoveryRows, harvestTierLabel } from '@/lib/insurance-price-rows'
import type { HarvestPriceEstimate } from '@/lib/types'

// The unified Price Discovery window: row-model assembly, the three explicit
// harvest phases, and the write-then-swap refresh discipline.

const rma = (over: Partial<RmaLookupResult>): RmaLookupResult => ({
  crop_id: 'corn', state_code: 'AL', commodity_code: '0041',
  projected_price: 4.42, projected_status: 'released',
  projected_begin_date: '2026-01-15', projected_end_date: '2026-02-14',
  projected_label: 'RMA final',
  harvest_price: 4.42, harvest_status: 'in_discovery',
  harvest_begin_date: '2026-08-01', harvest_end_date: '2026-08-31',
  harvest_label: 'RMA discovery avg through 8/14/2026 (day 14 of 31)',
  volatility: 0.14, fetched_at: '2026-08-14T12:00:00Z',
  projected_market_symbol: 'ZCU26', harvest_market_symbol: 'ZCU26', harvest_exchange_code: 'CBOT',
  offer_identity: 'AL · All (Non-High Amylose) · Conventional · SCD 2/28/2026',
  ...over,
})

const est = (over: Partial<HarvestPriceEstimate>): HarvestPriceEstimate => ({
  id: 'e', crop_id: 'corn', crop_year: 2026, price_type: 'projected',
  price: 0, source: null, price_date: null, created_at: '',
  ...over,
} as HarvestPriceEstimate)

const BASE = {
  crops: [{ id: 'corn', name: 'Corn' }, { id: 'cotton', name: 'Cotton' }],
  plantings: [{ crop_id: 'corn', season_year: 2026 }],
  policies: [{ crop_id: 'cotton', crop_year: 2026 }],
  cropYear: 2026,
  estimates: [] as HarvestPriceEstimate[],
  keepManualProjected: new Set<string>(),
  liveQuotes: new Map<string, { price: number; priceDate: string | null }>(),
}

describe('harvestPhase', () => {
  it('maps status → phase; unknown/no offer reads as pre (estimate tier)', () => {
    expect(harvestPhase('yet_to_start')).toBe('pre')
    expect(harvestPhase('in_discovery')).toBe('in')
    expect(harvestPhase('released')).toBe('post')
    expect(harvestPhase(null)).toBe('pre')
  })
})

describe('buildPriceDiscoveryRows', () => {
  it('one row per grown crop (plantings OR policies), sorted; RMA offer attached', () => {
    const rows = buildPriceDiscoveryRows({ ...BASE, rmaResults: [rma({})] })
    expect(rows.map((r) => r.cropName)).toEqual(['Corn', 'Cotton'])
    const corn = rows[0]
    expect(corn.baseContract).toBe('ZCU26')
    expect(corn.offerIdentity).toContain('Conventional')
    // Cotton has no RMA result yet → placeholder row, pre phase.
    expect(rows[1].stateCode).toBeNull()
    expect(rows[1].harvest.phase).toBe('pre')
  })

  it('IN phase: RMA running average with the day-N label', () => {
    const rows = buildPriceDiscoveryRows({ ...BASE, rmaResults: [rma({})] })
    expect(rows[0].harvest).toMatchObject({ phase: 'in', price: 4.42 })
    expect(rows[0].harvest.label).toContain('day 14 of 31')
  })

  it('POST phase: the RMA final, labeled', () => {
    const rows = buildPriceDiscoveryRows({
      ...BASE,
      rmaResults: [rma({ harvest_status: 'released', harvest_price: 4.71 })],
    })
    expect(rows[0].harvest).toMatchObject({ phase: 'post', price: 4.71, label: 'RMA final' })
  })

  it('PRE phase: today’s quote of the OFFER base contract, with the start date', () => {
    const rows = buildPriceDiscoveryRows({
      ...BASE,
      rmaResults: [rma({ harvest_status: 'yet_to_start', harvest_price: null, harvest_label: null })],
      liveQuotes: new Map([['corn', { price: 4.5, priceDate: '2026-08-14' }]]),
    })
    expect(rows[0].harvest.phase).toBe('pre')
    expect(rows[0].harvest.price).toBe(4.5)
    expect(rows[0].harvest.label).toContain('ZCU26 today')
    expect(rows[0].harvest.label).toContain('discovery starts 8/1/2026')
  })

  it('cotton pre-phase live quote converts ¢/lb → $/lb at display', () => {
    const rows = buildPriceDiscoveryRows({
      ...BASE,
      rmaResults: [rma({ crop_id: 'cotton', commodity_code: '0021', harvest_status: 'yet_to_start', harvest_price: null, harvest_market_symbol: 'CTZ26' })],
      liveQuotes: new Map([['cotton', { price: 68.5, priceDate: '2026-08-14' }]]),
    })
    const cotton = rows.find((r) => r.cropName === 'Cotton')!
    expect(cotton.harvest.price).toBeCloseTo(0.685, 10)
  })

  it('no-offer rows say so instead of blanking, and stay on the estimate tier', () => {
    const rows = buildPriceDiscoveryRows({
      ...BASE,
      rmaResults: [rma({ crop_id: 'cotton', no_offer: true, projected_price: null, harvest_price: null, harvest_status: null, offer_identity: null, harvest_market_symbol: null })],
    })
    const cotton = rows.find((r) => r.cropName === 'Cotton')!
    expect(cotton.noOffer).toBe(true)
    expect(cotton.harvest.phase).toBe('pre')
  })

  it('manual override semantics match the old editor: keep-mine flips the resolved value', () => {
    const estimates = [
      est({ price: 4.55, source: 'manual', price_date: '2026-03-01' }),
      est({ price: 4.42, source: 'RMA final', price_date: '2026-02-14' }),
    ]
    const rmaWins = buildPriceDiscoveryRows({ ...BASE, estimates, rmaResults: [rma({})] })
    expect(rmaWins[0].projected.resolution).toMatchObject({ price: 4.42, source: 'rma', superseded: 4.55 })
    const kept = buildPriceDiscoveryRows({ ...BASE, estimates, rmaResults: [rma({})], keepManualProjected: new Set(['corn']) })
    expect(kept[0].projected.resolution).toMatchObject({ price: 4.55, source: 'manual' })
  })
})

describe('mergeRmaResults — write-then-swap, never blank', () => {
  const prev = [rma({})]

  it('failure keeps prior values with an error', () => {
    for (const bad of [null, {}, { data: {} }, { error: '504' }]) {
      const m = mergeRmaResults(prev, bad)
      expect(m.results).toHaveLength(1)
      expect(m.error).toBeTruthy()
    }
  })

  it('a suspiciously-empty success keeps prior values too', () => {
    const m = mergeRmaResults(prev, { data: { results: [] } })
    expect(m.results).toHaveLength(1)
    expect(m.error).toContain('no rows')
  })

  it('success swaps; invalid items are dropped', () => {
    const m = mergeRmaResults(prev, { data: { results: [rma({ projected_price: 4.5 }), { junk: true }] } })
    expect(m.error).toBeNull()
    expect(m.results).toHaveLength(1)
    expect(m.results[0].projected_price).toBe(4.5)
  })

  it('partial (per-row ↻) replaces only that crop × state, keeping the rest', () => {
    const two = [rma({}), rma({ crop_id: 'cotton', commodity_code: '0021' })]
    const m = mergeRmaResults(two, { data: { results: [rma({ projected_price: 9.99 })] } }, { partial: true })
    expect(m.results).toHaveLength(2)
    expect(m.results.find((r) => r.crop_id === 'corn')!.projected_price).toBe(9.99)
    expect(m.results.find((r) => r.crop_id === 'cotton')!.projected_price).toBe(4.42)
    // A failed per-row refresh keeps everything.
    const f = mergeRmaResults(two, null, { partial: true })
    expect(f.results).toHaveLength(2)
    expect(f.error).toBeTruthy()
  })
})

// The wheat case: fall-SCD offers (AL winter wheat closes 9/30/2025) resolve
// exactly like spring-SCD corn — the query never filters by sales-closing
// date, and closed windows display BOTH RMA finals.
describe('per-crop offer discovery across differing SCDs', () => {
  const wheatEntry = `
  <entry><content><m:properties>
    <d:CommodityYear m:type="Edm.Int32">2026</d:CommodityYear>
    <d:CommodityCode>0011</d:CommodityCode>
    <d:CommodityName>Wheat</d:CommodityName>
    <d:TypeCode m:type="Edm.Int32">2</d:TypeCode><d:TypeName>Winter</d:TypeName>
    <d:PracticeCode m:type="Edm.Int32">2</d:PracticeCode><d:PracticeName>Conventional</d:PracticeName>
    <d:StateCode>01</d:StateCode><d:StateName>Alabama</d:StateName>
    <d:SalesClosingDateDisplay>9/30/2025</d:SalesClosingDateDisplay>
    <d:ProjectedPrice m:type="Edm.Decimal">5.6300</d:ProjectedPrice>
    <d:ProjectedPriceStatus>Released</d:ProjectedPriceStatus>
    <d:ProjectedPriceBeginDate m:type="Edm.DateTime">2025-08-15T00:00:00</d:ProjectedPriceBeginDate>
    <d:ProjectedPriceEndDate m:type="Edm.DateTime">2025-09-14T00:00:00</d:ProjectedPriceEndDate>
    <d:HarvestPrice m:type="Edm.Decimal">5.9000</d:HarvestPrice>
    <d:HarvestPriceStatus>Released</d:HarvestPriceStatus>
    <d:HarvestPriceBeginDate m:type="Edm.DateTime">2026-06-01T00:00:00</d:HarvestPriceBeginDate>
    <d:HarvestPriceEndDate m:type="Edm.DateTime">2026-06-30T00:00:00</d:HarvestPriceEndDate>
    <d:ApprovedPriceVolatilityPercent m:type="Edm.Decimal">0.1900</d:ApprovedPriceVolatilityPercent>
    <d:HarvestPriceExchangeCode>CBOT</d:HarvestPriceExchangeCode>
    <d:HarvestPriceMarketSymbolCode>ZWN26</d:HarvestPriceMarketSymbolCode>
  </m:properties></content></entry>`
  const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${wheatEntry}</feed>`

  it('a fall-SCD winter-wheat offer parses and resolves (live-verified shape, SCD 9/30/2025)', () => {
    const rows = parseRmaRevenuePrices(feed)
    const chosen = pickPrimaryRow(rows)!
    expect(chosen.salesClosingDate).toBe('2025-09-30')
    expect(chosen.projectedStatus).toBe('released')
    expect(chosen.harvestStatus).toBe('released')
    expect(chosen.harvestMarketSymbol).toBe('ZWN26')
  })

  it('closed-window wheat: both RMA prices display as finals in the row model', () => {
    const rows = buildPriceDiscoveryRows({
      crops: [{ id: 'wheat', name: 'Wheat' }],
      plantings: [{ crop_id: 'wheat', season_year: 2026 }],
      policies: [], cropYear: 2026,
      rmaResults: [rma({
        crop_id: 'wheat', commodity_code: '0011',
        projected_price: 5.63, projected_status: 'released',
        harvest_price: 5.9, harvest_status: 'released',
        harvest_market_symbol: 'ZWN26',
        offer_identity: 'AL · Winter · Conventional · SCD 9/30/2025',
      })],
      estimates: [est({ crop_id: 'wheat', price: 5.63, source: 'RMA final', price_date: '2025-09-14' })],
      keepManualProjected: new Set(), liveQuotes: new Map(),
    })
    expect(rows[0].harvest).toMatchObject({ phase: 'post', price: 5.9, label: 'RMA final' })
    expect(rows[0].projected.resolution).toMatchObject({ price: 5.63, source: 'rma' })
    expect(rows[0].baseContract).toBe('ZWN26')
  })
})

describe('no-offer vs fetch-failure, properly distinguished', () => {
  it('fetch_failed keeps prior good data for that key and names a failure', () => {
    const prev = [rma({})]
    const failed = rma({ projected_price: null, harvest_price: null, fetch_failed: true })
    const m = mergeRmaResults(prev, { data: { results: [failed] } })
    expect(m.results[0].projected_price).toBe(4.42) // prior kept
    expect(m.error).toContain('could not be reached')
  })

  it('fetch_failed with NO prior shows the failed row (row model renders retry state), no silent hole', () => {
    const m = mergeRmaResults([], { data: { results: [rma({ fetch_failed: true, projected_price: null, harvest_price: null })] } })
    expect(m.results).toHaveLength(1)
    expect(m.results[0].fetch_failed).toBe(true)
    const rows = buildPriceDiscoveryRows({
      ...BASE, plantings: [{ crop_id: 'corn', season_year: 2026 }], policies: [],
      rmaResults: m.results,
    })
    expect(rows[0].fetchFailed).toBe(true)
    expect(rows[0].noOffer).toBe(false)
    expect(rows[0].harvest.phase).toBe('pre') // estimate tier still applies
  })

  it('a genuine no-offer row raises NO failure error and renders the calm state', () => {
    const m = mergeRmaResults([], { data: { results: [rma({ no_offer: true, projected_price: null, harvest_price: null, harvest_status: null, offer_identity: null })] } })
    expect(m.error).toBeNull()
    const rows = buildPriceDiscoveryRows({
      ...BASE, plantings: [{ crop_id: 'corn', season_year: 2026 }], policies: [],
      rmaResults: m.results,
    })
    expect(rows[0].noOffer).toBe(true)
    expect(rows[0].fetchFailed).toBe(false)
  })
})

describe('base-contract persistence through the cache path', () => {
  it('a cached offer with a null symbol flags for backfill; populated rows do not', () => {
    expect(rmaCacheMissingContracts([{ harvestMarketSymbol: null }, { harvestMarketSymbol: 'ZCU26' }])).toBe(true)
    expect(rmaCacheMissingContracts([{ harvestMarketSymbol: 'ZCU26' }])).toBe(false)
    expect(rmaCacheMissingContracts([])).toBe(false) // empty cache is a plain miss, not a backfill
  })
})

describe('Claims Monitor tier chips match the settings vocabulary', () => {
  it('every tier maps to the shared label + class', () => {
    expect(harvestTierLabel({ isFinal: true, rmaFinal: true, source: 'final' })).toMatchObject({ text: 'RMA final' })
    expect(harvestTierLabel({ isFinal: true, source: 'final' })).toMatchObject({ text: 'manual final' })
    expect(harvestTierLabel({ isFinal: false, source: 'rma_discovery', rmaLabel: 'RMA discovery avg through 8/14/2026 (day 14 of 31)' }).text)
      .toContain('day 14 of 31')
    expect(harvestTierLabel({ isFinal: false, source: 'estimate', contractLabel: 'ZCU26' })).toMatchObject({ text: 'est. — ZCU26 today' })
    expect(harvestTierLabel({ isFinal: false, source: 'projected' })).toMatchObject({ text: 'projected' })
    expect(harvestTierLabel(null).text).toBe('—')
  })
})

// Winter crops (CEPP ground truth): AL wheat = type Winter, ZWN base contract,
// SCD 9/30, projected window 8/15-9/14 of the PRE-harvest year, harvest window
// 6/1-6/30 of the harvest year - both Released for CY2026.
describe('winter-crop typing and prior-year windows', () => {
  const winter = rma({
    crop_id: 'wheat', commodity_code: '0011',
    projected_price: 5.63, projected_status: 'released',
    projected_begin_date: '2025-08-15', projected_end_date: '2025-09-14',
    harvest_price: 5.9, harvest_status: 'released',
    harvest_begin_date: '2026-06-01', harvest_end_date: '2026-06-30',
    harvest_market_symbol: 'ZWN26',
    offer_identity: 'AL · Winter · Conventional · SCD 9/30/2025',
  })

  it('a CY2026 projected window ending 9/14/2025 is RELEASED — phase never computed from dates', () => {
    // The status is RMA's own; a prior-calendar-year window must never read
    // as "yet to start" just because its dates precede the commodity year.
    const rows = buildPriceDiscoveryRows({
      crops: [{ id: 'wheat', name: 'Wheat' }],
      plantings: [{ crop_id: 'wheat', season_year: 2026 }],
      policies: [], cropYear: 2026,
      rmaResults: [winter],
      estimates: [est({ crop_id: 'wheat', price: 5.63, source: 'RMA final', price_date: '2025-09-14' })],
      keepManualProjected: new Set(), liveQuotes: new Map(),
    })
    expect(rows[0].projected.resolution).toMatchObject({ price: 5.63, source: 'rma' })
    expect(rows[0].projected.windowLabel).toBe('8/15/2025-9/14/2025'.replace('-', '–'))
    expect(rows[0].harvest).toMatchObject({ phase: 'post', price: 5.9, label: 'RMA final' })
    expect(rows[0].baseContract).toBe('ZWN26')
  })
})
