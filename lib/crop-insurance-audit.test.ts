import { describe, it, expect } from 'vitest'
import {
  auditCountyEstimate, auditInvariants, auditPolicyIndemnities, auditYieldBasis, compareAudit,
  type AuditResult,
} from '@/lib/crop-insurance-audit'
import { computePolicy, type PolicyInputs } from '@/lib/crop-insurance'

// The audit layer is an INDEPENDENT transcription of the indemnity formulas.
// These tests pin (a) agreement with the production engine on the
// hand-verified worked examples, and (b) that a forced disagreement flags.

const rpBase: PolicyInputs = {
  planType: 'RP', coverageLevel: 0.8, aphYield: 180, projectedPrice: 4.62,
  harvestPrice: 4.0, insuredAcres: 100, actualYield: 120,
}

describe('audit vs production — hand-verified agreement', () => {
  it('corn RP + SCO (county override 140): base 18,528.00 · SCO 4,989.60 — both implementations to the cent', () => {
    const prod = computePolicy({
      base: rpBase, basePremium: 0,
      sco: { coverageTrigger: 0.86, expectedCountyYield: 175, premiumPerAcre: null, totalPremium: null },
      eco: null,
      county: { assumption: { yield_differential: null, county_yield_override: 140, rma_final_county_yield: null } },
    })
    const audit = auditPolicyIndemnities({
      planType: 'RP', coverageLevel: 0.8, aphYield: 180, projectedPrice: 4.62, harvestPrice: 4.0,
      insuredAcres: 100, actualYield: 120,
      expectedCountyYield: null, expectedCountyRevenue: null, protectionFactor: null,
      county: { final: null, override: 140, differential: null, farmBasis: 120 },
      sco: { trigger: 0.86, lower: 0.8, expectedCountyYield: 175 },
      eco: null, stax: null, mco: null,
    })
    expect(audit.base).toBeCloseTo(18528.0, 2)
    expect(audit.sco).toBeCloseTo(4989.6, 2)
    expect(audit.base).toBeCloseTo(prod.base.indemnity, 2)
    expect(audit.sco!).toBeCloseTo(prod.sco!.indemnity, 2)
    const cmp = compareAudit({
      production: { base: prod.base.indemnity, sco: prod.sco!.indemnity, eco: null, stax: null, mco: null, total: prod.totalIndemnity },
      audit, insuredAcres: 100,
    })
    expect(cmp.flagged).toBe(false)
    expect(cmp.maxDeltaPerAcre).toBeLessThanOrEqual(0.01)
  })

  it('no-loss corn (yield ≥ APH, harvest ≥ projected): $0 everywhere in both', () => {
    const base: PolicyInputs = { ...rpBase, aphYield: 195, actualYield: 205, harvestPrice: 4.85 }
    const prod = computePolicy({
      base, basePremium: 0,
      sco: { coverageTrigger: 0.86, expectedCountyYield: 190, premiumPerAcre: null, totalPremium: null },
      eco: { ecoTriggerLevel: 0.95, expectedCountyYield: 190, premiumPerAcre: null, totalPremium: null },
    })
    const audit = auditPolicyIndemnities({
      planType: 'RP', coverageLevel: 0.8, aphYield: 195, projectedPrice: 4.62, harvestPrice: 4.85,
      insuredAcres: 100, actualYield: 205,
      expectedCountyYield: null, expectedCountyRevenue: null, protectionFactor: null,
      county: { final: null, override: null, differential: null, farmBasis: 205 },
      sco: { trigger: 0.86, lower: 0.8, expectedCountyYield: 190 },
      eco: { trigger: 0.95, lower: 0.86, expectedCountyYield: 190 },
      stax: null, mco: null,
    })
    expect(audit.base).toBe(0)
    expect(audit.sco).toBe(0)
    expect(audit.eco).toBe(0)
    expect(audit.total).toBe(0)
    expect(prod.totalIndemnity).toBe(0)
  })

  it('YP shortfall: 180 APH × 0.8 − 120 actual over 100 ac at gp 4.62 — agree', () => {
    const prod = computePolicy({ base: { ...rpBase, planType: 'YP' }, basePremium: 0, sco: null, eco: null })
    const audit = auditPolicyIndemnities({
      planType: 'YP', coverageLevel: 0.8, aphYield: 180, projectedPrice: 4.62, harvestPrice: 4.0,
      insuredAcres: 100, actualYield: 120,
      expectedCountyYield: null, expectedCountyRevenue: null, protectionFactor: null,
      county: { final: null, override: null, differential: null, farmBasis: 120 },
      sco: null, eco: null, stax: null, mco: null,
    })
    // shortfall = (180×0.8 − 120) × 100 = 2,400 bu × 4.62 = 11,088
    expect(audit.base).toBeCloseTo(11088, 2)
    expect(audit.base).toBeCloseTo(prod.base.indemnity, 2)
  })

  it('differential county resolution matches: farm 120 − diff −55 → est 175 → SCO $0', () => {
    const prod = computePolicy({
      base: rpBase, basePremium: 0,
      sco: { coverageTrigger: 0.86, expectedCountyYield: 175, premiumPerAcre: null, totalPremium: null },
      eco: null,
      county: { assumption: { yield_differential: -55, county_yield_override: null, rma_final_county_yield: null } },
    })
    const audit = auditPolicyIndemnities({
      planType: 'RP', coverageLevel: 0.8, aphYield: 180, projectedPrice: 4.62, harvestPrice: 4.0,
      insuredAcres: 100, actualYield: 120,
      expectedCountyYield: null, expectedCountyRevenue: null, protectionFactor: null,
      county: { final: null, override: null, differential: -55, farmBasis: 120 },
      sco: { trigger: 0.86, lower: 0.8, expectedCountyYield: 175 },
      eco: null, stax: null, mco: null,
    })
    expect(audit.countyEstimate).toEqual({ value: 175, source: 'differential' })
    expect(audit.sco).toBeCloseTo(0, 2)
    expect(audit.sco!).toBeCloseTo(prod.sco!.indemnity, 2)
  })
})

