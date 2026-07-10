// Request/response contracts and pure parsing/merge logic for the AI
// web-search lookups (ARC-CO benchmarks, USDA monthly MYA prices). Both
// lookups share the same pattern: server route → Claude with web search →
// JSON-only response → user confirms before anything is saved. This module
// has no SDK imports — the routes wrap it around lib/ai-web-search.ts, the
// MYA panel uses the merge helpers client-side, and the vitest suite
// exercises everything here directly.

import { marketingYearMonths, type MarketingMonth } from './mya-estimate'
import { LINT_SHARE, COTTONSEED_SHARE } from './government-payments'

// Pull the JSON object out of a model reply that may carry markdown fences or
// stray prose around it.
export function extractJson(text: string): string {
  let s = text.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) return s.slice(first, last + 1)
  return s
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

// ---------- ARC-CO benchmark lookup ----------

export type ArcBenchmarkLookupRequest = {
  commodity: string
  county: string
  state: string
  // counties.id when the client has it — used server-side to cache/dedupe on
  // commodity + county_id + program year.
  countyId: string | null
  cropYear: number
}

// County names repeat across states (30+ Washington Counties), so a benchmark
// lookup is only meaningful as county + state — both are required.
export function parseArcBenchmarkRequest(body: unknown): ParseResult<ArcBenchmarkLookupRequest> {
  const b = (body ?? {}) as Record<string, unknown>
  const commodity = typeof b.commodity === 'string' ? b.commodity.trim() : ''
  const county = typeof b.county === 'string' ? b.county.trim() : ''
  const state = typeof b.state === 'string' ? b.state.trim() : ''
  const countyId = typeof b.county_id === 'string' && b.county_id.trim() !== '' ? b.county_id.trim() : null
  const cropYear = Number(b.crop_year)
  if (!commodity || !county || !Number.isFinite(cropYear)) {
    return { ok: false, error: 'commodity, county, state, and crop_year are required.' }
  }
  if (!state) {
    return {
      ok: false,
      error: `state is required — county names repeat across states, so "${county}" alone is ambiguous. Send the county's state too (e.g. "Lawrence County, Alabama").`,
    }
  }
  return { ok: true, value: { commodity, county, state, countyId, cropYear } }
}

export type ArcBenchmarkLookupResult = {
  benchmark_yield: number | null
  benchmark_price: number | null
  // The crop year the returned numbers are actually FOR: the requested year
  // when FSA has published it, else the most recent prior year with published
  // FSA benchmark data (early in a program year the current year often isn't
  // out yet). null when the model didn't say.
  data_year: number | null
  source_description: string
  confidence: 'high' | 'low'
}

// Normalize whatever JSON came back into the contract. The source_description
// always names the county + state so the user can verify the right county was
// found — and, when the numbers came from an earlier year than requested,
// always names that year. Both are prepended if the model left them out.
export function normalizeArcBenchmarkResult(
  raw: unknown,
  loc: { county: string; state: string; cropYear?: number },
): ArcBenchmarkLookupResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const dataYear = typeof r.data_year === 'number' && Number.isInteger(r.data_year) && r.data_year > 1990 && r.data_year < 2100
    ? r.data_year
    : null
  let desc = typeof r.source_description === 'string' ? r.source_description : ''
  if (!desc.toLowerCase().includes(loc.county.toLowerCase())) {
    desc = `${loc.county} County, ${loc.state}: ${desc}`.trim().replace(/:\s*$/, '')
  }
  if (dataYear != null && loc.cropYear != null && dataYear !== loc.cropYear && !desc.includes(String(dataYear))) {
    desc = `${dataYear} data (most recent available — ${loc.cropYear} not yet published): ${desc}`
  }
  return {
    benchmark_yield: typeof r.benchmark_yield === 'number' && Number.isFinite(r.benchmark_yield) ? r.benchmark_yield : null,
    benchmark_price: typeof r.benchmark_price === 'number' && Number.isFinite(r.benchmark_price) ? r.benchmark_price : null,
    data_year: dataYear,
    source_description: desc,
    confidence: r.confidence === 'high' ? 'high' : 'low',
  }
}

// ---------- USDA monthly MYA price lookup ----------

export function isSeedCotton(name: string | null | undefined): boolean {
  return /seed\s*cotton/i.test(name ?? '')
}

export type MyaMonthlyLookupRequest = {
  commodity: string
  marketingYear: number
  // Marketing-year start month (corn/soy 9 = Sep–Aug, wheat 6 = Jun–May) —
  // from covered_commodities.marketing_year_start_month.
  startMonth: number
  unit: 'bushel' | 'pound'
  // Seed cotton: the lookup retrieves NASS lint (¢/lb) + cottonseed ($/ton)
  // and the BLEND happens in code at these weight shares (configurable on
  // covered_commodities; standard 43/57).
  seedCotton: boolean
  lintShare: number
  seedShare: number
}

