import { describe, it, expect } from 'vitest'
import {
  parsePrice,
  roundPrice,
  parseFractional,
  bushelsFor,
  unrealizedPnl,
  realizedPnl,
  optionPremiumTotal,
  optionUnrealizedPnl,
  optionOffsetPnl,
  optionFullPremiumPnl,
  exerciseFuturesSide,
  buildContractSymbol,
  parseContractMonth,
  monthCodeFor,
  contractMonthSortKey,
  normalizeOptionType,
  normalizeCommodity,
  expandClosedGroup,
  reconcileClosedGroup,
  CONTRACT_SIZE_BU,
} from '@/lib/hedging'

// All expected values below are hand-derived from the formulas/comments in
// lib/hedging.ts, NOT copied from function output. CBOT grains are 5,000-bu
// contracts (CONTRACT_SIZE_BU). Prices are $/bu; option premiums are cents/bu.
//
// Sign conventions taken straight from the source:
//   futures: SHORT perBu = entry - exit ; LONG perBu = exit - entry
//   options offset: BUY perBu = closeCents - premiumCents ; SELL perBu = premium - close
//   options full premium (expire/exercise): BUY = -premiumTotal (cost), SELL = +premiumTotal (income)
// realizedPnl/optionOffsetPnl/optionFullPremiumPnl subtract `commission`.

// Sanity-check the constant the worked examples lean on.
describe('CONTRACT_SIZE_BU', () => {
  it('is 5,000 bushels', () => {
    expect(CONTRACT_SIZE_BU).toBe(5000)
  })
})

// ---------- Fractional-cent price parsing ----------
describe('parsePrice - dollars + fractional cents', () => {
  it('"4.93 1/4" -> 4.9325 (1/4 cent = 0.0025)', () => {
    // 4.93 + (1/4)*0.01 = 4.93 + 0.0025 = 4.9325
    expect(parsePrice('4.93 1/4')).toBeCloseTo(4.9325, 6)
  })

  it('"11.09" -> 11.09 (plain decimal, no fraction)', () => {
    expect(parsePrice('11.09')).toBeCloseTo(11.09, 6)
  })

  it('plain whole/decimal numbers pass through (Number())', () => {
    expect(parsePrice('5')).toBeCloseTo(5, 6)
    expect(parsePrice('4.9325')).toBeCloseTo(4.9325, 6)
  })

  it('"11.43 1/2" -> 11.435 (1/2 cent = 0.005)', () => {
    // 11.43 + (1/2)*0.01 = 11.43 + 0.005 = 11.435
    expect(parsePrice('11.43 1/2')).toBeCloseTo(11.435, 6)
  })

  it('"4.93 3/4" -> 4.9375 (3/4 cent = 0.0075)', () => {
    // 4.93 + (3/4)*0.01 = 4.93 + 0.0075 = 4.9375
    expect(parsePrice('4.93 3/4')).toBeCloseTo(4.9375, 6)
  })

  it('bare fractional cents "3/4" -> 0.0075', () => {
    // (3/4)*0.01 = 0.0075
    expect(parsePrice('3/4')).toBeCloseTo(0.0075, 6)
  })

  it('trims surrounding whitespace', () => {
    expect(parsePrice('  4.93 1/4  ')).toBeCloseTo(4.9325, 6)
  })

  it('returns null for empty/blank/null input and bad denominators', () => {
    expect(parsePrice('')).toBeNull()
    expect(parsePrice('   ')).toBeNull()
    expect(parsePrice(null)).toBeNull()
    expect(parsePrice(undefined)).toBeNull()
    // den === 0 short-circuits to null in both fraction branches.
    expect(parsePrice('4.93 1/0')).toBeNull()
    expect(parsePrice('1/0')).toBeNull()
  })

  it('returns null for non-numeric garbage', () => {
    expect(parsePrice('abc')).toBeNull()
  })
})

