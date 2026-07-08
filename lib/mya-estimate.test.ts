import { describe, it, expect } from 'vitest'
import {
  marketingYearMonths, futuresSymbolForMonth, estimateMyaBlend, futuresSymbolsForBlend,
  defaultBasisAdj, defaultMonthWeights, describeMyaComposition,
} from '@/lib/mya-estimate'

// Hand-verified worked examples for the MYA blend. The MYA is a
// marketing-weighted average of monthly farm prices — published USDA months
// where entered, futures-implied (nearest contract + basis adjustment) for the
// rest. All expected values below are computed by hand in the comments.

describe('marketingYearMonths', () => {
  it('corn/soy marketing year: Sep of the crop year through Aug of the next', () => {
    const m = marketingYearMonths(9, 2026)
    expect(m).toHaveLength(12)
    expect(m[0]).toEqual({ month: 9, year: 2026 })
    expect(m[3]).toEqual({ month: 12, year: 2026 })
    expect(m[4]).toEqual({ month: 1, year: 2027 })
    expect(m[11]).toEqual({ month: 8, year: 2027 })
  })
  it('wheat marketing year: Jun through May', () => {
    const m = marketingYearMonths(6, 2026)
    expect(m[0]).toEqual({ month: 6, year: 2026 })
    expect(m[11]).toEqual({ month: 5, year: 2027 })
  })
})

describe('futuresSymbolForMonth', () => {
  it('picks the nearest corn contract at or after the month (H/K/N/U/Z cycle)', () => {
    // April 2027 → May (K) 2027; September 2026 → Sep (U) 2026; Dec → Dec (Z).
    expect(futuresSymbolForMonth('Corn', { month: 4, year: 2027 })).toBe('ZCK27')
    expect(futuresSymbolForMonth('Corn', { month: 9, year: 2026 })).toBe('ZCU26')
    expect(futuresSymbolForMonth('Corn', { month: 12, year: 2026 })).toBe('ZCZ26')
    // August 2027 → Sep (U) 2027 (no Q corn contract).
    expect(futuresSymbolForMonth('Corn', { month: 8, year: 2027 })).toBe('ZCU27')
  })
  it('wheat maps through the Chicago Wheat root', () => {
    expect(futuresSymbolForMonth('Wheat', { month: 6, year: 2026 })).toBe('ZWN26')
  })
  it('null for untraded commodities', () => {
    expect(futuresSymbolForMonth('Seed Cotton', { month: 9, year: 2026 })).toBeNull()
  })
})

describe('defaults', () => {
  it('per-commodity basis adjustments (corn −0.35, soybeans −0.60, wheat −0.45)', () => {
    expect(defaultBasisAdj('Corn')).toBe(-0.35)
    expect(defaultBasisAdj('Soybeans')).toBe(-0.6)
    expect(defaultBasisAdj('Wheat')).toBe(-0.45)
    expect(defaultBasisAdj('Seed Cotton')).toBe(0)
  })
  it('weight vectors have 12 entries summing to ~1', () => {
    for (const name of ['Corn', 'Soybeans', 'Wheat', 'Oats']) {
      const w = defaultMonthWeights(name)
      expect(w).toHaveLength(12)
      expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6)
    }
  })
})

