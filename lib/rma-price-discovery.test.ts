import { describe, it, expect } from 'vitest'
import {
  parseRmaRevenuePrices, pickPrimaryRow, rmaCommodityCode, stateFips,
  windowState, rmaSourceLabel, resolveTieredPrice, rmaCacheIsStale, rmaServiceUrl,
  offerIdentityLabel,
} from '@/lib/rma-price-discovery'
import { resolveHarvestPriceByCrop, resolveProjectedPrice, rmaToAppInsurancePrice } from '@/lib/crop-insurance'
import type { CropInsurancePolicy, HarvestPriceEstimate } from '@/lib/types'

// RMA Price Discovery: Atom parsing, state-keyed window facts, and the tier
// ladder (RMA final > manual > RMA running > Barchart estimate) — including
// the supersede-notice inversion and the Income Sensitivity pinning ride.

// A trimmed but structurally-faithful slice of the live service response
// (fields verified against the .svc $metadata on 2026-08-14).
const entry = (over: Partial<Record<string, string>>) => `
  <entry>
    <id>https://public-rma.fpac.usda.gov/.../RevenuePrices('x')</id>
    <content type="application/xml"><m:properties>
      <d:CommodityYear m:type="Edm.Int32">${over.year ?? '2026'}</d:CommodityYear>
      <d:CommodityCode>${over.code ?? '0041'}</d:CommodityCode>
      <d:CommodityName>${over.name ?? 'Corn'}</d:CommodityName>
      <d:TypeCode m:type="Edm.Int32">16</d:TypeCode>
      <d:TypeName>${over.type ?? 'All (Non-High Amylose)'}</d:TypeName>
      <d:PracticeCode m:type="Edm.Int32">3</d:PracticeCode>
      <d:PracticeName>${over.practice ?? 'Conventional'}</d:PracticeName>
      <d:StateCode>${over.state ?? '01'}</d:StateCode>
      <d:StateName>${over.stateName ?? 'Alabama'}</d:StateName>
      <d:SalesClosingDateDisplay>2/28/2026</d:SalesClosingDateDisplay>
      <d:ProjectedPrice m:type="Edm.Decimal">${over.projected ?? '4.4200'}</d:ProjectedPrice>
      <d:ProjectedPriceStatus>${over.projStatus ?? 'Released'}</d:ProjectedPriceStatus>
      <d:ProjectedPriceBeginDate m:type="Edm.DateTime">${over.projBegin ?? '2026-01-15T00:00:00'}</d:ProjectedPriceBeginDate>
      <d:ProjectedPriceEndDate m:type="Edm.DateTime">${over.projEnd ?? '2026-02-14T00:00:00'}</d:ProjectedPriceEndDate>
      <d:HarvestPrice m:type="Edm.Decimal">${over.harvest ?? '4.4200'}</d:HarvestPrice>
      <d:HarvestPriceStatus>${over.harvStatus ?? 'In Discovery'}</d:HarvestPriceStatus>
      <d:HarvestPriceBeginDate m:type="Edm.DateTime">${over.harvBegin ?? '2026-08-01T00:00:00'}</d:HarvestPriceBeginDate>
      <d:HarvestPriceEndDate m:type="Edm.DateTime">${over.harvEnd ?? '2026-08-31T00:00:00'}</d:HarvestPriceEndDate>
      <d:ApprovedPriceVolatilityPercent m:type="Edm.Decimal">0.1400</d:ApprovedPriceVolatilityPercent>
      <d:ProjectedPriceExchangeCode>${over.exchange ?? 'CBOT'}</d:ProjectedPriceExchangeCode>
      <d:ProjectedPriceMarketSymbolCode>${over.symbol ?? 'ZCU26'}</d:ProjectedPriceMarketSymbolCode>
      <d:HarvestPriceExchangeCode>${over.exchange ?? 'CBOT'}</d:HarvestPriceExchangeCode>
      <d:HarvestPriceMarketSymbolCode>${over.symbol ?? 'ZCU26'}</d:HarvestPriceMarketSymbolCode>
    </m:properties></content>
  </entry>`

