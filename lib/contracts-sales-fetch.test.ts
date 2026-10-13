import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  allocationPaid, buyersLabel, defaultPricedContractNumber, fetchSalesForContracts, fmtAvgPrice, narrowPool, priceLaterContractPayload,
  priceLaterRowFacts, settlementLinesByLoad, spotRowFacts, type SalesSettlementLine,
} from '@/lib/contracts-sales-fetch'
import { buildPriceLaterPools, buildSpotContracts, type SaleSourceLoad } from '@/lib/virtual-contracts'
import type { LoadSale } from '@/lib/load-sales'

// The tracker's virtual rows and per-part paid figures, hand-verified from
// Bunge settlement 0000205995: five spot loads (4,793.900 bu, $65,528.26,
// weighted average $13.6691) and the split ticket 0502289.

const SPOT = [
  { id: 'L289', date: '2026-09-25', bu: 912.744, price: 13.74 },
  { id: 'L302', date: '2026-09-25', bu: 959.926, price: 13.74 },
  { id: 'L508', date: '2026-09-26', bu: 1026, price: 13.74 },
  { id: 'L509', date: '2026-09-26', bu: 951, price: 13.74 },
  { id: 'L084', date: '2026-09-28', bu: 944.23, price: 13.38 },
]

function load(over: Partial<SaleSourceLoad> & Pick<SaleSourceLoad, 'id' | 'dryBu'>): SaleSourceLoad {
  return { crop_id: 'soy', crop_year: 2026, to_buyer_id: 'bunge', to_type: 'buyer', date: '2026-09-25', from_field_id: 'fieldA', from_type: 'field', ...over }
}
function sale(over: Partial<LoadSale> & Pick<LoadSale, 'load_id' | 'sale_type' | 'share'>): LoadSale {
  return { id: `s-${over.load_id}-${over.sale_type}`, contract_id: null, buyer_net_bushels: null, spot_price: null, spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null, ...over }
}
const nameOf = (id: string) => ({ bunge: 'Bunge', adm: 'ADM' } as Record<string, string>)[id]

const spotLoads = SPOT.map((s) => load({ id: s.id, dryBu: s.bu, date: s.date }))
const settledSales = SPOT.map((s) => sale({ load_id: s.id, sale_type: 'spot', share: 1, spot_price: s.price, spot_price_source: 'settlement' }))

