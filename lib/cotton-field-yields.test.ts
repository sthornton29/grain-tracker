import { describe, expect, it } from 'vitest'
import { lintEstimateChip, perAcre, summarizeCottonFieldYields, type CottonFieldYieldRow } from '@/lib/cotton-field-yields'
import type { CottonPlantingYield, TurnoutResolution } from '@/lib/cotton'

const turnout: TurnoutResolution = { pct: 40, fraction: 0.4, source: 'default', label: '40% (assumed)', assumed: true }

function y(over: Partial<CottonPlantingYield>): CottonPlantingYield {
  return {
    seedLbs: 0, seedPerAcre: null, yardSeedLbs: 0, loadCount: 0, receiptCount: 0, bales: 0,
    actualLintLbs: 0, estimatedLintLbs: 0, lintLbs: 0, lintBasis: null, lintPerAcre: null,
    turnoutPct: null, turnoutBasis: null, turnout, ginning: 'none', ...over,
  }
}

describe('summarizeCottonFieldYields — the farm-wide roll-up', () => {
  // Pivot: 250 ac, 645,220 lbs seed, fully ginned 282,956 lbs lint.
  // East: 100 ac, 120,000 lbs seed on the yard → 48,000 lbs lint estimated at 40%.
  // West: 80 ac planted, nothing off it yet.
  const rows: CottonFieldYieldRow[] = [
    { fieldId: 'pivot', acres: 250, y: y({ seedLbs: 645_220, loadCount: 22, receiptCount: 1, actualLintLbs: 282_956, lintLbs: 282_956, lintBasis: 'actual', bales: 585 }) },
    { fieldId: 'east', acres: 100, y: y({ seedLbs: 120_000, yardSeedLbs: 120_000, loadCount: 4, estimatedLintLbs: 48_000, lintLbs: 48_000, lintBasis: 'estimated_turnout' }) },
    { fieldId: 'west', acres: 80, y: y({}) },
  ]
  const farm = summarizeCottonFieldYields(rows)

  it('counts planted acres for every field but divides by the acres with cotton off them', () => {
    expect(farm.fields).toBe(3)
    expect(farm.fieldsPicked).toBe(2)
    expect(farm.acresPlanted).toBe(430)
    expect(farm.acresPicked).toBe(350)
    expect(farm.seedLbs).toBe(765_220)
    expect(farm.seedPerAcre).toBeCloseTo(765_220 / 350, 6)
    expect(farm.lintLbs).toBe(330_956)
    expect(farm.lintPerAcre).toBeCloseTo(330_956 / 350, 6)
  })
  it('the basis is mixed when some lint is estimated, with the turnout phrase behind it', () => {
    expect(farm.lintBasis).toBe('mixed')
    expect(farm.turnoutLabel).toBe('40% (assumed)')
    expect(farm.actualLintLbs).toBe(282_956)
    expect(farm.estimatedLintLbs).toBe(48_000)
    expect(farm.yardSeedLbs).toBe(120_000)
  })
  it('all-actual and all-estimated farms say so; nothing picked = no per-acre figure', () => {
    expect(summarizeCottonFieldYields([rows[0]]).lintBasis).toBe('actual')
    expect(summarizeCottonFieldYields([rows[1]]).lintBasis).toBe('estimated_turnout')
    const none = summarizeCottonFieldYields([rows[2]])
    expect(none.lintBasis).toBeNull()
    expect(none.seedPerAcre).toBeNull()
    expect(none.acresPlanted).toBe(80)
    expect(none.acresPicked).toBe(0)
  })
  it('perAcre and the chip', () => {
    expect(perAcre(645_220, 250)).toBeCloseTo(2580.88, 2)
    expect(perAcre(100, 0)).toBeNull()
    expect(perAcre(null, 10)).toBeNull()
    expect(lintEstimateChip('actual')).toBeNull()
    expect(lintEstimateChip('mixed')).toBe('part est.')
    expect(lintEstimateChip('estimated_turnout')).toBe('est.')
    expect(lintEstimateChip(null)).toBeNull()
  })
})
