// Yields on the cotton intake pages (2026-10-12): the Seed Cotton Loads and
// Gin Receipts pages show pounds per acre wherever they show a field or a
// farm-wide total. The per-field numbers come from the ONE cotton yield model
// (lib/cotton-yield-sources `yieldFor` → lib/cotton `cottonPlantingYield`):
// seed cotton lbs ÷ planted acres, and lint = ginned lint + the turnout
// estimate on seed cotton still on the yard. This module only rolls those
// per-field figures up to the farm.

import type { CottonPlantingYield, LintBasis } from '@/lib/cotton'

export type CottonFieldYieldRow = {
  fieldId: string
  /** Planted cotton acres on the field this crop year (all its cotton plantings). */
  acres: number
  y: CottonPlantingYield
}

export type CottonFarmYield = {
  /** Cotton plantings this crop year. */
  fields: number
  /** Plantings with any seed cotton hauled or ginned. */
  fieldsPicked: number
  acresPlanted: number
  /** Acres of the plantings that have cotton off them — the per-acre denominator. */
  acresPicked: number
  seedLbs: number
  lintLbs: number
  actualLintLbs: number
  estimatedLintLbs: number
  yardSeedLbs: number
  /** seedLbs ÷ acresPicked. */
  seedPerAcre: number | null
  /** lintLbs ÷ acresPicked. */
  lintPerAcre: number | null
  lintBasis: LintBasis | null
  /** The turnout phrase behind the estimate ("41.5% from your ginned cotton"), when any lint is estimated. */
  turnoutLabel: string | null
}

/** lbs ÷ acres, null when either side is missing. */
export function perAcre(lbs: number | null | undefined, acres: number | null | undefined): number | null {
  if (lbs == null || acres == null || !(Number(acres) > 0)) return null
  return Number(lbs) / Number(acres)
}

/**
 * Farm-wide seed cotton and lint per acre over the fields that have cotton
 * off them. A field nothing has come off yet is counted in acresPlanted but
 * NOT in the per-acre denominator — an unpicked field is not a zero yield.
 */
export function summarizeCottonFieldYields(rows: ReadonlyArray<CottonFieldYieldRow>): CottonFarmYield {
  let acresPlanted = 0, acresPicked = 0, fieldsPicked = 0
  let seedLbs = 0, lintLbs = 0, actualLintLbs = 0, estimatedLintLbs = 0, yardSeedLbs = 0
  let turnoutLabel: string | null = null
  for (const r of rows) {
    acresPlanted += r.acres
    const picked = r.y.loadCount > 0 || r.y.receiptCount > 0 || r.y.seedLbs > 0 || r.y.actualLintLbs > 0
    if (!picked) continue
    fieldsPicked += 1
    acresPicked += r.acres
    seedLbs += r.y.seedLbs
    lintLbs += r.y.lintLbs
    actualLintLbs += r.y.actualLintLbs
    estimatedLintLbs += r.y.estimatedLintLbs
    yardSeedLbs += r.y.yardSeedLbs
    if (r.y.estimatedLintLbs > 0 && !turnoutLabel) turnoutLabel = r.y.turnout.label
  }
  const lintBasis: LintBasis | null = lintLbs <= 0 ? null : estimatedLintLbs <= 0 ? 'actual' : actualLintLbs <= 0 ? 'estimated_turnout' : 'mixed'
  return {
    fields: rows.length, fieldsPicked, acresPlanted, acresPicked,
    seedLbs, lintLbs, actualLintLbs, estimatedLintLbs, yardSeedLbs,
    seedPerAcre: perAcre(seedLbs, acresPicked),
    lintPerAcre: perAcre(lintLbs, acresPicked),
    lintBasis, turnoutLabel,
  }
}

export type CottonYieldBucket = {
  /** Planted acres of the counted fields in this bucket. */
  acres: number
  lintLbs: number
  /** lintLbs ÷ acres. */
  lintPerAcre: number | null
  lintBasis: LintBasis | null
}

export type CottonCropProgress = {
  /** Seed cotton pounds hauled off every field in view (picked, whether ginned or not). */
  seedLbs: number
  /** Seed cotton on gin receipts (seed − yard). */
  ginnedSeedLbs: number
  yardSeedLbs: number
  /** ginnedSeedLbs ÷ seedLbs, 0–100 (0 with nothing hauled). */
  pctGinned: number
  /** Counted fields whose lint is all on gin receipts — the actual yield. */
  ginned: CottonYieldBucket
  /** Counted fields with seed cotton still on the yard — lint estimated at the turnout (part est. once some is ginned). */
  unginned: CottonYieldBucket
  /** The turnout phrase behind the unginned estimate, when there is one. */
  turnoutLabel: string | null
}

const bucketOf = (acres: number, lintLbs: number, actual: number, est: number): CottonYieldBucket => ({
  acres, lintLbs,
  lintPerAcre: perAcre(lintLbs, acres),
  lintBasis: lintLbs <= 0 ? null : est <= 0 ? 'actual' : actual <= 0 ? 'estimated_turnout' : 'mixed',
})

/**
 * The cotton crop card's second bar and its yield split. Percent ginned is in
 * POUNDS of seed cotton (ginning is a pounds matter — a partly ginned field
 * contributes what is on receipts), over every field handed in. The yield
 * split is over the COUNTED fields only (`counted` = harvest complete, the
 * same fields behind the headline average): the ginned bucket holds fields
 * with nothing left to estimate, the unginned bucket the rest, so the two
 * acre-weighted together equal the headline.
 */
export function summarizeCottonCropProgress(rows: ReadonlyArray<CottonFieldYieldRow & { counted: boolean }>): CottonCropProgress {
  let seedLbs = 0, yardSeedLbs = 0
  let gAcres = 0, gLint = 0
  let uAcres = 0, uLint = 0, uActual = 0, uEst = 0
  let turnoutLabel: string | null = null
  for (const r of rows) {
    seedLbs += r.y.seedLbs
    yardSeedLbs += r.y.yardSeedLbs
    if (!r.counted) continue
    if (r.y.estimatedLintLbs > 0) {
      uAcres += r.acres; uLint += r.y.lintLbs; uActual += r.y.actualLintLbs; uEst += r.y.estimatedLintLbs
      if (!turnoutLabel) turnoutLabel = r.y.turnout.label
    } else {
      gAcres += r.acres; gLint += r.y.lintLbs
    }
  }
  const ginnedSeedLbs = Math.max(0, seedLbs - yardSeedLbs)
  return {
    seedLbs, ginnedSeedLbs, yardSeedLbs,
    pctGinned: seedLbs > 0 ? (ginnedSeedLbs / seedLbs) * 100 : 0,
    ginned: bucketOf(gAcres, gLint, gLint, 0),
    unginned: bucketOf(uAcres, uLint, uActual, uEst),
    turnoutLabel,
  }
}

/** "est." / "part est." / null — the chip text for a lint figure. */
export function lintEstimateChip(basis: LintBasis | null | undefined): 'est.' | 'part est.' | null {
  if (basis === 'estimated_turnout') return 'est.'
  if (basis === 'mixed') return 'part est.'
  return null
}