describe('roundPrice', () => {
  it('clamps float noise to 6 decimals', () => {
    // 4.93 + 0.0025 can carry float noise; rounded to 1e-6.
    expect(roundPrice(4.93 + 0.0025)).toBeCloseTo(4.9325, 6)
    // 7th decimal rounds away.
    expect(roundPrice(1.23456749)).toBe(1.234567)
  })
})

// ---------- parseFractional (premiums in cents, fraction = fraction of a cent) ----------
describe('parseFractional - cents with whole-cent fractions', () => {
  it('"15 1/2" -> 15.5 (1/2 added directly, NOT /100)', () => {
    expect(parseFractional('15 1/2')).toBeCloseTo(15.5, 6)
  })

  it('"15.5" -> 15.5 and "15" -> 15', () => {
    expect(parseFractional('15.5')).toBeCloseTo(15.5, 6)
    expect(parseFractional('15')).toBeCloseTo(15, 6)
  })

  it('bare fraction "3/4" -> 0.75', () => {
    expect(parseFractional('3/4')).toBeCloseTo(0.75, 6)
  })

  it('returns null for blank/null and zero denominator', () => {
    expect(parseFractional('')).toBeNull()
    expect(parseFractional(null)).toBeNull()
    expect(parseFractional('5 1/0')).toBeNull()
  })
})

// ---------- bushelsFor ----------
describe('bushelsFor', () => {
  it('contracts * 5000 by default', () => {
    expect(bushelsFor(3)).toBe(15000)
  })
  it('honors an explicit contract size', () => {
    expect(bushelsFor(2, 1000)).toBe(2000)
  })
})

// ---------- Futures unrealized (mark-to-market) ----------
describe('unrealizedPnl - mark-to-market', () => {
  it('SHORT gains when current price falls', () => {
    // SHORT 2 @ 4.50, mark 4.20: perBu = 4.50 - 4.20 = 0.30
    // 0.30 * 2 * 5000 = 3,000
    const v = unrealizedPnl({ side: 'short', tradePrice: 4.5, currentPrice: 4.2, numContracts: 2 })
    expect(v).toBeCloseTo(3000, 6)
  })

  it('LONG gains when current price rises', () => {
    // LONG 4 @ 11.00, mark 11.25: perBu = 11.25 - 11.00 = 0.25
    // 0.25 * 4 * 5000 = 5,000
    const v = unrealizedPnl({ side: 'long', tradePrice: 11.0, currentPrice: 11.25, numContracts: 4 })
    expect(v).toBeCloseTo(5000, 6)
  })

  it('LONG loses when current price falls (negative sign)', () => {
    // LONG 1 @ 5.00, mark 4.90: perBu = 4.90 - 5.00 = -0.10
    // -0.10 * 1 * 5000 = -500
    const v = unrealizedPnl({ side: 'long', tradePrice: 5.0, currentPrice: 4.9, numContracts: 1 })
    expect(v).toBeCloseTo(-500, 6)
  })

  it('returns null when no current price is known', () => {
    expect(unrealizedPnl({ side: 'short', tradePrice: 4.5, currentPrice: null, numContracts: 2 })).toBeNull()
    expect(unrealizedPnl({ side: 'short', tradePrice: 4.5, currentPrice: undefined, numContracts: 2 })).toBeNull()
  })

  it('respects an explicit contract size', () => {
    // SHORT 1 @ 4.50, mark 4.40, size 1000: 0.10 * 1 * 1000 = 100
    const v = unrealizedPnl({ side: 'short', tradePrice: 4.5, currentPrice: 4.4, numContracts: 1, contractSizeBu: 1000 })
    expect(v).toBeCloseTo(100, 6)
  })
})

