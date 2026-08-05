import { describe, it, expect } from 'vitest'
import {
  guaranteePriceFor,
  computeIndemnity,
  computeBandIndemnity,
  resolveEstimatedCountyYield,
  countyAssumptionFor,
  computePolicy,
  computeStaxIndemnity,
  computeMcoIndemnity,
  stackingWarnings,
  staxArcPlcWarning,
  projectedPriceFromEstimates,
  reconcileAcreage,
  acreageTolerance,
  resolveUploadEntityId,
  resolveHarvestPriceByCrop,
  practiceActualYieldByCrop,
  projectInsuranceIndemnities,
  totalProjectedIndemnity,
  centsToInsuranceDollars,
  classifyPolicyUpload,
  type PolicyUploadValues,
  type PolicyInputs,
  type BandInputs,
  type CountyAssumptionLike,
} from '@/lib/crop-insurance'
import type { HarvestPriceEstimate, CropInsurancePolicy, CropInsuranceSco, CropAssumption, FieldPlanting, CountyYieldAssumption } from '@/lib/types'

// ---------------------------------------------------------------------------
// Fixtures for the shared indemnity projection. Builders fill every field so the
// objects are real DB types; tests override only what they exercise.
// ---------------------------------------------------------------------------
function mkPolicy(over: Partial<CropInsurancePolicy> = {}): CropInsurancePolicy {
  return {
    id: 'p1', entity_id: null, crop_id: 'corn', crop_year: 2026, county_id: 'A',
    policy_number: null, plan_type: 'RP', practice: 'non_irrigated', coverage_level: 0.8,
    unit_structure: 'enterprise', aph_yield: 100, projected_price: 5, harvest_price: null,
    volatility_factor: null, insured_acres: 100, premium_per_acre: null, total_premium: null,
    premium_subsidy_pct: null, notes: null, covers_all_planted_acres: false, coverage_note: null,
    expected_county_yield: null, expected_county_revenue: null, protection_factor: null,
    source: 'manual', created_at: '2026-01-01', ...over,
  }
}
function mkAssumption(over: Partial<CropAssumption> = {}): CropAssumption {
  return {
    id: 'a1', crop_id: 'corn', crop_year: 2026, expected_yield: null,
    expected_yield_irr: null, expected_yield_dry: null, expected_yield_dc_irr: null, expected_yield_dc_dry: null,
    harvest_complete: false, assumed_basis: 0, assumed_futures: null,
    cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null,
    notes: null, ...over,
  } as CropAssumption
}
function mkEstimate(over: Partial<HarvestPriceEstimate> = {}): HarvestPriceEstimate {
  return { id: 'e1', crop_id: 'corn', crop_year: 2026, price_type: 'harvest_estimate', price: 5, price_date: '2026-09-01', source: null, created_at: '2026-09-01', ...over } as HarvestPriceEstimate
}
function mkPlanting(over: Partial<FieldPlanting> = {}): FieldPlanting {
  return {
    crop_id: 'corn', season_year: 2026, irrigated_acres: 0, dryland_acres: 0,
    irrigated_bushels: null, dryland_bushels: null,
    ...over,
  } as FieldPlanting
}

// All worked examples below are hand-derived from the formulas/comments in
// lib/crop-insurance.ts. Arithmetic is shown inline so a reviewer can re-check
// every money figure without running the code. Money is compared with
// toBeCloseTo(…, 2) since the engine rounds to cents.

// ---------------------------------------------------------------------------
// guaranteePriceFor
// ---------------------------------------------------------------------------
describe('guaranteePriceFor', () => {
  it('RP uses MAX(projected, harvest) — harvest higher', () => {
    // max(4.62, 5.00) = 5.00
    expect(guaranteePriceFor('RP', 4.62, 5.0)).toBeCloseTo(5.0, 6)
  })

  it('RP uses MAX(projected, harvest) — projected higher', () => {
    // max(4.62, 4.00) = 4.62
    expect(guaranteePriceFor('RP', 4.62, 4.0)).toBeCloseTo(4.62, 6)
  })

  it('YP uses MAX(projected, harvest) — same rule as RP', () => {
    // max(4.62, 5.00) = 5.00 ; max(4.62, 4.00) = 4.62
    expect(guaranteePriceFor('YP', 4.62, 5.0)).toBeCloseTo(5.0, 6)
    expect(guaranteePriceFor('YP', 4.62, 4.0)).toBeCloseTo(4.62, 6)
  })

  it('RP_HPE uses the PROJECTED price only, ignoring a higher harvest price', () => {
    // RP-HPE excludes the harvest-price increase → stays at projected 4.62.
    expect(guaranteePriceFor('RP_HPE', 4.62, 5.0)).toBeCloseTo(4.62, 6)
    expect(guaranteePriceFor('RP_HPE', 4.62, 4.0)).toBeCloseTo(4.62, 6)
  })
})

// ---------------------------------------------------------------------------
// computeIndemnity — RP
// ---------------------------------------------------------------------------
describe('computeIndemnity — RP', () => {
  const baseRP: PolicyInputs = {
    planType: 'RP',
    coverageLevel: 0.8,
    aphYield: 180,
    projectedPrice: 4.62,
    harvestPrice: 4.0,
    insuredAcres: 100,
    actualYield: 120,
  }

  it('pays when actual revenue < revenue guarantee', () => {
    // gp = max(4.62, 4.00) = 4.62
    // revenueGuarantee = 180 * 0.80 * 4.62 * 100
    //                  = 144 * 4.62 * 100 = 665.28 * 100 = 66,528.00
    // actualRevenue    = 120 * 4.00 * 100 = 48,000.00
    // indemnity        = max(0, 66528 - 48000) = 18,528.00
    const r = computeIndemnity(baseRP)
    expect(r.guaranteePrice).toBeCloseTo(4.62, 6)
    expect(r.revenueGuarantee).toBeCloseTo(66528.0, 2)
    expect(r.expectedRevenue).toBeCloseTo(48000.0, 2) // "expectedRevenue" holds actualRevenue
    expect(r.indemnity).toBeCloseTo(18528.0, 2)
    // RP has no yield-protection intermediates
    expect(r.productionGuaranteeBu).toBeUndefined()
    expect(r.actualProductionBu).toBeUndefined()
    expect(r.indemnityBushels).toBeUndefined()
  })

  it('pays nothing when actual revenue >= revenue guarantee (no loss)', () => {
    // actualYield 200, harvest 4.62 → gp = max(4.62, 4.62) = 4.62
    // revenueGuarantee = 180 * 0.80 * 4.62 * 100 = 66,528.00
    // actualRevenue    = 200 * 4.62 * 100 = 92,400.00 (> guarantee)
    // indemnity        = max(0, 66528 - 92400) = 0
    const r = computeIndemnity({ ...baseRP, actualYield: 200, harvestPrice: 4.62 })
    expect(r.guaranteePrice).toBeCloseTo(4.62, 6)
    expect(r.revenueGuarantee).toBeCloseTo(66528.0, 2)
    expect(r.expectedRevenue).toBeCloseTo(92400.0, 2)
    expect(r.indemnity).toBeCloseTo(0, 2)
  })
})

// ---------------------------------------------------------------------------
// computeIndemnity — RP_HPE (guarantee uses projected even if harvest higher)
// ---------------------------------------------------------------------------
describe('computeIndemnity — RP_HPE', () => {
  it('values the guarantee at the projected price even when harvest is higher', () => {
    // planType RP_HPE → gp = projected = 4.62 (NOT max with harvest 5.00)
    // revenueGuarantee = 180 * 0.80 * 4.62 * 100 = 66,528.00
    // actualRevenue    = 120 * 5.00 * 100 = 60,000.00 (harvest price used for actual)
    // indemnity        = max(0, 66528 - 60000) = 6,528.00
    const r = computeIndemnity({
      planType: 'RP_HPE',
      coverageLevel: 0.8,
      aphYield: 180,
      projectedPrice: 4.62,
      harvestPrice: 5.0,
      insuredAcres: 100,
      actualYield: 120,
    })
    expect(r.guaranteePrice).toBeCloseTo(4.62, 6)
    expect(r.revenueGuarantee).toBeCloseTo(66528.0, 2)
    expect(r.expectedRevenue).toBeCloseTo(60000.0, 2)
    expect(r.indemnity).toBeCloseTo(6528.0, 2)
  })
})

