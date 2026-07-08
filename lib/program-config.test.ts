import { describe, it, expect } from 'vitest'
import {
  resolveProgramYearConfig, programConfigNotice,
  DEFAULT_SCO_TRIGGER, DEFAULT_PER_PERSON_PAYMENT_LIMIT, DEFAULT_SEQUESTRATION_PCT,
  DEFAULT_ERP_CAP_PCT, DEFAULT_PAYMENT_FACTOR, DEFAULT_ARC_IC_PAYMENT_FACTOR,
  defaultArcGuaranteePct, defaultArcPaymentCapPct, defaultErpOlympicFactor,
} from '@/lib/program-config'
import type { ProgramYearConfig } from '@/lib/types'

function cfg(year: number, sco: number, limit: number, seq: number, over: Partial<ProgramYearConfig> = {}): ProgramYearConfig {
  return {
    id: `cfg-${year}`, crop_year: year, sco_trigger: sco,
    per_person_payment_limit: limit, sequestration_pct: seq,
    arc_guarantee_pct: 0.9, arc_payment_cap_pct: 0.12, erp_olympic_factor: 0.88,
    erp_cap_pct: 1.15, payment_factor: 0.85, arc_ic_payment_factor: 0.65,
    notes: null, created_at: '', updated_at: '',
    ...over,
  }
}

const CONFIGS = [cfg(2026, 0.86, 155000, 0.054), cfg(2027, 0.9, 155000, 0.054)]

describe('resolveProgramYearConfig', () => {
  it('returns the exact-year row when present (no fallback)', () => {
    const r = resolveProgramYearConfig(2027, CONFIGS)
    expect(r.sourceYear).toBe(2027)
    expect(r.isFallback).toBe(false)
    expect(r.scoTrigger).toBe(0.9)
    expect(r.perPersonPaymentLimit).toBe(155000)
    expect(r.sequestrationPct).toBe(0.054)
  })

  it('falls back to the most recent year AT OR BELOW the requested year', () => {
    // 2028 has no row → use 2027 (most recent ≤ 2028).
    const r = resolveProgramYearConfig(2028, CONFIGS)
    expect(r.sourceYear).toBe(2027)
    expect(r.isFallback).toBe(true)
    expect(r.scoTrigger).toBe(0.9)
  })

  it('falls back to the earliest year when the requested year precedes all configs', () => {
    // 2025 is below every row → use the earliest (2026).
    const r = resolveProgramYearConfig(2025, CONFIGS)
    expect(r.sourceYear).toBe(2026)
    expect(r.isFallback).toBe(true)
    expect(r.scoTrigger).toBe(0.86)
  })

  it('uses built-in defaults when there are no config rows at all', () => {
    const r = resolveProgramYearConfig(2026, [])
    expect(r.sourceYear).toBeNull()
    expect(r.isFallback).toBe(true)
    expect(r.scoTrigger).toBe(DEFAULT_SCO_TRIGGER)
    expect(r.perPersonPaymentLimit).toBe(DEFAULT_PER_PERSON_PAYMENT_LIMIT)
    expect(r.sequestrationPct).toBe(DEFAULT_SEQUESTRATION_PCT)
    expect(r.arcGuaranteePct).toBe(0.9)
    expect(r.arcPaymentCapPct).toBe(0.12)
    expect(r.erpOlympicFactor).toBe(0.88)
    expect(r.erpCapPct).toBe(DEFAULT_ERP_CAP_PCT)
    expect(r.paymentFactor).toBe(DEFAULT_PAYMENT_FACTOR)
    expect(r.arcIcPaymentFactor).toBe(DEFAULT_ARC_IC_PAYMENT_FACTOR)
  })

  it('carries the OBBBA columns from a config row', () => {
    const r = resolveProgramYearConfig(2026, [cfg(2026, 0.86, 155000, 0.054, { arc_guarantee_pct: 0.91, arc_payment_cap_pct: 0.13 })])
    expect(r.arcGuaranteePct).toBe(0.91)
    expect(r.arcPaymentCapPct).toBe(0.13)
  })

  it('era-aware built-in defaults: pre-OBBBA years use 86% / 10% / 85%', () => {
    expect(defaultArcGuaranteePct(2024)).toBe(0.86)
    expect(defaultArcPaymentCapPct(2024)).toBe(0.1)
    expect(defaultErpOlympicFactor(2024)).toBe(0.85)
    expect(defaultArcGuaranteePct(2025)).toBe(0.9)
    expect(defaultArcPaymentCapPct(2025)).toBe(0.12)
    expect(defaultErpOlympicFactor(2025)).toBe(0.88)
    const r = resolveProgramYearConfig(2024, [])
    expect(r.arcGuaranteePct).toBe(0.86)
    expect(r.erpOlympicFactor).toBe(0.85)
  })
})

describe('programConfigNotice', () => {
  it('is null for an exact match', () => {
    expect(programConfigNotice(resolveProgramYearConfig(2026, CONFIGS))).toBeNull()
  })
  it('names both the requested and source year on fallback', () => {
    const msg = programConfigNotice(resolveProgramYearConfig(2028, CONFIGS))
    expect(msg).toContain('2028')
    expect(msg).toContain('2027')
  })
  it('mentions built-in defaults when no rows exist', () => {
    const msg = programConfigNotice(resolveProgramYearConfig(2026, []))
    expect(msg).toContain('built-in defaults')
  })
})
