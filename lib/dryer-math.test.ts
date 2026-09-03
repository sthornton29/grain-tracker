import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DEPRECIATION_CENTS_PER_BU,
  DEFAULT_ELECTRIC_RATE,
  SHRINK_PCT_PER_POINT,
  calibrateFromRecords,
  depreciationCentsPerBu,
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
// → 10 × 0.018 × 1.60 = $0.288 = 28.8¢ fuel per bushel, plus the flat
// depreciation per bushel dried (4.0¢ default) — and that IS the total cost
// of drying: the water above base is unsellable whether you dry it or the
// buyer's shrink table takes it, so shrink is not a drying cost.

const mixedFlowLp: DryerSpec = { fuel: 'lp', fuelPerBuPt: 0.018, fanKwhPerBuPt: null }
/** Fuel-only rates: depreciation excluded so the energy arithmetic reads bare. */
const noDepr = { depreciationCentsPerBu: 0 }

describe('fuel cost — the energy side of drying to base', () => {
  it('25% → 15% corn at $1.60 LP and 0.018 gal/bu-pt = 28.8¢/bu fuel (shrink excluded)', () => {
    const c = dryingCost(25, 15, mixedFlowLp, { fuelPrice: 1.6, ...noDepr }, 4.2)
    expect(c.points).toBe(10)
    expect(c.fuelPerBu).toBeCloseTo(0.288, 10)
    expect(c.energyPerBuPt).toBeCloseTo(0.0288, 10) // 2.88¢ per point
    expect(c.totalPerBu).toBeCloseTo(0.288, 10)     // 28.8¢ — NOT 28.8 + 49.7
  })
  it('fan electricity adds at the electric rate (default $0.12/kWh) and IS in the total', () => {
    const withFan: DryerSpec = { ...mixedFlowLp, fanKwhPerBuPt: 0.01 }
    const c = dryingCost(25, 15, withFan, { fuelPrice: 1.6, ...noDepr }, 4.2)
    expect(c.fanPerBu).toBeCloseTo(10 * 0.01 * DEFAULT_ELECTRIC_RATE, 10) // $0.012
    expect(c.energyPerBu).toBeCloseTo(0.288 + 0.012, 10)
    expect(c.totalPerBu).toBeCloseTo(0.288 + 0.012, 10)
  })
  it('at/below base = zero points, zero cost — and no depreciation either (the bushel never ran)', () => {
    const c = dryingCost(15, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2)
    expect(c.points).toBe(0)
    expect(c.depreciationPerBu).toBe(0)
    expect(c.totalPerBu).toBe(0)
  })
  it('the grain price is optional above base — the cost does not need it', () => {
    const c = dryingCost(25, 15, mixedFlowLp, { fuelPrice: 1.6, ...noDepr })
    expect(c.totalPerBu).toBeCloseTo(0.288, 10)
    expect(c.shrinkPct).toBeCloseTo(11.83, 10)
    expect(c.shrinkValuePerBu).toBeNull()
  })
})

