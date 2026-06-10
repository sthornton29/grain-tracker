import { describe, it, expect } from 'vitest'
import { computeBushels } from '@/lib/shrink'
import type { ShrinkInput } from '@/lib/shrink'

// All expected values below are hand-derived from the FSA1078 formulas in
// lib/shrink.ts, not copied from the function's output:
//   wet         = netWeightLb / baseLbPerBushel
//   dry (shrink) = wet * (100 - moisture) / (100 - baseMoisture)   when mc > baseMc
//   dry          = wet                                             when mc <= baseMc
//   dry          = wet                                             when moisture/base missing
// A non-null dryBushelsOverride always replaces the computed dry value.

// Crop base parameters used in the examples.
const CORN = { baseMoisturePct: 15, baseLbPerBushel: 56 }
const SOYBEANS = { baseMoisturePct: 13, baseLbPerBushel: 60 }
const WHEAT = { baseMoisturePct: 13.5, baseLbPerBushel: 60 }

function input(over: Partial<ShrinkInput>): ShrinkInput {
  return {
    netWeightLb: null,
    moisturePct: null,
    baseMoisturePct: null,
    baseLbPerBushel: null,
    dryBushelsOverride: null,
    ...over,
  }
}

describe('computeBushels - canonical worked example', () => {
  it('50,000 lb corn at 18% moisture, base 15% / 56 lb-per-bu', () => {
    const r = computeBushels(input({
      netWeightLb: 50000,
      moisturePct: 18,
      ...CORN,
    }))
    // wet = 50000 / 56 = 892.8571428571...
    expect(r.wetBushels).toBeCloseTo(892.857142857, 6)
    // mc 18 > base 15 → shrink applies.
    // dry = wet * (100-18)/(100-15) = wet * 82/85
    //     = 50000 * 82 / (56 * 85) = 4,100,000 / 4,760 = 861.3445378151...
    expect(r.dryBushels).toBeCloseTo(861.344537815, 6)
    expect(r.computedDryBushels).toBeCloseTo(861.344537815, 6)
    expect(r.overridden).toBe(false)
    // Shrink must reduce bushels when wet of base.
    expect(r.dryBushels!).toBeLessThan(r.wetBushels!)
  })
})

describe('computeBushels - moisture vs base relationship', () => {
  it('moisture ABOVE base: dry < wet (shrink applies)', () => {
    const r = computeBushels(input({ netWeightLb: 56000, moisturePct: 20, ...CORN }))
    // wet = 56000 / 56 = 1000
    expect(r.wetBushels).toBeCloseTo(1000, 6)
    // dry = 1000 * (100-20)/(100-15) = 1000 * 80/85 = 941.1764705882...
    expect(r.dryBushels).toBeCloseTo(941.176470588, 6)
    expect(r.dryBushels!).toBeLessThan(r.wetBushels!)
  })

  it('moisture AT base: dry == wet (no shrink)', () => {
    const r = computeBushels(input({ netWeightLb: 56000, moisturePct: 15, ...CORN }))
    // wet = 56000 / 56 = 1000; mc == baseMc so code returns computedDry = wet.
    expect(r.wetBushels).toBeCloseTo(1000, 6)
    expect(r.dryBushels).toBeCloseTo(1000, 6)
    expect(r.computedDryBushels).toBeCloseTo(1000, 6)
    expect(r.dryBushels).toBe(r.wetBushels)
  })

  it('moisture BELOW base: dry == wet (buyers do not pay for expansion)', () => {
    const r = computeBushels(input({ netWeightLb: 56000, moisturePct: 12, ...CORN }))
    // mc 12 < base 15 → no shrink, dry = wet = 1000.
    expect(r.wetBushels).toBeCloseTo(1000, 6)
    expect(r.dryBushels).toBeCloseTo(1000, 6)
    expect(r.dryBushels).toBe(r.wetBushels)
  })
})