// ---------- Futures realized P&L ----------
describe('realizedPnl - closed futures (gross & net)', () => {
  it('SHORT closed lower = profit; gross = (entry-exit)*contracts*5000', () => {
    // SHORT 3 @ 4.80, closed @ 4.50: perBu = 4.80 - 4.50 = 0.30
    // gross = 0.30 * 3 * 5000 = 4,500
    // commission 90 total -> net = 4,500 - 90 = 4,410
    const r = realizedPnl({ side: 'short', tradePrice: 4.8, closePrice: 4.5, numContracts: 3, commission: 90 })
    expect(r.gross).toBeCloseTo(4500, 2)
    expect(r.net).toBeCloseTo(4410, 2)
  })

  it('LONG closed higher = profit; gross = (exit-entry)*contracts*5000', () => {
    // LONG 2 @ 11.00, closed @ 11.40: perBu = 11.40 - 11.00 = 0.40
    // gross = 0.40 * 2 * 5000 = 4,000
    // commission 60 -> net = 3,940
    const r = realizedPnl({ side: 'long', tradePrice: 11.0, closePrice: 11.4, numContracts: 2, commission: 60 })
    expect(r.gross).toBeCloseTo(4000, 2)
    expect(r.net).toBeCloseTo(3940, 2)
  })

  it('SHORT closed higher = loss (negative gross)', () => {
    // SHORT 1 @ 4.50, closed @ 4.65: perBu = 4.50 - 4.65 = -0.15
    // gross = -0.15 * 1 * 5000 = -750
    const r = realizedPnl({ side: 'short', tradePrice: 4.5, closePrice: 4.65, numContracts: 1 })
    expect(r.gross).toBeCloseTo(-750, 2)
    expect(r.net).toBeCloseTo(-750, 2) // no commission -> net == gross
  })

  it('LONG closed lower = loss; net subtracts commission', () => {
    // LONG 1 @ 5.00, closed @ 4.75: perBu = 4.75 - 5.00 = -0.25
    // gross = -0.25 * 1 * 5000 = -1,250 ; commission 20 -> net = -1,270
    const r = realizedPnl({ side: 'long', tradePrice: 5.0, closePrice: 4.75, numContracts: 1, commission: 20 })
    expect(r.gross).toBeCloseTo(-1250, 2)
    expect(r.net).toBeCloseTo(-1270, 2)
  })

  it('defaults commission to 0 (net == gross)', () => {
    // SHORT 2 @ 4.50, closed @ 4.4325: perBu = 0.0675 ; 0.0675*2*5000 = 675
    const r = realizedPnl({ side: 'short', tradePrice: 4.5, closePrice: 4.4325, numContracts: 2 })
    expect(r.gross).toBeCloseTo(675, 2)
    expect(r.net).toBeCloseTo(675, 2)
  })
})

