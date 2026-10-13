// The shared spot/price-later assembly (094): the pure shaping in
// lib/spot-contracts.ts and the server loader in lib/spot-contracts-server.ts
// over a fake Supabase client. Fixture: Bunge 0000205995 — five spot loads
// (4,793.900 bu, $65,528.26, avg 13.669093) beside contract 2002960604-10.

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildSpotInputs, emptySpotInputs, fieldEntityMap, loadDryBushels, marketingAgentEntityId, priceLaterPoolLabel,
  spotContractLabel, spotForBuyer, splitsByLoad, toSaleSourceLoads, type SpotLoadRecord,
} from '@/lib/spot-contracts'
import { loadSpotInputs } from '@/lib/spot-contracts-server'
import type { LoadSale } from '@/lib/load-sales'
import type { Contract } from '@/lib/types'

const SOY = { id: 'soy', base_moisture_pct: 13, base_lb_per_bushel: 60 }

const SPOT = [
  { id: 'L289', date: '2026-09-25', bu: 912.744, price: 13.74 },
  { id: 'L302', date: '2026-09-25', bu: 959.926, price: 13.74 },
  { id: 'L508', date: '2026-09-26', bu: 1026, price: 13.74 },
  { id: 'L509', date: '2026-09-26', bu: 951, price: 13.74 },
  { id: 'L084', date: '2026-09-28', bu: 944.23, price: 13.38 },
]

function load(over: Partial<SpotLoadRecord> & Pick<SpotLoadRecord, 'id'>): SpotLoadRecord {
  return {
    date: '2026-09-25', crop_id: 'soy', crop_year: 2026, net_weight: null, moisture: null, dry_bushels_override: null,
    from_type: 'field', from_field_id: 'fieldA', to_type: 'buyer', to_buyer_id: 'bunge', contract_id: null, ticket_number: null, buyer_ticket_number: null,
    ...over,
  }
}
function sale(over: Partial<LoadSale> & Pick<LoadSale, 'load_id' | 'sale_type' | 'share'>): LoadSale {
  return { id: `s-${over.load_id}-${over.sale_type}`, contract_id: null, buyer_net_bushels: null, spot_price: null, spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null, ...over }
}

const spotLoads = SPOT.map((s) => load({ id: s.id, date: s.date, dry_bushels_override: s.bu }))
const spotSales = SPOT.map((s) => sale({ load_id: s.id, sale_type: 'spot', share: 1, spot_price: s.price, spot_price_source: 'settlement' }))
const AGENT = [{ id: 'VCF', entity_role: 'farming' }, { id: 'TRW', entity_role: 'marketing_agent' }]

describe('toSaleSourceLoads — dry bushels with the load\'s crop bases', () => {
  it('shrinks 55,000 lb of 14% soybeans to base 13% at 60 lb/bu (906.1 bu); an override wins; bin loads are left out', () => {
    const wet = load({ id: 'w', net_weight: 55000, moisture: 14 })
    expect(loadDryBushels(wet, SOY)).toBeCloseTo((55000 / 60) * (86 / 87), 3)
    const rows = toSaleSourceLoads([wet, load({ id: 'o', net_weight: 55000, moisture: 14, dry_bushels_override: 900 }), load({ id: 'bin', to_type: 'bin', to_buyer_id: null, dry_bushels_override: 500 })], [SOY])
    expect(rows.map((r) => r.id)).toEqual(['w', 'o'])
    expect(rows[1].dryBu).toBe(900)
    expect(rows[0]).toMatchObject({ crop_id: 'soy', crop_year: 2026, to_buyer_id: 'bunge', to_type: 'buyer', from_field_id: 'fieldA', from_type: 'field' })
  })

  it('a load whose crop has no bases still carries its override (and otherwise 0)', () => {
    expect(loadDryBushels(load({ id: 'x', net_weight: 55000, dry_bushels_override: 912.744 }), null)).toBe(912.744)
    expect(loadDryBushels(load({ id: 'y', net_weight: 55000 }), null)).toBe(0)
  })
})