describe('computeBushels - missing moisture / base moisture fallback', () => {
  it('missing moisture → dry falls back to wet', () => {
    const r = computeBushels(input({ netWeightLb: 50000, moisturePct: null, ...CORN }))
    // wet = 50000 / 56 = 892.8571428571...; no moisture → computedDry = wet.
    expect(r.wetBushels).toBeCloseTo(892.857142857, 6)
    expect(r.dryBushels).toBeCloseTo(892.857142857, 6)
    expect(r.computedDryBushels).toBeCloseTo(892.857142857, 6)
    expect(r.dryBushels).toBe(r.wetBushels)
  })

  it('empty-string moisture is treated as missing → dry falls back to wet', () => {
    // toNum('') returns null, so this behaves the same as a missing moisture.
    const r = computeBushels(input({
      netWeightLb: 50000,
      moisturePct: '' as unknown as number,
      ...CORN,
    }))
    expect(r.dryBushels).toBe(r.wetBushels)
    expect(r.dryBushels).toBeCloseTo(892.857142857, 6)
  })

  it('missing base moisture → dry falls back to wet even with a moisture reading', () => {
    const r = computeBushels(input({
      netWeightLb: 50000,
      moisturePct: 18,
      baseMoisturePct: null,
      baseLbPerBushel: 56,
    }))
    // baseMc null → computedDry = wet (no shrink possible).
    expect(r.wetBushels).toBeCloseTo(892.857142857, 6)
    expect(r.dryBushels).toBeCloseTo(892.857142857, 6)
    expect(r.dryBushels).toBe(r.wetBushels)
  })
})

describe('computeBushels - dryBushelsOverride precedence', () => {
  it('override replaces the computed dry value but leaves wet/computed intact', () => {
    const r = computeBushels(input({
      netWeightLb: 50000,
      moisturePct: 18,
      ...CORN,
      dryBushelsOverride: 800,
    }))
    // wet and computedDry are still the canonical numbers...
    expect(r.wetBushels).toBeCloseTo(892.857142857, 6)
    expect(r.computedDryBushels).toBeCloseTo(861.344537815, 6)
    // ...but dryBushels is the override, and overridden flag is set.
    expect(r.dryBushels).toBe(800)
    expect(r.overridden).toBe(true)
  })

  it('override of 0 is honored (non-null), not the computed value', () => {
    const r = computeBushels(input({
      netWeightLb: 50000,
      moisturePct: 18,
      ...CORN,
      dryBushelsOverride: 0,
    }))
    // toNum(0) === 0 (not null), so override != null → dry = 0.
    expect(r.dryBushels).toBe(0)
    expect(r.overridden).toBe(true)
    expect(r.computedDryBushels).toBeCloseTo(861.344537815, 6)
  })

  it('override applies even when net weight / base are missing (no wet computable)', () => {
    const r = computeBushels(input({
      netWeightLb: null,
      baseLbPerBushel: null,
      dryBushelsOverride: 777,
    }))
    // Early-return branch: wet/computed null but the manual dry figure survives.
    expect(r.wetBushels).toBeNull()
    expect(r.computedDryBushels).toBeNull()
    expect(r.dryBushels).toBe(777)
    expect(r.overridden).toBe(true)
  })
})

