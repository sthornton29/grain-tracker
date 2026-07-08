import { describe, it, expect } from 'vitest'
import {
  computePlcPayment, computeArcCoPayment, computeArcCoFlatPayment, seedCottonMya, effectiveReferencePrice,
  myaPrice, paymentLimitTotal, expectedArcPlcDate, computeCommodityPayment, projectPayments,
  resolveMyaPrice, applyMyaResolution,
  olympicAverage, computeEffectiveReferencePrice, arcBenchmarkPriceFromHistory,
  resolveArcBenchmark, expectedCountyYield,
  PAYMENT_FACTOR, LINT_SHARE, COTTONSEED_SHARE,
} from '@/lib/government-payments'
import { DEFAULT_SEQUESTRATION_PCT } from '@/lib/program-config'
import type {
  ArcBenchmarkData, ArcPlcElection, ArcPlcPayment, ArcPlcPriceData, CoveredCommodity, FarmBaseAcres,
} from '@/lib/types'

// Hand-verified worked examples for the ARC/PLC engine. Every expected money
// value below is derived from the formula in the source comments, with the
// arithmetic shown so a reviewer can re-check it without running the code.
//
// Shared constants used in the worked examples:
//   PAYMENT_FACTOR            = 0.85
//   DEFAULT_SEQUESTRATION_PCT = 0.054  => (1 - seq) = 0.946

// ---------- builders for minimal fixture rows ----------

function commodity(over: Partial<CoveredCommodity> = {}): CoveredCommodity {
  return {
    id: 'corn', name: 'Corn', crop_id: null,
    statutory_reference_price: 4.10, unit: 'bushel', national_loan_rate: 2.20,
    marketing_year_start_month: 9, marketing_year_end_month: 8,
    mya_basis_adj: null, mya_month_weights: null, created_at: '',
    ...over,
  }
}

function priceData(over: Partial<ArcPlcPriceData> = {}): ArcPlcPriceData {
  return {
    id: 'pd', commodity_id: 'corn', crop_year: 2026,
    effective_reference_price: null, mya_price_estimate: null, mya_price_final: null,
    wasde_midpoint: null, mya_note: null,
    source: 'manual', updated_at: '',
    ...over,
  }
}

function benchmarkRow(over: Partial<ArcBenchmarkData> = {}): ArcBenchmarkData {
  return {
    id: 'bm', commodity_id: 'corn', crop_year: 2026, county: null,
    benchmark_price: 5.03, benchmark_yield: 200,
    price_source: 'usda', yield_source: 'usda',
    county_yield_vs_benchmark_pct: 0, source_description: null,
    created_at: '', updated_at: '',
    ...over,
  }
}

function baseAcresRow(over: Partial<FarmBaseAcres> = {}): FarmBaseAcres {
  return {
    id: 'ba', farm_id: 'farm-1', commodity_id: 'corn', base_acres: 100, plc_yield: 130,
    is_unassigned: false, source: 'manual', notes: null, created_at: '', updated_at: '',
    ...over,
  }
}

function electionRow(over: Partial<ArcPlcElection> = {}): ArcPlcElection {
  return {
    id: 'el', farm_id: 'farm-1', commodity_id: 'corn', crop_year: 2026,
    election: 'PLC', created_at: '',
    ...over,
  }
}

function paymentRow(over: Partial<ArcPlcPayment> = {}): ArcPlcPayment {
  return {
    id: 'pay', farm_id: 'farm-1', commodity_id: 'corn', crop_year: 2026, election: 'ARC_CO',
    base_acres: 100, plc_yield: 130, payment_rate_per_unit: 45, gross_payment: 0,
    payment_factor: 0.85, sequestration_pct: 0.054, net_payment: 0,
    payment_status: 'projected', expected_payment_date: null, actual_payment_date: null,
    actual_payment_amount: null, notes: null, created_at: '',
    ...over,
  }
}

// ---------- computePlcPayment ----------

