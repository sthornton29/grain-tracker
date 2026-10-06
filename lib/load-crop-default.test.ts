// cropForFieldOnDate + resolveTicketCrop — the crop a field load defaults to,
// and how a printed commodity takes precedence on a scanned ticket.
//
// Fixture (2026): Wheeler Grove = Wheat (spring) + Soybean (fall, double-crop);
// Moore = Corn only; North 40 = nothing in 2026 (Corn in 2025); Split = Corn 80
// + Soybean 60, both fall; Picker = Cotton only.
import { describe, expect, it } from 'vitest'
import {
  SPRING_HARVEST_LAST_MONTH, cropConflictNote, cropForFieldOnDate, fieldDefaultNote, resolveTicketCrop,
} from './load-crop-default'

const crops = [
  { id: 'corn', name: 'Corn', harvest_category: 'fall' as const },
  { id: 'beans', name: 'Soybean', harvest_category: 'fall' as const },
  { id: 'wheat', name: 'Wheat', harvest_category: 'spring' as const },
  { id: 'cotton', name: 'Cotton', harvest_category: 'fall' as const },
]
const plantings = [
  { id: 'p1', field_id: 'wheeler', crop_id: 'wheat', season_year: 2026 },
  { id: 'p2', field_id: 'wheeler', crop_id: 'beans', season_year: 2026 },
  { id: 'p3', field_id: 'moore', crop_id: 'corn', season_year: 2026 },
  { id: 'p4', field_id: 'north40', crop_id: 'corn', season_year: 2025 },
  { id: 'p5', field_id: 'split', crop_id: 'corn', season_year: 2026 },
  { id: 'p6', field_id: 'split', crop_id: 'beans', season_year: 2026 },
  { id: 'p7', field_id: 'picker', crop_id: 'cotton', season_year: 2026 },
  { id: 'p8', field_id: 'gone', crop_id: 'corn', season_year: 2026, archived_at: '2026-05-01T00:00:00Z' },
]
const on = (fieldId: string, date: string | null, cropYear = 2026) => cropForFieldOnDate({ plantings, crops, fieldId, cropYear, date })

describe('cropForFieldOnDate — the spring + fall pair decides by date', () => {
  it('Wheeler Grove: 6/14 → Wheat, 10/22 → Soybean, the other crop always offered', () => {
    const june = on('wheeler', '2026-06-14')
    expect(june.cropId).toBe('wheat')
    expect(june.reason).toBe('spring_fall_by_date')
    expect(june.season).toBe('spring')
    expect(june.alternatives).toEqual(['beans'])
    const oct = on('wheeler', '2026-10-22')
    expect(oct.cropId).toBe('beans')
    expect(oct.season).toBe('fall')
    expect(oct.alternatives).toEqual(['wheat'])
    expect(oct.springCropId).toBe('wheat')
    expect(oct.fieldCropIds.sort()).toEqual(['beans', 'wheat'])
  })
  it('the boundary is the ONE constant: 7/31 → Wheat, 8/1 → Soybean', () => {
    expect(SPRING_HARVEST_LAST_MONTH).toBe(7)
    expect(on('wheeler', '2026-07-31').cropId).toBe('wheat')
    expect(on('wheeler', '2026-08-01').cropId).toBe('beans')
  })
  it('without a date the pair cannot be decided — both offered', () => {
    const d = on('wheeler', null)
    expect(d.cropId).toBeNull()
    expect(d.reason).toBe('multiple')
    expect(d.alternatives.sort()).toEqual(['beans', 'wheat'])
  })
})