describe('computeBushels - null / zero / missing inputs', () => {
  it('null net weight → all-null result, not overridden', () => {
    const r = computeBushels(input({ netWeightLb: null, ...CORN }))
    expect(r.wetBushels).toBeNull()
    expect(r.dryBushels).toBeNull()
    expect(r.computedDryBushels).toBeNull()
    expect(r.overridden).toBe(false)
  })

  it('zero net weight → wet and dry are 0 (0 is a valid number, not null)', () => {
    const r = computeBushels(input({ netWeightLb: 0, moisturePct: 18, ...CORN }))
    // toNum(0) === 0; net is not null so wet = 0 / 56 = 0, dry = 0.
    expect(r.wetBushels).toBe(0)
    expect(r.dryBushels).toBe(0)
    expect(r.computedDryBushels).toBe(0)
    expect(r.overridden).toBe(false)
  })

  it('missing base lb-per-bushel → all-null result (cannot convert weight)', () => {
    const r = computeBushels(input({ netWeightLb: 50000, moisturePct: 18, baseMoisturePct: 15, baseLbPerBushel: null }))
    expect(r.wetBushels).toBeNull()
    expect(r.dryBushels).toBeNull()
    expect(r.computedDryBushels).toBeNull()
    expect(r.overridden).toBe(false)
  })

  it('zero base lb-per-bushel → all-null result (guards divide-by-zero)', () => {
    const r = computeBushels(input({ netWeightLb: 50000, moisturePct: 18, baseMoisturePct: 15, baseLbPerBushel: 0 }))
    // baseLb <= 0 hits the early return, so no Infinity from division.
    expect(r.wetBushels).toBeNull()
    expect(r.dryBushels).toBeNull()
    expect(r.computedDryBushels).toBeNull()
  })

  it('negative base lb-per-bushel → all-null result (baseLb <= 0 guard)', () => {
    const r = computeBushels(input({ netWeightLb: 50000, moisturePct: 18, baseMoisturePct: 15, baseLbPerBushel: -56 }))
    expect(r.wetBushels).toBeNull()
    expect(r.dryBushels).toBeNull()
    expect(r.computedDryBushels).toBeNull()
  })

  it('non-numeric string net weight → treated as null → all-null result', () => {
    const r = computeBushels(input({
      netWeightLb: 'abc' as unknown as number,
      moisturePct: 18,
      ...CORN,
    }))
    // Number('abc') is NaN → toNum returns null → early return.
    expect(r.wetBushels).toBeNull()
    expect(r.dryBushels).toBeNull()
  })
})

describe('computeBushels - soybeans (13% / 60) and wheat (13.5% / 60)', () => {
  it('soybeans 60,000 lb at 16% moisture, base 13% / 60', () => {
    const r = computeBushels(input({ netWeightLb: 60000, moisturePct: 16, ...SOYBEANS }))
    // wet = 60000 / 60 = 1000
    expect(r.wetBushels).toBeCloseTo(1000, 6)
    // dry = 1000 * (100-16)/(100-13) = 1000 * 84/87 = 965.5172413793...
    expect(r.dryBushels).toBeCloseTo(965.517241379, 6)
    expect(r.dryBushels!).toBeLessThan(r.wetBushels!)
  })

  it('soybeans at base moisture (13%) → no shrink', () => {
    const r = computeBushels(input({ netWeightLb: 60000, moisturePct: 13, ...SOYBEANS }))
    // wet = 1000; mc == baseMc → dry = wet.
    expect(r.dryBushels).toBeCloseTo(1000, 6)
    expect(r.dryBushels).toBe(r.wetBushels)
  })

  it('wheat 60,000 lb at 15.5% moisture, base 13.5% / 60', () => {
    const r = computeBushels(input({ netWeightLb: 60000, moisturePct: 15.5, ...WHEAT }))
    // wet = 60000 / 60 = 1000
    expect(r.wetBushels).toBeCloseTo(1000, 6)
    // dry = 1000 * (100-15.5)/(100-13.5) = 1000 * 84.5/86.5 = 976.8786127168...
    expect(r.dryBushels).toBeCloseTo(976.878612717, 6)
    expect(r.dryBushels!).toBeLessThan(r.wetBushels!)
  })

  it('wheat below base (12%) → no shrink, dry == wet', () => {
    const r = computeBushels(input({ netWeightLb: 60000, moisturePct: 12, ...WHEAT }))
    expect(r.dryBushels).toBeCloseTo(1000, 6)
    expect(r.dryBushels).toBe(r.wetBushels)
  })
})
