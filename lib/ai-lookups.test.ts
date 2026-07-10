import { describe, it, expect } from 'vitest'
import {
  parseArcBenchmarkRequest, normalizeArcBenchmarkResult,
  parseMyaMonthlyRequest, normalizeMyaMonthlyResult,
  elapsedMarketingMonths, monthKey,
  defaultConfirmedMonths, planMonthlySaves,
  blendSeedCottonMonth, normalizeSeedCottonMonthlyResult,
} from './ai-lookups'

// ---------- ARC benchmark lookup request: county + state both required ----------

describe('parseArcBenchmarkRequest', () => {
  it('accepts a full county + state request and carries county_id through', () => {
    const r = parseArcBenchmarkRequest({ commodity: 'Corn', county: 'Lawrence', state: 'Alabama', county_id: 'cid-1', crop_year: 2026 })
    expect(r).toEqual({ ok: true, value: { commodity: 'Corn', county: 'Lawrence', state: 'Alabama', countyId: 'cid-1', cropYear: 2026 } })
  })
  it('rejects a request without state — county names repeat across states', () => {
    const r = parseArcBenchmarkRequest({ commodity: 'Corn', county: 'Washington', crop_year: 2026 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/state is required/i)
  })
  it('rejects an empty/whitespace state the same way', () => {
    const r = parseArcBenchmarkRequest({ commodity: 'Corn', county: 'Washington', state: '  ', crop_year: 2026 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/state is required/i)
  })
  it('rejects missing commodity, county, or crop_year', () => {
    expect(parseArcBenchmarkRequest({ county: 'Lee', state: 'MS', crop_year: 2026 }).ok).toBe(false)
    expect(parseArcBenchmarkRequest({ commodity: 'Corn', state: 'MS', crop_year: 2026 }).ok).toBe(false)
    expect(parseArcBenchmarkRequest({ commodity: 'Corn', county: 'Lee', state: 'MS', crop_year: 'soon' }).ok).toBe(false)
    expect(parseArcBenchmarkRequest(null).ok).toBe(false)
  })
  it('county_id is optional', () => {
    const r = parseArcBenchmarkRequest({ commodity: 'Corn', county: 'Lee', state: 'Mississippi', crop_year: 2026 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.countyId).toBeNull()
  })
})

describe('normalizeArcBenchmarkResult', () => {
  it('keeps a source_description that already names the county', () => {
    const r = normalizeArcBenchmarkResult(
      { benchmark_yield: 185, benchmark_price: 5.03, source_description: 'FSA ARC/PLC data for Lawrence County, Alabama.', confidence: 'high' },
      { county: 'Lawrence', state: 'Alabama' },
    )
    expect(r.source_description).toBe('FSA ARC/PLC data for Lawrence County, Alabama.')
    expect(r.confidence).toBe('high')
  })
  it('prepends the county + state when the model left it out, so the user can verify the match', () => {
    const r = normalizeArcBenchmarkResult(
      { benchmark_yield: 185, source_description: 'From the FSA benchmark file.' },
      { county: 'Washington', state: 'Arkansas' },
    )
    expect(r.source_description).toBe('Washington County, Arkansas: From the FSA benchmark file.')
  })
  it('nulls non-numeric values and defaults confidence to low', () => {
    const r = normalizeArcBenchmarkResult({ benchmark_yield: 'about 185', benchmark_price: NaN }, { county: 'Lee', state: 'MS' })
    expect(r.benchmark_yield).toBeNull()
    expect(r.benchmark_price).toBeNull()
    expect(r.data_year).toBeNull()
    expect(r.confidence).toBe('low')
  })

  // Most-recent-available-year fallback: when the requested crop year isn't
  // published yet, the model reports the latest year it found via data_year.
  describe('data_year (most recent available crop year)', () => {
    it('passes the data year through and leaves the description alone when it names the year', () => {
      const r = normalizeArcBenchmarkResult(
        { benchmark_yield: 182, data_year: 2024, source_description: 'FSA 2024 ARC-CO file for Lee County, Mississippi (2025 not yet published).' },
        { county: 'Lee', state: 'Mississippi', cropYear: 2025 },
      )
      expect(r.data_year).toBe(2024)
      expect(r.source_description).toBe('FSA 2024 ARC-CO file for Lee County, Mississippi (2025 not yet published).')
    })
    it('prepends the fallback-year note when the model reported a prior year but left it out of the description', () => {
      const r = normalizeArcBenchmarkResult(
        { benchmark_yield: 182, data_year: 2024, source_description: 'FSA ARC/PLC data for Lee County, Mississippi.' },
        { county: 'Lee', state: 'Mississippi', cropYear: 2025 },
      )
      expect(r.source_description).toBe('2024 data (most recent available — 2025 not yet published): FSA ARC/PLC data for Lee County, Mississippi.')
    })
    it('no year note when the data is for the requested year', () => {
      const r = normalizeArcBenchmarkResult(
        { benchmark_yield: 182, data_year: 2025, source_description: 'FSA data for Lee County, Mississippi.' },
        { county: 'Lee', state: 'Mississippi', cropYear: 2025 },
      )
      expect(r.data_year).toBe(2025)
      expect(r.source_description).toBe('FSA data for Lee County, Mississippi.')
    })
    it('rejects garbage data years', () => {
      expect(normalizeArcBenchmarkResult({ data_year: 'last year' }, { county: 'Lee', state: 'MS', cropYear: 2025 }).data_year).toBeNull()
      expect(normalizeArcBenchmarkResult({ data_year: 24 }, { county: 'Lee', state: 'MS', cropYear: 2025 }).data_year).toBeNull()
      expect(normalizeArcBenchmarkResult({ data_year: 2024.5 }, { county: 'Lee', state: 'MS', cropYear: 2025 }).data_year).toBeNull()
    })
  })
})

// ---------- MYA monthly lookup ----------

describe('parseMyaMonthlyRequest', () => {
  it('accepts commodity + marketing year with wheat start month', () => {
    const r = parseMyaMonthlyRequest({ commodity: 'Wheat', marketing_year: 2026, start_month: 6, unit: 'bushel' })
    expect(r).toEqual({
      ok: true,
      value: {
        commodity: 'Wheat', marketingYear: 2026, startMonth: 6, unit: 'bushel',
        seedCotton: false, lintShare: 0.43, seedShare: 0.57,
      },
    })
  })
  it('flags seed cotton and honors configured shares (defaulting 43/57)', () => {
    const r = parseMyaMonthlyRequest({ commodity: 'Seed Cotton', marketing_year: 2025, start_month: 8, unit: 'pound', lint_share: 0.45, seed_share: 0.55 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.seedCotton).toBe(true)
      expect(r.value.lintShare).toBe(0.45)
      expect(r.value.seedShare).toBe(0.55)
    }
    const bad = parseMyaMonthlyRequest({ commodity: 'Seed Cotton', marketing_year: 2025, lint_share: -1, seed_share: 'x' })
    expect(bad.ok).toBe(true)
    if (bad.ok) {
      expect(bad.value.lintShare).toBe(0.43)
      expect(bad.value.seedShare).toBe(0.57)
    }
  })
  it('defaults start_month to 9 (corn/soy) and unit to bushel', () => {
    const r = parseMyaMonthlyRequest({ commodity: 'Corn', marketing_year: 2025 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.startMonth).toBe(9)
      expect(r.value.unit).toBe('bushel')
    }
  })
  it('rejects missing commodity/marketing_year and out-of-range start months', () => {
    expect(parseMyaMonthlyRequest({ marketing_year: 2025 }).ok).toBe(false)
    expect(parseMyaMonthlyRequest({ commodity: 'Corn' }).ok).toBe(false)
    expect(parseMyaMonthlyRequest({ commodity: 'Corn', marketing_year: 2025, start_month: 13 }).ok).toBe(false)
    expect(parseMyaMonthlyRequest({ commodity: 'Corn', marketing_year: 2025, start_month: 0 }).ok).toBe(false)
  })
})

describe('elapsedMarketingMonths', () => {
  it('corn 2025 (Sep 2025–Aug 2026) as of Jul 9 2026 → Sep..Jul, 11 months', () => {
    const m = elapsedMarketingMonths(9, 2025, new Date(2026, 6, 9))
    expect(m).toHaveLength(11)
    expect(monthKey(m[0])).toBe('2025-09')
    expect(monthKey(m[10])).toBe('2026-07')
  })
  it('wheat 2026 (Jun 2026–May 2027) as of Jul 9 2026 → Jun and Jul only', () => {
    const m = elapsedMarketingMonths(6, 2026, new Date(2026, 6, 9))
    expect(m.map(monthKey)).toEqual(['2026-06', '2026-07'])
  })
  it('empty when the marketing year has not started', () => {
    expect(elapsedMarketingMonths(9, 2026, new Date(2026, 6, 9))).toHaveLength(0)
  })
})

describe('normalizeMyaMonthlyResult', () => {
  const raw = {
    commodity: 'Corn',
    marketing_year: 2025,
    monthly_prices: [
      { month: '2025-09', price: 4.12, status: 'published' },
      { month: '2025-10', price: 4.05, status: 'published' },
      { month: '2026-03', price: null, status: 'not_yet_published' },
      { month: '2025-08', price: 3.99, status: 'published' }, // Aug 2025 = PRIOR marketing year
      { month: '2026-09', price: 4.5, status: 'published' }, // Sep 2026 = NEXT marketing year
      { month: 'March', price: 4.2 }, // malformed month
      { month: '2025-11', price: -1 }, // negative price → not published
    ],
    source_description: 'USDA NASS Agricultural Prices, May 2026 release',
    confidence: 'high',
  }
  const r = normalizeMyaMonthlyResult(raw, 9, 2025)

  it('accepts only months inside the marketing-year window (corn: Sep 2025–Aug 2026)', () => {
    expect(r.monthly_prices.map((m) => m.key)).toEqual(['2025-09', '2025-10', '2025-11', '2026-03'])
  })
  it('maps to calendar month/year and forces status from the price', () => {
    expect(r.monthly_prices[0]).toEqual({ month: 9, year: 2025, key: '2025-09', price: 4.12, status: 'published', note: null, components: null })
    expect(r.monthly_prices.find((m) => m.key === '2026-03')).toMatchObject({ price: null, status: 'not_yet_published' })
    // a negative "price" is not a price
    expect(r.monthly_prices.find((m) => m.key === '2025-11')).toMatchObject({ price: null, status: 'not_yet_published' })
  })
  it('passes through source_description and confidence', () => {
    expect(r.source_description).toBe('USDA NASS Agricultural Prices, May 2026 release')
    expect(r.confidence).toBe('high')
  })
  it('tolerates garbage input', () => {
    const g = normalizeMyaMonthlyResult({ monthly_prices: 'nope' }, 9, 2025)
    expect(g.monthly_prices).toEqual([])
    expect(g.confidence).toBe('low')
  })
})

// ---------- Merge: AI months into a table with existing manual entries ----------

describe('defaultConfirmedMonths', () => {
  it('pre-checks published months without an existing entry; existing months start unchecked', () => {
    const fetched = [
      { month: 9, price: 4.12 },
      { month: 10, price: 4.05 }, // already entered → unchecked
      { month: 11, price: null }, // not published → never confirmable
    ]
    expect(defaultConfirmedMonths(fetched, new Set([10]))).toEqual(new Set([9]))
  })
})

describe('planMonthlySaves', () => {
  const fetched = [
    { month: 9, price: 4.12 },
    { month: 10, price: 4.05 },
    { month: 11, price: null },
  ]
  it('manual wins unless explicitly confirmed: unconfirmed months are not saved', () => {
    expect(planMonthlySaves({ fetched, confirmed: new Set([9]) })).toEqual([
      { month: 9, price: 4.12, source: 'ai', note: null },
    ])
  })
  it('null (not-yet-published) months are ignored even if somehow confirmed', () => {
    expect(planMonthlySaves({ fetched, confirmed: new Set([11]) })).toEqual([])
  })
  it('a confirmed month the user explicitly checked overwrites — with source ai', () => {
    expect(planMonthlySaves({ fetched, confirmed: new Set([9, 10]) })).toEqual([
      { month: 9, price: 4.12, source: 'ai', note: null },
      { month: 10, price: 4.05, source: 'ai', note: null },
    ])
  })
  it('a confirmed AI value the user edited saves as manual with the edited price', () => {
    expect(planMonthlySaves({ fetched, confirmed: new Set([9]), edited: new Map([[9, 4.2]]) })).toEqual([
      { month: 9, price: 4.2, source: 'manual', note: null },
    ])
  })
  it('an edit equal to the fetched value stays source ai; invalid edits are ignored', () => {
    expect(planMonthlySaves({ fetched, confirmed: new Set([9]), edited: new Map([[9, 4.12]]) })).toEqual([
      { month: 9, price: 4.12, source: 'ai', note: null },
    ])
    expect(planMonthlySaves({ fetched, confirmed: new Set([9]), edited: new Map([[9, -2]]) })).toEqual([
      { month: 9, price: 4.12, source: 'ai', note: null },
    ])
  })
  it('a derived (seed cotton) month keeps its component note; an edit drops it', () => {
    const sc = [{ month: 9, price: 0.351685, note: 'lint 68.2¢ + seed $205/ton → 35.17¢ SC' }]
    expect(planMonthlySaves({ fetched: sc, confirmed: new Set([9]) })).toEqual([
      { month: 9, price: 0.351685, source: 'ai', note: 'lint 68.2¢ + seed $205/ton → 35.17¢ SC' },
    ])
    expect(planMonthlySaves({ fetched: sc, confirmed: new Set([9]), edited: new Map([[9, 0.36]]) })).toEqual([
      { month: 9, price: 0.36, source: 'manual', note: null },
    ])
  })
})

// ---------- Seed cotton: blend the two NASS series in code ----------

describe('seed cotton monthly blend', () => {
  it('worked example: lint 68.2¢/lb + cottonseed $205/ton at 43/57', () => {
    // By hand: 0.43 × $0.682 = $0.29326; $205/ton ÷ 2000 = $0.1025/lb;
    // 0.57 × $0.1025 = $0.058425; total $0.351685/lb = 35.17¢/lb.
    const { price, note } = blendSeedCottonMonth(68.2, 205)
    expect(price).toBe(0.351685)
    expect(note).toBe('lint 68.2¢ + seed $205/ton → 35.17¢ SC')
  })

  it('honors configured shares', () => {
    const { price } = blendSeedCottonMonth(68.2, 205, { lintShare: 0.45, seedShare: 0.55 })
    expect(price).toBe(Math.round((0.45 * 0.682 + 0.55 * 0.1025) * 1e6) / 1e6)
  })

  it('requires BOTH components: a lint-only month is not_yet_published, never a lint-only blend', () => {
    const raw = {
      monthly_prices: [
        { month: '2025-08', lint_cents_per_lb: 68.2, cottonseed_dollars_per_ton: 205 },
        { month: '2025-09', lint_cents_per_lb: 66.9, cottonseed_dollars_per_ton: null }, // seed not out yet
        { month: '2025-10', lint_cents_per_lb: null, cottonseed_dollars_per_ton: 210 }, // lint not out yet
        { month: '2025-11', lint_cents_per_lb: null, cottonseed_dollars_per_ton: null },
      ],
      source_description: 'USDA NASS Agricultural Prices',
      confidence: 'high',
    }
    // Seed cotton marketing year starts in August.
    const r = normalizeSeedCottonMonthlyResult(raw, 8, 2025)
    const aug = r.monthly_prices.find((m) => m.key === '2025-08')!
    expect(aug.status).toBe('published')
    expect(aug.price).toBe(0.351685)
    expect(aug.note).toBe('lint 68.2¢ + seed $205/ton → 35.17¢ SC')
    expect(aug.components).toEqual({ lint_cents_per_lb: 68.2, cottonseed_dollars_per_ton: 205 })
    for (const key of ['2025-09', '2025-10', '2025-11']) {
      expect(r.monthly_prices.find((m) => m.key === key)).toMatchObject({ price: null, status: 'not_yet_published', note: null })
    }
  })

  it('only accepts months inside the marketing year and tolerates garbage', () => {
    const r = normalizeSeedCottonMonthlyResult({
      monthly_prices: [
        { month: '2025-07', lint_cents_per_lb: 70, cottonseed_dollars_per_ton: 200 }, // before the MY window
        { month: 'bogus', lint_cents_per_lb: 70, cottonseed_dollars_per_ton: 200 },
        { month: '2025-08', lint_cents_per_lb: -5, cottonseed_dollars_per_ton: 200 }, // negative lint → unusable
      ],
    }, 8, 2025)
    expect(r.monthly_prices.map((m) => m.key)).toEqual(['2025-08'])
    expect(r.monthly_prices[0].status).toBe('not_yet_published')
    expect(r.confidence).toBe('low')
  })
})
