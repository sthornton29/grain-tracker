import { describe, it, expect } from 'vitest'
import {
  normalizeTradeDate,
  matchExistingOpenPosition,
  resolveClosedGroupSide,
  type PositionFingerprint,
} from '@/lib/statement-matching'

// The failing 7/06 StoneX statement case, encoded as regression fixtures:
//   * six JUL 27 CBT wheat lots already imported in June were re-listed on the
//     7/06 statement; three (the fractional-price ones) were wrongly flagged
//     "New" because dedupe used near-exact float equality (1e-4) — a $0.0025
//     fractional-parse drift between extraction runs failed the match.
//   * the NOV 26 soybean closed group was extracted as "long" while the DB
//     positions it closes are short — the DB side must win.

// ---------- normalizeTradeDate ----------
describe('normalizeTradeDate', () => {
  it('passes YYYY-MM-DD through (zero-padding as needed)', () => {
    expect(normalizeTradeDate('2026-04-23')).toBe('2026-04-23')
    expect(normalizeTradeDate('2026-4-3')).toBe('2026-04-03')
  })
  it('strips a time part from ISO datetimes', () => {
    expect(normalizeTradeDate('2026-04-23T00:00:00Z')).toBe('2026-04-23')
    expect(normalizeTradeDate('2026-04-23 00:00:00')).toBe('2026-04-23')
  })
  it('parses US M/D/YYYY and M/D/YY forms', () => {
    expect(normalizeTradeDate('4/23/2026')).toBe('2026-04-23')
    expect(normalizeTradeDate('04/23/26')).toBe('2026-04-23')
  })
  it('parses the statement quirk single-digit year: "3/09/6" -> 2026-03-09', () => {
    expect(normalizeTradeDate('3/09/6')).toBe('2026-03-09')
  })
  it('returns null for blank/garbage/invalid month or day', () => {
    expect(normalizeTradeDate(null)).toBeNull()
    expect(normalizeTradeDate('')).toBeNull()
    expect(normalizeTradeDate('not a date')).toBeNull()
    expect(normalizeTradeDate('2026-13-01')).toBeNull()
    expect(normalizeTradeDate('2026-01-32')).toBeNull()
  })
})

// ---------- matchExistingOpenPosition: the six-wheat-lot case ----------
type DbPos = PositionFingerprint & { id: string }

