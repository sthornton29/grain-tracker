// Double-crop classification. A field + season_year that has any SPRING-harvest
// planting (e.g. wheat, canola) is double-cropped; the *second* crop on that
// field counts as a double-crop only when its crop is flagged double_crop in
// settings (e.g. soybeans after wheat). Returns the set of those planting ids.
export function buildDoubleCropSet(
  plantings: ReadonlyArray<{ id: string; field_id: string; season_year: number; crop_id: string }>,
  cropsById: Map<string, { harvest_category: 'fall' | 'spring'; double_crop?: boolean }>,
): Set<string> {
  const hasSpring = new Set<string>()
  for (const p of plantings) {
    if (cropsById.get(p.crop_id)?.harvest_category === 'spring') {
      hasSpring.add(`${p.field_id}|${p.season_year}`)
    }
  }
  const result = new Set<string>()
  for (const p of plantings) {
    if (!cropsById.get(p.crop_id)?.double_crop) continue
    if (hasSpring.has(`${p.field_id}|${p.season_year}`)) result.add(p.id)
  }
  return result
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