describe('computePlcPayment', () => {
  it('computes the standard PLC payment with default factor (0.85) and sequestration (0.054)', () => {
    // effRef 4.10, mya 3.50, loan 2.20, yield 130, base 100
    // effectivePrice = max(3.50, 2.20)            = 3.50
    // paymentRate    = max(0, 4.10 - 3.50)        = 0.60
    // grossPerAcre   = 0.60 * 130                 = 78.00
    // gross          = 78.00 * 100                = 7800.00
    // net            = 7800 * 0.85 * 0.946        = 6271.98
    const r = computePlcPayment({
      effectiveReferencePrice: 4.10, myaPrice: 3.50, nationalLoanRate: 2.20,
      plcYield: 130, baseAcres: 100,
    })
    expect(r.effectivePrice).toBeCloseTo(3.50, 6)
    expect(r.paymentRatePerUnit).toBeCloseTo(0.60, 6)
    expect(r.grossPerAcre).toBeCloseTo(78.00, 2)
    expect(r.gross).toBeCloseTo(7800.00, 2)
    expect(r.net).toBeCloseTo(6271.98, 2)
  })

  it('floors the effective price at the national loan rate when MYA is below it', () => {
    // mya 1.80 < loan 2.20 => effectivePrice = max(1.80, 2.20) = 2.20
    // paymentRate = max(0, 4.10 - 2.20) = 1.90
    // grossPerAcre = 1.90 * 130 = 247.00 ; gross = 24700.00
    // net = 24700 * 0.85 * 0.946 = 20995 * 0.946 = 19861.27
    const r = computePlcPayment({
      effectiveReferencePrice: 4.10, myaPrice: 1.80, nationalLoanRate: 2.20,
      plcYield: 130, baseAcres: 100,
    })
    expect(r.effectivePrice).toBeCloseTo(2.20, 6)
    expect(r.paymentRatePerUnit).toBeCloseTo(1.90, 6)
    expect(r.gross).toBeCloseTo(24700.00, 2)
    expect(r.net).toBeCloseTo(19861.27, 2)
  })

  it('pays nothing when the MYA price is at or above the effective reference price', () => {
    // mya 4.50 >= effRef 4.10 => effectivePrice = max(4.50, 2.20) = 4.50
    // paymentRate = max(0, 4.10 - 4.50) = 0 => gross 0, net 0
    const r = computePlcPayment({
      effectiveReferencePrice: 4.10, myaPrice: 4.50, nationalLoanRate: 2.20,
      plcYield: 130, baseAcres: 100,
    })
    expect(r.effectivePrice).toBeCloseTo(4.50, 6)
    expect(r.paymentRatePerUnit).toBe(0)
    expect(r.grossPerAcre).toBe(0)
    expect(r.gross).toBe(0)
    expect(r.net).toBe(0)
  })

  it('honors a custom sequestrationPct', () => {
    // Same inputs as the standard case but seq = 0.10 => (1 - seq) = 0.90
    // net = 7800 * 0.85 * 0.90 = 6630 * 0.90 = 5967.00
    const r = computePlcPayment({
      effectiveReferencePrice: 4.10, myaPrice: 3.50, nationalLoanRate: 2.20,
      plcYield: 130, baseAcres: 100, sequestrationPct: 0.10,
    })
    expect(r.net).toBeCloseTo(5967.00, 2)
  })

  it('honors a custom paymentFactor', () => {
    // Same inputs, paymentFactor = 1 (no 85% factor), default seq 0.054
    // net = 7800 * 1 * 0.946 = 7378.80
    const r = computePlcPayment({
      effectiveReferencePrice: 4.10, myaPrice: 3.50, nationalLoanRate: 2.20,
      plcYield: 130, baseAcres: 100, paymentFactor: 1,
    })
    expect(r.net).toBeCloseTo(7378.80, 2)
  })
})

// ---------- Effective Reference Price (ERP) ----------

describe('olympicAverage', () => {
  it('drops the single highest and lowest, averages the rest', () => {
    // 5 values: drop 3.00 and 6.00, average (4.00 + 4.50 + 5.00) / 3 = 4.50
    expect(olympicAverage([4.5, 3.0, 5.0, 6.0, 4.0])).toBeCloseTo(4.5, 6)
  })
  it('needs at least 3 values', () => {
    expect(olympicAverage([4, 5])).toBeNull()
    expect(olympicAverage([])).toBeNull()
  })
})

describe('computeEffectiveReferencePrice — the three OBBBA regimes (88% / statutory / 115% cap)', () => {
  // Corn statutory $4.10; cap = 1.15 × 4.10 = 4.715.
  it('regime 1 — statutory floor: 88% of a low Olympic average stays below statutory', () => {
    // 0.88 × 4.50 = 3.96 < 4.10 → ERP = 4.10
    expect(computeEffectiveReferencePrice({
      statutoryReferencePrice: 4.10, olympicAvgMya: 4.50, erpOlympicFactor: 0.88, erpCapPct: 1.15,
    })).toBeCloseTo(4.10, 6)
  })
  it('regime 2 — escalator: 88% of the Olympic average lands between statutory and the cap', () => {
    // 0.88 × 5.10 = 4.488; 4.10 < 4.488 < 4.715 → ERP = 4.488
    expect(computeEffectiveReferencePrice({
      statutoryReferencePrice: 4.10, olympicAvgMya: 5.10, erpOlympicFactor: 0.88, erpCapPct: 1.15,
    })).toBeCloseTo(4.488, 6)
  })
  it('regime 3 — 115% cap: a high Olympic average is clamped', () => {
    // 0.88 × 5.60 = 4.928 > 4.715 → ERP = 4.715
    expect(computeEffectiveReferencePrice({
      statutoryReferencePrice: 4.10, olympicAvgMya: 5.60, erpOlympicFactor: 0.88, erpCapPct: 1.15,
    })).toBeCloseTo(4.715, 6)
  })
  it('no Olympic average → statutory stands', () => {
    expect(computeEffectiveReferencePrice({ statutoryReferencePrice: 4.10, olympicAvgMya: null })).toBe(4.10)
  })
  it('effectiveReferencePrice prefers the FSA-published value, else computes, else statutory', () => {
    const c = commodity({ statutory_reference_price: 4.10 })
    // Published wins over a computed Olympic escalation.
    expect(effectiveReferencePrice(c, priceData({ effective_reference_price: 4.42 }), { olympicAvgMya: 5.10 })).toBe(4.42)
    // No published → computed from the Olympic average.
    expect(effectiveReferencePrice(c, null, { olympicAvgMya: 5.10, erpOlympicFactor: 0.88, erpCapPct: 1.15 })).toBeCloseTo(4.488, 6)
  })
})

