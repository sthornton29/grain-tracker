// The ops actions (2026-11-09; turnrow-farm docs/OPS_ACTIONS.md): the write
// token's door (503 unset, 401 wrong, the read token refused), the preview's
// shape and fingerprint, apply (stale 409 when the records moved, replay by
// key, every call logged), and the rules kept: a seed contract, bushels below
// what is delivered, irrigated above planted and a planting Turnrow Farm
// manages are all refused. Every query is scoped to the organization.
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkOpsAuth, checkOpsWriteAuth } from './auth'
import { actionIndex, applyAction, previewAction } from './actions'

type Row = Record<string, unknown>

// A PostgREST-shaped fake with writes: filters, ilike, range, limit,
// maybeSingle, insert (the applied-key unique index on ops_action_log) and
// update. Records any read or write without an org_id filter.
function fakeClient(tables: Record<string, Row[]>, unscoped: string[]) {
  const UNTENANTED = new Set(['field_planting_varieties'])
  return {
    from(table: string) {
      tables[table] ??= []
      const rows = tables[table]
      const preds: Array<(r: Row) => boolean> = []
      let scoped = false
      let lo = 0, hi = Infinity
      let mode: 'select' | 'update' | 'insert' = 'select'
      let patch: Row = {}
      let inserted: Row[] = []
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { if (c === 'org_id') scoped = true; preds.push((r) => r[c] === v); return q },
        neq: (c: string, v: unknown) => { preds.push((r) => r[c] !== v); return q },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return q },
        ilike: (c: string, v: string) => { preds.push((r) => String(r[c] ?? '').toLowerCase() === v.toLowerCase()); return q },
        order: () => q,
        range: (a: number, b: number) => { lo = a; hi = b + 1; return q },
        limit: (n: number) => { hi = Math.min(hi, lo + n); return q },
        update: (p: Row) => { mode = 'update'; patch = p; return q },
        insert: (r: Row | Row[]) => { mode = 'insert'; inserted = Array.isArray(r) ? r : [r]; return q },
        maybeSingle: () => run().then((r) => ({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error })),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
      }
      const run = (): Promise<{ data: unknown; error: { message: string } | null }> => {
        if (mode === 'insert') {
          for (const r of inserted) {
            if (!r.org_id) unscoped.push(`${table} insert`)
            if (table === 'ops_action_log' && r.outcome === 'applied' && rows.some((x) => x.org_id === r.org_id && x.key === r.key && x.outcome === 'applied')) {
              return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "ops_action_log_applied_key"' } })
            }
            rows.push({ id: `log-${rows.length + 1}`, ...r })
          }
          return Promise.resolve({ data: null, error: null })
        }
        if (!scoped && !UNTENANTED.has(table)) unscoped.push(`${table} ${mode}`)
        const m = rows.filter((r) => preds.every((p) => p(r)))
        if (mode === 'update') { for (const r of m) Object.assign(r, patch); return Promise.resolve({ data: null, error: null }) }
        return Promise.resolve({ data: m.slice(lo, hi).map((r) => ({ ...r })), error: null })
      }
      return q
    },
  } as unknown as SupabaseClient
}

const ORG = 'org-1'
const NOW = new Date('2026-11-09T15:00:00Z')
const o = (r: Row) => ({ org_id: ORG, ...r })
const C1 = '11111111-1111-4111-8111-111111111111'
const F1 = '22222222-2222-4222-8222-222222222222'
const WHEAT = '33333333-3333-4333-8333-333333333333'

