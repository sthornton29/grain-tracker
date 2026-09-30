import { describe, it, expect } from 'vitest'
import { fallbackCropYear, cropYearChoices } from '@/lib/report-filters'

// The one crop-year rule's pure pieces: where an untouched default lands when
// the current year has no data, and what the dropdown offers.

describe('fallbackCropYear', () => {
  it('keeps the current year when the report has it', () => {
    expect(fallbackCropYear([2024, 2025, 2026], 2026)).toBe(2026)
  })
  it('falls back to the newest year before now', () => {
    expect(fallbackCropYear([2023, 2024, 2025], 2026)).toBe(2025)
  })
  it('takes the earliest future year when nothing is at or before now', () => {
    expect(fallbackCropYear([2027, 2028], 2026)).toBe(2027)
  })
  it('stays on now with no data at all', () => {
    expect(fallbackCropYear([], 2026)).toBe(2026)
  })
})

describe('cropYearChoices', () => {
  it('lists the data years plus the pick and the current year, newest first, once each', () => {
    expect(cropYearChoices([2024, 2024, null, 2025], 2023, 2026)).toEqual([2026, 2025, 2024, 2023])
  })
  it('ignores an "All" pick', () => {
    expect(cropYearChoices([2025], '', 2026)).toEqual([2026, 2025])
  })
})
