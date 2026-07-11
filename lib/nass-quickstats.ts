// Pure parsing/conversion/blend logic for the USDA NASS Quick Stats API —
// the PRIMARY source for monthly MYA prices ("prices received by farmers").
// The /api/nass-monthly-prices route does the HTTP; everything here is pure
// and unit-tested. Quick Stats returns real published data, so results save
// as source 'usda' (the AI web search remains only as an explicit fallback).
//
// Defensive by design: series are selected from what the API actually
// returns (unit strings parsed, the best-covered series preferred) rather
// than trusting exact `_desc` values, since NASS wording shifts between
// commodities and years. All unit conversions live here, in one place.

import { marketingYearMonths } from './mya-estimate'
import { monthKey, type MyaLookupMonth, type MyaMonthlyLookupResult } from './ai-lookups'
import { LINT_SHARE, COTTONSEED_SHARE } from './government-payments'

// ---------- Value + unit parsing ----------

/**
 * Quick Stats `Value` fields are strings with thousands separators;
 * suppressed/unavailable cells are parenthesized codes — "(NA)" not
 * available, "(D)" withheld, "(S)"/"(Z)"/"(X)" variants → null.
 */
export function parseNassValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '' || /^\(.*\)$/.test(s)) return null
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** The unit each commodity's price is STORED in throughout the app. */
export type PriceUnit = 'dollars_per_bushel' | 'dollars_per_lb' | 'cents_per_lb' | 'dollars_per_ton'

type NassUnit = '$/BU' | '$/CWT' | '$/TON' | '$/LB' | 'C/LB'

function normalizeNassUnit(unitDesc: unknown): NassUnit | null {
  const u = String(unitDesc ?? '').toUpperCase().replace(/\s+/g, '')
  if (u === '$/BU' || u === '$/BUSHEL') return '$/BU'
  if (u === '$/CWT') return '$/CWT'
  if (u === '$/TON') return '$/TON'
  if (u === '$/LB') return '$/LB'
  if (u === '¢/LB' || u === 'CENTS/LB' || u === '¢/POUND' || u === 'CENTS/POUND') return 'C/LB'
  return null
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * Convert a NASS value in `unitDesc` to the target storage unit. $/CWT →
 * $/bu needs the commodity's pounds per bushel (sorghum 56, canola 50).
 * Returns null when the conversion isn't defined — the row is then skipped,
 * so a wrong-unit series can never leak a wrong-magnitude price.
 */
export function convertNassPrice(
  value: number,
  unitDesc: unknown,
  target: PriceUnit,
  lbPerBushel?: number | null,
): number | null {
  const unit = normalizeNassUnit(unitDesc)
  if (unit == null || !Number.isFinite(value)) return null
  // Everything via $/lb where possible.
  switch (target) {
    case 'dollars_per_bushel':
      if (unit === '$/BU') return round6(value)
      if (unit === '$/CWT') return lbPerBushel ? round6((value / 100) * lbPerBushel) : null
      return null
    case 'dollars_per_lb':
      if (unit === '$/LB') return round6(value)
      if (unit === 'C/LB') return round6(value / 100)
      if (unit === '$/CWT') return round6(value / 100)
      if (unit === '$/TON') return round6(value / 2000)
      return null
    case 'cents_per_lb':
      if (unit === 'C/LB') return round6(value)
      if (unit === '$/LB') return round6(value * 100)
      if (unit === '$/CWT') return round6(value) // $1/cwt = 1¢/lb
      if (unit === '$/TON') return round6(value / 20)
      return null
    case 'dollars_per_ton':
      if (unit === '$/TON') return round6(value)
      if (unit === '$/CWT') return round6(value * 20)
      if (unit === '$/LB') return round6(value * 2000)
      if (unit === 'C/LB') return round6(value * 20)
      return null
  }
}

// ---------- Commodity → query spec ----------

export type NassSeriesSpec = {
  /** Query params beyond the shared PRICE RECEIVED / MONTHLY / NATIONAL base. */
  params: Record<string, string>
  target: PriceUnit
  lbPerBushel?: number
}

/**
 * The Quick Stats query for one covered commodity. `unit` is the
 * covered_commodities unit ('bushel'/'pound') — used for commodities without
 * a bespoke mapping. Seed cotton is NOT here: it is two series (upland lint +
 * cottonseed) blended by the route; see LINT_SERIES / COTTONSEED_SERIES.
 */
export function nassSeriesFor(commodityName: string, unit: 'bushel' | 'pound'): NassSeriesSpec {
  const s = commodityName.trim().toLowerCase()
  if (s === 'corn') return { params: { commodity_desc: 'CORN' }, target: 'dollars_per_bushel' }
  if (s === 'soybeans') return { params: { commodity_desc: 'SOYBEANS' }, target: 'dollars_per_bushel' }
  if (s === 'wheat') return { params: { commodity_desc: 'WHEAT' }, target: 'dollars_per_bushel' }
  if (s === 'oats') return { params: { commodity_desc: 'OATS' }, target: 'dollars_per_bushel' }
  if (s === 'barley') return { params: { commodity_desc: 'BARLEY' }, target: 'dollars_per_bushel' }
  if (s === 'grain sorghum' || s === 'sorghum') {
    // NASS reports sorghum in $/CWT; program math runs in $/bu at 56 lb/bu.
    return { params: { commodity_desc: 'SORGHUM' }, target: 'dollars_per_bushel', lbPerBushel: 56 }
  }
  if (s === 'canola') return { params: { commodity_desc: 'CANOLA' }, target: 'dollars_per_bushel', lbPerBushel: 50 }
  if (s === 'peanuts') return { params: { commodity_desc: 'PEANUTS' }, target: 'dollars_per_lb' }
  if (s.includes('sunflower')) {
    // NASS says SUNFLOWER (singular), published in $/CWT; the all-types
    // series is preferred over OIL TYPE / NON-OIL TYPE by window coverage.
    return {
      params: { commodity_desc: 'SUNFLOWER' },
      target: unit === 'pound' ? 'dollars_per_lb' : 'dollars_per_bushel',
    }
  }
  // Unknown commodity: try its uppercased name; storage unit from the config.
  return {
    params: { commodity_desc: commodityName.trim().toUpperCase() },
    target: unit === 'pound' ? 'dollars_per_lb' : 'dollars_per_bushel',
  }
}

/**
 * Seed cotton components (blended in code, never a single NASS series).
 * Verified against the live API: lint is COTTON/UPLAND published in $ / LB
 * (normalized to ¢/lb here); cottonseed is NOT its own commodity — it is
 * COTTON with class_desc=COTTONSEED, in $ / TON.
 */
export const LINT_SERIES: NassSeriesSpec = {
  params: { commodity_desc: 'COTTON', class_desc: 'UPLAND' },
  target: 'cents_per_lb',
}
export const COTTONSEED_SERIES: NassSeriesSpec = {
  params: { commodity_desc: 'COTTON', class_desc: 'COTTONSEED' },
  target: 'dollars_per_ton',
}

// ---------- Response rows → monthly prices in a marketing-year window ----------

/** The Quick Stats row fields this module reads. */
export type NassRow = {
  year?: unknown
  reference_period_desc?: unknown
  unit_desc?: unknown
  Value?: unknown
  short_desc?: unknown
}

const MONTH_BY_ABBREV: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}