// ---------------------------------------------------------------------------
// computeIndemnity — YP
// ---------------------------------------------------------------------------
describe('computeIndemnity — YP', () => {
  it('pays the bushel shortfall valued at the guarantee price', () => {
    // gp = max(4.62, 4.00) = 4.62
    // productionGuaranteeBu = 180 * 0.80 * 100 = 14,400 bu
    // actualProductionBu    = 120 * 100       = 12,000 bu
    // indemnityBushels      = max(0, 14400 - 12000) = 2,400 bu
    // indemnity             = 2400 * 4.62 = 11,088.00
    // revenueGuarantee      = 180 * 0.80 * 4.62 * 100 = 66,528.00
    // expectedRevenue       = 120 * 4.00 * 100 = 48,000.00
    const r = computeIndemnity({
      planType: 'YP',
      coverageLevel: 0.8,
      aphYield: 180,
      projectedPrice: 4.62,
      harvestPrice: 4.0,
      insuredAcres: 100,
      actualYield: 120,
    })
    expect(r.guaranteePrice).toBeCloseTo(4.62, 6)
    expect(r.productionGuaranteeBu).toBeCloseTo(14400, 2)
    expect(r.actualProductionBu).toBeCloseTo(12000, 2)
    expect(r.indemnityBushels).toBeCloseTo(2400, 2)
    expect(r.indemnity).toBeCloseTo(11088.0, 2)
    expect(r.revenueGuarantee).toBeCloseTo(66528.0, 2)
    expect(r.expectedRevenue).toBeCloseTo(48000.0, 2)
  })

  it('pays nothing when actual production meets the guarantee', () => {
    // productionGuaranteeBu = 180 * 0.80 * 100 = 14,400 bu
    // actualProductionBu    = 180 * 100        = 18,000 bu (>= guarantee)
    // indemnityBushels = max(0, 14400 - 18000) = 0 ; indemnity = 0
    const r = computeIndemnity({
      planType: 'YP',
      coverageLevel: 0.8,
      aphYield: 180,
      projectedPrice: 4.62,
      harvestPrice: 4.0,
      insuredAcres: 100,
      actualYield: 180,
    })
    expect(r.indemnityBushels).toBeCloseTo(0, 2)
    expect(r.indemnity).toBeCloseTo(0, 2)
  })
})

// ---------------------------------------------------------------------------
// computeBandIndemnity (SCO / ECO)
// ---------------------------------------------------------------------------
describe('computeBandIndemnity', () => {
  // Shared band geometry: lower 0.80, upper 0.86 → bandWidth 0.06.
  // paymentLimit = 0.06 * 180 * 4.62 * 100
  //   0.06 * 180 = 10.8 ; 10.8 * 4.62 = 49.896 ; * 100 = 4,989.60
  const geometry = {
    lowerLevel: 0.8,
    upperTrigger: 0.86,
    guaranteePrice: 4.62,
    harvestPrice: 4.0,
    aphYield: 180,
    insuredAcres: 100,
  }

  it('yield-based: partial payment factor (ratio between lower and trigger)', () => {
    // revenueBased = false → ratio = estimatedCountyYield / expectedCountyYield
    //   = 166 / 200 = 0.83
    // ratio < trigger 0.86 → paymentFactor = min(0.86 - 0.83, 0.06)
    //   = min(0.03, 0.06) = 0.03
    // indemnity = (0.03 / 0.06) * 4989.60 = 0.5 * 4989.60 = 2,494.80
    const inp: BandInputs = {
      ...geometry,
      expectedCountyYield: 200,
      estimatedCountyYield: 166,
      revenueBased: false,
    }
    const r = computeBandIndemnity(inp)
    expect(r.bandWidth).toBeCloseTo(0.06, 6)
    expect(r.paymentLimit).toBeCloseTo(4989.6, 2)
    expect(r.ratio).toBeCloseTo(0.83, 6)
    expect(r.paymentFactor).toBeCloseTo(0.03, 6)
    expect(r.indemnity).toBeCloseTo(2494.8, 2)
  })

  it('revenue-based: ratio well below the floor caps the payment factor at bandWidth', () => {
    // revenueBased = true:
    //   expectedCountyRevenue = 175 * 4.62 = 808.50
    //   actualCountyRevenue   = 130 * 4.00 = 520.00
    //   ratio = 520 / 808.50 = 0.6431663…
    // ratio < 0.86 → paymentFactor = min(0.86 - 0.6431663, 0.06)
    //   = min(0.2168337, 0.06) = 0.06 (capped at bandWidth)
    // indemnity = (0.06 / 0.06) * 4989.60 = 4,989.60 (full band)
    const inp: BandInputs = {
      ...geometry,
      expectedCountyYield: 175,
      estimatedCountyYield: 130,
      revenueBased: true,
    }
    const r = computeBandIndemnity(inp)
    expect(r.ratio).toBeCloseTo(520 / 808.5, 6) // 0.643166…
    expect(r.paymentFactor).toBeCloseTo(0.06, 6)
    expect(r.indemnity).toBeCloseTo(4989.6, 2)
  })

  it('pays nothing when the ratio is at/above the trigger', () => {
    // yield ratio = 180 / 200 = 0.90 >= trigger 0.86 → no payment
    const inp: BandInputs = {
      ...geometry,
      expectedCountyYield: 200,
      estimatedCountyYield: 180,
      revenueBased: false,
    }
    const r = computeBandIndemnity(inp)
    expect(r.ratio).toBeCloseTo(0.9, 6)
    expect(r.paymentFactor).toBeCloseTo(0, 6)
    expect(r.indemnity).toBeCloseTo(0, 2)
  })
})

// ---------------------------------------------------------------------------
// resolveEstimatedCountyYield — the SHARED county assumption (differential,
// 047). Estimated county yield = the farm's own yield basis − differential
// ("my yields run this much ABOVE the county"), or the absolute override;
// pinned to the RMA final once published. RMA expected is reference-only
// (the last-resort estimate when no differential can apply).
// ---------------------------------------------------------------------------
const diffAssumption = (over: Partial<CountyAssumptionLike> = {}): CountyAssumptionLike => ({
  yield_differential: null, county_yield_override: null, rma_final_county_yield: null, ...over,
})

describe('resolveEstimatedCountyYield — differential semantics', () => {
  it('farm 185 − differential 15 → county estimate 170', () => {
    const r = resolveEstimatedCountyYield({
      expectedCountyYield: 150,
      assumption: diffAssumption({ yield_differential: 15 }),
      farmYieldBasis: 185,
    })
    expect(r.estimatedYield).toBeCloseTo(170, 6)
    expect(r.source).toBe('differential')
    expect(r.differential).toBe(15)
    expect(r.pinned).toBe(false)
  })

  it('cotton in lbs: farm 1,275 − differential 75 → county 1,200', () => {
    const r = resolveEstimatedCountyYield({
      expectedCountyYield: 1150,
      assumption: diffAssumption({ yield_differential: 75 }),
      farmYieldBasis: 1275,
    })
    expect(r.estimatedYield).toBeCloseTo(1200, 6)
  })

  it('a negative differential ("I run below the county") adds to the farm yield', () => {
    const r = resolveEstimatedCountyYield({
      expectedCountyYield: 150,
      assumption: diffAssumption({ yield_differential: -10 }),
      farmYieldBasis: 160,
    })
    expect(r.estimatedYield).toBeCloseTo(170, 6)
  })

  it('no differential (or no farm basis) → RMA expected as the last resort', () => {
    expect(resolveEstimatedCountyYield({ expectedCountyYield: 150 }).estimatedYield).toBeCloseTo(150, 6)
    expect(resolveEstimatedCountyYield({ expectedCountyYield: 150 }).source).toBe('expected')
    // A differential without a farm basis cannot apply.
    expect(resolveEstimatedCountyYield({
      expectedCountyYield: 150, assumption: diffAssumption({ yield_differential: 15 }),
    }).estimatedYield).toBeCloseTo(150, 6)
  })

  it('the legacy per-endorsement variance fallback is GONE — no row means RMA expected, nothing else', () => {
    // (Regression for the "impossible corn indemnity": a stale legacy pct used
    // to depress the estimate and pay SCO/ECO with nothing wrong.)
    const r = resolveEstimatedCountyYield({ expectedCountyYield: 150 })
    expect(r.estimatedYield).toBeCloseTo(150, 6)
    expect(r.source).toBe('expected')
  })

  it('absolute override wins over the differential (and does not move with the farm)', () => {
    const a = diffAssumption({ yield_differential: 15, county_yield_override: 140 })
    expect(resolveEstimatedCountyYield({ expectedCountyYield: 150, assumption: a, farmYieldBasis: 185 }).estimatedYield).toBeCloseTo(140, 6)
    expect(resolveEstimatedCountyYield({ expectedCountyYield: 150, assumption: a, farmYieldBasis: 120 }).estimatedYield).toBeCloseTo(140, 6)
  })

  it('RMA final pins the yield over everything', () => {
    const a = diffAssumption({ yield_differential: 15, county_yield_override: 140, rma_final_county_yield: 152 })
    const r = resolveEstimatedCountyYield({ expectedCountyYield: 150, assumption: a, farmYieldBasis: 185 })
    expect(r.estimatedYield).toBeCloseTo(152, 6)
    expect(r.pinned).toBe(true)
    expect(r.source).toBe('final')
  })

  it('never goes below zero', () => {
    expect(resolveEstimatedCountyYield({
      expectedCountyYield: 150, assumption: diffAssumption({ yield_differential: 50 }), farmYieldBasis: 30,
    }).estimatedYield).toBe(0)
  })
})

