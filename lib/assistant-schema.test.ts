// CI gate: the data assistant's schema digest covers EVERY tenant table.
//
// The digest is generated from the migrations (scripts/build-assistant-
// schema.mjs) with the tenant list taken from supabase/054_org_isolation.sql
// — the canonical org_id table set the multi-tenant verify scripts use. This
// test re-derives that list straight from the SQL and fails if any table is
// absent from the generated digest, has no columns, or has no description —
// so "the assistant can't see the cotton contracts" can never happen again
// by omission. Same discipline as the help-coverage gate.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_SCHEMA_SUMMARY, ASSISTANT_SCHEMA_TABLES } from '@/lib/assistant-schema'

function tenantTablesFrom054(): string[] {
  const sql = readFileSync(join(process.cwd(), 'supabase', '054_org_isolation.sql'), 'utf8')
  const start = sql.indexOf('foreach t in array array[')
  const end = sql.indexOf('] loop', start)
  expect(start).toBeGreaterThan(0)
  return [...sql.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

// The modules the old hand-written digest left out or lumped together — the
// screenshot's "cotton sales contract" miss was the symptom. Each must be a
// first-class line with real columns now.
const PREVIOUSLY_MISSING = [
  'cotton_sales_contracts', 'cotton_pool_payments', 'ccc_loans', 'ccc_loan_bales', 'cotton_ldp_records', 'cotton_ldp_bales',
  'cotton_bale_dispositions', 'cotton_fees', 'cotton_fee_schedule', 'gin_receipts', 'gin_receipt_loads', 'cotton_bales', 'cotton_bale_grades', 'gins',
  'seed_contract_details', 'seed_contract_premiums', 'seed_pricing_elections', 'seed_contract_payments', 'seed_contract_plantings',
  'settlement_discount_items', 'bin_transfers', 'combine_yield_entries', 'lease_terms', 'rent_settlements',
  'budget_scenarios', 'budget_lines', 'dryer_settings', 'org_dryers', 'freight_settings', 'freight_distances',
  'buyer_discount_schedules', 'buyer_discount_schedule_rules', 'hedge_position_events', 'manual_market_quotes',
]

describe('assistant schema digest — coverage gate', () => {
  const tenant = tenantTablesFrom054()
  const byName = new Map(ASSISTANT_SCHEMA_TABLES.map((t) => [t.name, t]))

  it('reads the canonical tenant list from 054 (sanity)', () => {
    expect(tenant.length).toBeGreaterThan(70)
    expect(tenant).toContain('cotton_sales_contracts')
    expect(tenant).toContain('hedge_position_events')
  })

  it('every tenant table is in the digest with columns and a description', () => {
    const missing = tenant.filter((t) => !byName.has(t))
    expect(missing, `tenant tables missing from the digest: ${missing.join(', ')}`).toEqual([])
    for (const t of tenant) {
      const meta = byName.get(t)!
      expect(meta.kind).toBe('tenant')
      expect(meta.columns.length, `${t} has no parsed columns`).toBeGreaterThan(0)
      expect(meta.description.length, `${t} has no description`).toBeGreaterThan(10)
      expect(meta.help_route, `${t} has no help route`).toMatch(/^\//)
      expect(ASSISTANT_SCHEMA_SUMMARY, `${t} is not in the digest text`).toMatch(new RegExp(`^- ${t}\\(`, 'm'))
    }
  })

  it('the digest contains nothing that is not a tenant or reference table', () => {
    for (const meta of ASSISTANT_SCHEMA_TABLES) {
      if (meta.kind === 'tenant') expect(tenant).toContain(meta.name)
    }
  })

  it('the previously omitted modules are first-class lines with real columns', () => {
    for (const t of PREVIOUSLY_MISSING) {
      const meta = byName.get(t)
      expect(meta, `${t} missing`).toBeDefined()
      expect(meta!.columns.length).toBeGreaterThan(1)
    }
    // The screenshot case: a cotton sales contract's buyer, bales and pricing are visible.
    const csc = byName.get('cotton_sales_contracts')!
    for (const c of ['buyer_id', 'committed_bales', 'price_cents_per_lb', 'pricing_status', 'contract_type', 'crop_year']) expect(csc.columns).toContain(c)
    expect(byName.get('cotton_bale_dispositions')!.columns).toContain('contract_id')
  })

  it('carries the unit conventions and key relationships the model needs', () => {
    expect(ASSISTANT_SCHEMA_SUMMARY).toMatch(/CENTS PER LB/)
    expect(ASSISTANT_SCHEMA_SUMMARY).toMatch(/POUNDS/)
    expect(ASSISTANT_SCHEMA_SUMMARY).toMatch(/buyer_id→buyers/)
    expect(ASSISTANT_SCHEMA_SUMMARY).toMatch(/- counties\(/)
    expect(ASSISTANT_SCHEMA_SUMMARY).toMatch(/every module's data is reachable/i)
  })
})
