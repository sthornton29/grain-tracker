// The Season Summary's per-crop rows — one pure builder so the on-screen table,
// its export, and the tests see the same numbers. A crop designated double-crop
// that has BOTH croppings planted that season gets its combined row plus
// Full-season and Double-crop sub-rows; the sub-rows partition the combined
// row exactly (a planting is entirely one cropping — no allocation math).

import { croppingOf, CROPPING_LABEL, type Cropping } from '@/lib/plantings'
import type { ExclusionReason } from '@/lib/yields'

export type SeasonCropRow = {
  cropId: string
  cropName: string
  /** Cotton is lbs-native — its production/yield live in the Cotton table. */
  isCotton: boolean
  fullSeasonAcres: number
  doubleCropAcres: number
  totalAcres: number
  irrigatedAcres: number
  drylandAcres: number
  /** Production of the harvested, included fields only. */
  dryBu: number
  /** Acres of the harvested, included fields only — the yield denominator. */
  harvestedAcres: number
  /** Per cohort — present (as sub-rows) only when the crop has both croppings. */
  cohorts: Array<{ cropping: Cropping; label: string; acres: number; dryBu: number; harvestedAcres: number }> | null
}

export function seasonCropRows(args: {
  plantings: ReadonlyArray<{
    id: string; field_id: string; crop_id: string; season_year: number
    planted_acres: number | string | null; irrigated_acres?: number | string | null; dryland_acres?: number | string | null
  }>
  cropName: (cropId: string) => string
  isCotton: (cropId: string) => boolean
  dryBuFor: (fieldId: string, cropId: string, seasonYear: number) => number
  excluded: ReadonlyMap<string, ExclusionReason>
  doubleCropIds: ReadonlySet<string>
}): SeasonCropRow[] {
  type Acc = SeasonCropRow & { byCohort: Map<Cropping, { acres: number; dryBu: number; harvestedAcres: number }> }
  const m = new Map<string, Acc>()
  for (const p of args.plantings) {
    let agg = m.get(p.crop_id)
    if (!agg) {
      agg = {
        cropId: p.crop_id, cropName: args.cropName(p.crop_id), isCotton: args.isCotton(p.crop_id),
        fullSeasonAcres: 0, doubleCropAcres: 0, totalAcres: 0, irrigatedAcres: 0, drylandAcres: 0,
        dryBu: 0, harvestedAcres: 0, cohorts: null, byCohort: new Map(),
      }
      m.set(p.crop_id, agg)
    }
    const acres = Number(p.planted_acres) || 0
    const cropping = croppingOf(p, args.doubleCropIds)
    agg.totalAcres += acres
    agg.irrigatedAcres += Number(p.irrigated_acres) || 0
    agg.drylandAcres += Number(p.dryland_acres) || 0
    if (cropping === 'double_crop') agg.doubleCropAcres += acres
    else agg.fullSeasonAcres += acres
    const c = agg.byCohort.get(cropping) ?? { acres: 0, dryBu: 0, harvestedAcres: 0 }
    c.acres += acres
    // Production + yield count only harvested, non-in-progress fields.
    if (!args.excluded.has(p.id)) {
      const bu = args.dryBuFor(p.field_id, p.crop_id, p.season_year)
      agg.dryBu += bu
      agg.harvestedAcres += acres
      c.dryBu += bu
      c.harvestedAcres += acres
    }
    agg.byCohort.set(cropping, c)
  }
  return [...m.values()]
    .map(({ byCohort, ...row }) => ({
      ...row,
      cohorts: byCohort.size > 1
        ? (['full_season', 'double_crop'] as Cropping[]).map((k) => ({ cropping: k, label: CROPPING_LABEL[k], ...byCohort.get(k)! }))
        : null,
    }))
    .sort((a, b) => a.cropName.localeCompare(b.cropName))
}

/** Yield of a row or cohort — bu over the harvested acres; null before any field finishes. */
export function seasonYieldOf(r: { dryBu: number; harvestedAcres: number }): number | null {
  return r.harvestedAcres > 0 ? r.dryBu / r.harvestedAcres : null
}