describe('the two-column row model — total = fuel + fan electricity + depreciation', () => {
  // 20% → 15% corn (5 points), 0.018 gal/pt, $1.60 LP:
  //   fuel     5 × 0.018 × 1.60         = $0.144  = 14.4¢
  //   electric 5 × 0.01 kWh × $0.10/kWh = $0.005  =  0.5¢
  //   depreciation (flat per bu dried)  = $0.040  =  4.0¢
  //   total                                        = 18.9¢/bu
  const withFan: DryerSpec = { ...mixedFlowLp, fanKwhPerBuPt: 0.01 }
  const rates = { fuelPrice: 1.6, electricRate: 0.1, depreciationCentsPerBu: 4.0 }

  it('20% → 15%: 14.4¢ fuel + 0.5¢ electric + 4.0¢ depreciation = 18.9¢/bu', () => {
    const c = dryingCost(20, 15, withFan, rates)
    expect(c.fuelPerBu).toBeCloseTo(0.144, 10)
    expect(c.fanPerBu).toBeCloseTo(0.005, 10)
    expect(c.depreciationPerBu).toBeCloseTo(0.04, 10)
    expect(c.totalPerBu).toBeCloseTo(0.189, 10)
    expect(c.totalPerBu * 100).toBeCloseTo(18.9, 10)
  })
  it('depreciation is flat per bushel dried, not per point: 25% → 15% still carries 4.0¢', () => {
    const ten = dryingCost(25, 15, withFan, rates)
    const five = dryingCost(20, 15, withFan, rates)
    expect(ten.depreciationPerBu).toBeCloseTo(0.04, 10)
    expect(ten.depreciationPerBu).toBeCloseTo(five.depreciationPerBu, 10)
    // Energy scales with points; depreciation does not.
    expect(ten.energyPerBu).toBeCloseTo(2 * five.energyPerBu, 10)
    expect(ten.totalPerBu).toBeCloseTo(0.288 + 0.01 + 0.04, 10)
  })
  it('omitting the figure uses the 4.0¢ default; 0 excludes it; a negative is ignored', () => {
    expect(DEFAULT_DEPRECIATION_CENTS_PER_BU).toBe(4.0)
    expect(dryingCost(20, 15, withFan, { fuelPrice: 1.6, electricRate: 0.1 }).totalPerBu).toBeCloseTo(0.189, 10)
    expect(dryingCost(20, 15, withFan, { fuelPrice: 1.6, electricRate: 0.1, depreciationCentsPerBu: 0 }).totalPerBu).toBeCloseTo(0.149, 10)
    expect(dryingCost(20, 15, withFan, { fuelPrice: 1.6, electricRate: 0.1, depreciationCentsPerBu: -3 }).depreciationPerBu).toBeCloseTo(0.04, 10)
  })
  it('the overdrying row is unchanged: lost sellable volume + extra fuel, no depreciation', () => {
    // 13.5% against a 15.0% base: 1.5 × 1.183% × $4.20 = $0.074529 volume
    // + 1.5 × 0.018 × $1.60 = $0.0432 fuel → 11.77¢/bu, with or without a
    // depreciation figure in the rates.
    const o = overdryingCost(13.5, 15, mixedFlowLp, rates, 4.2)
    expect(o.lostVolumePerBu).toBeCloseTo(0.074529, 6)
    expect(o.extraEnergyPerBu).toBeCloseTo(0.0432, 10)
    expect(o.totalPerBu).toBeCloseTo(0.117729, 6)
    expect(overdryingCost(13.5, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2).totalPerBu).toBeCloseTo(o.totalPerBu, 10)
  })
})

describe('depreciation mini-calculator — investment ÷ useful life ÷ bushels dried per year', () => {
  it('$300,000 ÷ 15 yr ÷ 500,000 bu ≈ 4.0¢/bu', () => {
    expect(depreciationCentsPerBu({ investment: 300000, usefulLifeYears: 15, bushelsDriedPerYear: 500000 })).toBeCloseTo(4.0, 10)
  })
  it('accepts typed strings; blanks, zero life/bushels, and junk give null (never Infinity)', () => {
    expect(depreciationCentsPerBu({ investment: '300000', usefulLifeYears: '15', bushelsDriedPerYear: '500000' })).toBeCloseTo(4.0, 10)
    expect(depreciationCentsPerBu({ investment: '', usefulLifeYears: 15, bushelsDriedPerYear: 500000 })).toBeNull()
    expect(depreciationCentsPerBu({ investment: 300000, usefulLifeYears: 0, bushelsDriedPerYear: 500000 })).toBeNull()
    expect(depreciationCentsPerBu({ investment: 300000, usefulLifeYears: 15, bushelsDriedPerYear: null })).toBeNull()
    expect(depreciationCentsPerBu({ investment: 'abc', usefulLifeYears: 15, bushelsDriedPerYear: 500000 })).toBeNull()
  })
  it('a smaller dryer over more bushels: $120,000 ÷ 20 yr ÷ 300,000 bu = 2.0¢', () => {
    expect(depreciationCentsPerBu({ investment: 120000, usefulLifeYears: 20, bushelsDriedPerYear: 300000 })).toBeCloseTo(2.0, 10)
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
    expect(ngCost.totalPerBu).toBeCloseTo(lpCost.totalPerBu, 10)
  })
})

