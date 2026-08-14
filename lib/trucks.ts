// Own trucks vs hauler (external) trucks — the pure rules behind the load
// form's Truck field and every surface that displays a load's truck.
//
// THE CLASSIFICATION RULE (067): a truck saved from a PICKUP-contract load is
// EXTERNAL (external_trucks — a buyer's or hired hauler's truck); a truck
// saved anywhere else is OURS (trucks). The two lists never mix.
//
// A load carries EITHER truck_id (ours, FK) OR hauler_truck (theirs, free
// text kept as entered). Display prefers the FK's name; the hauler text gets
// a subtle "hauler" badge so reports keep the two distinct.

import type { ExternalTruck } from '@/lib/types'

/** Which table a truck save goes to, by where the save happens. */
export function truckSaveTable(fromPickupContractLoad: boolean): 'external_trucks' | 'trucks' {
  return fromPickupContractLoad ? 'external_trucks' : 'trucks'
}

/** Case-insensitive lookup of a typed hauler-truck name in the saved list. */
export function findExternalTruck(externalTrucks: ExternalTruck[], name: string): ExternalTruck | null {
  const norm = name.trim().toLowerCase()
  if (!norm) return null
  return externalTrucks.find((t) => t.name.trim().toLowerCase() === norm) ?? null
}

/**
 * The truck to display for a load: the own truck's name, or the hauler text
 * with hauler=true (drives the badge). Own truck wins if both are somehow set.
 */
export function truckDisplay(load: {
  truck?: { name_or_number: string } | null
  hauler_truck?: string | null
}): { name: string; hauler: boolean } {
  if (load.truck?.name_or_number) return { name: load.truck.name_or_number, hauler: false }
  if (load.hauler_truck) return { name: load.hauler_truck, hauler: true }
  return { name: '', hauler: false }
}

/** Truck name for exports/search: hauler text is suffixed so the two lists
 *  stay distinct in a flat CSV column. */
export function truckExportLabel(load: {
  truck?: { name_or_number: string } | null
  hauler_truck?: string | null
}): string {
  const d = truckDisplay(load)
  return d.hauler ? `${d.name} (hauler)` : d.name
}
