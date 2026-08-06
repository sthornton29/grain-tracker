import { describe, it, expect } from 'vitest'
import {
  marketingReferenceContract,
  referenceMonthOptions,
  referenceExpiryDate,
  isExpired,
  fallForwardOnMissingQuote,
} from './reference-contract'
import { harvestContractSymbol } from './crop-insurance'

const AUG_6_2026 = new Date(2026, 7, 6)
const JAN_15_2027 = new Date(2027, 0, 15)

describe('referenceExpiryDate — business day preceding the 15th', () => {
  it('plain weekday: JUL 2026 expires Tue Jul 14', () => {
    const d = referenceExpiryDate(7, 2026)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 7, 14])
  })

  it('weekend rolls back to Friday: MAR 2027 (the 14th is a Sunday) expires Fri Mar 12', () => {
    const d = referenceExpiryDate(3, 2027)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2027, 3, 12])
    expect(d.getDay()).toBe(5)
  })

  it('still the reference ON the expiry day, rolled the day after', () => {
    expect(isExpired(7, 2026, new Date(2026, 6, 14))).toBe(false)
    expect(isExpired(7, 2026, new Date(2026, 6, 15))).toBe(true)
  })
})

describe('marketingReferenceContract — default + roll-forward', () => {
  it('wheat 2026 as of Aug 6 2026: JUL 26 expired → rolls to SEP 26 (ZWU26)', () => {
    const r = marketingReferenceContract('Wheat', 2026, AUG_6_2026)!
    expect(r.symbol).toBe('ZWU26')
    expect(r.contractMonth).toBe('SEP 26')
    expect(r.rolled).toBe(true)
    expect(r.benchmarkMonth).toBe('JUL 26')
    expect(r.overridden).toBe(false)
  })

  it('corn 2026 as of Aug 6 2026: DEC 26 still trading → ZCZ26 unchanged', () => {
    const r = marketingReferenceContract('Corn', 2026, AUG_6_2026)!
    expect(r.symbol).toBe('ZCZ26')
    expect(r.rolled).toBe(false)
  })

  it('soybeans 2026 as of Aug 6 2026: NOV 26 still trading → ZSX26', () => {
    const r = marketingReferenceContract('Soybean', 2026, AUG_6_2026)!
    expect(r.symbol).toBe('ZSX26')
    expect(r.rolled).toBe(false)
  })

  it('cotton 2026: DEC benchmark → CTZ26', () => {
    const r = marketingReferenceContract('Cotton', 2026, AUG_6_2026)!
    expect(r.symbol).toBe('CTZ26')
    expect(r.rolled).toBe(false)
  })

  it('corn 2026 as of Jan 2027: DEC 26 expired → rolls to MAR 27 (ZCH27)', () => {
    const r = marketingReferenceContract('Corn', 2026, JAN_15_2027)!
    expect(r.symbol).toBe('ZCH27')
    expect(r.contractMonth).toBe('MAR 27')
    expect(r.rolled).toBe(true)
  })

  it('wheat 2026 as of Oct 2026: SEP 26 also expired → DEC 26 (ZWZ26)', () => {
    const r = marketingReferenceContract('Wheat', 2026, new Date(2026, 9, 1))!
    expect(r.symbol).toBe('ZWZ26')
    expect(r.rolled).toBe(true)
  })

  it('returns null for a crop with no traded future', () => {
    expect(marketingReferenceContract('Canola', 2026, AUG_6_2026)).toBeNull()
  })
})

describe('marketingReferenceContract — user override', () => {
  it('a still-trading override wins over the resolver', () => {
    const r = marketingReferenceContract('Wheat', 2026, AUG_6_2026, 'DEC 26')!
    expect(r.symbol).toBe('ZWZ26')
    expect(r.overridden).toBe(true)
    expect(r.rolled).toBe(false)
  })

  it('an EXPIRED override is ignored — the resolver default applies (clean reset)', () => {
    const r = marketingReferenceContract('Wheat', 2026, AUG_6_2026, 'JUL 26')!
    expect(r.symbol).toBe('ZWU26')
    expect(r.overridden).toBe(false)
    expect(r.rolled).toBe(true)
  })

  it('a garbage override is ignored', () => {
    const r = marketingReferenceContract('Corn', 2026, AUG_6_2026, 'not-a-month')!
    expect(r.symbol).toBe('ZCZ26')
    expect(r.overridden).toBe(false)
  })

  it('null/empty override = resolver default', () => {
    expect(marketingReferenceContract('Corn', 2026, AUG_6_2026, null)!.symbol).toBe('ZCZ26')
    expect(marketingReferenceContract('Corn', 2026, AUG_6_2026, '')!.symbol).toBe('ZCZ26')
  })
})

