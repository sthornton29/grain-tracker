import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ELECTRIC_RATE,
  SHRINK_PCT_PER_POINT,
  calibrateFromRecords,
  dryingCost,
  energyCostPerBuPt,
  lpGalToNgCcf,
  moistureRows,
  ngCcfToLpGal,
  overdryingCost,
  presetFuelPerBuPt,
  wetVsDry,
  type DryerSpec,
} from '@/lib/dryer-math'
import type { ScheduleRuleShape } from '@/lib/discount-schedules'

// Hand-verified dryer economics. The spec's worked example: 25% corn dried
// to 15% (10 points) on a mixed-flow at 0.018 gal LP per bu-pt and $1.60 LP
// → 10 × 0.018 × 1.60 = $0.288 = 28.8¢ fuel per bushel.

const mixedFlowLp: DryerSpec = { fuel: 'lp', fuelPerBuPt: 0.018, fanKwhPerBuPt: null }

describe('fuel cost', () => {
  it('25% → 15% corn at $1.60 LP and 0.018 gal/bu-pt = 28.8¢/bu', () => {
    const c = dryingCost(25, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2)
    expect(c.points).toBe(10)
    expect(c.fuelPerBu).toBeCloseTo(0.288, 10)
    expect(c.energyPerBuPt).toBeCloseTo(0.0288, 10) // 2.88¢ per point
  })
  it('fan electricity adds at the electric rate (default $0.12/kWh)', () => {
    const withFan: DryerSpec = { ...mixedFlowLp, fanKwhPerBuPt: 0.01 }
    const c = dryingCost(25, 15, withFan, { fuelPrice: 1.6 }, 4.2)
    expect(c.fanPerBu).toBeCloseTo(10 * 0.01 * DEFAULT_ELECTRIC_RATE, 10) // $0.012
    expect(c.energyPerBu).toBeCloseTo(0.288 + 0.012, 10)
  })
  it('at/below base = zero points, zero cost', () => {
    const c = dryingCost(15, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2)
    expect(c.points).toBe(0)
    expect(c.totalPerBu).toBe(0)
  })
})

describe('LP ↔ NG equivalence (BTU parity: 91,500 BTU/gal ÷ 1,020 BTU/cf)', () => {
  it('0.018 gal LP per bu-pt ≈ 0.01615 ccf NG per bu-pt', () => {
    expect(lpGalToNgCcf(0.018)).toBeCloseTo((0.018 * 91500) / 1020 / 100, 12)
    expect(lpGalToNgCcf(0.018)).toBeCloseTo(0.016147, 5)
  })
  it('round-trips', () => {
    expect(ngCcfToLpGal(lpGalToNgCcf(0.018))).toBeCloseTo(0.018, 12)
  })
  it('presetFuelPerBuPt keeps LP presets as-is and converts for NG dryers', () => {
    expect(presetFuelPerBuPt(0.018, 'lp')).toBe(0.018)
    expect(presetFuelPerBuPt(0.018, 'ng')).toBeCloseTo(0.016147, 5)
  })
  it('equal-BTU fuel prices give equal drying cost', () => {
    // NG at $/ccf priced to LP parity: $1.60/gal ÷ 0.897059 ccf/gal.
    const ngDryer: DryerSpec = { fuel: 'ng', fuelPerBuPt: lpGalToNgCcf(0.018) }
    const parityNgPrice = 1.6 / lpGalToNgCcf(1)
    const lpCost = dryingCost(25, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2)
    const ngCost = dryingCost(25, 15, ngDryer, { fuelPrice: parityNgPrice }, 4.2)
    expect(ngCost.fuelPerBu).toBeCloseTo(lpCost.fuelPerBu, 10)
  })
})

describe('shrink — the physical weight loss, valued at the grain price', () => {
  it('1.183%/pt × $4.20 corn = 4.9686¢ per point; 10 points = 49.686¢/bu', () => {
    expect(SHRINK_PCT_PER_POINT).toBe(1.183)
    const c = dryingCost(25, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2)
    expect(c.shrinkPct).toBeCloseTo(11.83, 10)
    expect(c.shrinkValuePerBu).toBeCloseTo(0.1183 * 4.2, 10) // $0.49686
    // Total cost of drying = fuel + shrink.
    expect(c.totalPerBu).toBeCloseTo(0.288 + 0.49686, 10)
  })
})

