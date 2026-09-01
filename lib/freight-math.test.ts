// Freight Math — hand-verified: 25 one-way miles, $3.50 diesel, $25/hr,
// default assumptions →
//   fuel  = 50 ÷ 6.0 × 3.50            = $29.17
//   labor = (50 ÷ 45 + 0.75) × 25      = $46.53
//   wear  = 50 × 0.20                  = $10.00
//   total                              = $85.70/load
//   per bu on corn's 950-bu payload    = 9.0¢/bu (= the breakeven line)

import { describe, expect, it } from 'vitest'
import {
  FREIGHT_DEFAULTS, ROAD_FACTOR, distanceFor, freightCost, haversineMiles,
  payloadForCrop, planDistanceSaves, roadMilesEstimate,
} from '@/lib/freight-math'

describe('freightCost', () => {
  const c = freightCost({ oneWayMiles: 25, dieselPrice: 3.5, laborRate: 25, payloadBu: 950 })

  it('itemizes fuel, labor, and wear per the worked example', () => {
    expect(c.roundTripMiles).toBe(50)
    expect(c.fuel).toBeCloseTo(50 / 6 * 3.5, 10) // 29.1667
    expect(c.labor).toBeCloseTo((50 / 45 + 0.75) * 25, 10) // 46.5278
    expect(c.wear).toBeCloseTo(10, 10)
    expect(c.ownership).toBe(0) // toggle off by default
    expect(c.totalPerLoad).toBeCloseTo(85.6944, 3)
  })

  it('cost per bushel is the headline and equals the breakeven line', () => {
    expect(c.centsPerBu).toBeCloseTo(9.02, 2) // 85.6944 / 950 × 100
    expect(c.breakevenCentsPerBu).toBe(c.centsPerBu)
  })

  it('custom-rate equivalent is $/loaded (one-way) mile', () => {
    expect(c.customRatePerLoadedMile).toBeCloseTo(85.6944 / 25, 3) // ≈ $3.43
  })

  it('ownership costs enter only via the toggle', () => {
    const withOwn = freightCost({
      oneWayMiles: 25, dieselPrice: 3.5, laborRate: 25, payloadBu: 950,
      settings: { ...FREIGHT_DEFAULTS, includeOwnership: true, ownershipPerMile: 0.3 },
    })
    expect(withOwn.ownership).toBeCloseTo(15, 10)
    expect(withOwn.totalPerLoad).toBeCloseTo(c.totalPerLoad + 15, 6)
  })

  it('a crop without a payload still costs per load, never per bushel', () => {
    const noPayload = freightCost({ oneWayMiles: 25, dieselPrice: 3.5, laborRate: 25, payloadBu: null })
    expect(noPayload.totalPerLoad).toBeCloseTo(c.totalPerLoad, 10)
    expect(noPayload.perBu).toBeNull()
    expect(noPayload.breakevenCentsPerBu).toBeNull()
  })
})

describe('payloadForCrop (test-weight derived, override wins)', () => {
  it('corn 56# → 950 bu; soybeans/wheat 60# → 880; canola 50# → 1,060', () => {
    expect(payloadForCrop(56)).toBe(950)
    expect(payloadForCrop(60)).toBe(880)
    expect(payloadForCrop(50)).toBe(1060)
  })
  it('an org override wins; a lbs-native crop (no lb/bu) has no bushel payload', () => {
    expect(payloadForCrop(56, 900)).toBe(900)
    expect(payloadForCrop(null)).toBeNull()
    expect(payloadForCrop(0)).toBeNull()
  })
})

describe('distances', () => {
  it('haversine × 1.25 road factor — Decatur AL to Town Creek AL ballpark', () => {
    // Decatur ≈ (34.606, -86.983); Town Creek ≈ (34.681, -87.407) — ~24.6 mi
    // straight-line → ~31 road miles.
    const straight = haversineMiles(34.606, -86.983, 34.681, -87.407)
    expect(straight).toBeGreaterThan(20)
    expect(straight).toBeLessThan(30)
    expect(roadMilesEstimate(34.606, -86.983, 34.681, -87.407)).toBeCloseTo(straight * ROAD_FACTOR, 10)
  })

  it('a manual correction sticks: re-estimates never overwrite a manual row', () => {
    const existing = [
      { bin_site_id: 'b1', delivery_location_id: 'd1', miles: 28, source: 'manual' as const },
      { bin_site_id: 'b1', delivery_location_id: 'd2', miles: 40, source: 'estimate' as const },
    ]
    const plan = planDistanceSaves(existing, [
      { bin_site_id: 'b1', delivery_location_id: 'd1', miles: 31 }, // manual — blocked
      { bin_site_id: 'b1', delivery_location_id: 'd2', miles: 42 }, // estimate — refresh
      { bin_site_id: 'b2', delivery_location_id: 'd1', miles: 55 }, // new — insert
    ])
    expect(plan).toEqual([
      { bin_site_id: 'b1', delivery_location_id: 'd2', miles: 42 },
      { bin_site_id: 'b2', delivery_location_id: 'd1', miles: 55 },
    ])
    expect(distanceFor(existing, 'b1', 'd1')).toEqual({ miles: 28, source: 'manual' })
    expect(distanceFor(existing, 'b2', 'd9')).toBeNull()
  })
})
