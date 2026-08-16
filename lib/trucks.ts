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
//
// THE SNAPSHOT RULE (071): trucks are renameable (from the picker and from
// Settings → Trucks), so a load also stores loads.truck_label — the own
// truck's name AT SAVE TIME. Display prefers the snapshot over the live FK
// name; renaming a truck changes the picker and future loads only. Rows that
// predate 071 (or come from a writer that doesn't stamp the label) fall back
// to the live FK name. hauler_truck was born a snapshot (067) and needs no
// column of its own.

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
 * The truck to display for a load: the saved snapshot (071) first, then the
 * own truck's live name, then the hauler text with hauler=true (drives the
 * badge). Own truck wins if both are somehow set.
 */
export function truckDisplay(load: {
  truck_label?: string | null
  truck?: { name_or_number: string } | null
  hauler_truck?: string | null
}): { name: string; hauler: boolean } {
  if (load.truck_label) return { name: load.truck_label, hauler: false }
  if (load.truck?.name_or_number) return { name: load.truck.name_or_number, hauler: false }
  if (load.hauler_truck) return { name: load.hauler_truck, hauler: true }
  return { name: '', hauler: false }
}

/** Truck name for exports/search: hauler text is suffixed so the two lists
 *  stay distinct in a flat CSV column. */
export function truckExportLabel(load: {
  truck_label?: string | null
  truck?: { name_or_number: string } | null
  hauler_truck?: string | null
}): string {
  const d = truckDisplay(load)
  return d.hauler ? `${d.name} (hauler)` : d.name
}

/**
 * The truck_label snapshot to store on a load at save time.
 *
 * New load, or edit that PICKS A DIFFERENT truck → the truck's current name.
 * Edit that keeps the same truck → the load's existing label, so re-saving an
 * old load after a rename never silently rewrites its history.
 */
export function truckLabelForSave(args: {
  truckId: string | null
  trucks: Array<{ id: string; name_or_number: string }>
  /** The load being edited, when there is one. */
  prior?: { truck_id: string | null; truck_label?: string | null } | null
}): string | null {
  const { truckId, trucks, prior } = args
  if (!truckId) return null
  if (prior && prior.truck_id === truckId && prior.truck_label) return prior.truck_label
  return trucks.find((t) => t.id === truckId)?.name_or_number ?? null
}

// Inline-add insert payloads. org_id is stamped from the caller's session
// (lib/org getOrgId — the same membership row current_org_id() reads), never
// trusted from anywhere else; the 054 org-isolation WITH CHECK verifies it.
// When the org can't be resolved client-side the key is omitted so the 054
// column DEFAULT (coalesce(current_org_id(), default_org_id())) still stamps
// it server-side — an explicit null would defeat the default and be rejected.

/** Insert payload for the operation's OWN trucks (public.trucks). */
export function ownTruckInsert(name: string, orgId: string | null): { name_or_number: string; org_id?: string } {
  return { name_or_number: name.trim(), ...(orgId ? { org_id: orgId } : {}) }
}

/** Insert payload for saved hauler trucks (public.external_trucks). */
export function externalTruckInsert(
  name: string,
  buyerId: string | null,
  orgId: string | null,
): { name: string; buyer_id: string | null; org_id?: string } {
  return { name: name.trim(), buyer_id: buyerId, ...(orgId ? { org_id: orgId } : {}) }
}