describe('shrink to base — reported, never a cost', () => {
  it('1.183%/pt: 10 points = 11.83% of the wet weight, valued at $4.20 = 49.686¢ — informational only', () => {
    expect(SHRINK_PCT_PER_POINT).toBe(1.183)
    const c = dryingCost(25, 15, mixedFlowLp, { fuelPrice: 1.6, ...noDepr }, 4.2)
    expect(c.shrinkPct).toBeCloseTo(11.83, 10)
    expect(c.shrinkValuePerBu).toBeCloseTo(0.1183 * 4.2, 10) // $0.49686 — what the buyer's table would take
    // The counterfactual is identical (haul wet → the buyer shrinks it; dry
    // it → it evaporates), so the total stays fuel-only.
    expect(c.totalPerBu).toBeCloseTo(0.288, 10)
    expect(c.totalPerBu).toBeLessThan(c.fuelPerBu + c.shrinkValuePerBu!)
  })
})

describe('overdrying — stopping below base IS a cost (unchanged)', () => {
  it('drying corn to 13.5% against a 15.0% base combines lost volume + extra fuel', () => {
    // 1.5 points over: volume 1.5 × 1.183% × $4.20 = $0.074529;
    // fuel 1.5 × 0.018 × $1.60 = $0.0432 → total $0.117729 = 11.77¢/bu.
    const o = overdryingCost(13.5, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2)
    expect(o.pointsOver).toBeCloseTo(1.5, 10)
    expect(o.lostVolumePct).toBeCloseTo(1.7745, 10)
    expect(o.lostVolumePerBu).toBeCloseTo(0.074529, 6)
    expect(o.extraEnergyPerBu).toBeCloseTo(0.0432, 10)
    expect(o.totalPerBu).toBeCloseTo(0.117729, 6)
  })
  it('at/above base costs nothing extra', () => {
    expect(overdryingCost(15, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2).totalPerBu).toBe(0)
  })
})

