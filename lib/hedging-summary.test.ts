import { describe, expect, it } from 'vitest'
import { legHasActivity, summarizeByCropYear } from '@/lib/hedging-summary'

// The Hedging page's crop-year cards. A rolled hedge must read as ONE hedge:
// the 10/12/2026 roll of 23 DEC 26 cotton into 23 MAR 27 showed
// "46 contracts hedged" while the open-positions table said 23.

const qty = (commodity: string, n: number) => (commodity === 'Cotton' ? n * 50000 : n * 5000)

describe('summarizeByCropYear', () => {
  it('a rolled hedge counts once: 23 closed DEC + 23 open MAR → 23 hedged, 23 closed, realized once', () => {
    const futures = [
      { id: 'd10', crop_year: 2026, commodity: 'Cotton', status: 'closed', num_contracts: 10, trade_price: 72.65, realized: -39036.96 },
      { id: 'd13', crop_year: 2026, commodity: 'Cotton', status: 'closed', num_contracts: 13, trade_price: 84.4, realized: 25626.96 },
      { id: 'm3', crop_year: 2026, commodity: 'Cotton', status: 'open', num_contracts: 3, trade_price: 83.63, realized: 0 },
      { id: 'm12', crop_year: 2026, commodity: 'Cotton', status: 'open', num_contracts: 12, trade_price: 83.64, realized: 0 },
      { id: 'm3b', crop_year: 2026, commodity: 'Cotton', status: 'open', num_contracts: 3, trade_price: 83.65, realized: 0 },
      { id: 'm3c', crop_year: 2026, commodity: 'Cotton', status: 'open', num_contracts: 3, trade_price: 83.67, realized: 0 },
      { id: 'm2', crop_year: 2026, commodity: 'Cotton', status: 'open', num_contracts: 2, trade_price: 83.68, realized: 0 },
    ]
    const [s] = summarizeByCropYear({
      futures, options: [], quantityFor: qty,
      futuresUnrealized: () => null, futuresRealized: (p) => p.realized,
      optionUnrealized: () => null, optionRealized: () => 0, optionPremium: () => 0,
    })
    expect(s.cropYear).toBe(2026)
    expect(s.fut.contracts).toBe(23)
    expect(s.fut.quantity).toBe(1_150_000)
    expect(s.fut.priceWeight / s.fut.contracts).toBeCloseTo(83.64739, 5)
    expect(s.fut.closedContracts).toBe(23)
    expect(s.fut.realized).toBeCloseTo(-13410, 2)
    expect(s.fut.hasOpen).toBe(true)
  })

  it('corn: lifted and rolled lots are closed history; only the open MAR legs are hedged', () => {
    const futures = [
      { crop_year: 2026, commodity: 'Corn', status: 'closed', num_contracts: 30, trade_price: 4.9, r: 71875 },
      { crop_year: 2026, commodity: 'Corn', status: 'closed', num_contracts: 14, trade_price: 4.9525, r: -33775 },
      { crop_year: 2026, commodity: 'Corn', status: 'closed', num_contracts: 22, trade_price: 4.9, r: -80712.5 },
      { crop_year: 2026, commodity: 'Corn', status: 'open', num_contracts: 14, trade_price: 5.585, r: 0 },
      { crop_year: 2026, commodity: 'Corn', status: 'open', num_contracts: 12, trade_price: 5.4825, r: 0 },
    ]
    const [s] = summarizeByCropYear({
      futures, options: [], quantityFor: qty,
      futuresUnrealized: (p) => (p.status === 'open' ? 1000 : null), futuresRealized: (p) => p.r,
      optionUnrealized: () => null, optionRealized: () => 0, optionPremium: () => 0,
    })
    expect(s.fut.contracts).toBe(26)
    expect(s.fut.quantity).toBe(130_000)
    expect(s.fut.closedContracts).toBe(66)
    expect(s.fut.unrealized).toBe(2000)
    expect(s.fut.realized).toBeCloseTo(71875 - 33775 - 80712.5, 2)
  })

  it('a year with only closed hedges still shows (realized), and options follow the same rule', () => {
    const futures = [{ crop_year: 2026, commodity: 'Chicago Wheat', status: 'closed', num_contracts: 16, trade_price: 6.2, r: 15723.79 }]
    const options = [
      { crop_year: 2026, commodity: 'Chicago Wheat', status: 'open', num_contracts: 2, side: 'buy', prem: -1500, u: 300 },
      { crop_year: 2026, commodity: 'Chicago Wheat', status: 'closed_offset', num_contracts: 4, side: 'sell', prem: 2000, u: 0 },
    ]
    const [s] = summarizeByCropYear({
      futures, options, quantityFor: qty,
      futuresUnrealized: () => null, futuresRealized: (p) => p.r,
      optionUnrealized: (o) => o.u, optionRealized: () => 800, optionPremium: (o) => o.prem,
    })
    expect(s.fut.contracts).toBe(0)
    expect(s.fut.closedContracts).toBe(16)
    expect(legHasActivity(s.fut)).toBe(true)
    expect(s.fut.hasOpen).toBe(false)
    expect(s.opt.contracts).toBe(2)
    expect(s.opt.closedContracts).toBe(4)
    expect(s.opt.premium).toBe(500)
    expect(s.opt.realized).toBe(800)
    expect(legHasActivity({ contracts: 0, quantity: 0, priceWeight: 0, closedContracts: 0, premium: 0, unrealized: 0, realized: 0, hasOpen: false })).toBe(false)
  })

  it('sorts newest crop year first, then commodity', () => {
    const futures = [
      { crop_year: 2026, commodity: 'Soybeans', status: 'open', num_contracts: 2, trade_price: 12.035 },
      { crop_year: 2027, commodity: 'Chicago Wheat', status: 'open', num_contracts: 8, trade_price: 7.1 },
      { crop_year: 2026, commodity: 'Corn', status: 'open', num_contracts: 26, trade_price: 5.5 },
    ]
    const out = summarizeByCropYear({ futures, options: [], quantityFor: qty, futuresUnrealized: () => null, futuresRealized: () => 0, optionUnrealized: () => null, optionRealized: () => 0, optionPremium: () => 0 })
    expect(out.map((s) => `${s.cropYear} ${s.commodity}`)).toEqual(['2027 Chicago Wheat', '2026 Corn', '2026 Soybeans'])
  })
})
