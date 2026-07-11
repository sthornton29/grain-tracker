import { describe, it, expect } from 'vitest'
import {
  parseNassValue, convertNassPrice, nassSeriesFor, monthFromReferencePeriod,
  extractMonthlyPrices, extractAnnualPrice, toLookupResult, blendSeedCottonMonthly,
  LINT_SERIES, COTTONSEED_SERIES,
  type NassRow,
} from './nass-quickstats'

const row = (year: number, period: string, value: string, unit: string, shortDesc = 'X - PRICE RECEIVED'): NassRow => ({
  year: String(year), reference_period_desc: period, Value: value, unit_desc: unit, short_desc: shortDesc,
})

describe('parseNassValue', () => {
  it('parses plain and comma-separated values; suppression codes → null', () => {
    expect(parseNassValue('4.12')).toBe(4.12)
    expect(parseNassValue('1,234.5')).toBe(1234.5)
    expect(parseNassValue('(NA)')).toBeNull()
    expect(parseNassValue('(D)')).toBeNull()
    expect(parseNassValue('(S)')).toBeNull()
    expect(parseNassValue('')).toBeNull()
    expect(parseNassValue('n/a-ish garbage')).toBeNull()
  })
})

describe('convertNassPrice — all unit conversions in one place', () => {
  it('sorghum $/CWT → $/bu at 56 lb/bu', () => {
    // $8.93/cwt = $0.0893/lb × 56 lb/bu = $5.0008/bu.
    expect(convertNassPrice(8.93, '$ / CWT', 'dollars_per_bushel', 56)).toBe(5.0008)
    // Without a lb/bu factor the conversion is undefined — never guessed.
    expect(convertNassPrice(8.93, '$ / CWT', 'dollars_per_bushel')).toBeNull()
  })
  it('$/BU passes through; wrong units refuse', () => {
    expect(convertNassPrice(4.12, '$ / BU', 'dollars_per_bushel')).toBe(4.12)
    expect(convertNassPrice(205, '$ / TON', 'dollars_per_bushel')).toBeNull()
    expect(convertNassPrice(4.12, 'BALES', 'dollars_per_bushel')).toBeNull()
  })
  it('peanuts ¢/lb → $/lb (and $/ton → $/lb)', () => {
    expect(convertNassPrice(26.4, '¢ / LB', 'dollars_per_lb')).toBe(0.264)
    expect(convertNassPrice(26.4, 'CENTS / LB', 'dollars_per_lb')).toBe(0.264)
    expect(convertNassPrice(528, '$ / TON', 'dollars_per_lb')).toBe(0.264)
  })
  it('lint to ¢/lb and cottonseed to $/ton', () => {
    expect(convertNassPrice(63.1, '¢ / LB', 'cents_per_lb')).toBe(63.1)
    expect(convertNassPrice(0.631, '$ / LB', 'cents_per_lb')).toBe(63.1)
    expect(convertNassPrice(208, '$ / TON', 'dollars_per_ton')).toBe(208)
    expect(convertNassPrice(10.4, '$ / CWT', 'dollars_per_ton')).toBe(208)
  })
})

describe('nassSeriesFor', () => {
  it('maps the covered commodities to their query + storage units', () => {
    expect(nassSeriesFor('Corn', 'bushel')).toMatchObject({ params: { commodity_desc: 'CORN' }, target: 'dollars_per_bushel' })
    expect(nassSeriesFor('Grain Sorghum', 'bushel')).toMatchObject({ params: { commodity_desc: 'SORGHUM' }, lbPerBushel: 56 })
    expect(nassSeriesFor('Peanuts', 'pound')).toMatchObject({ params: { commodity_desc: 'PEANUTS' }, target: 'dollars_per_lb' })
    expect(nassSeriesFor('Canola', 'bushel')).toMatchObject({ lbPerBushel: 50 })
    // Unknown commodities try their name with the configured storage unit.
    expect(nassSeriesFor('Sesame', 'pound')).toMatchObject({ params: { commodity_desc: 'SESAME' }, target: 'dollars_per_lb' })
    expect(LINT_SERIES.params).toMatchObject({ commodity_desc: 'COTTON', class_desc: 'UPLAND' })
    expect(COTTONSEED_SERIES.target).toBe('dollars_per_ton')
  })
})

