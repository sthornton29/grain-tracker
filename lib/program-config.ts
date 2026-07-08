// Resolves per-crop-year program parameters (SCO trigger, per-person payment
// limit, sequestration %, and the OBBBA ARC/PLC parameters: ARC guarantee %,
// ARC payment cap %, ERP Olympic factor/cap, base-acre payment factors) that
// used to be hard-coded constants. The values live in the program_year_config
// table; callers fetch the rows and resolve the year they need here. When a
// year has no row, we fall back to the most recent configured year and flag it
// so the UI can show a non-blocking notice.
//
// Pure (no I/O): the settings page and reports pass the fetched rows in.

import type { ProgramYearConfig } from '@/lib/types'

// Built-in last-resort values, used only when the table is completely empty
// (e.g. a fresh DB before migration 032/037's seeds have run) or when an old
// row predates a column. These mirror the seeded rows.
export const DEFAULT_SCO_TRIGGER = 0.86
export const DEFAULT_PER_PERSON_PAYMENT_LIMIT = 155000
export const DEFAULT_SEQUESTRATION_PCT = 0.054

// OBBBA rewrote the ARC/PLC parameters starting with the 2025 crop year:
// ARC guarantee 86% → 90%, ARC payment cap 10% → 12%, ERP Olympic factor
// 85% → 88%. The built-in defaults are era-aware so historical years compute
// under the law that actually applied to them.
export const OBBBA_FIRST_YEAR = 2025
export const DEFAULT_ERP_CAP_PCT = 1.15
export const DEFAULT_PAYMENT_FACTOR = 0.85 // ARC-CO and PLC base-acre factor
export const DEFAULT_ARC_IC_PAYMENT_FACTOR = 0.65

export function defaultArcGuaranteePct(cropYear: number): number {
  return cropYear >= OBBBA_FIRST_YEAR ? 0.9 : 0.86
}
export function defaultArcPaymentCapPct(cropYear: number): number {
  return cropYear >= OBBBA_FIRST_YEAR ? 0.12 : 0.1
}
export function defaultErpOlympicFactor(cropYear: number): number {
  return cropYear >= OBBBA_FIRST_YEAR ? 0.88 : 0.85
}

export type ResolvedProgramConfig = {
  requestedYear: number
  // The crop_year the values actually came from. null = built-in defaults
  // (the table had no rows at all).
  sourceYear: number | null
  // true when the values came from a different year than requested (or from the
  // built-in defaults) — the UI should surface programConfigNotice().
  isFallback: boolean
  scoTrigger: number
  perPersonPaymentLimit: number
  sequestrationPct: number
  arcGuaranteePct: number
  arcPaymentCapPct: number
  erpOlympicFactor: number
  erpCapPct: number
  paymentFactor: number
  arcIcPaymentFactor: number
}

// A numeric column that may be missing on rows fetched before migration 037.
function numOr(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function fromRow(requestedYear: number, row: ProgramYearConfig, isFallback: boolean): ResolvedProgramConfig {
  return {
    requestedYear,
    sourceYear: row.crop_year,
    isFallback,
    scoTrigger: Number(row.sco_trigger),
    perPersonPaymentLimit: Number(row.per_person_payment_limit),
    sequestrationPct: Number(row.sequestration_pct),
    arcGuaranteePct: numOr(row.arc_guarantee_pct, defaultArcGuaranteePct(requestedYear)),
    arcPaymentCapPct: numOr(row.arc_payment_cap_pct, defaultArcPaymentCapPct(requestedYear)),
    erpOlympicFactor: numOr(row.erp_olympic_factor, defaultErpOlympicFactor(requestedYear)),
    erpCapPct: numOr(row.erp_cap_pct, DEFAULT_ERP_CAP_PCT),
    paymentFactor: numOr(row.payment_factor, DEFAULT_PAYMENT_FACTOR),
    arcIcPaymentFactor: numOr(row.arc_ic_payment_factor, DEFAULT_ARC_IC_PAYMENT_FACTOR),
  }
}

// Resolve program parameters for a crop year. An exact-year row wins; otherwise
// we use the most recent configured year at or below the requested year, and
// failing that the earliest configured year. With no rows at all, fall back to
// the built-in (era-aware) defaults.
export function resolveProgramYearConfig(
  cropYear: number,
  configs: readonly ProgramYearConfig[],
): ResolvedProgramConfig {
  const exact = configs.find((c) => c.crop_year === cropYear)
  if (exact) return fromRow(cropYear, exact, false)

  const sorted = [...configs].sort((a, b) => a.crop_year - b.crop_year)
  const atOrBelow = sorted.filter((c) => c.crop_year <= cropYear)
  const src = atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : sorted[0]

  if (!src) {
    return {
      requestedYear: cropYear,
      sourceYear: null,
      isFallback: true,
      scoTrigger: DEFAULT_SCO_TRIGGER,
      perPersonPaymentLimit: DEFAULT_PER_PERSON_PAYMENT_LIMIT,
      sequestrationPct: DEFAULT_SEQUESTRATION_PCT,
      arcGuaranteePct: defaultArcGuaranteePct(cropYear),
      arcPaymentCapPct: defaultArcPaymentCapPct(cropYear),
      erpOlympicFactor: defaultErpOlympicFactor(cropYear),
      erpCapPct: DEFAULT_ERP_CAP_PCT,
      paymentFactor: DEFAULT_PAYMENT_FACTOR,
      arcIcPaymentFactor: DEFAULT_ARC_IC_PAYMENT_FACTOR,
    }
  }

  return fromRow(cropYear, src, true)
}

// Plain-English fallback notice, or null when the year resolved exactly.
export function programConfigNotice(r: ResolvedProgramConfig): string | null {
  if (!r.isFallback) return null
  const where = 'Update in Settings → Government Payments.'
  if (r.sourceYear == null) {
    return `Program parameters for ${r.requestedYear} not yet configured — using built-in defaults. ${where}`
  }
  return `Program parameters for ${r.requestedYear} not yet configured — using ${r.sourceYear} values. ${where}`
}