describe('wetVsDry — the elevator shrinks first, then charges to dry what is left', () => {
  // The extension example: 20% corn on a 15.0 base, $4.20 corn, a sheet
  // printing "1.4% shrink per point + 3.5¢/pt drying".
  //   charge        3.5¢ × 5 pt                          = 17.5¢
  //   excess shrink (1.4 − 1.183)% × 5 pt × $4.20         =  4.557¢  (≈ 4.6¢)
  //   haul it wet                                          = 22.057¢ (≈ 22.1¢)
  //   dry it        14.4¢ fuel + 0.5¢ fan (+ 4.0¢ depr)    = 14.9¢ / 18.9¢
  // → drying wins with depreciation off AND on. The physical 1.183%/pt is
  // on neither side: that water is gone whether you or they dry it.
  const withFan: DryerSpec = { ...mixedFlowLp, fanKwhPerBuPt: 0.01 }
  const rates = { fuelPrice: 1.6, electricRate: 0.1, depreciationCentsPerBu: 4.0 }
  const dryingCharge: ScheduleRuleShape = {
    factor: 'drying', basis: 'cents_per_bu', base_value: 15, direction: 'above',
    rate_per_unit: 3.5, tiers: [], cumulative: false, rejection_at: null,
  }
  const sheet14: ScheduleRuleShape[] = [{ ...dryingCharge, shrink_factor_pct_per_point: 1.4 }]

  it('20% corn: 17.5¢ charge + 4.6¢ excess shrink = 22.1¢ to haul wet, itemized', () => {
    const v = wetVsDry(20, 15, withFan, rates, 4.2, sheet14)
    expect(v.reason).toBeNull()
    expect(v.buyer!.pointsPastBase).toBe(5)
    expect(v.buyer!.chargeCents).toBeCloseTo(17.5, 10)
    expect(v.buyer!.chargeBasis).toBe('cents_per_bu_per_point')
    expect(v.buyer!.shrinkPct).toBeCloseTo(7.0, 10)                      // 1.4 × 5
    expect(v.buyer!.excessShrinkPct).toBeCloseTo((1.4 - 1.183) * 5, 10)  // 1.085%
    expect(v.buyer!.excessShrinkCents).toBeCloseTo(4.557, 3)
    expect(v.buyer!.shrinkFactorPctPerPoint).toBe(1.4)
    expect(v.buyer!.shrinkFactorAssumed).toBe(false)
    expect(v.buyer!.bundled).toBe(false)
    expect(v.buyerCents).toBeCloseTo(22.057, 3)
    expect(v.buyerCents!).toBeCloseTo(22.1, 1)
  })

  it('dry-yourself wins with depreciation ON (18.9¢) and OFF (14.9¢) — the previously inverted verdict', () => {
    const on = wetVsDry(20, 15, withFan, rates, 4.2, sheet14)
    expect(on.dryCents).toBeCloseTo(18.9, 10)
    expect(on.depreciationIncluded).toBe(true)
    expect(on.cheaper).toBe('dry')
    const off = wetVsDry(20, 15, withFan, rates, 4.2, sheet14, { includeDepreciation: false })
    expect(off.dryCents).toBeCloseTo(14.9, 10)
    expect(off.cheaper).toBe('dry')
    // The old model (charge only, 17.5¢ vs 18.9¢) called this "haul it wet".
    expect(on.buyerCents!).toBeGreaterThan(on.dryCents)
  })

  it('the same sheet read as two lines (a 1.4% shrink rule + the drying rule) gives the same answer, not assumed', () => {
    const shrinkLine: ScheduleRuleShape = {
      factor: 'moisture_shrink', basis: 'weight_shrink_pct', base_value: 15, direction: 'above',
      rate_per_unit: 1.4, tiers: [], cumulative: false, rejection_at: null,
    }
    const v = wetVsDry(20, 15, withFan, rates, 4.2, [shrinkLine, dryingCharge])
    expect(v.buyer!.shrinkFactorPctPerPoint).toBe(1.4)
    expect(v.buyer!.shrinkFactorAssumed).toBe(false)
    expect(v.buyerCents).toBeCloseTo(22.057, 3)
    expect(v.cheaper).toBe('dry')
  })

  it('bundled %-of-price sheet: 2%/pt × 5 pt × $4.20 = 42¢, applied alone — no excess-shrink add-on', () => {
    const bundled: ScheduleRuleShape = {
      factor: 'drying', basis: 'pct_of_price', base_value: 15, direction: 'above',
      rate_per_unit: 2, tiers: [], cumulative: false, rejection_at: null,
    }
    const v = wetVsDry(20, 15, withFan, rates, 4.2, [bundled])
    expect(v.buyer!.bundled).toBe(true)
    expect(v.buyer!.chargeBasis).toBe('pct_of_price_per_point')
    expect(v.buyer!.chargeCents).toBeCloseTo(42, 10)
    expect(v.buyer!.shrinkPct).toBeNull()
    expect(v.buyer!.excessShrinkPct).toBe(0)
    expect(v.buyer!.excessShrinkCents).toBe(0)
    expect(v.buyer!.shrinkFactorPctPerPoint).toBeNull()
    expect(v.buyer!.shrinkFactorAssumed).toBe(false)
    expect(v.buyerCents).toBeCloseTo(42, 10)
    expect(v.cheaper).toBe('dry')
    // A %-of-price charge WITH a stated factor is not bundled: charge + excess.
    const explicit = wetVsDry(20, 15, withFan, rates, 4.2, [{ ...bundled, shrink_factor_pct_per_point: 1.4 }])
    expect(explicit.buyer!.bundled).toBe(false)
    expect(explicit.buyerCents).toBeCloseTo(42 + 4.557, 3)
  })

  it('a factor of exactly 1.183 is pure physical water — zero excess shrink, the charge alone', () => {
    const v = wetVsDry(20, 15, withFan, rates, 4.2, [{ ...dryingCharge, shrink_factor_pct_per_point: 1.183 }])
    expect(v.buyer!.excessShrinkPct).toBeCloseTo(0, 10)
    expect(v.buyer!.excessShrinkCents).toBe(0)
    expect(v.buyerCents).toBeCloseTo(17.5, 10)
    // And a factor UNDER physical never goes negative.
    const lenient = wetVsDry(20, 15, withFan, rates, 4.2, [{ ...dryingCharge, shrink_factor_pct_per_point: 1.0 }])
    expect(lenient.buyer!.excessShrinkPct).toBe(0)
    expect(lenient.buyerCents).toBeCloseTo(17.5, 10)
  })

  it('a sheet with no shrink factor on file assumes 1.4% and flags it', () => {
    const v = wetVsDry(20, 15, withFan, rates, 4.2, [dryingCharge])
    expect(v.buyer!.shrinkFactorPctPerPoint).toBe(1.4)
    expect(v.buyer!.shrinkFactorAssumed).toBe(true)
    expect(v.buyerCents).toBeCloseTo(22.057, 3)
    expect(v.cheaper).toBe('dry')
  })

  it('the schedule base wins over the crop base for the buyer side; the crop base still drives your side', () => {
    // Their sheet starts at 15.5; our crop base is 15.0. At 20%: they shrink
    // and charge 4.5 points; we dry 5.
    const v = wetVsDry(20, 15, withFan, rates, 4.2, [{ ...dryingCharge, base_value: 15.5, shrink_factor_pct_per_point: 1.4 }])
    expect(v.buyer!.pointsPastBase).toBeCloseTo(4.5, 10)
    expect(v.buyer!.chargeCents).toBeCloseTo(3.5 * 4.5, 10)
    expect(v.buyer!.excessShrinkPct).toBeCloseTo((1.4 - 1.183) * 4.5, 10)
    expect(v.dryCents).toBeCloseTo(18.9, 10)
    // No base on the sheet at all → the crop base stands in.
    const noBase = wetVsDry(20, 15, withFan, rates, 4.2, [{ ...dryingCharge, base_value: null, shrink_factor_pct_per_point: 1.4 }])
    expect(noBase.buyer!.pointsPastBase).toBe(5)
  })

  it('the grain price is required: it prices the excess shrink (and any %-of-price rule)', () => {
    const v = wetVsDry(20, 15, withFan, rates, null, sheet14)
    expect(v.buyerCents).toBeNull()
    expect(v.reason).toBe('needs_price')
    expect(v.cheaper).toBeNull()
    expect(v.dryCents).toBeCloseTo(18.9, 10)       // your side never needs it
    expect(v.buyer!.chargeCents).toBeCloseTo(17.5, 10) // the ¢/pt part still shows
    expect(v.buyer!.excessShrinkCents).toBeNull()
    // Only a ¢/bu charge with a factor at/under physical water can do without one.
    const noExcess = wetVsDry(20, 15, withFan, rates, null, [{ ...dryingCharge, shrink_factor_pct_per_point: 1.183 }])
    expect(noExcess.buyerCents).toBeCloseTo(17.5, 10)
  })

  it('a tier-walk drying charge runs through the same rule engine, plus the excess shrink', () => {
    const walk: ScheduleRuleShape = {
      factor: 'drying', basis: 'cents_per_bu', base_value: 15.5, direction: 'above',
      rate_per_unit: null, cumulative: true, rejection_at: null, shrink_factor_pct_per_point: 1.4,
      tiers: [
        { from: 15.5, to: 17.0, rate: 6 },
        { from: 17.0, to: 19.0, rate: 10 },
      ],
    }
    // 18% is past bracket 1 (6¢) and inside bracket 2 (10¢) = 16¢ walked;
    // excess shrink on 2.5 points over 15.5 = 0.217 × 2.5 × $4.20 = 2.28¢.
    const v = wetVsDry(18, 15, withFan, rates, 4.2, [walk])
    expect(v.buyer!.chargeCents).toBeCloseTo(16, 10)
    expect(v.buyer!.excessShrinkCents).toBeCloseTo(0.217 * 2.5 * 4.2, 6)
    expect(v.buyerCents).toBeCloseTo(16 + 2.27850, 4)
  })

  it('no moisture rule on the sheet → no buyer side, own cost still shown', () => {
    const twOnly: ScheduleRuleShape = {
      factor: 'test_weight', basis: 'cents_per_bu', base_value: 54, direction: 'below',
      rate_per_unit: 4, tiers: [], cumulative: false, rejection_at: null,
    }
    const v = wetVsDry(18, 15, withFan, rates, 4.2, [twOnly])
    expect(v.buyerCents).toBeNull()
    expect(v.buyer).toBeNull()
    expect(v.reason).toBe('no_moisture_rule')
    expect(v.cheaper).toBeNull()
    expect(v.dryCents).toBeGreaterThan(0)
  })

  it('a cheap sheet can still win: 1¢/pt with a 1.2% factor at 18% → 3¢ + 0.2¢ vs 8.64¢ fuel (depr off)', () => {
    const cheap: ScheduleRuleShape = { ...dryingCharge, rate_per_unit: 1, shrink_factor_pct_per_point: 1.2 }
    const v = wetVsDry(18, 15, mixedFlowLp, { fuelPrice: 1.6 }, 4.2, [cheap], { includeDepreciation: false })
    expect(v.buyer!.chargeCents).toBeCloseTo(3, 10)
    expect(v.buyer!.excessShrinkCents).toBeCloseTo((1.2 - 1.183) * 3 * 4.2, 6) // 0.214¢
    expect(v.dryCents).toBeCloseTo(8.64, 10)
    expect(v.cheaper).toBe('haul_wet')
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