describe('extractMonthlyPrices — month mapping into marketing-year windows', () => {
  it('corn Sep–Aug window: keeps only in-window months, maps abbrevs, drops NA', () => {
    const rows: NassRow[] = [
      row(2025, 'SEP', '4.12', '$ / BU'),
      row(2025, 'OCT', '4.05', '$ / BU'),
      row(2025, 'AUG', '3.99', '$ / BU'), // prior marketing year
      row(2026, 'SEP', '4.50', '$ / BU'), // next marketing year
      row(2025, 'NOV', '(NA)', '$ / BU'),
      row(2026, 'MAR', '4.31', '$ / BU'),
      row(2025, 'MARKETING YEAR', '4.20', '$ / BU'), // annual row — not a month
    ]
    const { prices } = extractMonthlyPrices(rows, { target: 'dollars_per_bushel' }, 9, 2025)
    expect(prices.map((p) => `${p.year}-${p.month}`)).toEqual(['2025-9', '2025-10', '2026-3'])
    expect(prices[0].price).toBe(4.12)
  })

  it('wheat Jun–May window: Jun/Jul of the crop year in; May of the crop year out', () => {
    const rows: NassRow[] = [
      row(2026, 'JUN', '5.20', '$ / BU'),
      row(2026, 'JUL', '5.10', '$ / BU'),
      row(2026, 'MAY', '5.40', '$ / BU'), // May 2026 = tail of the PRIOR wheat MY
      row(2027, 'MAY', '5.55', '$ / BU'), // May 2027 = tail of THIS MY — in
    ]
    const { prices } = extractMonthlyPrices(rows, { target: 'dollars_per_bushel' }, 6, 2026)
    expect(prices.map((p) => `${p.year}-${p.month}`)).toEqual(['2026-6', '2026-7', '2027-5'])
  })

  it('prefers the best-covered series when several come back (WHEAT vs WHEAT, WINTER)', () => {
    const all = 'WHEAT - PRICE RECEIVED, MEASURED IN $ / BU'
    const winter = 'WHEAT, WINTER - PRICE RECEIVED, MEASURED IN $ / BU'
    const rows: NassRow[] = [
      row(2026, 'JUN', '5.20', '$ / BU', all),
      row(2026, 'JUL', '5.10', '$ / BU', all),
      row(2026, 'JUN', '4.90', '$ / BU', winter),
    ]
    const { prices, seriesUsed } = extractMonthlyPrices(rows, { target: 'dollars_per_bushel' }, 6, 2026)
    expect(seriesUsed).toBe(all)
    expect(prices.map((p) => p.price)).toEqual([5.2, 5.1])
  })

  it('converts sorghum $/CWT rows into $/bu during extraction', () => {
    const rows: NassRow[] = [row(2025, 'SEP', '8.93', '$ / CWT')]
    const { prices } = extractMonthlyPrices(rows, { target: 'dollars_per_bushel', lbPerBushel: 56 }, 9, 2025)
    expect(prices[0].price).toBe(5.0008)
  })
})

describe('toLookupResult', () => {
  it('published months where data exists; elapsed months without data → not_yet_published', () => {
    const r = toLookupResult({
      prices: [{ month: 9, year: 2025, price: 4.12 }],
      elapsed: [{ month: 9, year: 2025 }, { month: 10, year: 2025 }],
      startMonth: 9,
      marketingYear: 2025,
      sourceDescription: 'NASS',
    })
    expect(r.monthly_prices).toHaveLength(2)
    expect(r.monthly_prices[0]).toMatchObject({ key: '2025-09', price: 4.12, status: 'published' })
    expect(r.monthly_prices[1]).toMatchObject({ key: '2025-10', price: null, status: 'not_yet_published' })
    expect(r.confidence).toBe('high')
  })
})

