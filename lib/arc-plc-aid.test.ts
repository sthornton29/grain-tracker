import { describe, it, expect } from 'vitest'
import {
  TOSS_UP_BAND_PER_ACRE, farmVerdict, arcTriggerPrice, compareProgramTotals,
  arcMissingText, recommendationText, notCountedText, type ComparableFarm,
} from '@/lib/arc-plc-aid'

const farm = (over: Partial<ComparableFarm>): ComparableFarm => ({
  baseAcres: 100, plcNet: null, arcNet: null, hasMya: true, hasBenchmark: true, arcTriggerPrice: null, ...over,
})

describe('farmVerdict', () => {
  it('$0 vs $0 is a toss-up, never "Favors PLC"', () => {
    expect(farmVerdict(0, 0, 31.48)).toBe('TOSS')
    expect(farmVerdict(0, 0, 0)).toBe('TOSS')
  })
  it('uses the same per-acre band as the by-crop verdict', () => {
    expect(farmVerdict(100, 100 + TOSS_UP_BAND_PER_ACRE * 100 - 1, 100)).toBe('TOSS')
    expect(farmVerdict(100, 100 + TOSS_UP_BAND_PER_ACRE * 100 + 1, 100)).toBe('ARC')
    expect(farmVerdict(404, 0, 31.48)).toBe('PLC')
  })
  it('a side with no number cannot win or lose', () => {
    expect(farmVerdict(404, null, 31)).toBe('PLC')
    expect(farmVerdict(null, 122, 31)).toBe('ARC')
    expect(farmVerdict(null, null, 31)).toBeNull()
    // a $0 against an unknown side is no recommendation (canola: PLC $0, no county row)
    expect(farmVerdict(0, null, 2)).toBeNull()
    expect(farmVerdict(null, 0, 2)).toBeNull()
  })
})

describe('arcTriggerPrice', () => {
  it('is the guarantee spread over the expected county yield', () => {
    // Lawrence AL corn 2026: $5.03 × 165.08 = $830.35; 90% = $747.32; county at +10% = 181.59
    expect(arcTriggerPrice(747.32, 181.59)).toBeCloseTo(4.1154, 3)
    expect(arcTriggerPrice(747.32, 0)).toBeNull()
  })
})

describe('compareProgramTotals', () => {
  it('sums each side over the farms that have a number and compares only the farms with both', () => {
    const t = compareProgramTotals([
      farm({ baseAcres: 10, plcNet: 162, arcNet: 0 }),
      farm({ baseAcres: 10, plcNet: 84, arcNet: 0 }),
      // Cottontown: wheat benchmark row missing for Colbert — PLC known, ARC-CO not
      farm({ baseAcres: 8.63, plcNet: 238, arcNet: null, hasBenchmark: false }),
    ])
    expect(t.plcTotal).toBe(484)
    expect(t.arcTotal).toBe(0)
    expect(t.comparedFarms).toBe(2)
    expect(t.diffPerAcre).toBeCloseTo((0 - 246) / 20, 6)
    expect(t.verdict).toBe('PLC')
    expect(t.arcNoBenchmark).toBe(1)
    expect(t.arcNoMya).toBe(0)
    expect(t.plcNoMya).toBe(0)
  })
  it('a missing marketing-year price is reported as that, not as a missing benchmark', () => {
    const t = compareProgramTotals([
      farm({ plcNet: null, arcNet: null, hasMya: false }),
      farm({ plcNet: null, arcNet: null, hasMya: false }),
    ])
    expect(t.plcTotal).toBeNull()
    expect(t.arcTotal).toBeNull()
    expect(t.verdict).toBeNull()
    expect(t.arcNoMya).toBe(2)
    expect(t.plcNoMya).toBe(2)
    expect(t.arcNoBenchmark).toBe(0)
  })
  it('inside the band it is a toss-up, and the highest ARC-CO trigger is surfaced', () => {
    const t = compareProgramTotals([
      farm({ baseAcres: 50, plcNet: 0, arcNet: 0, arcTriggerPrice: 4.12 }),
      farm({ baseAcres: 50, plcNet: 0, arcNet: 60, arcTriggerPrice: 4.09 }),
    ])
    expect(t.verdict).toBe('TOSS')
    expect(t.arcTriggerHigh).toBe(4.12)
  })
})

describe('labels', () => {
  it('names the two different ARC-CO gaps apart', () => {
    expect(arcMissingText({ hasMya: false, hasBenchmark: true, county: 'Lawrence, AL' })).toBe('needs the marketing-year price')
    expect(arcMissingText({ hasMya: true, hasBenchmark: false, county: 'Colbert, AL' })).toBe('no county benchmark row')
    expect(arcMissingText({ hasMya: true, hasBenchmark: false, county: null })).toBe('farm has no county')
    expect(arcMissingText({ hasMya: true, hasBenchmark: true, county: 'Lawrence, AL' })).toBe('')
  })
  it('recommendation wording', () => {
    expect(recommendationText({ favors: 'TOSS', plcNet: 0, arcNet: 0 })).toBe('Neither pays at this price')
    expect(recommendationText({ favors: 'TOSS', plcNet: 100, arcNet: 110 })).toBe('Toss-up')
    expect(recommendationText({ favors: 'PLC', plcNet: 1, arcNet: 0 })).toBe('Favors PLC')
    expect(recommendationText({ favors: null, plcNet: null, arcNet: null })).toBe('—')
  })
  it('not-counted summary', () => {
    expect(notCountedText({ arcNoBenchmark: 1, arcNoMya: 0, plcNoMya: 0 })).toBe('1 ARC-CO: no county benchmark')
    expect(notCountedText({ arcNoBenchmark: 0, arcNoMya: 5, plcNoMya: 5 })).toBe('5: no marketing-year price')
    expect(notCountedText({ arcNoBenchmark: 0, arcNoMya: 0, plcNoMya: 0 })).toBe('')
  })
})