/** Monthly rows carry "JAN".."DEC" (older data sometimes full month names). */
export function monthFromReferencePeriod(desc: unknown): number | null {
  const s = String(desc ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3,9}$/.test(s)) return null
  return MONTH_BY_ABBREV[s.slice(0, 3)] ?? null
}

export type NassMonthlyPrice = { month: number; year: number; price: number }

/**
 * Extract one price per calendar month inside the marketing-year window,
 * converted to the target unit. When the response carries several series
 * (e.g. "WHEAT" alongside "WHEAT, WINTER"), the series covering the most
 * window months wins; ties go to the shortest short_desc (the base series).
 */
export function extractMonthlyPrices(
  rows: readonly NassRow[],
  spec: Pick<NassSeriesSpec, 'target' | 'lbPerBushel'>,
  startMonth: number,
  marketingYear: number,
): { prices: NassMonthlyPrice[]; seriesUsed: string | null } {
  const window = new Set(marketingYearMonths(startMonth, marketingYear).map((m) => monthKey(m)))
  type Parsed = { month: number; year: number; price: number; series: string }
  const parsed: Parsed[] = []
  for (const r of rows) {
    const month = monthFromReferencePeriod(r.reference_period_desc)
    const year = Number(r.year)
    if (month == null || !Number.isInteger(year)) continue
    if (!window.has(monthKey({ month, year }))) continue
    const raw = parseNassValue(r.Value)
    if (raw == null) continue
    const price = convertNassPrice(raw, r.unit_desc, spec.target, spec.lbPerBushel)
    if (price == null) continue
    parsed.push({ month, year, price, series: String(r.short_desc ?? '') })
  }
  if (parsed.length === 0) return { prices: [], seriesUsed: null }
  const bySeries = new Map<string, Parsed[]>()
  for (const p of parsed) {
    const list = bySeries.get(p.series) ?? []
    list.push(p)
    bySeries.set(p.series, list)
  }
  const seriesUsed = [...bySeries.keys()].sort(
    (a, b) => bySeries.get(b)!.length - bySeries.get(a)!.length || a.length - b.length || a.localeCompare(b),
  )[0]
  const prices = new Map<string, NassMonthlyPrice>()
  for (const p of bySeries.get(seriesUsed)!) {
    const k = monthKey(p)
    if (!prices.has(k)) prices.set(k, { month: p.month, year: p.year, price: p.price })
  }
  return {
    prices: marketingYearMonths(startMonth, marketingYear)
      .filter((m) => prices.has(monthKey(m)))
      .map((m) => prices.get(monthKey(m))!),
    seriesUsed,
  }
}

