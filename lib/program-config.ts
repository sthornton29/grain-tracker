// Resolves per-crop-year program parameters (SCO trigger, per-person payment
// limit, sequestration %) that used to be hard-coded constants. The values now
// live in the program_year_config table; callers fetch the rows and resolve the
// year they need here. When a year has no row, we fall back to the most recent
// configured year and flag it so the UI can show a non-blocking notice.
//
// Pure (no I/O): the settings page and reports pass the fetched rows in.

import type { ProgramYearConfig } from '@/lib/types'

// Built-in last-resort values, used only when the table is completely empty
// (e.g. a fresh DB before migration 032's seed has run). These mirror the 2026
// seeded row, so behaviour is unchanged from the old hard-coded constants.
export const DEFAULT_SCO_TRIGGER = 0.86
export const DEFAULT_PER_PERSON_PAYMENT_LIMIT = 155000
export const DEFAULT_SEQUESTRATION_PCT = 0.054

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
}

// Resolve program parameters for a crop year. An exact-year row wins; otherwise
// we use the most recent configured year at or below the requested year, and
// failing that the earliest configured year. With no rows at all, fall back to
// the built-in defaults.
export function resolveProgramYearConfig(
  cropYear: number,
  configs: readonly ProgramYearConfig[],
): ResolvedProgramConfig {
  const exact = configs.find((c) => c.crop_year === cropYear)
  if (exact) {
    return {
      requestedYear: cropYear,
      sourceYear: exact.crop_year,
      isFallback: false,
      scoTrigger: Number(exact.sco_trigger),
      perPersonPaymentLimit: Number(exact.per_person_payment_limit),
      sequestrationPct: Number(exact.sequestration_pct),
    }
  }

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
    }
  }

  return {
    requestedYear: cropYear,
    sourceYear: src.crop_year,
    isFallback: true,
    scoTrigger: Number(src.sco_trigger),
    perPersonPaymentLimit: Number(src.per_person_payment_limit),
    sequestrationPct: Number(src.sequestration_pct),
  }
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
