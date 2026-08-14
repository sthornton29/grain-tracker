// Own trucks vs hauler (external) trucks — the 067 classification rule.
//
// Behavior pinned:
//   * a truck saved from a PICKUP-contract load goes to external_trucks;
//     saved anywhere else it goes to the org's own trucks — the lists never mix;
//   * display prefers the own truck's name; hauler text carries hauler=true
//     (the badge) and exports as "name (hauler)" so flat CSVs stay distinct;
//   * typed hauler names match the saved list case-insensitively.

import { describe, expect, it } from 'vitest'
import { findExternalTruck, truckDisplay, truckExportLabel, truckSaveTable } from './trucks'
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
})
