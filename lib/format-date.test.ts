import { describe, it, expect } from 'vitest'
import { fmtDate, fmtDateShort, fmtDateMonth } from './format-date'

describe('format-date', () => {
  it('formats calendar dates without timezone drift', () => {
    expect(fmtDate('2026-09-24')).toBe('9/24/2026')
    expect(fmtDate('2026-01-05')).toBe('1/5/2026')
    expect(fmtDateShort('2026-09-24')).toBe('9/24')
    expect(fmtDateMonth('2026-09-24')).toBe('Sep 24')
  })
  it('accepts timestamps and tolerates junk', () => {
    expect(fmtDate('2026-09-24T14:05:00Z')).toBe('9/24/2026')
    expect(fmtDate(null)).toBe('')
    expect(fmtDate('')).toBe('')
    expect(fmtDate('nope')).toBe('')
  })
})
