// Own trucks vs hauler (external) trucks — the 067 classification rule and
// the 071 snapshot rule.
//
// Behavior pinned:
//   * a truck saved from a PICKUP-contract load goes to external_trucks;
//     saved anywhere else it goes to the org's own trucks — the lists never mix;
//   * display prefers the saved truck_label snapshot, then the own truck's
//     live name; hauler text carries hauler=true (the badge) and exports as
//     "name (hauler)" so flat CSVs stay distinct;
//   * renaming a truck changes future loads only — old loads keep the label
//     captured at save time (truckLabelForSave), including through an edit
//     that doesn't change the truck;
//   * the inline-add insert payloads stamp org_id from the session for BOTH
//     lists (054 WITH CHECK), omitting the key — never null — when the org
//     can't be resolved so the column DEFAULT still stamps it;
//   * typed hauler names match the saved list case-insensitively.

import { describe, expect, it } from 'vitest'
import {
  externalTruckInsert,
  findExternalTruck,
  ownTruckInsert,
  truckDisplay,
  truckExportLabel,
  truckLabelForSave,
  truckSaveTable,
} from './trucks'
import type { ExternalTruck } from './types'

const ext = (over: Partial<ExternalTruck> = {}): ExternalTruck => ({
  id: 'xt-1', name: 'JD Trucking 12', buyer_id: 'buyer-1', created_at: '2026-08-14T00:00:00Z', ...over,
})

describe('truckSaveTable', () => {
  it('pickup-contract load save → external_trucks; anywhere else → trucks', () => {
    expect(truckSaveTable(true)).toBe('external_trucks')
    expect(truckSaveTable(false)).toBe('trucks')
  })
})

describe('findExternalTruck', () => {
  it('matches case-insensitively with surrounding whitespace ignored', () => {
    const list = [ext(), ext({ id: 'xt-2', name: 'Red Peterbilt' })]
    expect(findExternalTruck(list, '  jd trucking 12 ')?.id).toBe('xt-1')
    expect(findExternalTruck(list, 'RED PETERBILT')?.id).toBe('xt-2')
    expect(findExternalTruck(list, 'Unknown')).toBeNull()
    expect(findExternalTruck(list, '   ')).toBeNull()
  })
})

describe('truckDisplay', () => {
  it('own truck shows its name with no badge', () => {
    expect(truckDisplay({ truck: { name_or_number: 'Kenworth 1' }, hauler_truck: null }))
      .toEqual({ name: 'Kenworth 1', hauler: false })
  })
  it('hauler text shows with the badge when there is no own truck', () => {
    expect(truckDisplay({ truck: null, hauler_truck: 'JD Trucking 12' }))
      .toEqual({ name: 'JD Trucking 12', hauler: true })
  })
  it('own truck wins if both are somehow set; empty load shows nothing', () => {
    expect(truckDisplay({ truck: { name_or_number: 'Kenworth 1' }, hauler_truck: 'JD 12' }).hauler).toBe(false)
    expect(truckDisplay({ truck: null, hauler_truck: null })).toEqual({ name: '', hauler: false })
  })
})

describe('truckExportLabel', () => {
  it('suffixes hauler trucks so flat exports keep the two lists distinct', () => {
    expect(truckExportLabel({ truck: null, hauler_truck: 'JD 12' })).toBe('JD 12 (hauler)')
    expect(truckExportLabel({ truck: { name_or_number: 'Kenworth 1' }, hauler_truck: null })).toBe('Kenworth 1')
    expect(truckExportLabel({ truck: null, hauler_truck: null })).toBe('')
  })
  it('prefers the snapshot in exports too', () => {
    expect(truckExportLabel({ truck_label: 'Old 88', truck: { name_or_number: 'New 88' }, hauler_truck: null })).toBe('Old 88')
  })
})

