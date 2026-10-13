import { describe, expect, it } from 'vitest'
import { deliveryFuturesSymbol, impliedBuyerBasis, resolveSpotPrice, spotPriceChip, spotSummary, firstNoticeDay } from '@/lib/spot-price'
import type { LoadSale, SaleAllocation } from '@/lib/load-sales'

// FIXTURE futures values (not real quotes): ZSX26 closed 13.55 on 9/25 and
// 13.20 on 9/28. Bunge paid 13.74 spot on 9/25 → implied basis +0.19; the
// 9/28 load therefore estimates at 13.20 + 0.19 = 13.39.

describe('deliveryFuturesSymbol — the month an elevator bids off', () => {
  it('first notice day is the last calendar day of the month before delivery', () => {
    expect(firstNoticeDay(11, 2026).toISOString().slice(0, 10)).toBe('2026-10-31')
  })
  it('a 9/28 soybean delivery bids off NOV (ZSX26); on Nov 5 NOV is in notice, so JAN (ZSF27)', () => {
    expect(deliveryFuturesSymbol('Soybean', '2026-09-28')).toMatchObject({ symbol: 'ZSX26', contractMonth: 'NOV 26' })
    expect(deliveryFuturesSymbol('Soybeans', '2026-11-05')).toMatchObject({ symbol: 'ZSF27', contractMonth: 'JAN 27' })
    expect(deliveryFuturesSymbol('Soybean', '2026-10-31')).toMatchObject({ symbol: 'ZSF27' }) // FND itself is not "after"
  })
  it('corn in late September bids off DEC; wheat in June bids off JUL; canola has no future', () => {
    expect(deliveryFuturesSymbol('Corn', '2026-09-28')!.symbol).toBe('ZCZ26')
    expect(deliveryFuturesSymbol('Wheat', '2026-06-10')!.symbol).toBe('ZWN26')
    expect(deliveryFuturesSymbol('Canola', '2026-09-28')).toBeNull()
  })
})

describe('impliedBuyerBasis', () => {
  const hist = [
    { date: '2026-09-25', settledPrice: 13.74, futuresSettle: 13.55 },
    { date: '2026-09-25', settledPrice: 13.74, futuresSettle: 13.55 },
    { date: '2026-08-01', settledPrice: 12.9, futuresSettle: 12.5 },
  ]
  it('averages the settled loads within 30 days of the delivery', () => {
    const b = impliedBuyerBasis(hist, '2026-09-28')!
    expect(b.basis).toBeCloseTo(0.19, 6)
    expect(b.count).toBe(2)
  })
  it('falls back to the latest settled load when none are within 30 days; null with no history', () => {
    const b = impliedBuyerBasis([hist[2]], '2026-09-28')!
    expect(b.basis).toBeCloseTo(0.4, 6)
    expect(b.count).toBe(1)
    expect(impliedBuyerBasis([], '2026-09-28')).toBeNull()
    // Loads delivered AFTER the date in question never inform it.
    expect(impliedBuyerBasis([{ date: '2026-10-05', settledPrice: 14, futuresSettle: 13 }], '2026-09-28')).toBeNull()
  })
})

describe('resolveSpotPrice — settlement > entered > estimate', () => {
  const est = { futures: { price: 13.2, symbol: 'ZSX26', priceDate: '2026-09-28', isToday: false }, buyerBasis: { basis: 0.19, count: 4, dates: ['2026-09-25'] }, assumedBasis: -0.4, buyerName: 'Bunge' }
  it('the settlement always wins', () => {
    const d = resolveSpotPrice({ settlementPrice: 13.38, enteredBid: 13.74, estimate: est })
    expect(d).toMatchObject({ price: 13.38, source: 'settlement', label: 'settled $13.38' })
  })
  it('a typed bid beats the estimate', () => {
    expect(resolveSpotPrice({ enteredBid: 13.74, estimate: est })).toMatchObject({ price: 13.74, source: 'entered', label: 'your bid $13.74' })
  })
  it('the estimate = the delivery-date settle + the buyer\'s implied basis, and says so', () => {
    const d = resolveSpotPrice({ estimate: est })
    expect(d.price).toBeCloseTo(13.39, 6)
    expect(d).toMatchObject({ source: 'estimate', est_futures_price: 13.2, est_futures_symbol: 'ZSX26', est_basis: 0.19, basisSource: 'buyer', usedTodaysFutures: false })
    expect(d.label).toBe('est. $13.39 (ZSX26 9/28 close + Bunge basis +0.19)')
  })
  it('no buyer history → the crop\'s assumed basis', () => {
    const d = resolveSpotPrice({ estimate: { ...est, buyerBasis: null } })
    expect(d.price).toBeCloseTo(12.8, 6)
    expect(d.basisSource).toBe('assumed')
    expect(d.label).toBe('est. $12.80 (ZSX26 9/28 close + assumed basis −0.40)')
  })
  it('no historical settle → today\'s quote, labelled', () => {
    const d = resolveSpotPrice({ estimate: { ...est, futures: { price: 13.0, symbol: 'ZSX26', priceDate: '2026-10-13', isToday: true } } })
    expect(d.price).toBeCloseTo(13.19, 6)
    expect(d.usedTodaysFutures).toBe(true)
    expect(d.label).toBe("est. $13.19 (today's futures + Bunge basis +0.19)")
  })
  it('nothing to go on → no price', () => {
    expect(resolveSpotPrice({})).toMatchObject({ price: null, source: null })
    expect(resolveSpotPrice({ estimate: { futures: null, buyerBasis: null, assumedBasis: 0 } }).price).toBeNull()
  })
})

