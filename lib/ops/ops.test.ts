// The ops API (2026-11-08): the token gate (503 unset, 401 missing or wrong,
// OPS_TOKEN_NEXT accepted for a rotation), OPS_ORG as an id or a slug, the
// brief's envelope and its to-dos from a small in-memory organization (a
// load with no sale type, an unpaid load, a settlement line not matched, a
// contract past its window, an option about to expire, a revoked Farm
// link), every query scoped to the organization, and a dataset read.
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkOpsAuth, orgFilter } from './auth'
import { buildOpsBrief } from './brief'
import { BadParam, DATASETS, readDataset } from './data'

type Row = Record<string, unknown>

// A PostgREST-shaped fake: filters, range, limit, maybeSingle, head counts.
// It records every table read without an org_id filter (tenant leak check).
function fakeClient(tables: Record<string, Row[]>, unscoped: string[]) {
  const UNTENANTED = new Set(['organizations', 'covered_commodities', 'farm_link_calls'])
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const preds: Array<(r: Row) => boolean> = []
      let scoped = false
      let lo = 0, hi = Infinity, head = false
      const q: Record<string, unknown> = {
        select: (_c?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return q },
        eq: (c: string, v: unknown) => { if (c === 'org_id') scoped = true; preds.push((r) => r[c] === v); return q },
        neq: (c: string, v: unknown) => { preds.push((r) => r[c] !== v); return q },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return q },
        is: (c: string, v: null) => { preds.push((r) => (r[c] ?? null) === v); return q },
        not: (c: string, _op: string, v: null) => { preds.push((r) => (r[c] ?? null) !== v); return q },
        lt: (c: string, v: string) => { preds.push((r) => r[c] != null && String(r[c]) < String(v)); return q },
        lte: (c: string, v: string) => { preds.push((r) => r[c] != null && String(r[c]) <= String(v)); return q },
        gte: (c: string, v: string | number) => { preds.push((r) => r[c] != null && (typeof v === 'number' ? Number(r[c]) >= v : String(r[c]) >= v)); return q },
        order: () => q,
        range: (a: number, b: number) => { lo = a; hi = b + 1; return q },
        limit: (n: number) => { hi = n; return q },
        maybeSingle: () => run().then((r) => ({ data: r.data?.[0] ?? null, error: null })),
        single: () => run().then((r) => ({ data: r.data?.[0] ?? null, error: null })),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
      }
      const run = () => {
        if (!scoped && !UNTENANTED.has(table)) unscoped.push(table)
        const m = rows.filter((r) => preds.every((p) => p(r)))
        return Promise.resolve(head ? { data: null, count: m.length, error: null } : { data: m.slice(lo, hi).map((r) => ({ ...r })), error: null })
      }
      return q
    },
  } as unknown as SupabaseClient
}

const ORG = 'org-1'
const NOW = new Date('2026-11-08T15:00:00Z')
const o = (r: Row) => ({ org_id: ORG, ...r })

function farm(): Record<string, Row[]> {
  return {
    crops: [o({ id: 'corn', name: 'Corn', base_moisture_pct: 15.5, base_lb_per_bushel: 56, harvest_category: 'fall' })],
    buyers: [o({ id: 'b1', name: 'Woodall Grain' })],
    entities: [o({ id: 'e1', name: 'View Celeste Farm LLC' })],
    loads: [
      // 56,000 lb at base moisture: 1,000 dry bushels each.
      o({ id: 'l1', date: '2026-10-01', crop_id: 'corn', crop_year: 2026, net_weight: 56000, moisture: 15.5, dry_bushels_override: null, from_type: 'field', to_type: 'buyer', to_buyer_id: 'b1', contract_id: null, ticket_number: 'T1' }),
      o({ id: 'l2', date: '2026-10-02', crop_id: 'corn', crop_year: 2026, net_weight: 56000, moisture: 15.5, dry_bushels_override: null, from_type: 'field', to_type: 'buyer', to_buyer_id: 'b1', contract_id: 'c1', ticket_number: 'T2' }),
      o({ id: 'l3', date: '2026-11-07', crop_id: 'corn', crop_year: 2026, net_weight: 56000, moisture: 15.5, dry_bushels_override: null, from_type: 'field', to_type: 'bin', to_buyer_id: null, contract_id: null, ticket_number: 'T3' }),
    ],
    load_sales: [],
    settlement_lines: [o({ id: 's1l1', settlement_id: 's1', load_id: null, net_bushels: 990 })],
    settlements: [o({ id: 's1', settlement_number: '77232', settlement_date: '2026-10-20', buyer_id: 'b1' })],
    contracts: [o({ id: 'c1', contract_number: 'W-100', buyer_id: 'b1', crop_id: 'corn', entity_id: 'e1', crop_year: 2026, contracted_bushels: 5000, pricing_status: 'fully_priced', delivery_end_date: '2026-10-31', completed_at: null, contract_kind: 'grain' })],
    options_positions: [o({ id: 'op1', option_type: 'put', side: 'buy', strike_price: 4.4, num_contracts: 5, underlying_contract_month: 'Dec 26', expiration_date: '2026-11-20', commodity: 'corn', status: 'open' })],
    futures_positions: [o({ id: 'f1', status: 'open' })],
    ccc_loans: [], cotton_sales_contracts: [], arc_plc_payments: [],
    farm_links: [o({ id: 'link1', status: 'revoked', last_seen_at: null })],
    farm_link_calls: [],
    organizations: [{ id: ORG, slug: 'turnrow-farm' }],
  }
}