const feed = (...entries: string[]) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`

describe('parseRmaRevenuePrices', () => {
  it('extracts prices, statuses, windows, and volatility from the Atom shape', () => {
    const rows = parseRmaRevenuePrices(feed(entry({})))
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.commodityYear).toBe(2026)
    expect(r.commodityCode).toBe('0041')
    expect(r.stateCode).toBe('01')
    expect(r.projectedPrice).toBe(4.42)
    expect(r.projectedStatus).toBe('released')
    expect(r.projectedBeginDate).toBe('2026-01-15')
    expect(r.projectedEndDate).toBe('2026-02-14')
    expect(r.harvestStatus).toBe('in_discovery')
    expect(r.volatility).toBe(0.14)
  })

  it('throws loudly on a non-Atom or key-less response (the FSA-workbook lesson)', () => {
    expect(() => parseRmaRevenuePrices('<html>maintenance</html>')).toThrow(/non-Atom/)
    expect(() => parseRmaRevenuePrices(feed('<entry><content></content></entry>'))).toThrow(/missing its commodity\/state key/)
  })

  it('AL vs IL corn resolve DIFFERENT windows from the same feed — state keying, never a national calendar', () => {
    const rows = parseRmaRevenuePrices(feed(
      entry({}), // Alabama: Jan 15 – Feb 14
      entry({ state: '17', stateName: 'Illinois', projected: '4.5800', projBegin: '2026-02-01T00:00:00', projEnd: '2026-02-28T00:00:00' }),
    ))
    const al = rows.find((r) => r.stateCode === '01')!
    const il = rows.find((r) => r.stateCode === '17')!
    expect(al.projectedEndDate).toBe('2026-02-14')
    expect(il.projectedEndDate).toBe('2026-02-28')
    expect(al.projectedPrice).not.toBe(il.projectedPrice)
  })
})

describe('pickPrimaryRow', () => {
  it('prefers Conventional practice and the catch-all type', () => {
    const rows = parseRmaRevenuePrices(feed(
      entry({ practice: 'Organic', projected: '5.0000' }),
      entry({ projected: '4.4200' }),
    ))
    expect(pickPrimaryRow(rows)?.projectedPrice).toBe(4.42)
  })

  it('no rows → null (the route renders "no RMA offer", never a blank)', () => {
    expect(pickPrimaryRow([])).toBeNull()
  })
})

// The portal ground truth for AL · Conventional · SCD 2/28/2026 · Corn 2026
// (verified live 2026-08-14): projected $4.42 Released (1/15–2/14), harvest In
// Discovery 8/1–8/31, volatility 0.14, base contract ZCU26 (September — NOT
// the Midwest DEC assumption). The app showed the $4.62 seed instead.
describe('the Alabama corn case, end-to-end', () => {
  const AL_ROWS = parseRmaRevenuePrices(feed(entry({}), entry({ practice: 'Organic', projected: '4.6800' })))
  const chosen = pickPrimaryRow(AL_ROWS)!

  it('the offer carries its own base contract: ZCU26 / CBOT, both windows', () => {
    expect(chosen.projectedMarketSymbol).toBe('ZCU26')
    expect(chosen.harvestMarketSymbol).toBe('ZCU26')
    expect(chosen.harvestExchangeCode).toBe('CBOT')
    expect(offerIdentityLabel({ ...chosen, stateAbbr: 'AL' })).toBe('AL · All (Non-High Amylose) · Conventional · SCD 2/28/2026')
  })

  it('harvest is in discovery in August (8/1–8/31), day-of-window correct', () => {
    const ws = windowState({ status: chosen.harvestStatus, beginDate: chosen.harvestBeginDate, endDate: chosen.harvestEndDate, today: '2026-08-14' })!
    expect(ws.status).toBe('in_discovery')
    expect(ws.dayOfWindow).toBe(14)
    expect(ws.windowDays).toBe(31)
  })

  it('the RMA $4.42 outranks the seeded $4.62 — silently (seeds get no notice)', () => {
    const estimates: HarvestPriceEstimate[] = [
      // The 024 seed: dated 02-28, LATER than AL's window end — under the old
      // latest-date rule it always won. Relabeled source='seed' by 065.
      { id: 's', crop_id: 'corn', crop_year: 2026, price_type: 'projected', price: 4.62, source: 'seed', price_date: '2026-02-28', created_at: '' } as HarvestPriceEstimate,
      { id: 'r', crop_id: 'corn', crop_year: 2026, price_type: 'projected', price: 4.42, source: 'RMA final', price_date: '2026-02-14', created_at: '' } as HarvestPriceEstimate,
    ]
    const res = resolveProjectedPrice(estimates, 'corn', 2026)!
    expect(res).toMatchObject({ price: 4.42, source: 'rma', superseded: null, supersededSource: null })
  })

  it('a user-typed manual value: superseded with notice by default, kept via keepManual', () => {
    const estimates: HarvestPriceEstimate[] = [
      { id: 'm', crop_id: 'corn', crop_year: 2026, price_type: 'projected', price: 4.55, source: 'manual', price_date: '2026-03-01', created_at: '' } as HarvestPriceEstimate,
      { id: 'r', crop_id: 'corn', crop_year: 2026, price_type: 'projected', price: 4.42, source: 'RMA final', price_date: '2026-02-14', created_at: '' } as HarvestPriceEstimate,
    ]
    expect(resolveProjectedPrice(estimates, 'corn', 2026)!).toMatchObject({ price: 4.42, source: 'rma', superseded: 4.55, supersededSource: 'manual' })
    expect(resolveProjectedPrice(estimates, 'corn', 2026, { keepManual: true })!).toMatchObject({ price: 4.55, source: 'manual' })
  })

  it('seed alone (no RMA yet) still resolves — labeled as the seed it is', () => {
    const estimates: HarvestPriceEstimate[] = [
      { id: 's', crop_id: 'corn', crop_year: 2026, price_type: 'projected', price: 4.62, source: 'seed', price_date: '2026-02-28', created_at: '' } as HarvestPriceEstimate,
    ]
    expect(resolveProjectedPrice(estimates, 'corn', 2026)!).toMatchObject({ price: 4.62, source: 'seed', superseded: null })
  })
})

describe('unit boundary (the cotton-unit-bug lesson)', () => {
  it('canola: RMA $/lb × 50 = the app’s $/bu — hand-verified 0.226 → 11.30', () => {
    expect(rmaToAppInsurancePrice('Canola', 0.226)).toBeCloseTo(11.3, 10)
  })
  it('cotton and grains pass through ($/lb and $/bu native both sides)', () => {
    expect(rmaToAppInsurancePrice('Cotton', 0.69)).toBe(0.69)
    expect(rmaToAppInsurancePrice('Corn', 4.42)).toBe(4.42)
  })
  it('cotton (0021) and canola (0015) are in the commodity map — codes confirmed from the service’s own AL feed', () => {
    expect(rmaCommodityCode('Cotton')).toBe('0021')
    expect(rmaCommodityCode('Canola')).toBe('0015')
  })
})

describe('codes and window state', () => {
  it('maps app crop names and states', () => {
    expect(rmaCommodityCode('Corn')).toBe('0041')
    expect(rmaCommodityCode('Cotton')).toBe('0021')
    expect(rmaCommodityCode('Grain Sorghum (Milo)')).toBe('0051')
    expect(rmaCommodityCode('Alfalfa')).toBeNull()
    expect(stateFips('ga')).toBe('13')
    expect(stateFips('AL')).toBe('01')
  })

  it('classifies windows with a clamped day-of-window', () => {
    const ws = windowState({ status: 'in_discovery', beginDate: '2026-08-01', endDate: '2026-08-31', today: '2026-08-12' })
    expect(ws).toEqual({ status: 'in_discovery', dayOfWindow: 12, windowDays: 31 })
    // Clock skew can't escape the window.
    expect(windowState({ status: 'in_discovery', beginDate: '2026-08-01', endDate: '2026-08-31', today: '2026-09-02' })!.dayOfWindow).toBe(31)
    expect(windowState({ status: 'released', beginDate: '2026-08-01', endDate: '2026-08-31' })).toEqual({ status: 'released', dayOfWindow: null, windowDays: null })
  })

  it('labels each tier the way the UI shows it', () => {
    expect(rmaSourceLabel({ status: 'released' })).toBe('RMA final')
    expect(rmaSourceLabel({ status: 'in_discovery', dayOfWindow: 12, windowDays: 31, asOf: '2026-08-12' }))
      .toBe('RMA discovery avg through 8/12/2026 (day 12 of 31)')
    expect(rmaSourceLabel({ status: 'yet_to_start' })).toBe('RMA window not started')
  })
})

describe('resolveTieredPrice (the pure ladder)', () => {
  const rmaFinal = { price: 4.71, status: 'released' as const, label: 'RMA final' }
  const rmaRunning = { price: 4.42, status: 'in_discovery' as const, label: 'RMA discovery avg' }

  it('RMA final beats everything — and reports the manual it superseded', () => {
    const r = resolveTieredPrice({ rma: rmaFinal, manual: 4.65, estimate: 4.5 })!
    expect(r).toMatchObject({ price: 4.71, source: 'rma_final', supersededManual: 4.65 })
  })

  it('"keep mine" restores the manual over the final', () => {
    const r = resolveTieredPrice({ rma: rmaFinal, manual: 4.65, keepManual: true, estimate: 4.5 })!
    expect(r).toMatchObject({ price: 4.65, source: 'manual' })
  })

  it('below the final tier, manual outranks the running value and the estimate', () => {
    expect(resolveTieredPrice({ rma: rmaRunning, manual: 4.65, estimate: 4.5 })!.source).toBe('manual')
    expect(resolveTieredPrice({ rma: rmaRunning, manual: null, estimate: 4.5 })!).toMatchObject({ price: 4.42, source: 'rma_discovery' })
    expect(resolveTieredPrice({ rma: null, manual: null, estimate: 4.5 })!).toMatchObject({ price: 4.5, source: 'estimate' })
    expect(resolveTieredPrice({ rma: null, manual: null, estimate: null })).toBeNull()
  })
})

describe('cache staleness + service url', () => {
  it('daily while a window is open or pending, weekly once released', () => {
    const now = Date.parse('2026-08-14T12:00:00Z')
    const twoDaysOld = new Date(now - 2 * 86_400_000).toISOString()
    expect(rmaCacheIsStale({ fetchedAt: twoDaysOld, projectedStatus: 'released', harvestStatus: 'in_discovery', now })).toBe(true)
    expect(rmaCacheIsStale({ fetchedAt: twoDaysOld, projectedStatus: 'released', harvestStatus: 'released', now })).toBe(false)
    const eightDaysOld = new Date(now - 8 * 86_400_000).toISOString()
    expect(rmaCacheIsStale({ fetchedAt: eightDaysOld, projectedStatus: 'released', harvestStatus: 'released', now })).toBe(true)
  })

  it('builds the OData filter url', () => {
    const url = rmaServiceUrl({ commodityYear: 2026, commodityCode: '0041', stateFips: '01' })
    expect(url).toContain('RevenuePriceDataService.svc/RevenuePrices')
    expect(decodeURIComponent(url)).toContain("CommodityYear eq 2026 and CommodityCode eq '0041' and StateCode eq '01'")
  })
})

// The shared resolver's new tiers, as the Claims Monitor / Income Sensitivity
// consume them via harvest_price_estimates rows.
describe('resolveHarvestPriceByCrop with RMA tiers', () => {
  const policy = (over: Partial<CropInsurancePolicy>): CropInsurancePolicy => ({
    id: 'p1', crop_id: 'corn', crop_year: 2026, county_id: null, entity_id: null,
    plan_type: 'RP', practice: null, coverage_level: 0.8, unit_structure: null,
    aph_yield: 180, projected_price: 4.42, insured_acres: 100, premium_per_acre: null,
    total_premium: null, harvest_price: null, policy_number: null, volatility_factor: null,
    covers_all_planted_acres: null, expected_county_yield: null, expected_county_revenue: null,
    protection_factor: null, notes: null, created_at: '',
    ...over,
  } as unknown as CropInsurancePolicy)
  const est = (over: Partial<HarvestPriceEstimate>): HarvestPriceEstimate => ({
    id: 'e1', crop_id: 'corn', crop_year: 2026, price_type: 'harvest_estimate',
    price: 0, source: null, price_date: null, created_at: '',
    ...over,
  } as HarvestPriceEstimate)
  const now = new Date('2026-08-14T12:00:00Z')

  it('an RMA final (written by the route) outranks the manual policy final, with the supersede reported', () => {
    const r = resolveHarvestPriceByCrop({
      cropIds: ['corn'], cropYear: 2026,
      policies: [policy({ harvest_price: 4.65 })],
      estimates: [est({ price_type: 'harvest_final', price: 4.71, source: 'RMA final', price_date: '2026-08-31' })],
      now,
    }).get('corn')!
    expect(r).toMatchObject({ price: 4.71, source: 'final', rmaFinal: true, supersededManual: 4.65 })
  })

  it('keepManualCropIds restores the manual final', () => {
    const r = resolveHarvestPriceByCrop({
      cropIds: ['corn'], cropYear: 2026,
      policies: [policy({ harvest_price: 4.65 })],
      estimates: [est({ price_type: 'harvest_final', price: 4.71, source: 'RMA final', price_date: '2026-08-31' })],
      keepManualCropIds: new Set(['corn']),
      now,
    }).get('corn')!
    expect(r).toMatchObject({ price: 4.65, source: 'final' })
    expect(r.rmaFinal).toBeUndefined()
  })

  it('a fresh rma_discovery row outranks the live Barchart quote; a stale one falls through', () => {
    const fresh = resolveHarvestPriceByCrop({
      cropIds: ['corn'], cropYear: 2026, policies: [policy({})],
      estimates: [est({ source: 'rma_discovery', price: 4.42, price_date: '2026-08-13' })],
      liveByCrop: new Map([['corn', { price: 4.5, stale: false, priceDate: '2026-08-14' }]]),
      now,
    }).get('corn')!
    expect(fresh).toMatchObject({ price: 4.42, source: 'rma_discovery' })
    const stale = resolveHarvestPriceByCrop({
      cropIds: ['corn'], cropYear: 2026, policies: [policy({})],
      estimates: [est({ source: 'rma_discovery', price: 4.42, price_date: '2026-08-01' })],
      liveByCrop: new Map([['corn', { price: 4.5, stale: false, priceDate: '2026-08-14' }]]),
      now,
    }).get('corn')!
    expect(stale).toMatchObject({ price: 4.5, source: 'estimate' })
  })

  it('the Income Sensitivity pin rides the final tier: an RMA-written harvest_final resolves as source "final"', () => {
    // income-sensitivity-report keys its pinning off exactly this resolution
    // (a stored harvest_final row) — RMA feeding it changes the source, not
    // the pinning behavior.
    const r = resolveHarvestPriceByCrop({
      cropIds: ['corn'], cropYear: 2026, policies: [policy({})],
      estimates: [est({ price_type: 'harvest_final', price: 4.71, source: 'RMA final', price_date: '2026-08-31' })],
      now,
    }).get('corn')!
    expect(r.source).toBe('final')
    expect(r.price).toBe(4.71)
  })
})
