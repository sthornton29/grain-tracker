// Matching & dedupe logic for the brokerage-statement import: normalize trade
// dates, match extracted rows against stored positions with tolerance, explain
// near-misses, and resolve a closed group's side from the DB positions it
// closes. Pure functions (no I/O) extracted from the review component so the
// failing statement cases can be pinned down in tests.

import { pricesMatch, PRICE_MATCH_EPSILON, type Side } from './hedging'

// Normalize a trade date to YYYY-MM-DD. Accepts the forms that show up across
// extractions and the DB: "2026-04-23", ISO with a time part, "4/23/2026",
// "4/23/26", and the statement quirk "3/09/6" (single-digit year = 2026).
// Returns null when unparseable — callers treat that as a non-match, never a
// silent pass.
export function normalizeTradeDate(input: string | null | undefined): string | null {
  if (!input) return null
  const s = String(input).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/)
  if (m) return ymd(m[1], m[2], m[3])
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/)
  if (m) {
    const raw = m[3]
    const y = parseInt(raw, 10)
    const year = raw.length >= 4 ? y : raw.length >= 2 ? 2000 + y : 2020 + y
    return ymd(String(year), m[1], m[2])
  }
  return null
}

function ymd(y: string, mo: string, d: string): string | null {
  const yy = parseInt(y, 10)
  const mm = parseInt(mo, 10)
  const dd = parseInt(d, 10)
  if (!yy || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

// The fields that identify a futures fill for dedupe purposes.
export type PositionFingerprint = {
  commodity: string
  contract_month: string
  side: Side
  num_contracts: number
  trade_date: string
  trade_price: number
}

export type FieldDifference = {
  field: 'trade_price' | 'trade_date' | 'num_contracts' | 'side'
  message: string // human-readable, shown on the review screen
}

export type OpenPositionMatch<T> = {
  // Tolerant match — this statement row is already in the database.
  match: T | null
  // When there's no match: the closest same-commodity/month candidate and
  // exactly which fields kept it from matching, so a "New" verdict is
  // explainable instead of mysterious.
  nearMiss: { position: T; differences: FieldDifference[] } | null
}

// Decide whether an extracted open position already exists among stored
// positions. A row matches when commodity, contract month, and num_contracts
// are exact, the trade date is exact after normalization, and the trade price
// is within `epsilon` (default half a cent — fractional-parse drift like
// 6.6775 vs 6.675 must not create a duplicate).
//
// Side is deliberately NOT required to match: the AI sometimes mis-reads
// long/short, and a re-upload must not duplicate a position just because the
// side flipped — a real long and short of the same contract at the same
// date/price/size doesn't happen in this hedging account. A side-only
// disagreement still counts as "already exists" (candidates whose side agrees
// are preferred when several qualify).
export function matchExistingOpenPosition<T extends PositionFingerprint>(
  row: PositionFingerprint,
  existing: T[],
  epsilon = PRICE_MATCH_EPSILON,
): OpenPositionMatch<T> {
  const month = row.contract_month.trim().toUpperCase()
  const date = normalizeTradeDate(row.trade_date)

  const candidates = existing.filter(
    (ex) => ex.commodity === row.commodity && ex.contract_month.trim().toUpperCase() === month,
  )
  if (candidates.length === 0) return { match: null, nearMiss: null }

  const diffsFor = (ex: T): FieldDifference[] => {
    const out: FieldDifference[] = []
    if (ex.num_contracts !== row.num_contracts) {
      out.push({ field: 'num_contracts', message: `contracts differ (${ex.num_contracts} vs ${row.num_contracts})` })
    }
    const exDate = normalizeTradeDate(ex.trade_date)
    if (exDate == null || date == null || exDate !== date) {
      out.push({ field: 'trade_date', message: `date differs (${exDate ?? ex.trade_date} vs ${date ?? row.trade_date})` })
    }
    if (!pricesMatch(ex.trade_price, row.trade_price, epsilon)) {
      const delta = Math.abs(ex.trade_price - row.trade_price)
      out.push({ field: 'trade_price', message: `price differs by $${delta.toFixed(4)}` })
    }
    if (ex.side !== row.side) {
      out.push({ field: 'side', message: `side differs (${ex.side} vs ${row.side})` })
    }
    return out
  }

  // A match = no differences beyond (possibly) side. Prefer a same-side match.
  const matches = candidates.filter((ex) => diffsFor(ex).every((d) => d.field === 'side'))
  const match = matches.find((ex) => ex.side === row.side) ?? matches[0] ?? null
  if (match) return { match, nearMiss: null }

  // No match — pick the closest candidate (fewest differences, then smallest
  // price gap) and report what differs.
  let best: { position: T; differences: FieldDifference[] } | null = null
  for (const ex of candidates) {
    const differences = diffsFor(ex)
    if (
      best == null ||
      differences.length < best.differences.length ||
      (differences.length === best.differences.length &&
        Math.abs(ex.trade_price - row.trade_price) < Math.abs(best.position.trade_price - row.trade_price))
    ) {
      best = { position: ex, differences }
    }
  }
  return { match: null, nearMiss: best }
}

// The side of a closed offset group that closes existing DB positions is
// dictated by those positions — a group that closes short positions IS a short
// group, whatever the extraction said. When every matched position agrees on
// one side, that side wins; `overridden` flags that the extracted side was
// corrected so the review UI can say so. With no matches (or a mixed bag,
// which shouldn't happen) the extracted side stands.
export function resolveClosedGroupSide(
  extractedSide: Side,
  matchedSides: Side[],
): { side: Side; overridden: boolean } {
  const unique = Array.from(new Set(matchedSides))
  if (unique.length === 1) {
    return { side: unique[0], overridden: unique[0] !== extractedSide }
  }
  return { side: extractedSide, overridden: false }
}
