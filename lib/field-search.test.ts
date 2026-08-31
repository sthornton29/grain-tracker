// Field-picker search — the pure filter + farm grouping behind
// components/field-picker.tsx.
//
// Behavior pinned:
//   * search matches FIELD name AND FARM name — "saun" finds every field on
//     Big Saunders, a field's own name finds it wherever it lives;
//   * the farm→field grouping survives filtering (matches always show their
//     farm), farms alphabetical, unassigned fields last;
//   * empty query returns everything; no matches returns no groups.

import { describe, expect, it } from 'vitest'
import { groupFieldsByFarm } from './field-search'

const farms = [
  { id: 'fa-clear', name: 'Clearwater' },
  { id: 'fa-saun', name: 'Big Saunders' },
]

const fields = [
  { id: 'f-1', name_or_number: 'Field 12', farm_id: 'fa-saun' },
  { id: 'f-2', name_or_number: 'North 80', farm_id: 'fa-saun' },
  { id: 'f-3', name_or_number: 'Field 12', farm_id: 'fa-clear' },
  { id: 'f-4', name_or_number: 'River Bottom', farm_id: 'fa-clear' },
  { id: 'f-5', name_or_number: 'Home Place', farm_id: null },
]

describe('groupFieldsByFarm', () => {
  it('empty query: everything, farms alphabetical, unassigned last', () => {
    const groups = groupFieldsByFarm(fields, farms, '')
    expect(groups.map((g) => g.farmName)).toEqual(['Big Saunders', 'Clearwater', 'No farm'])
    expect(groups[0].fields.map((f) => f.id)).toEqual(['f-1', 'f-2'])
    expect(groups[2].fields.map((f) => f.id)).toEqual(['f-5'])
  })

  it('a farm-name fragment keeps that whole farm ("saun" → Big Saunders)', () => {
    const groups = groupFieldsByFarm(fields, farms, 'saun')
    expect(groups).toHaveLength(1)
    expect(groups[0].farmName).toBe('Big Saunders')
    expect(groups[0].fields.map((f) => f.id)).toEqual(['f-1', 'f-2'])
  })

  it('"clearwater" narrows to that farm\'s fields', () => {
    const groups = groupFieldsByFarm(fields, farms, 'clearwater')
    expect(groups).toHaveLength(1)
    expect(groups[0].fields.map((f) => f.id)).toEqual(['f-3', 'f-4'])
  })

  it('a field name matches under EVERY farm that has it, still grouped', () => {
    const groups = groupFieldsByFarm(fields, farms, 'field 12')
    expect(groups.map((g) => g.farmName)).toEqual(['Big Saunders', 'Clearwater'])
    expect(groups.flatMap((g) => g.fields.map((f) => f.id))).toEqual(['f-1', 'f-3'])
  })

  it('matching is case-insensitive and trims the query', () => {
    expect(groupFieldsByFarm(fields, farms, '  RIVER ')).toHaveLength(1)
    expect(groupFieldsByFarm(fields, farms, '  RIVER ')[0].fields[0].id).toBe('f-4')
  })

  it('unassigned fields match by their own name and land in "No farm"', () => {
    const groups = groupFieldsByFarm(fields, farms, 'home')
    expect(groups).toEqual([
      { farmId: null, farmName: 'No farm', fields: [fields[4]] },
    ])
  })

  it('no matches → no groups', () => {
    expect(groupFieldsByFarm(fields, farms, 'zzz')).toEqual([])
  })
})