function parseShare(raw: unknown, fallback: number): number {
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback
}

export function parseMyaMonthlyRequest(body: unknown): ParseResult<MyaMonthlyLookupRequest> {
  const b = (body ?? {}) as Record<string, unknown>
  const commodity = typeof b.commodity === 'string' ? b.commodity.trim() : ''
  const marketingYear = Number(b.marketing_year)
  const startMonthRaw = b.start_month == null ? 9 : Number(b.start_month)
  const unit = b.unit === 'pound' ? 'pound' : 'bushel'
  if (!commodity || !Number.isFinite(marketingYear)) {
    return { ok: false, error: 'commodity and marketing_year are required.' }
  }
  if (!Number.isInteger(startMonthRaw) || startMonthRaw < 1 || startMonthRaw > 12) {
    return { ok: false, error: 'start_month must be a calendar month 1–12.' }
  }
  return {
    ok: true,
    value: {
      commodity, marketingYear, startMonth: startMonthRaw, unit,
      seedCotton: isSeedCotton(commodity),
      lintShare: parseShare(b.lint_share, LINT_SHARE),
      seedShare: parseShare(b.seed_share, COTTONSEED_SHARE),
    },
  }
}

// The marketing-year months that have started as of `now` — the ones NASS can
// have a (possibly preliminary) price for.
export function elapsedMarketingMonths(startMonth: number, marketingYear: number, now: Date): MarketingMonth[] {
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  return marketingYearMonths(startMonth, marketingYear).filter(
    (mm) => mm.year < y || (mm.year === y && mm.month <= m),
  )
}

export function monthKey(m: MarketingMonth): string {
  return `${m.year}-${String(m.month).padStart(2, '0')}`
}

export type MyaLookupMonth = {
  month: number // calendar month 1–12
  year: number
  key: string // "YYYY-MM"
  price: number | null
  status: 'published' | 'not_yet_published'
  // Derived prices (seed cotton) carry their composition, e.g.
  // "lint 68.2¢ + seed $205/ton → 35.17¢ SC". null for plain NASS prices.
  note: string | null
  components: { lint_cents_per_lb: number; cottonseed_dollars_per_ton: number } | null
}

export type MyaMonthlyLookupResult = {
  monthly_prices: MyaLookupMonth[]
  source_description: string
  confidence: 'high' | 'low'
}

// Normalize the model's JSON: only months inside this commodity's marketing
// year are accepted, months are returned in marketing-year order, malformed
// entries are dropped, and a null/absent price forces not_yet_published.
export function normalizeMyaMonthlyResult(
  raw: unknown,
  startMonth: number,
  marketingYear: number,
): MyaMonthlyLookupResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const window = marketingYearMonths(startMonth, marketingYear)
  const byKey = new Map(window.map((m) => [monthKey(m), m]))
  const out = new Map<string, MyaLookupMonth>()
  const entries = Array.isArray(r.monthly_prices) ? r.monthly_prices : []
  for (const e of entries) {
    const rec = (e ?? {}) as Record<string, unknown>
    const key = typeof rec.month === 'string' ? rec.month.trim() : ''
    const m = byKey.get(key)
    if (!m || out.has(key)) continue
    const price = typeof rec.price === 'number' && Number.isFinite(rec.price) && rec.price >= 0 ? rec.price : null
    out.set(key, {
      month: m.month,
      year: m.year,
      key,
      price,
      status: price != null ? 'published' : 'not_yet_published',
      note: null,
      components: null,
    })
  }
  return {
    monthly_prices: window.filter((m) => out.has(monthKey(m))).map((m) => out.get(monthKey(m))!),
    source_description: typeof r.source_description === 'string' ? r.source_description : '',
    confidence: r.confidence === 'high' ? 'high' : 'low',
  }
}

// ---------- Seed cotton: blend NASS lint + cottonseed in code ----------

const round6 = (n: number) => Math.round(n * 1e6) / 1e6
const fmtCents = (c: number) => (Math.round(c * 100) / 100).toString()

/**
 * The seed cotton monthly price is the production-weighted blend of the NASS
 * upland cotton LINT price (¢/lb) and the NASS COTTONSEED price ($/ton) —
 * lint alone materially misstates it. Computed HERE, never by the AI:
 *   sc $/lb = lintShare × (lint¢ ÷ 100) + seedShare × (seed$/ton ÷ 2000)
 * (equivalently in ¢/lb: lintShare × lint¢ + seedShare × (seed$/ton ÷ 20)).
 * Stored in $/lb like every other pound-unit price in the app, so the PLC
 * comparison against the $0.42/lb seed cotton reference stays unit-consistent.
 */