describe('auditCountyEstimate precedence', () => {
  it('final > override > differential > expected', () => {
    expect(auditCountyEstimate({ final: 152, override: 140, differential: 15, farmBasis: 185 }, 150)).toEqual({ value: 152, source: 'final' })
    expect(auditCountyEstimate({ final: null, override: 140, differential: 15, farmBasis: 185 }, 150)).toEqual({ value: 140, source: 'override' })
    expect(auditCountyEstimate({ final: null, override: null, differential: 15, farmBasis: 185 }, 150)).toEqual({ value: 170, source: 'differential' })
    expect(auditCountyEstimate({ final: null, override: null, differential: null, farmBasis: 185 }, 150)).toEqual({ value: 150, source: 'expected' })
  })
})

describe('auditYieldBasis provenance', () => {
  const base = {
    practice: 'non_irrigated' as const,
    practiceActualYield: null, expectedYieldIrr: 220, expectedYieldDry: 165, expectedYieldBlended: 190,
    harvestComplete: false, actualCropYield: null, meanAph: 172,
  }
  it('actual practice breakout wins; then per-practice expected; then mean APH', () => {
    expect(auditYieldBasis({ ...base, practiceActualYield: 158 })).toEqual({ value: 158, source: 'actual_practice' })
    expect(auditYieldBasis(base)).toEqual({ value: 165, source: 'expected_practice' })
    expect(auditYieldBasis({ ...base, expectedYieldDry: null })).toEqual({ value: 190, source: 'expected_blended' })
    expect(auditYieldBasis({ ...base, expectedYieldDry: null, expectedYieldBlended: null })).toEqual({ value: 172, source: 'mean_aph' })
  })
  it('harvest-complete prefers the crop actual over the expected', () => {
    expect(auditYieldBasis({ ...base, harvestComplete: true, actualCropYield: 151 })).toEqual({ value: 151, source: 'actual_crop' })
  })
})

describe('compareAudit flagging', () => {
  const zero: AuditResult = {
    guaranteePrice: 4.62, revenueGuarantee: 0, expectedRevenue: 0,
    base: 0, sco: null, eco: null, stax: null, mco: null, total: 0, countyEstimate: null,
  }
  it('flags a leg disagreeing by more than $1/acre; tolerates less', () => {
    const big = compareAudit({ production: { base: 250, sco: null, eco: null, stax: null, mco: null, total: 250 }, audit: zero, insuredAcres: 100 })
    expect(big.flagged).toBe(true) // $2.50/ac on base
    const small = compareAudit({ production: { base: 80, sco: null, eco: null, stax: null, mco: null, total: 80 }, audit: zero, insuredAcres: 100 })
    expect(small.flagged).toBe(false) // $0.80/ac
  })
})

describe('auditInvariants', () => {
  it('fails the base-zero invariant when a payment shows in the impossible state', () => {
    const checks = auditInvariants({
      planType: 'RP', aphYield: 195, actualYield: 205, projectedPrice: 4.62, harvestPrice: 4.85,
      baseIndemnity: 1234, isCotton: false, countyLegSources: ['differential'],
    })
    expect(checks[0].status).toBe('fail')
    expect(checks[1].status).toBe('pass')
    expect(checks[2].status).toBe('n/a')
  })
  it('passes when base is $0, county legs labeled, cotton in dollars', () => {
    const checks = auditInvariants({
      planType: 'RP', aphYield: 1200, actualYield: 1300, projectedPrice: 0.68, harvestPrice: 0.71,
      baseIndemnity: 0, isCotton: true, countyLegSources: ['expected'],
    })
    expect(checks.every((c) => c.status !== 'fail')).toBe(true)
    expect(checks[2].status).toBe('pass')
  })
  it('flags a ¢/lb cotton price', () => {
    const checks = auditInvariants({
      planType: 'RP', aphYield: 1200, actualYield: 1000, projectedPrice: 68, harvestPrice: 71,
      baseIndemnity: 0, isCotton: true, countyLegSources: [],
    })
    expect(checks[2].status).toBe('fail')
  })
})
