import { describe, expect, it } from 'vitest'
import { assembleBinLoads, type BinLoadInputs } from './farm-link-bin-loads'

const inputs: BinLoadInputs = {
  bins: [{ id: 'seed', name_or_number: 'Wheat Seed' }, { id: 'wheat', name_or_number: 'Wheat' }],
  crops: [{ id: 'w', name: 'Wheat', base_moisture_pct: 13.5, base_lb_per_bushel: 60 }],
  fields: [{ id: 'ra', name_or_number: 'Robert Allen' }],
  loads: [
    { id: 'l2', date: '2026-06-04', ticket_number: null, crop_id: 'w', crop_year: 2026, net_weight: 43300, moisture: 13, test_weight: null, dry_bushels_override: null, from_type: 'bin', from_field_id: null, from_bin_id: 'wheat', to_type: 'bin', to_bin_id: 'seed', updated_at: '2026-06-04T20:44:00Z' },
    { id: 'l1', date: '2026-06-04', ticket_number: ' 3-17 ', crop_id: 'w', crop_year: 2026, net_weight: 44460, moisture: 12.9, test_weight: 58.8, dry_bushels_override: null, from_type: 'field', from_field_id: 'ra', from_bin_id: null, to_type: 'bin', to_bin_id: 'seed', updated_at: '2026-06-04T19:56:00Z' },
    { id: 'l3', date: '2026-06-05', ticket_number: '4-1', crop_id: 'w', crop_year: 2026, net_weight: 50000, moisture: 13, test_weight: null, dry_bushels_override: null, from_type: 'field', from_field_id: 'ra', from_bin_id: null, to_type: 'buyer', to_bin_id: null, updated_at: '2026-06-05T00:00:00Z' },
    { id: 'l4', date: '2025-06-04', ticket_number: null, crop_id: 'w', crop_year: 2025, net_weight: 40000, moisture: 13, test_weight: null, dry_bushels_override: null, from_type: 'field', from_field_id: 'ra', from_bin_id: null, to_type: 'bin', to_bin_id: 'seed', updated_at: '2025-06-04T00:00:00Z' },
  ],
  plantings: [{ id: 'p', field_id: 'ra', crop_id: 'w', season_year: 2026 }],
  varieties: [{ planting_id: 'p', variety: 'Pioneer 26R59' }, { planting_id: 'p', variety: ' Pioneer 26R59 ' }],
}

describe('assembleBinLoads', () => {
  it('lists the loads into the bin for the year, with the field and its varieties or the bin moved from', () => {
    const r = assembleBinLoads(inputs, { cropYear: 2026, binId: 'seed' })
    expect(r.map((x) => x.id)).toEqual(['l1', 'l2'])
    expect(r[0]).toMatchObject({ ticket_number: '3-17', from_type: 'field', from_field_name: 'Robert Allen', varieties: ['Pioneer 26R59'], to_bin_name: 'Wheat Seed', crop: 'Wheat' })
    expect(r[0].dry_bushels).toBeCloseTo(741, 0)
    expect(r[1]).toMatchObject({ from_type: 'bin', from_bin_name: 'Wheat', varieties: [], from_field_id: null })
    expect(r[1].dry_bushels).toBeCloseTo(722, 0)
  })
  it('leaves loads to a buyer out and takes every bin when none is asked for', () => {
    expect(assembleBinLoads(inputs, { cropYear: 2026 }).map((x) => x.id)).toEqual(['l1', 'l2'])
  })
})
