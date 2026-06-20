import { describe, it, expect } from 'vitest'
import {
  guaranteePriceFor,
  computeIndemnity,
  computeBandIndemnity,
  estimatedCountyYield,
  computePolicy,
  projectedPriceFromEstimates,
  reconcileAcreage,
  acreageTolerance,
  resolveUploadEntityId,
  type PolicyInputs,
  type BandInputs,
} from '@/lib/crop-insurance'
import type { HarvestPriceEstimate } from '@/lib/types'

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
// estimatedCountyYield
// ---------------------------------------------------------------------------
describe('estimatedCountyYield', () => {
  it('zero assumption leaves the yield unchanged', () => {
    // 150 * (1 + 0/100) = 150
    expect(estimatedCountyYield(150, 0)).toBeCloseTo(150, 6)
  })

  it('negative pct reduces the yield', () => {
    // 150 * (1 + (-10)/100) = 150 * 0.90 = 135
    expect(estimatedCountyYield(150, -10)).toBeCloseTo(135, 6)
  })

  it('positive pct raises the yield', () => {
    // 150 * (1 + 5/100) = 150 * 1.05 = 157.5
    expect(estimatedCountyYield(150, 5)).toBeCloseTo(157.5, 6)
  })

  it('null assumption is treated as 0% (factor 1.0)', () => {
    // 150 * (1 + 0/100) = 150
    expect(estimatedCountyYield(150, null)).toBeCloseTo(150, 6)
    expect(estimatedCountyYield(150, undefined)).toBeCloseTo(150, 6)
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
    //   countyYieldAssumptionPct = null → estimatedCountyYield = actualYield = 120
    //   revenueBased (RP):
    //     expectedCountyRevenue = 175 * 4.62 = 808.50
    //     actualCountyRevenue   = 120 * 4.00 = 480.00
    //     ratio = 480 / 808.50 = 0.59369… < 0.86
    //   paymentFactor = min(0.86 - 0.59369, 0.06) = 0.06 (full band)
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
        countyYieldAssumptionPct: null,
        premiumPerAcre: null,
        totalPremium: 1500,
      },
      eco: null,
    })

    expect(comp.base.indemnity).toBeCloseTo(18528.0, 2)
    expect(comp.sco).not.toBeNull()
    expect(comp.sco!.indemnity).toBeCloseTo(4989.6, 2)
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
        countyYieldAssumptionPct: null,
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
