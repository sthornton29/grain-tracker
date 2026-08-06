// Viewer private assumption overrides (052) — the PURE resolution layer.
//
// A viewer may re-assume report inputs (yields, costs, assumed futures/basis,
// county differentials) without touching the shared rows: each override
// shadows one column of one base row and carries base_updated_at, a snapshot
// of the base row's updated_at at save time. Resolution is then trivial and
// needs no sync job:
//
//   * snapshot matches the base row's current updated_at → override applies;
//   * base row changed since (any owner edit advances updated_at via the 052
//     trigger) → the override is STALE: ignored here and lazily deleted by
//     the caller (useViewerAssumptions) — admin changes win by construction;
//   * no base row: an override saved against "no row yet" (the epoch
//     sentinel) applies to a synthesized default row, and goes stale the
//     moment an owner creates the real row.
//
// Owners never pass overrides (RLS hides other users' rows anyway), so their
// resolution is the identity. Two viewers' overrides are independent because
// each only ever loads their own rows.
//
// harvest_complete is an operational fact, never overridable — enforced by
// the DB check constraint and again by OVERRIDABLE_CROP_FIELDS here.

import type { CropAssumption, CountyYieldAssumption, ViewerAssumptionOverride } from '@/lib/types'

/** base_updated_at sentinel meaning "no base row existed when I saved". */
export const NO_BASE_SENTINEL = '1970-01-01T00:00:00+00:00'

export const OVERRIDABLE_CROP_FIELDS = [
  'expected_yield', 'expected_yield_irr', 'expected_yield_dry', 'expected_yield_dc_irr', 'expected_yield_dc_dry',
  'cost_per_acre', 'cost_per_acre_irr', 'cost_per_acre_dry', 'cost_per_acre_dc_irr', 'cost_per_acre_dc_dry',
  'assumed_basis', 'assumed_futures', 'reference_contract_month',
] as const
export type OverridableCropField = (typeof OVERRIDABLE_CROP_FIELDS)[number]

export const OVERRIDABLE_COUNTY_FIELDS = ['yield_differential', 'county_yield_override', 'rma_final_county_yield'] as const
export type OverridableCountyField = (typeof OVERRIDABLE_COUNTY_FIELDS)[number]

/** Timestamp equality at JS Date precision (ms). Postgres keeps microseconds
 *  but the snapshot round-trips through the same column type, so both sides
 *  truncate identically. Unparseable stamps never match (fail safe → stale). */
export function sameStamp(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false
  const ta = Date.parse(a), tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb
}

const cropKey = (cropId: string, cropYear: number) => `${cropId}|${cropYear}`
const countyKey = (cropId: string, cropYear: number, countyId: string | null) =>
  `${cropId}|${cropYear}|${countyId ?? 'default'}`

/** Chip lookup key for one overridden value. */
export const overrideKey = (o: Pick<ViewerAssumptionOverride, 'scope' | 'crop_id' | 'crop_year' | 'county_id' | 'field'>) =>
  o.scope === 'crop'
    ? `crop|${cropKey(o.crop_id, o.crop_year)}|${o.field}`
    : `county|${countyKey(o.crop_id, o.crop_year, o.county_id)}|${o.field}`

export type OverrideResolution<T> = {
  /** Effective rows: base rows with the viewer's live overrides applied
   *  (copies — base objects untouched), plus synthesized rows for overrides
   *  saved against "no base row yet". Order of base rows is preserved. */
  rows: T[]
  /** Override row ids superseded by an admin change — delete lazily. */
  staleIds: string[]
  /** overrideKey() of every APPLIED override — drives the "your scenario"
   *  chips. */
  appliedKeys: Set<string>
}

function emptyCropAssumption(cropId: string, cropYear: number): CropAssumption {
  return {
    id: '', crop_id: cropId, crop_year: cropYear,
    expected_yield: null,
    expected_yield_irr: null, expected_yield_dry: null, expected_yield_dc_irr: null, expected_yield_dc_dry: null,
    harvest_complete: false,
    assumed_basis: 0, assumed_futures: null, reference_contract_month: null,
    cost_per_acre: null,
    cost_per_acre_irr: null, cost_per_acre_dry: null, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null,
    notes: null, created_at: NO_BASE_SENTINEL, updated_at: NO_BASE_SENTINEL,
  }
}