function spot(id: string, bushels: number, price: number | null, source: LoadSale['spot_price_source'], fut: number | null = null): SaleAllocation {
  return {
    loadId: id, saleType: 'spot', contractId: null, share: 1, bushels,
    sale: { id: `s-${id}`, load_id: id, sale_type: 'spot', contract_id: null, share: 1, buyer_net_bushels: null, spot_price: price, spot_price_source: source, est_futures_price: fut, est_futures_symbol: fut != null ? 'ZSX26' : null, est_basis: fut != null && price != null ? price - fut : null, settlement_line_id: null },
  }
}

describe('spotSummary — the spot contract\'s weighted average', () => {
  it('before the settlement: four typed 13.74 bids + the 9/28 load estimated at 13.39', () => {
    const s = spotSummary([
      spot('a', 912.744, 13.74, 'entered'), spot('b', 959.926, 13.74, 'entered'), spot('c', 1026, 13.74, 'entered'), spot('d', 951, 13.74, 'entered'),
      spot('e', 944.23, 13.39, 'estimate', 13.2),
    ])
    expect(s.bushels).toBeCloseTo(4793.9, 6)
    expect(s.revenue).toBeCloseTo(65537.7055, 4)
    expect(s.avgPrice).toBeCloseTo(13.671062, 6)
    expect(s.statusText).toBe('0 of 5 settled · est. on 1 · your bid on 4')
    expect(s.futures).toBeNull() // not every priced row carries a futures settle
  })
  it('after the settlement: all five settled, 65,528.26320 / 4,793.900 = 13.669093', () => {
    const s = spotSummary([
      spot('a', 912.744, 13.74, 'settlement'), spot('b', 959.926, 13.74, 'settlement'), spot('c', 1026, 13.74, 'settlement'), spot('d', 951, 13.74, 'settlement'),
      spot('e', 944.23, 13.38, 'settlement'),
    ])
    expect(s.revenue).toBeCloseTo(65528.2632, 4)
    expect(s.avgPrice).toBeCloseTo(13.669093, 6)
    expect(s.settledCount).toBe(5)
    expect(s.statusText).toBe('5 of 5 settled')
  })
  it('when every priced row carries a futures settle the summary offers weighted futures + basis', () => {
    const s = spotSummary([spot('a', 1000, 13.74, 'settlement', 13.55), spot('b', 1000, 13.38, 'settlement', 13.2)])
    expect(s.futures).toEqual({ bushels: 2000, avgFutures: 13.375, avgBasis: 0.185 })
  })
  it('unpriced rows count in bushels but not in the average', () => {
    const s = spotSummary([spot('a', 1000, 13.74, 'settlement'), spot('b', 500, null, null)])
    expect(s.bushels).toBe(1500)
    expect(s.unpricedBushels).toBe(500)
    expect(s.avgPrice).toBeCloseTo(13.74, 6)
    expect(s.statusText).toBe('1 of 2 settled · 1 unpriced')
  })
})

describe('spotPriceChip', () => {
  it('reads the stored row', () => {
    const base = { spot_price: 13.39, spot_price_source: 'estimate' as const, est_futures_price: 13.2, est_futures_symbol: 'ZSX26', est_basis: 0.19 }
    expect(spotPriceChip(base, 'Bunge')).toBe('est. $13.39 (ZSX26 close + Bunge basis +0.19)')
    expect(spotPriceChip({ ...base, spot_price: 13.74, spot_price_source: 'settlement' })).toBe('settled $13.74')
    expect(spotPriceChip({ ...base, spot_price: 13.74, spot_price_source: 'entered' })).toBe('your bid $13.74')
    expect(spotPriceChip({ ...base, spot_price: null, spot_price_source: null })).toBe('no price yet')
  })
})
