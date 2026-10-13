import { describe, it, expect } from 'vitest'
import { reconcileStatementLots, weightedPrice, lotKey } from '@/lib/statement-lots'
import type { BrokerageStatementExtraction, BrokerageOpenPosition } from '@/lib/pdf-upload'

// The statement-side rules on their own (the full 10/12 statement lives in
// lib/stonex-1012-fixture.test.ts). Each case is one way the raw extraction
// mis-shapes a correctly-read page.

const base: BrokerageStatementExtraction = {
  statement_date: '2026-10-12', broker: 'StoneX', open_positions: [], closed_groups: [], open_options: [], closed_options: [], account_summary: null,
}
const open = (o: Partial<BrokerageOpenPosition>): BrokerageOpenPosition => ({
  trade_date: '2026-10-12', side: 'short', num_contracts: 3, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: 83.63, unrealized_pnl: null, execution_code: 'SE', ...o,
})

describe('weightedPrice', () => {
  it('the five 10/12 BUYs average to 80.4573913 (the statement prints 80.45739)', () => {
    const w = weightedPrice([{ price: 80.44, contracts: 3 }, { price: 80.45, contracts: 12 }, { price: 80.46, contracts: 3 }, { price: 80.48, contracts: 3 }, { price: 80.49, contracts: 2 }])
    expect(w).toBeCloseTo(80.4573913, 7)
    expect(Math.round(w! * 1e5) / 1e5).toBe(80.45739)
  })
  it('no fills → null', () => {
    expect(weightedPrice([])).toBeNull()
  })
})

describe('reconcileStatementLots — opens', () => {
  it('a quantity carrying the asterisk is a subtotal, never a position', () => {
    const rec = reconcileStatementLots({ ...base, open_positions: [open({}), open({ num_contracts: '23*' as unknown as number, trade_date: null })] })
    expect(rec.opens).toHaveLength(1)
    expect(rec.warnings[0]).toMatch(/"23\*" subtotal line was read as a position and set aside/)
  })

  it('a row with no trade date at the subtotal CLOSE price is the CLOSE, not a position', () => {
    const rec = reconcileStatementLots({
      ...base,
      open_positions: [open({}), open({ trade_date: null, num_contracts: 23, trade_price: 83.81 })],
      open_position_subtotals: [{ commodity: 'Cotton', contract_month: 'MAR 27', side: 'short', contracts: 3, close_price: 83.81, open_trade_equity: -270 }],
    })
    expect(rec.opens).toHaveLength(1)
    expect(rec.warnings.some((w) => w.includes('subtotal’s CLOSE') || w.includes("subtotal's CLOSE"))).toBe(true)
  })

  it('the same fill listed twice (CONFIRMATION + OPEN POSITIONS) is kept once…', () => {
    const rec = reconcileStatementLots({ ...base, open_positions: [open({}), open({})] })
    expect(rec.opens).toHaveLength(1)
    expect(rec.opens[0].num_contracts).toBe(3)
    expect(rec.warnings[0]).toMatch(/listed 2 times and kept once/)
  })

  it('…unless the confirmation shows that many separate fills of that exact key', () => {
    const rec = reconcileStatementLots({
      ...base,
      open_positions: [open({}), open({})],
      confirmation_trades: [
        { trade_date: '2026-10-12', side: 'sell', num_contracts: 3, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: 83.63, execution_code: 'SE' },
        { trade_date: '2026-10-12', side: 'sell', num_contracts: 3, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: 83.63, execution_code: 'SE' },
      ],
    })
    expect(rec.opens).toHaveLength(2)
    expect(rec.warnings).toEqual([])
  })

  it('different prices are different fills, even on the same day — and the key tells them apart', () => {
    const rec = reconcileStatementLots({ ...base, open_positions: [open({ trade_price: 83.63 }), open({ trade_price: 83.64, num_contracts: 12 })] })
    expect(rec.opens).toHaveLength(2)
    expect(lotKey(rec.opens[0])).not.toBe(lotKey(rec.opens[1]))
  })

  it('the statement count vs what was read is reported per subtotal', () => {
    const rec = reconcileStatementLots({
      ...base,
      open_positions: [open({})],
      open_position_subtotals: [{ commodity: 'Cotton', contract_month: 'MAR 27', side: 'short', contracts: 23, close_price: 83.81, open_trade_equity: -1870 }],
    })
    expect(rec.warnings).toContain('MAR 27 Cotton: the statement shows short 23, but 3 were read from its open positions.')
  })
})

