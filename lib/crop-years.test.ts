import { describe, it, expect } from 'vitest'
import { marketingCropYearOptions } from '@/lib/crop-years'

// The marketing selector is the union of every source plus this year and the
// next two — a year is reachable the moment anything is on file for it, and a
// future year is always reachable to start planning in.

describe('marketingCropYearOptions — plantings ∪ contracts ∪ hedges ∪ assumptions ∪ (now … now+2)', () => {
  it('offers this year and the next two even with nothing on file', () => {
    expect(marketingCropYearOptions({ now: 2026 })).toEqual([2028, 2027, 2026])
  })

  it('a year that exists ONLY via a hedge appears', () => {
    // 2028 corn hedged (ZCZ28) with no plantings, contracts, or assumptions —
    // and 2029 only via a hedge, past the default horizon.
    const years = marketingCropYearOptions({
      plantingYears: [2025, 2026],
      contractYears: [2026],
      hedgeYears: [2029],
      now: 2026,
    })
    expect(years).toEqual([2029, 2028, 2027, 2026, 2025])
    expect(years).toContain(2029)
  })

  it('a year that exists only via an assumption row (assumed acres) appears', () => {
    expect(marketingCropYearOptions({ assumptionYears: [2030], now: 2026 })).toEqual([2030, 2028, 2027, 2026])
  })

  it('a year that exists only via a contract appears (2027 wheat sold ahead)', () => {
    expect(marketingCropYearOptions({ plantingYears: [2026], contractYears: [2027], now: 2024, horizon: 0 })).toEqual([2027, 2026, 2024])
  })

  it('dedupes, ignores nulls, keeps the current selection, newest first', () => {
    const years = marketingCropYearOptions({
      plantingYears: [2026, 2026, null, undefined, 2024],
      extraYears: [2019, null],
      now: 2026,
    })
    expect(years).toEqual([2028, 2027, 2026, 2024, 2019])
  })
})
