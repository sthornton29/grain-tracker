// resolveTicketDate — the code decides the year, never the model.
//
// Pinned (today = 2026-10-05 unless stated):
//   * "10/03" and "OCT 3" → 2026-10-03, flagged year-assumed
//   * "10/03/26" → 2026-10-03 not flagged; "10/03/2025" → 2025-10-03 as printed
//   * "10/09" → 2026-10-09 (4 days ahead, inside the 7-day tolerance)
//   * today 2027-01-03, "12/30" → 2026-12-30 (the previous year)
//   * "2/30" → null, needs review
import { describe, expect, it } from 'vitest'
import { YEAR_GUARD_DAYS, effectiveCropYear, parseTicketDateText, resolveTicketDate, yearAssumedNote } from './ticket-date'

const TODAY = '2026-10-05'

describe('resolveTicketDate — year printed', () => {
  it('a two-digit year means 20YY and is not flagged', () => {
    expect(resolveTicketDate('10/03/26', TODAY)).toEqual({ date: '2026-10-03', yearAssumed: false, problem: null })
  })
  it('a four-digit year is used exactly as printed, even a past year', () => {
    expect(resolveTicketDate('10/03/2025', TODAY)).toEqual({ date: '2025-10-03', yearAssumed: false, problem: null })
  })
  it('ISO and month-name forms with a year', () => {
    expect(resolveTicketDate('2026-10-03', TODAY).date).toBe('2026-10-03')
    expect(resolveTicketDate('Oct 3, 2026', TODAY).date).toBe('2026-10-03')
    expect(resolveTicketDate('3 October 2026', TODAY).date).toBe('2026-10-03')
    expect(resolveTicketDate('10-03-26', TODAY).date).toBe('2026-10-03')
    expect(resolveTicketDate('10.03.2026', TODAY).date).toBe('2026-10-03')
  })
  it('the extraction saying no year was printed overrides a year the model wrote anyway', () => {
    // The model guessed 2025 for a year-less ticket: ignored, the code's rule applies.
    expect(resolveTicketDate('2025-10-03', TODAY, { yearPrinted: false })).toEqual({ date: '2026-10-03', yearAssumed: true, problem: null })
  })
})

describe('resolveTicketDate — no year printed', () => {
  it('"10/03" → the current year, flagged', () => {
    expect(resolveTicketDate('10/03', TODAY)).toEqual({ date: '2026-10-03', yearAssumed: true, problem: null })
  })
  it('"OCT 3" → the same', () => {
    expect(resolveTicketDate('OCT 3', TODAY)).toEqual({ date: '2026-10-03', yearAssumed: true, problem: null })
    expect(resolveTicketDate('Oct. 3rd', TODAY).date).toBe('2026-10-03')
    expect(resolveTicketDate('3 Oct', TODAY).date).toBe('2026-10-03')
  })
  it('a few days ahead stays in the current year (inside the 7-day tolerance)', () => {
    expect(YEAR_GUARD_DAYS).toBe(7)
    expect(resolveTicketDate('10/09', TODAY)).toEqual({ date: '2026-10-09', yearAssumed: true, problem: null })
    expect(resolveTicketDate('10/12', TODAY).date).toBe('2026-10-12') // exactly 7 days
  })
  it('more than 7 days ahead means last year: a 12/30 ticket scanned on January 3', () => {
    expect(resolveTicketDate('12/30', '2027-01-03')).toEqual({ date: '2026-12-30', yearAssumed: true, problem: null })
    expect(resolveTicketDate('10/13', TODAY).date).toBe('2025-10-13') // 8 days ahead
  })
  it('accepts a Date for today (local calendar date)', () => {
    expect(resolveTicketDate('10/03', new Date(2026, 9, 5, 23, 30)).date).toBe('2026-10-03')
  })
})

describe('resolveTicketDate — impossible or unreadable', () => {
  it('"2/30" → no date, needs review', () => {
    expect(resolveTicketDate('2/30', TODAY)).toEqual({ date: null, yearAssumed: false, problem: 'impossible' })
    expect(resolveTicketDate('2/30/26', TODAY).problem).toBe('impossible')
    expect(resolveTicketDate('13/01', TODAY).problem).toBe('impossible')
  })
  it('nothing date-like → unreadable', () => {
    expect(resolveTicketDate(null, TODAY)).toEqual({ date: null, yearAssumed: false, problem: 'unreadable' })
    expect(resolveTicketDate('', TODAY).problem).toBe('unreadable')
    expect(resolveTicketDate('ticket', TODAY).problem).toBe('unreadable')
  })
  it('2/29 with no year resolves to the nearest leap year only when one applies', () => {
    expect(resolveTicketDate('2/29', '2029-03-01').date).toBe('2028-02-29')
    expect(resolveTicketDate('2/29', '2026-03-01').problem).toBe('impossible')
  })
})

describe('parseTicketDateText', () => {
  it('reports whether a year was in the text', () => {
    expect(parseTicketDateText('10/03')).toEqual({ month: 10, day: 3, year: null })
    expect(parseTicketDateText('10/03/26')).toEqual({ month: 10, day: 3, year: 2026 })
  })
})

describe('helpers', () => {
  it('the chip names the assumed year', () => {
    expect(yearAssumedNote('2026-10-03')).toBe('Year not on ticket, assumed 2026.')
  })
  it('effectiveCropYear is the existing rule: crop_year ?? the date year', () => {
    expect(effectiveCropYear('2026', '2027-01-03')).toBe(2026)
    expect(effectiveCropYear('', '2027-01-03')).toBe(2027)
    expect(effectiveCropYear(null, null)).toBeNull()
  })
})
