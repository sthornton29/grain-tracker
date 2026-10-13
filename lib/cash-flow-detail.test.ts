import { describe, expect, it } from 'vitest'
import { contractCashAggregates, lineShareFor, priceLaterInfo, projectionMonths, selectCashDetails, spotCashRows, sumCashDetails, type CashDetail, type CashLine } from './cash-flow-detail'
import type { LoadSale } from '@/lib/load-sales'
import { buildPriceLaterPools, buildSpotContracts, type SaleSourceLoad } from '@/lib/virtual-contracts'

const rows: CashDetail[] = [
  { kind: 'received', month: '2026-09', label: 'Settlement #1', amount: 5000 },
  { kind: 'received', month: '2026-10', label: 'Settlement #2', amount: 8000 },
  { kind: 'outstanding', month: '2026-09', label: 'Contract A', amount: 1200 },
  { kind: 'projected', month: '2026-09', label: 'Contract B', amount: 0 },
  { kind: 'cotton', month: '2026-09', label: 'Gin fees', amount: -300 },
]

describe('selectCashDetails', () => {
  it('one kind, one month — biggest first, zero rows dropped', () => {
    const out = selectCashDetails(rows, { kind: 'received', month: '2026-09' })
    expect(out.map((r) => r.label)).toEqual(['Settlement #1'])
    expect(selectCashDetails(rows, { kind: 'projected', month: '2026-09' })).toEqual([])
  })

  it('one kind across every month — in month order', () => {
    expect(selectCashDetails(rows, { kind: 'received', month: null }).map((r) => r.label)).toEqual(['Settlement #1', 'Settlement #2'])
  })

  it('every kind for one month — grouped in the report\'s column order', () => {
    const out = selectCashDetails(rows, { kind: 'all', month: '2026-09' })
    expect(out.map((r) => r.kind)).toEqual(['received', 'outstanding', 'cotton'])
    expect(sumCashDetails(out)).toBe(5900)
  })
})

describe('projectionMonths', () => {
  it('spreads from this month to the window end', () => {
    expect(projectionMonths({ todayKey: '2026-09', start: '2026-07-01', end: '2026-11-30' })).toEqual(['2026-09', '2026-10', '2026-11'])
  })

  it('starts at a future window start, crossing a year end', () => {
    expect(projectionMonths({ todayKey: '2026-09', start: '2026-12-01', end: '2027-02-15' })).toEqual(['2026-12', '2027-01', '2027-02'])
  })

  it('no end, or an end already passed, means "all in the current month"', () => {
    expect(projectionMonths({ todayKey: '2026-09', start: null, end: null })).toEqual([])
    expect(projectionMonths({ todayKey: '2026-09', start: '2026-01-01', end: '2026-08-31' })).toEqual([])
  })
})

// ---------- sale-aware buckets (094) — Bunge 0000205995 ----------

function load(over: Partial<SaleSourceLoad> & Pick<SaleSourceLoad, 'id' | 'dryBu'>): SaleSourceLoad {
  return { crop_id: 'soy', crop_year: 2026, to_buyer_id: 'bunge', to_type: 'buyer', date: '2026-09-25', ...over }
}
function sale(over: Partial<LoadSale> & Pick<LoadSale, 'load_id' | 'sale_type' | 'share'>): LoadSale {
  return { id: `s-${over.load_id}-${over.sale_type}`, contract_id: null, buyer_net_bushels: null, spot_price: null, spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null, ...over }
}
const SPOT = [
  { id: 'L289', date: '2026-09-25', bu: 912.744, price: 13.74 },
  { id: 'L302', date: '2026-09-25', bu: 959.926, price: 13.74 },
  { id: 'L508', date: '2026-09-26', bu: 1026, price: 13.74 },
  { id: 'L509', date: '2026-09-26', bu: 951, price: 13.74 },
  { id: 'L084', date: '2026-09-28', bu: 944.23, price: 13.38 },
]

