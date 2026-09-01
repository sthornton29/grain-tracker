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
// Distance table rules: manual corrections stick.
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

/**
 * Which freshly-computed estimates may be saved: a pair whose existing row is
 * 'manual' is NEVER overwritten by a re-estimate (the user's correction
 * sticks); 'estimate' rows refresh, missing pairs insert.
 */
export function planDistanceSaves(
  existing: readonly FreightDistanceRow[],
  estimates: readonly DistanceEstimate[],
): DistanceEstimate[] {
  const manualPairs = new Set(
    existing.filter((r) => r.source === 'manual').map((r) => `${r.bin_site_id}|${r.delivery_location_id}`),
  )
  return estimates.filter((e) => !manualPairs.has(`${e.bin_site_id}|${e.delivery_location_id}`))
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