describe('referenceMonthOptions — the selectable month list', () => {
  it('wheat 2026 as of Aug 6 2026: SEP 26, DEC 26, MAR 27, MAY 27, JUL 27', () => {
    const opts = referenceMonthOptions('Wheat', 2026, AUG_6_2026)
    expect(opts.map((o) => o.contractMonth)).toEqual(['SEP 26', 'DEC 26', 'MAR 27', 'MAY 27', 'JUL 27'])
    expect(opts.map((o) => o.symbol)).toEqual(['ZWU26', 'ZWZ26', 'ZWH27', 'ZWK27', 'ZWN27'])
    expect(opts.find((o) => o.isDefault)?.contractMonth).toBe('SEP 26')
  })

  it('corn 2026 as of Aug 6 2026 starts at the live benchmark and runs through DEC 27', () => {
    const opts = referenceMonthOptions('Corn', 2026, AUG_6_2026)
    expect(opts[0]).toMatchObject({ contractMonth: 'DEC 26', symbol: 'ZCZ26', isDefault: true })
    expect(opts[opts.length - 1]).toMatchObject({ contractMonth: 'DEC 27', symbol: 'ZCZ27' })
  })

  it('empty for crops with no traded future', () => {
    expect(referenceMonthOptions('Canola', 2026, AUG_6_2026)).toEqual([])
  })
})

describe('insurance harvest-price paths are untouched', () => {
  it('RMA discovery symbols stay put regardless of marketing roll state', () => {
    // Marketing wheat rolled to ZWU26, but the RMA wheat discovery contract is
    // SEP (ZWU) by its own rule and corn/beans stay DEC/NOV — the insurance
    // seam answers from HARVEST_MONTH_ABBR, not from the marketing resolver.
    expect(harvestContractSymbol('Wheat', 2026)).toBe('ZWU26')
    expect(harvestContractSymbol('Corn', 2026)).toBe('ZCZ26')
    expect(harvestContractSymbol('Soybean', 2026)).toBe('ZSX26')
    expect(harvestContractSymbol('Cotton', 2026)).toBe('CTZ26')
  })
})

describe('fallForwardOnMissingQuote — shared by every consumer', () => {
  const ref = marketingReferenceContract('Wheat', 2026, new Date(2026, 7, 6))! // ZWU26
  const opts = referenceMonthOptions('Wheat', 2026, new Date(2026, 7, 6))

  it('keeps the reference when its quote exists', () => {
    const eff = fallForwardOnMissingQuote(ref, opts, (s) => s === 'ZWU26', true)
    expect(eff.symbol).toBe('ZWU26')
  })

  it('falls to the next listed month that quoted when the reference did not', () => {
    const eff = fallForwardOnMissingQuote(ref, opts, (s) => s === 'ZWZ26' || s === 'ZWH27', true)
    expect(eff.symbol).toBe('ZWZ26')
    expect(eff.rolled).toBe(true)
  })

  it('a wholesale quote outage changes nothing', () => {
    const eff = fallForwardOnMissingQuote(ref, opts, () => false, false)
    expect(eff.symbol).toBe('ZWU26')
  })

  it('a user-pinned month never falls forward', () => {
    const pinned = marketingReferenceContract('Wheat', 2026, new Date(2026, 7, 6), 'DEC 26')!
    const eff = fallForwardOnMissingQuote(pinned, opts, (s) => s === 'ZWH27', true)
    expect(eff.symbol).toBe('ZWZ26')
    expect(eff.overridden).toBe(true)
  })
})
