import { describe, expect, it } from 'vitest'
import { projectionMonths, selectCashDetails, sumCashDetails, type CashDetail } from './cash-flow-detail'

const rows: CashDetail[] = [
  { kind: 'received', month: '2026-09', label: 'Settlement #1', amount: 5000 },
  { kind: 'received', month: '2026-10', label: 'Settlement #2', amount: 8000 },
  { kind: 'outstanding', month: '2026-09', label: 'Contract A', amount: 1200 },
  { kind: 'projected', month: '2026-09', label: 'Contract B', amount: 0 },
  { kind: 'cotton', month: '2026-09', label: 'Gin fees', amount: -300 },
]

describe('selectCashDetails', () => {
  it('one kind, one month — biggest first, zero rows dropped', () => {
    const out = selectCashDetails(rows, { kind: 'received', month: '2026-09' })
    expect(out.map((r) => r.label)).toEqual(['Settlement #1'])
    expect(selectCashDetails(rows, { kind: 'projected', month: '2026-09' })).toEqual([])
  })

  it('one kind across every month — in month order', () => {
    expect(selectCashDetails(rows, { kind: 'received', month: null }).map((r) => r.label)).toEqual(['Settlement #1', 'Settlement #2'])
  })

  it('every kind for one month — grouped in the report\'s column order', () => {
    const out = selectCashDetails(rows, { kind: 'all', month: '2026-09' })
    expect(out.map((r) => r.kind)).toEqual(['received', 'outstanding', 'cotton'])
    expect(sumCashDetails(out)).toBe(5900)
  })
})

describe('projectionMonths', () => {
  it('spreads from this month to the window end', () => {
    expect(projectionMonths({ todayKey: '2026-09', start: '2026-07-01', end: '2026-11-30' })).toEqual(['2026-09', '2026-10', '2026-11'])
  })

  it('starts at a future window start, crossing a year end', () => {
    expect(projectionMonths({ todayKey: '2026-09', start: '2026-12-01', end: '2027-02-15' })).toEqual(['2026-12', '2027-01', '2027-02'])
  })

  it('no end, or an end already passed, means "all in the current month"', () => {
    expect(projectionMonths({ todayKey: '2026-09', start: null, end: null })).toEqual([])
    expect(projectionMonths({ todayKey: '2026-09', start: '2026-01-01', end: '2026-08-31' })).toEqual([])
  })
})
