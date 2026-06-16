import { describe, it, expect } from 'vitest'
import {
  cropToCommodity,
  contractMonthOptionsForCrop,
  cashFromFuturesBasis,
  futuresFromCashBasis,
  basisFromCashFutures,
  pricingStatusFor,
  effectiveContractType,
  CONTRACT_TYPE_LABEL,
  PRICING_STATUS_LABEL,
} from '@/lib/contracts'

// ---------------------------------------------------------------------------
// Pricing identity:  cash = futures + basis − service_fee
// The three solvers are exact algebraic rearrangements of that one identity:
//   cash    = futures + basis − fee
//   futures = cash − basis + fee
//   basis   = cash − futures + fee
// All round to 6 decimals (round6). Use toBeCloseTo for the float-y cases.
// ---------------------------------------------------------------------------

describe('pricing identity: cash = futures + basis − fee', () => {
  it('cashFromFuturesBasis with POSITIVE basis ("over"), no fee', () => {
    // futures 4.50, basis +0.20 → cash = 4.50 + 0.20 − 0 = 4.70
    expect(cashFromFuturesBasis(4.5, 0.2)).toBeCloseTo(4.7, 6)
  })

  it('cashFromFuturesBasis with NEGATIVE basis ("under"), no fee', () => {
    // futures 4.50, basis −0.35 → cash = 4.50 + (−0.35) − 0 = 4.15
    expect(cashFromFuturesBasis(4.5, -0.35)).toBeCloseTo(4.15, 6)
  })

  it('cashFromFuturesBasis subtracts the service fee', () => {
    // futures 11.20, basis −0.40, fee 0.03 → 11.20 − 0.40 − 0.03 = 10.77
    expect(cashFromFuturesBasis(11.2, -0.4, 0.03)).toBeCloseTo(10.77, 6)
  })

  it('cashFromFuturesBasis defaults fee to 0', () => {
    // futures 6.00, basis +0.10, fee omitted → 6.10
    expect(cashFromFuturesBasis(6, 0.1)).toBeCloseTo(6.1, 6)
  })

  it('futuresFromCashBasis inverts with POSITIVE basis', () => {
    // cash 4.70, basis +0.20, no fee → futures = 4.70 − 0.20 + 0 = 4.50
    expect(futuresFromCashBasis(4.7, 0.2)).toBeCloseTo(4.5, 6)
  })

  it('futuresFromCashBasis inverts with NEGATIVE basis ("under")', () => {
    // cash 4.15, basis −0.35, no fee → futures = 4.15 − (−0.35) + 0 = 4.50
    expect(futuresFromCashBasis(4.15, -0.35)).toBeCloseTo(4.5, 6)
  })

  it('futuresFromCashBasis adds the service fee back', () => {
    // cash 10.77, basis −0.40, fee 0.03 → futures = 10.77 + 0.40 + 0.03 = 11.20
    expect(futuresFromCashBasis(10.77, -0.4, 0.03)).toBeCloseTo(11.2, 6)
  })

  it('basisFromCashFutures derives POSITIVE basis', () => {
    // cash 4.70, futures 4.50, no fee → basis = 4.70 − 4.50 + 0 = +0.20
    expect(basisFromCashFutures(4.7, 4.5)).toBeCloseTo(0.2, 6)
  })

  it('basisFromCashFutures derives NEGATIVE basis ("under")', () => {
    // cash 4.15, futures 4.50, no fee → basis = 4.15 − 4.50 + 0 = −0.35
    expect(basisFromCashFutures(4.15, 4.5)).toBeCloseTo(-0.35, 6)
  })

  it('basisFromCashFutures adds the service fee back', () => {
    // cash 10.77, futures 11.20, fee 0.03 → basis = 10.77 − 11.20 + 0.03 = −0.40
    expect(basisFromCashFutures(10.77, 11.2, 0.03)).toBeCloseTo(-0.4, 6)
  })

  it('the three solvers are mutually consistent (round-trip)', () => {
    const futures = 4.9325
    const basis = -0.4
    const fee = 0.015
    // cash = 4.9325 − 0.4 − 0.015 = 4.5175
    const cash = cashFromFuturesBasis(futures, basis, fee)
    expect(cash).toBeCloseTo(4.5175, 6)
    // recover futures and basis from the derived cash
    expect(futuresFromCashBasis(cash, basis, fee)).toBeCloseTo(futures, 6)
    expect(basisFromCashFutures(cash, futures, fee)).toBeCloseTo(basis, 6)
  })

  it('round6 clamps float noise (0.1 + 0.2 style)', () => {
    // 4.1 + 0.2 = 4.300000000000001 in IEEE-754; round6 must return exactly 4.3
    expect(cashFromFuturesBasis(4.1, 0.2)).toBe(4.3)
  })
})

// ---------------------------------------------------------------------------
// pricingStatusFor: which legs being set make a contract fully priced.
//   forward → always fully_priced (both legs implied)
//   hta     → futures locked at signing; fully_priced once basis is set,
//             otherwise awaiting_basis  (futures leg is ignored)
//   basis   → basis locked at signing; fully_priced once futures is set,
//             otherwise awaiting_futures (basis leg is ignored)
// ---------------------------------------------------------------------------