describe('the ops token', () => {
  it('is closed until configured, then wants the exact token', () => {
    expect(checkOpsAuth('Bearer x', {})).toEqual({ ok: false, status: 503, error: 'The ops API is not configured.' })
    expect(checkOpsAuth(null, { OPS_TOKEN: 'secret-1' })).toMatchObject({ ok: false, status: 401 })
    expect(checkOpsAuth('Bearer secret-2', { OPS_TOKEN: 'secret-1' })).toMatchObject({ ok: false, status: 401 })
    expect(checkOpsAuth('Bearer secret-1', { OPS_TOKEN: 'secret-1' })).toEqual({ ok: true })
    expect(checkOpsAuth('bearer  secret-2 ', { OPS_TOKEN: 'secret-1', OPS_TOKEN_NEXT: 'secret-2' })).toEqual({ ok: true })
  })
  it('reads OPS_ORG as an id or a slug', () => {
    expect(orgFilter('turnrow-farm')).toEqual({ column: 'slug', value: 'turnrow-farm' })
    expect(orgFilter('3f1c7580-0000-4000-8000-000000000001')).toMatchObject({ column: 'id' })
    expect(orgFilter(' ')).toBeNull()
  })
})

describe('buildOpsBrief', () => {
  it('lists what needs doing in the shared envelope, scoped to the organization', async () => {
    const unscoped: string[] = []
    const b = await buildOpsBrief(fakeClient(farm(), unscoped), ORG, NOW)
    expect(Object.keys(b).sort()).toEqual(['alerts', 'app', 'as_of', 'generated_at', 'label', 'lists', 'metrics', 'notes', 'todos'])
    expect(b.app).toBe('grain')
    const text = b.todos.map((t) => t.text).join('\n')
    expect(text).toContain('Pick contract, spot or price later for 1 load delivered to buyers (1,000 bu)')
    expect(text).toContain('2 buyer loads delivered more than three weeks ago are on no settlement yet (2,000 bu; Woodall Grain 2)')
    expect(text).toContain('Match 1 line on Woodall Grain settlement 77232')
    expect(text).toContain('Finish or close contract W-100 with Woodall Grain (2026 Corn): 4,000 bu of 5,000 bu left')
    expect(text).toContain('5 long corn Dec 26 4.4 puts')
    // Overdue first; every url absolute.
    expect(b.todos[0].status).toBe('overdue')
    expect(b.todos.every((t) => t.url.startsWith('https://turnrowgrain.com/'))).toBe(true)
    expect(b.alerts.map((a) => a.text)).toContain('The Turnrow Farm link is revoked.')
    expect(b.metrics.find((m) => m.key === 'delivered-Corn')?.value).toBe(2000)
    expect(b.lists[0].rows[0]).toEqual(['W-100', 'Woodall Grain', 'Corn', 2026, 5000, 4000, '2026-10-31', 'priced'])
    expect(unscoped).toEqual([])
  })
})

describe('readDataset', () => {
  it('reads positions by crop and refuses an unknown dataset', async () => {
    const unscoped: string[] = []
    const r = await readDataset(fakeClient(farm(), unscoped), ORG, 'positions', { crop_year: '2026' }, NOW)
    const row = Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0][i]]))
    expect(row).toMatchObject({ crop: 'Corn', harvested_bu: 3000, harvested_into_bins_bu: 1000, delivered_to_buyers_bu: 2000, on_contracts_bu: 1000, no_sale_type_bu: 1000, contracted_bu: 5000, contracted_not_delivered_bu: 4000 })
    expect(unscoped).toEqual([])
    await expect(readDataset(fakeClient(farm(), []), ORG, 'nope', {}, NOW)).rejects.toThrow(BadParam)
    await expect(readDataset(fakeClient(farm(), []), ORG, 'positions', { crop_year: 'soon' }, NOW)).rejects.toThrow(/crop_year/)
    expect(DATASETS.length).toBeGreaterThanOrEqual(5)
  })
})

describe('the routes', () => {
  it('answer 503 unconfigured, 401 on a wrong token, 405 on a write', async () => {
    const { NextRequest } = await import('next/server')
    const brief = await import('../../app/api/ops/brief/route')
    const data = await import('../../app/api/ops/data/route')
    const saved = { t: process.env.OPS_TOKEN, n: process.env.OPS_TOKEN_NEXT }
    try {
      delete process.env.OPS_TOKEN; delete process.env.OPS_TOKEN_NEXT
      const r1 = await brief.GET(new NextRequest('https://turnrowgrain.com/api/ops/brief', { headers: { authorization: 'Bearer x' } }))
      expect(r1.status).toBe(503)
      process.env.OPS_TOKEN = 'secret-1'
      const r2 = await data.GET(new NextRequest('https://turnrowgrain.com/api/ops/data', { headers: { authorization: 'Bearer wrong' } }))
      expect(r2.status).toBe(401)
      expect(r2.headers.get('cache-control')).toBe('no-store')
      expect((await brief.POST()).status).toBe(405)
    } finally {
      if (saved.t === undefined) delete process.env.OPS_TOKEN; else process.env.OPS_TOKEN = saved.t
      if (saved.n !== undefined) process.env.OPS_TOKEN_NEXT = saved.n
    }
  })
})