describe('arcBenchmarkPriceFromHistory — ERP substitution', () => {
  it('substitutes the ERP for any year whose MYA fell below it, then Olympic-averages', () => {
    // ERP 4.10 every year. MYAs: 6.00, 4.85, 3.80→4.10, 4.50, 3.90→4.10
    // Substituted: [6.00, 4.85, 4.10, 4.50, 4.10]; drop 6.00 & one 4.10,
    // average (4.85 + 4.50 + 4.10) / 3 = 13.45 / 3 = 4.483333
    const p = arcBenchmarkPriceFromHistory([
      { mya: 6.00, erp: 4.10 }, { mya: 4.85, erp: 4.10 }, { mya: 3.80, erp: 4.10 },
      { mya: 4.50, erp: 4.10 }, { mya: 3.90, erp: 4.10 },
    ])
    expect(p).toBeCloseTo(4.483333, 5)
  })
  it('a year with no MYA counts at its ERP', () => {
    const p = arcBenchmarkPriceFromHistory([
      { mya: null, erp: 4.10 }, { mya: 4.50, erp: 4.10 }, { mya: 5.00, erp: 4.10 },
      { mya: 4.80, erp: 4.10 }, { mya: 4.20, erp: 4.10 },
    ])
    // Substituted: [4.10, 4.50, 5.00, 4.80, 4.20]; drop 4.10 & 5.00 → (4.50+4.80+4.20)/3 = 4.50
    expect(p).toBeCloseTo(4.5, 6)
  })
  it('needs at least 3 years', () => {
    expect(arcBenchmarkPriceFromHistory([{ mya: 4, erp: 4 }])).toBeNull()
  })
})

// ---------- computeArcCoPayment — the county-revenue engine ----------

describe('computeArcCoPayment (county-revenue engine)', () => {
  // The 2025 corn benchmark price $5.03 with a 200 bu/ac benchmark county yield:
  //   benchmark revenue = 5.03 × 200 = 1006.00 $/ac
  //   guarantee (90%)   = 905.40 $/ac
  //   cap (12%)         = 120.72 $/ac
  it('pays the revenue shortfall when the 12% cap does NOT bind', () => {
    // MYA 4.20, county at benchmark (yield 200): actual = 4.20 × 200 = 840.00
    // shortfall = 905.40 − 840.00 = 65.40 ≤ 120.72 → rate 65.40
    // gross = 65.40 × 1000 ac = 65,400; net = 65,400 × 0.85 × 0.946 = 52,588.14
    const r = computeArcCoPayment({
      benchmarkPrice: 5.03, benchmarkYield: 200, myaPrice: 4.20, actualCountyYield: 200,
      nationalLoanRate: 2.42, baseAcres: 1000, guaranteePct: 0.90, capPct: 0.12,
    })
    expect(r.benchmarkRevenue).toBeCloseTo(1006.00, 2)
    expect(r.guarantee).toBeCloseTo(905.40, 2)
    expect(r.actualRevenue).toBeCloseTo(840.00, 2)
    expect(r.paymentRatePerUnit).toBeCloseTo(65.40, 2)
    expect(r.capped).toBe(false)
    expect(r.gross).toBeCloseTo(65400.00, 2)
    expect(r.net).toBeCloseTo(52588.14, 2)
  })

  it('caps the rate at 12% of benchmark revenue when the shortfall exceeds it', () => {
    // MYA 3.80, county −5% (yield 190): actual = 3.80 × 190 = 722.00
    // shortfall = 905.40 − 722.00 = 183.40 > 120.72 → rate capped at 120.72
    // gross = 120.72 × 1000 = 120,720; net = 120,720 × 0.85 × 0.946 = 97,070.95
    const r = computeArcCoPayment({
      benchmarkPrice: 5.03, benchmarkYield: 200, myaPrice: 3.80, actualCountyYield: 190,
      nationalLoanRate: 2.42, baseAcres: 1000, guaranteePct: 0.90, capPct: 0.12,
    })
    expect(r.capped).toBe(true)
    expect(r.maxRatePerAcre).toBeCloseTo(120.72, 2)
    expect(r.paymentRatePerUnit).toBeCloseTo(120.72, 2)
    expect(r.gross).toBeCloseTo(120720.00, 2)
    expect(r.net).toBeCloseTo(97070.95, 2)
  })

  it('the 90% trigger can pay even with county yield ABOVE benchmark when the MYA is well below the benchmark price', () => {
    // County +2% (yield 204), MYA 4.00: actual = 4.00 × 204 = 816.00 < 905.40
    // shortfall = 89.40 ≤ 120.72 → a payment despite the above-benchmark yield.
    const r = computeArcCoPayment({
      benchmarkPrice: 5.03, benchmarkYield: 200, myaPrice: 4.00, actualCountyYield: 204,
      nationalLoanRate: 2.42, baseAcres: 100, guaranteePct: 0.90, capPct: 0.12,
    })
    expect(r.paymentRatePerUnit).toBeCloseTo(89.40, 2)
    expect(r.capped).toBe(false)
    expect(r.paymentRatePerUnit).toBeGreaterThan(0)
  })

  it('floors the price in actual county revenue at the national loan rate', () => {
    // MYA 2.00 below loan 2.42 → actual = 2.42 × 200 = 484.00 (not 400.00)
    const r = computeArcCoPayment({
      benchmarkPrice: 5.03, benchmarkYield: 200, myaPrice: 2.00, actualCountyYield: 200,
      nationalLoanRate: 2.42, baseAcres: 100, guaranteePct: 0.90, capPct: 0.12,
    })
    expect(r.effectivePrice).toBeCloseTo(2.42, 6)
    expect(r.actualRevenue).toBeCloseTo(484.00, 2)
  })

  it('never pays when actual revenue meets the guarantee', () => {
    // MYA 5.00 × 200 = 1000 > 905.40 → rate 0
    const r = computeArcCoPayment({
      benchmarkPrice: 5.03, benchmarkYield: 200, myaPrice: 5.00, actualCountyYield: 200,
      nationalLoanRate: 2.42, baseAcres: 100, guaranteePct: 0.90, capPct: 0.12,
    })
    expect(r.paymentRatePerUnit).toBe(0)
    expect(r.net).toBe(0)
  })
})