function emptyCountyAssumption(cropId: string, cropYear: number, countyId: string | null): CountyYieldAssumption {
  return {
    id: '', crop_id: cropId, county_id: countyId, crop_year: cropYear,
    variance_pct: 0,
    yield_differential: null, county_yield_override: null, rma_final_county_yield: null,
    notes: null, created_at: NO_BASE_SENTINEL, updated_at: NO_BASE_SENTINEL,
  }
}

function resolve<T extends { updated_at: string }>(args: {
  base: ReadonlyArray<T>
  overrides: ReadonlyArray<ViewerAssumptionOverride>
  keyOfRow: (row: T) => string
  keyOfOverride: (o: ViewerAssumptionOverride) => string
  allowedFields: ReadonlyArray<string>
  synthesize: (o: ViewerAssumptionOverride) => T
}): OverrideResolution<T> {
  const { base, overrides, keyOfRow, keyOfOverride, allowedFields, synthesize } = args
  if (overrides.length === 0) return { rows: [...base], staleIds: [], appliedKeys: new Set() }

  const byKey = new Map<string, T>()
  for (const row of base) byKey.set(keyOfRow(row), row)
  const effective = new Map<string, T>()
  const synthesized: T[] = []
  const staleIds: string[] = []
  const appliedKeys = new Set<string>()

  for (const o of overrides) {
    if (!allowedFields.includes(o.field)) { staleIds.push(o.id); continue }
    const key = keyOfOverride(o)
    const baseRow = byKey.get(key)
    const anchor = baseRow ? baseRow.updated_at : NO_BASE_SENTINEL
    if (!sameStamp(o.base_updated_at, anchor)) { staleIds.push(o.id); continue }
    let target = effective.get(key)
    if (!target) {
      target = baseRow ? { ...baseRow } : synthesize(o)
      effective.set(key, target)
      if (!baseRow) synthesized.push(target)
    }
    ;(target as Record<string, unknown>)[o.field] = o.value as unknown
    appliedKeys.add(overrideKey(o))
  }

  const rows = base.map((row) => effective.get(keyOfRow(row)) ?? row).concat(synthesized)
  return { rows, staleIds, appliedKeys }
}

/** Layer a viewer's crop-assumption overrides over the shared rows. */
export function resolveCropAssumptions(
  base: ReadonlyArray<CropAssumption>,
  overrides: ReadonlyArray<ViewerAssumptionOverride>,
): OverrideResolution<CropAssumption> {
  return resolve({
    base,
    overrides: overrides.filter((o) => o.scope === 'crop'),
    keyOfRow: (r) => cropKey(r.crop_id, r.crop_year),
    keyOfOverride: (o) => cropKey(o.crop_id, o.crop_year),
    allowedFields: OVERRIDABLE_CROP_FIELDS,
    synthesize: (o) => emptyCropAssumption(o.crop_id, o.crop_year),
  })
}

/** Layer a viewer's county-assumption overrides over the shared rows. */
export function resolveCountyAssumptions(
  base: ReadonlyArray<CountyYieldAssumption>,
  overrides: ReadonlyArray<ViewerAssumptionOverride>,
): OverrideResolution<CountyYieldAssumption> {
  return resolve({
    base,
    overrides: overrides.filter((o) => o.scope === 'county'),
    keyOfRow: (r) => countyKey(r.crop_id, r.crop_year, r.county_id),
    keyOfOverride: (o) => countyKey(o.crop_id, o.crop_year, o.county_id),
    allowedFields: OVERRIDABLE_COUNTY_FIELDS,
    synthesize: (o) => emptyCountyAssumption(o.crop_id, o.crop_year, o.county_id),
  })
}

/** The upsert payload for saving one override (the caller adds nothing —
 *  user_id defaults through RLS?  No: RLS checks user_id = auth.uid(), so the
 *  caller MUST pass their user id). base is the CURRENT base row (or null),
 *  whose updated_at becomes the snapshot. */
export function buildOverrideUpsert(args: {
  userId: string
  scope: 'crop' | 'county'
  cropId: string
  cropYear: number
  countyId?: string | null
  field: OverridableCropField | OverridableCountyField
  // jsonb: numeric for every field except reference_contract_month (a text label).
  value: number | string | null
  base: { updated_at: string } | null | undefined
}) {
  return {
    user_id: args.userId,
    scope: args.scope,
    crop_id: args.cropId,
    crop_year: args.cropYear,
    county_id: args.scope === 'county' ? args.countyId ?? null : null,
    field: args.field,
    value: args.value,
    base_updated_at: args.base?.updated_at ?? NO_BASE_SENTINEL,
  }
}
