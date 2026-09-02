// Freight Math — the /reports/freight-math calculator's pure engine.
//
// The question it answers: what does hauling a load X miles really cost, and
// therefore how much MORE must a delivered contract pay than a picked-up one
// to cover the trip? Costs are OPERATING costs by default (fuel + labor +
// wear) — the Iowa State convention for comparing WHERE to haul: ownership
// costs (depreciation, insurance, housing) accrue whether the truck rolls or
// not, so they only enter via the optional toggle.
//
// Defaults come from extension-service custom-rate research; every one is
// editable and persisted per org (freight_settings, 078).

export const TRUCK_PAYLOAD_LBS = 53_000 // typical legal grain-trailer payload

export type FreightSettings = {
  truckMpg: number
  avgSpeedMph: number
  loadUnloadHours: number
  wearPerMile: number
  includeOwnership: boolean
  ownershipPerMile: number | null
}

export const FREIGHT_DEFAULTS: FreightSettings = {
  truckMpg: 6.0, // loaded/empty average
  avgSpeedMph: 45,
  loadUnloadHours: 0.75, // load + unload + wait, per round trip
  wearPerMile: 0.2,
  includeOwnership: false,
  ownershipPerMile: null,
}

/**
 * Payload in the crop's own bushels, from its test weight: a legal payload of
 * ~53,000 lbs ÷ lb/bu, rounded to the nearest 10 bu — corn (56#) ≈ 950,
 * soybeans/wheat (60#) ≈ 880. An override (freight_settings.payload_overrides)
 * wins; a crop without a usable lb/bu (e.g. cotton in lbs) returns null and
 * the page shows per-load cost only.
 */
export function payloadForCrop(
  baseLbPerBushel: number | string | null | undefined,
  overrideBu?: number | null,
): number | null {
  if (overrideBu != null && Number.isFinite(Number(overrideBu)) && Number(overrideBu) > 0) {
    return Number(overrideBu)
  }
  const lb = Number(baseLbPerBushel)
  if (!Number.isFinite(lb) || lb <= 0) return null
  return Math.round(TRUCK_PAYLOAD_LBS / lb / 10) * 10
}

export type FreightCost = {
  roundTripMiles: number
  /** Round-trip miles ÷ mpg × diesel $/gal. */
  fuel: number
  /** (Round-trip ÷ avg speed + load/unload hours) × labor $/hr. */
  labor: number
  /** Round-trip × wear $/mi. */
  wear: number
  /** Round-trip × ownership $/mi — only when the toggle is on. */
  ownership: number
  totalPerLoad: number
  /** totalPerLoad ÷ payload; null without a payload. */
  perBu: number | null
  centsPerBu: number | null
  /** The decision line: a delivered contract must pay at least this many
   *  ¢/bu more than a picked-up one to cover the haul. (= centsPerBu.) */
  breakevenCentsPerBu: number | null
  /** totalPerLoad ÷ one-way (loaded) miles — sanity-check vs hauler quotes. */
  customRatePerLoadedMile: number | null
}

export function freightCost(args: {
  oneWayMiles: number
  dieselPrice: number
  laborRate: number
  payloadBu: number | null
  settings?: FreightSettings
}): FreightCost {
  const s = args.settings ?? FREIGHT_DEFAULTS
  const roundTrip = args.oneWayMiles * 2
  const fuel = (roundTrip / s.truckMpg) * args.dieselPrice
  const labor = (roundTrip / s.avgSpeedMph + s.loadUnloadHours) * args.laborRate
  const wear = roundTrip * s.wearPerMile
  const ownership = s.includeOwnership && s.ownershipPerMile != null ? roundTrip * s.ownershipPerMile : 0
  const totalPerLoad = fuel + labor + wear + ownership
  const perBu = args.payloadBu != null && args.payloadBu > 0 ? totalPerLoad / args.payloadBu : null
  return {
    roundTripMiles: roundTrip,
    fuel,
    labor,
    wear,
    ownership,
    totalPerLoad,
    perBu,
    centsPerBu: perBu != null ? perBu * 100 : null,
    breakevenCentsPerBu: perBu != null ? perBu * 100 : null,
    customRatePerLoadedMile: args.oneWayMiles > 0 ? totalPerLoad / args.oneWayMiles : null,
  }
}

// ---------------------------------------------------------------------------
// Distance estimates: geocoded coordinates → haversine × a road factor.
// ---------------------------------------------------------------------------

/** Straight-line-to-road correction — rural road networks run ~25% longer
 *  than the crow flies. Estimates are labeled as such and editable. */
export const ROAD_FACTOR = 1.25

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.7613 // earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function roadMilesEstimate(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineMiles(lat1, lon1, lat2, lon2) * ROAD_FACTOR
}

// ---------------------------------------------------------------------------
// Distance table rules: typed miles are the primary path; the AI estimate
// only fills blanks and never touches what's on file.
// ---------------------------------------------------------------------------

export type FreightDistanceRow = {
  bin_site_id: string
  delivery_location_id: string
  miles: number | string
  source: 'estimate' | 'manual'
}