describe('expectedCountyYield', () => {
  it('applies the % above/below expectation to the benchmark yield', () => {
    expect(expectedCountyYield(200, 0)).toBe(200)
    expect(expectedCountyYield(200, -5)).toBe(190)
    expect(expectedCountyYield(200, 2)).toBe(204)
  })
})

describe('resolveArcBenchmark', () => {
  const rows: ArcBenchmarkData[] = [
    benchmarkRow({ id: 'default', county: null }),
    benchmarkRow({ id: 'washington', county: 'Washington', benchmark_yield: 185 }),
  ]
  it('a county-specific row (case-insensitive) wins over the default row', () => {
    expect(resolveArcBenchmark({ commodityId: 'corn', cropYear: 2026, county: 'washington', benchmarks: rows })?.id).toBe('washington')
  })
  it('falls back to the county-null default row', () => {
    expect(resolveArcBenchmark({ commodityId: 'corn', cropYear: 2026, county: 'Lee', benchmarks: rows })?.id).toBe('default')
    expect(resolveArcBenchmark({ commodityId: 'corn', cropYear: 2026, county: null, benchmarks: rows })?.id).toBe('default')
  })
  it('null when no rows match the commodity/year', () => {
    expect(resolveArcBenchmark({ commodityId: 'soy', cropYear: 2026, county: null, benchmarks: rows })).toBeNull()
    expect(resolveArcBenchmark({ commodityId: 'corn', cropYear: 2025, county: null, benchmarks: rows })).toBeNull()
  })
})

// ---------- computeArcCoFlatPayment — the fallback ----------

describe('computeArcCoFlatPayment', () => {
  it('computes ARC from a projected rate per acre with default factor/sequestration', () => {
    // rate 45.00, base 200
    // gross = 45 * 200 = 9000.00
    // net   = 9000 * 0.85 * 0.946 = 7650 * 0.946 = 7236.90
    const r = computeArcCoFlatPayment({ projectedRatePerAcre: 45.00, baseAcres: 200 })
    expect(r.effectivePrice).toBe(0)
    expect(r.paymentRatePerUnit).toBeCloseTo(45.00, 6)
    expect(r.grossPerAcre).toBeCloseTo(45.00, 2)
    expect(r.gross).toBeCloseTo(9000.00, 2)
    expect(r.net).toBeCloseTo(7236.90, 2)
  })

  it('honors a custom sequestrationPct', () => {
    // rate 45, base 200, seq 0.10 => net = 9000 * 0.85 * 0.90 = 6885.00
    const r = computeArcCoFlatPayment({ projectedRatePerAcre: 45.00, baseAcres: 200, sequestrationPct: 0.10 })
    expect(r.net).toBeCloseTo(6885.00, 2)
  })
})

// ---------- seedCottonMya ----------

describe('seedCottonMya', () => {
  it('blends lint ($/lb) and cottonseed ($/ton converted to $/lb)', () => {
    // lint 0.70 $/lb, cottonseed 300 $/ton
    // cottonseedPerLb = 300 / 2000 = 0.15
    // mya = 0.43 * 0.70 + 0.57 * 0.15 = 0.301 + 0.0855 = 0.3865
    expect(seedCottonMya(0.70, 300)).toBeCloseTo(0.3865, 6)
  })

  it('uses the documented weight shares', () => {
    expect(LINT_SHARE).toBe(0.43)
    expect(COTTONSEED_SHARE).toBe(0.57)
  })
})

// ---------- effectiveReferencePrice ----------

describe('effectiveReferencePrice', () => {
  it('uses the price-data override when present', () => {
    const r = effectiveReferencePrice(commodity({ statutory_reference_price: 4.10 }), priceData({ effective_reference_price: 4.26 }))
    expect(r).toBe(4.26)
  })

  it('falls back to the commodity statutory reference price when there is no override', () => {
    expect(effectiveReferencePrice(commodity({ statutory_reference_price: 4.10 }), priceData({ effective_reference_price: null }))).toBe(4.10)
    expect(effectiveReferencePrice(commodity({ statutory_reference_price: 4.10 }), null)).toBe(4.10)
    expect(effectiveReferencePrice(commodity({ statutory_reference_price: 4.10 }))).toBe(4.10)
  })
})

// ---------- myaPrice ----------

