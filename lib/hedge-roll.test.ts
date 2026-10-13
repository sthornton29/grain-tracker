import { describe, it, expect } from 'vitest'
import { buildRollPayload, friendlyRollError, rollRealized } from '@/lib/hedge-roll'

type Leg = Record<string, unknown>

describe('buildRollPayload — the 9/03 roll as the RPC receives it', () => {
  it('existing DEC 14-lot closes @ 5.435 (−$33,775 gross) and MAR 27 14 @ 5.585 opens, linked', () => {
    const payload = buildRollPayload({
      source: 'statement_import',
      statementDate: '2026-09-03',
      statementRef: 'StoneX',
      executionCode: 'SE',
      closePrice: 5.435,
      closeDate: '2026-09-03',
      closedLegs: [{ positionId: 'dec-14', quantity: 14, side: 'short', commodity: 'Corn', tradePrice: 4.9525 }],
      open: { row: { contract_month: 'MAR 27', num_contracts: 14, trade_price: 5.585, trade_date: '2026-09-03' } },
    })
    expect(payload.source).toBe('statement_import')
    expect(payload.statement_date).toBe('2026-09-03')
    expect(payload.statement_ref).toBe('StoneX')
    expect(payload.execution_code).toBe('SE')
    const close = payload.close as Leg[]
    expect(close).toHaveLength(1)
    expect(close[0].position_id).toBe('dec-14')
    expect(close[0].quantity).toBe(14)
    expect(close[0].close_price).toBe(5.435)
    expect(close[0].realized_pnl).toBeCloseTo(-33775, 2)
    expect(close[0].fees).toBe(0)
    const open = payload.open as Record<string, { contract_symbol: string; commodity: string; crop_year?: number }>
    expect(open.row.contract_symbol).toBe('ZCH27')
    expect(open.row.commodity).toBe('Corn')
    expect(open.row.crop_year).toBeUndefined() // inherited server-side, never sent
  })

  it('link-only legs send ids and nothing to insert', () => {
    const payload = buildRollPayload({
      source: 'statement_import', closePrice: 5.435, closeDate: '2026-09-03',
      closedLegs: [{ positionId: 'dec-14', quantity: 14, side: 'short', commodity: 'Corn', tradePrice: 4.9525 }],
      open: { positionId: 'mar-14' },
    })
    expect((payload.open as Leg).position_id).toBe('mar-14')
    expect((payload.open as Leg).row).toBeUndefined()
  })

  it('a closed leg not held in the app is recorded from its own facts with the crop year the reviewer picked', () => {
    const payload = buildRollPayload({
      source: 'statement_import', closePrice: 5.435, closeDate: '2026-09-03', fees: 28,
      closedLegs: [{ row: { entity_id: null, commodity: 'Corn', contract_month: 'DEC 26', crop_year: 2026, side: 'short', num_contracts: 14, trade_price: 4.9525, trade_date: '2026-04-15' } }],
      open: { row: { contract_month: 'MAR 27', num_contracts: 14, trade_price: 5.585, trade_date: '2026-09-03' } },
    })
    const close = (payload.close as Leg[])[0]
    expect((close.row as Leg).contract_symbol).toBe('ZCZ26')
    expect((close.row as Leg).crop_year).toBe(2026)
    expect(close.realized_pnl).toBeCloseTo(-33775, 2)
    expect(close.fees).toBe(28)
  })

  it('two lots rolled together: both legs close at the group price, fees charged once, each realized on its own entry', () => {
    // 10 @ 4.90 and 4 @ 5.10 both closed @ 5.435: (4.90−5.435)×50,000 = −26,750; (5.10−5.435)×20,000 = −6,700
    const payload = buildRollPayload({
      source: 'statement_import', closePrice: 5.435, closeDate: '2026-09-03', fees: 20,
      closedLegs: [
        { positionId: 'a', quantity: 10, side: 'short', commodity: 'Corn', tradePrice: 4.9 },
        { positionId: 'b', quantity: 4, side: 'short', commodity: 'Corn', tradePrice: 5.1 },
      ],
      open: { row: { contract_month: 'MAR 27', num_contracts: 14, trade_price: 5.585, trade_date: '2026-09-03' } },
    })
    const close = payload.close as Leg[]
    expect(close.map((l) => l.realized_pnl)).toEqual([-26750, -6700])
    expect(close.map((l) => l.fees)).toEqual([20, 0])
  })

  it('cotton rolls use the ¢/lb P&L size (50,000 lbs ÷ 100 per contract)', () => {
    // short 10 CT @ 72.65 closed @ 78.30: (72.65 − 78.30) × 10 × 500 = −28,250
    expect(rollRealized({ side: 'short', commodity: 'Cotton', tradePrice: 72.65, closePrice: 78.3, quantity: 10 })).toBeCloseTo(-28250, 2)
  })

  it('refuses a roll with no closed leg', () => {
    expect(() => buildRollPayload({ source: 'roll_action', closePrice: 1, closeDate: '2026-09-03', closedLegs: [], open: { positionId: 'x' } })).toThrow()
  })
})