// ---------- Closed offset groups: per-lot realized P&L ----------
// This is the failing-case regression suite. The statement prints ONE gross
// profit/loss per offset group; we must compute realized P&L PER LOT from each
// lot's own open price and the shared close price — never copy the group total
// onto a lot (which multiplied the gain). All values hand-derived:
//   short lot realized = (open - close) * contracts * 5000
//   long  lot realized = (close - open) * contracts * 5000
describe('expandClosedGroup - per-lot realized P&L', () => {
  it('three short DEC 26 corn lots closed at 4.4275 (the failing case)', () => {
    // close 4.4275, each lot 10 contracts, size 5000:
    //   lot1 open 4.9325 -> (4.9325-4.4275)=0.5050 * 10 * 5000 = 25,250
    //   lot2 open 4.8650 -> (4.8650-4.4275)=0.4375 * 10 * 5000 = 21,875
    //   lot3 open 4.9225 -> (4.9225-4.4275)=0.4950 * 10 * 5000 = 24,750
    //   sum = 71,875  (NOT 3 * 71,875 = 215,625)
    const lots = expandClosedGroup({
      commodity: 'Corn',
      contract_month: 'DEC 26',
      side: 'short',
      close_date: '2026-06-18',
      close_price: 4.4275,
      lots: [
        { open_date: '2026-03-09', open_price: 4.9325, contracts: 10 },
        { open_date: '2026-03-11', open_price: 4.865, contracts: 10 },
        { open_date: '2026-04-28', open_price: 4.9225, contracts: 10 },
      ],
    })
    expect(lots).toHaveLength(3)
    expect(lots[0].realized_pnl).toBeCloseTo(25250, 2)
    expect(lots[1].realized_pnl).toBeCloseTo(21875, 2)
    expect(lots[2].realized_pnl).toBeCloseTo(24750, 2)

    const sum = lots.reduce((s, l) => s + l.realized_pnl, 0)
    // Sum equals the statement total...
    expect(sum).toBeCloseTo(71875, 2)
    // ...and explicitly is NOT the bug's multiplied figure.
    expect(sum).not.toBeCloseTo(215625, 2)
    // No single lot carries the whole group total either.
    for (const l of lots) expect(l.realized_pnl).not.toBeCloseTo(71875, 2)

    // Each expanded lot carries its OWN open price/contracts + the shared close.
    expect(lots.map((l) => l.open_price)).toEqual([4.9325, 4.865, 4.9225])
    expect(lots.every((l) => l.close_price === 4.4275 && l.contracts === 10)).toBe(true)
  })

  it('single-lot single-close (short)', () => {
    // SHORT 1 lot, 5 contracts, open 4.80 -> close 4.50:
    //   (4.80-4.50)=0.30 * 5 * 5000 = 7,500
    const lots = expandClosedGroup({
      commodity: 'Corn',
      contract_month: 'JUL 26',
      side: 'short',
      close_date: '2026-06-10',
      close_price: 4.5,
      lots: [{ open_date: '2026-02-01', open_price: 4.8, contracts: 5 }],
    })
    expect(lots).toHaveLength(1)
    expect(lots[0].realized_pnl).toBeCloseTo(7500, 2)
  })

  it('partial close: close fewer contracts than the open lot holds', () => {
    // The open lot holds 20 contracts but only 8 are closed on this statement,
    // so the group lists contracts = 8 for the closing transaction:
    //   SHORT (4.50-4.40)=0.10 * 8 * 5000 = 4,000
    // (The realized math uses the CLOSED count, not the full holding.)
    const lots = expandClosedGroup({
      commodity: 'Corn',
      contract_month: 'DEC 26',
      side: 'short',
      close_date: '2026-06-18',
      close_price: 4.4,
      lots: [{ open_date: '2026-03-01', open_price: 4.5, contracts: 8 }],
    })
    expect(lots).toHaveLength(1)
    expect(lots[0].contracts).toBe(8)
    expect(lots[0].realized_pnl).toBeCloseTo(4000, 2)
  })

  it('long-side close uses (close - open)', () => {
    // LONG 5 contracts, open 11.00 -> close 11.40:
    //   (11.40-11.00)=0.40 * 5 * 5000 = 10,000
    const lots = expandClosedGroup({
      commodity: 'Soybeans',
      contract_month: 'NOV 26',
      side: 'long',
      close_date: '2026-09-15',
      close_price: 11.4,
      lots: [{ open_date: '2026-04-10', open_price: 11.0, contracts: 5 }],
    })
    expect(lots).toHaveLength(1)
    expect(lots[0].realized_pnl).toBeCloseTo(10000, 2)
  })

  it('honors an explicit contract size', () => {
    // SHORT 2 contracts, open 4.50 -> close 4.40, size 1000:
    //   0.10 * 2 * 1000 = 200
    const lots = expandClosedGroup({
      commodity: 'Corn',
      contract_month: 'DEC 26',
      side: 'short',
      close_date: '2026-06-18',
      close_price: 4.4,
      lots: [{ open_date: '2026-03-01', open_price: 4.5, contracts: 2 }],
      contractSizeBu: 1000,
    })
    expect(lots[0].realized_pnl).toBeCloseTo(200, 2)
  })
})