describe('lineShareFor', () => {
  const contractPart = { saleType: 'contract' as const, contractId: 'K', share: 0.06 }
  const spotPart = { saleType: 'spot' as const, contractId: null, share: 0.94 }
  it('a line tagged with the contract counts whole for that part and nothing for the spot part', () => {
    const line: CashLine = { settlement_id: 'S', net_bushels: 58.284, net_revenue: 725, contract_id: 'K' }
    expect(lineShareFor(line, contractPart)).toBe(1)
    expect(lineShareFor(line, spotPart)).toBe(0)
  })
  it('a line tagged "spot" counts whole for the spot part', () => {
    const line: CashLine = { settlement_id: 'S', net_bushels: 912.744, net_revenue: 12278, sale_type: 'spot' }
    expect(lineShareFor(line, spotPart)).toBe(1)
    expect(lineShareFor(line, contractPart)).toBe(0)
  })
  it('an untagged line (pre-094 settlements) splits by the load\'s shares', () => {
    const line: CashLine = { settlement_id: 'S', net_bushels: 971, net_revenue: 13000 }
    expect(lineShareFor(line, contractPart)).toBe(0.06)
    expect(lineShareFor(line, spotPart)).toBe(0.94)
  })
})

describe('contractCashAggregates — delivered / unpaid / received from allocations', () => {
  // Ticket 0502289 split: 58.284 bu to contract K, 912.744 bu spot (971.028 total).
  const loads = [
    load({ id: 'L248', dryBu: 894.14 }),
    load({ id: 'L289', dryBu: 971.028 }),
    load({ id: 'L999', dryBu: 1000, contract_id: 'K' }), // pre-094 mirror only, unpaid
  ]
  const sales = [
    sale({ load_id: 'L248', sale_type: 'contract', contract_id: 'K', share: 1 }),
    sale({ load_id: 'L289', sale_type: 'contract', contract_id: 'K', share: 0.06002298 }),
    sale({ load_id: 'L289', sale_type: 'spot', share: 0.93997702, spot_price: 13.74, spot_price_source: 'settlement' }),
  ]
  const lines = new Map<string, CashLine[]>([
    ['L248', [{ settlement_id: 'S1', net_bushels: 894.14, net_revenue: 11364.52, contract_id: 'K' }]],
    ['L289', [
      { settlement_id: 'S1', net_bushels: 58.284, net_revenue: 740.79, contract_id: 'K' },
      { settlement_id: 'S1', net_bushels: 912.744, net_revenue: 12541.1, sale_type: 'spot' },
    ]],
  ])
  const agg = contractCashAggregates({ loads, sales, linesForLoad: (id) => lines.get(id) ?? [] })

  it('delivered counts the split load by its contract share; the mirror-only load counts whole', () => {
    const k = agg.get('K')!
    expect(k.delivered).toBeCloseTo(894.14 + 971.028 * 0.06002298 + 1000, 3)
    expect(k.deliveredUnpaid).toBe(1000)
    expect(k.unpaidLoads).toBe(1)
  })

  it('received takes only the lines tagged for the contract — the spot line of the split ticket never leaks in', () => {
    const k = agg.get('K')!
    expect(k.revenueReceived).toBeCloseTo(11364.52 + 740.79, 2)
    const s1 = k.receivedBySettlement.get('S1')!
    expect(s1.loads).toBe(2)
    expect(s1.bushels).toBeCloseTo(894.14 + 58.284, 3)
  })

  it('an untagged line on a split load is shared by the allocation\'s fraction', () => {
    const untagged = contractCashAggregates({ loads, sales, linesForLoad: (id) => (id === 'L289' ? [{ settlement_id: 'S2', net_bushels: 971.028, net_revenue: 13281.89 }] : []) })
    expect(untagged.get('K')!.revenueReceived).toBeCloseTo(13281.89 * 0.06002298, 2)
  })
})

