import { describe, it, expect } from 'vitest'
import {
  NO_BASE_SENTINEL,
  overrideKey,
  resolveCropAssumptions,
  resolveCountyAssumptions,
  sameStamp,
  buildOverrideUpsert,
} from '@/lib/viewer-assumptions'
import { countyAssumptionFor } from '@/lib/crop-insurance'
import type { CropAssumption, CountyYieldAssumption, ViewerAssumptionOverride } from '@/lib/types'

// The viewer's private assumption overrides (052). The whole design is the
// staleness rule: an override carries base_updated_at (the base row's
// updated_at at save time) and applies ONLY while they still match. Any owner
// edit advances the base's updated_at (052 trigger) → the override silently
// loses. No sync job, no merge conflicts — admin wins by construction.

const T1 = '2026-08-01T10:00:00+00:00'
const T2 = '2026-08-02T10:00:00+00:00'

function baseCrop(over: Partial<CropAssumption> = {}): CropAssumption {
  return {
    id: 'a1', crop_id: 'corn', crop_year: 2026,
    expected_yield: 200, expected_yield_irr: null, expected_yield_dry: null,
    expected_yield_dc_irr: null, expected_yield_dc_dry: null, harvest_complete: false,
    assumed_basis: -0.25, assumed_futures: 4.5, reference_contract_month: null, cost_per_acre: 800, cost_per_acre_irr: null,
    cost_per_acre_dry: null, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null,
    notes: null, created_at: T1, updated_at: T1, ...over,
  }
}

function ovr(over: Partial<ViewerAssumptionOverride> = {}): ViewerAssumptionOverride {
  return {
    id: 'o1', user_id: 'u1', scope: 'crop', crop_id: 'corn', crop_year: 2026,
    county_id: null, field: 'expected_yield', value: 180, base_updated_at: T1,
    created_at: T1, updated_at: T1, ...over,
  }
}

function baseCounty(over: Partial<CountyYieldAssumption> = {}): CountyYieldAssumption {
  return {
    id: 'c1', crop_id: 'corn', county_id: 'CTY', crop_year: 2026, variance_pct: 0,
    yield_differential: 15, county_yield_override: null, rma_final_county_yield: null,
    notes: null, created_at: T1, updated_at: T1, ...over,
  }
}

describe('sameStamp', () => {
  it('matches at millisecond precision regardless of formatting', () => {
    expect(sameStamp('2026-08-01T10:00:00+00:00', '2026-08-01T10:00:00.000Z')).toBe(true)
    expect(sameStamp(T1, T2)).toBe(false)
  })
  it('fails safe on missing or unparseable stamps', () => {
    expect(sameStamp(null, T1)).toBe(false)
    expect(sameStamp('not a date', 'not a date')).toBe(false)
  })
})

describe('resolveCropAssumptions', () => {
  it('applies an override while the base snapshot still matches', () => {
    const { rows, staleIds, appliedKeys } = resolveCropAssumptions([baseCrop()], [ovr()])
    expect(rows).toHaveLength(1)
    expect(rows[0].expected_yield).toBe(180)
    expect(rows[0].cost_per_acre).toBe(800) // untouched fields keep base values
    expect(staleIds).toEqual([])
    expect(appliedKeys.has('crop|corn|2026|expected_yield')).toBe(true)
  })

  it('goes stale the moment the base row advances (admin edit wins)', () => {
    const { rows, staleIds, appliedKeys } = resolveCropAssumptions(
      [baseCrop({ updated_at: T2, expected_yield: 210 })],
      [ovr()],
    )
    expect(rows[0].expected_yield).toBe(210) // the admin's number, not the viewer's
    expect(staleIds).toEqual(['o1'])
    expect(appliedKeys.size).toBe(0)
  })

  it('never mutates the base rows (copies only)', () => {
    const base = baseCrop()
    resolveCropAssumptions([base], [ovr()])
    expect(base.expected_yield).toBe(200)
  })

  it('overriding to null works (clearing assumed_futures back to the live estimate)', () => {
    const { rows } = resolveCropAssumptions([baseCrop()], [ovr({ field: 'assumed_futures', value: null })])
    expect(rows[0].assumed_futures).toBeNull()
  })

  it('synthesizes a default row for an override saved against "no base row yet"', () => {
    const { rows, staleIds } = resolveCropAssumptions(
      [],
      [ovr({ field: 'assumed_futures', value: 5.1, base_updated_at: NO_BASE_SENTINEL })],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].assumed_futures).toBe(5.1)
    expect(rows[0].harvest_complete).toBe(false)
    expect(staleIds).toEqual([])
  })

  it('a no-base override goes stale once an owner creates the real row', () => {
    const { rows, staleIds } = resolveCropAssumptions(
      [baseCrop()],
      [ovr({ base_updated_at: NO_BASE_SENTINEL })],
    )
    expect(rows[0].expected_yield).toBe(200)
    expect(staleIds).toEqual(['o1'])
  })

  it('rejects non-overridable fields (harvest_complete is an operational fact)', () => {
    const { rows, staleIds } = resolveCropAssumptions(
      [baseCrop()],
      [ovr({ field: 'harvest_complete', value: true })],
    )
    expect(rows[0].harvest_complete).toBe(false)
    expect(staleIds).toEqual(['o1'])
  })

  it('multiple overrides on one row stack; other rows and order are preserved', () => {
    const other = baseCrop({ id: 'a2', crop_id: 'beans' })
    const { rows } = resolveCropAssumptions(
      [baseCrop(), other],
      [ovr(), ovr({ id: 'o2', field: 'assumed_basis', value: -0.1 })],
    )
    expect(rows.map((r) => r.crop_id)).toEqual(['corn', 'beans'])
    expect(rows[0].expected_yield).toBe(180)
    expect(rows[0].assumed_basis).toBe(-0.1)
    expect(rows[1]).toEqual(other)
  })

  it('two viewers are independent — each resolution sees only its own rows', () => {
    const base = [baseCrop()]
    const u1 = resolveCropAssumptions(base, [ovr({ value: 170 })])
    const u2 = resolveCropAssumptions(base, [ovr({ id: 'o9', user_id: 'u2', value: 230 })])
    const owner = resolveCropAssumptions(base, [])
    expect(u1.rows[0].expected_yield).toBe(170)
    expect(u2.rows[0].expected_yield).toBe(230)
    expect(owner.rows).toEqual(base) // owners: exact pass-through
  })
})

