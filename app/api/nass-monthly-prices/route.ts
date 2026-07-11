import { NextRequest, NextResponse } from 'next/server'
import { parseMyaMonthlyRequest, elapsedMarketingMonths, type MyaMonthlyLookupResult } from '@/lib/ai-lookups'
import {
  nassSeriesFor, LINT_SERIES, COTTONSEED_SERIES,
  extractMonthlyPrices, extractAnnualPrice, toLookupResult, blendSeedCottonMonthly,
  type NassRow, type NassSeriesSpec,
} from '@/lib/nass-quickstats'

export const runtime = 'nodejs'
export const maxDuration = 30

// PRIMARY monthly MYA price source: the USDA NASS Quick Stats API — real
// published "prices received by farmers", deterministic, no web search.
// Same request/response contract as /api/mya-monthly-lookup (the AI route,
// which stays as an explicit fallback): values are returned for USER
// CONFIRMATION only; confirmed months save as source 'usda'. Seed cotton
// fetches BOTH series (upland lint ¢/lb + cottonseed $/ton) and blends in
// code, handling the cottonseed ginning-season survey cadence
// (lib/nass-quickstats.ts). Requires the free NASS_API_KEY
// (quickstats.nass.usda.gov/api); responses cache in-process for 24 h per
// series × marketing year to stay far inside the API's rate limits.

const NASS_URL = 'https://quickstats.nass.usda.gov/api/api_GET/'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

type CacheEntry = { expires: number; promise: Promise<NassRow[]> }
const cache = new Map<string, CacheEntry>()

class NassError extends Error {}

async function fetchNassRows(apiKey: string, params: Record<string, string>): Promise<NassRow[]> {
  const cacheKey = JSON.stringify(params)
  const now = Date.now()
  const hit = cache.get(cacheKey)
  if (hit && hit.expires > now) return hit.promise
  const promise = (async () => {
    const qs = new URLSearchParams({ key: apiKey, format: 'JSON', ...params })
    let resp: Response
    try {
      resp = await fetch(`${NASS_URL}?${qs}`, { cache: 'no-store' })
    } catch (e: any) {
      throw new NassError(`Could not reach the NASS Quick Stats API (${e?.message ?? 'network error'}).`)
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new NassError('The NASS Quick Stats API rejected the key — check NASS_API_KEY.')
    }
    if (resp.status === 429) {
      throw new NassError('The NASS Quick Stats API rate limit was hit — try again in a few minutes.')
    }
    const json = await resp.json().catch(() => null)
    // Quick Stats reports "no rows for these parameters" as an error payload
    // — that's a valid empty result, not a failure. Real failures (bad
    // params, record-limit, key problems) surface as NassError.
    if (json && typeof json === 'object' && 'error' in json) {
      const msg = String((json as { error: unknown }).error)
      if (/no data/i.test(msg)) return []
      throw new NassError(`NASS Quick Stats: ${msg}`)
    }
    if (!resp.ok) throw new NassError(`NASS Quick Stats returned HTTP ${resp.status}.`)
    const data = (json as { data?: unknown } | null)?.data
    return Array.isArray(data) ? (data as NassRow[]) : []
  })()
  cache.set(cacheKey, { expires: now + CACHE_TTL_MS, promise })
  promise.catch(() => { if (cache.get(cacheKey)?.promise === promise) cache.delete(cacheKey) })
  return promise
}

