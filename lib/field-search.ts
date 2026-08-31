// Field-picker search + farm grouping — the pure half of
// components/field-picker.tsx.
//
// One search box filters by FIELD name AND FARM name: "saun" finds every
// field on Big Saunders, and a field called "Saunders East" matches wherever
// it lives. The farm→field grouping survives filtering so a match always
// shows which farm it belongs to (two farms often have a "Field 12").

export type FieldSearchField = {
  id: string
  name_or_number: string
  farm_id: string | null
}

export type FieldSearchFarm = {
  id: string
  name: string
}

export type FieldGroup = {
  farmId: string | null
  /** Display label — the farm's name, or 'No farm' for unassigned fields. */
  farmName: string
  fields: FieldSearchField[]
}

const NO_FARM_LABEL = 'No farm'

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * Group fields by farm (farms alphabetical, unassigned last), filtered by the
 * query. A field stays when the query matches its own name OR its farm's name
 * — so typing a farm keeps that whole farm's fields, and typing a field name
 * finds it under whichever farm it belongs to. Empty query = everything.
 */
export function groupFieldsByFarm(
  fields: FieldSearchField[],
  farms: FieldSearchFarm[],
  query: string,
): FieldGroup[] {
  const q = norm(query)
  const farmById = new Map(farms.map((f) => [f.id, f]))
  const byFarm = new Map<string, FieldSearchField[]>()
  for (const f of fields) {
    const farmName = f.farm_id ? farmById.get(f.farm_id)?.name ?? NO_FARM_LABEL : NO_FARM_LABEL
    if (q && !norm(f.name_or_number).includes(q) && !norm(farmName).includes(q)) continue
    const key = f.farm_id ?? ''
    const list = byFarm.get(key) ?? []
    list.push(f)
    byFarm.set(key, list)
  }
  return [...byFarm.entries()]
    .map(([farmId, fs]) => ({
      farmId: farmId || null,
      farmName: farmId ? farmById.get(farmId)?.name ?? NO_FARM_LABEL : NO_FARM_LABEL,
      fields: fs,
    }))
    .sort((a, b) => {
      // Unassigned fields sink to the bottom; farms alphabetical.
      if (a.farmId === null) return b.farmId === null ? 0 : 1
      if (b.farmId === null) return -1
      return a.farmName.localeCompare(b.farmName)
    })
}
