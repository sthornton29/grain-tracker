import { describe, it, expect } from 'vitest'
import { buildSavePlan, assertSavePlan, projectOpenPositions, reconcileWithStatement, scopeGatePositions, statementReferencedIds, type PlanClosedLot, type PlanOpenRow, type ProjectionPosition } from '@/lib/import-reconciliation'
import type { RollCandidate } from '@/lib/roll-detection'
import type { StatementSubtotal } from '@/lib/statement-lots'

// The save plan and the gate on their own — the 10/12 statement end to end
// lives in lib/stonex-1012-fixture.test.ts.

const openRow = (key: string, over: Partial<PlanOpenRow> = {}): PlanOpenRow => ({
  key, commodity: 'Cotton', contract_month: 'MAR 27', side: 'short', num_contracts: 3, trade_date: '2026-10-12', trade_price: 83.63,
  include: true, existing: false, existingId: null, manualMatchId: null, execution_code: 'SE', crop_year: '2026', ...over,
})
const lotRow = (key: string, groupKey: string, over: Partial<PlanClosedLot> = {}): PlanClosedLot => ({
  key, groupKey, commodity: 'Cotton', contract_month: 'DEC 26', side: 'short', open_trade_date: '2026-03-18', open_price: 72.65, num_contracts: 10,
  close_trade_date: '2026-10-12', close_price: 80.4573913, realized_pnl: -39036.96, matchedOpenId: 'dec-10', heldContracts: 10,
  alreadyImported: false, closedRowId: null, include: true, crop_year: '2026', ...over,
})
const roll = (over: Partial<RollCandidate> = {}): RollCandidate => ({
  closedKey: 'g0', openKey: 'o0', openKeys: ['o0', 'o1'], commodity: 'Cotton', side: 'short', fromMonth: 'DEC 26', toMonth: 'MAR 27', date: '2026-10-12',
  closedContracts: 6, openContracts: 6, closePrice: 80.45, openPrice: 83.64, spreadPerUnit: 3.19, spreadCode: true, partial: false, countMismatch: false,
  confidence: 'high', reasons: [], defaultOn: true, inheritedCropYear: 2026, closedAlreadyRecorded: false, openAlreadyRecorded: false, alreadyRecorded: false, ...over,
})

describe('buildSavePlan', () => {
  it('a roll consumes every one of its open fills and its closed group; the rest is new opens / matched closes / closed to import', () => {
    const opens = [openRow('o0'), openRow('o1', { trade_price: 83.64 }), openRow('o2', { commodity: 'Corn', contract_month: 'MAR 27', trade_price: 5.5 })]
    const lots = [lotRow('g0l0', 'g0'), lotRow('g1l0', 'g1', { commodity: 'Corn', contract_month: 'SEP 26', matchedOpenId: 'corn-x' }), lotRow('g2l0', 'g2', { commodity: 'Soybeans', matchedOpenId: null })]
    const plan = buildSavePlan({ opens, lots, rolls: [roll()], isRollOn: () => true })
    expect(plan.rolls).toHaveLength(1)
    expect(plan.rolls[0].opens.map((o) => o.key)).toEqual(['o0', 'o1'])
    expect(plan.rolls[0].closedLots.map((l) => l.key)).toEqual(['g0l0'])
    expect(plan.newOpens.map((o) => o.key)).toEqual(['o2'])
    expect(plan.closesMatched.map((l) => l.key)).toEqual(['g1l0'])
    expect(plan.closedToImport.map((l) => l.key)).toEqual(['g2l0'])
    expect(plan.conflicts).toEqual([])
    expect(plan.isEmpty).toBe(false)
    expect(() => assertSavePlan(plan)).not.toThrow()
  })

  it('a roll switched off puts its legs back into the plain buckets — still no lot twice', () => {
    const opens = [openRow('o0'), openRow('o1')]
    const lots = [lotRow('g0l0', 'g0')]
    const plan = buildSavePlan({ opens, lots, rolls: [roll()], isRollOn: () => false })
    expect(plan.rolls).toEqual([])
    expect(plan.newOpens).toHaveLength(2)
    expect(plan.closesMatched).toHaveLength(1)
    expect(plan.conflicts).toEqual([])
  })

  it('an already-recorded roll is never run, and its legs are "already imported"', () => {
    const opens = [openRow('o0', { existing: true, existingId: 'm0', include: false }), openRow('o1', { existing: true, existingId: 'm1', include: false })]
    const lots = [lotRow('g0l0', 'g0', { alreadyImported: true, closedRowId: 'dec-10', matchedOpenId: null, include: false })]
    const plan = buildSavePlan({ opens, lots, rolls: [roll({ alreadyRecorded: true, defaultOn: false })], isRollOn: () => true })
    expect(plan.isEmpty).toBe(true)
    expect(plan.alreadyImported.rolls).toHaveLength(1)
    expect(plan.alreadyImported.opens).toHaveLength(2)
    expect(plan.alreadyImported.closedLots).toHaveLength(1)
  })

  it('flags a lot that lands in two buckets (two rolls claiming one open fill)', () => {
    const opens = [openRow('o0'), openRow('o1')]
    const lots = [lotRow('g0l0', 'g0'), lotRow('g1l0', 'g1', { contract_month: 'SEP 26', matchedOpenId: 'dec-x' })]
    const plan = buildSavePlan({ opens, lots, rolls: [roll(), roll({ closedKey: 'g1', openKeys: ['o1'], openKey: 'o1' })], isRollOn: () => true })
    expect(plan.conflicts).toEqual(['o1'])
    expect(() => assertSavePlan(plan)).toThrow(/same trade twice/)
  })
})