describe('spotRowFacts — the Spot row on the tracker', () => {
  it('titles, buyers, the weighted average to 4 decimals and the status line', () => {
    const [spot] = buildSpotContracts({ loads: spotLoads, sales: settledSales, marketingAgentEntityId: 'TRW' })
    const f = spotRowFacts(spot, 'Soybean', nameOf)
    expect(f.title).toBe('Spot · Soybean 2026')
    expect(f.buyersLabel).toBe('Bunge')
    expect(f.avgText).toBe('$13.6691')
    expect(f.statusText).toBe('5 of 5 settled')
    expect(f.estimated).toBe(false)
    expect(f.loadCount).toBe(5)
    expect(f.bushels).toBeCloseTo(4793.9, 6)
    // Every load settled: all of the revenue is paid, nothing unpaid.
    expect(f.paidBu).toBeCloseTo(4793.9, 6)
    expect(f.paidRevenue).toBeCloseTo(65528.2632, 4)
    expect(f.unpaidBu).toBe(0)
    expect(f.unpaidRevenue).toBe(0)
    expect(f.value).toBeCloseTo(f.paidRevenue, 6)
  })

  it('splits paid (settled) from unpaid (estimated / entered, at their current price) and marks est.', () => {
    const sales = settledSales.map((s, i) => (i === 4 ? { ...s, spot_price_source: 'estimate' as const, spot_price: 13.39 } : s))
    const [spot] = buildSpotContracts({ loads: spotLoads, sales, marketingAgentEntityId: 'TRW' })
    const f = spotRowFacts(spot, 'Soybean', nameOf)
    expect(f.statusText).toBe('4 of 5 settled · est. on 1')
    expect(f.estimated).toBe(true)
    expect(f.paidBu).toBeCloseTo(912.744 + 959.926 + 1026 + 951, 6)
    expect(f.paidRevenue).toBeCloseTo(13.74 * (912.744 + 959.926 + 1026 + 951), 4)
    expect(f.unpaidBu).toBeCloseTo(944.23, 6)
    expect(f.unpaidRevenue).toBeCloseTo(13.39 * 944.23, 4)
    expect(f.value).toBeCloseTo(f.paidRevenue + f.unpaidRevenue, 4)
  })

  it('an unpriced load is unpaid bushels with no dollars, and "Bunge +1" names a second buyer', () => {
    const loads = [...spotLoads, load({ id: 'adm1', dryBu: 500, to_buyer_id: 'adm' })]
    const sales = [...settledSales, sale({ load_id: 'adm1', sale_type: 'spot', share: 1 })]
    const [spot] = buildSpotContracts({ loads, sales, marketingAgentEntityId: 'TRW' })
    const f = spotRowFacts(spot, 'Soybean', nameOf)
    expect(f.buyersLabel).toBe('Bunge +1')
    expect(f.unpaidBu).toBeCloseTo(500, 6)
    expect(f.unpaidRevenue).toBe(0)
    expect(f.statusText).toBe('5 of 6 settled · 1 unpriced')
    expect(f.estimated).toBe(true)
  })

  it('formats the average with 4 decimals and a dash with no price', () => {
    expect(fmtAvgPrice(13.669093)).toBe('$13.6691')
    expect(fmtAvgPrice(1234.5)).toBe('$1,234.5000')
    expect(fmtAvgPrice(null)).toBe('—')
    expect(buyersLabel([], nameOf)).toBe('')
    expect(buyersLabel(['bunge', 'adm', 'x'], nameOf)).toBe('Bunge +1')
  })
})

describe('priceLaterRowFacts — the Price later row', () => {
  const plLoads = [load({ id: 'p1', dryBu: 1000, date: '2026-09-20' }), load({ id: 'p2', dryBu: 1500, date: '2026-09-22' })]
  const plSales = [sale({ load_id: 'p1', sale_type: 'price_later', share: 1 }), sale({ load_id: 'p2', sale_type: 'price_later', share: 1 })]
  const [pool] = buildPriceLaterPools(plLoads, plSales)

  it('values the pool at assumed futures + basis, labelled unpriced', () => {
    const f = priceLaterRowFacts(pool, 'Soybean', 'Bunge', { assumed_futures: 10.5, assumed_basis: -0.4 })
    expect(f.title).toBe('Price later · Soybean 2026 · Bunge')
    expect(f.bushels).toBe(2500)
    expect(f.loadCount).toBe(2)
    expect(f.oldestDate).toBe('2026-09-20')
    expect(f.assumedPrice).toBeCloseTo(10.1, 9)
    expect(f.value).toBeCloseTo(25250, 6)
    expect(f.valueLabel).toBe('unpriced')
  })

  it('has no value without an assumed futures price (the row shows a dash)', () => {
    const f = priceLaterRowFacts(pool, 'Soybean', 'Bunge', { assumed_futures: null, assumed_basis: -0.4 })
    expect(f.assumedPrice).toBeNull()
    expect(f.value).toBeNull()
    expect(priceLaterRowFacts(pool, 'Soybean', 'Bunge', null).value).toBeNull()
  })

  it('narrows a pool to some loads (the entity filter) and drops it when nothing is left', () => {
    const narrowed = narrowPool(pool, (r) => r.load.id === 'p2')!
    expect(narrowed.bushels).toBe(1500)
    expect(narrowed.loadCount).toBe(1)
    expect(narrowed.oldestDate).toBe('2026-09-22')
    expect(narrowPool(pool, () => false)).toBeNull()
  })
})

