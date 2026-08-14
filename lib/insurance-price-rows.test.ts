import { describe, it, expect } from 'vitest'
import { harvestPhase, mergeRmaResults, type RmaLookupResult } from '@/lib/rma-price-discovery'
import { buildPriceDiscoveryRows } from '@/lib/insurance-price-rows'
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