describe('attribution inputs', () => {
  it('marketingAgentEntityId: the entity with entity_role marketing_agent, else null', () => {
    expect(marketingAgentEntityId(AGENT)).toBe('TRW')
    expect(marketingAgentEntityId([{ id: 'VCF', entity_role: 'farming' }])).toBeNull()
  })
  it('fieldEntityMap goes field → farm → entity; splitsByLoad turns percentage into a fraction', () => {
    const fe = fieldEntityMap([{ id: 'fv', farm_id: 'F-V' }, { id: 'fx', farm_id: null }], [{ id: 'F-V', entity_id: 'VCF' }])
    expect(fe.get('fv')).toBe('VCF')
    expect(fe.get('fx')).toBeNull()
    const sb = splitsByLoad([{ load_id: 'L1', field_id: 'fv', percentage: 60 }, { load_id: 'L1', field_id: 'ft', percentage: '40' }, { load_id: 'L2', field_id: 'fv', percentage: 0 }])
    expect(sb.get('L1')).toEqual([{ field_id: 'fv', fraction: 0.6 }, { field_id: 'ft', fraction: 0.4 }])
    expect(sb.has('L2')).toBe(false)
  })
})

describe('buildSpotInputs', () => {
  it('with a marketing agent: ONE spot contract per crop × year held by the agent — Bunge 4,793.900 bu, $65,528.26, avg 13.669093', () => {
    const inputs = buildSpotInputs({ loads: spotLoads, sales: spotSales, crops: [SOY], entities: AGENT })
    expect(inputs.marketingAgentEntityId).toBe('TRW')
    expect(inputs.spots).toHaveLength(1)
    const [spot] = inputs.spots
    expect(spot).toMatchObject({ id: 'spot:soy:2026:TRW', entity_id: 'TRW', crop_year: 2026 })
    expect(spot.bushels).toBeCloseTo(4793.9, 3)
    expect(spot.revenue).toBeCloseTo(65528.26, 2)
    expect(spot.avgPrice).toBeCloseTo(13.669093, 6)
    expect(spot.summary.statusText).toBe('5 of 5 settled')
    expect(inputs.pools).toEqual([])
    expect(spotContractLabel(spot, () => 'Soybean')).toBe('Spot · Soybean 2026')
  })

  it('contractsWithSpot appends the spot contract as a fully priced forward after the real contracts', () => {
    const inputs = buildSpotInputs({ loads: spotLoads, sales: spotSales, crops: [SOY], entities: AGENT })
    const real = { id: 'K', contract_number: '2002960604-10', crop_id: 'soy', crop_year: 2026, contracted_bushels: 2059.757, cash_price: 12.71 } as Contract
    const out = inputs.contractsWithSpot([real])
    expect(out.map((c) => c.id)).toEqual(['K', 'spot:soy:2026:TRW'])
    expect(out[1]).toMatchObject({ contract_type: 'forward', pricing_status: 'fully_priced', source_label: 'Spot (5 loads)' })
    expect(out[1].contracted_bushels).toBeCloseTo(4793.9, 2)
  })

  it('without an agent: each spot load lands on its field\'s entity; a split-source load fans out 60/40', () => {
    const loads = [
      load({ id: 'a', from_field_id: 'fv', dry_bushels_override: 1000 }),
      load({ id: 'b', from_field_id: 'ft', dry_bushels_override: 500 }),
      load({ id: 'c', from_field_id: null, dry_bushels_override: 1000 }),
    ]
    const sales = loads.map((l) => sale({ load_id: l.id, sale_type: 'spot', share: 1, spot_price: 13, spot_price_source: 'settlement' }))
    const inputs = buildSpotInputs({
      loads, sales, crops: [SOY], entities: [{ id: 'VCF', entity_role: 'farming' }, { id: 'TSF', entity_role: 'farming' }],
      fields: [{ id: 'fv', farm_id: 'F-V' }, { id: 'ft', farm_id: 'F-T' }], farms: [{ id: 'F-V', entity_id: 'VCF' }, { id: 'F-T', entity_id: 'TSF' }],
      splits: [{ load_id: 'c', field_id: 'fv', percentage: 60 }, { load_id: 'c', field_id: 'ft', percentage: 40 }],
    })
    const byEntity = new Map(inputs.spots.map((s) => [s.entity_id, s.bushels]))
    expect(byEntity.get('VCF')).toBeCloseTo(1600, 6)
    expect(byEntity.get('TSF')).toBeCloseTo(900, 6)
    expect(inputs.spots).toHaveLength(2)
  })

  it('price-later rows build pools per crop × year × buyer; a split load contributes only its price-later share', () => {
    const loads = [load({ id: 'p1', date: '2026-09-20', dry_bushels_override: 1000 }), load({ id: 'p2', date: '2026-09-22', to_buyer_id: 'adm', dry_bushels_override: 800 })]
    const sales = [
      sale({ load_id: 'p1', sale_type: 'price_later', share: 1 }),
      sale({ load_id: 'p2', sale_type: 'price_later', share: 0.5 }),
      sale({ load_id: 'p2', sale_type: 'spot', share: 0.5, spot_price: 13, spot_price_source: 'entered' }),
    ]
    const inputs = buildSpotInputs({ loads, sales, crops: [SOY], entities: AGENT })
    expect(inputs.pools.map((p) => [p.buyer_id, p.bushels])).toEqual([['adm', 400], ['bunge', 1000]])
    expect(priceLaterPoolLabel(inputs.pools[1], () => 'Soybean', () => 'Bunge')).toBe('Price later · Soybean 2026 · Bunge')
    expect(inputs.spots[0].bushels).toBe(400)
  })

  it('no rows at all (a database before 094): a contract load is a full contract load, no spot, no pools', () => {
    const inputs = buildSpotInputs({ loads: [load({ id: 'k', contract_id: 'K', dry_bushels_override: 900 })], sales: [], crops: [SOY], entities: AGENT })
    expect(inputs.spots).toEqual([])
    expect(inputs.pools).toEqual([])
    expect(inputs.sourceLoads[0]).toMatchObject({ contract_id: 'K', dryBu: 900 })
    expect(emptySpotInputs().contractsWithSpot([{ id: 'K' } as Contract]).map((c) => c.id)).toEqual(['K'])
  })

  it('spotForBuyer narrows a spot contract to one buyer\'s loads (null when none)', () => {
    const loads = [...spotLoads, load({ id: 'adm1', to_buyer_id: 'adm', dry_bushels_override: 1000 })]
    const sales = [...spotSales, sale({ load_id: 'adm1', sale_type: 'spot', share: 1, spot_price: 13, spot_price_source: 'settlement' })]
    const [spot] = buildSpotInputs({ loads, sales, crops: [SOY], entities: AGENT }).spots
    expect(spot.bushels).toBeCloseTo(5793.9, 3)
    const bunge = spotForBuyer(spot, 'bunge')!
    expect(bunge.bushels).toBeCloseTo(4793.9, 3)
    expect(bunge.revenue).toBeCloseTo(65528.26, 2)
    expect(bunge.buyers.map((b) => b.buyerId)).toEqual(['bunge'])
    expect(spotForBuyer(spot, 'cargill')).toBeNull()
    expect(spotForBuyer(spot, null)).toBe(spot)
  })
})