function grain(): Record<string, Row[]> {
  return {
    crops: [o({ id: WHEAT, name: 'Wheat', base_moisture_pct: 13.5, base_lb_per_bushel: 60, harvest_category: 'summer' })],
    buyers: [o({ id: 'b1', name: 'Woodall Grain' })],
    contracts: [
      o({ id: C1, contract_number: '90894', buyer_id: 'b1', crop_id: WHEAT, crop_year: 2026, contracted_bushels: 3000, delivery_start_date: '2026-06-01', delivery_end_date: '2026-07-31', completed_at: null, contract_kind: 'grain' }),
      o({ id: 'seed-1', contract_number: 'S-1', buyer_id: 'b1', crop_id: WHEAT, crop_year: 2026, contracted_bushels: 100, delivery_start_date: null, delivery_end_date: null, completed_at: null, contract_kind: 'seed' }),
      // another organization's contract with the same number is never seen
      { org_id: 'org-2', id: 'other', contract_number: '90894', crop_year: 2026, contracted_bushels: 1, contract_kind: 'grain' },
    ],
    // 1,154 bu delivered: one load on a 094 sale row, one on the pre-094 fallback.
    loads: [
      o({ id: 'l1', crop_id: WHEAT, net_weight: null, moisture: null, dry_bushels_override: 1000, contract_id: null, to_type: 'buyer' }),
      o({ id: 'l2', crop_id: WHEAT, net_weight: null, moisture: null, dry_bushels_override: 154, contract_id: C1, to_type: 'buyer' }),
    ],
    load_sales: [o({ id: 's1', load_id: 'l1', sale_type: 'contract', contract_id: C1, share: 1 })],
    farms: [o({ id: 'farm-1', name: 'River' })],
    fields: [o({ id: F1, name: 'River South', farm_id: 'farm-1' })],
    field_plantings: [
      o({ id: 'p1', field_id: F1, crop_id: WHEAT, season_year: 2026, planted_acres: 276.2, irrigated_acres: 276.2, dryland_acres: 0, managed_by: null }),
    ],
    field_planting_varieties: [{ planting_id: 'p1', acres: 200 }],
    farm_links: [],
    ops_action_log: [],
  }
}

describe('the write token', () => {
  it('is closed until set, takes only the write token, and never the read token', () => {
    expect(checkOpsWriteAuth('Bearer w', {})).toMatchObject({ ok: false, status: 503, error: 'Ops actions are not configured.' })
    expect(checkOpsWriteAuth(null, { OPS_WRITE_TOKEN: 'write-1' })).toMatchObject({ ok: false, status: 401 })
    expect(checkOpsWriteAuth('Bearer read-1', { OPS_TOKEN: 'read-1', OPS_WRITE_TOKEN: 'write-1' })).toMatchObject({ ok: false, status: 401 })
    expect(checkOpsWriteAuth('Bearer write-1', { OPS_TOKEN: 'read-1', OPS_WRITE_TOKEN: 'write-1' })).toEqual({ ok: true })
    expect(checkOpsWriteAuth('Bearer write-2', { OPS_WRITE_TOKEN: 'write-1', OPS_WRITE_TOKEN_NEXT: 'write-2' })).toEqual({ ok: true })
    // The same value set as both: the write routes stay shut.
    expect(checkOpsWriteAuth('Bearer same', { OPS_TOKEN: 'same', OPS_WRITE_TOKEN: 'same' })).toMatchObject({ status: 503 })
    // And the write token does not open the read routes.
    expect(checkOpsAuth('Bearer write-1', { OPS_TOKEN: 'read-1', OPS_WRITE_TOKEN: 'write-1' })).toMatchObject({ ok: false, status: 401 })
  })
})

