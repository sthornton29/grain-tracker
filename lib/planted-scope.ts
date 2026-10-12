// Planted scope — THE one rule for "which farms and fields count for crop X
// in crop year Y" (2026-10-12): the fields with a live (unarchived) planting
// of that crop that season, and the farms those fields sit on. Every
// crop-filtered farm/field picker, filter and list narrows through here, so
// Settings → Plantings is the single source of what shows up — a farm with no
// cotton this year is not offered on the cotton pages, and last year's wheat
// fields never appear under this year's wheat.
//
// The pure half; the pages hand in the plantings they already load.

export type PlantedScopePlanting = {
  field_id: string
  crop_id: string
  season_year: number
  archived_at?: string | null
}

export type PlantedScopeField = { id: string; farm_id: string | null }
export type PlantedScopeFarm = { id: string }

/**
 * The ids of the fields with a live planting of one of `cropIds` in
 * `seasonYear`. `cropIds` as a string is a single crop, null is any crop
 * ("All crops" on a filter bar); `seasonYear` null means any season (the
 * load form before a crop year is picked). Archived plantings (removed on
 * the Turnrow Farm side) never count.
 */
export function plantedFieldIds(
  plantings: ReadonlyArray<PlantedScopePlanting>,
  opts: { cropIds: ReadonlySet<string> | string | null; seasonYear: number | null },
): Set<string> {
  const crops = opts.cropIds == null ? null : typeof opts.cropIds === 'string' ? new Set([opts.cropIds]) : opts.cropIds
  const out = new Set<string>()
  for (const p of plantings) {
    if (p.archived_at) continue
    if (crops && !crops.has(p.crop_id)) continue
    if (opts.seasonYear != null && p.season_year !== opts.seasonYear) continue
    out.add(p.field_id)
  }
  return out
}

export type PlantedScope<F extends PlantedScopeField, M extends PlantedScopeFarm> = {
  /** The fields in scope, in the caller's order. */
  fields: F[]
  /** The farms with at least one field in scope, in the caller's order. */
  farms: M[]
  /** True once a planted set was applied (false = nothing to narrow by yet, everything shown). */
  narrowed: boolean
}

/**
 * Narrow `fields` to the planted set and `farms` to the farms those fields
 * sit on. `plantedFieldIds` null = don't narrow (plantings still loading, or
 * no crop chosen) — every field and farm comes back as-is.
 *
 * `keep` is the value already saved or selected (an existing load's field,
 * an edit form's farm): it stays in scope even without a planting, so an
 * edit never silently loses what the record already says. Callers show a
 * note beside a kept value instead (see `keptWithoutPlanting`).
 */
export function scopeToPlanted<F extends PlantedScopeField, M extends PlantedScopeFarm>(args: {
  fields: ReadonlyArray<F>
  farms: ReadonlyArray<M>
  plantedFieldIds: ReadonlySet<string> | null
  keep?: { fieldId?: string | null; farmId?: string | null }
}): PlantedScope<F, M> {
  const planted = args.plantedFieldIds
  if (planted == null) return { fields: [...args.fields], farms: [...args.farms], narrowed: false }
  const keepField = args.keep?.fieldId || null
  const keepFarm = args.keep?.farmId || null
  const fields = args.fields.filter((f) => planted.has(f.id) || f.id === keepField)
  const farmIds = new Set<string>()
  for (const f of fields) if (f.farm_id) farmIds.add(f.farm_id)
  if (keepFarm) farmIds.add(keepFarm)
  const farms = args.farms.filter((m) => farmIds.has(m.id))
  return { fields, farms, narrowed: true }
}

/** Whether a kept (already saved) field is in the picker only because it was kept — no planting backs it. */
export function keptWithoutPlanting(fieldId: string | null | undefined, plantedFieldIds: ReadonlySet<string> | null): boolean {
  if (!fieldId || plantedFieldIds == null) return false
  return !plantedFieldIds.has(fieldId)
}