describe('overdrying — stopping below base', () => {
  it('drying corn to 13.5% against a 15.0% base combines lost volume + extra fuel', () => {
    // 1.5 points over: volume 1.5 × 1.183% × $4.20 = $0.074529;
    // fuel 1.5 × 0.018 × $1.60 = $0.0432 → total $0.117729 = 11.77¢/bu.
    const o = overdryingCost(13.5, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2)
    expect(o.pointsOver).toBeCloseTo(1.5, 10)
    expect(o.lostVolumePerBu).toBeCloseTo(0.074529, 6)
    expect(o.extraEnergyPerBu).toBeCloseTo(0.0432, 10)
    expect(o.totalPerBu).toBeCloseTo(0.117729, 6)
  })
  it('at/above base costs nothing extra', () => {
    expect(overdryingCost(15, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2).totalPerBu).toBe(0)
  })
})

describe('wetVsDry — dry it or haul it wet', () => {
  // A buyer sheet: 5¢/bu per point over 15% (tiered walk exercised in the
  // discount-schedules tests; here a linear rule keeps the arithmetic bare).
  const dryingRule: ScheduleRuleShape = {
    factor: 'drying', basis: 'cents_per_bu', base_value: 15, direction: 'above',
    rate_per_unit: 5, tiers: [], cumulative: false, rejection_at: null,
  }
  it('18% corn: buyer docks 15¢, own drying costs 23.5¢ → hauling wet is cheaper', () => {
    const v = wetVsDry(18, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2, [dryingRule])
    expect(v.buyerCents).toBeCloseTo(15, 10)
    // 3 pts: fuel 3×0.018×1.60 = 8.64¢ + shrink 3×4.9686¢ = 14.9058¢ → 23.5458¢.
    expect(v.dryCents).toBeCloseTo(23.5458, 3)
    expect(v.cheaper).toBe('haul_wet')
  })
  it('a punitive sheet flips the verdict', () => {
    const punitive = { ...dryingRule, rate_per_unit: 12 } // 12¢/point
    const v = wetVsDry(18, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2, [punitive])
    expect(v.buyerCents).toBeCloseTo(36, 10)
    expect(v.cheaper).toBe('dry')
  })
  it('tier-walk schedules run through the same rule engine', () => {
    const walk: ScheduleRuleShape = {
      factor: 'drying', basis: 'cents_per_bu', base_value: 15.5, direction: 'above',
      rate_per_unit: null, cumulative: true, rejection_at: null,
      tiers: [
        { from: 15.5, to: 17.0, rate: 6 },
        { from: 17.0, to: 19.0, rate: 10 },
      ],
    }
    // 18%: past the 6¢ tier... 18 is inside the second bracket AND inside
    // neither/past the first? 18 > 17.0 → past bracket 1 (6¢) + in bracket 2
    // (10¢) = 16¢ walked.
    const v = wetVsDry(18, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2, [walk])
    expect(v.buyerCents).toBeCloseTo(16, 10)
  })
  it('no applicable moisture rule → null verdict, own cost still shown', () => {
    const twOnly: ScheduleRuleShape = {
      factor: 'test_weight', basis: 'cents_per_bu', base_value: 54, direction: 'below',
      rate_per_unit: 4, tiers: [], cumulative: false, rejection_at: null,
    }
    const v = wetVsDry(18, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2, [twOnly])
    expect(v.buyerCents).toBeNull()
    expect(v.cheaper).toBeNull()
    expect(v.dryCents).toBeGreaterThan(0)
  })
})

describe('calibrateFromRecords', () => {
  it('5,000 gal over 40,000 bu × 7 points = 0.017857 gal/bu-pt', () => {
    const c = calibrateFromRecords({ totalFuel: 5000, bushelsDried: 40000, avgPointsRemoved: 7 })
    expect(c.buPoints).toBe(280000)
    expect(c.fuelPerBuPt).toBeCloseTo(5000 / 280000, 12)
    expect(c.fuelPerBuPt).toBeCloseTo(0.017857, 5)
  })
  it('zero/invalid inputs return null instead of Infinity', () => {
    expect(calibrateFromRecords({ totalFuel: 0, bushelsDried: 40000, avgPointsRemoved: 7 }).fuelPerBuPt).toBeNull()
    expect(calibrateFromRecords({ totalFuel: 5000, bushelsDried: 0, avgPointsRemoved: 7 }).fuelPerBuPt).toBeNull()
  })
})

describe('moistureRows', () => {
  it('half-point rows from ~3 points under base to 28', () => {
    const rows = moistureRows(15)
    expect(rows[0]).toBe(12)
    expect(rows[rows.length - 1]).toBe(28)
    expect(rows).toContain(13.5)
    expect(rows).toContain(15.5)
    // Half-point spacing throughout.
    for (let i = 1; i < rows.length; i++) expect(rows[i] - rows[i - 1]).toBeCloseTo(0.5, 10)
  })
  it('a 15.5 base still lands on clean half-points', () => {
    const rows = moistureRows(15.5)
    expect(rows[0]).toBe(12.5)
    expect(rows).toContain(15.5)
  })
})