export function blendSeedCottonMonth(
  lintCentsPerLb: number,
  cottonseedDollarsPerTon: number,
  shares?: { lintShare?: number; seedShare?: number },
): { price: number; note: string } {
  const lintShare = shares?.lintShare ?? LINT_SHARE
  const seedShare = shares?.seedShare ?? COTTONSEED_SHARE
  const price = round6(lintShare * (lintCentsPerLb / 100) + seedShare * (cottonseedDollarsPerTon / 2000))
  const note = `lint ${fmtCents(lintCentsPerLb)}¢ + seed $${fmtCents(cottonseedDollarsPerTon)}/ton → ${fmtCents(price * 100)}¢ SC`
  return { price, note }
}

/**
 * Normalize the seed cotton lookup's JSON: the model reports the two NASS
 * series per month (lint ¢/lb, cottonseed $/ton) and the blended price is
 * computed here. A month missing EITHER component is not_yet_published —
 * never a lint-only blend.
 */
export function normalizeSeedCottonMonthlyResult(
  raw: unknown,
  startMonth: number,
  marketingYear: number,
  shares?: { lintShare?: number; seedShare?: number },
): MyaMonthlyLookupResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const window = marketingYearMonths(startMonth, marketingYear)
  const byKey = new Map(window.map((m) => [monthKey(m), m]))
  const out = new Map<string, MyaLookupMonth>()
  const entries = Array.isArray(r.monthly_prices) ? r.monthly_prices : []
  for (const e of entries) {
    const rec = (e ?? {}) as Record<string, unknown>
    const key = typeof rec.month === 'string' ? rec.month.trim() : ''
    const m = byKey.get(key)
    if (!m || out.has(key)) continue
    const lint = typeof rec.lint_cents_per_lb === 'number' && Number.isFinite(rec.lint_cents_per_lb) && rec.lint_cents_per_lb >= 0
      ? rec.lint_cents_per_lb : null
    const seed = typeof rec.cottonseed_dollars_per_ton === 'number' && Number.isFinite(rec.cottonseed_dollars_per_ton) && rec.cottonseed_dollars_per_ton >= 0
      ? rec.cottonseed_dollars_per_ton : null
    if (lint != null && seed != null) {
      const blended = blendSeedCottonMonth(lint, seed, shares)
      out.set(key, {
        month: m.month, year: m.year, key,
        price: blended.price, status: 'published',
        note: blended.note,
        components: { lint_cents_per_lb: lint, cottonseed_dollars_per_ton: seed },
      })
    } else {
      out.set(key, {
        month: m.month, year: m.year, key,
        price: null, status: 'not_yet_published', note: null, components: null,
      })
    }
  }
  return {
    monthly_prices: window.filter((m) => out.has(monthKey(m))).map((m) => out.get(monthKey(m))!),
    source_description: typeof r.source_description === 'string' ? r.source_description : '',
    confidence: r.confidence === 'high' ? 'high' : 'low',
  }
}

// ---------- Merging fetched months into the monthly table ----------

// Default confirmation set for a fresh lookup: published months the operator
// has NOT already entered. Months with an existing entry start unchecked —
// they are never overwritten without explicit confirmation.
export function defaultConfirmedMonths(
  fetched: ReadonlyArray<{ month: number; price: number | null }>,
  existingMonths: ReadonlySet<number>,
): Set<number> {
  return new Set(fetched.filter((f) => f.price != null && !existingMonths.has(f.month)).map((f) => f.month))
}

export type MonthlySavePlan = { month: number; price: number; source: 'ai' | 'manual'; note: string | null }

// What actually gets upserted after the operator hits save: only confirmed,
// published months (null months are ignored; unconfirmed months — including
// every month that already has an entry the operator didn't re-check — are
// left alone). A confirmed AI value the operator edited saves as 'manual' —
// and drops the component note, which no longer describes the edited number.
export function planMonthlySaves(args: {
  fetched: ReadonlyArray<{ month: number; price: number | null; note?: string | null }>
  confirmed: ReadonlySet<number>
  edited?: ReadonlyMap<number, number>
}): MonthlySavePlan[] {
  const out: MonthlySavePlan[] = []
  for (const f of args.fetched) {
    if (f.price == null || !args.confirmed.has(f.month)) continue
    const edit = args.edited?.get(f.month)
    if (edit != null && Number.isFinite(edit) && edit >= 0 && edit !== f.price) {
      out.push({ month: f.month, price: edit, source: 'manual', note: null })
    } else {
      out.push({ month: f.month, price: f.price, source: 'ai', note: f.note ?? null })
    }
  }
  return out
}
