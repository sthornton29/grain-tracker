// Classification of an extracted planting row (AI plantings upload) against the
// matched existing planting — INCLUDING varieties. A row identical except for
// its varieties is an UPDATE that adds the missing variety rows on save, never
// Unchanged; a planting with no varieties yet that gains one in the upload is
// the canonical case. Pure so the New/Update/Unchanged rules are unit-tested.

import { varietyKey } from '@/lib/variety-resolution'

export type UploadPlantingFacts = {
  planted_acres: number | null // null = not provided in the document
  irrigated_acres: number | null
  planting_date: string // '' = not provided
  notes: string // '' = not provided
  /** Non-blank variety names on the row, AFTER resolution where decided
   *  (raw spelling while a possible match is still undecided — the key-based
   *  comparison is stable across that, since variants share a key). */
  varietyNames: string[]
}

export type ExistingPlantingFacts = {
  planted_acres: number
  irrigated_acres: number
  planting_date: string | null
  notes: string | null
  /** The planting's CURRENT variety names (possibly empty). */
  varietyNames: string[]
}

/** Upload variety names not already on the planting, compared by normalized
 *  key and deduped within the upload list (format variants collapse). */
export function varietyAdditions(uploadNames: string[], existingNames: string[]): string[] {
  const have = new Set(existingNames.map(varietyKey).filter(Boolean))
  const out: string[] = []
  for (const n of uploadNames) {
    const k = varietyKey(n)
    if (!k || have.has(k)) continue
    have.add(k)
    out.push(n.trim())
  }
  return out
}

export type PlantingRowClass = {
  kind: 'new' | 'update' | 'unchanged'
  /** A provided scalar (acres/date/notes) differs from the existing planting. */
  scalarChanged: boolean
  /** Upload varieties missing from the existing planting — added on save for
   *  update rows, inserted with the planting for new rows. */
  varietyAdds: string[]
}

/** Classify one upload row against its matched existing planting (null = no
 *  match → new). Preserve-existing: a blank/not-provided value never counts as
 *  a change. Varieties count: any upload variety the planting doesn't already
 *  carry makes the row an update. */
export function classifyPlantingRow(
  row: UploadPlantingFacts,
  existing: ExistingPlantingFacts | null,
): PlantingRowClass {
  const uploadVarieties = varietyAdditions(row.varietyNames, existing?.varietyNames ?? [])
  if (!existing) return { kind: 'new', scalarChanged: false, varietyAdds: uploadVarieties }
  const scalarChanged =
    (row.planted_acres != null && row.planted_acres !== Number(existing.planted_acres)) ||
    (row.irrigated_acres != null && row.irrigated_acres !== (Number(existing.irrigated_acres) || 0)) ||
    (row.planting_date !== '' && row.planting_date !== (existing.planting_date ?? '')) ||
    (row.notes.trim() !== '' && row.notes.trim() !== (existing.notes ?? ''))
  return {
    kind: scalarChanged || uploadVarieties.length > 0 ? 'update' : 'unchanged',
    scalarChanged,
    varietyAdds: uploadVarieties,
  }
}