describe('projectOpenPositions', () => {
  const positions: ProjectionPosition[] = [
    { id: 'dec-10', commodity: 'Cotton', contract_month: 'DEC 26', side: 'short', num_contracts: 10, trade_price: 72.65, trade_date: '2026-03-18', status: 'open' },
    { id: 'corn-14', commodity: 'Corn', contract_month: 'MAR 27', side: 'short', num_contracts: 14, trade_price: 5.585, trade_date: '2026-09-03', status: 'open' },
    { id: 'old', commodity: 'Corn', contract_month: 'DEC 25', side: 'short', num_contracts: 5, trade_price: 4.5, trade_date: '2025-03-01', status: 'closed' },
  ]

  it('rolls close their closed legs and open their open legs; new opens add; matched closes reduce; closed imports add nothing', () => {
    const opens = [openRow('o0', { num_contracts: 4 }), openRow('o1', { num_contracts: 6, trade_price: 83.64 }), openRow('o2', { commodity: 'Corn', contract_month: 'MAR 27', num_contracts: 2, trade_price: 5.5 })]
    const lots = [
      lotRow('g0l0', 'g0'),
      lotRow('g1l0', 'g1', { commodity: 'Corn', contract_month: 'MAR 27', matchedOpenId: 'corn-14', heldContracts: 14, num_contracts: 4, open_price: 5.585 }),
      lotRow('g2l0', 'g2', { commodity: 'Soybeans', contract_month: 'NOV 26', matchedOpenId: null, num_contracts: 2 }),
    ]
    const plan = buildSavePlan({ opens, lots, rolls: [roll({ closedContracts: 10, openContracts: 10 })], isRollOn: () => true })
    const projected = projectOpenPositions(positions, plan)
    const by = Object.fromEntries(projected.map((p) => [p.key, p.contracts]))
    expect(by).toEqual({ 'Cotton|MAR 27|short': 10, 'Corn|MAR 27|short': 12 })
    const cotton = projected.find((p) => p.key === 'Cotton|MAR 27|short')!
    expect(cotton.lots.map((l) => l.origin)).toEqual(['statement', 'statement'])
    expect(cotton.lots[0].description).toBe('short 4 MAR 27 Cotton @ $0.8363 on 10/12 — from this statement')
    const corn = projected.find((p) => p.key === 'Corn|MAR 27|short')!
    expect(corn.lots.map((l) => `${l.origin}:${l.contracts}`)).toEqual(['stored:10', 'statement:2'])
  })

  it('an open leg already stored is not added twice', () => {
    const opens = [openRow('o0', { num_contracts: 10, existing: true, existingId: 'mar-x', include: false })]
    const withMar = [...positions, { id: 'mar-x', commodity: 'Cotton', contract_month: 'MAR 27', side: 'short' as const, num_contracts: 10, trade_price: 83.63, trade_date: '2026-10-12', status: 'open' }]
    const plan = buildSavePlan({ opens, lots: [lotRow('g0l0', 'g0')], rolls: [roll({ openKeys: ['o0'], closedContracts: 10, openContracts: 10 })], isRollOn: () => true })
    const projected = projectOpenPositions(withMar, plan)
    expect(projected.find((p) => p.key === 'Cotton|MAR 27|short')?.contracts).toBe(10)
    expect(projected.find((p) => p.key === 'Cotton|DEC 26|short')).toBeUndefined()
  })
})