describe('resolveCountyAssumptions', () => {
  it('keys per crop × year × county (null county = the crop default row)', () => {
    const county = baseCounty()
    const dflt = baseCounty({ id: 'c2', county_id: null, yield_differential: 10 })
    const { rows, appliedKeys } = resolveCountyAssumptions(
      [county, dflt],
      [ovr({ scope: 'county', county_id: 'CTY', field: 'yield_differential', value: 25 })],
    )
    expect(rows.find((r) => r.county_id === 'CTY')?.yield_differential).toBe(25)
    expect(rows.find((r) => r.county_id == null)?.yield_differential).toBe(10)
    expect(appliedKeys.has('county|corn|2026|CTY|yield_differential')).toBe(true)
  })

  it('plays correctly with countyAssumptionFor’s county-then-default fallback', () => {
    // Override the DEFAULT row: a crop with a real county row must still see
    // the county row, not the overridden default.
    const { rows } = resolveCountyAssumptions(
      [baseCounty(), baseCounty({ id: 'c2', county_id: null, yield_differential: 10, updated_at: T1 })],
      [ovr({ scope: 'county', county_id: null, field: 'yield_differential', value: 99 })],
    )
    expect(countyAssumptionFor(rows, 'corn', 'CTY', 2026)?.yield_differential).toBe(15)
    expect(countyAssumptionFor(rows, 'corn', 'OTHER', 2026)?.yield_differential).toBe(99)
  })

  it('stale county overrides drop when the base advances', () => {
    const { rows, staleIds } = resolveCountyAssumptions(
      [baseCounty({ updated_at: T2 })],
      [ovr({ scope: 'county', county_id: 'CTY', field: 'county_yield_override', value: 150 })],
    )
    expect(rows[0].county_yield_override).toBeNull()
    expect(staleIds).toEqual(['o1'])
  })
})

describe('buildOverrideUpsert / overrideKey', () => {
  it('snapshots the base updated_at, or the sentinel when no base exists', () => {
    expect(buildOverrideUpsert({
      userId: 'u1', scope: 'crop', cropId: 'corn', cropYear: 2026,
      field: 'expected_yield', value: 180, base: { updated_at: T1 },
    }).base_updated_at).toBe(T1)
    expect(buildOverrideUpsert({
      userId: 'u1', scope: 'crop', cropId: 'corn', cropYear: 2026,
      field: 'expected_yield', value: 180, base: null,
    }).base_updated_at).toBe(NO_BASE_SENTINEL)
  })

  it('county_id only survives on county-scope keys', () => {
    const row = buildOverrideUpsert({
      userId: 'u1', scope: 'crop', cropId: 'corn', cropYear: 2026,
      countyId: 'CTY', field: 'expected_yield', value: 1, base: null,
    })
    expect(row.county_id).toBeNull()
    expect(overrideKey({ scope: 'crop', crop_id: 'corn', crop_year: 2026, county_id: null, field: 'f' }))
      .toBe('crop|corn|2026|f')
  })
})
