// ARC/PLC Decision Aid — the pure comparison logic behind the by-crop verdict
// and the per-farm recommendation, kept out of the component so it can be
// unit-tested and so the screen and the export say the same words.
//
// The engine math (PLC rate, ARC-CO county revenue) lives in
// lib/government-payments.ts; this file only compares its outputs.

export const TOSS_UP_BAND_PER_ACRE = 2

export type Favors = 'PLC' | 'ARC' | 'TOSS' | null

// Per farm × commodity: which program pays more. Inside the toss-up band the
// projection's precision cannot separate them — and "$0 vs $0" is the common
// case at prices above both triggers, which must never read as "Favors PLC".
export function farmVerdict(plcNet: number | null, arcNet: number | null, baseAcres: number): Favors {
  if (plcNet != null && arcNet != null) {
    if (baseAcres > 0 && Math.abs(arcNet - plcNet) / baseAcres < TOSS_UP_BAND_PER_ACRE) return 'TOSS'
    if (baseAcres <= 0 && arcNet === plcNet) return 'TOSS'
    return plcNet > arcNet ? 'PLC' : 'ARC'
  }
  // One side unknown: the known side "wins" only if it actually pays — a
  // $0 against an unknown is no recommendation at all.
  if (plcNet != null) return plcNet > 0 ? 'PLC' : null
  if (arcNet != null) return arcNet > 0 ? 'ARC' : null
  return null
}

// The marketing-year price below which ARC-CO starts paying, at the expected
// county yield: guarantee ÷ expected county yield. null without county figures.
export function arcTriggerPrice(guaranteePerAcre: number, expectedCountyYield: number): number | null {
  if (!(expectedCountyYield > 0)) return null
  return guaranteePerAcre / expectedCountyYield
}

export type ComparableFarm = {
  baseAcres: number
  plcNet: number | null
  arcNet: number | null
  hasMya: boolean
  hasBenchmark: boolean
  arcTriggerPrice: number | null
}

export type ProgramTotals = {
  plcTotal: number | null // sum over the farms with a PLC number (null when none)
  arcTotal: number | null // sum over the farms with an ARC-CO number (null when none)
  diffPerAcre: number | null // ARC − PLC per base acre, over the farms with BOTH
  verdict: 'PLC' | 'ARC' | 'TOSS' | null
  comparedFarms: number
  arcNoBenchmark: number // ARC-CO side missing because the county has no benchmark row
  arcNoMya: number // ARC-CO side missing because there is no marketing-year price
  plcNoMya: number
  arcTriggerHigh: number | null // the highest ARC-CO trigger price across the farms
}

// Every-farm-PLC vs every-farm-ARC-CO for one crop. A farm that one side
// cannot compute is left out of THAT side's total and out of the verdict, and
// counted by cause — one county without a benchmark row never blanks the
// whole crop (2026-10-28: Cottontown's missing wheat row hid all 19 farms'
// ARC-CO total behind "needs the marketing-year price").
export function compareProgramTotals(farms: readonly ComparableFarm[]): ProgramTotals {
  const plcRows = farms.filter((f) => f.plcNet != null)
  const arcRows = farms.filter((f) => f.arcNet != null)
  const both = farms.filter((f) => f.plcNet != null && f.arcNet != null)
  const bothAcres = both.reduce((s, f) => s + f.baseAcres, 0)
  const diffPerAcre = both.length > 0 && bothAcres > 0
    ? both.reduce((s, f) => s + ((f.arcNet ?? 0) - (f.plcNet ?? 0)), 0) / bothAcres
    : null
  const verdict = diffPerAcre == null ? null
    : Math.abs(diffPerAcre) < TOSS_UP_BAND_PER_ACRE ? 'TOSS'
    : diffPerAcre > 0 ? 'ARC' : 'PLC'
  const triggers = farms.map((f) => f.arcTriggerPrice).filter((t): t is number => t != null)
  return {
    plcTotal: plcRows.length > 0 ? plcRows.reduce((s, f) => s + (f.plcNet ?? 0), 0) : null,
    arcTotal: arcRows.length > 0 ? arcRows.reduce((s, f) => s + (f.arcNet ?? 0), 0) : null,
    diffPerAcre,
    verdict,
    comparedFarms: both.length,
    arcNoBenchmark: farms.filter((f) => f.arcNet == null && !f.hasBenchmark).length,
    arcNoMya: farms.filter((f) => f.arcNet == null && f.hasBenchmark && !f.hasMya).length,
    plcNoMya: farms.filter((f) => f.plcNet == null).length,
    arcTriggerHigh: triggers.length > 0 ? Math.max(...triggers) : null,
  }
}

// ---------- Plain-language labels shared by the screen and the export ----------

// Why a farm's ARC-CO side has no number. "needs the marketing-year price" is
// the same phrase the PLC side uses for the same gap; a missing county
// benchmark row is a different fix (Settings → ARC-CO Benchmarks).
export function arcMissingText(r: { hasMya: boolean; hasBenchmark: boolean; county: string | null }): string {
  if (!r.hasMya) return 'needs the marketing-year price'
  if (!r.hasBenchmark) return r.county == null ? 'farm has no county' : 'no county benchmark row'
  return ''
}

// Per-farm recommendation. Inside the toss-up band the two programs are too
// close to call; when neither pays at this price, say that outright.
export function recommendationText(r: { favors: Favors; plcNet: number | null; arcNet: number | null }): string {
  if (r.favors === 'PLC') return 'Favors PLC'
  if (r.favors === 'ARC') return 'Favors ARC-CO'
  if (r.favors === 'TOSS') return r.plcNet === 0 && r.arcNet === 0 ? 'Neither pays at this price' : 'Toss-up'
  return '—'
}

// The farms a crop's totals could not count, by cause.
export function notCountedText(s: { arcNoBenchmark: number; arcNoMya: number; plcNoMya: number }): string {
  const parts: string[] = []
  if (s.arcNoBenchmark > 0) parts.push(`${s.arcNoBenchmark} ARC-CO: no county benchmark`)
  if (s.arcNoMya > 0 || s.plcNoMya > 0) parts.push(`${Math.max(s.arcNoMya, s.plcNoMya)}: no marketing-year price`)
  return parts.join('; ')
}