describe('seed cotton blend over NASS months (cottonseed ginning-season cadence)', () => {
  const elapsed = [
    { month: 8, year: 2025 }, { month: 9, year: 2025 }, { month: 10, year: 2025 },
    { month: 11, year: 2025 }, { month: 3, year: 2026 },
  ]

  it('hand-verified plain blend: lint 63.1¢ + seed $208/ton at 43/57', () => {
    // 0.43 × $0.631 = $0.27133; $208/ton ÷ 2000 = $0.104/lb; 0.57 × $0.104 =
    // $0.05928; total $0.33061/lb = 33.06¢/lb.
    const out = blendSeedCottonMonthly({
      lint: [{ month: 8, year: 2025, price: 63.1 }],
      seed: [{ month: 8, year: 2025, price: 208 }],
      elapsed: [{ month: 8, year: 2025 }],
    })
    expect(out[0].price).toBe(0.33061)
    expect(out[0].status).toBe('published')
    expect(out[0].note).toBe('lint 63.1¢ + seed $208/ton → 33.06¢ SC')
    expect(out[0].components).toEqual({ lint_cents_per_lb: 63.1, cottonseed_dollars_per_ton: 208 })
  })

  it('a lint month with cottonseed NA uses the season average of published seed months, labeled', () => {
    const out = blendSeedCottonMonthly({
      lint: [
        { month: 9, year: 2025, price: 63.1 },
        { month: 3, year: 2026, price: 65.0 }, // Mar: cottonseed not surveyed
      ],
      seed: [
        { month: 9, year: 2025, price: 204 },
        { month: 10, year: 2025, price: 212 }, // avg 208
      ],
      elapsed,
    })
    const mar = out.find((m) => m.key === '2026-03')!
    expect(mar.status).toBe('published')
    // 0.43 × 0.65 + 0.57 × (208/2000) = 0.2795 + 0.05928 = 0.33878
    expect(mar.price).toBe(0.33878)
    expect(mar.note).toContain('seed $208/ton (season avg)')
    // The September month with its own published seed price stays unlabeled.
    expect(out.find((m) => m.key === '2025-09')!.note).not.toContain('season avg')
  })

  it('no cottonseed at all yet: the prior-year annual stands in, labeled; without it the month waits', () => {
    const withAnnual = blendSeedCottonMonthly({
      lint: [{ month: 8, year: 2025, price: 63.1 }],
      seed: [],
      elapsed: [{ month: 8, year: 2025 }],
      priorYearSeedAnnual: 215,
    })
    expect(withAnnual[0].status).toBe('published')
    expect(withAnnual[0].note).toContain('seed $215/ton (prior-year annual)')

    const without = blendSeedCottonMonthly({
      lint: [{ month: 8, year: 2025, price: 63.1 }],
      seed: [],
      elapsed: [{ month: 8, year: 2025 }],
    })
    expect(without[0].status).toBe('not_yet_published')
    expect(without[0].price).toBeNull()
    expect(without[0].note).toContain('lint 63.1¢ published')
    expect(without[0].note).toContain('manually')
  })

  it('honors configured shares and never blends a month without a lint price', () => {
    const out = blendSeedCottonMonthly({
      lint: [{ month: 8, year: 2025, price: 63.1 }],
      seed: [{ month: 8, year: 2025, price: 208 }],
      elapsed: [{ month: 8, year: 2025 }, { month: 9, year: 2025 }],
      lintShare: 0.45, seedShare: 0.55,
    })
    expect(out[0].price).toBe(Math.round((0.45 * 0.631 + 0.55 * 0.104) * 1e6) / 1e6)
    expect(out[1]).toMatchObject({ key: '2025-09', price: null, status: 'not_yet_published', note: null })
  })
})

describe('extractAnnualPrice', () => {
  it('reads the MARKETING YEAR row in the target unit; months and NA ignored', () => {
    const rows: NassRow[] = [
      row(2024, 'SEP', '210', '$ / TON'),
      row(2024, 'MARKETING YEAR', '(NA)', '$ / TON'),
      row(2024, 'MARKETING YEAR', '215', '$ / TON'),
    ]
    expect(extractAnnualPrice(rows, 'dollars_per_ton')).toBe(215)
    expect(extractAnnualPrice([row(2024, 'SEP', '210', '$ / TON')], 'dollars_per_ton')).toBeNull()
  })
})

describe('monthFromReferencePeriod', () => {
  it('maps abbrevs and full names; annual/garbage → null', () => {
    expect(monthFromReferencePeriod('SEP')).toBe(9)
    expect(monthFromReferencePeriod('June')).toBe(6)
    expect(monthFromReferencePeriod('SEPTEMBER')).toBe(9)
    expect(monthFromReferencePeriod('MARKETING YEAR')).toBeNull()
    expect(monthFromReferencePeriod('YEAR')).toBeNull()
    expect(monthFromReferencePeriod('')).toBeNull()
  })
})
