import { describe, it, expect } from 'vitest'
import {
  centsPerBu,
  coerceDiscountCategory,
  categoryTotals,
  effectivePriceWalk,
  excessShrink,
  sumCheck,
} from '@/lib/settlement-discounts'
import { computeBushels } from '@/lib/shrink'

// Hand-verified worked examples. Every ¢/bu figure divides by the SETTLED
// (pay) bushels, and the price walk is gross $/bu → less discounts ¢/bu →
// net $/bu, so the identity net = gross − disc/100 must hold exactly.

describe('centsPerBu — itemized ¢/bu math', () => {
  it('$75 over 1,000 settled bu = 7.5¢/bu', () => {
    expect(centsPerBu(75, 1000)).toBeCloseTo(7.5, 10)
  })
  it('$512.25 over 2,049 bu = 25.0¢/bu (hand: 512.25/2049×100)', () => {
    expect(centsPerBu(512.25, 2049)).toBeCloseTo(25.0, 10)
  })
  it('no bushels → null, never Infinity', () => {
    expect(centsPerBu(75, 0)).toBeNull()
  })
})

describe('sumCheck — itemized lines vs the stated discount total', () => {
  const items = [
    { category: 'drying', amount: 75 },
    { category: 'test_weight', amount: 41 },
    { category: 'other', amount: 12.5 },
  ]
  it('matching sum (within tolerance) does not flag', () => {
    // Σ items = 128.50 vs stated 128.50 → delta 0.
    const r = sumCheck(items, 128.5)
    expect(r.itemizedTotal).toBeCloseTo(128.5, 10)
    expect(r.delta).toBeCloseTo(0, 10)
    expect(r.mismatch).toBe(false)
  })
  it('rounding-level drift stays quiet ($0.30 on $128.50)', () => {
    expect(sumCheck(items, 128.2).mismatch).toBe(false)
  })
  it('a real gap flags: stated $150 vs itemized $128.50', () => {
    const r = sumCheck(items, 150)
    expect(r.delta).toBeCloseTo(-21.5, 10)
    expect(r.mismatch).toBe(true)
  })
  it('no items at all is "nothing to check", not a mismatch', () => {
    expect(sumCheck([], 150).mismatch).toBe(false)
  })
})

describe('categoryTotals + category coercion', () => {
  it('sums by category, coercing loose spellings into the enum', () => {
    const totals = categoryTotals([
      { category: 'drying', amount: 50 },
      { category: 'Drying', amount: 25 }, // case-insensitive
      { category: 'test weight', amount: 41 }, // space → underscore
      { category: 'checkoff fee', amount: 3 }, // unknown → other
    ])
    expect(totals.get('drying')).toBeCloseTo(75, 10)
    expect(totals.get('test_weight')).toBeCloseTo(41, 10)
    expect(totals.get('other')).toBeCloseTo(3, 10)
  })
  it('coerceDiscountCategory maps variants and defaults to other', () => {
    expect(coerceDiscountCategory('musty/sour')).toBe('musty_sour')
    expect(coerceDiscountCategory('Foreign Material')).toBe('foreign_material')
    expect(coerceDiscountCategory('mystery charge')).toBe('other')
    expect(coerceDiscountCategory(null)).toBe('other')
  })
})

describe('effectivePriceWalk — gross → less discounts → net', () => {
  it('worked: 1,000 bu, $4,500 gross, $128.50 discounts', () => {
    const w = effectivePriceWalk({ grossRevenue: 4500, discountTotal: 128.5, settledBu: 1000 })
    expect(w.grossPerBu).toBeCloseTo(4.5, 10) // 4500/1000
    expect(w.discountCentsPerBu).toBeCloseTo(12.85, 10) // 128.50/1000×100
    expect(w.netPerBu).toBeCloseTo(4.3715, 10) // (4500−128.50)/1000
    // The walk closes: net = gross − discounts/100.
    expect(w.netPerBu!).toBeCloseTo(w.grossPerBu! - w.discountCentsPerBu! / 100, 10)
  })
  it('zero bushels → all null', () => {
    const w = effectivePriceWalk({ grossRevenue: 100, discountTotal: 10, settledBu: 0 })
    expect(w.grossPerBu).toBeNull()
    expect(w.discountCentsPerBu).toBeNull()
    expect(w.netPerBu).toBeNull()
  })
})

describe('excessShrink — pay-bushels vs FSA-standard dry bushels, monetized', () => {
  it('worked example straight off the FSA shrink seam (lib/shrink.ts)', () => {
    // Corn load: 56,000 lb at 18.0% moisture, base 15.5% / 56 lb per bu.
    // wet = 56,000/56 = 1,000 bu; dry = 1,000 × (100−18)/(100−15.5)
    //     = 1,000 × 82/84.5 = 970.4142… bu (the FSA-standard figure).
    const { dryBushels } = computeBushels({
      netWeightLb: 56000,
      moisturePct: 18,
      baseMoisturePct: 15.5,
      baseLbPerBushel: 56,
    })
    expect(dryBushels).toBeCloseTo(970.4142, 3)
    // Buyer paid on only 960 bu at $4.37115/bu:
    //   gap = 970.4142 − 960 = 10.4142 bu
    //   dollars = 10.4142 × 4.37115 = $45.52…
    //   ¢/bu on the 960 settled = 45.52/960×100 = 4.742…¢
    const x = excessShrink({ ourDryBu: dryBushels!, settledBu: 960, pricePerBu: 4.37115 })
    expect(x.bu).toBeCloseTo(10.4142, 3)
    expect(x.dollars).toBeCloseTo(10.414201 * 4.37115, 2)
    expect(x.centsPerBu!).toBeCloseTo(((10.414201 * 4.37115) / 960) * 100, 2)
    expect(x.centsPerBu!).toBeGreaterThan(0) // a cost — positive
  })
  it('buyer paying MORE bushels than standard shrink goes negative (favorable)', () => {
    const x = excessShrink({ ourDryBu: 950, settledBu: 960, pricePerBu: 4.5 })
    expect(x.bu).toBeCloseTo(-10, 10)
    expect(x.dollars).toBeCloseTo(-45, 10)
    expect(x.centsPerBu!).toBeLessThan(0)
  })
})
