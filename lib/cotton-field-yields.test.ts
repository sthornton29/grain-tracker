import { describe, expect, it } from 'vitest'
import { lintEstimateChip, perAcre, summarizeCottonCropProgress, summarizeCottonFieldYields, type CottonFieldYieldRow } from '@/lib/cotton-field-yields'
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

describe('summarizeCottonCropProgress — the crop card\'s percent ginned and the ginned / not-ginned yield split', () => {
  // Pivot: 250 ac, fully ginned, 282,956 lbs lint actual — counted.
  // East: 100 ac, 120,000 lbs seed on the yard → 48,000 lbs est. — counted (count anyway).
  // North: 60 ac, 200,000 lbs seed of which 50,000 on the yard: 60,000 actual + 20,000 est. — still in progress (NOT counted).
  // West: 80 ac planted, nothing off it.
  const rows = [
    { fieldId: 'pivot', acres: 250, counted: true, y: y({ seedLbs: 645_220, loadCount: 22, receiptCount: 1, actualLintLbs: 282_956, lintLbs: 282_956, lintBasis: 'actual', ginning: 'ginned' }) },
    { fieldId: 'east', acres: 100, counted: true, y: y({ seedLbs: 120_000, yardSeedLbs: 120_000, loadCount: 4, estimatedLintLbs: 48_000, lintLbs: 48_000, lintBasis: 'estimated_turnout', ginning: 'on_yard' }) },
    { fieldId: 'north', acres: 60, counted: false, y: y({ seedLbs: 200_000, yardSeedLbs: 50_000, loadCount: 7, receiptCount: 1, actualLintLbs: 60_000, estimatedLintLbs: 20_000, lintLbs: 80_000, lintBasis: 'mixed', ginning: 'partly_ginned' }) },
    { fieldId: 'west', acres: 80, counted: true, y: y({}) },
  ] satisfies Array<CottonFieldYieldRow & { counted: boolean }>
  const p = summarizeCottonCropProgress(rows)

  it('percent ginned is acres of all-ginned fields over EVERY cotton acre planted — the partly ginned and unpicked acres count against it', () => {
    expect(p.acresPlanted).toBe(490)
    expect(p.acresGinned).toBe(250)
    expect(p.acresPartlyGinned).toBe(60)
    expect(p.pctGinned).toBeCloseTo((250 / 490) * 100, 6)
    // The pounds ride along for anything that wants them.
    expect(p.seedLbs).toBe(965_220)
    expect(p.yardSeedLbs).toBe(170_000)
    expect(p.ginnedSeedLbs).toBe(795_220)
  })
  it('a field with receipts but no loads on file counts as ginned', () => {
    const q = summarizeCottonCropProgress([{ fieldId: 'r', acres: 40, counted: true, y: y({ receiptCount: 1, actualLintLbs: 30_000, lintLbs: 30_000, lintBasis: 'actual', ginning: 'none' }) }])
    expect(q.acresGinned).toBe(40)
    expect(q.pctGinned).toBe(100)
  })
  it('the split covers only the counted fields: ginned = nothing left to estimate, not ginned yet = the rest', () => {
    // Pivot and the empty West field (nothing to estimate) are the ginned bucket; East is the estimate.
    expect(p.ginned.acres).toBe(330)
    expect(p.ginned.lintLbs).toBe(282_956)
    expect(p.ginned.lintPerAcre).toBeCloseTo(282_956 / 330, 6)
    expect(p.ginned.lintBasis).toBe('actual')
    expect(p.unginned.acres).toBe(100)
    expect(p.unginned.lintLbs).toBe(48_000)
    expect(p.unginned.lintPerAcre).toBeCloseTo(480, 6)
    expect(p.unginned.lintBasis).toBe('estimated_turnout')
    expect(p.turnoutLabel).toBe('40% (assumed)')
    // The in-progress field is in neither bucket — it is not in the headline either.
    expect(p.ginned.acres + p.unginned.acres).toBe(430)
  })
  it('acre-weighting the two buckets gives back the headline average', () => {
    const headline = (282_956 + 48_000) / 430
    const blend = (p.ginned.lintLbs + p.unginned.lintLbs) / (p.ginned.acres + p.unginned.acres)
    expect(blend).toBeCloseTo(headline, 9)
  })
  it('a partly ginned counted field is "part est." in the not-ginned bucket; nothing hauled = 0% ginned and empty buckets', () => {
    const q = summarizeCottonCropProgress([{ ...rows[2], counted: true }])
    expect(q.unginned.lintBasis).toBe('mixed')
    expect(q.unginned.acres).toBe(60)
    expect(q.ginned.acres).toBe(0)
    const none = summarizeCottonCropProgress([rows[3]])
    expect(none.pctGinned).toBe(0)
    expect(none.acresPlanted).toBe(80)
    expect(none.acresGinned).toBe(0)
    expect(none.seedLbs).toBe(0)
    expect(none.unginned.lintPerAcre).toBeNull()
  })
})