// Monthly "prices received" query for one series across the two calendar
// years a marketing year spans. unit_desc is deliberately NOT pinned — the
// parser normalizes whatever unit the series actually carries.
function monthlyParams(series: NassSeriesSpec, marketingYear: number): Record<string, string> {
  return {
    ...series.params,
    source_desc: 'SURVEY',
    statisticcat_desc: 'PRICE RECEIVED',
    freq_desc: 'MONTHLY',
    agg_level_desc: 'NATIONAL',
    year__GE: String(marketingYear),
    year__LE: String(marketingYear + 1),
  }
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const parsed = parseMyaMonthlyRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { commodity, marketingYear, startMonth, unit, seedCotton, lintShare, seedShare } = parsed.value

  const apiKey = process.env.NASS_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'NASS_API_KEY is not configured. Get a free key at quickstats.nass.usda.gov/api and add it to .env.local (and the Vercel project), or use the AI lookup fallback.' },
      { status: 500 },
    )
  }

  const elapsed = elapsedMarketingMonths(startMonth, marketingYear, new Date())
  if (elapsed.length === 0) {
    return NextResponse.json(
      { error: `The ${marketingYear} marketing year for ${commodity} hasn't started yet — there are no monthly prices to look up.` },
      { status: 400 },
    )
  }
  const today = new Date().toISOString().slice(0, 10)

  try {
    let data: MyaMonthlyLookupResult
    if (seedCotton) {
      // Two raw series; the blend happens HERE, never at the source.
      const [lintRows, seedRows] = await Promise.all([
        fetchNassRows(apiKey, monthlyParams(LINT_SERIES, marketingYear)),
        fetchNassRows(apiKey, monthlyParams(COTTONSEED_SERIES, marketingYear)),
      ])
      const lint = extractMonthlyPrices(lintRows, LINT_SERIES, startMonth, marketingYear)
      const seed = extractMonthlyPrices(seedRows, COTTONSEED_SERIES, startMonth, marketingYear)
      // Very early season (no cottonseed surveyed yet): the prior marketing
      // year's annual cottonseed price stands in, clearly labeled.
      let priorYearSeedAnnual: number | null = null
      if (seed.prices.length === 0 && lint.prices.length > 0) {
        // agg_level_desc must be pinned: the annual query also returns ~18
        // per-state MARKETING YEAR rows (verified live).
        const annualRows = await fetchNassRows(apiKey, {
          ...COTTONSEED_SERIES.params,
          source_desc: 'SURVEY',
          statisticcat_desc: 'PRICE RECEIVED',
          freq_desc: 'ANNUAL',
          agg_level_desc: 'NATIONAL',
          year: String(marketingYear - 1),
        })
        priorYearSeedAnnual = extractAnnualPrice(annualRows, 'dollars_per_ton')
      }
      const monthly = blendSeedCottonMonthly({
        lint: lint.prices, seed: seed.prices, elapsed, lintShare, seedShare, priorYearSeedAnnual,
      })
      const seedNote = seed.prices.length > 0
        ? `cottonseed published for ${seed.prices.length} month${seed.prices.length === 1 ? '' : 's'} (ginning-season survey); the season average stands in for unsurveyed months`
        : priorYearSeedAnnual != null
          ? `no cottonseed surveyed yet this season — the ${marketingYear - 1} annual cottonseed price ($${priorYearSeedAnnual}/ton) stands in`
          : 'no cottonseed data yet this season'
      data = {
        monthly_prices: monthly,
        source_description: `USDA NASS Quick Stats (Agricultural Prices), retrieved ${today}. Seed cotton blended in-app from upland lint (¢/lb) + cottonseed ($/ton); ${seedNote}. Recent months may be preliminary.`,
        confidence: 'high',
      }
    } else {
      const series = nassSeriesFor(commodity, unit)
      const rows = await fetchNassRows(apiKey, monthlyParams(series, marketingYear))
      const extracted = extractMonthlyPrices(rows, series, startMonth, marketingYear)
      data = toLookupResult({
        prices: extracted.prices,
        elapsed,
        startMonth,
        marketingYear,
        sourceDescription: `USDA NASS Quick Stats (Agricultural Prices)${extracted.seriesUsed ? `, series "${extracted.seriesUsed}"` : ''}, retrieved ${today}. Recent months may be preliminary.`,
      })
    }
    return NextResponse.json({ data: { ...data, source: 'nass' } })
  } catch (e) {
    if (e instanceof NassError) return NextResponse.json({ error: e.message }, { status: 502 })
    throw e
  }
}