// ---------- Reconcile computed total vs the statement's printed total ----------
describe('reconcileClosedGroup', () => {
  it('the three-lot corn group ties to its statement_reported_total', () => {
    const lots = expandClosedGroup({
      commodity: 'Corn',
      contract_month: 'DEC 26',
      side: 'short',
      close_date: '2026-06-18',
      close_price: 4.4275,
      lots: [
        { open_date: '2026-03-09', open_price: 4.9325, contracts: 10 },
        { open_date: '2026-03-11', open_price: 4.865, contracts: 10 },
        { open_date: '2026-04-28', open_price: 4.9225, contracts: 10 },
      ],
    })
    const recon = reconcileClosedGroup(lots, 71875)
    expect(recon.computedTotal).toBeCloseTo(71875, 2)
    expect(recon.reportedTotal).toBe(71875)
    expect(recon.hasReportedTotal).toBe(true)
    expect(recon.diff).toBeCloseTo(0, 2)
    expect(recon.matches).toBe(true)
  })

  it('flags a mismatch beyond the $1 tolerance', () => {
    // computed 7,500 vs reported 7,000 -> diff 500, mismatch.
    const recon = reconcileClosedGroup([{ realized_pnl: 7500 }], 7000)
    expect(recon.diff).toBeCloseTo(500, 2)
    expect(recon.matches).toBe(false)
  })

  it('treats sub-$1 rounding noise as a match', () => {
    // computed 71,875 vs reported 71,874.40 -> diff 0.60 (<= 1) -> matches.
    const recon = reconcileClosedGroup([{ realized_pnl: 71875 }], 71874.4)
    expect(recon.matches).toBe(true)
  })

  it('no reported total -> nothing to compare, matches with hasReportedTotal=false', () => {
    const recon = reconcileClosedGroup([{ realized_pnl: 1234 }], null)
    expect(recon.computedTotal).toBeCloseTo(1234, 2)
    expect(recon.reportedTotal).toBeNull()
    expect(recon.hasReportedTotal).toBe(false)
    expect(recon.diff).toBeNull()
    expect(recon.matches).toBe(true)
  })
})

// ---------- Options premium math ----------
describe('optionPremiumTotal', () => {
  it('total = cents/100 * contracts * 5000', () => {
    // 25 cents, 2 contracts: (25/100)*2*5000 = 0.25*10000 = 2,500
    expect(optionPremiumTotal(25, 2)).toBeCloseTo(2500, 2)
  })

  it('fractional cents: 32.5c on 1 contract = $1,625', () => {
    // (32.5/100)*1*5000 = 0.325*5000 = 1,625
    expect(optionPremiumTotal(32.5, 1)).toBeCloseTo(1625, 2)
  })

  it('honors explicit contract size', () => {
    // (10/100)*1*1000 = 100
    expect(optionPremiumTotal(10, 1, 1000)).toBeCloseTo(100, 2)
  })
})

// ---------- Options unrealized (mark-to-market on premium) ----------
describe('optionUnrealizedPnl', () => {
  it('BUY gains when premium rises', () => {
    // bought @ 20c, now 35c: perBu = (35-20)/100 = 0.15
    // 0.15 * 1 * 5000 = 750
    const v = optionUnrealizedPnl({ side: 'buy', premiumCents: 20, currentCents: 35, numContracts: 1 })
    expect(v).toBeCloseTo(750, 2)
  })

  it('SELL (written) gains when premium falls', () => {
    // sold @ 30c, now 12c: perBu = (30-12)/100 = 0.18
    // 0.18 * 2 * 5000 = 1,800
    const v = optionUnrealizedPnl({ side: 'sell', premiumCents: 30, currentCents: 12, numContracts: 2 })
    expect(v).toBeCloseTo(1800, 2)
  })

  it('returns null when no current value', () => {
    expect(optionUnrealizedPnl({ side: 'buy', premiumCents: 20, currentCents: null, numContracts: 1 })).toBeNull()
  })
})