describe('reconcileWithStatement', () => {
  const subtotals: StatementSubtotal[] = [
    { key: 'Cotton|MAR 27|short', commodity: 'Cotton', contract_month: 'MAR 27', side: 'short', contracts: 23, close_price: 83.81, open_trade_equity: -1870 },
    { key: 'Corn|MAR 27|short', commodity: 'Corn', contract_month: 'MAR 27', side: 'short', contracts: 26, close_price: 4.9725, open_trade_equity: 73475 },
  ]
  const lot = (commodity: string, month: string, contracts: number, trade_price: number) => ({
    commodity, contract_month: month, side: 'short' as const, contracts, trade_price, trade_date: '2026-10-12', origin: 'statement' as const, description: `short ${contracts} ${month} ${commodity}`,
  })

  it('a count that would not match blocks, naming the contract the statement way and listing the rows', () => {
    const r = reconcileWithStatement({
      projected: [
        { key: 'Cotton|MAR 27|short', commodity: 'Cotton', contract_month: 'MAR 27', side: 'short', contracts: 46, lots: [lot('Cotton', 'MAR 27', 23, 83.64), lot('Cotton', 'MAR 27', 23, 83.64)] },
        { key: 'Corn|MAR 27|short', commodity: 'Corn', contract_month: 'MAR 27', side: 'short', contracts: 26, lots: [lot('Corn', 'MAR 27', 26, 5.5)] },
      ],
      subtotals, closesRealized: -13410, grossProfitLoss: -13410, openTradeEquity: 70080,
    })
    expect(r.level).toBe('block')
    expect(r.countMismatches).toHaveLength(1)
    expect(r.countMismatches[0].message).toBe('Statement shows MAR 27 ICE Cotton short 23. After this import Turnrow would have 46.')
    expect(r.countMismatches[0].rows).toHaveLength(2)
  })

  it('a month the statement lists that Turnrow would not hold — and vice versa within the statement’s commodities — blocks', () => {
    const missing = reconcileWithStatement({ projected: [{ key: 'Corn|MAR 27|short', commodity: 'Corn', contract_month: 'MAR 27', side: 'short', contracts: 26, lots: [] }], subtotals, closesRealized: 0, grossProfitLoss: null, openTradeEquity: null })
    expect(missing.countMismatches.map((m) => m.message)).toEqual(['Statement shows MAR 27 ICE Cotton short 23. After this import Turnrow would have 0.'])
    const extra = reconcileWithStatement({
      projected: [
        { key: 'Cotton|MAR 27|short', commodity: 'Cotton', contract_month: 'MAR 27', side: 'short', contracts: 23, lots: [] },
        { key: 'Corn|MAR 27|short', commodity: 'Corn', contract_month: 'MAR 27', side: 'short', contracts: 26, lots: [] },
        { key: 'Cotton|DEC 26|short', commodity: 'Cotton', contract_month: 'DEC 26', side: 'short', contracts: 4, lots: [lot('Cotton', 'DEC 26', 4, 72.3)] },
        { key: 'Soybeans|NOV 26|short', commodity: 'Soybeans', contract_month: 'NOV 26', side: 'short', contracts: 8, lots: [] },
      ],
      subtotals, closesRealized: 0, grossProfitLoss: null, openTradeEquity: null,
    })
    // Soybeans are not on this statement at all, so they are not judged.
    expect(extra.countMismatches.map((m) => m.message)).toEqual(['Statement shows DEC 26 ICE Cotton short 0. After this import Turnrow would have 4.'])
  })

  it('counts matching but a dollar check off → warn; everything within $1 → ok; unprinted figures are not checked', () => {
    const projected = [
      { key: 'Cotton|MAR 27|short', commodity: 'Cotton', contract_month: 'MAR 27', side: 'short' as const, contracts: 23, lots: [lot('Cotton', 'MAR 27', 23, 83.64)] },
      { key: 'Corn|MAR 27|short', commodity: 'Corn', contract_month: 'MAR 27', side: 'short' as const, contracts: 26, lots: [lot('Corn', 'MAR 27', 14, 5.585), lot('Corn', 'MAR 27', 12, 5.4825)] },
    ]
    // cotton: (83.64 − 83.81) × 23 × 500 = −1,955; corn: 42,875 + 30,600 = 73,475 → 71,520
    const warn = reconcileWithStatement({ projected, subtotals, closesRealized: -13410, grossProfitLoss: -13410, openTradeEquity: 70080 })
    expect(warn.level).toBe('warn')
    expect(warn.ote.projected).toBe(71520)
    expect(warn.ote.ok).toBe(false)
    expect(warn.ote.diff).toBe(1440)
    expect(warn.realized.ok).toBe(true)
    const ok = reconcileWithStatement({ projected, subtotals, closesRealized: -13409.5, grossProfitLoss: -13410, openTradeEquity: 71520.4 })
    expect(ok.level).toBe('ok')
    const unchecked = reconcileWithStatement({ projected, subtotals, closesRealized: 0, grossProfitLoss: null, openTradeEquity: null })
    expect(unchecked.ote.ok).toBeNull()
    expect(unchecked.realized.ok).toBeNull()
    expect(unchecked.level).toBe('ok')
  })
})

