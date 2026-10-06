// The one place a scanned ticket's printed date becomes a load date.
//
// The document extraction returns the date EXACTLY as printed (date_text) plus
// whether a year was printed; the model is told never to supply a year that is
// not on the ticket. THIS code decides the year:
//   * a printed year is used as printed (a two-digit year means 20YY);
//   * no year → the current year, unless that puts the date more than
//     YEAR_GUARD_DAYS after today, in which case the previous year (a 12/30
//     ticket scanned on January 3);
//   * an impossible (2/30) or unreadable date → no date, the row needs review.
// Pure: `today` is always passed in, never read from the clock here.

export const YEAR_GUARD_DAYS = 7

export type ResolvedTicketDate = {
  /** YYYY-MM-DD, or null when the text could not become a real date. */
  date: string | null
  /** True when no year was printed and the code supplied one. */
  yearAssumed: boolean
  /** Why `date` is null. */
  problem: 'unreadable' | 'impossible' | null
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

type Parts = { month: number; day: number; year: number | null }

/** Reads month / day / optional year out of the printed text. Accepts
 *  10/03, 10/3/26, 10-03-2026, 10.03.26, 2026-10-03, OCT 3, Oct 3 2026,
 *  October 3, 2026, 3 Oct 2026. Null when nothing date-like is there. */
export function parseTicketDateText(text: string | null | undefined): Parts | null {
  if (text == null) return null
  const s = String(text).trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')
  if (!s) return null
  let m: RegExpMatchArray | null

  // ISO: 2026-10-03 (also 2026/10/03)
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }

  // Numeric US: 10/03, 10/3/26, 10-03-2026, 10.03.26
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/)
  if (m) return { month: Number(m[1]), day: Number(m[2]), year: m[3] != null ? expandYear(m[3]) : null }

  // Month name first: oct 3, oct 3 26, october 3 2026, oct. 3rd 2026
  m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{2}|\d{4}))?$/)
  if (m && MONTHS[m[1]] != null) return { month: MONTHS[m[1]], day: Number(m[2]), year: m[3] != null ? expandYear(m[3]) : null }

  // Day first: 3 oct, 3 oct 2026, 3rd october 26
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{2}|\d{4}))?$/)
  if (m && MONTHS[m[2]] != null) return { month: MONTHS[m[2]], day: Number(m[1]), year: m[3] != null ? expandYear(m[3]) : null }

  return null
}

function expandYear(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

function isoOf(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return null
  const d = new Date(Date.UTC(year, month - 1, day))
  // Date.UTC rolls 2/30 forward into March — that is the impossible-date tell.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** `today` as a local calendar date (YYYY-MM-DD string or Date). */
function todayIso(today: Date | string): string {
  if (typeof today === 'string') return today.slice(0, 10)
  return `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}

/**
 * Resolve a printed ticket date to a load date.
 * `yearPrinted` is the extraction's own flag: false means "ignore any year in
 * the text — the ticket had none" (the model is never trusted to supply one);
 * true / null means a year in the text is used when present.
 */
export function resolveTicketDate(
  dateText: string | null | undefined,
  today: Date | string,
  opts?: { yearPrinted?: boolean | null },
): ResolvedTicketDate {
  const parts = parseTicketDateText(dateText)
  if (!parts) return { date: null, yearAssumed: false, problem: 'unreadable' }
  const printedYear = opts?.yearPrinted === false ? null : parts.year
  if (printedYear != null) {
    const iso = isoOf(printedYear, parts.month, parts.day)
    return iso ? { date: iso, yearAssumed: false, problem: null } : { date: null, yearAssumed: false, problem: 'impossible' }
  }
  const t = todayIso(today)
  const thisYear = Number(t.slice(0, 4))
  let iso = isoOf(thisYear, parts.month, parts.day)
  if (iso && daysBetween(t, iso) > YEAR_GUARD_DAYS) iso = isoOf(thisYear - 1, parts.month, parts.day)
  if (!iso) {
    // 2/29 in a non-leap current year reads as the previous year's only when
    // that one is a leap year; otherwise the date is impossible.
    const prev = isoOf(thisYear - 1, parts.month, parts.day)
    if (prev && parts.month === 2 && parts.day === 29) return { date: prev, yearAssumed: true, problem: null }
    return { date: null, yearAssumed: false, problem: 'impossible' }
  }
  return { date: iso, yearAssumed: true, problem: null }
}

/** The review chip for an assumed year. */
export function yearAssumedNote(date: string): string {
  return `Year not on ticket, assumed ${date.slice(0, 4)}.`
}

/** The effective crop year of a load — THE existing rule (crop_year ?? the
 *  date's year), here for the scan's row order: resolve the date, then the
 *  crop year, then the field's planting. */
export function effectiveCropYear(cropYear: number | string | null | undefined, date: string | null): number | null {
  if (cropYear != null && cropYear !== '' && Number.isFinite(Number(cropYear))) return Number(cropYear)
  if (date && /^\d{4}-/.test(date)) return Number(date.slice(0, 4))
  return null
}