describe('cropForFieldOnDate — the other shapes', () => {
  it('Moore: Corn only → Corn', () => {
    expect(on('moore', '2026-09-10')).toMatchObject({ cropId: 'corn', reason: 'single', alternatives: [], fieldCropIds: ['corn'] })
  })
  it('North 40: no 2026 planting → null, no_planting (its 2025 corn does not count)', () => {
    expect(on('north40', '2026-09-10')).toMatchObject({ cropId: null, reason: 'no_planting', alternatives: [] })
    expect(on('north40', '2025-09-10', 2025).cropId).toBe('corn')
  })
  it('a split field (Corn + Soybean, both fall) → null, multiple, both as quick picks', () => {
    const d = on('split', '2026-10-01')
    expect(d.cropId).toBeNull()
    expect(d.reason).toBe('multiple')
    expect(d.alternatives.sort()).toEqual(['beans', 'corn'])
  })
  it('a cotton-only field → null, cotton_only, with the Seed Cotton Loads note', () => {
    const d = on('picker', '2026-10-01')
    expect(d).toMatchObject({ cropId: null, reason: 'cotton_only' })
    expect(fieldDefaultNote(d, () => '', 2026)).toBe('Planted to cotton. Use Seed Cotton Loads.')
  })
  it('an archived planting takes no part', () => {
    expect(on('gone', '2026-10-01').reason).toBe('no_planting')
  })
  it('no field → no_field (a bin source is unaffected)', () => {
    expect(on('', '2026-10-01').reason).toBe('no_field')
  })
})

describe('resolveTicketCrop — precedence on a scanned row', () => {
  const name = (id: string) => crops.find((c) => c.id === id)?.name ?? id
  it('ticket prints CORN, field Moore planted Corn → Corn from the ticket, no conflict', () => {
    const r = resolveTicketCrop({ printedCropId: 'corn', fieldDefault: on('moore', '2026-09-10') })
    expect(r).toEqual({ cropId: 'corn', provenance: 'ticket', conflict: null })
  })
  it('ticket prints CORN, Wheeler Grove has no corn → Corn KEPT, flagged as a conflict naming the field crops', () => {
    const fd = on('wheeler', '2026-10-22')
    const r = resolveTicketCrop({ printedCropId: 'corn', fieldDefault: fd })
    expect(r.cropId).toBe('corn')
    expect(r.provenance).toBe('ticket')
    expect(r.conflict?.fieldCropIds.sort()).toEqual(['beans', 'wheat'])
    expect(cropConflictNote({ ticketCrop: 'Corn', fieldName: 'Wheeler Grove', fieldCrops: ['Soybean'], cropYear: 2026 }))
      .toBe('Ticket says Corn, but Wheeler Grove is planted to Soybean in 2026.')
  })
  it('nothing printed → the field planting decides, with the double-crop chip text', () => {
    const fd = on('wheeler', '2026-10-22')
    const r = resolveTicketCrop({ printedCropId: null, fieldDefault: fd })
    expect(r).toEqual({ cropId: 'beans', provenance: 'field_planting', conflict: null })
    expect(fieldDefaultNote(fd, name, 2026)).toBe('Soybean, double-crop behind Wheat (date is after July)')
    expect(fieldDefaultNote(on('wheeler', '2026-06-14'), name, 2026)).toBe('Wheat (date is July or earlier; Soybean follows it)')
    expect(fieldDefaultNote(on('moore', '2026-09-10'), name, 2026)).toBe('from field (2026 planting)')
  })
  it('nothing printed and no usable default → the fallback (blank), provenance fallback', () => {
    expect(resolveTicketCrop({ printedCropId: null, fieldDefault: on('split', '2026-10-01') })).toEqual({ cropId: '', provenance: 'fallback', conflict: null })
    expect(resolveTicketCrop({ printedCropId: null, fieldDefault: on('north40', '2026-10-01'), fallbackCropId: 'corn' }).cropId).toBe('corn')
  })
  it('a printed crop with no field to check against stands on its own (bin rows)', () => {
    expect(resolveTicketCrop({ printedCropId: 'corn', fieldDefault: null })).toEqual({ cropId: 'corn', provenance: 'ticket', conflict: null })
    expect(resolveTicketCrop({ printedCropId: 'corn', fieldDefault: on('north40', '2026-10-01') }).conflict).toBeNull()
  })
})