describe('myaPrice', () => {
  it('prefers the final price over the estimate', () => {
    expect(myaPrice(priceData({ mya_price_final: 3.90, mya_price_estimate: 3.50 }))).toBe(3.90)
  })

  it('uses the estimate when there is no final', () => {
    expect(myaPrice(priceData({ mya_price_final: null, mya_price_estimate: 3.50 }))).toBe(3.50)
  })

  it('is null when neither final nor estimate is set', () => {
    expect(myaPrice(priceData({ mya_price_final: null, mya_price_estimate: null }))).toBeNull()
    expect(myaPrice(null)).toBeNull()
    expect(myaPrice()).toBeNull()
  })
})

// ---------- paymentLimitTotal ----------

describe('paymentLimitTotal', () => {
  it('multiplies eligible persons by the per-person limit', () => {
    // 2 persons * 155000 = 310000
    expect(paymentLimitTotal(2, 155000)).toBe(310000)
  })
})

// ---------- expectedArcPlcDate ----------

describe('expectedArcPlcDate', () => {
  it('returns Oct 1 of the year after the crop year', () => {
    expect(expectedArcPlcDate(2026)).toBe('2027-10-01')
    expect(expectedArcPlcDate(2025)).toBe('2026-10-01')
  })
})

// ---------- computeCommodityPayment ----------

describe('computeCommodityPayment', () => {
  it('PLC with no MYA price is not computable and returns zeros', () => {
    const r = computeCommodityPayment({
      commodity: commodity(), baseAcres: 100, plcYield: 130, election: 'PLC',
      priceData: priceData({ mya_price_final: null, mya_price_estimate: null }),
    })
    expect(r.computable).toBe(false)
    expect(r.myaPrice).toBeNull()
    expect(r.effectivePrice).toBeNull()
    expect(r.gross).toBe(0)
    expect(r.net).toBe(0)
    // The effective reference price still resolves from the commodity.
    expect(r.effectiveReferencePrice).toBe(4.10)
  })

  it('PLC with an MYA price matches computePlcPayment', () => {
    const args = {
      commodity: commodity({ statutory_reference_price: 4.10, national_loan_rate: 2.20 }),
      baseAcres: 100, plcYield: 130, election: 'PLC' as const,
      priceData: priceData({ mya_price_estimate: 3.50 }),
    }
    const r = computeCommodityPayment(args)
    const direct = computePlcPayment({
      effectiveReferencePrice: 4.10, myaPrice: 3.50, nationalLoanRate: 2.20,
      plcYield: 130, baseAcres: 100,
    })
    expect(r.computable).toBe(true)
    expect(r.myaPrice).toBe(3.50)
    expect(r.effectivePrice).toBeCloseTo(direct.effectivePrice, 6)
    expect(r.paymentRatePerUnit).toBeCloseTo(direct.paymentRatePerUnit, 6)
    expect(r.gross).toBeCloseTo(direct.gross, 2)
    expect(r.net).toBeCloseTo(direct.net, 2) // 6271.98
  })

  it('ARC-CO without benchmark data falls back to the flat rate and matches computeArcCoFlatPayment', () => {
    const r = computeCommodityPayment({
      commodity: commodity(), baseAcres: 200, plcYield: 130, election: 'ARC_CO',
      priceData: priceData({ mya_price_estimate: 3.50 }), arcRatePerAcre: 45,
    })
    const direct = computeArcCoFlatPayment({ projectedRatePerAcre: 45, baseAcres: 200 })
    expect(r.computable).toBe(true)
    expect(r.arcMethod).toBe('flat')
    expect(r.arcDetail).toBeNull()
    expect(r.effectivePrice).toBeNull() // ARC has no effective price
    expect(r.myaPrice).toBe(3.50) // carried through from price data
    expect(r.gross).toBeCloseTo(direct.gross, 2) // 9000
    expect(r.net).toBeCloseTo(direct.net, 2) // 7236.90
  })

  it('ARC-CO with benchmark data runs the county-revenue engine and matches computeArcCoPayment', () => {
    const bm = benchmarkRow({ benchmark_price: 5.03, benchmark_yield: 200, county_yield_vs_benchmark_pct: -5 })
    const r = computeCommodityPayment({
      commodity: commodity({ national_loan_rate: 2.42 }), baseAcres: 1000, plcYield: 130, election: 'ARC_CO',
      priceData: priceData({ mya_price_estimate: 3.80 }), arcRatePerAcre: null,
      benchmark: bm, arcGuaranteePct: 0.90, arcPaymentCapPct: 0.12,
    })
    // −5% expectation → actual county yield 190; same capped worked example as
    // the direct engine test: rate 120.72, net 97,070.95 on 1000 acres.
    const direct = computeArcCoPayment({
      benchmarkPrice: 5.03, benchmarkYield: 200, myaPrice: 3.80, actualCountyYield: 190,
      nationalLoanRate: 2.42, baseAcres: 1000, guaranteePct: 0.90, capPct: 0.12,
    })
    expect(r.computable).toBe(true)
    expect(r.arcMethod).toBe('engine')
    expect(r.arcDetail?.actualCountyYield).toBe(190)
    expect(r.arcDetail?.capped).toBe(true)
    expect(r.net).toBeCloseTo(direct.net, 2) // 97,070.95
  })

  it('ARC-IC uses the 65% payment factor on the flat rate', () => {
    // rate 45 × 200 ac = 9000 gross; net = 9000 × 0.65 × 0.946 = 5534.10
    const r = computeCommodityPayment({
      commodity: commodity(), baseAcres: 200, plcYield: 130, election: 'ARC_IC',
      arcRatePerAcre: 45,
    })
    expect(r.computable).toBe(true)
    expect(r.net).toBeCloseTo(5534.10, 2)
  })

  it('ARC-CO with a null rate and no benchmark is not computable and returns zeros', () => {
    const r = computeCommodityPayment({
      commodity: commodity(), baseAcres: 200, plcYield: 130, election: 'ARC_CO',
      arcRatePerAcre: null,
    })
    expect(r.computable).toBe(false)
    expect(r.gross).toBe(0)
    expect(r.net).toBe(0)
  })
})

