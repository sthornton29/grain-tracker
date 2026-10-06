// Which crop a load off a FIELD should default to, from the field's plantings
// for the load's crop year — the one rule for the AI ticket scan and the New
// Load form. Pure.
//
//   * no grain planting on the field that year → no default ('no_planting';
//     'cotton_only' when the field's only plantings are cotton — cotton goes
//     through Seed Cotton Loads, never the grain load log);
//   * exactly one grain planting → that crop;
//   * one SPRING-harvest planting + one FALL-harvest planting (wheat, then
//     double-crop soybeans) → the LOAD DATE decides: through the last day of
//     SPRING_HARVEST_LAST_MONTH the spring crop, from the first day of the next
//     month the fall crop; the other crop is offered as the alternative;
//   * two or more fall-harvest grain plantings (a split field) → no default
//     ('multiple'); the crops are offered as quick picks.
//
// Then, on a scanned row, the printed commodity takes precedence over the
// field: see resolveTicketCrop — paper evidence is never silently overridden
// by a fuzzy field match, and once the user picks a crop nothing overwrites it.

import { isCottonCrop } from '@/lib/marketing'

/** Loads dated through the last day of this month (1–12) go to the spring
 *  crop of a spring + fall pair; the next month onward go to the fall crop. */
export const SPRING_HARVEST_LAST_MONTH = 7

export type CropDefaultReason =
  | 'single'
  | 'spring_fall_by_date'
  | 'no_planting'
  | 'cotton_only'
  | 'multiple'
  | 'no_field'

export type FieldCropDefault = {
  cropId: string | null
  reason: CropDefaultReason
  /** The other crop(s) the field carries that year — the switch offer on a
   *  spring/fall pair, the quick picks on a split field. */
  alternatives: string[]
  /** Every grain crop planted on the field that year (ticket-match universe). */
  fieldCropIds: string[]
  /** Set on a spring/fall pair: which side the date landed on. */
  season?: 'spring' | 'fall'
  /** The spring crop of the pair (for "Double-crop behind Wheat"). */
  springCropId?: string
}

type PlantingLike = { field_id: string; crop_id: string; season_year: number; archived_at?: string | null }
type CropLike = { id: string; name: string; harvest_category: 'fall' | 'spring' }

export function cropForFieldOnDate(args: {
  plantings: ReadonlyArray<PlantingLike>
  crops: ReadonlyArray<CropLike> | ReadonlyMap<string, CropLike>
  fieldId: string | null | undefined
  cropYear: number | null | undefined
  /** YYYY-MM-DD (or null — a spring/fall pair then cannot be decided). */
  date: string | null | undefined
}): FieldCropDefault {
  if (!args.fieldId) return { cropId: null, reason: 'no_field', alternatives: [], fieldCropIds: [] }
  const cropById: ReadonlyMap<string, CropLike> = args.crops instanceof Map
    ? args.crops
    : new Map((args.crops as ReadonlyArray<CropLike>).map((c) => [c.id, c]))
  const onField = args.plantings.filter(
    (p) => p.field_id === args.fieldId && (args.cropYear == null || p.season_year === args.cropYear) && !p.archived_at,
  )
  const grainCropIds: string[] = []
  let sawCotton = false
  for (const p of onField) {
    const c = cropById.get(p.crop_id)
    if (!c) continue
    if (isCottonCrop(c.name)) { sawCotton = true; continue }
    if (!grainCropIds.includes(c.id)) grainCropIds.push(c.id)
  }
  if (grainCropIds.length === 0) {
    return { cropId: null, reason: sawCotton ? 'cotton_only' : 'no_planting', alternatives: [], fieldCropIds: [] }
  }
  if (grainCropIds.length === 1) {
    return { cropId: grainCropIds[0], reason: 'single', alternatives: [], fieldCropIds: grainCropIds }
  }
  const spring = grainCropIds.filter((id) => cropById.get(id)?.harvest_category === 'spring')
  const fall = grainCropIds.filter((id) => cropById.get(id)?.harvest_category !== 'spring')
  if (spring.length === 1 && fall.length === 1) {
    const month = args.date && /^\d{4}-\d{2}/.test(args.date) ? Number(args.date.slice(5, 7)) : null
    if (month == null) {
      return { cropId: null, reason: 'multiple', alternatives: grainCropIds, fieldCropIds: grainCropIds, springCropId: spring[0] }
    }
    const season: 'spring' | 'fall' = month <= SPRING_HARVEST_LAST_MONTH ? 'spring' : 'fall'
    const pick = season === 'spring' ? spring[0] : fall[0]
    const other = season === 'spring' ? fall[0] : spring[0]
    return { cropId: pick, reason: 'spring_fall_by_date', alternatives: [other], fieldCropIds: grainCropIds, season, springCropId: spring[0] }
  }
  return { cropId: null, reason: 'multiple', alternatives: grainCropIds, fieldCropIds: grainCropIds }
}

