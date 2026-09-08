// Crop-year options for the MARKETING family of pages (Marketing Dashboard,
// Revenue Projections, Income Sensitivity, Cash Flow).
//
// Marketing runs ahead of planting: next year's wheat is sold and the
// year-after's corn is hedged before any field_plantings row exists. So the
// selector cannot be derived from plantings alone — it is the union of every
// year anything is on file for (plantings, contracts, hedges, assumptions —
// including assumed acres, 081) PLUS the current year and the next two, so a
// future year is always reachable to start planning in. Newest first.
//
// The operational pages (loads, settlements, …) keep
// lib/plantings.ts cropYearOptionsFromPlantings: their years are facts.

export function marketingCropYearOptions(args: {
  plantingYears?: ReadonlyArray<number | null | undefined>
  contractYears?: ReadonlyArray<number | null | undefined>
  hedgeYears?: ReadonlyArray<number | null | undefined>
  assumptionYears?: ReadonlyArray<number | null | undefined>
  /** Any other years to keep selectable (e.g. the current selection, policy years). */
  extraYears?: ReadonlyArray<number | null | undefined>
  /** The current calendar year (injectable for tests). */
  now?: number
  /** How many years past `now` to always offer (default 2). */
  horizon?: number
}): number[] {
  const years = new Set<number>()
  const add = (list?: ReadonlyArray<number | null | undefined>) => {
    for (const y of list ?? []) if (y != null && Number.isFinite(y)) years.add(Number(y))
  }
  add(args.plantingYears)
  add(args.contractYears)
  add(args.hedgeYears)
  add(args.assumptionYears)
  add(args.extraYears)
  const now = args.now ?? new Date().getFullYear()
  const horizon = args.horizon ?? 2
  for (let y = now; y <= now + horizon; y++) years.add(y)
  return [...years].sort((a, b) => b - a)
}