// ---------- the server loader over a fake client ----------

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
    b.in = (col: string, vals: unknown[]) => { call.filters.push(`${col} in ${vals.length}`); if (rows) rows = rows.filter((r) => vals.includes(r[col])); return b }
    b.range = (f: number, t: number) => { if (rows) rows = rows.slice(f, t + 1); return b }
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(err ? { data: null, error: { message: err } } : { data: rows, error: null }).then(resolve)
    return b
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
}

const DB_LOADS: Row[] = [
  ...SPOT.map((s) => ({ id: s.id, date: s.date, crop_id: 'soy', crop_year: 2026, net_weight: null, moisture: null, dry_bushels_override: s.bu, from_type: 'field', from_field_id: 'fv', to_type: 'buyer', to_buyer_id: 'bunge', contract_id: null, ticket_number: null, buyer_ticket_number: null, org_id: 'org1' })),
  { id: 'K1', date: '2026-09-25', crop_id: 'soy', crop_year: 2026, net_weight: null, moisture: null, dry_bushels_override: 894.14, from_type: 'field', from_field_id: 'fv', to_type: 'buyer', to_buyer_id: 'bunge', contract_id: 'K', ticket_number: '0502248', buyer_ticket_number: null, org_id: 'org1' },
  { id: 'old', date: '2025-10-01', crop_id: 'soy', crop_year: 2025, net_weight: null, moisture: null, dry_bushels_override: 700, from_type: 'field', from_field_id: 'fv', to_type: 'buyer', to_buyer_id: 'bunge', contract_id: null, ticket_number: null, buyer_ticket_number: null, org_id: 'org1' },
]
const DB_SALES: Row[] = [
  ...spotSales.map((s) => ({ ...s, org_id: 'org1' })),
  { ...sale({ load_id: 'old', sale_type: 'spot', share: 1, spot_price: 10, spot_price_source: 'settlement' }), org_id: 'org1' },
]
const BASE_TABLES = {
  crops: [{ ...SOY, org_id: 'org1' }],
  entities: AGENT.map((e) => ({ ...e, org_id: 'org1' })),
  fields: [{ id: 'fv', farm_id: 'F-V', org_id: 'org1' }],
  farms: [{ id: 'F-V', entity_id: 'VCF', org_id: 'org1' }],
  load_splits: [],
}