describe('countyAssumptionFor', () => {
  const mkRow = (over: Partial<CountyYieldAssumption>): CountyYieldAssumption => ({
    id: '1', crop_id: 'corn', county_id: 'A', crop_year: 2026, variance_pct: 0,
    yield_differential: null, county_yield_override: null, rma_final_county_yield: null, notes: null, created_at: '', updated_at: '',
    ...over,
  })
  const rows = [
    mkRow({ id: '1', county_id: 'A', yield_differential: 15 }),
    mkRow({ id: '2', county_id: null, yield_differential: 5 }),
  ]
  it('exact county match wins; null-county default fills; other crops/years miss', () => {
    expect(countyAssumptionFor(rows, 'corn', 'A', 2026)?.yield_differential).toBe(15)
    expect(countyAssumptionFor(rows, 'corn', 'B', 2026)?.yield_differential).toBe(5)
    expect(countyAssumptionFor(rows, 'soy', 'A', 2026)).toBeNull()
    expect(countyAssumptionFor(rows, 'corn', 'A', 2025)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// computePolicy — base + SCO, net P&L
// ---------------------------------------------------------------------------
describe('computePolicy', () => {
  it('combines base RP indemnity + SCO band and computes netPnl', () => {
    // BASE (RP): APH 180, cov 0.80, projected 4.62, harvest 4.00, yield 120, 100 ac
    //   gp = 4.62 ; revenueGuarantee = 66,528 ; actualRevenue = 48,000
    //   base.indemnity = 18,528.00 (from the RP worked example above)
    //
    // SCO: trigger 0.86, lowerLevel = base coverage 0.80 → bandWidth 0.06
    //   shared county override 140 → estimatedCountyYield = 140
    //   revenueBased (RP):
    //     expectedCountyRevenue = 175 * 4.62 = 808.50
    //     actualCountyRevenue   = 140 * 4.00 = 560.00
    //     ratio = 560 / 808.50 = 0.69264… < 0.86
    //   paymentFactor = min(0.86 - 0.69264, 0.06) = 0.06 (full band)
    //   paymentLimit  = 0.06 * 180 * 4.62 * 100 = 4,989.60
    //   sco.indemnity = (0.06/0.06) * 4989.60 = 4,989.60
    //
    // totalIndemnity = 18,528.00 + 4,989.60 = 23,517.60
    // premiumPaid    = basePremium 8,000 + scoPremium 1,500 = 9,500.00
    // netPnl         = 23,517.60 - 9,500.00 = 14,017.60
    const base: PolicyInputs = {
      planType: 'RP',
      coverageLevel: 0.8,
      aphYield: 180,
      projectedPrice: 4.62,
      harvestPrice: 4.0,
      insuredAcres: 100,
      actualYield: 120,
    }
    const comp = computePolicy({
      base,
      basePremium: 8000,
      sco: {
        coverageTrigger: 0.86,
        expectedCountyYield: 175,
        premiumPerAcre: null,
        totalPremium: 1500,
      },
      eco: null,
      county: { assumption: { yield_differential: null, county_yield_override: 140, rma_final_county_yield: null } },
    })

    expect(comp.base.indemnity).toBeCloseTo(18528.0, 2)
    expect(comp.sco).not.toBeNull()
    expect(comp.sco!.indemnity).toBeCloseTo(4989.6, 2)
    // Provenance the UI shows on paying county legs:
    expect(comp.sco!.estimatedCountyYield).toBeCloseTo(140, 2)
    expect(comp.sco!.countySource).toBe('override')
    expect(comp.eco).toBeNull()
    expect(comp.totalIndemnity).toBeCloseTo(23517.6, 2)
    expect(comp.premiumPaid).toBeCloseTo(9500.0, 2)
    expect(comp.netPnl).toBeCloseTo(14017.6, 2)
  })

  it('endorsement premium falls back to per-acre × insured acres when no total', () => {
    // No base or SCO indemnity (high yield, no loss). SCO premiumPerAcre 12 over
    // 100 ac → scoPremium = 1,200. premiumPaid = 5,000 + 1,200 = 6,200.
    // netPnl = 0 - 6,200 = -6,200.
    const base: PolicyInputs = {
      planType: 'RP',
      coverageLevel: 0.8,
      aphYield: 180,
      projectedPrice: 4.62,
      harvestPrice: 4.62,
      insuredAcres: 100,
      actualYield: 220, // big crop → no loss anywhere
    }
    const comp = computePolicy({
      base,
      basePremium: 5000,
      sco: {
        coverageTrigger: 0.86,
        expectedCountyYield: 175,
        premiumPerAcre: 12,
        totalPremium: null,
      },
      eco: null,
    })
    expect(comp.base.indemnity).toBeCloseTo(0, 2)
    expect(comp.sco!.indemnity).toBeCloseTo(0, 2)
    expect(comp.premiumPaid).toBeCloseTo(6200.0, 2)
    expect(comp.netPnl).toBeCloseTo(-6200.0, 2)
  })
})

// ---------------------------------------------------------------------------
// projectedPriceFromEstimates
// ---------------------------------------------------------------------------
describe('projectedPriceFromEstimates', () => {
  function est(
    over: Partial<HarvestPriceEstimate> & Pick<HarvestPriceEstimate, 'id'>,
  ): HarvestPriceEstimate {
    return {
      crop_id: 'corn',
      crop_year: 2026,
      price_type: 'projected',
      price: 4.62,
      source: null,
      price_date: '2026-02-15',
      created_at: '',
      ...over,
    }
  }

  it('returns the latest-dated projected price for the matching crop+year', () => {
    const rows = [
      est({ id: 'a', price: 4.5, price_date: '2026-02-01' }),
      est({ id: 'b', price: 4.62, price_date: '2026-02-28' }), // latest → wins
      est({ id: 'c', price: 4.55, price_date: '2026-02-15' }),
    ]
    expect(projectedPriceFromEstimates(rows, 'corn', 2026)).toBeCloseTo(4.62, 6)
  })

  it('ignores rows for other crops, other years, or non-projected price types', () => {
    const rows = [
      est({ id: 'wrongcrop', crop_id: 'soybeans', price: 11.0, price_date: '2026-03-01' }),
      est({ id: 'wrongyear', crop_year: 2025, price: 9.99, price_date: '2026-03-01' }),
      est({ id: 'harvest', price_type: 'harvest_final', price: 5.5, price_date: '2026-12-01' }),
      est({ id: 'match', price: 4.7, price_date: '2026-02-20' }),
    ]
    // Only "match" qualifies (corn / 2026 / projected) → 4.70
    expect(projectedPriceFromEstimates(rows, 'corn', 2026)).toBeCloseTo(4.7, 6)
  })

  it('returns null when no row matches', () => {
    const rows = [est({ id: 'soy', crop_id: 'soybeans', price: 11.0 })]
    expect(projectedPriceFromEstimates(rows, 'corn', 2026)).toBeNull()
    expect(projectedPriceFromEstimates([], 'corn', 2026)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Per-practice indemnity: a crop's irrigated and dryland policies compute
// INDEPENDENTLY from their own APH / coverage / insured acres / actual yield.
// ---------------------------------------------------------------------------
describe('per-practice indemnity (irrigated vs dryland compute independently)', () => {
  it('RP — each practice from its own APH/coverage/acres/yield; the crop subtotal is their sum', () => {
    // Irrigated: APH 220, 80% cov, 100 ac, actual 180. proj 4.62, harvest 4.00.
    //   g.price = max(4.62, 4.00) = 4.62
    //   rev guarantee = 220 × 0.80 × 4.62 × 100 = 81,312
    //   expected rev  = 180 × 4.00 × 100        = 72,000
    //   indemnity     = max(0, 81,312 − 72,000) =  9,312
    const irr = computeIndemnity({ planType: 'RP', coverageLevel: 0.80, aphYield: 220, projectedPrice: 4.62, harvestPrice: 4.0, insuredAcres: 100, actualYield: 180 })
    expect(irr.revenueGuarantee).toBeCloseTo(81312, 2)
    expect(irr.expectedRevenue).toBeCloseTo(72000, 2)
    expect(irr.indemnity).toBeCloseTo(9312, 2)
    // Dryland: APH 150, 75% cov, 200 ac, actual 120.
    //   rev guarantee = 150 × 0.75 × 4.62 × 200 = 103,950
    //   expected rev  = 120 × 4.00 × 200         =  96,000
    //   indemnity     = max(0, 103,950 − 96,000) =   7,950
    const dry = computeIndemnity({ planType: 'RP', coverageLevel: 0.75, aphYield: 150, projectedPrice: 4.62, harvestPrice: 4.0, insuredAcres: 200, actualYield: 120 })
    expect(dry.revenueGuarantee).toBeCloseTo(103950, 2)
    expect(dry.expectedRevenue).toBeCloseTo(96000, 2)
    expect(dry.indemnity).toBeCloseTo(7950, 2)
    // Crop subtotal = irrigated + dryland.
    expect(irr.indemnity + dry.indemnity).toBeCloseTo(17262, 2)
  })
})

// ---------------------------------------------------------------------------
// acreageTolerance + reconcileAcreage — the Coverage Check.
// Tolerance = max(0.5 acres, 1% of planted).
// ---------------------------------------------------------------------------
describe('acreageTolerance', () => {
  it('is the greater of 0.5 acres or 1% of planted', () => {
    expect(acreageTolerance(30)).toBeCloseTo(0.5, 6)   // 1% of 30 = 0.30 < 0.5
    expect(acreageTolerance(200)).toBeCloseTo(2.0, 6)  // 1% of 200 = 2.0 > 0.5
    expect(acreageTolerance(50)).toBeCloseTo(0.5, 6)   // 1% of 50 = 0.5 (tie)
  })
})

describe('reconcileAcreage', () => {
  it('classifies matched / under-insured / over-reported / no-policy + the reverse gap', () => {
    const { rows, insuredNotPlanted, summary } = reconcileAcreage({
      plantings: [
        { cropId: 'corn', countyId: 'A', practice: 'irrigated',     plantedAcres: 100 }, // matched   (insured 100, tol 1.0)
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', plantedAcres: 200 }, // under     (insured 150, tol 2.0)
        { cropId: 'corn', countyId: 'B', practice: 'irrigated',     plantedAcres: 80 },  // no policy
        { cropId: 'soy',  countyId: 'A', practice: 'non_irrigated', plantedAcres: 100 }, // over      (insured 130, tol 1.0)
      ],
      policies: [
        { cropId: 'corn',  countyId: 'A', practice: 'irrigated',     insuredAcres: 100 },
        { cropId: 'corn',  countyId: 'A', practice: 'non_irrigated', insuredAcres: 150 },
        { cropId: 'soy',   countyId: 'A', practice: 'non_irrigated', insuredAcres: 130 },
        { cropId: 'wheat', countyId: 'A', practice: 'irrigated',     insuredAcres: 40 },  // reverse gap (no plantings)
      ],
    })
    const find = (crop: string, county: string, pr: string) =>
      rows.find((r) => r.cropId === crop && r.countyId === county && r.practice === pr)!
    expect(find('corn', 'A', 'irrigated').status).toBe('matched')
    const under = find('corn', 'A', 'non_irrigated')
    expect(under.status).toBe('under_insured')
    expect(under.variance).toBeCloseTo(-50, 2)
    expect(find('corn', 'B', 'irrigated').status).toBe('no_policy')
    const over = find('soy', 'A', 'non_irrigated')
    expect(over.status).toBe('over_reported')
    expect(over.variance).toBeCloseTo(30, 2)
    // Reverse gap: a policy with no plantings.
    expect(insuredNotPlanted).toHaveLength(1)
    expect(insuredNotPlanted[0]).toMatchObject({ cropId: 'wheat', practice: 'irrigated', insuredAcres: 40, status: 'insured_not_planted' })
    // Summary: planted 100+200+80+100 = 480; insured 100+150+0+130 = 380;
    // uninsured = 50 (under) + 80 (no policy) = 130; flagged = under + no_policy + over = 3.
    expect(summary.totalPlanted).toBeCloseTo(480, 2)
    expect(summary.totalInsured).toBeCloseTo(380, 2)
    expect(summary.uninsuredAcres).toBeCloseTo(130, 2)
    expect(summary.flaggedCount).toBe(3)
  })

  it('stays Matched within tolerance and flips just past it', () => {
    const within = reconcileAcreage({
      plantings: [{ cropId: 'c', countyId: 'A', practice: 'irrigated', plantedAcres: 100 }],
      policies: [{ cropId: 'c', countyId: 'A', practice: 'irrigated', insuredAcres: 100.8 }], // +0.8 ≤ tol 1.0
    })
    expect(within.rows[0].status).toBe('matched')
    const past = reconcileAcreage({
      plantings: [{ cropId: 'c', countyId: 'A', practice: 'irrigated', plantedAcres: 100 }],
      policies: [{ cropId: 'c', countyId: 'A', practice: 'irrigated', insuredAcres: 101.5 }], // +1.5 > tol 1.0
    })
    expect(past.rows[0].status).toBe('over_reported')
  })

  it('sums multiple optional-unit policies for the same crop/county/practice', () => {
    const { rows } = reconcileAcreage({
      plantings: [{ cropId: 'corn', countyId: 'A', practice: 'non_irrigated', plantedAcres: 150 }],
      policies: [
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', insuredAcres: 60 },
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', insuredAcres: 90 },
      ],
    })
    expect(rows[0].insuredAcres).toBeCloseTo(150, 2) // 60 + 90
    expect(rows[0].policyCount).toBe(2)
    expect(rows[0].status).toBe('matched')
  })

  it('keeps irrigated and dryland of the same crop/county as separate rows', () => {
    const { rows } = reconcileAcreage({
      plantings: [
        { cropId: 'corn', countyId: 'A', practice: 'irrigated', plantedAcres: 120 },
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', plantedAcres: 80 },
      ],
      policies: [
        { cropId: 'corn', countyId: 'A', practice: 'irrigated', insuredAcres: 120 },
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', insuredAcres: 80 },
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'matched')).toBe(true)
  })

  it('splits combinations by entity (same crop/county/practice, two entities)', () => {
    const { rows } = reconcileAcreage({
      plantings: [
        { entityId: 'E1', cropId: 'corn', countyId: 'A', practice: 'irrigated', plantedAcres: 100 },
        { entityId: 'E2', cropId: 'corn', countyId: 'A', practice: 'irrigated', plantedAcres: 60 },
      ],
      policies: [
        { entityId: 'E1', cropId: 'corn', countyId: 'A', practice: 'irrigated', insuredAcres: 100 }, // matched
        { entityId: 'E2', cropId: 'corn', countyId: 'A', practice: 'irrigated', insuredAcres: 20 },  // under (tol 0.6)
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.entityId === 'E1')!.status).toBe('matched')
    expect(rows.find((r) => r.entityId === 'E2')!.status).toBe('under_insured')
  })
})

// ---------------------------------------------------------------------------
// reconcileAcreage — "covers all planted acres" attestation (Part B).
// The attestation suppresses ONLY the acre-mismatch flags (under/over); it never
// suppresses "no policy". Covered rows are excluded from uninsured + flagged.
// ---------------------------------------------------------------------------
describe('reconcileAcreage — covers-all-planted attestation', () => {
  it('planted > insured but attested → "covered" (not under-insured), excluded from totals; no-policy unaffected', () => {
    const { rows, summary } = reconcileAcreage({
      plantings: [
        // Would be under-insured (insured 150 < planted 200, tol 2.0)…
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', plantedAcres: 200 },
        // …and a separate combination with no policy at all.
        { cropId: 'corn', countyId: 'B', practice: 'irrigated', plantedAcres: 80 },
      ],
      policies: [
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', insuredAcres: 150, coversAllPlanted: true, coverageNote: 'confirmed with agent 6/2026' },
      ],
    })
    const covered = rows.find((r) => r.countyId === 'A')!
    expect(covered.status).toBe('covered')          // NOT 'under_insured'
    expect(covered.plantedAcres).toBeCloseTo(200, 2) // numbers still shown side by side
    expect(covered.insuredAcres).toBeCloseTo(150, 2)
    expect(covered.variance).toBeCloseTo(-50, 2)     // variance kept as informational
    expect(covered.coversAllPlanted).toBe(true)
    expect(covered.coverageNote).toBe('confirmed with agent 6/2026')

    // No-policy combination is unaffected by the attestation.
    const gap = rows.find((r) => r.countyId === 'B')!
    expect(gap.status).toBe('no_policy')

    // Uncovered exposure excludes the covered row's 50-ac shortfall; only the
    // 80 no-policy acres count. Flagged excludes covered → just the no-policy row.
    expect(summary.uninsuredAcres).toBeCloseTo(80, 2)
    expect(summary.flaggedCount).toBe(1)
    // Totals still sum every planted/insured acre regardless of attestation.
    expect(summary.totalPlanted).toBeCloseTo(280, 2)
    expect(summary.totalInsured).toBeCloseTo(150, 2)
  })

  it('the SAME inputs without the flag are under-insured and counted (contrast)', () => {
    const { rows, summary } = reconcileAcreage({
      plantings: [{ cropId: 'corn', countyId: 'A', practice: 'non_irrigated', plantedAcres: 200 }],
      policies: [{ cropId: 'corn', countyId: 'A', practice: 'non_irrigated', insuredAcres: 150 }],
    })
    expect(rows[0].status).toBe('under_insured')
    expect(summary.uninsuredAcres).toBeCloseTo(50, 2) // 200 − 150
    expect(summary.flaggedCount).toBe(1)
  })

  it('attestation also suppresses an over-reported flag (insured > planted)', () => {
    const { rows, summary } = reconcileAcreage({
      plantings: [{ cropId: 'soy', countyId: 'A', practice: 'irrigated', plantedAcres: 100 }],
      policies: [{ cropId: 'soy', countyId: 'A', practice: 'irrigated', insuredAcres: 130, coversAllPlanted: true }],
    })
    expect(rows[0].status).toBe('covered') // not 'over_reported'
    expect(summary.flaggedCount).toBe(0)
    expect(summary.uninsuredAcres).toBeCloseTo(0, 2)
  })

  it('covered when ANY policy in the combination attests (one of two optional units)', () => {
    const { rows } = reconcileAcreage({
      plantings: [{ cropId: 'corn', countyId: 'A', practice: 'non_irrigated', plantedAcres: 300 }],
      policies: [
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', insuredAcres: 100 }, // no attestation
        { cropId: 'corn', countyId: 'A', practice: 'non_irrigated', insuredAcres: 120, coversAllPlanted: true, coverageNote: 'agent ok' },
      ],
    })
    // insured 220 < planted 300 would be under-insured, but one unit attests.
    expect(rows[0].status).toBe('covered')
    expect(rows[0].coverageNote).toBe('agent ok')
  })
})

// ---------------------------------------------------------------------------
// resolveUploadEntityId — which entity a policy upload/manual entry is saved to.
// Single-entity ops auto-assign (never asked); multi-entity uses the user's
// choice (else a fallback, else null → save blocked upstream).
// ---------------------------------------------------------------------------
describe('resolveUploadEntityId', () => {
  it('single-entity op auto-assigns its only entity even when nothing is chosen', () => {
    expect(resolveUploadEntityId({ entities: [{ id: 'E1' }], chosen: '' })).toBe('E1')
    // a stale empty fallback doesn't override the lone entity
    expect(resolveUploadEntityId({ entities: [{ id: 'E1' }], chosen: '', fallback: '' })).toBe('E1')
  })

  it('multi-entity op uses the chosen entity', () => {
    expect(resolveUploadEntityId({ entities: [{ id: 'E1' }, { id: 'E2' }], chosen: 'E2' })).toBe('E2')
  })

  it('multi-entity with nothing chosen falls back to the default, else null', () => {
    expect(resolveUploadEntityId({ entities: [{ id: 'E1' }, { id: 'E2' }], chosen: '', fallback: 'E1' })).toBe('E1')
    expect(resolveUploadEntityId({ entities: [{ id: 'E1' }, { id: 'E2' }], chosen: '' })).toBeNull()
  })

  it('a chosen entity always wins over the single-entity / fallback shortcuts', () => {
    expect(resolveUploadEntityId({ entities: [{ id: 'E1' }], chosen: 'E2' })).toBe('E2')
  })
})

// ---------------------------------------------------------------------------
// reconcileAcreage — entity matching (the Issue 1 ↔ Issue 2 connection).
// Plantings carry their entity (field→farm→entity). A policy only matches a
// planting when their entity_id agrees, so a null-entity policy (the Issue 1
// bug) leaves the Coverage Check unable to match — every combo "no policy".
// ---------------------------------------------------------------------------
describe('reconcileAcreage — entity matching', () => {
  it('matches a policy to a planting when both carry the same entity', () => {
    const { rows, insuredNotPlanted } = reconcileAcreage({
      plantings: [{ entityId: 'E1', cropId: 'corn', countyId: 'A', practice: 'irrigated', plantedAcres: 100 }],
      policies: [{ entityId: 'E1', cropId: 'corn', countyId: 'A', practice: 'irrigated', insuredAcres: 100 }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('matched')
    expect(rows[0].entityId).toBe('E1')
    expect(insuredNotPlanted).toHaveLength(0)
  })

  it('does NOT match when the policy entity is null but the planting has one (the Issue 1 symptom)', () => {
    const { rows, insuredNotPlanted } = reconcileAcreage({
      plantings: [{ entityId: 'E1', cropId: 'corn', countyId: 'A', practice: 'irrigated', plantedAcres: 100 }],
      // policy saved with a null entity (the bug) → different combination key.
      policies: [{ entityId: null, cropId: 'corn', countyId: 'A', practice: 'irrigated', insuredAcres: 100 }],
    })
    // The planting sees no policy at its entity → Coverage Check would show this
    // as "no policy" with no attestation toggle (policyCount 0)…
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('no_policy')
    expect(rows[0].policyCount).toBe(0)
    // …and the policy shows up as a reverse gap (insured, not planted).
    expect(insuredNotPlanted).toHaveLength(1)
    expect(insuredNotPlanted[0].status).toBe('insured_not_planted')
  })
})

// ---------------------------------------------------------------------------
// resolveHarvestPriceByCrop — final → live → stored estimate → projected.
// ---------------------------------------------------------------------------
describe('resolveHarvestPriceByCrop', () => {
  const base = { cropIds: ['corn'], cropYear: 2026 }

  it('a policy-entered final harvest price wins over everything', () => {
    const m = resolveHarvestPriceByCrop({
      ...base,
      policies: [mkPolicy({ harvest_price: 4.1, projected_price: 5 })],
      estimates: [mkEstimate({ price_type: 'harvest_final', price: 4.5 })],
      liveByCrop: new Map([['corn', { price: 4.9, stale: false, priceDate: '2026-10-01' }]]),
    })
    expect(m.get('corn')).toMatchObject({ price: 4.1, source: 'final' })
  })

  it('today’s live estimate wins over a stored estimate when no final', () => {
    const m = resolveHarvestPriceByCrop({
      ...base,
      policies: [mkPolicy({ harvest_price: null, projected_price: 5 })],
      estimates: [mkEstimate({ price_type: 'harvest_estimate', price: 4.2 })],
      liveByCrop: new Map([['corn', { price: 4.8, stale: false, priceDate: '2026-10-01' }]]),
    })
    expect(m.get('corn')).toMatchObject({ price: 4.8, source: 'estimate', stale: false })
  })

  it('falls back to a stored estimate, then to the average projected price', () => {
    const stored = resolveHarvestPriceByCrop({ ...base, policies: [mkPolicy({ harvest_price: null })], estimates: [mkEstimate({ price_type: 'harvest_estimate', price: 4.2 })] })
    expect(stored.get('corn')).toMatchObject({ price: 4.2, source: 'estimate', stale: true })
    const projected = resolveHarvestPriceByCrop({ ...base, policies: [mkPolicy({ harvest_price: null, projected_price: 5 }), mkPolicy({ id: 'p2', harvest_price: null, projected_price: 7 })], estimates: [] })
    expect(projected.get('corn')).toMatchObject({ price: 6, source: 'projected' }) // avg(5,7)
  })
})

describe('practiceActualYieldByCrop', () => {
  it('irrigated = Σ irr bu / Σ irr ac; dryland = Σ dry bu / Σ dry ac', () => {
    const m = practiceActualYieldByCrop([
      mkPlanting({ irrigated_acres: 100, irrigated_bushels: 22000, dryland_acres: 50, dryland_bushels: 8000 }),
      mkPlanting({ irrigated_acres: 100, irrigated_bushels: 20000 }),
    ], 2026)
    expect(m.get('corn|irrigated')).toBeCloseTo((22000 + 20000) / 200, 6) // 210
    expect(m.get('corn|non_irrigated')).toBeCloseTo(8000 / 50, 6) // 160
  })
})

// ---------------------------------------------------------------------------
// projectInsuranceIndemnities — the SHARED projection the Claims Monitor and the
// Cash Flow both call (so their crop-insurance dollars reconcile). RP indemnity
// hand-check (coverage 0.80, APH 100, projected $5, 100 ac, no SCO/ECO):
//   guarantee = 100 × 0.80 × max(proj,harvest) × 100 ac
//   actual    = assumedYield × harvest × 100 ac
//   indemnity = max(0, guarantee − actual)
// ---------------------------------------------------------------------------
describe('projectInsuranceIndemnities', () => {
  const common = {
    cropYear: 2026,
    scos: [], ecos: [],
    actualYieldByCrop: new Map<string, number>(),
    harvestEstimates: [] as HarvestPriceEstimate[],
  }

  it('uses the per-practice EXPECTED breakout so irrigated and dryland differ', () => {
    // Harvest falls back to projected $5 (no live/stored). gp = 5.
    // dryland: assumed 60 → actual 60·5·100=30,000 vs guarantee 40,000 → 10,000.
    // irrigated: assumed 90 → actual 90·5·100=45,000 > 40,000 → 0.
    const res = projectInsuranceIndemnities({
      ...common,
      policies: [
        mkPolicy({ id: 'd', practice: 'non_irrigated' }),
        mkPolicy({ id: 'i', practice: 'irrigated' }),
      ],
      assumptions: [mkAssumption({ expected_yield: 75, expected_yield_irr: 90, expected_yield_dry: 60 })],
      plantings: [],
    })
    const dry = res.find((r) => r.policy.id === 'd')!
    const irr = res.find((r) => r.policy.id === 'i')!
    expect(dry.assumedYield).toBeCloseTo(60, 6)
    expect(irr.assumedYield).toBeCloseTo(90, 6)
    expect(dry.comp.totalIndemnity).toBeCloseTo(10000, 2)
    expect(irr.comp.totalIndemnity).toBeCloseTo(0, 2)
  })

  it('priority: per-policy override > actual per-practice > expected breakout', () => {
    const policies = [mkPolicy({ id: 'd', practice: 'non_irrigated' })]
    const assumptions = [mkAssumption({ expected_yield_dry: 60 })]
    // expected only → assumed 60 → 10,000
    expect(projectInsuranceIndemnities({ ...common, policies, assumptions, plantings: [] })[0].assumedYield).toBeCloseTo(60, 6)
    // actual per-practice (90) overrides expected → assumed 90
    const withActual = projectInsuranceIndemnities({
      ...common, policies, assumptions,
      plantings: [mkPlanting({ dryland_acres: 100, dryland_bushels: 9000 })], // 90 bu/ac
    })
    expect(withActual[0].assumedYield).toBeCloseTo(90, 6)
    // per-policy override (50) wins over both
    const withOverride = projectInsuranceIndemnities({
      ...common, policies, assumptions,
      plantings: [mkPlanting({ dryland_acres: 100, dryland_bushels: 9000 })],
      yieldOverrideByPolicy: new Map([['d', 50]]),
    })
    expect(withOverride[0].assumedYield).toBeCloseTo(50, 6)
    expect(withOverride[0].comp.totalIndemnity).toBeCloseTo(15000, 2) // (40000 − 50·5·100)
  })

  it('applies the global yield slider and the harvest override', () => {
    const policies = [mkPolicy({ id: 'd', practice: 'non_irrigated' })]
    const assumptions = [mkAssumption({ expected_yield_dry: 60 })]
    // slider −20% → assumed 48 → actual 48·5·100=24,000 → 16,000
    const slid = projectInsuranceIndemnities({ ...common, policies, assumptions, plantings: [], globalYieldPct: -20 })
    expect(slid[0].assumedYield).toBeCloseTo(48, 6)
    expect(slid[0].comp.totalIndemnity).toBeCloseTo(16000, 2)
    // harvest override $4 (gp still max(5,4)=5): actual 60·4·100=24,000 → 16,000
    const ho = projectInsuranceIndemnities({ ...common, policies, assumptions, plantings: [], harvestOverrideByCrop: new Map([['corn', 4]]) })
    expect(ho[0].harvest.source).toBe('projected')
    expect(ho[0].comp.totalIndemnity).toBeCloseTo(16000, 2)
  })

  it('a live harvest estimate changes the projection (matches the Claims Monitor’s today-price)', () => {
    const policies = [mkPolicy({ id: 'd', practice: 'non_irrigated' })]
    const assumptions = [mkAssumption({ expected_yield_dry: 60 })]
    // live $4 → RP: gp=max(5,4)=5, actual=60·4·100=24,000 → 16,000 (vs 10,000 at projected $5).
    const res = projectInsuranceIndemnities({
      ...common, policies, assumptions, plantings: [],
      liveHarvestByCrop: new Map([['corn', { price: 4, stale: false, priceDate: '2026-10-01' }]]),
    })
    expect(res[0].harvest).toMatchObject({ price: 4, source: 'estimate' })
    expect(res[0].comp.totalIndemnity).toBeCloseTo(16000, 2)
    expect(totalProjectedIndemnity(res)).toBeCloseTo(16000, 2)
  })

  it('identical inputs give identical totals regardless of caller (the reconciliation guarantee)', () => {
    const policies = [mkPolicy({ id: 'd', practice: 'non_irrigated' }), mkPolicy({ id: 'i', practice: 'irrigated' })]
    const assumptions = [mkAssumption({ expected_yield_irr: 90, expected_yield_dry: 60 })]
    const args = { ...common, policies, assumptions, plantings: [], liveHarvestByCrop: new Map([['corn', { price: 4.5, stale: false, priceDate: '2026-10-01' }]]) }
    // Claims Monitor path (with empty what-if) and Cash Flow path (no what-if)
    // are the same call → identical totals.
    const claims = totalProjectedIndemnity(projectInsuranceIndemnities({ ...args, globalYieldPct: 0, yieldOverrideByPolicy: new Map(), harvestOverrideByCrop: new Map() }))
    const cashflow = totalProjectedIndemnity(projectInsuranceIndemnities(args))
    expect(claims).toBeCloseTo(cashflow, 2)
  })
})

// ---------------------------------------------------------------------------
// Policy upload dedupe — classifyPolicyUpload / diffPolicyUpload. The brokerage
// import pattern: 'exists' (identical -> skipped), 'update' (material field
// diffs, existing policy patched in place), 'new'. Blanks never diff; SCO/ECO
// dedupe with their parent (added/corrected, never removed).
// ---------------------------------------------------------------------------
function mkUpload(over: Partial<PolicyUploadValues> = {}): PolicyUploadValues {
  return {
    coverage_level: '0.80', unit_structure: 'enterprise', aph_yield: '', projected_price: '',
    harvest_price: '', volatility_factor: '', insured_acres: '', premium_per_acre: '',
    total_premium: '', premium_subsidy_pct: '', policy_number: '',
    expected_county_yield: '', expected_county_revenue: '', protection_factor: '',
    sco_enabled: false, sco_expected_county_yield: '', sco_premium_per_acre: '', sco_total_premium: '',
    eco_enabled: false, eco_trigger_level: '', eco_expected_county_yield: '', eco_premium_per_acre: '', eco_total_premium: '',
    ...over,
  }
}
function mkSco(over: Partial<CropInsuranceSco> = {}): CropInsuranceSco {
  return {
    id: 's1', policy_id: 'p1', coverage_trigger: 0.86, expected_county_yield: 110,
    county_yield_assumption_pct: null, premium_per_acre: 9, total_premium: null,
    notes: null, created_at: '2026-01-01', ...over,
  }
}

describe('classifyPolicyUpload — Already exists / Update available / New', () => {
  const onFile = mkPolicy({
    coverage_level: 0.75, aph_yield: 165, insured_acres: 850,
    premium_per_acre: 12.4, policy_number: 'POL-100',
  })

  it('no matching policy → new', () => {
    const s = classifyPolicyUpload(mkUpload(), null)
    expect(s.kind).toBe('new')
    expect(s.existing).toBeNull()
  })

  it('a re-uploaded identical packet classifies exists (skipped) — blanks never diff', () => {
    // The extraction provided coverage/APH/acres/premium/policy #; everything
    // else is blank and must not count as a change.
    const s = classifyPolicyUpload(
      mkUpload({ coverage_level: '0.75', aph_yield: '165', insured_acres: '850', premium_per_acre: '12.4', policy_number: 'pol-100' }),
      onFile,
    )
    expect(s.kind).toBe('exists')
    expect(s.diffs).toEqual([])
  })

  it('a blank extracted field never diffs against a stored value', () => {
    const s = classifyPolicyUpload(mkUpload({ coverage_level: '0.75' }), onFile)
    expect(s.kind).toBe('exists')
  })

  it('each material field flags an update with a field-level diff', () => {
    const cov = classifyPolicyUpload(mkUpload({ coverage_level: '0.80' }), onFile)
    expect(cov.kind).toBe('update')
    expect(cov.diffs).toEqual([{ label: 'Coverage', existing: '75%', incoming: '80%' }])

    const aph = classifyPolicyUpload(mkUpload({ coverage_level: '0.75', aph_yield: '172' }), onFile)
    expect(aph.kind).toBe('update')
    expect(aph.diffs).toEqual([{ label: 'APH yield', existing: '165', incoming: '172' }])

    const acres = classifyPolicyUpload(mkUpload({ coverage_level: '0.75', insured_acres: '900' }), onFile)
    expect(acres.diffs).toEqual([{ label: 'Insured acres', existing: '850', incoming: '900' }])

    const prem = classifyPolicyUpload(mkUpload({ coverage_level: '0.75', premium_per_acre: '13.1' }), onFile)
    expect(prem.diffs).toEqual([{ label: 'Premium/ac', existing: '12.4', incoming: '13.1' }])
  })

  it('a stored null diffs against a provided value (shown as —)', () => {
    const s = classifyPolicyUpload(mkUpload({ coverage_level: '0.75', total_premium: '5100' }), onFile)
    expect(s.diffs).toEqual([{ label: 'Total premium', existing: '—', incoming: '5100' }])
  })

  it('SCO dedupes with its parent: absent-from-upload is not a diff; new-on-upload is', () => {
    // Packet without the SCO page: the policy on file keeps its SCO, no update.
    const noSco = classifyPolicyUpload(mkUpload({ coverage_level: '0.75' }), onFile, mkSco())
    expect(noSco.kind).toBe('exists')
    // Upload carries an SCO the app lacks → update, "added".
    const addSco = classifyPolicyUpload(mkUpload({ coverage_level: '0.75', sco_enabled: true }), onFile, null)
    expect(addSco.kind).toBe('update')
    expect(addSco.diffs).toEqual([{ label: 'SCO', existing: 'none', incoming: 'added' }])
    // Upload SCO matching the one on file → still exists.
    const sameSco = classifyPolicyUpload(
      mkUpload({ coverage_level: '0.75', sco_enabled: true, sco_expected_county_yield: '110', sco_premium_per_acre: '9' }),
      onFile,
      mkSco(),
    )
    expect(sameSco.kind).toBe('exists')
    // Upload SCO correcting the county yield → update with the endorsement diff.
    const fixSco = classifyPolicyUpload(
      mkUpload({ coverage_level: '0.75', sco_enabled: true, sco_expected_county_yield: '118' }),
      onFile,
      mkSco(),
    )
    expect(fixSco.kind).toBe('update')
    expect(fixSco.diffs).toEqual([{ label: 'SCO county yield', existing: '110', incoming: '118' }])
  })
})

// ---------------------------------------------------------------------------
// STAX / ARP / MCO — area-based plans (045). All county-triggered via the
// shared assumption; hand-derived numbers.
// ---------------------------------------------------------------------------
describe('computeStaxIndemnity', () => {
  // Expected county revenue $800/ac, top 0.90, band 0.20 (floor 0.70),
  // protection 1.2, 100 ac. gp = harvest = 4.00.
  const base: PolicyInputs = {
    planType: 'RP', coverageLevel: 0.7, aphYield: 0, projectedPrice: 4, harvestPrice: 4,
    insuredAcres: 100, actualYield: 0,
  }
  const stax = { coverageRangeTop: 0.9, coveragePct: 0.2, protectionFactor: 1.2, expectedCountyRevenue: 800, premiumPerAcre: null, totalPremium: null }

  it('above the trigger pays nothing', () => {
    // est county yield 190 → actual revenue 760 → ratio 0.95 ≥ 0.90
    const r = computeStaxIndemnity(base, stax, 190)
    expect(r.indemnity).toBeCloseTo(0, 2)
  })

  it('mid-band scales linearly', () => {
    // est 160 → actual 640 → ratio 0.80; paymentFactor = min(0.90−0.80, 0.20) = 0.10
    // paymentLimit = 0.20 × 800 × 1.2 × 100 = 24,000... wait: 0.2*800=160; ×1.2=192; ×100 = 19,200
    // indemnity = (0.10/0.20) × 19,200 = 9,600
    const r = computeStaxIndemnity(base, stax, 160)
    expect(r.ratio).toBeCloseTo(0.8, 6)
    expect(r.paymentLimit).toBeCloseTo(19200, 2)
    expect(r.indemnity).toBeCloseTo(9600, 2)
  })

  it('at/below the band floor pays the full 20% × protection factor', () => {
    // est 120 → actual 480 → ratio 0.60 < floor 0.70 → full band 19,200
    const r = computeStaxIndemnity(base, stax, 120)
    expect(r.paymentFactor).toBeCloseTo(0.2, 6)
    expect(r.indemnity).toBeCloseTo(19200, 2)
  })
})

describe('ARP — county-triggered, farm yield plays no role', () => {
  const arpBase: PolicyInputs = {
    planType: 'ARP', coverageLevel: 0.9, aphYield: 0, projectedPrice: 4, harvestPrice: 4,
    insuredAcres: 100, actualYield: 50, // farm disaster — must be ignored
    expectedCountyYield: 200, expectedCountyRevenue: 800, protectionFactor: 1,
  }

  it('farm loss + county fine (no assumption row → RMA expected) pays ZERO', () => {
    // county at expectation: est = 200 → actual revenue 800 ≥ trigger 720.
    // The farm's 50 bu disaster plays no role in the ARP indemnity itself.
    const comp = computePolicy({ base: arpBase, basePremium: 0, sco: null, eco: null, county: { assumption: null, farmYieldBasis: 200 } })
    expect(comp.base.indemnity).toBeCloseTo(0, 2)
  })

  it('the differential puts the county 40 bu under the farm basis → revenue shortfall × protection', () => {
    // farm basis 200 − differential 40 → est 160 → actual 640; trigger = 0.9 × 800 = 720
    // shortfall 80 × pf 1 × 100 ac = 8,000
    const a = { yield_differential: 40, county_yield_override: null, rma_final_county_yield: null }
    const comp = computePolicy({ base: arpBase, basePremium: 0, sco: null, eco: null, county: { assumption: a, farmYieldBasis: 200 } })
    expect(comp.base.indemnity).toBeCloseTo(8000, 2)
    // With the SAME county basis, the policy's own actualYield stays irrelevant.
    const comp2 = computePolicy({ base: { ...arpBase, actualYield: 260 }, basePremium: 0, sco: null, eco: null, county: { assumption: a, farmYieldBasis: 200 } })
    expect(comp2.base.indemnity).toBeCloseTo(8000, 2)
  })
})

describe('computeMcoIndemnity — margin band 0.86 → trigger', () => {
  // expected margin $200/ac; expected county yield 200 @ gp 4 → expected
  // revenue 800, expected cost 600. Band 0.86→0.90 (width 0.04), 100 ac.
  const base: PolicyInputs = {
    planType: 'RP', coverageLevel: 0.75, aphYield: 0, projectedPrice: 4, harvestPrice: 4,
    insuredAcres: 100, actualYield: 0,
  }
  const mco = { triggerLevel: 0.9, expectedMargin: 200, inputCostAdjustment: 0, expectedCountyYield: 200, premiumPerAcre: null, totalPremium: null }

  it('margin at expectation pays nothing', () => {
    // est yield 200 → margin 800 − 600 = 200 → ratio 1.0
    expect(computeMcoIndemnity(base, mco, 200).indemnity).toBeCloseTo(0, 2)
  })

  it('a collapsed margin pays the full band', () => {
    // est 176 → revenue 704 → margin 104 → ratio 0.52 < 0.86
    // paymentLimit = 0.04 × 200 × 100 = 800 → full band
    const r = computeMcoIndemnity(base, mco, 176)
    expect(r.ratio).toBeCloseTo(0.52, 6)
    expect(r.indemnity).toBeCloseTo(800, 2)
  })

  it('the MCO band does not overlap the SCO band (0.86 top)', () => {
    // margin ratio 0.88: inside MCO's 0.86–0.90 band → partial payment
    // (0.02/0.04) × 800 = 400; an SCO county ratio of 0.88 pays nothing.
    // est yield → margin ratio 0.88: margin 176 → revenue 776 → est = 194
    const r = computeMcoIndemnity(base, mco, 194)
    expect(r.ratio).toBeCloseTo(0.88, 6)
    expect(r.indemnity).toBeCloseTo(400, 2)
    const scoAt088 = computeBandIndemnity({
      lowerLevel: 0.75, upperTrigger: 0.86, expectedCountyYield: 200, estimatedCountyYield: 176,
      guaranteePrice: 4, harvestPrice: 4, aphYield: 180, insuredAcres: 100, revenueBased: false,
    })
    expect(scoAt088.ratio).toBeCloseTo(0.88, 6)
    expect(scoAt088.indemnity).toBeCloseTo(0, 2)
  })

  it('the input-cost adjustment squeezes the margin', () => {
    // est 200 → revenue 800; cost 600 + 40 adj → margin 160 → ratio 0.80 < 0.86
    // full band 800
    expect(computeMcoIndemnity(base, { ...mco, inputCostAdjustment: 40 }, 200).indemnity).toBeCloseTo(800, 2)
  })
})

describe('shared county assumption drives SCO (RMA expected when no row)', () => {
  const base: PolicyInputs = {
    planType: 'RP', coverageLevel: 0.8, aphYield: 180, projectedPrice: 4.62, harvestPrice: 4,
    insuredAcres: 100, actualYield: 120,
  }
  const sco = { coverageTrigger: 0.86, expectedCountyYield: 175, premiumPerAcre: null, totalPremium: null }

  it('a shared differential row sets the county estimate from the farm basis', () => {
    // farm basis = the policy's actualYield 120; differential −55 ("I run 55
    // under the county") → est = 120 + 55 = 175 → ratio 700/808.5 = 0.8658 ≥
    // 0.86 → no payment.
    const withRow = computePolicy({ base, basePremium: 0, sco, eco: null, county: { assumption: { yield_differential: -55, county_yield_override: null, rma_final_county_yield: null } } })
    expect(withRow.sco!.indemnity).toBeCloseTo(0, 2)
    expect(withRow.sco!.countySource).toBe('differential')
    // Without a row the estimate is the RMA expected itself; at harvest 4 vs
    // gp 4.62 the county revenue ratio is 4/4.62 = 0.8658 ≥ 0.86 → no payment
    // (the old −20% legacy fallback would have paid the full band here).
    const without = computePolicy({ base, basePremium: 0, sco, eco: null })
    expect(without.sco!.indemnity).toBeCloseTo(0, 2)
    expect(without.sco!.countySource).toBe('expected')
  })

  it('the RMA final pins the county yield and flags the computation', () => {
    const comp = computePolicy({
      base, basePremium: 0, sco, eco: null,
      county: { assumption: { yield_differential: 100, county_yield_override: null, rma_final_county_yield: 175 }, farmYieldBasis: 120 },
    })
    // final 175 → ratio 0.8658 → no payment; the differential is ignored
    expect(comp.sco!.indemnity).toBeCloseTo(0, 2)
    expect(comp.countyPinned).toBe(true)
  })
})

describe('stacking warnings (warn, never block)', () => {
  const pol = (id: string, plan: 'RP' | 'ARP' = 'RP') =>
    ({ id, crop_id: 'cotton', county_id: 'A', crop_year: 2026, plan_type: plan }) as CropInsurancePolicy

  it('ECO ⊗ ARP/STAX/MCO on the same crop-county-year; MCO ⊗ ARP', () => {
    const warnings = stackingWarnings({
      policies: [pol('p1'), pol('p2', 'ARP')],
      ecoPolicyIds: new Set(['p1']),
      staxPolicyIds: new Set(['p1']),
      mcoPolicyIds: new Set(['p1']),
      cropName: () => 'Cotton',
    })
    expect(warnings.some((w) => w.message.includes('ECO'))).toBe(true)
    expect(warnings.some((w) => w.message.includes('MCO') && w.message.includes('ARP'))).toBe(true)
  })

  it('SCO stacks freely with ECO/MCO — no warning without ECO conflicts', () => {
    const warnings = stackingWarnings({
      policies: [pol('p1')],
      ecoPolicyIds: new Set(['p1']),
      staxPolicyIds: new Set(),
      mcoPolicyIds: new Set(),
    })
    expect(warnings).toEqual([])
  })

  it('STAX ⊗ seed-cotton ARC/PLC enrollment warns; otherwise silent', () => {
    expect(staxArcPlcWarning({ staxCount: 1, seedCottonEnrolled: true })).toMatch(/STAX/)
    expect(staxArcPlcWarning({ staxCount: 0, seedCottonEnrolled: true })).toBeNull()
    expect(staxArcPlcWarning({ staxCount: 2, seedCottonEnrolled: false })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cotton price units (¢/lb vs $/lb) — the boundary conversion, the hand-
// verified RP example from the unit-mismatch incident, and the sanity guard.
// ---------------------------------------------------------------------------

describe('centsToInsuranceDollars — the ¢/lb → $/lb boundary', () => {
  it('divides cotton futures prices by 100', () => {
    expect(centsToInsuranceDollars('Cotton', 68)).toBeCloseTo(0.68, 10)
    expect(centsToInsuranceDollars('Upland Cotton', 45)).toBeCloseTo(0.45, 10)
  })
  it('passes grain prices through unchanged', () => {
    expect(centsToInsuranceDollars('Corn', 4.5)).toBe(4.5)
    expect(centsToInsuranceDollars('Soybeans', 11.09)).toBe(11.09)
    expect(centsToInsuranceDollars(null, 5)).toBe(5)
  })
  it('does not treat seed cotton (no traded future) as cotton', () => {
    expect(centsToInsuranceDollars('Seed Cotton', 12)).toBe(12)
  })
})

describe('cotton RP — hand-verified $/lb example', () => {
  // APH 1,200 lbs, coverage 75%, projected 0.68 $/lb, harvest scenario 0.45 $/lb
  // (45¢ converted at the boundary), actual 1,082 lbs/ac, 1 acre:
  //   guarantee = 1,200 × 0.75 × max(0.68, 0.45) = 612.00
  //   actual    = 1,082 × 0.45                   = 486.90
  //   indemnity = 612.00 − 486.90                = 125.10
  it('pays $125.10/ac — not thousands', () => {
    const r = computeIndemnity({
      planType: 'RP', coverageLevel: 0.75, aphYield: 1200,
      projectedPrice: 0.68, harvestPrice: centsToInsuranceDollars('Cotton', 45),
      insuredAcres: 1, actualYield: 1082,
    })
    expect(r.guaranteePrice).toBeCloseTo(0.68, 6)
    expect(r.revenueGuarantee).toBeCloseTo(612, 2)
    expect(r.expectedRevenue).toBeCloseTo(486.9, 2)
    expect(r.indemnity).toBeCloseTo(125.1, 2)
  })

  it('a grains case is unchanged by the boundary helper', () => {
    // Corn RP: APH 200, 80%, projected 4.50, harvest 4.00, actual 170, 1 ac:
    // guarantee = 200 × 0.8 × 4.50 = 720; actual = 170 × 4.00 = 680 → 40.
    const r = computeIndemnity({
      planType: 'RP', coverageLevel: 0.8, aphYield: 200,
      projectedPrice: 4.5, harvestPrice: centsToInsuranceDollars('Corn', 4),
      insuredAcres: 1, actualYield: 170,
    })
    expect(r.revenueGuarantee).toBeCloseTo(720, 2)
    expect(r.indemnity).toBeCloseTo(40, 2)
  })
})

describe('computePolicy sanity guard — flags a ¢/lb leak, never blocks', () => {
  const cottonBase: PolicyInputs = {
    planType: 'RP', coverageLevel: 0.75, aphYield: 1200,
    projectedPrice: 0.68, harvestPrice: 0.45, insuredAcres: 100, actualYield: 1082,
  }

  it('clean cotton math carries no warnings', () => {
    const comp = computePolicy({ base: cottonBase, basePremium: 0, sco: null, eco: null })
    expect(comp.warnings).toEqual([])
    expect(comp.base.indemnity).toBeCloseTo(12510, 2) // 125.10/ac × 100 ac
  })

  it('fires on a deliberately mis-unit harvest price (¢ where $ expected)', () => {
    const comp = computePolicy({
      base: { ...cottonBase, harvestPrice: 45 }, // ¢ leaked through
      basePremium: 0, sco: null, eco: null,
    })
    expect(comp.warnings.length).toBeGreaterThan(0)
    expect(comp.warnings[0]).toMatch(/price units/)
  })

  it('fires on a ¢-stored projected price (guarantee/acre implausible)', () => {
    const comp = computePolicy({
      base: { ...cottonBase, projectedPrice: 68 }, // ¢-stored projected
      basePremium: 0, sco: null, eco: null,
    })
    expect(comp.warnings.length).toBeGreaterThan(0)
  })

  it('stays silent on normal grain math', () => {
    const comp = computePolicy({
      base: { planType: 'RP', coverageLevel: 0.8, aphYield: 200, projectedPrice: 4.5, harvestPrice: 4, insuredAcres: 100, actualYield: 170 },
      basePremium: 2000, sco: null, eco: null,
    })
    expect(comp.warnings).toEqual([])
  })
})

describe('resolveHarvestPriceByCrop — cotton futures sources convert to $/lb', () => {
  const cottonPolicy = mkPolicy({ id: 'pc', crop_id: 'cotton', projected_price: 0.68, aph_yield: 1200 })
  const crops = [{ id: 'cotton', name: 'Cotton' }, { id: 'corn', name: 'Corn' }]
  const base = { cropIds: ['cotton'], cropYear: 2026, policies: [cottonPolicy], estimates: [] as HarvestPriceEstimate[], crops }

  it('live CT quote (¢/lb) → $/lb', () => {
    const m = resolveHarvestPriceByCrop({
      ...base,
      liveByCrop: new Map([['cotton', { price: 67.5, stale: false, priceDate: '2026-10-01' }]]),
    })
    expect(m.get('cotton')).toMatchObject({ price: 0.675, source: 'estimate' })
  })

  it('stored harvest_estimate (Barchart mirror, ¢/lb) → $/lb', () => {
    const m = resolveHarvestPriceByCrop({
      ...base,
      estimates: [mkEstimate({ crop_id: 'cotton', price_type: 'harvest_estimate', price: 62 })],
    })
    expect(m.get('cotton')!.price).toBeCloseTo(0.62, 6)
  })

  it('RMA-native sources (harvest_final, policy harvest_price, projected) pass through', () => {
    const viaFinal = resolveHarvestPriceByCrop({
      ...base,
      estimates: [mkEstimate({ crop_id: 'cotton', price_type: 'harvest_final', price: 0.62 })],
    })
    expect(viaFinal.get('cotton')).toMatchObject({ price: 0.62, source: 'final' })
    const viaPolicy = resolveHarvestPriceByCrop({
      ...base,
      policies: [mkPolicy({ ...cottonPolicy, harvest_price: 0.59 })],
    })
    expect(viaPolicy.get('cotton')!.price).toBeCloseTo(0.59, 6)
    const viaProjected = resolveHarvestPriceByCrop(base)
    expect(viaProjected.get('cotton')).toMatchObject({ price: 0.68, source: 'projected' })
  })

  it('grains are untouched with crops supplied', () => {
    const m = resolveHarvestPriceByCrop({
      cropIds: ['corn'], cropYear: 2026, policies: [mkPolicy()], estimates: [], crops,
      liveByCrop: new Map([['corn', { price: 4.2, stale: false, priceDate: '2026-10-01' }]]),
    })
    expect(m.get('corn')!.price).toBe(4.2)
  })
})

// ---------------------------------------------------------------------------
// INVARIANT (the "impossible corn indemnity" guard): for any farm-based
// (non-area) policy, actual yield ≥ APH AND harvest ≥ projected ⟹ the base
// indemnity is exactly $0. guarantee = APH × cov × max(proj, harvest) <
// actual × harvest whenever cov < 1 — a payment in that state means an
// upstream input (county estimate, harvest resolution, units) is wrong.
// ---------------------------------------------------------------------------
describe('invariant: yield ≥ APH and harvest ≥ projected ⟹ base indemnity = 0 (non-area plans)', () => {
  it('holds for RP / RP-HPE / YP across coverage levels, crops, and price gaps', () => {
    const yields: Array<[number, number]> = [[180, 180], [180, 195], [58, 60.2], [1200, 1350]]
    const prices: Array<[number, number]> = [[4.62, 4.62], [4.62, 4.9], [11.2, 12.4], [0.68, 0.71]]
    for (const planType of ['RP', 'RP_HPE', 'YP'] as const) {
      for (const coverageLevel of [0.5, 0.65, 0.75, 0.8, 0.85]) {
        for (const [aphYield, actualYield] of yields) {
          for (const [projectedPrice, harvestPrice] of prices) {
            const r = computeIndemnity({
              planType, coverageLevel, aphYield, projectedPrice, harvestPrice,
              insuredAcres: 250, actualYield,
            })
            expect(r.indemnity).toBe(0)
          }
        }
      }
    }
  })

  it('corn RP worked example: yield above APH + harvest above projected pays nothing anywhere', () => {
    // APH 195, cov 80%, projected 4.62, harvest 4.85, actual 205, 100 ac:
    //   guarantee = 195 × 0.80 × 4.85 × 100 = 75,660
    //   actual    = 205 × 4.85 × 100        = 99,425 → base $0
    // With NO shared county row, SCO/ECO estimate = RMA expected, so the county
    // revenue ratio is harvest/gp = 1 ≥ every trigger → county legs $0 too.
    const comp = computePolicy({
      base: {
        planType: 'RP', coverageLevel: 0.8, aphYield: 195, projectedPrice: 4.62,
        harvestPrice: 4.85, insuredAcres: 100, actualYield: 205,
      },
      basePremium: 5000,
      sco: { coverageTrigger: 0.86, expectedCountyYield: 190, premiumPerAcre: 10, totalPremium: null },
      eco: { ecoTriggerLevel: 0.95, expectedCountyYield: 190, premiumPerAcre: 8, totalPremium: null },
    })
    expect(comp.base.indemnity).toBe(0)
    expect(comp.base.revenueGuarantee).toBeCloseTo(75660, 2)
    expect(comp.base.expectedRevenue).toBeCloseTo(99425, 2)
    expect(comp.sco!.indemnity).toBe(0)
    expect(comp.eco!.indemnity).toBe(0)
    expect(comp.totalIndemnity).toBe(0)
  })
})