describe('reconcileStatementLots — closed groups', () => {
  const dec = {
    commodity: 'Cotton', contract_month: 'DEC 26', side: 'short' as const, close_date: '2026-10-12', close_price: 80.45739,
    lots: [{ open_date: '2026-03-18', open_price: 72.65, contracts: 10 }, { open_date: '2026-08-10', open_price: 84.4, contracts: 13 }],
    statement_reported_total: -13410, close_execution_code: 'SE',
  }
  const fills = [
    { date: '2026-10-12', price: 80.44, contracts: 3 }, { date: '2026-10-12', price: 80.45, contracts: 12 }, { date: '2026-10-12', price: 80.46, contracts: 3 },
    { date: '2026-10-12', price: 80.48, contracts: 3 }, { date: '2026-10-12', price: 80.49, contracts: 2 },
  ]

  it('closing fills listed as lots are dropped when they match the printed closing_fills', () => {
    const rec = reconcileStatementLots({ ...base, closed_groups: [{ ...dec, closing_fills: fills, statement_reported_contracts: 23, lots: [...dec.lots, ...fills.map((f) => ({ open_date: f.date, open_price: f.price, contracts: f.contracts }))] }] })
    expect(rec.closes[0].lots).toHaveLength(2)
    expect(rec.closes[0].close_price).toBeCloseTo(80.4573913, 7)
    expect(rec.warnings[0]).toMatch(/7 lots read, 46 contracts, but the statement subtotal is 23/)
  })

  it('with no closing_fills printed, same-day lots that average to the close (or count like the earlier lots) are the closing side', () => {
    const rec = reconcileStatementLots({ ...base, closed_groups: [{ ...dec, side: 'long', lots: [...dec.lots, ...fills.map((f) => ({ open_date: f.date, open_price: f.price, contracts: f.contracts }))] }] })
    const g = rec.closes[0]
    expect(g.lots.map((l) => l.contracts)).toEqual([10, 13])
    expect(g.closing_fills).toHaveLength(5)
    expect(g.side).toBe('short')
    expect(g.sideCorrected).toBe(true)
  })

  it('a genuine same-day open lot in a group with printed closing fills stays a lot', () => {
    const rec = reconcileStatementLots({ ...base, closed_groups: [{ ...dec, closing_fills: fills, statement_reported_contracts: 25, statement_reported_total: null, lots: [...dec.lots, { open_date: '2026-10-12', open_price: 81.1, contracts: 2 }] }] })
    expect(rec.closes[0].lots).toHaveLength(3)
    expect(rec.warnings).toEqual([])
  })

  it('a lot count that does not reach the subtotal is flagged, not fixed', () => {
    const rec = reconcileStatementLots({ ...base, closed_groups: [{ ...dec, statement_reported_contracts: 25, closing_fills: fills }] })
    expect(rec.closes[0].lots).toHaveLength(2)
    expect(rec.warnings[0]).toMatch(/add up to 23 contracts but the statement subtotal is 25/)
  })

  it('a lot with no open date (the AVG line) is set aside', () => {
    const rec = reconcileStatementLots({ ...base, closed_groups: [{ ...dec, lots: [...dec.lots, { open_date: null, open_price: 80.45739, contracts: 23 }] }] })
    expect(rec.closes[0].lots).toHaveLength(2)
    expect(rec.warnings[0]).toMatch(/no open date/)
  })

  it('the legacy closed_trades shape still wraps as one-lot groups', () => {
    const rec = reconcileStatementLots({
      ...base,
      closed_groups: [],
      closed_trades: [{ open_trade_date: '2026-04-15', close_trade_date: '2026-09-03', side: 'short', num_contracts: 14, commodity: 'Corn', contract_month: 'DEC 26', open_price: 4.9525, close_price: 5.435, realized_pnl: -33775 }],
    })
    expect(rec.closes).toHaveLength(1)
    expect(rec.closes[0].lots).toEqual([{ open_date: '2026-04-15', open_price: 4.9525, contracts: 14 }])
    expect(rec.closes[0].statement_reported_total).toBe(-33775)
  })

  it('fees: close side from the groups, open side = the summary total less the close side', () => {
    const rec = reconcileStatementLots({
      ...base,
      closed_groups: [{ ...dec, closing_fills: fills, statement_reported_contracts: 23, fees: 531.53 }],
      account_summary: { beginning_balance: null, ending_balance: null, open_trade_equity: null, total_equity: null, margin_requirement: null, excess_equity: null, total_commissions_and_fees: 1063.06 },
    })
    expect(rec.fees).toEqual({ total: 1063.06, closeSide: 531.53, openSide: 531.53 })
    expect(reconcileStatementLots({ ...base, closed_groups: [{ ...dec, fees: 531.53 }] }).fees).toEqual({ total: null, closeSide: 531.53, openSide: null })
  })
})
