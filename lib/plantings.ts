// Double-crop classification — THE one rule, used by every surface that tells
// full-season from double-crop (Yields, Season Summary, Marketing's FS/DC acre
// segments, the breakout grid, the partner API projected yields, the farm link,
// Settings → Fields).
//
// A planting is DOUBLE-CROP when its crop is designated Double-crop in
// Settings → Crops (crops.double_crop) AND the same field has a SPRING-harvest
// planting (e.g. wheat, canola — crops.harvest_category) in the same season
// year. Everything else is full-season. A planting is entirely one cropping, so
// full-season + double-crop always partitions a crop exactly.
//
// Not consulted: field_plantings.paired_planting_id (an explicit pairing the
// farm link writes; informational only), planting dates, acre overlap.
// Archived plantings (archived_at set — removed on the Turnrow Farm side) take
// no part on either side of the rule, and a spring-harvest crop never
// classifies itself as double-crop even when flagged.

export type Cropping = 'full_season' | 'double_crop'

export const CROPPING_LABEL: Record<Cropping, string> = {
  full_season: 'Full-season',
  double_crop: 'Double-crop',
}

type CroppingPlanting = { id: string; field_id: string; season_year: number; crop_id: string; archived_at?: string | null }
type CroppingCrop = { harvest_category: 'fall' | 'spring'; double_crop?: boolean }

/** The ids of the double-crop plantings in `plantings` (see the rule above).
 *  Pass EVERY planting the organization has for the seasons in question — the
 *  spring planting that makes a field double-cropped is usually a different
 *  crop than the one being looked at, so a crop-filtered list cannot classify. */
export function buildDoubleCropSet(
  plantings: ReadonlyArray<CroppingPlanting>,
  cropsById: ReadonlyMap<string, CroppingCrop>,
): Set<string> {
  const hasSpring = new Set<string>()
  for (const p of plantings) {
    if (p.archived_at) continue
    if (cropsById.get(p.crop_id)?.harvest_category === 'spring') {
      hasSpring.add(`${p.field_id}|${p.season_year}`)
    }
  }
  const result = new Set<string>()
  for (const p of plantings) {
    if (p.archived_at) continue
    const crop = cropsById.get(p.crop_id)
    if (!crop?.double_crop || crop.harvest_category === 'spring') continue
    if (hasSpring.has(`${p.field_id}|${p.season_year}`)) result.add(p.id)
  }
  return result
}

/** The cropping of ONE planting, given the set from buildDoubleCropSet. */
export function croppingOf(planting: { id: string }, doubleCropIds: ReadonlySet<string>): Cropping {
  return doubleCropIds.has(planting.id) ? 'double_crop' : 'full_season'
}

/** `${field_id}|${season_year}` → the spring-harvest crop id on that field
 *  that season (the crop a double-crop planting sits behind — "Double-crop
 *  behind Wheat"). With two spring crops on one field the first by crop id
 *  order wins; that is a data-entry oddity, not a case the label serves. */
export function buildSpringCropByFieldYear(
  plantings: ReadonlyArray<CroppingPlanting>,
  cropsById: ReadonlyMap<string, CroppingCrop>,
): Map<string, string> {
  const m = new Map<string, string>()
  for (const p of plantings) {
    if (p.archived_at) continue
    if (cropsById.get(p.crop_id)?.harvest_category !== 'spring') continue
    const key = `${p.field_id}|${p.season_year}`
    const cur = m.get(key)
    if (cur == null || p.crop_id < cur) m.set(key, p.crop_id)
  }
  return m
}

/** Whether a crop × season has BOTH croppings planted — the condition for
 *  showing the Cropping control / tiles / split lines (the same idea as the
 *  breakout grid's breakoutShowsSeason). */
export function cropHasBothCroppings(
  plantings: ReadonlyArray<{ id: string; crop_id: string; season_year: number }>,
  cropId: string,
  seasonYear: number | null,
  doubleCropIds: ReadonlySet<string>,
): boolean {
  let fs = false
  let dc = false
  for (const p of plantings) {
    if (p.crop_id !== cropId) continue
    if (seasonYear != null && p.season_year !== seasonYear) continue
    if (doubleCropIds.has(p.id)) dc = true
    else fs = true
    if (fs && dc) return true
  }
  return false
}

// Crop-year dropdown options sourced from field_plantings.season_year.
// Falls back to current + previous year when no plantings exist.
export function cropYearOptionsFromPlantings(
  seasonYears: ReadonlyArray<number | null | undefined>,
  extra?: number | null | undefined,
): number[] {
  const years = new Set<number>()
  for (const y of seasonYears) if (y != null) years.add(y)
  if (extra != null && Number.isFinite(extra)) years.add(extra)
  if (years.size === 0) {
    const now = new Date().getFullYear()
    years.add(now)
    years.add(now - 1)
  }
  return [...years].sort((a, b) => b - a)
}