describe('friendlyRollError', () => {
  it('a missing RPC reads as a database update, not a stack trace', () => {
    expect(friendlyRollError('Could not find the function public.hedge_execute_roll(payload)')).toMatch(/database update — contact support/)
    expect(friendlyRollError('cannot roll 20 of 14 contracts')).toMatch(/More contracts/)
    expect(friendlyRollError(null)).toBe('Could not record the roll.')
  })
})

describe('buildRollPayload — several open legs (0095)', () => {
  const closed = [
    { positionId: 'dec-10', quantity: 10, side: 'short' as const, commodity: 'Cotton', tradePrice: 72.65 },
    { positionId: 'dec-13', quantity: 13, side: 'short' as const, commodity: 'Cotton', tradePrice: 84.4 },
  ]
  const mar = ([[3, 83.63], [12, 83.64], [3, 83.65], [3, 83.67], [2, 83.68]] as const).map(([n, px]) => ({
    row: { contract_month: 'MAR 27', num_contracts: n, trade_price: px, trade_date: '2026-10-12', commission: 0 },
  }))

  it('every MAR fill is an open leg; open is the array shape; close fees once; open fees pro-rata to the cent', () => {
    const payload = buildRollPayload({
      source: 'statement_import', statementDate: '2026-10-12', statementRef: 'StoneX', executionCode: 'SE',
      closePrice: 80.4573913, closeDate: '2026-10-12', fees: 531.53, openFees: 531.53, closedLegs: closed, opens: mar, note: 'Saved with a position mismatch, checked by hand',
    })
    const close = payload.close as Leg[]
    expect(close.map((l) => l.realized_pnl)).toEqual([-39036.96, 25626.96])
    expect(close.map((l) => l.fees)).toEqual([531.53, 0])
    const open = payload.open as Array<{ row: { num_contracts: number; commission: number; contract_symbol: string; commodity: string } }>
    expect(Array.isArray(open)).toBe(true)
    expect(open.map((o) => o.row.num_contracts)).toEqual([3, 12, 3, 3, 2])
    expect(open.map((o) => o.row.commission)).toEqual([69.33, 277.32, 69.33, 69.33, 46.22])
    expect(Math.round(open.reduce((s, o) => s + o.row.commission, 0) * 100) / 100).toBe(531.53)
    expect(open.every((o) => o.row.contract_symbol === 'CTH27' && o.row.commodity === 'Cotton')).toBe(true)
    expect(payload.note).toBe('Saved with a position mismatch, checked by hand')
  })

  it('one open leg via `opens` keeps the 083 object shape; no note key when none given', () => {
    const payload = buildRollPayload({ source: 'roll_action', closePrice: 5.435, closeDate: '2026-09-03', closedLegs: [closed[0]], opens: [mar[1]] })
    expect(Array.isArray(payload.open)).toBe(false)
    expect((payload.open as Leg).row).toBeDefined()
    expect('note' in payload).toBe(false)
  })

  it('open fees land only on NEW legs — a leg linked by id keeps its own commission', () => {
    const payload = buildRollPayload({
      source: 'statement_import', closePrice: 80.45, closeDate: '2026-10-12', openFees: 100, closedLegs: closed,
      opens: [{ positionId: 'mar-existing' }, mar[0]],
    })
    const open = payload.open as Leg[]
    expect(open[0].position_id).toBe('mar-existing')
    expect((open[1].row as Leg).commission).toBe(100)
  })

  it('refuses a roll with no open leg', () => {
    expect(() => buildRollPayload({ source: 'roll_action', closePrice: 1, closeDate: '2026-09-03', closedLegs: [closed[0]] })).toThrow(/open leg/)
  })
})
