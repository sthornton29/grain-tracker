// MYA (marketing-year average) estimation. The MYA is the national average
// farm cash price weighted by monthly marketings across the marketing year
// (corn/soy: Sep 1–Aug 31; wheat: Jun 1–May 31) — a single day's futures quote
// is not an MYA. This module estimates it month by month:
//   * elapsed/published months use the USDA/NASS monthly average farm prices
//     the operator has entered (mya_monthly_prices);
//   * remaining months are futures-implied: the nearest futures contract for
//     that month plus a per-commodity futures→farm-price adjustment (national
//     average basis, negative = farm under futures);
//   * months are weighted by typical national marketing weights (heavier
//     Oct–Jan for corn/soy harvest marketings), normalized over the months a
//     price exists for.
// Pure functions — the /api/mya-estimate route and the UI pass data in. The
// result feeds resolveMyaPrice's 'estimate' tier (a typed WASDE midpoint
// outranks it there; a manual override and the published final outrank both).

import { COMMODITY_SPECS, buildContractSymbol, monthCodeFor, type Commodity } from './hedging'
import { cropToCommodity } from './contracts'

// Futures→farm-price adjustment defaults, $/bu, keyed by covered-commodity
// name. Overridable per commodity via covered_commodities.mya_basis_adj.
export function defaultBasisAdj(commodityName: string | null | undefined): number {
  const s = (commodityName ?? '').trim().toLowerCase()
  if (s === 'corn') return -0.35
  if (s === 'soybeans') return -0.6
  if (s === 'wheat') return -0.45
  return 0
}

// Default monthly marketing weights, aligned to the MARKETING YEAR's month
// order (index 0 = the marketing year's first month). Approximate national
// marketing patterns; the engine normalizes, so only the shape matters.
// Overridable per commodity via covered_commodities.mya_month_weights.
const CORN_WEIGHTS = [0.06, 0.115, 0.11, 0.1, 0.115, 0.085, 0.08, 0.075, 0.07, 0.07, 0.065, 0.055] // Sep..Aug
const SOY_WEIGHTS = [0.08, 0.16, 0.14, 0.1, 0.11, 0.08, 0.07, 0.06, 0.05, 0.05, 0.05, 0.05] // Sep..Aug
const WHEAT_WEIGHTS = [0.14, 0.15, 0.13, 0.1, 0.08, 0.07, 0.06, 0.06, 0.055, 0.055, 0.05, 0.05] // Jun..May
const UNIFORM_WEIGHTS = Array.from({ length: 12 }, () => 1 / 12)

export function defaultMonthWeights(commodityName: string | null | undefined): number[] {
  const s = (commodityName ?? '').trim().toLowerCase()
  if (s === 'corn') return [...CORN_WEIGHTS]
  if (s === 'soybeans') return [...SOY_WEIGHTS]
  if (s === 'wheat') return [...WHEAT_WEIGHTS]
  return [...UNIFORM_WEIGHTS]
}

export type MarketingMonth = { month: number; year: number } // calendar month/year

// The 12 calendar months of a marketing year. cropYear is the year the
// marketing year STARTS in (2026 corn = Sep 2026 – Aug 2027).
export function marketingYearMonths(startMonth: number, cropYear: number): MarketingMonth[] {
  return Array.from({ length: 12 }, (_, i) => {
    const m0 = startMonth - 1 + i
    return { month: (m0 % 12) + 1, year: cropYear + Math.floor(m0 / 12) }
  })
}

// The futures contract used to imply a month's farm price: the commodity's
// nearest delivery month at or after the calendar month. null for commodities
// with no traded futures.
export function futuresSymbolForMonth(
  commodityName: string | null | undefined,
  m: MarketingMonth,
): string | null {
  const traded = cropToCommodity(commodityName)
  if (!traded) return null
  const spec = COMMODITY_SPECS[traded as Commodity]
  if (!spec) return null
  const allowed = new Set(spec.contractMonths)
  for (let i = 0; i < 12; i++) {
    const m0 = m.month - 1 + i
    const month = (m0 % 12) + 1
    const year = m.year + Math.floor(m0 / 12)
    if (allowed.has(monthCodeFor(month))) {
      const abbr = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][month - 1]
      return buildContractSymbol(traded, `${abbr} ${String(year % 100).padStart(2, '0')}`) || null
    }
  }
  return null
}

export type MyaMonthComposition = {
  month: number // calendar month
  year: number
  weight: number // normalized over months with a price (0 when missing)
  price: number | null // published price, or futures + basis adj
  source: 'published' | 'futures' | 'missing'
  symbol: string | null // the futures contract used, when futures-implied
}

