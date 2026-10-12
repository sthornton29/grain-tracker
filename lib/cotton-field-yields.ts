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

/** "est." / "part est." / null — the chip text for a lint figure. */
export function lintEstimateChip(basis: LintBasis | null | undefined): 'est.' | 'part est.' | null {
  if (basis === 'estimated_turnout') return 'est.'
  if (basis === 'mixed') return 'part est.'
  return null
}
