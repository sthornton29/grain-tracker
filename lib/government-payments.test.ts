import { describe, it, expect } from 'vitest'
import {
  computePlcPayment, computeArcCoPayment, seedCottonMya, effectiveReferencePrice,
  myaPrice, paymentLimitTotal, expectedArcPlcDate, computeCommodityPayment, projectPayments,
  PAYMENT_FACTOR, LINT_SHARE, COTTONSEED_SHARE,
} from '@/lib/government-payments'
import { DEFAULT_SEQUESTRATION_PCT } from '@/lib/program-config'
import type {
  ArcPlcElection, ArcPlcPayment, ArcPlcPriceData, CoveredCommodity, FarmBaseAcres,
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
    marketing_year_start_month: 9, marketing_year_end_month: 8, created_at: '',
    ...over,
  }
}

function priceData(over: Partial<ArcPlcPriceData> = {}): ArcPlcPriceData {
  return {
    id: 'pd', commodity_id: 'corn', crop_year: 2026,
    effective_reference_price: null, mya_price_estimate: null, mya_price_final: null,
    source: 'manual', updated_at: '',
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

// ---------- computeArcCoPayment ----------

describe('computeArcCoPayment', () => {
  it('computes ARC-CO from a projected rate per acre with default factor/sequestration', () => {
    // rate 45.00, base 200
    // gross = 45 * 200 = 9000.00
    // net   = 9000 * 0.85 * 0.946 = 7650 * 0.946 = 7236.90
    const r = computeArcCoPayment({ projectedRatePerAcre: 45.00, baseAcres: 200 })
    expect(r.effectivePrice).toBe(0)
    expect(r.paymentRatePerUnit).toBeCloseTo(45.00, 6)
    expect(r.grossPerAcre).toBeCloseTo(45.00, 2)
    expect(r.gross).toBeCloseTo(9000.00, 2)
    expect(r.net).toBeCloseTo(7236.90, 2)
  })

  it('honors a custom sequestrationPct', () => {
    // rate 45, base 200, seq 0.10 => net = 9000 * 0.85 * 0.90 = 6885.00
    const r = computeArcCoPayment({ projectedRatePerAcre: 45.00, baseAcres: 200, sequestrationPct: 0.10 })
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

  it('ARC-CO with a projected rate is computable and matches computeArcCoPayment', () => {
    const r = computeCommodityPayment({
      commodity: commodity(), baseAcres: 200, plcYield: 130, election: 'ARC_CO',
      priceData: priceData({ mya_price_estimate: 3.50 }), arcRatePerAcre: 45,
    })
    const direct = computeArcCoPayment({ projectedRatePerAcre: 45, baseAcres: 200 })
    expect(r.computable).toBe(true)
    expect(r.effectivePrice).toBeNull() // ARC has no effective price
    expect(r.myaPrice).toBe(3.50) // carried through from price data
    expect(r.gross).toBeCloseTo(direct.gross, 2) // 9000
    expect(r.net).toBeCloseTo(direct.net, 2) // 7236.90
  })

  it('ARC-CO with a null rate is not computable and returns zeros', () => {
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
