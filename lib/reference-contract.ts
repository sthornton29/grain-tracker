// Marketing reference contract — the futures contract unpriced bushels are
// valued against, shared by the marketing engine's inputs, the What-If, the
// Income Sensitivity price axis, and the Budget Planner's live quote.
//
// Default: the crop year's NEW-CROP benchmark (Corn → DEC/ZCZ, Soybeans →
// NOV/ZSX, Chicago Wheat → JUL/ZWN, Cotton → DEC/CTZ). Once that contract has
// EXPIRED as of the given date, the reference rolls forward to the nearest
// still-trading listed month for the commodity (wheat after JUL 26 → SEP 26;
// after SEP 26 → DEC 26; corn after DEC 26 → MAR 27; …).
//
// EXPIRY RULE (documented approximation): a contract stops being the reference
// on the business day preceding the 15th of its delivery month — the CBOT
// grain last-trading-day rule, applied uniformly (including cotton, whose real
// ICE expiry differs by a few days) because this seam only decides which
// contract to QUOTE, not anything settlement-critical. Weekends step back to
// Friday; exchange holidays are ignored on purpose.
//
// This seam is for MARKETING references only. Crop-insurance harvest-price
// discovery (lib/crop-insurance.ts harvestContractSymbol — DEC corn, NOV
// beans, SEP wheat per RMA) and final-price pinning are deliberately separate
// and unchanged.

import { cropToHedgeCommodity } from '@/lib/contracts'
import { COMMODITY_SPECS, buildContractSymbol, parseContractMonth, type Commodity } from '@/lib/hedging'

const MONTH_ABBR_BY_NUM: Record<number, string> = {
  1: 'JAN', 2: 'FEB', 3: 'MAR', 4: 'APR', 5: 'MAY', 6: 'JUN',
  7: 'JUL', 8: 'AUG', 9: 'SEP', 10: 'OCT', 11: 'NOV', 12: 'DEC',
}
const MONTH_NUM_BY_CODE: Record<string, number> = {
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12,
}

// The new-crop benchmark delivery month per commodity (the marketing default;
// mirrors the What-If's historical "use today's price" target).
export const NEW_CROP_MONTH_NUM: Record<Commodity, number> = {
  Corn: 12,          // DEC
  Soybeans: 11,      // NOV
  'Chicago Wheat': 7, // JUL
  Cotton: 12,        // DEC
}

export type ReferenceContract = {
  symbol: string        // 'ZWU26'
  contractMonth: string // 'SEP 26' — the app's contract-month label format
  monthNum: number
  year: number
  /** True when the crop year's benchmark expired and the reference rolled
   *  forward. False for the benchmark itself and for a user override. */
  rolled: boolean
  /** The crop-year benchmark this reference is standing in for ('JUL 26'). */
  benchmarkMonth: string
  /** True when the month came from the user's saved override, not the resolver. */
  overridden: boolean
}

export function contractMonthLabel(monthNum: number, year: number): string {
  return `${MONTH_ABBR_BY_NUM[monthNum]} ${String(year % 100).padStart(2, '0')}`
}

/**
 * The date a contract stops being quotable for reference purposes: the
 * business day preceding the 15th of the delivery month (weekends roll back
 * to Friday; holidays ignored — see the header note).
 */
export function referenceExpiryDate(monthNum: number, year: number): Date {
  const d = new Date(year, monthNum - 1, 14) // the day before the 15th
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
  return d
}

export function isExpired(monthNum: number, year: number, asOf: Date): boolean {
  // Expired ON the expiry date's end: still the reference through the last
  // trading day itself, rolled the day after.
  const exp = referenceExpiryDate(monthNum, year)
  const a = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate())
  return a.getTime() > exp.getTime()
}

/** Listed delivery months for a commodity, chronological, from a start month. */
function listedMonthsFrom(
  commodity: Commodity,
  startMonthNum: number,
  startYear: number,
  count: number,
): Array<{ monthNum: number; year: number }> {
  const allowed = COMMODITY_SPECS[commodity].contractMonths
    .map((c) => MONTH_NUM_BY_CODE[c])
    .sort((a, b) => a - b)
  const out: Array<{ monthNum: number; year: number }> = []
  let year = startYear
  let from = startMonthNum
  while (out.length < count) {
    for (const m of allowed) {
      if (year === startYear && m < from) continue
      out.push({ monthNum: m, year })
      if (out.length >= count) break
    }
    year++
    from = 1
  }
  return out
}