describe('pricingStatusFor', () => {
  it('forward is always fully_priced (both legs null)', () => {
    expect(pricingStatusFor('forward', { futures: null, basis: null })).toBe('fully_priced')
  })

  it('forward is fully_priced even with both legs set', () => {
    expect(pricingStatusFor('forward', { futures: 4.5, basis: -0.2 })).toBe('fully_priced')
  })

  it('hta awaiting_basis when basis is null', () => {
    expect(pricingStatusFor('hta', { futures: 4.5, basis: null })).toBe('awaiting_basis')
  })

  it('hta fully_priced once basis is set (incl. negative basis)', () => {
    expect(pricingStatusFor('hta', { futures: 4.5, basis: -0.3 })).toBe('fully_priced')
  })

  it('hta treats basis 0 as set (not null) → fully_priced', () => {
    // 0 != null, so a literal zero basis counts as priced
    expect(pricingStatusFor('hta', { futures: 4.5, basis: 0 })).toBe('fully_priced')
  })

  it('hta only cares about basis, not futures (futures null still resolves via basis)', () => {
    expect(pricingStatusFor('hta', { futures: null, basis: -0.3 })).toBe('fully_priced')
  })

  it('basis awaiting_futures when futures is null', () => {
    expect(pricingStatusFor('basis', { futures: null, basis: -0.25 })).toBe('awaiting_futures')
  })

  it('basis fully_priced once futures is set', () => {
    expect(pricingStatusFor('basis', { futures: 4.6, basis: -0.25 })).toBe('fully_priced')
  })

  it('basis treats futures 0 as set (not null) → fully_priced', () => {
    expect(pricingStatusFor('basis', { futures: 0, basis: -0.25 })).toBe('fully_priced')
  })
})

// ---------------------------------------------------------------------------
// effectiveContractType: a contract priced on BOTH futures and basis is a
// standard forward, regardless of how it was first entered (HTA → basis added,
// or basis → futures added). Otherwise the stored type stands.
// ---------------------------------------------------------------------------

describe('effectiveContractType', () => {
  it('basis contract + futures added → forward (the Woodall case)', () => {
    expect(effectiveContractType({ contract_type: 'basis', futures_price: 4.6, basis: -0.25 })).toBe('forward')
  })

  it('HTA + basis added → forward', () => {
    expect(effectiveContractType({ contract_type: 'hta', futures_price: 4.5, basis: -0.3 })).toBe('forward')
  })

  it('HTA still awaiting basis (futures only) stays HTA', () => {
    expect(effectiveContractType({ contract_type: 'hta', futures_price: 4.5, basis: null })).toBe('hta')
  })

  it('basis still awaiting futures (basis only) stays basis', () => {
    expect(effectiveContractType({ contract_type: 'basis', futures_price: null, basis: -0.25 })).toBe('basis')
  })

  it('flat-cash forward (neither leg) stays forward', () => {
    expect(effectiveContractType({ contract_type: 'forward', futures_price: null, basis: null })).toBe('forward')
  })

  it('both legs at zero still count as set → forward', () => {
    expect(effectiveContractType({ contract_type: 'basis', futures_price: 0, basis: 0 })).toBe('forward')
  })

  it('null stored type with both legs → forward', () => {
    expect(effectiveContractType({ contract_type: null, futures_price: 4.5, basis: -0.2 })).toBe('forward')
  })
})

// ---------------------------------------------------------------------------
// cropToCommodity: crops-table name → traded futures commodity, else null.
// Matching is case-insensitive substring (corn / soybean / wheat) plus the
// soybean aliases "beans" and "soy". Anything else (Canola) → null.
// ---------------------------------------------------------------------------