describe('scopeGatePositions', () => {
  // The 10/29 StoneX statement: 26 MAR 27 corn (14 + 12) and 8 JUL 27 wheat
  // (4 × 2), every one stored, open and matched — but the 14-lot and two of
  // the wheat lots were tagged with an entity while the account entity was
  // "none". The gate blocked on "short 26 … Turnrow would have 12".
  const stored = (id: string, commodity: string, month: string, n: number, price: number, date: string, entity_id: string | null): ProjectionPosition => ({
    id, commodity, contract_month: month, side: 'short', num_contracts: n, trade_price: price, trade_date: date, status: 'open', entity_id,
  })
  const positions = [
    stored('corn-14', 'Corn', 'MAR 27', 14, 5.585, '2026-09-03', 'turnrow'),
    stored('corn-12', 'Corn', 'MAR 27', 12, 5.4825, '2026-09-11', null),
    stored('wheat-a', 'Chicago Wheat', 'JUL 27', 2, 7.0025, '2026-04-29', 'turnrow'),
    stored('wheat-b', 'Chicago Wheat', 'JUL 27', 2, 7.1875, '2026-05-19', 'turnrow'),
    stored('wheat-c', 'Chicago Wheat', 'JUL 27', 2, 6.99, '2026-07-15', null),
    stored('wheat-d', 'Chicago Wheat', 'JUL 27', 2, 7.31, '2026-07-23', null),
    stored('soy-nov', 'Soybeans', 'NOV 26', 2, 12.035, '2026-05-19', 'turnrow'),
    stored('other-account', 'Corn', 'MAR 27', 5, 5.6, '2026-09-20', 'elsewhere'),
  ]
  const matched = (key: string, id: string, over: Partial<PlanOpenRow>) => openRow(key, { existing: true, existingId: id, include: false, ...over })
  const opens = [
    matched('o0', 'corn-14', { commodity: 'Corn', num_contracts: 14, trade_price: 5.585, trade_date: '2026-09-03' }),
    matched('o1', 'corn-12', { commodity: 'Corn', num_contracts: 12, trade_price: 5.4825, trade_date: '2026-09-11' }),
    matched('o2', 'wheat-a', { commodity: 'Chicago Wheat', contract_month: 'JUL 27', num_contracts: 2, trade_price: 7.0025, trade_date: '2026-04-29' }),
    matched('o3', 'wheat-b', { commodity: 'Chicago Wheat', contract_month: 'JUL 27', num_contracts: 2, trade_price: 7.1875, trade_date: '2026-05-19' }),
    matched('o4', 'wheat-c', { commodity: 'Chicago Wheat', contract_month: 'JUL 27', num_contracts: 2, trade_price: 6.99, trade_date: '2026-07-15' }),
    matched('o5', 'wheat-d', { commodity: 'Chicago Wheat', contract_month: 'JUL 27', num_contracts: 2, trade_price: 7.31, trade_date: '2026-07-23' }),
    openRow('o6', { commodity: 'Soybeans', contract_month: 'JAN 27', num_contracts: 2, trade_price: 12.3825, trade_date: '2026-10-29' }),
  ]
  // The NOV 26 → JAN 27 roll: its closed lot closes the entity-tagged NOV 26 position.
  const lots = [lotRow('g0l0', 'g0', { commodity: 'Soybeans', contract_month: 'NOV 26', open_trade_date: '2026-05-19', open_price: 12.035, num_contracts: 2, close_trade_date: '2026-10-29', close_price: 12.245, realized_pnl: -2100, matchedOpenId: 'soy-nov', heldContracts: 2 })]
  const rolls = [roll({ closedKey: 'g0', openKey: 'o6', openKeys: ['o6'], commodity: 'Soybeans', fromMonth: 'NOV 26', toMonth: 'JAN 27', date: '2026-10-29', closedContracts: 2, openContracts: 2, closePrice: 12.245, openPrice: 12.3825 })]
  const subtotals: StatementSubtotal[] = [
    { key: 'Corn|MAR 27|short', commodity: 'Corn', contract_month: 'MAR 27', side: 'short', contracts: 26, close_price: 4.6475, open_trade_equity: 115725 },
    { key: 'Soybeans|JAN 27|short', commodity: 'Soybeans', contract_month: 'JAN 27', side: 'short', contracts: 2, close_price: 12.3475, open_trade_equity: 350 },
    { key: 'Chicago Wheat|JUL 27|short', commodity: 'Chicago Wheat', contract_month: 'JUL 27', side: 'short', contracts: 8, close_price: 6.275, open_trade_equity: 33900 },
  ]
  // Account entity "none": only untagged positions are in scope on their own.
  const inScope = (e: string | null) => e == null

  it('collects every stored position the statement rows point at', () => {
    const ids = statementReferencedIds({ opens: [...opens, openRow('x', { manualMatchId: 'paired' })], lots })
    expect([...ids].sort()).toEqual(['corn-12', 'corn-14', 'paired', 'soy-nov', 'wheat-a', 'wheat-b', 'wheat-c', 'wheat-d'])
  })

  it('a position the statement lists counts whatever entity it carries; another account’s position still does not', () => {
    const scoped = scopeGatePositions(positions, { inScope, referencedIds: statementReferencedIds({ opens, lots }) })
    expect(scoped.map((p) => p.id)).not.toContain('other-account')
    expect(scoped).toHaveLength(7)
    const plan = buildSavePlan({ opens, lots, rolls, isRollOn: () => true })
    const projected = projectOpenPositions(scoped, plan)
    // Open trade equity at the statement's closes: corn 115,725 + soy 350 + wheat 33,900 (the cotton is not on this test's statement).
    const gate = reconcileWithStatement({ projected, subtotals, closesRealized: -2100, grossProfitLoss: -2100, openTradeEquity: 149975 })
    expect(gate.countMismatches).toEqual([])
    expect(gate.ote.projected).toBe(149975)
    expect(gate.level).toBe('ok')
  })

  it('the old strict entity filter is exactly the false block', () => {
    const scoped = positions.filter((p) => inScope(p.entity_id ?? null))
    const plan = buildSavePlan({ opens, lots, rolls, isRollOn: () => true })
    const gate = reconcileWithStatement({ projected: projectOpenPositions(scoped, plan), subtotals, closesRealized: -2100, grossProfitLoss: -2100, openTradeEquity: null })
    expect(gate.countMismatches.map((m) => m.message)).toEqual([
      'Statement shows MAR 27 Corn short 26. After this import Turnrow would have 12.',
      'Statement shows JUL 27 Chicago Wheat short 8. After this import Turnrow would have 4.',
    ])
  })
})