// ---------- Building the lookup result the MYA panel consumes ----------

/**
 * Shape plain (non-seed-cotton) monthly prices into the panel's lookup
 * contract: months with data are published; elapsed months without data are
 * not_yet_published; future months are omitted.
 */
export function toLookupResult(args: {
  prices: readonly NassMonthlyPrice[]
  elapsed: ReadonlyArray<{ month: number; year: number }>
  startMonth: number
  marketingYear: number
  sourceDescription: string
}): MyaMonthlyLookupResult {
  const byKey = new Map(args.prices.map((p) => [monthKey(p), p]))
  const monthly_prices: MyaLookupMonth[] = args.elapsed.map((m) => {
    const hit = byKey.get(monthKey(m))
    return {
      month: m.month,
      year: m.year,
      key: monthKey(m),
      price: hit?.price ?? null,
      status: hit ? 'published' : 'not_yet_published',
      note: null,
      components: null,
    }
  })
  return { monthly_prices, source_description: args.sourceDescription, confidence: 'high' }
}

// ---------- Seed cotton: blend the two NASS series month by month ----------

const fmtNum = (n: number) => String(Math.round(n * 100) / 100)

/**
 * Per-month seed cotton blend from the two NASS series, handling the
 * cottonseed survey cadence (only surveyed during ginning season, roughly
 * Aug/Sep–Feb; other months return NA):
 *   - both series published → plain blend;
 *   - lint published, that month's cottonseed NA but SOME cottonseed months
 *     exist this marketing year → the running marketing-year average of the
 *     published cottonseed prices stands in ("seed … (season avg)") —
 *     cottonseed marketings concentrate in ginning season, so the season
 *     average is a faithful stand-in;
 *   - no cottonseed at all yet (very early season) → the prior marketing
 *     year's annual/MYA cottonseed price when supplied ("prior-year annual"),
 *     else the month stays unpublished with a note telling the operator the
 *     lint price exists and the seed component needs manual entry.
 * sc $/lb = lintShare × lint¢/100 + seedShare × seed$/ton/2000.
 */
export function blendSeedCottonMonthly(args: {
  lint: readonly NassMonthlyPrice[] // ¢/lb
  seed: readonly NassMonthlyPrice[] // $/ton
  elapsed: ReadonlyArray<{ month: number; year: number }>
  lintShare?: number | null
  seedShare?: number | null
  priorYearSeedAnnual?: number | null // $/ton
}): MyaLookupMonth[] {
  const lintShare = args.lintShare ?? LINT_SHARE
  const seedShare = args.seedShare ?? COTTONSEED_SHARE
  const lintByKey = new Map(args.lint.map((p) => [monthKey(p), p]))
  const seedByKey = new Map(args.seed.map((p) => [monthKey(p), p]))
  const seasonAvg = args.seed.length > 0
    ? Math.round((args.seed.reduce((s, p) => s + p.price, 0) / args.seed.length) * 100) / 100
    : null

  return args.elapsed.map((m) => {
    const base = { month: m.month, year: m.year, key: monthKey(m) }
    const lint = lintByKey.get(base.key)
    if (!lint) {
      return { ...base, price: null, status: 'not_yet_published' as const, note: null, components: null }
    }
    const seedMonth = seedByKey.get(base.key)
    const seed = seedMonth != null
      ? { price: seedMonth.price, label: '' }
      : seasonAvg != null
        ? { price: seasonAvg, label: ' (season avg)' }
        : args.priorYearSeedAnnual != null
          ? { price: args.priorYearSeedAnnual, label: ' (prior-year annual)' }
          : null
    if (seed == null) {
      return {
        ...base,
        price: null,
        status: 'not_yet_published' as const,
        note: `lint ${fmtNum(lint.price)}¢ published — cottonseed not yet surveyed this season; enter the seed component manually`,
        components: null,
      }
    }
    const price = round6(lintShare * (lint.price / 100) + seedShare * (seed.price / 2000))
    return {
      ...base,
      price,
      status: 'published' as const,
      note: `lint ${fmtNum(lint.price)}¢ + seed $${fmtNum(seed.price)}/ton${seed.label} → ${fmtNum(price * 100)}¢ SC`,
      components: { lint_cents_per_lb: lint.price, cottonseed_dollars_per_ton: seed.price },
    }
  })
}

/**
 * The cottonseed ANNUAL (marketing-year) price from Quick Stats rows —
 * used as the early-season fallback seed component and, once a year is
 * complete, worth noting for the final.
 */
export function extractAnnualPrice(rows: readonly NassRow[], target: PriceUnit): number | null {
  for (const r of rows) {
    const desc = String(r.reference_period_desc ?? '').trim().toUpperCase()
    if (desc !== 'MARKETING YEAR' && desc !== 'YEAR') continue
    const raw = parseNassValue(r.Value)
    if (raw == null) continue
    const price = convertNassPrice(raw, r.unit_desc, target)
    if (price != null) return price
  }
  return null
}