describe('071 truck snapshot — rename never rewrites history', () => {
  const fleet = [{ id: 't-1', name_or_number: 'Kenworth 88' }]

  it('display prefers the saved label over the live FK name', () => {
    // A load saved before the rename carries the old label; the FK now
    // resolves to the new name — the load must keep showing the old one.
    expect(truckDisplay({ truck_label: 'Kenworth 88', truck: { name_or_number: 'KW 88 (Bill)' }, hauler_truck: null }))
      .toEqual({ name: 'Kenworth 88', hauler: false })
  })
  it('falls back to the live name on pre-071 rows without a snapshot', () => {
    expect(truckDisplay({ truck_label: null, truck: { name_or_number: 'KW 88 (Bill)' }, hauler_truck: null }))
      .toEqual({ name: 'KW 88 (Bill)', hauler: false })
  })
  it('the snapshot survives truck deletion (FK nulled, label kept)', () => {
    expect(truckDisplay({ truck_label: 'Kenworth 88', truck: null, hauler_truck: null }))
      .toEqual({ name: 'Kenworth 88', hauler: false })
  })

  it('rename after N loads: old loads keep the old label, new loads get the new', () => {
    // Loads 1..N saved while the truck was "Kenworth 88".
    const oldLoads = Array.from({ length: 3 }, () => ({
      truck_id: 't-1',
      truck_label: truckLabelForSave({ truckId: 't-1', trucks: fleet }),
    }))
    // The rename.
    const renamed = [{ id: 't-1', name_or_number: 'KW 88 (Bill)' }]
    // A load entered after it.
    const newLabel = truckLabelForSave({ truckId: 't-1', trucks: renamed })
    for (const l of oldLoads) expect(l.truck_label).toBe('Kenworth 88')
    expect(newLabel).toBe('KW 88 (Bill)')
  })
  it('editing a load without changing its truck keeps the label as entered', () => {
    const renamed = [{ id: 't-1', name_or_number: 'KW 88 (Bill)' }]
    expect(
      truckLabelForSave({ truckId: 't-1', trucks: renamed, prior: { truck_id: 't-1', truck_label: 'Kenworth 88' } }),
    ).toBe('Kenworth 88')
  })
  it('editing a load onto a DIFFERENT truck snapshots that truck’s current name', () => {
    const two = [...fleet, { id: 't-2', name_or_number: 'Peterbilt 3' }]
    expect(
      truckLabelForSave({ truckId: 't-2', trucks: two, prior: { truck_id: 't-1', truck_label: 'Kenworth 88' } }),
    ).toBe('Peterbilt 3')
  })
  it('no truck → no label', () => {
    expect(truckLabelForSave({ truckId: null, trucks: fleet })).toBeNull()
    expect(truckLabelForSave({ truckId: '', trucks: fleet } as never)).toBeNull()
  })
})

describe('inline-add insert payloads — org stamped on BOTH truck lists', () => {
  it('own trucks: name trimmed, org_id present', () => {
    expect(ownTruckInsert('  Kenworth 88 ', 'org-1')).toEqual({ name_or_number: 'Kenworth 88', org_id: 'org-1' })
  })
  it('external trucks: name trimmed, buyer kept, org_id present', () => {
    expect(externalTruckInsert(' JD Trucking 12 ', 'buyer-1', 'org-1'))
      .toEqual({ name: 'JD Trucking 12', buyer_id: 'buyer-1', org_id: 'org-1' })
  })
  it('unresolved org OMITS the key (never null) so the column DEFAULT stamps it', () => {
    expect(ownTruckInsert('KW', null)).toEqual({ name_or_number: 'KW' })
    expect('org_id' in ownTruckInsert('KW', null)).toBe(false)
    expect('org_id' in externalTruckInsert('JD', null, null)).toBe(false)
  })
  it('each payload matches its classification-rule table', () => {
    // pickup load → external_trucks shape; anywhere else → trucks shape.
    expect(truckSaveTable(true)).toBe('external_trucks')
    expect(externalTruckInsert('JD', null, 'org-1')).toHaveProperty('name')
    expect(truckSaveTable(false)).toBe('trucks')
    expect(ownTruckInsert('KW', 'org-1')).toHaveProperty('name_or_number')
  })
})