// ---------- Options offset (closed/traded back at a premium) ----------
describe('optionOffsetPnl - closed at a price', () => {
  it('BUY offset higher = profit (perBu = close - premium)', () => {
    // bought @ 18c, offset @ 30c, 2 contracts: perBu = (30-18)/100 = 0.12
    // gross = 0.12 * 2 * 5000 = 1,200 ; commission 40 -> 1,160
    const v = optionOffsetPnl({ side: 'buy', premiumCents: 18, closeCents: 30, numContracts: 2, commission: 40 })
    expect(v).toBeCloseTo(1160, 2)
  })

  it('SELL offset lower = profit (perBu = premium - close)', () => {
    // sold @ 40c, bought back @ 15c, 1 contract: perBu = (40-15)/100 = 0.25
    // gross = 0.25 * 1 * 5000 = 1,250 ; commission 0 -> 1,250
    const v = optionOffsetPnl({ side: 'sell', premiumCents: 40, closeCents: 15, numContracts: 1 })
    expect(v).toBeCloseTo(1250, 2)
  })

  it('BUY offset lower = loss', () => {
    // bought @ 30c, offset @ 10c, 1 contract: perBu = (10-30)/100 = -0.20
    // gross = -0.20 * 1 * 5000 = -1,000
    const v = optionOffsetPnl({ side: 'buy', premiumCents: 30, closeCents: 10, numContracts: 1 })
    expect(v).toBeCloseTo(-1000, 2)
  })
})

// ---------- Options expired worthless / exercised (full premium realized) ----------
describe('optionFullPremiumPnl - expired worthless / exercised', () => {
  it('BUY = the premium is a cost (negative), net of commission', () => {
    // bought 2 @ 25c -> premiumTotal = (25/100)*2*5000 = 2,500
    // signed = -2,500 ; commission 30 -> -2,530
    const v = optionFullPremiumPnl({ side: 'buy', premiumCents: 25, numContracts: 2, commission: 30 })
    expect(v).toBeCloseTo(-2530, 2)
  })

  it('SELL = the premium is income (positive), net of commission', () => {
    // sold 1 @ 40c -> premiumTotal = (40/100)*1*5000 = 2,000
    // signed = +2,000 ; commission 20 -> 1,980
    const v = optionFullPremiumPnl({ side: 'sell', premiumCents: 40, numContracts: 1, commission: 20 })
    expect(v).toBeCloseTo(1980, 2)
  })

  it('defaults commission to 0', () => {
    // BUY 1 @ 10c -> -(10/100)*1*5000 = -500
    expect(optionFullPremiumPnl({ side: 'buy', premiumCents: 10, numContracts: 1 })).toBeCloseTo(-500, 2)
  })
})

// ---------- Exercise -> futures side mapping ----------
describe('exerciseFuturesSide', () => {
  it('buy put -> short, buy call -> long', () => {
    expect(exerciseFuturesSide('put', 'buy')).toBe('short')
    expect(exerciseFuturesSide('call', 'buy')).toBe('long')
  })
  it('sell put -> long, sell call -> short', () => {
    expect(exerciseFuturesSide('put', 'sell')).toBe('long')
    expect(exerciseFuturesSide('call', 'sell')).toBe('short')
  })
})

// ---------- Contract month + symbol building ----------
describe('monthCodeFor', () => {
  it('maps month numbers to CBOT codes (Dec=Z, Mar=H, Jul=N)', () => {
    expect(monthCodeFor(12)).toBe('Z')
    expect(monthCodeFor(3)).toBe('H')
    expect(monthCodeFor(7)).toBe('N')
    expect(monthCodeFor(1)).toBe('F')
  })
  it('returns empty string for an out-of-range month', () => {
    expect(monthCodeFor(13)).toBe('')
    expect(monthCodeFor(0)).toBe('')
  })
})