// ---------- projectPayments ----------

describe('projectPayments', () => {
  it('projects each eligible farm x commodity, skipping unassigned and null-commodity rows', () => {
    const corn = commodity({ id: 'corn', name: 'Corn', statutory_reference_price: 4.10, national_loan_rate: 2.20 })
    const soy = commodity({ id: 'soy', name: 'Soybeans', statutory_reference_price: 10.00, national_loan_rate: 6.20 })

    const baseAcres: FarmBaseAcres[] = [
      // PLC by default (no election row) — corn, 100 ac, yield 130.
      baseAcresRow({ id: 'b1', farm_id: 'farm-1', commodity_id: 'corn', base_acres: 100, plc_yield: 130 }),
      // ARC-CO via election row — soy, 200 ac.
      baseAcresRow({ id: 'b2', farm_id: 'farm-1', commodity_id: 'soy', base_acres: 200, plc_yield: 50 }),
      // Unassigned generic base — must be skipped.
      baseAcresRow({ id: 'b3', farm_id: 'farm-1', commodity_id: 'corn', base_acres: 999, plc_yield: 0, is_unassigned: true }),
      // Null commodity — must be skipped.
      baseAcresRow({ id: 'b4', farm_id: 'farm-1', commodity_id: null, base_acres: 50, plc_yield: 0 }),
    ]
    const commodities = [corn, soy]
    const elections: ArcPlcElection[] = [
      electionRow({ farm_id: 'farm-1', commodity_id: 'soy', crop_year: 2026, election: 'ARC_CO' }),
    ]
    const prices: ArcPlcPriceData[] = [
      priceData({ commodity_id: 'corn', crop_year: 2026, mya_price_estimate: 3.50 }),
    ]
    const payments: ArcPlcPayment[] = [
      paymentRow({ farm_id: 'farm-1', commodity_id: 'soy', crop_year: 2026, election: 'ARC_CO', payment_rate_per_unit: 45 }),
    ]

    const out = projectPayments({ cropYear: 2026, baseAcres, commodities, elections, priceData: prices, payments })

    // Only the two eligible rows survive (b3 unassigned, b4 null commodity skipped).
    expect(out).toHaveLength(2)

    // --- Row 1: corn PLC (default election) ---
    const cornOut = out.find((o) => o.commodityId === 'corn')!
    expect(cornOut.election).toBe('PLC') // defaulted (no election row)
    expect(cornOut.baseAcres).toBe(100)
    expect(cornOut.plcYield).toBe(130)
    expect(cornOut.arcRatePerAcre).toBeNull()
    expect(cornOut.result.computable).toBe(true)
    // net = 0.60 * 130 * 100 * 0.85 * 0.946 = 6271.98 (same worked example as above)
    expect(cornOut.result.net).toBeCloseTo(6271.98, 2)

    // --- Row 2: soy ARC-CO using the payment row's payment_rate_per_unit ---
    const soyOut = out.find((o) => o.commodityId === 'soy')!
    expect(soyOut.election).toBe('ARC_CO')
    expect(soyOut.baseAcres).toBe(200)
    expect(soyOut.arcRatePerAcre).toBe(45)
    expect(soyOut.result.computable).toBe(true)
    // net = 45 * 200 * 0.85 * 0.946 = 7236.90
    expect(soyOut.result.net).toBeCloseTo(7236.90, 2)
  })

  it('defaults to PLC when no election row exists and respects sequestrationPct override', () => {
    const corn = commodity({ id: 'corn', statutory_reference_price: 4.10, national_loan_rate: 2.20 })
    const out = projectPayments({
      cropYear: 2026,
      baseAcres: [baseAcresRow({ commodity_id: 'corn', base_acres: 100, plc_yield: 130 })],
      commodities: [corn],
      elections: [],
      priceData: [priceData({ commodity_id: 'corn', crop_year: 2026, mya_price_estimate: 3.50 })],
      payments: [],
      sequestrationPct: 0.10,
    })
    expect(out).toHaveLength(1)
    expect(out[0].election).toBe('PLC')
    // net with seq 0.10 = 7800 * 0.85 * 0.90 = 5967.00
    expect(out[0].result.net).toBeCloseTo(5967.00, 2)
  })

  it('leaves ARC rate null (not computable) when no matching payment row exists', () => {
    const corn = commodity({ id: 'corn' })
    const out = projectPayments({
      cropYear: 2026,
      baseAcres: [baseAcresRow({ commodity_id: 'corn', base_acres: 100, plc_yield: 130 })],
      commodities: [corn],
      elections: [electionRow({ commodity_id: 'corn', crop_year: 2026, election: 'ARC_CO' })],
      priceData: [],
      payments: [], // no payment row → arcRate stays null
    })
    expect(out).toHaveLength(1)
    expect(out[0].election).toBe('ARC_CO')
    expect(out[0].arcRatePerAcre).toBeNull()
    expect(out[0].result.computable).toBe(false)
    expect(out[0].result.net).toBe(0)
  })
})