describe('allocationPaid — the buyer\'s settled figures for one part of a load', () => {
  const line = (over: Partial<SalesSettlementLine>): SalesSettlementLine => ({
    id: 'ln', settlement_id: 'st', load_id: 'L', ticket_number: '0502289', net_bushels: 0, net_revenue: 0, contract_id: null, sale_type: null, ...over,
  })

  it('no lines → unpaid', () => {
    expect(allocationPaid({ saleType: 'contract', contractId: 'A', share: 1 }, [])).toBeNull()
  })

  it('an older single line (no per-line sale facts) is scaled by the part\'s share', () => {
    const paid = allocationPaid({ saleType: 'contract', contractId: 'A', share: 0.25 }, [line({ net_bushels: 1000, net_revenue: 12710 })])
    expect(paid).toEqual({ bushels: 250, revenue: 3177.5 })
  })

  it('a split ticket with per-line facts pays each part from its own line', () => {
    const lines = [
      line({ id: 'c', contract_id: 'A', sale_type: 'contract', net_bushels: 58.284, net_revenue: 740.79 }),
      line({ id: 's', sale_type: 'spot', net_bushels: 912.744, net_revenue: 12541.1 }),
    ]
    expect(allocationPaid({ saleType: 'contract', contractId: 'A', share: 0.06 }, lines)).toEqual({ bushels: 58.284, revenue: 740.79 })
    expect(allocationPaid({ saleType: 'spot', contractId: null, share: 0.94 }, lines)).toEqual({ bushels: 912.744, revenue: 12541.1 })
    // A part the settlement did not name is unpaid.
    expect(allocationPaid({ saleType: 'contract', contractId: 'B', share: 0.5 }, lines)).toBeNull()
  })

  it('groups lines by load id first, then by ticket number — both lines of a split ticket', () => {
    const lines = [
      line({ id: 'c', load_id: null, ticket_number: '0502289', contract_id: 'A', sale_type: 'contract', net_bushels: 58.284 }),
      line({ id: 's', load_id: null, ticket_number: '0502289', sale_type: 'spot', net_bushels: 912.744 }),
      line({ id: 'o', load_id: 'L2', ticket_number: null, net_bushels: 100 }),
    ]
    const linesFor = settlementLinesByLoad(lines)
    expect(linesFor({ id: 'L', ticket_number: '0502289' }).map((l) => l.id)).toEqual(['c', 's'])
    expect(linesFor({ id: 'L2', ticket_number: null }).map((l) => l.id)).toEqual(['o'])
    expect(linesFor({ id: 'L3', ticket_number: null, buyer_ticket_number: '0502289' }).map((l) => l.id)).toEqual(['c', 's'])
    expect(linesFor({ id: 'L4', ticket_number: 'nope' })).toEqual([])
  })
})

describe('priceLaterContractPayload — what "Price bushels" creates', () => {
  const pool = { crop_id: 'soy', crop_year: 2026, buyer_id: 'bunge', bushels: 2500 }

  it('a fully priced delivered forward at the typed price for min(requested, pool), held by the marketing agent', () => {
    const r = priceLaterContractPayload(pool, { bushels: 3000, pricePerBushel: 13.5, date: '2026-10-13', contractNumber: '  ', notes: ' called in ' }, 'TRW')
    if ('error' in r) throw new Error(r.error)
    expect(r.bushels).toBe(2500)
    expect(r.payload).toMatchObject({
      contract_number: 'Priced 10/13/26', buyer_id: 'bunge', crop_id: 'soy', crop_year: 2026, entity_id: 'TRW',
      contracted_bushels: 2500, cash_price: 13.5, price_per_bushel: 13.5, contract_type: 'forward', pricing_status: 'fully_priced',
      delivery_type: 'delivered', date_sold: '2026-10-13', notes: 'called in', service_fee: 0, futures_price: null, basis: null,
    })
  })

  it('keeps a typed contract number, a null entity without an agent, and prices part of the pool', () => {
    const r = priceLaterContractPayload(pool, { bushels: 1000, pricePerBushel: 13, date: '2026-01-05', contractNumber: '2002960604-11' }, null)
    if ('error' in r) throw new Error(r.error)
    expect(r.bushels).toBe(1000)
    expect(r.payload).toMatchObject({ contract_number: '2002960604-11', entity_id: null, contracted_bushels: 1000, notes: null })
    expect(defaultPricedContractNumber('2026-01-05')).toBe('Priced 1/5/26')
  })

  it('refuses a missing price, bushels or date, and an empty pool', () => {
    expect(priceLaterContractPayload(pool, { bushels: 100, pricePerBushel: 0, date: '2026-10-13' }, null)).toEqual({ error: 'Enter the price per bushel.' })
    expect(priceLaterContractPayload(pool, { bushels: 0, pricePerBushel: 13, date: '2026-10-13' }, null)).toEqual({ error: 'Enter how many bushels to price.' })
    expect(priceLaterContractPayload(pool, { bushels: 100, pricePerBushel: 13, date: '10/13/2026' }, null)).toEqual({ error: 'Pick the date.' })
    expect(priceLaterContractPayload({ ...pool, bushels: 0 }, { bushels: 100, pricePerBushel: 13, date: '2026-10-13' }, null)).toEqual({ error: 'There are no unpriced bushels left in this pool.' })
  })
})