describe('cropToCommodity', () => {
  it('Corn → Corn', () => {
    expect(cropToCommodity('Corn')).toBe('Corn')
  })

  it('Soybean → Soybeans', () => {
    expect(cropToCommodity('Soybean')).toBe('Soybeans')
  })

  it('Soybeans → Soybeans', () => {
    expect(cropToCommodity('Soybeans')).toBe('Soybeans')
  })

  it('Wheat → Chicago Wheat', () => {
    expect(cropToCommodity('Wheat')).toBe('Chicago Wheat')
  })

  it('is case-insensitive (CORN, corn)', () => {
    expect(cropToCommodity('CORN')).toBe('Corn')
    expect(cropToCommodity('corn')).toBe('Corn')
  })

  it('trims surrounding whitespace', () => {
    expect(cropToCommodity('  Soybeans  ')).toBe('Soybeans')
  })

  it('matches substrings (e.g. "Yellow Corn", "Winter Wheat")', () => {
    expect(cropToCommodity('Yellow Corn')).toBe('Corn')
    expect(cropToCommodity('Winter Wheat')).toBe('Chicago Wheat')
  })

  it('soybean aliases "beans" and "soy" map to Soybeans', () => {
    expect(cropToCommodity('beans')).toBe('Soybeans')
    expect(cropToCommodity('soy')).toBe('Soybeans')
  })

  it('unmapped crop (Canola) → null', () => {
    expect(cropToCommodity('Canola')).toBeNull()
  })

  it('empty / null / undefined → null', () => {
    expect(cropToCommodity('')).toBeNull()
    expect(cropToCommodity('   ')).toBeNull()
    expect(cropToCommodity(null)).toBeNull()
    expect(cropToCommodity(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// contractMonthOptionsForCrop: deterministic with a fixed `from` date.
// Fixed date: 2026-06-10 (June = month 6, code 'M').
//
// For a TRADED crop it defers to hedging.contractMonthOptions, which keeps only
// months whose code is in the commodity's delivery cycle AND at/after the start
// month, over i = 0..24.
//   Corn cycle = H(Mar) K(May) N(Jul) U(Sep) Z(Dec).
//   Walking Jun-2026 .. Jun-2028 and keeping cycle months:
//     JUL26(N) SEP26(U) DEC26(Z) MAR27(H) MAY27(K) JUL27(N) SEP27(U)
//     DEC27(Z) MAR28(H) MAY28(K)  → 10 options, first label "JUL 26".
//
// For an UNMAPPED crop (Canola) it returns EVERY month for 24 months ahead,
// i = 0..24 inclusive → 25 options, first label "JUN 26", code ''.
// ---------------------------------------------------------------------------

describe('contractMonthOptionsForCrop', () => {
  const FROM = new Date(2026, 5, 10) // 2026-06-10, local time, month index 5 = June

  it('Corn returns only delivery-cycle months at/after the start month', () => {
    const opts = contractMonthOptionsForCrop('Corn', FROM)
    expect(opts).toHaveLength(10)
    expect(opts[0].label).toBe('JUL 26')
    expect(opts[0].monthNum).toBe(7)
    expect(opts[0].year).toBe(2026)
    expect(opts[0].code).toBe('N')
    // Every returned code is in the corn delivery cycle
    const cycle = new Set(['H', 'K', 'N', 'U', 'Z'])
    expect(opts.every((o) => cycle.has(o.code))).toBe(true)
    // Chronological order (year*100 + month strictly increasing)
    const keys = opts.map((o) => o.year * 100 + o.monthNum)
    expect(keys).toEqual([...keys].sort((a, b) => a - b))
    // Last option is MAY 28 (K)
    expect(opts[opts.length - 1].label).toBe('MAY 28')
    expect(opts[opts.length - 1].code).toBe('K')
  })

  it('Soybeans uses its own (wider) delivery cycle', () => {
    // Soybean cycle = F H K N Q U X. Code 'M' (June) is excluded, so the first
    // option from Jun-2026 is JUL 26 (N).
    const opts = contractMonthOptionsForCrop('Soybeans', FROM)
    const cycle = new Set(['F', 'H', 'K', 'N', 'Q', 'U', 'X'])
    expect(opts.length).toBeGreaterThan(0)
    expect(opts.every((o) => cycle.has(o.code))).toBe(true)
    expect(opts[0].label).toBe('JUL 26')
    expect(opts[0].code).toBe('N')
  })

  it('unmapped crop (Canola) returns every month for 24 months ahead, code ""', () => {
    const opts = contractMonthOptionsForCrop('Canola', FROM)
    // i = 0..24 inclusive → 25 entries
    expect(opts).toHaveLength(25)
    // First entry is the start month itself, June 2026
    expect(opts[0].label).toBe('JUN 26')
    expect(opts[0].monthNum).toBe(6)
    expect(opts[0].year).toBe(2026)
    // The fallback path leaves the futures code blank
    expect(opts.every((o) => o.code === '')).toBe(true)
    // 24 months after June 2026 is June 2028
    expect(opts[opts.length - 1].label).toBe('JUN 28')
    expect(opts[opts.length - 1].monthNum).toBe(6)
    expect(opts[opts.length - 1].year).toBe(2028)
  })

  it('null crop name falls through to the unmapped 25-month list', () => {
    const opts = contractMonthOptionsForCrop(null, FROM)
    expect(opts).toHaveLength(25)
    expect(opts[0].label).toBe('JUN 26')
    expect(opts.every((o) => o.code === '')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Label maps — small but they drive the UI, so pin the exact strings.
// ---------------------------------------------------------------------------

describe('label constants', () => {
  it('CONTRACT_TYPE_LABEL', () => {
    expect(CONTRACT_TYPE_LABEL).toEqual({ forward: 'Forward', hta: 'HTA', basis: 'Basis' })
  })

  it('PRICING_STATUS_LABEL', () => {
    expect(PRICING_STATUS_LABEL).toEqual({
      fully_priced: 'Fully priced',
      awaiting_basis: 'Awaiting basis',
      awaiting_futures: 'Awaiting futures',
    })
  })
})
