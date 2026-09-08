import { describe, it, expect } from 'vitest'
import { markOpenPosition, sumUnrealized } from '@/lib/hedging-rows'
import type { Quote } from '@/lib/quotes'

// Unrealized P&L on a cotton position marked off a MANUAL close, with the
// provenance chip in the row model. Cotton: 50,000 lbs per contract, quoted in
// ¢/lb, so P&L per 1¢ = $500 per contract (pnlSizeFor = 50,000 ÷ 100).
// Worked: short 2 CTZ26 at 74.10¢; manual close typed 72.65¢ (9/2) →
// gain = (74.10 − 72.65) = 1.45¢ × $500 × 2 = $1,450.

const shortCotton = { side: 'short' as const, trade_price: 74.1, num_contracts: 2, commodity: 'Cotton', contract_symbol: 'CTZ26' }
const manualClose: Quote = { symbol: 'CTZ26', price: 72.65, priceDate: '2026-09-02', stale: true, source: 'manual', enteredAt: '2026-09-02T14:00:00' }
const liveClose: Quote = { symbol: 'CTZ26', price: 72.65, priceDate: '2026-09-08', stale: false, source: 'live', enteredAt: null }

describe('markOpenPosition — a CT short off a manual close', () => {
  it('computes $1,450 and carries the "manual · 9/2" chip', () => {
    const m = markOpenPosition({ position: shortCotton, quote: manualClose, today: '2026-09-08' })
    expect(m.currentPrice).toBe(72.65)
    expect(m.unrealized).toBeCloseTo(1450, 6)
    expect(m.chip).toBe('manual · 9/2')
    expect(m.provenance.tone).toBe('amber')
    expect(m.provenance.warning).toBeNull() // 6 days old
  })
  it('the same close from the live feed prices identically with NO chip', () => {
    const m = markOpenPosition({ position: shortCotton, quote: liveClose, today: '2026-09-08' })
    expect(m.unrealized).toBeCloseTo(1450, 6)
    expect(m.chip).toBeNull()
    expect(m.provenance.tone).toBe('neutral')
  })
  it('a long loses what the short gains; a stale manual quote escalates the chip', () => {
    const long = markOpenPosition({ position: { ...shortCotton, side: 'long' }, quote: manualClose, today: '2026-10-15' })
    expect(long.unrealized).toBeCloseTo(-1450, 6)
    expect(long.provenance.tone).toBe('red') // 43 days
    expect(long.chip).toBe('manual · 9/2')
  })
  it('no quote → null P&L, no chip', () => {
    const m = markOpenPosition({ position: shortCotton, quote: null })
    expect(m.currentPrice).toBeNull()
    expect(m.unrealized).toBeNull()
    expect(m.chip).toBeNull()
  })
  it('grain: short 3 ZCZ26 at 4.60 vs 4.50 = $0.10 × 5,000 × 3 = $1,500', () => {
    const m = markOpenPosition({
      position: { side: 'short', trade_price: 4.6, num_contracts: 3, commodity: 'Corn', contract_symbol: 'ZCZ26' },
      quote: { symbol: 'ZCZ26', price: 4.5, priceDate: '2026-09-08', stale: false, source: 'live', enteredAt: null },
    })
    expect(m.unrealized).toBeCloseTo(1500, 6)
  })
})

describe('sumUnrealized never hides a missing quote', () => {
  it('totals priced rows and counts the unpriced ones', () => {
    const priced = markOpenPosition({ position: shortCotton, quote: manualClose, today: '2026-09-08' })
    const unpriced = markOpenPosition({ position: shortCotton, quote: null })
    const sum = sumUnrealized([priced, unpriced, priced])
    expect(sum.total).toBeCloseTo(2900, 6)
    expect(sum.unpriced).toBe(1)
  })
})