// Sanity: documented constant matches the engine's default factor.
describe('PAYMENT_FACTOR / default sequestration constants', () => {
  it('match the documented values', () => {
    expect(PAYMENT_FACTOR).toBe(0.85)
    expect(DEFAULT_SEQUESTRATION_PCT).toBe(0.054)
  })
})

// ---------- resolveMyaPrice / applyMyaResolution (shared MYA resolution) ----------

describe('resolveMyaPrice', () => {
  it('a published final outranks everything — including a source=manual row', () => {
    // The Settings page stamps source='manual' on every edit while carrying the
    // old Barchart estimate forward, so the final MUST win or entering a USDA
    // final would leave a stale estimate driving PLC.
    const r = resolveMyaPrice({
      commodityName: 'Corn',
      priceData: priceData({ source: 'manual', mya_price_estimate: 4.50, mya_price_final: 4.10 }),
      liveEstimate: 4.20,
    })
    expect(r).toEqual({ price: 4.10, state: 'final', manualOnly: false, live: false })
  })

  it('a manual override (no final yet) outranks the live estimate', () => {
    const r = resolveMyaPrice({
      commodityName: 'Corn',
      priceData: priceData({ source: 'manual', mya_price_estimate: 3.80 }),
      liveEstimate: 4.20,
    })
    expect(r).toEqual({ price: 3.80, state: 'manual', manualOnly: false, live: false })
  })

  it('live estimate beats the stored estimate for a tradeable commodity', () => {
    const r = resolveMyaPrice({
      commodityName: 'Corn',
      priceData: priceData({ source: 'barchart', mya_price_estimate: 4.10 }),
      liveEstimate: 4.22,
    })
    expect(r).toEqual({ price: 4.22, state: 'estimate', manualOnly: false, live: true })
  })

  it('falls back to the stored estimate, else missing', () => {
    expect(resolveMyaPrice({
      commodityName: 'Corn',
      priceData: priceData({ source: 'barchart', mya_price_estimate: 4.10 }),
    })).toEqual({ price: 4.10, state: 'estimate', manualOnly: false, live: false })
    expect(resolveMyaPrice({ commodityName: 'Corn' }).state).toBe('missing')
  })

  it('a typed WASDE midpoint overrides the blended (live) estimate within the estimate tier', () => {
    const r = resolveMyaPrice({
      commodityName: 'Corn',
      priceData: priceData({ source: 'wasde', wasde_midpoint: 4.05, mya_price_estimate: 4.22 }),
      liveEstimate: 4.22,
    })
    expect(r).toEqual({ price: 4.05, state: 'wasde', manualOnly: false, live: false })
  })

  it('WASDE precedence: final > manual > wasde > blended', () => {
    // manual beats wasde
    const manual = resolveMyaPrice({
      commodityName: 'Corn',
      priceData: priceData({ source: 'manual', mya_price_estimate: 3.80, wasde_midpoint: 4.05 }),
      liveEstimate: 4.22,
    })
    expect(manual.state).toBe('manual')
    expect(manual.price).toBe(3.80)
    // final beats wasde
    const final = resolveMyaPrice({
      commodityName: 'Corn',
      priceData: priceData({ mya_price_final: 4.15, wasde_midpoint: 4.05, source: 'usda' }),
    })
    expect(final.state).toBe('final')
    expect(final.price).toBe(4.15)
    // myaPrice (the projectPayments-side resolver) agrees on all tiers
    expect(myaPrice(priceData({ mya_price_final: 4.15, wasde_midpoint: 4.05, source: 'usda' }))).toBe(4.15)
    expect(myaPrice(priceData({ source: 'manual', mya_price_estimate: 3.80, wasde_midpoint: 4.05 }))).toBe(3.80)
    expect(myaPrice(priceData({ source: 'wasde', wasde_midpoint: 4.05, mya_price_estimate: 4.22 }))).toBe(4.05)
  })

  it('Barchart-less commodities are manual-only: the live estimate is ignored', () => {
    // Seed cotton has no traded-futures mapping, so a "live" number can only be
    // a bug upstream — resolution must never surface it.
    const r = resolveMyaPrice({ commodityName: 'Seed Cotton', liveEstimate: 0.38 })
    expect(r).toEqual({ price: null, state: 'missing', manualOnly: true, live: false })
    const manual = resolveMyaPrice({
      commodityName: 'Seed Cotton',
      priceData: priceData({ commodity_id: 'sc', source: 'manual', mya_price_estimate: 0.36 }),
      liveEstimate: 0.38,
    })
    expect(manual).toEqual({ price: 0.36, state: 'manual', manualOnly: true, live: false })
  })
})

