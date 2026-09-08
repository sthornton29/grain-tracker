import { describe, it, expect } from 'vitest'
import {
  commodityForSymbol, fmtQuote, hasLiveCoverage, manualQuoteAgeDays, parseManualQuoteInput,
  quoteFromWire, quoteMapFromWire, quoteProvenance,
} from '@/lib/quotes'

// The quote shape every consumer reads, the manual-entry unit boundary, and
// the provenance chip's staleness ladder (7 days amber, 30 days red).

describe('manual cotton quote — unit round trip (¢ stored, $/lb displayed)', () => {
  it('0.7265 and 72.65 both land as 72.65¢ and display $0.7265', () => {
    expect(parseManualQuoteInput('Cotton', '0.7265')).toBe(72.65)
    expect(parseManualQuoteInput('Cotton', '72.65')).toBe(72.65)
    expect(fmtQuote('Cotton', 72.65)).toBe('$0.7265')
    expect(fmtQuote('Cotton', parseManualQuoteInput('Cotton', '0.7265'))).toBe('$0.7265')
  })
  it('a statement close of 78.30 stores 78.30¢ and shows $0.7830', () => {
    expect(parseManualQuoteInput('Cotton', '78.30')).toBe(78.3)
    expect(fmtQuote('Cotton', 78.3)).toBe('$0.7830')
  })
  it('grains store $/bu, accept fractional ticks, display $/bu', () => {
    expect(parseManualQuoteInput('Corn', '4.50')).toBe(4.5)
    expect(parseManualQuoteInput('Corn', '4.50 1/4')).toBe(4.5025)
    expect(fmtQuote('Corn', 4.5)).toBe('$4.50')
    expect(fmtQuote('Chicago Wheat', 5.7275)).toBe('$5.7275')
  })
  it('rejects blanks, junk, and non-positive prices', () => {
    expect(parseManualQuoteInput('Corn', '')).toBeNull()
    expect(parseManualQuoteInput('Corn', 'abc')).toBeNull()
    expect(parseManualQuoteInput('Corn', '0')).toBeNull()
    expect(parseManualQuoteInput('Cotton', '-72')).toBeNull()
  })
})

describe('symbols → commodity and live coverage', () => {
  it('maps the four traded roots; cotton has no live coverage', () => {
    expect(commodityForSymbol('CTZ26')).toBe('Cotton')
    expect(commodityForSymbol('ZCZ26')).toBe('Corn')
    expect(commodityForSymbol('ZSX26')).toBe('Soybeans')
    expect(commodityForSymbol('ZWN27')).toBe('Chicago Wheat')
    expect(commodityForSymbol('XX')).toBeNull()
    expect(hasLiveCoverage('ZCZ26')).toBe(true)
    expect(hasLiveCoverage('CTZ26')).toBe(false)
    expect(hasLiveCoverage(null)).toBe(false)
  })
})

describe('wire rows → Quote', () => {
  it('reads source and entered_at; a priceless row is no quote', () => {
    expect(quoteFromWire({ symbol: 'ctz26', price: 72.65, price_date: '2026-09-02', stale: true, source: 'manual', entered_at: '2026-09-02T14:00:00Z' }))
      .toEqual({ symbol: 'CTZ26', price: 72.65, priceDate: '2026-09-02', stale: true, source: 'manual', enteredAt: '2026-09-02T14:00:00Z' })
    expect(quoteFromWire({ symbol: 'ZCZ26', price: 4.5, price_date: '2026-09-08', stale: false })?.source).toBe('live')
    expect(quoteFromWire({ symbol: 'CTZ26', price: null, price_date: null, stale: true })).toBeNull()
    const m = quoteMapFromWire([{ symbol: 'ZCZ26', price: 4.5, price_date: '2026-09-08', stale: false }, { symbol: 'CTZ26', price: null, price_date: null, stale: true }])
    expect([...m.keys()]).toEqual(['ZCZ26'])
  })
})

describe('provenance chip and the staleness ladder', () => {
  const manual = (enteredAt: string) => ({ source: 'manual' as const, priceDate: enteredAt.slice(0, 10), enteredAt })
  it('a live quote carries no chip', () => {
    const p = quoteProvenance({ source: 'live', priceDate: '2026-09-08', enteredAt: null }, '2026-09-08')
    expect(p.chip).toBeNull()
    expect(p.tone).toBe('neutral')
    expect(p.warning).toBeNull()
  })
  it('a fresh manual quote: amber "manual · 9/2", no warning', () => {
    const p = quoteProvenance(manual('2026-09-02T14:00:00'), '2026-09-02')
    expect(p.chip).toBe('manual · 9/2')
    expect(p.tone).toBe('amber')
    expect(p.warning).toBeNull()
    expect(p.ageDays).toBe(0)
  })
  it('7 days is still fine; 8 days warns (amber, a week old)', () => {
    expect(quoteProvenance(manual('2026-09-01T09:00:00'), '2026-09-08').warning).toBeNull()
    const p = quoteProvenance(manual('2026-09-01T09:00:00'), '2026-09-09')
    expect(p.tone).toBe('amber')
    expect(p.warning).toMatch(/a week old \(8 days\)/)
  })
  it('30 days warns amber; 31 days turns red', () => {
    expect(quoteProvenance(manual('2026-08-09T09:00:00'), '2026-09-08').tone).toBe('amber')
    const p = quoteProvenance(manual('2026-08-08T09:00:00'), '2026-09-08')
    expect(p.tone).toBe('red')
    expect(p.warning).toMatch(/over a month old \(31 days\)/)
    expect(p.chip).toBe('manual · 8/8')
  })
  it('manualQuoteAgeDays counts calendar days and tolerates junk', () => {
    expect(manualQuoteAgeDays('2026-09-01T23:59:00', '2026-09-02')).toBe(1)
    expect(manualQuoteAgeDays(null)).toBeNull()
    expect(manualQuoteAgeDays('not a date', '2026-09-02')).toBeNull()
  })
})