describe('parseContractMonth', () => {
  it('parses "DEC 26" -> Dec/12/Z, year 2026', () => {
    const p = parseContractMonth('DEC 26')
    expect(p).not.toBeNull()
    expect(p!.abbr).toBe('DEC')
    expect(p!.monthNum).toBe(12)
    expect(p!.code).toBe('Z')
    expect(p!.year2).toBe(26)
    expect(p!.year4).toBe(2026)
  })
  it('parses 4-digit years "JUL 2027"', () => {
    const p = parseContractMonth('JUL 2027')
    expect(p!.monthNum).toBe(7)
    expect(p!.code).toBe('N')
    expect(p!.year2).toBe(27)
    expect(p!.year4).toBe(2027)
  })
  it('is case-insensitive and trims', () => {
    expect(parseContractMonth('  mar 26 ')!.code).toBe('H')
  })
  it('returns null for unknown month abbr or malformed input', () => {
    expect(parseContractMonth('XYZ 26')).toBeNull()
    expect(parseContractMonth('DEC')).toBeNull()
    expect(parseContractMonth('')).toBeNull()
    expect(parseContractMonth(null)).toBeNull()
  })
})

describe('buildContractSymbol', () => {
  it('Corn + "DEC 26" -> "ZCZ26"', () => {
    // ZC (corn root) + Z (Dec) + 26 (year2)
    expect(buildContractSymbol('Corn', 'DEC 26')).toBe('ZCZ26')
  })
  it('Soybeans + "NOV 26" -> "ZSX26" (Nov = X)', () => {
    expect(buildContractSymbol('Soybeans', 'NOV 26')).toBe('ZSX26')
  })
  it('Chicago Wheat + "JUL 27" -> "ZWN27"', () => {
    expect(buildContractSymbol('Chicago Wheat', 'JUL 27')).toBe('ZWN27')
  })
  it('zero-pads single-digit year2 (year 2005 -> "05")', () => {
    expect(buildContractSymbol('Corn', 'DEC 2005')).toBe('ZCZ05')
  })
  it('returns "" for an unknown commodity or unparseable month', () => {
    expect(buildContractSymbol('Cotton', 'DEC 26')).toBe('')
    expect(buildContractSymbol('Corn', 'nope')).toBe('')
  })
})

describe('contractMonthSortKey', () => {
  it('orders chronologically: year4*100 + monthNum', () => {
    // DEC 26 -> 2026*100 + 12 = 202612 ; MAR 27 -> 2027*100 + 3 = 202703
    expect(contractMonthSortKey('DEC 26')).toBe(202612)
    expect(contractMonthSortKey('MAR 27')).toBe(202703)
    expect(contractMonthSortKey('MAR 27')).toBeGreaterThan(contractMonthSortKey('DEC 26'))
  })
  it('sorts unparseable labels last', () => {
    expect(contractMonthSortKey('nope')).toBe(Number.MAX_SAFE_INTEGER)
  })
})

// ---------- Statement-import normalizers ----------
describe('normalizeOptionType', () => {
  it('detects put/call regardless of case/surrounding text', () => {
    expect(normalizeOptionType('PUT')).toBe('put')
    expect(normalizeOptionType('Corn Call Option')).toBe('call')
    expect(normalizeOptionType('future')).toBeNull()
    expect(normalizeOptionType(null)).toBeNull()
  })
})

describe('normalizeCommodity', () => {
  it('maps brokerage labels to canonical commodities', () => {
    expect(normalizeCommodity('CORN')).toBe('Corn')
    expect(normalizeCommodity('SOYBEANS')).toBe('Soybeans')
    expect(normalizeCommodity('BEANS')).toBe('Soybeans')
    expect(normalizeCommodity('WHEAT')).toBe('Chicago Wheat')
  })
  it('returns null for untracked commodities and empties', () => {
    expect(normalizeCommodity('COTTON')).toBeNull()
    expect(normalizeCommodity(null)).toBeNull()
  })
})