// ---------- fetchSalesForContracts over a fake client ----------
// The contracts pages shape their loads through lib/spot-contracts.ts — the
// same dry-bushel rule, agent lookup and builders every other consumer uses.

type Row = Record<string, unknown>
function fakeClient(tables: Record<string, Row[] | { error: string }>, calls: Array<{ table: string; filters: string[] }>) {
  const builder = (table: string) => {
    const call = { table, filters: [] as string[] }
    calls.push(call)
    let rows: Row[] | null = null
    let err: string | null = null
    const src = tables[table]
    if (!src) rows = []
    else if (Array.isArray(src)) rows = [...src]
    else err = src.error
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.order = () => b
    b.eq = (col: string, v: unknown) => { call.filters.push(`${col}=${String(v)}`); if (rows) rows = rows.filter((r) => r[col] === v); return b }
    b.in = (col: string, vals: unknown[]) => { if (rows) rows = rows.filter((r) => vals.includes(r[col])); return b }
    b.range = (f: number, t: number) => { if (rows) rows = rows.slice(f, t + 1); return b }
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(err ? { data: null, error: { message: err } } : { data: rows, error: null }).then(resolve)
    return b
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
}

const SOY = { id: 'soy', name: 'Soybean', base_moisture_pct: 13, base_lb_per_bushel: 60, harvest_category: 'fall', double_crop: false }
const dbLoad = (over: Row): Row => ({
  date: '2026-09-25', crop_id: 'soy', crop_year: 2026, net_weight: null, moisture: null, dry_bushels_override: null, from_type: 'field', from_field_id: 'fv',
  to_type: 'buyer', to_buyer_id: 'bunge', contract_id: null, ticket_number: null, buyer_ticket_number: null, org_id: 'org1', ...over,
})
const DB_LOADS: Row[] = [
  ...SPOT.map((s) => dbLoad({ id: s.id, date: s.date, dry_bushels_override: s.bu })),
  // 55,000 lb at 14% with no override: the seam shrinks it to base (906.1 bu).
  dbLoad({ id: 'K1', net_weight: 55000, moisture: 14, contract_id: 'K', ticket_number: '0502248' }),
  dbLoad({ id: 'PL', date: '2026-09-30', dry_bushels_override: 1000, to_buyer_id: 'adm' }),
  dbLoad({ id: 'none', dry_bushels_override: 800 }),
  dbLoad({ id: 'bin', to_type: 'bin', to_buyer_id: null, dry_bushels_override: 500 }),
  dbLoad({ id: 'old', date: '2025-10-01', crop_year: 2025, dry_bushels_override: 700 }),
]
const DB_SALES: Row[] = [
  ...settledSales.map((s) => ({ ...s, org_id: 'org1' })),
  { ...sale({ load_id: 'PL', sale_type: 'price_later', share: 1 }), org_id: 'org1' },
  { ...sale({ load_id: 'old', sale_type: 'spot', share: 1, spot_price: 10, spot_price_source: 'settlement' }), org_id: 'org1' },
]
const TABLES = {
  loads: DB_LOADS,
  load_sales: DB_SALES,
  crops: [{ ...SOY, org_id: 'org1' }],
  entities: [{ id: 'VCF', name: 'VCF', entity_role: 'farming', org_id: 'org1' }, { id: 'TRW', name: 'Turnrow', entity_role: 'marketing_agent', org_id: 'org1' }],
  fields: [{ id: 'fv', farm_id: 'F-V', org_id: 'org1' }, { id: 'ft', farm_id: 'F-T', org_id: 'org1' }],
  farms: [{ id: 'F-V', entity_id: 'VCF', org_id: 'org1' }, { id: 'F-T', entity_id: null, org_id: 'org1' }],
  buyers: [{ id: 'bunge', name: 'Bunge' }, { id: 'adm', name: 'ADM' }],
  load_splits: [{ id: 1, load_id: 'none', field_id: 'fv', percentage: 60, org_id: 'org1' }, { id: 2, load_id: 'none', field_id: 'ft', percentage: 40, org_id: 'org1' }],
}

describe('fetchSalesForContracts — the contracts pages through the shared seam', () => {
  it('reads the year\'s BUYER loads, shapes them with the load\'s crop bases, and builds spots, pools and the lookups', async () => {
    const calls: Array<{ table: string; filters: string[] }> = []
    const out = await fetchSalesForContracts(fakeClient(TABLES, calls), { cropYear: 2026, orgId: 'org1' })
    expect(calls.find((c) => c.table === 'loads')!.filters).toEqual(expect.arrayContaining(['to_type=buyer', 'crop_year=2026', 'org_id=org1']))
    expect(out.loads.map((l) => l.id).sort()).toEqual(['K1', 'L084', 'L289', 'L302', 'L508', 'L509', 'PL', 'none'])
    expect(out.loads.find((l) => l.id === 'K1')!.dryBu).toBeCloseTo((55000 / 60) * (86 / 87), 3)
    expect(out.deliveredByContract.get('K')!.dryBu).toBeCloseTo((55000 / 60) * (86 / 87), 3)
    expect(out.marketingAgentEntityId).toBe('TRW')
    expect(out.spots).toHaveLength(1)
    expect(out.spots[0]).toMatchObject({ id: 'spot:soy:2026:TRW', entity_id: 'TRW' })
    expect(out.spots[0].bushels).toBeCloseTo(4793.9, 3)
    expect(out.pools.map((p) => [p.buyer_id, p.bushels])).toEqual([['adm', 1000]])
    expect(out.unassigned.map((l) => l.id)).toEqual(['none'])
    expect(out.fieldEntity.get('fv')).toBe('VCF')
    expect(out.fieldEntity.get('ft')).toBeNull()
    expect(out.splitsByLoad.get('none')).toEqual([{ field_id: 'fv', fraction: 0.6 }, { field_id: 'ft', fraction: 0.4 }])
    expect(out.crops[0].name).toBe('Soybean')
    expect(out.buyers.map((b) => b.id)).toEqual(['bunge', 'adm'])
  })

  it('without a crop year reads every buyer load and every sale row; a missing load_sales table reads as no rows', async () => {
    const all = await fetchSalesForContracts(fakeClient(TABLES, []))
    expect(all.loads.map((l) => l.id)).toContain('old')
    expect(all.loads.map((l) => l.id)).not.toContain('bin')
    expect(all.spots.map((s) => s.crop_year)).toEqual([2025, 2026])
    const pre = await fetchSalesForContracts(fakeClient({ ...TABLES, load_sales: { error: 'relation "public.load_sales" does not exist' } }, []), { cropYear: 2026 })
    expect(pre.sales).toEqual([])
    expect(pre.spots).toEqual([])
    expect(pre.deliveredByContract.get('K')!.count).toBe(1)
    expect(pre.unassigned.map((l) => l.id).sort()).toEqual(['L084', 'L289', 'L302', 'L508', 'L509', 'PL', 'none'])
  })
})
