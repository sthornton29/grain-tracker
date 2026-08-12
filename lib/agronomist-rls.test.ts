import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Shape check on migration 061: the agronomist's readable-table allowlist
// must cover exactly the Yields surface — production data in, every
// financial table out. The migration select-blocks everything NOT in the
// array, so this test parses the AGRONOMIST_READABLE_TABLES array literal
// and pins both directions. If the Yields page starts reading a new table,
// add it to the migration AND here.

const sql = readFileSync(join(process.cwd(), 'supabase', '061_agronomist_role.sql'), 'utf8') // vitest runs from the repo root

function readableTables(): string[] {
  const marker = sql.indexOf('AGRONOMIST_READABLE_TABLES')
  expect(marker, 'marker comment missing from 061').toBeGreaterThan(-1)
  const arrayStart = sql.indexOf('array[', marker)
  const arrayEnd = sql.indexOf('];', arrayStart)
  expect(arrayStart, 'readable array literal missing from 061').toBeGreaterThan(-1)
  expect(arrayEnd).toBeGreaterThan(arrayStart)
  const body = sql.slice(arrayStart, arrayEnd)
  return Array.from(body.matchAll(/'([a-z_]+)'/g), (m) => m[1])
}

const READABLE = readableTables()

// The Yields page + drill-down read set (see app/yields/page.tsx and the
// components it mounts) plus the two shell tables every role reads.
const YIELDS_READ_SET = [
  'loads', 'load_splits', 'fields', 'farms', 'field_plantings',
  'field_planting_varieties', 'entities', 'crops', 'landowners', 'counties',
  'trucks', 'bins', 'buyers', 'crop_assumptions',
  'gin_receipts', 'gin_receipt_loads', 'cotton_bales', 'cotton_bale_grades', 'cotton_loads',
  'user_profiles', 'app_settings',
]

// Money tables an agronomist must NEVER select: contracts, settlements,
// hedging, insurance, government payments, budgets, fees, cotton marketing.
const FINANCIAL_TABLES = [
  'contracts', 'contract_attachments', 'settlements', 'settlement_lines',
  'futures_positions', 'options_positions',
  'crop_insurance_policies', 'crop_insurance_sco', 'crop_insurance_eco',
  'crop_insurance_stax', 'crop_insurance_mco',
  'farm_base_acres', 'arc_plc_elections', 'arc_plc_payments',
  'other_government_payments', 'payment_limit_config',
  'budget_scenarios', 'budget_lines',
  'cotton_sales_contracts', 'cotton_pool_payments', 'ccc_loans', 'ccc_loan_bales',
  'cotton_ldp_records', 'cotton_ldp_bales', 'cotton_fees', 'cotton_fee_schedule',
]

describe('agronomist RLS shape (061)', () => {
  it('the readable set is exactly the Yields surface', () => {
    expect([...READABLE].sort()).toEqual([...YIELDS_READ_SET].sort())
  })

  it('no financial table is readable', () => {
    for (const t of FINANCIAL_TABLES) {
      expect(READABLE, `${t} must not be agronomist-readable`).not.toContain(t)
    }
  })

  it('write-blocks cover every table and select-blocks cover everything outside the allowlist', () => {
    // The loop must iterate ALL of pg_tables (not a hand-typed list) so new
    // tables at apply time are covered, and must create the three write
    // blocks unconditionally plus the select block for non-readable tables.
    expect(sql).toMatch(/for t in select tablename from pg_tables where schemaname = 'public' loop/)
    for (const cmd of ['_agronomist_block_ins', '_agronomist_block_upd', '_agronomist_block_del', '_agronomist_block_sel']) {
      expect(sql).toContain(cmd)
    }
    expect(sql).toMatch(/if not \(t = any\(readable\)\) then/)
  })

  it('BOTH role constraints and the RPC accept agronomist', () => {
    // user_profiles AND organization_members — 053's sync trigger mirrors the
    // role into the membership row, so widening only one breaks assignment.
    expect(sql).toMatch(/alter table public\.user_profiles\s+add constraint user_profiles_role_check/)
    expect(sql).toMatch(/alter table public\.organization_members\s+add constraint organization_members_role_check/)
    const widened = sql.match(/check \(role in \('owner', 'gin', 'viewer', 'agronomist'\)\)/g) ?? []
    expect(widened).toHaveLength(2)
    expect(sql).toContain("new_role not in ('owner', 'gin', 'viewer', 'agronomist')")
  })
})
