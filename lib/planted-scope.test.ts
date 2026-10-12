import { describe, expect, it } from 'vitest'
import { keptWithoutPlanting, plantedFieldIds, scopeToPlanted } from './planted-scope'

const plantings = [
  { field_id: 'f1', crop_id: 'cotton', season_year: 2026 },
  { field_id: 'f2', crop_id: 'cotton', season_year: 2025 },
  { field_id: 'f3', crop_id: 'corn', season_year: 2026 },
  { field_id: 'f4', crop_id: 'cotton', season_year: 2026, archived_at: '2026-05-01T00:00:00Z' },
  { field_id: 'f5', crop_id: 'pima', season_year: 2026 },
]

const fields = [
  { id: 'f1', farm_id: 'A', name: 'North' },
  { id: 'f2', farm_id: 'A', name: 'South' },
  { id: 'f3', farm_id: 'B', name: 'Bottom' },
  { id: 'f4', farm_id: 'C', name: 'Archived cotton' },
  { id: 'f5', farm_id: null, name: 'No farm' },
]
const farms = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]

describe('plantedFieldIds', () => {
  it('keeps only live plantings of the crop in the season', () => {
    expect([...plantedFieldIds(plantings, { cropIds: 'cotton', seasonYear: 2026 })]).toEqual(['f1'])
  })
  it('takes a set of crop ids (upland + pima are both cotton)', () => {
    expect([...plantedFieldIds(plantings, { cropIds: new Set(['cotton', 'pima']), seasonYear: 2026 })]).toEqual(['f1', 'f5'])
  })
  it('crop null = any crop (the "All crops" filter)', () => {
    expect([...plantedFieldIds(plantings, { cropIds: null, seasonYear: 2026 })]).toEqual(['f1', 'f3', 'f5'])
  })
  it('season null = any season', () => {
    expect([...plantedFieldIds(plantings, { cropIds: 'cotton', seasonYear: null })]).toEqual(['f1', 'f2'])
  })
  it('never counts an archived planting', () => {
    expect(plantedFieldIds(plantings, { cropIds: 'cotton', seasonYear: 2026 }).has('f4')).toBe(false)
  })
})

describe('scopeToPlanted', () => {
  it('narrows fields to the planted set and farms to the farms those fields sit on', () => {
    const s = scopeToPlanted({ fields, farms, plantedFieldIds: new Set(['f1', 'f5']) })
    expect(s.narrowed).toBe(true)
    expect(s.fields.map((f) => f.id)).toEqual(['f1', 'f5'])
    expect(s.farms.map((f) => f.id)).toEqual(['A'])
  })
  it('null planted set = nothing to narrow by, everything shown', () => {
    const s = scopeToPlanted({ fields, farms, plantedFieldIds: null })
    expect(s.narrowed).toBe(false)
    expect(s.fields).toHaveLength(5)
    expect(s.farms).toHaveLength(4)
  })
  it('an empty planted set leaves no fields and no farms', () => {
    const s = scopeToPlanted({ fields, farms, plantedFieldIds: new Set() })
    expect(s.fields).toEqual([])
    expect(s.farms).toEqual([])
  })
  it('keeps the already-saved field and farm so an edit never loses them', () => {
    const s = scopeToPlanted({ fields, farms, plantedFieldIds: new Set(['f1']), keep: { fieldId: 'f3', farmId: 'D' } })
    expect(s.fields.map((f) => f.id)).toEqual(['f1', 'f3'])
    expect(s.farms.map((f) => f.id)).toEqual(['A', 'B', 'D'])
  })
  it('a kept field brings its own farm into scope', () => {
    const s = scopeToPlanted({ fields, farms, plantedFieldIds: new Set(['f1']), keep: { fieldId: 'f3' } })
    expect(s.farms.map((f) => f.id)).toEqual(['A', 'B'])
  })
  it('empty-string keep values are ignored', () => {
    const s = scopeToPlanted({ fields, farms, plantedFieldIds: new Set(['f1']), keep: { fieldId: '', farmId: '' } })
    expect(s.fields.map((f) => f.id)).toEqual(['f1'])
    expect(s.farms.map((f) => f.id)).toEqual(['A'])
  })
})

describe('keptWithoutPlanting', () => {
  it('flags a kept field that has no planting backing it', () => {
    expect(keptWithoutPlanting('f3', new Set(['f1']))).toBe(true)
    expect(keptWithoutPlanting('f1', new Set(['f1']))).toBe(false)
  })
  it('is false with no field or before plantings load', () => {
    expect(keptWithoutPlanting('', new Set(['f1']))).toBe(false)
    expect(keptWithoutPlanting('f3', null)).toBe(false)
  })
})
