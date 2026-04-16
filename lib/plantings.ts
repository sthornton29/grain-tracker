import type { FieldPlanting } from '@/lib/types'

// A Soybean planting is double-crop when the same field + season_year also
// has a Wheat or Canola planting.
// Returns a Set of planting ids that are double-crop soybeans.
export function buildDoubleCropSoySet(
  plantings: FieldPlanting[],
  cropsById: Map<string, { name: string }>,
): Set<string> {
  const hasPredecessor = new Set<string>()
  for (const p of plantings) {
    const n = cropsById.get(p.crop_id)?.name
    if (n === 'Wheat' || n === 'Canola') hasPredecessor.add(`${p.field_id}|${p.season_year}`)
  }
  const result = new Set<string>()
  for (const p of plantings) {
    const n = cropsById.get(p.crop_id)?.name
    if (n !== 'Soybean') continue
    if (hasPredecessor.has(`${p.field_id}|${p.season_year}`)) result.add(p.id)
  }
  return result
}