describe('spotCashRows — the Spot row\'s cash', () => {
  const spotLoads = SPOT.map((s) => load({ id: s.id, dryBu: s.bu, date: s.date }))
  const spotSales = SPOT.map((s) => sale({ load_id: s.id, sale_type: 'spot', share: 1, spot_price: s.price, spot_price_source: s.id === 'L084' ? 'estimate' : 'settlement' }))
  const [spot] = buildSpotContracts({ loads: spotLoads, sales: spotSales, marketingAgentEntityId: 'TRW' })
  // Four loads on the 10/02 settlement; the 9/28 load not settled yet (estimated).
  const lines = new Map<string, CashLine[]>(
    SPOT.filter((s) => s.id !== 'L084').map((s) => [s.id, [{ settlement_id: 'S1', net_bushels: s.bu, net_revenue: s.bu * s.price, sale_type: 'spot' as const }]]),
  )
  const res = spotCashRows({
    spot, label: 'Spot · Soybean 2026', href: '/contracts/spot/soy/2026',
    linesForLoad: (id) => lines.get(id) ?? [],
    settlementMonth: () => '2026-10', settlementLabel: () => 'Settlement #0000205995 · Bunge', settlementHref: (id) => `/settlements/${id}`,
    thisMonth: '2026-10',
  })

  it('settled loads → ONE received row for the settlement, in the settlement\'s month', () => {
    const received = res.details.filter((d) => d.kind === 'received')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ month: '2026-10', status: 'received', label: 'Settlement #0000205995 · Bunge', href: '/settlements/S1' })
    expect(received[0].amount).toBeCloseTo((912.744 + 959.926 + 1026 + 951) * 13.74, 2)
    expect(res.received).toBeCloseTo(received[0].amount, 6)
    expect(received[0].sub).toContain('Spot · Soybean 2026 · 4 loads')
  })

  it('the unsettled load → outstanding this month at its current price, flagged as an estimate', () => {
    const outstanding = res.details.filter((d) => d.kind === 'outstanding')
    expect(outstanding).toHaveLength(1)
    expect(outstanding[0]).toMatchObject({ month: '2026-10', status: 'outstanding', label: 'Spot · Soybean 2026', href: '/contracts/spot/soy/2026' })
    expect(outstanding[0].amount).toBeCloseTo(944.23 * 13.38, 2)
    expect(outstanding[0].sub).toContain('est.')
    expect(res.estimated).toBe(true)
    expect(res.unsettledLoads).toBe(1)
    expect(res.settledLoads).toBe(4)
  })

  it('NEVER projected', () => {
    expect(res.details.some((d) => d.kind === 'projected')).toBe(false)
  })

  it('an entity share scales every dollar', () => {
    const half = spotCashRows({ spot, label: 'Spot · Soybean 2026', linesForLoad: (id) => lines.get(id) ?? [], settlementMonth: () => '2026-10', settlementLabel: () => 'S', thisMonth: '2026-10', share: 0.5 })
    expect(half.received).toBeCloseTo(res.received / 2, 6)
    expect(half.outstanding).toBeCloseTo(res.outstanding / 2, 6)
    expect(half.details[0].sub).toContain('50% entity share')
  })

  it('all settled → no outstanding row and no estimate flag', () => {
    const allLines = new Map<string, CashLine[]>(SPOT.map((s) => [s.id, [{ settlement_id: 'S1', net_bushels: s.bu, net_revenue: s.bu * s.price, sale_type: 'spot' as const }]]))
    const done = spotCashRows({ spot, label: 'Spot', linesForLoad: (id) => allLines.get(id) ?? [], settlementMonth: () => '2026-10', settlementLabel: () => 'S', thisMonth: '2026-10' })
    expect(done.outstanding).toBe(0)
    expect(done.estimated).toBe(false)
    expect(done.received).toBeCloseTo(65528.26, 2)
  })
})

describe('priceLaterInfo — the line under the table', () => {
  const loads = [load({ id: 'p1', dryBu: 2500, date: '2026-09-20' }), load({ id: 'p2', dryBu: 1700, date: '2026-09-22', to_buyer_id: 'adm' })]
  const pools = buildPriceLaterPools(loads, loads.map((l) => sale({ load_id: l.id, sale_type: 'price_later', share: 1 })))

  it('"X bu unpriced at buyers (~$Y at today\'s price)" with today = assumed futures + basis', () => {
    const info = priceLaterInfo({ pools, priceFor: () => 13.0 - 0.4 })!
    expect(info.bushels).toBe(4200)
    expect(info.value).toBeCloseTo(4200 * 12.6, 2)
    expect(info.text).toBe("4,200 bu unpriced at buyers (~$52,920 at today's price)")
  })

  it('no price assumption → the bushels still show, with a nudge to set one', () => {
    const info = priceLaterInfo({ pools, priceFor: () => null })!
    expect(info.value).toBeNull()
    expect(info.text).toContain('4,200 bu unpriced at buyers (no price assumption set yet')
  })

  it('no price-later bushels → null (no line at all)', () => {
    expect(priceLaterInfo({ pools: [], priceFor: () => 12 })).toBeNull()
  })

  it('a per-pool entity share scales the bushels', () => {
    const info = priceLaterInfo({ pools, priceFor: () => 10, share: () => 0.5 })!
    expect(info.bushels).toBe(2100)
    expect(info.value).toBe(21000)
  })
})