describe('the actions', () => {
  it('lists three to eight, each described with its params', () => {
    const idx = actionIndex()
    expect(idx.app).toBe('grain')
    expect(idx.actions.length).toBeGreaterThanOrEqual(3)
    expect(idx.actions.length).toBeLessThanOrEqual(8)
    for (const a of idx.actions) { expect(a.description).toBeTruthy(); expect(a.params.length).toBeGreaterThan(0) }
  })

  it('previews closing the Woodall contract with its delivered bushels, writing nothing', async () => {
    const t = grain(), unscoped: string[] = []
    const p = await previewAction(fakeClient(t, unscoped), ORG, { action: 'complete_contract', params: { contract: '90894' } }, NOW)
    expect(p).toMatchObject({ app: 'grain', action: 'complete_contract', changes: 1, params: { contract: C1, crop_year: 2026, completed: true } })
    expect(p.headline).toBe('Contract 90894 with Woodall Grain (2026 Wheat): would be marked complete with 1,846 bu undelivered.')
    expect(p.rows[2]).toEqual(['Delivered bushels', 1154, 1154])
    expect(p.fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(p.url).toBe(`https://turnrowgrain.com/contracts/${C1}`)
    expect(t.contracts[0].completed_at).toBeNull()
    expect(t.ops_action_log).toHaveLength(0)
    expect(unscoped).toEqual([])
    // Same records, same params: same fingerprint.
    const again = await previewAction(fakeClient(t, unscoped), ORG, { action: 'complete_contract', params: p.params }, NOW)
    expect(again.fingerprint).toBe(p.fingerprint)
  })

  it('applies with the fingerprint, logs it, and replays the same key without writing again', async () => {
    const t = grain(), unscoped: string[] = []
    const sb = fakeClient(t, unscoped)
    const p = await previewAction(sb, ORG, { action: 'set_contracted_bushels', params: { contract: '90894', contracted_bushels: 1154 } }, NOW)
    expect(p.changes).toBe(1)
    const a = await applyAction(sb, ORG, { action: p.action, params: p.params, fingerprint: p.fingerprint, key: 'prop-1', approved_by: 'Stuart <stuart@turnrow.farm>' }, NOW)
    expect(a.status).toBe(200)
    expect(a.body).toMatchObject({ applied: true, key: 'prop-1', result: { contracted_bushels: 1154 } })
    expect(t.contracts[0].contracted_bushels).toBe(1154)
    expect(t.ops_action_log).toHaveLength(1)
    expect(t.ops_action_log[0]).toMatchObject({ org_id: ORG, key: 'prop-1', outcome: 'applied', approved_by: 'Stuart <stuart@turnrow.farm>' })
    // Replay: the old fingerprint no longer matches the records, but the key wins.
    t.contracts[0].contracted_bushels = 999999
    const r = await applyAction(sb, ORG, { action: p.action, params: p.params, fingerprint: p.fingerprint, key: 'prop-1', approved_by: 'x' }, NOW)
    expect(r).toMatchObject({ status: 200, body: { replay: true, applied: true } })
    expect(t.contracts[0].contracted_bushels).toBe(999999)
    expect(t.ops_action_log).toHaveLength(1)
    expect(unscoped).toEqual([])
  })

  it('answers 409 stale when the records moved since the preview, and changes nothing', async () => {
    const t = grain(), unscoped: string[] = []
    const sb = fakeClient(t, unscoped)
    const p = await previewAction(sb, ORG, { action: 'set_contract_window', params: { contract: C1, delivery_end_date: '2026-12-31' } }, NOW)
    t.contracts[0].delivery_end_date = '2026-08-15' // someone edited it in the meantime
    const a = await applyAction(sb, ORG, { action: p.action, params: p.params, fingerprint: p.fingerprint, key: 'prop-2', approved_by: 'Stuart' }, NOW)
    expect(a.status).toBe(409)
    expect(a.body).toMatchObject({ stale: true })
    expect((a.body.preview as { rows: unknown[][] }).rows[1]).toEqual(['Delivery ends', '2026-08-15', '2026-12-31'])
    expect(t.contracts[0].delivery_end_date).toBe('2026-08-15')
    expect(t.ops_action_log[0]).toMatchObject({ key: 'prop-2', outcome: 'stale' })
    // A stale key may be tried again with a fresh preview.
    const fresh = a.body.preview as { fingerprint: string; params: Record<string, unknown> }
    const b = await applyAction(sb, ORG, { action: 'set_contract_window', params: fresh.params, fingerprint: fresh.fingerprint, key: 'prop-2', approved_by: 'Stuart' }, NOW)
    expect(b.status).toBe(200)
    expect(t.contracts[0].delivery_end_date).toBe('2026-12-31')
  })

  it('keeps Grain\'s rules: seed contracts, bushels below delivered, a window ending before it starts', async () => {
    const t = grain(), unscoped: string[] = []
    const sb = fakeClient(t, unscoped)
    await expect(previewAction(sb, ORG, { action: 'set_contract_window', params: { contract: 'S-1', delivery_end_date: '2026-12-31' } }, NOW)).rejects.toMatchObject({ status: 422 })
    await expect(previewAction(sb, ORG, { action: 'set_contracted_bushels', params: { contract: '90894', contracted_bushels: 1000 } }, NOW)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('1,154 bu are already delivered') })
    await expect(previewAction(sb, ORG, { action: 'set_contract_window', params: { contract: '90894', delivery_end_date: '2026-05-01' } }, NOW)).rejects.toMatchObject({ status: 422 })
    await expect(previewAction(sb, ORG, { action: 'set_contract_window', params: { contract: '90894', delivery_end_date: 'soon' } }, NOW)).rejects.toMatchObject({ status: 400 })
    await expect(previewAction(sb, ORG, { action: 'drop_tables', params: {} }, NOW)).rejects.toMatchObject({ status: 400 })
    // A refused apply is logged as refused and changes nothing.
    const a = await applyAction(sb, ORG, { action: 'set_contracted_bushels', params: { contract: '90894', contracted_bushels: 10 }, fingerprint: 'x', key: 'prop-3', approved_by: 'Stuart' }, NOW)
    expect(a.status).toBe(422)
    expect(t.ops_action_log[0]).toMatchObject({ key: 'prop-3', outcome: 'refused' })
    expect(t.contracts[0].contracted_bushels).toBe(3000)
  })

  it('corrects a planting\'s acres within the Plantings page\'s rules', async () => {
    const t = grain(), unscoped: string[] = []
    const sb = fakeClient(t, unscoped)
    const p = await previewAction(sb, ORG, { action: 'set_planting_acres', params: { field: 'River South', farm: 'River', crop: 'Wheat', season_year: 2026, irrigated_acres: 235.5 } }, NOW)
    expect(p).toMatchObject({ changes: 1, params: { field: F1, crop: WHEAT, season_year: 2026, planted_acres: 276.2, irrigated_acres: 235.5 } })
    expect(p.rows[2]).toEqual(['Dryland acres', 0, 40.7])
    await expect(previewAction(sb, ORG, { action: 'set_planting_acres', params: { field: 'River South', crop: 'Wheat', season_year: 2026, irrigated_acres: 300 } }, NOW)).rejects.toMatchObject({ status: 422 })
    await expect(previewAction(sb, ORG, { action: 'set_planting_acres', params: { field: 'River South', crop: 'Wheat', season_year: 2026, planted_acres: 150, irrigated_acres: 0 } }, NOW)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('varieties') })
    const a = await applyAction(sb, ORG, { action: p.action, params: p.params, fingerprint: p.fingerprint, key: 'prop-4', approved_by: 'Stuart' }, NOW)
    expect(a.status).toBe(200)
    expect(t.field_plantings[0]).toMatchObject({ planted_acres: 276.2, irrigated_acres: 235.5, dryland_acres: 40.7 })
    expect(unscoped).toEqual([])
  })

  it('refuses a planting Turnrow Farm manages (the Farm link\'s lock)', async () => {
    const t = grain(), unscoped: string[] = []
    t.field_plantings[0].managed_by = 'turnrow_farm'
    t.farm_links = [o({ id: 'link', status: 'active', scopes: ['land:write'], last_sync: { inbound: { at: '2026-11-08T00:00:00Z' } }, created_at: '2026-10-01' })]
    const sb = fakeClient(t, unscoped)
    await expect(previewAction(sb, ORG, { action: 'set_planting_acres', params: { field: 'River South', crop: 'Wheat', season_year: 2026, irrigated_acres: 235.5 } }, NOW)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('managed in Turnrow Farm') })
    expect(t.field_plantings[0].irrigated_acres).toBe(276.2)
  })
})