describe('applyMyaResolution', () => {
  const corn = commodity({ id: 'corn', name: 'Corn' })
  const seedCotton = commodity({ id: 'sc', name: 'Seed Cotton' })

  it('a manual override (no final yet) survives the live merge', () => {
    const rows = applyMyaResolution({
      cropYear: 2026,
      commodities: [corn],
      priceData: [priceData({ source: 'manual', mya_price_estimate: 3.80 })],
      liveEstimates: new Map([['corn', 4.22]]),
    })
    expect(rows).toHaveLength(1)
    expect(myaPrice(rows[0])).toBe(3.80)
  })

  it('a source=manual row with a published final resolves to the final', () => {
    const rows = applyMyaResolution({
      cropYear: 2026,
      commodities: [corn],
      priceData: [priceData({ source: 'manual', mya_price_estimate: 4.50, mya_price_final: 4.10 })],
      liveEstimates: new Map([['corn', 4.22]]),
    })
    expect(myaPrice(rows[0])).toBe(4.10)
  })

  it('creates a synthetic row for a live-only commodity and passes other years through', () => {
    const prior = priceData({ id: 'pd-2025', crop_year: 2025, mya_price_final: 4.85 })
    const rows = applyMyaResolution({
      cropYear: 2026,
      commodities: [corn, seedCotton],
      priceData: [prior],
      liveEstimates: new Map([['corn', 4.22], ['sc', 0.38]]),
    })
    // 2025 row untouched; corn gets a synthetic 2026 row; manual-only seed
    // cotton gets nothing from the (ignored) live estimate.
    expect(rows.find((r) => r.crop_year === 2025)).toEqual(prior)
    const cornRow = rows.find((r) => r.commodity_id === 'corn' && r.crop_year === 2026)
    expect(myaPrice(cornRow)).toBe(4.22)
    expect(rows.some((r) => r.commodity_id === 'sc' && r.crop_year === 2026)).toBe(false)
  })

  it('keeps a published final when nothing overrides it', () => {
    const rows = applyMyaResolution({
      cropYear: 2026,
      commodities: [corn],
      priceData: [priceData({ source: 'usda', mya_price_estimate: 4.20, mya_price_final: 4.05 })],
      liveEstimates: new Map([['corn', 4.30]]),
    })
    expect(myaPrice(rows[0])).toBe(4.05)
  })

  it('clears wasde_midpoint on output rows so downstream myaPrice cannot re-rank it above the resolution', () => {
    // A manual override + a WASDE midpoint: the resolution picks manual; the
    // baked row must not let myaPrice() pick the wasde column instead.
    const rows = applyMyaResolution({
      cropYear: 2026,
      commodities: [corn],
      priceData: [priceData({ source: 'manual', mya_price_estimate: 3.80, wasde_midpoint: 4.05 })],
      liveEstimates: new Map([['corn', 4.22]]),
    })
    expect(rows[0].wasde_midpoint).toBeNull()
    expect(myaPrice(rows[0])).toBe(3.80)
    // And a wasde-driven resolution rides the estimate slot with the WASDE value.
    const rows2 = applyMyaResolution({
      cropYear: 2026,
      commodities: [corn],
      priceData: [priceData({ source: 'wasde', wasde_midpoint: 4.05, mya_price_estimate: 4.30 })],
      liveEstimates: new Map([['corn', 4.22]]),
    })
    expect(rows2[0].wasde_midpoint).toBeNull()
    expect(myaPrice(rows2[0])).toBe(4.05)
  })
})

// ---------- projectPayments with benchmarks (the shared Decision Aid / Tracker path) ----------

describe('projectPayments — ARC-CO engine via benchmarks + farm county', () => {
  it('resolves the farm county to its benchmark row and runs the engine', () => {
    const corn = commodity({ id: 'corn', national_loan_rate: 2.42 })
    const out = projectPayments({
      cropYear: 2026,
      baseAcres: [baseAcresRow({ commodity_id: 'corn', base_acres: 1000, plc_yield: 130 })],
      commodities: [corn],
      elections: [electionRow({ commodity_id: 'corn', crop_year: 2026, election: 'ARC_CO' })],
      priceData: [priceData({ commodity_id: 'corn', crop_year: 2026, mya_price_estimate: 4.20, source: 'barchart' })],
      payments: [],
      benchmarks: [benchmarkRow({ benchmark_price: 5.03, benchmark_yield: 200, county: 'Washington' })],
      farms: [{ id: 'farm-1', county: 'Washington' }],
      arcGuaranteePct: 0.90, arcPaymentCapPct: 0.12,
    })
    expect(out).toHaveLength(1)
    expect(out[0].result.arcMethod).toBe('engine')
    // Same uncapped worked example: rate 65.40 × 1000 × 0.85 × 0.946 = 52,588.14
    expect(out[0].result.net).toBeCloseTo(52588.14, 2)
    expect(out[0].result.arcDetail?.capped).toBe(false)
  })

  it('falls back to the flat rate when no benchmark row matches', () => {
    const corn = commodity({ id: 'corn' })
    const out = projectPayments({
      cropYear: 2026,
      baseAcres: [baseAcresRow({ commodity_id: 'corn', base_acres: 200, plc_yield: 130 })],
      commodities: [corn],
      elections: [electionRow({ commodity_id: 'corn', crop_year: 2026, election: 'ARC_CO' })],
      priceData: [],
      payments: [paymentRow({ commodity_id: 'corn', crop_year: 2026, payment_rate_per_unit: 45 })],
      benchmarks: [],
      farms: [{ id: 'farm-1', county: 'Washington' }],
    })
    expect(out[0].result.arcMethod).toBe('flat')
    expect(out[0].result.net).toBeCloseTo(7236.90, 2)
  })
})