describe('estimateMyaBlend — 7 USDA months + 5 futures-implied (the worked example)', () => {
  // Corn 2026 (Sep 2026–Aug 2027), default corn weights
  //   [Sep .06, Oct .115, Nov .11, Dec .10, Jan .115, Feb .085, Mar .08,
  //    Apr .075, May .07, Jun .07, Jul .065, Aug .055]  (sums to 1.000)
  // Published Sep–Mar: 4.05, 4.10, 4.15, 4.20, 4.25, 4.30, 4.35.
  // Futures for the rest with basis −0.35:
  //   Apr/May → ZCK27 @ 4.60 → 4.25 ; Jun/Jul → ZCN27 @ 4.70 → 4.35 ;
  //   Aug → ZCU27 @ 4.50 → 4.15.
  // Weighted sum (weights already total 1.0):
  //   4.05×.06 + 4.10×.115 + 4.15×.11 + 4.20×.10 + 4.25×.115 + 4.30×.085
  // + 4.35×.08 + 4.25×.075 + 4.25×.07 + 4.35×.07 + 4.35×.065 + 4.15×.055
  // = .2430+.4715+.4565+.4200+.48875+.3655+.3480+.31875+.2975+.3045+.28275+.22825
  // = 4.2250
  const monthly = [
    { month: 9, price: 4.05 }, { month: 10, price: 4.1 }, { month: 11, price: 4.15 },
    { month: 12, price: 4.2 }, { month: 1, price: 4.25 }, { month: 2, price: 4.3 },
    { month: 3, price: 4.35 },
  ]
  const quotes = new Map([['ZCK27', 4.6], ['ZCN27', 4.7], ['ZCU27', 4.5]])

  it('blends published + futures-implied months with marketing weights', () => {
    const r = estimateMyaBlend({
      commodityName: 'Corn', marketingYearStartMonth: 9, cropYear: 2026,
      monthlyPrices: monthly,
      futuresPriceForSymbol: (s) => quotes.get(s) ?? null,
    })
    expect(r.publishedCount).toBe(7)
    expect(r.futuresCount).toBe(5)
    expect(r.missingCount).toBe(0)
    expect(r.basisAdj).toBe(-0.35)
    expect(r.estimate).toBeCloseTo(4.225, 4)
    // Spot-check a futures-implied month: April = ZCK27 4.60 − 0.35 = 4.25.
    const apr = r.months.find((m) => m.month === 4)!
    expect(apr.source).toBe('futures')
    expect(apr.symbol).toBe('ZCK27')
    expect(apr.price).toBeCloseTo(4.25, 4)
  })

  it('lists exactly the symbols the blend needs', () => {
    const syms = futuresSymbolsForBlend({
      commodityName: 'Corn', marketingYearStartMonth: 9, cropYear: 2026, monthlyPrices: monthly,
    })
    expect(syms.sort()).toEqual(['ZCK27', 'ZCN27', 'ZCU27'])
  })

  it('describes the composition for the MYA panel', () => {
    const r = estimateMyaBlend({
      commodityName: 'Corn', marketingYearStartMonth: 9, cropYear: 2026,
      monthlyPrices: monthly,
      futuresPriceForSymbol: (s) => quotes.get(s) ?? null,
    })
    expect(describeMyaComposition(r)).toBe('7 of 12 months USDA-published; 5 futures-implied (futures − $0.35)')
  })

  it('redistributes weight over available months when quotes are missing', () => {
    // Only two published months, no quotes at all: weights normalize over the
    // two months → (4.00×.06 + 4.40×.115) / (.06+.115) = 0.746 / 0.175 = 4.262857
    const r = estimateMyaBlend({
      commodityName: 'Corn', marketingYearStartMonth: 9, cropYear: 2026,
      monthlyPrices: [{ month: 9, price: 4.0 }, { month: 10, price: 4.4 }],
    })
    expect(r.publishedCount).toBe(2)
    expect(r.missingCount).toBe(10)
    expect(r.estimate).toBeCloseTo(4.2629, 4)
  })

  it('no prices at all → null estimate', () => {
    const r = estimateMyaBlend({
      commodityName: 'Seed Cotton', marketingYearStartMonth: 8, cropYear: 2026, monthlyPrices: [],
    })
    expect(r.estimate).toBeNull()
    expect(r.missingCount).toBe(12)
  })

  it('honors custom weights and a custom basis adjustment', () => {
    // Single published month with weight vector all on that month.
    const w = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    const r = estimateMyaBlend({
      commodityName: 'Corn', marketingYearStartMonth: 9, cropYear: 2026,
      monthlyPrices: [{ month: 9, price: 4.1 }], weights: w, basisAdj: -0.2,
    })
    expect(r.estimate).toBeCloseTo(4.1, 4)
    expect(r.basisAdj).toBe(-0.2)
  })
})