/** Where a scanned row's crop came from. UI state only — never stored. */
export type CropProvenance = 'ticket' | 'field_planting' | 'user' | 'fallback'

export type TicketCropResolution = {
  cropId: string
  provenance: CropProvenance
  /** The printed commodity names a crop the field is not planted to. The
   *  ticket's crop stays selected; the row needs review with the field's crop
   *  on offer. */
  conflict: { ticketCropId: string; fieldCropIds: string[] } | null
}

/**
 * Precedence on a scanned row:
 *   1. printed commodity matching one of the field's plantings → the ticket;
 *   2. nothing printed / no confident match → the field's planting default;
 *   3. printed commodity CONFLICTING with the field's plantings → the ticket
 *      stays selected and the row is flagged (paper beats a fuzzy field match,
 *      but never silently);
 *   4. otherwise → whatever the caller fell back to before (blank, or the
 *      printed match when the row has no field).
 */
export function resolveTicketCrop(args: {
  /** The crop the printed commodity fuzzy-matched, or null. */
  printedCropId: string | null
  /** cropForFieldOnDate for the row's field × crop year × date; null when the
   *  row has no field (a bin source, or an unmatched field). */
  fieldDefault: FieldCropDefault | null
  /** The pre-existing fallback (the previous page behavior). */
  fallbackCropId?: string | null
}): TicketCropResolution {
  const printed = args.printedCropId
  const fd = args.fieldDefault
  const fieldCropIds = fd?.fieldCropIds ?? []
  if (printed) {
    if (fieldCropIds.includes(printed)) return { cropId: printed, provenance: 'ticket', conflict: null }
    if (fieldCropIds.length > 0) return { cropId: printed, provenance: 'ticket', conflict: { ticketCropId: printed, fieldCropIds } }
    // No field plantings to compare against: the ticket stands on its own.
    return { cropId: printed, provenance: 'ticket', conflict: null }
  }
  if (fd?.cropId) return { cropId: fd.cropId, provenance: 'field_planting', conflict: null }
  return { cropId: args.fallbackCropId ?? '', provenance: 'fallback', conflict: null }
}

// ---------------------------------------------------------------------------
// Review copy — worded once for the scan page and the New Load form.
// ---------------------------------------------------------------------------

export function fieldDefaultNote(d: FieldCropDefault, cropName: (id: string) => string, cropYear: number | null): string | null {
  switch (d.reason) {
    case 'single':
      return `from field (${cropYear ?? ''} planting)`.replace('( ', '(')
    case 'spring_fall_by_date': {
      const picked = cropName(d.cropId!)
      const other = cropName(d.alternatives[0])
      const monthName = new Date(Date.UTC(2000, SPRING_HARVEST_LAST_MONTH - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
      return d.season === 'fall'
        ? `${picked}, double-crop behind ${other} (date is after ${monthName})`
        : `${picked} (date is ${monthName} or earlier; ${other} follows it)`
    }
    case 'no_planting':
      return 'No planting recorded for this field this crop year.'
    case 'cotton_only':
      return 'Planted to cotton. Use Seed Cotton Loads.'
    case 'multiple':
      return 'This field has more than one crop planted this year — pick one.'
    case 'no_field':
      return null
  }
}

export function cropConflictNote(args: { ticketCrop: string; fieldName: string; fieldCrops: string[]; cropYear: number | null }): string {
  const planted = args.fieldCrops.join(' and ')
  return `Ticket says ${args.ticketCrop}, but ${args.fieldName} is planted to ${planted}${args.cropYear != null ? ` in ${args.cropYear}` : ''}.`
}
