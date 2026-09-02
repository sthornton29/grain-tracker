// Freight Math — hand-verified: 25 one-way miles, $3.50 diesel, $25/hr,
// default assumptions →
//   fuel  = 50 ÷ 6.0 × 3.50            = $29.17
//   labor = (50 ÷ 45 + 0.75) × 25      = $46.53
//   wear  = 50 × 0.20                  = $10.00
//   total                              = $85.70/load
//   per bu on corn's 950-bu payload    = 9.0¢/bu (= the breakeven line)

import { describe, expect, it } from 'vitest'
import {
  FREIGHT_DEFAULTS, ROAD_FACTOR, applyManualDistance, distanceFor, freightCost,
  groupDistancesByBuyer, haversineMiles, manualDistanceRow, payloadForCrop,
  planDistanceSaves, roadMilesEstimate,
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

describe('distance estimates', () => {
  it('haversine × 1.25 road factor — Decatur AL to Town Creek AL ballpark', () => {
    // Decatur ≈ (34.606, -86.983); Town Creek ≈ (34.681, -87.407) — ~24.6 mi
    // straight-line → ~31 road miles.
    const straight = haversineMiles(34.606, -86.983, 34.681, -87.407)
    expect(straight).toBeGreaterThan(20)
    expect(straight).toBeLessThan(30)
    expect(roadMilesEstimate(34.606, -86.983, 34.681, -87.407)).toBeCloseTo(straight * ROAD_FACTOR, 10)
  })

  it('the estimate fills BLANKS ONLY: manual rows are never overwritten, and existing estimates are left alone too', () => {
    const existing = [
      { bin_site_id: 'b1', delivery_location_id: 'd1', miles: 28, source: 'manual' as const },
      { bin_site_id: 'b1', delivery_location_id: 'd2', miles: 40, source: 'estimate' as const },
    ]
    const plan = planDistanceSaves(existing, [
      { bin_site_id: 'b1', delivery_location_id: 'd1', miles: 31 }, // manual — blocked
      { bin_site_id: 'b1', delivery_location_id: 'd2', miles: 42 }, // already estimated — left alone
      { bin_site_id: 'b2', delivery_location_id: 'd1', miles: 55 }, // blank — fills
    ])
    expect(plan).toEqual([{ bin_site_id: 'b2', delivery_location_id: 'd1', miles: 55 }])
    expect(distanceFor(existing, 'b1', 'd1')).toEqual({ miles: 28, source: 'manual' })
    expect(distanceFor(existing, 'b2', 'd9')).toBeNull()
  })
})

describe('manual entry — type the miles you know', () => {
  it('saves as source manual whether or not the location has an address, without any estimate', () => {
    // A location with no address can't be geocoded — typing is its only path.
    const addressless = { id: 'd-noaddr', buyer_id: 'buyer-1', name: 'River Terminal', address: null }
    const row = manualDistanceRow('b1', addressless.id, '31.4')
    expect(row).toEqual({ bin_site_id: 'b1', delivery_location_id: 'd-noaddr', miles: 31.4, source: 'manual' })
    // The saved pair reads back as the user's own number.
    const rows = applyManualDistance([], 'b1', addressless.id, '31.4')
    expect(distanceFor(rows, 'b1', addressless.id)).toEqual({ miles: 31.4, source: 'manual' })
  })

  it('typing over an estimate replaces it with a manual row; a blank or zero entry saves nothing', () => {
    const existing = [{ bin_site_id: 'b1', delivery_location_id: 'd1', miles: 40, source: 'estimate' as const }]
    const corrected = applyManualDistance(existing, 'b1', 'd1', 37)
    expect(corrected).toEqual([{ bin_site_id: 'b1', delivery_location_id: 'd1', miles: 37, source: 'manual' }])
    expect(manualDistanceRow('b1', 'd1', '')).toBeNull()
    expect(manualDistanceRow('b1', 'd1', 0)).toBeNull()
    expect(manualDistanceRow('b1', 'd1', 'abc')).toBeNull()
    expect(applyManualDistance(existing, 'b1', 'd1', '')).toEqual(existing)
  })

  it('a manual number then survives a later estimate run (the fill-blanks rule)', () => {
    const rows = applyManualDistance([], 'b1', 'd-noaddr', 31.4)
    expect(planDistanceSaves(rows, [{ bin_site_id: 'b1', delivery_location_id: 'd-noaddr', miles: 50 }])).toEqual([])
  })
})

describe('groupDistancesByBuyer — the Settings → Buyers hierarchy with a miles cell per bin site', () => {
  const buyers = [
    { id: 'zeigler', name: 'Zeigler Grain' },
    { id: 'adm', name: 'ADM' },
  ]
  const locations = [
    { id: 'l-dec', buyer_id: 'adm', name: 'Decatur', address: '123 River Rd, Decatur AL' },
    { id: 'l-noaddr', buyer_id: 'adm', name: 'Barge dock', address: null },      // no address — still listed
    { id: 'l-zg', buyer_id: 'zeigler', name: 'Zeigler elevator', address: '' },  // blank address counts as none
    { id: 'l-orphan', buyer_id: 'gone', name: 'Old feed mill', address: null },  // buyer not in the list
  ]
  const binSites = [{ id: 'home' }, { id: 'north' }]
  const distances = [
    { bin_site_id: 'home', delivery_location_id: 'l-dec', miles: 31, source: 'manual' as const },
    { bin_site_id: 'north', delivery_location_id: 'l-dec', miles: 44.5, source: 'estimate' as const },
    { bin_site_id: 'home', delivery_location_id: 'l-noaddr', miles: 12, source: 'manual' as const },
  ]
  const groups = groupDistancesByBuyer({ buyers, locations, binSites, distances })

  it('buyers sort by name, each with its own locations beneath (sorted), plus a trailing group for orphans', () => {
    expect(groups.map((g) => g.buyerName)).toEqual(['ADM', 'Zeigler Grain', 'Other locations'])
    expect(groups[0].buyerId).toBe('adm')
    expect(groups[0].locations.map((l) => l.name)).toEqual(['Barge dock', 'Decatur'])
    expect(groups[1].locations.map((l) => l.name)).toEqual(['Zeigler elevator'])
    expect(groups[2].buyerId).toBeNull()
    expect(groups[2].locations.map((l) => l.id)).toEqual(['l-orphan'])
  })

  it('address-less locations appear with hasAddress=false — manual entry is their only path', () => {
    const dock = groups[0].locations.find((l) => l.id === 'l-noaddr')!
    expect(dock.hasAddress).toBe(false)
    expect(dock.milesBySite.get('home')).toEqual({ miles: 12, source: 'manual' })
    expect(dock.milesBySite.get('north')).toBeNull()
    expect(groups[1].locations[0].hasAddress).toBe(false) // blank string address
    expect(groups[0].locations.find((l) => l.id === 'l-dec')!.hasAddress).toBe(true)
  })

  it('every location carries one cell per bin site: saved miles with their source, or null when blank', () => {
    const dec = groups[0].locations.find((l) => l.id === 'l-dec')!
    expect([...dec.milesBySite.keys()]).toEqual(['home', 'north'])
    expect(dec.milesBySite.get('home')).toEqual({ miles: 31, source: 'manual' })
    expect(dec.milesBySite.get('north')).toEqual({ miles: 44.5, source: 'estimate' })
    const orphan = groups[2].locations[0]
    expect(orphan.milesBySite.get('home')).toBeNull()
    expect(orphan.milesBySite.get('north')).toBeNull()
  })

  it('a buyer with no locations still gets its heading (matching the settings page)', () => {
    const g = groupDistancesByBuyer({ buyers: [{ id: 'x', name: 'New Buyer' }], locations: [], binSites, distances: [] })
    expect(g).toEqual([{ buyerId: 'x', buyerName: 'New Buyer', locations: [] }])
  })
})