export type MyaBlendResult = {
  estimate: number | null // Σ(month price × normalized weight); null when no month has a price
  months: MyaMonthComposition[]
  publishedCount: number
  futuresCount: number
  missingCount: number
  basisAdj: number // the adjustment actually applied to futures months
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

// The month-by-month MYA blend.
export function estimateMyaBlend(args: {
  commodityName: string
  marketingYearStartMonth: number
  cropYear: number
  // Published/entered monthly prices, keyed by CALENDAR month (each calendar
  // month appears exactly once in a marketing year).
  monthlyPrices: ReadonlyArray<{ month: number; price: number }>
  // Quote lookup for futures symbols ($/bu). Omit to treat all unpublished
  // months as missing (e.g. untraded commodities).
  futuresPriceForSymbol?: (symbol: string) => number | null | undefined
  basisAdj?: number | null // default: per-commodity national average
  weights?: readonly number[] | null // 12 weights in marketing-year order; default per commodity
}): MyaBlendResult {
  const basisAdj = args.basisAdj ?? defaultBasisAdj(args.commodityName)
  const rawWeights =
    args.weights && args.weights.length === 12 && args.weights.some((w) => w > 0)
      ? [...args.weights]
      : defaultMonthWeights(args.commodityName)
  const publishedByMonth = new Map(args.monthlyPrices.map((p) => [p.month, Number(p.price)]))

  const months: MyaMonthComposition[] = marketingYearMonths(args.marketingYearStartMonth, args.cropYear).map(
    (m, i) => {
      const published = publishedByMonth.get(m.month)
      if (published != null && Number.isFinite(published)) {
        return { ...m, weight: rawWeights[i], price: published, source: 'published' as const, symbol: null }
      }
      const symbol = futuresSymbolForMonth(args.commodityName, m)
      const quote = symbol != null ? args.futuresPriceForSymbol?.(symbol) : null
      if (quote != null && Number.isFinite(Number(quote))) {
        return { ...m, weight: rawWeights[i], price: round4(Number(quote) + basisAdj), source: 'futures' as const, symbol }
      }
      return { ...m, weight: rawWeights[i], price: null, source: 'missing' as const, symbol }
    },
  )

  // Normalize weights over the months that have a price; missing months drop
  // out (their weight is redistributed proportionally).
  const totalW = months.reduce((s, m) => s + (m.price != null ? m.weight : 0), 0)
  let estimate: number | null = null
  if (totalW > 0) {
    estimate = round4(months.reduce((s, m) => s + (m.price != null ? m.price * (m.weight / totalW) : 0), 0))
  }
  const normalized = months.map((m) => ({
    ...m,
    weight: m.price != null && totalW > 0 ? round4(m.weight / totalW) : 0,
  }))

  return {
    estimate,
    months: normalized,
    publishedCount: normalized.filter((m) => m.source === 'published').length,
    futuresCount: normalized.filter((m) => m.source === 'futures').length,
    missingCount: normalized.filter((m) => m.source === 'missing').length,
    basisAdj,
  }
}

// The futures symbols a blend would need quotes for (the non-published months),
// deduplicated — used to prefetch quotes before calling estimateMyaBlend.
export function futuresSymbolsForBlend(args: {
  commodityName: string
  marketingYearStartMonth: number
  cropYear: number
  monthlyPrices: ReadonlyArray<{ month: number; price: number }>
}): string[] {
  const published = new Set(args.monthlyPrices.map((p) => p.month))
  const out = new Set<string>()
  for (const m of marketingYearMonths(args.marketingYearStartMonth, args.cropYear)) {
    if (published.has(m.month)) continue
    const s = futuresSymbolForMonth(args.commodityName, m)
    if (s) out.add(s)
  }
  return [...out]
}

// One-line composition summary for the MYA panel, e.g.
// "7 of 12 months USDA-published; 5 futures-implied (futures − $0.35)".
export function describeMyaComposition(r: MyaBlendResult): string {
  if (r.publishedCount === 12) return 'All 12 months USDA-published'
  const adjAbs = Math.abs(r.basisAdj).toFixed(2)
  const adjTxt = r.basisAdj <= 0 ? `futures − $${adjAbs}` : `futures + $${adjAbs}`
  const parts: string[] = [`${r.publishedCount} of 12 months USDA-published`]
  if (r.futuresCount > 0) parts.push(`${r.futuresCount} futures-implied (${adjTxt})`)
  if (r.missingCount > 0) parts.push(`${r.missingCount} missing`)
  return parts.join('; ')
}