describe('loadSpotInputs (server)', () => {
  it('fetches the year\'s buyer loads + their sale rows, scoped to the org, and builds the Bunge spot contract', async () => {
    const calls: Array<{ table: string; filters: string[] }> = []
    const out = await loadSpotInputs(fakeClient({ ...BASE_TABLES, loads: DB_LOADS, load_sales: DB_SALES }, calls), { org: 'org1', cropYear: 2026 })
    expect(out.spots).toHaveLength(1)
    expect(out.spots[0].bushels).toBeCloseTo(4793.9, 3)
    expect(out.spots[0].revenue).toBeCloseTo(65528.26, 2)
    expect(out.sourceLoads.map((l) => l.id)).not.toContain('old')
    // Every read scopes the org (service-role callers bypass RLS).
    for (const c of calls) expect(c.filters, `${c.table} unscoped`).toContain('org_id=org1')
    expect(calls.find((c) => c.table === 'loads')!.filters).toEqual(expect.arrayContaining(['crop_year=2026', 'to_type=buyer']))
  })

  it('without an org, nothing is scoped (the session\'s RLS decides)', async () => {
    const calls: Array<{ table: string; filters: string[] }> = []
    await loadSpotInputs(fakeClient({ ...BASE_TABLES, loads: DB_LOADS, load_sales: DB_SALES }, calls), { cropYear: 2026 })
    for (const c of calls) expect(c.filters.some((f) => f.startsWith('org_id='))).toBe(false)
  })

  it('a database before 094 (load_sales missing) reads as no sale rows: the contract load still counts, no spot', async () => {
    const calls: Array<{ table: string; filters: string[] }> = []
    const out = await loadSpotInputs(fakeClient({ ...BASE_TABLES, loads: DB_LOADS, load_sales: { error: 'relation "public.load_sales" does not exist' } }, calls), { org: 'org1', cropYear: 2026 })
    expect(out.sales).toEqual([])
    expect(out.spots).toEqual([])
    expect(out.sourceLoads.find((l) => l.id === 'K1')).toMatchObject({ contract_id: 'K', dryBu: 894.14 })
  })

  it('crops handed in are not fetched again', async () => {
    const calls: Array<{ table: string; filters: string[] }> = []
    await loadSpotInputs(fakeClient({ ...BASE_TABLES, loads: DB_LOADS, load_sales: DB_SALES }, calls), { org: 'org1', cropYear: 2026, crops: [SOY] })
    expect(calls.map((c) => c.table)).not.toContain('crops')
  })
})