/**
 * Resolve the reference contract for a crop × crop year as of a date.
 * A saved user override (a contract-month label like 'SEP 26') wins while it
 * is still trading; an expired or unparseable override is ignored and the
 * resolver's default answer (benchmark, rolled forward past expiry) applies.
 * Returns null for crops with no traded future (e.g. Canola).
 */
export function marketingReferenceContract(
  cropName: string | null | undefined,
  cropYear: number,
  asOf: Date,
  overrideMonth?: string | null,
): ReferenceContract | null {
  const commodity = cropToHedgeCommodity(cropName)
  if (!commodity) return null
  const benchNum = NEW_CROP_MONTH_NUM[commodity]
  const benchmarkMonth = contractMonthLabel(benchNum, cropYear)

  if (overrideMonth) {
    const p = parseContractMonth(overrideMonth)
    if (p && !isExpired(p.monthNum, p.year4, asOf)) {
      return {
        symbol: buildContractSymbol(commodity, overrideMonth),
        contractMonth: contractMonthLabel(p.monthNum, p.year4),
        monthNum: p.monthNum,
        year: p.year4,
        rolled: false,
        benchmarkMonth,
        overridden: true,
      }
    }
    // Expired/invalid override → fall through to the resolver default.
  }

  if (!isExpired(benchNum, cropYear, asOf)) {
    return {
      symbol: buildContractSymbol(commodity, benchmarkMonth),
      contractMonth: benchmarkMonth,
      monthNum: benchNum,
      year: cropYear,
      rolled: false,
      benchmarkMonth,
      overridden: false,
    }
  }

  // Benchmark expired: nearest still-trading listed month after it.
  for (const m of listedMonthsFrom(commodity, benchNum, cropYear, 24)) {
    if (isExpired(m.monthNum, m.year, asOf)) continue
    const label = contractMonthLabel(m.monthNum, m.year)
    return {
      symbol: buildContractSymbol(commodity, label),
      contractMonth: label,
      monthNum: m.monthNum,
      year: m.year,
      rolled: true,
      benchmarkMonth,
      overridden: false,
    }
  }
  return null
}

/**
 * A supposedly-live reference whose quote fetch came back empty (while other
 * symbols quoted fine) falls forward to the next listed month that DID quote —
 * shared by every consumer so the marketing dashboard, Revenue Projections,
 * and Income Sensitivity always land on the same contract. A user-pinned
 * month never falls forward (their choice is shown, quote or not), and a
 * wholesale fetch failure (no quotes at all) changes nothing.
 */
export function fallForwardOnMissingQuote(
  ref: ReferenceContract,
  options: ReadonlyArray<{ symbol: string; contractMonth: string; monthNum: number; year: number }>,
  hasQuote: (symbol: string) => boolean,
  anyQuotes: boolean,
): ReferenceContract {
  if (ref.overridden || !anyQuotes || hasQuote(ref.symbol)) return ref
  const key = ref.year * 100 + ref.monthNum
  const live = options.find((o) => o.year * 100 + o.monthNum > key && hasQuote(o.symbol))
  if (!live) return ref
  return { ...ref, symbol: live.symbol, contractMonth: live.contractMonth, monthNum: live.monthNum, year: live.year, rolled: true }
}

export type ReferenceMonthOption = {
  contractMonth: string // 'SEP 26'
  symbol: string        // 'ZWU26'
  monthNum: number
  year: number
  isDefault: boolean    // the resolver's own (no-override) answer
}

/**
 * The months a user may point the reference at: the commodity's listed,
 * still-trading contracts from this crop year's cycle through the NEXT crop
 * year's benchmark (wheat as of Aug 2026 → SEP 26, DEC 26, MAR 27, MAY 27,
 * JUL 27).
 */
export function referenceMonthOptions(
  cropName: string | null | undefined,
  cropYear: number,
  asOf: Date,
): ReferenceMonthOption[] {
  const commodity = cropToHedgeCommodity(cropName)
  if (!commodity) return []
  const def = marketingReferenceContract(cropName, cropYear, asOf)
  const benchNum = NEW_CROP_MONTH_NUM[commodity]
  const out: ReferenceMonthOption[] = []
  for (const m of listedMonthsFrom(commodity, benchNum, cropYear, 24)) {
    if (isExpired(m.monthNum, m.year, asOf)) continue
    // Stop after the next crop year's benchmark.
    if (m.year > cropYear + 1 || (m.year === cropYear + 1 && m.monthNum > benchNum)) break
    const label = contractMonthLabel(m.monthNum, m.year)
    out.push({
      contractMonth: label,
      symbol: buildContractSymbol(commodity, label),
      monthNum: m.monthNum,
      year: m.year,
      isDefault: def != null && !def.overridden && def.contractMonth === label,
    })
  }
  return out
}