// The six JUL 27 wheat shorts as stored by the June import. The 4/24 lot
// carries a deliberate $0.0025 fractional-parse difference from what the 7/06
// statement shows (DB 6.675 vs statement 6.6775) — it must still match.
const JUL27_WHEAT_DB: DbPos[] = [
  { id: 'w1', commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-23', trade_price: 6.7 },
  { id: 'w2', commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-24', trade_price: 6.675 },
  { id: 'w3', commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-27', trade_price: 6.8 },
  { id: 'w4', commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-28', trade_price: 6.9 },
  { id: 'w5', commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-29', trade_price: 7.0025 },
  { id: 'w6', commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-05-19', trade_price: 7.1875 },
]

// The same six lots as extracted from the 7/06 statement (canonical prices).
const JUL27_WHEAT_STATEMENT: PositionFingerprint[] = [
  { commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-23', trade_price: 6.7 },
  { commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-24', trade_price: 6.6775 },
  { commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-27', trade_price: 6.8 },
  { commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-28', trade_price: 6.9 },
  { commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-04-29', trade_price: 7.0025 },
  { commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', num_contracts: 2, trade_date: '2026-05-19', trade_price: 7.1875 },
]

describe('matchExistingOpenPosition - the six JUL 27 wheat lots', () => {
  it('ALL six statement lots match the stored positions — zero flagged New', () => {
    for (const row of JUL27_WHEAT_STATEMENT) {
      const { match } = matchExistingOpenPosition(row, JUL27_WHEAT_DB)
      expect(match, `${row.trade_date} @ ${row.trade_price} should match`).not.toBeNull()
    }
  })

  it('the $0.0025 price-parse drift lot (6.6775 vs stored 6.675) matches under tolerance', () => {
    const { match } = matchExistingOpenPosition(JUL27_WHEAT_STATEMENT[1], JUL27_WHEAT_DB)
    expect(match?.id).toBe('w2')
  })

  it('an exact-price lot matches its own row, not a neighbor', () => {
    const { match } = matchExistingOpenPosition(JUL27_WHEAT_STATEMENT[0], JUL27_WHEAT_DB)
    expect(match?.id).toBe('w1')
  })

  it('a genuinely-new lot (different trade date) stays New, with the near-miss explained', () => {
    const newLot: PositionFingerprint = {
      commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short',
      num_contracts: 2, trade_date: '2026-06-02', trade_price: 7.1875,
    }
    const { match, nearMiss } = matchExistingOpenPosition(newLot, JUL27_WHEAT_DB)
    expect(match).toBeNull()
    // Closest candidate is w6 (same price/contracts, only the date differs).
    expect(nearMiss?.position.id).toBe('w6')
    expect(nearMiss?.differences).toHaveLength(1)
    expect(nearMiss?.differences[0].field).toBe('trade_date')
    expect(nearMiss?.differences[0].message).toContain('2026-05-19')
    expect(nearMiss?.differences[0].message).toContain('2026-06-02')
  })

  it('a price gap beyond half a cent does NOT match and reports the delta', () => {
    const row: PositionFingerprint = {
      commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short',
      num_contracts: 2, trade_date: '2026-04-24', trade_price: 6.63, // 0.045 below stored 6.675
    }
    const { match, nearMiss } = matchExistingOpenPosition(row, JUL27_WHEAT_DB)
    expect(match).toBeNull()
    expect(nearMiss?.position.id).toBe('w2')
    expect(nearMiss?.differences.some((d) => d.field === 'trade_price' && d.message.includes('0.0450'))).toBe(true)
  })

  it('a side-only disagreement still matches (AI side reads are unreliable; same fill cannot be two positions)', () => {
    const flipped: PositionFingerprint = { ...JUL27_WHEAT_STATEMENT[0], side: 'long' }
    const { match } = matchExistingOpenPosition(flipped, JUL27_WHEAT_DB)
    expect(match?.id).toBe('w1')
  })

  it('dates in different formats still compare equal after normalization', () => {
    const usFormat: PositionFingerprint = { ...JUL27_WHEAT_STATEMENT[0], trade_date: '4/23/26' }
    const { match } = matchExistingOpenPosition(usFormat, JUL27_WHEAT_DB)
    expect(match?.id).toBe('w1')
  })

  it('different contract count is not a match (partial vs full position are distinct)', () => {
    const bigger: PositionFingerprint = { ...JUL27_WHEAT_STATEMENT[0], num_contracts: 4 }
    const { match, nearMiss } = matchExistingOpenPosition(bigger, JUL27_WHEAT_DB)
    expect(match).toBeNull()
    expect(nearMiss?.differences.some((d) => d.field === 'num_contracts')).toBe(true)
  })

  it('no same-commodity/month candidates -> New with no near-miss', () => {
    const corn: PositionFingerprint = {
      commodity: 'Corn', contract_month: 'DEC 26', side: 'short',
      num_contracts: 2, trade_date: '2026-04-23', trade_price: 4.7,
    }
    const { match, nearMiss } = matchExistingOpenPosition(corn, JUL27_WHEAT_DB)
    expect(match).toBeNull()
    expect(nearMiss).toBeNull()
  })
})

// ---------- resolveClosedGroupSide: DB positions are authoritative ----------
describe('resolveClosedGroupSide', () => {
  it('the 7/06 soybean case: extracted "long" but the matched DB positions are short -> short, overridden', () => {
    const r = resolveClosedGroupSide('long', ['short', 'short'])
    expect(r.side).toBe('short')
    expect(r.overridden).toBe(true)
  })
  it('agreement: extracted side matches the DB side -> no override flag', () => {
    const r = resolveClosedGroupSide('short', ['short', 'short'])
    expect(r.side).toBe('short')
    expect(r.overridden).toBe(false)
  })
  it('no matched positions -> the extracted side stands', () => {
    const r = resolveClosedGroupSide('long', [])
    expect(r.side).toBe('long')
    expect(r.overridden).toBe(false)
  })
  it('mixed matched sides (should not happen) -> keep the extracted side, no override', () => {
    const r = resolveClosedGroupSide('long', ['short', 'long'])
    expect(r.side).toBe('long')
    expect(r.overridden).toBe(false)
  })
})