export type DistanceEstimate = {
  bin_site_id: string
  delivery_location_id: string
  miles: number
}

const pairKey = (r: { bin_site_id: string; delivery_location_id: string }) => `${r.bin_site_id}|${r.delivery_location_id}`

/**
 * Which freshly-computed estimates may be saved: ONLY pairs with nothing on
 * file. A 'manual' row is the user's own number and is never overwritten; an
 * existing 'estimate' is left alone too — the action is "estimate MISSING
 * distances", a bulk fill for the blanks, not a refresh.
 */
export function planDistanceSaves(
  existing: readonly FreightDistanceRow[],
  estimates: readonly DistanceEstimate[],
): DistanceEstimate[] {
  const onFile = new Set(existing.map(pairKey))
  return estimates.filter((e) => !onFile.has(pairKey(e)))
}

/**
 * The row a typed mileage saves: source 'manual', whether or not the location
 * has an address (no address is needed to type a distance you know) and
 * whatever was there before. Null for a blank/zero/invalid entry — nothing to
 * save.
 */
export function manualDistanceRow(
  binSiteId: string,
  deliveryLocationId: string,
  miles: number | string | null | undefined,
): FreightDistanceRow | null {
  if (miles == null || miles === '') return null
  const n = Number(miles)
  if (!Number.isFinite(n) || n <= 0) return null
  return { bin_site_id: binSiteId, delivery_location_id: deliveryLocationId, miles: Math.round(n * 10) / 10, source: 'manual' }
}

/** Pure state update: the pair's row becomes the manual one (replacing an
 *  estimate or an earlier manual number); an invalid entry changes nothing. */
export function applyManualDistance<T extends FreightDistanceRow>(
  rows: readonly T[],
  binSiteId: string,
  deliveryLocationId: string,
  miles: number | string | null | undefined,
): Array<T | FreightDistanceRow> {
  const manual = manualDistanceRow(binSiteId, deliveryLocationId, miles)
  if (!manual) return [...rows]
  const key = pairKey(manual)
  let replaced = false
  const out: Array<T | FreightDistanceRow> = rows.map((r) => {
    if (pairKey(r) !== key) return r
    replaced = true
    return { ...r, miles: manual.miles, source: 'manual' as const }
  })
  if (!replaced) out.push(manual)
  return out
}

// ---------------------------------------------------------------------------
// The by-buyer distance model: buyer heading → its delivery locations →
// one miles cell per bin site. Mirrors the Settings → Buyers hierarchy.
// ---------------------------------------------------------------------------

export type DistanceLocationRow = {
  id: string
  name: string
  address: string | null
  /** False = no address on file. The AI estimate can't reach it — typing
   *  the miles you know is the only path, and it is always open. */
  hasAddress: boolean
  /** bin_site_id → what's on file for that pair (null = blank). */
  milesBySite: Map<string, { miles: number; source: 'estimate' | 'manual' } | null>
}

export type DistanceBuyerGroup = {
  /** Null for locations whose buyer isn't in the list (shouldn't happen —
   *  kept so nothing silently disappears). */
  buyerId: string | null
  buyerName: string
  locations: DistanceLocationRow[]
}

export function groupDistancesByBuyer(args: {
  buyers: ReadonlyArray<{ id: string; name: string }>
  locations: ReadonlyArray<{ id: string; buyer_id: string | null; name: string; address: string | null }>
  binSites: ReadonlyArray<{ id: string }>
  distances: readonly FreightDistanceRow[]
}): DistanceBuyerGroup[] {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const toRow = (l: { id: string; name: string; address: string | null }): DistanceLocationRow => {
    const milesBySite = new Map<string, { miles: number; source: 'estimate' | 'manual' } | null>()
    for (const s of args.binSites) milesBySite.set(s.id, distanceFor(args.distances, s.id, l.id))
    return { id: l.id, name: l.name, address: l.address, hasAddress: (l.address ?? '').trim() !== '', milesBySite }
  }
  const groups: DistanceBuyerGroup[] = []
  const placed = new Set<string>()
  for (const b of [...args.buyers].sort(byName)) {
    const locs = args.locations.filter((l) => l.buyer_id === b.id).sort(byName)
    for (const l of locs) placed.add(l.id)
    groups.push({ buyerId: b.id, buyerName: b.name, locations: locs.map(toRow) })
  }
  const orphans = args.locations.filter((l) => !placed.has(l.id)).sort(byName)
  if (orphans.length > 0) groups.push({ buyerId: null, buyerName: 'Other locations', locations: orphans.map(toRow) })
  return groups
}

/** The miles for a pair, if on file. */
export function distanceFor(
  rows: readonly FreightDistanceRow[],
  binSiteId: string,
  deliveryLocationId: string,
): { miles: number; source: 'estimate' | 'manual' } | null {
  const row = rows.find((r) => r.bin_site_id === binSiteId && r.delivery_location_id === deliveryLocationId)
  if (!row) return null
  const miles = Number(row.miles)
  return Number.isFinite(miles) && miles > 0 ? { miles, source: row.source } : null
}
