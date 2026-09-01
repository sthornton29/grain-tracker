// CI gate: NO BARE READS OF GROWING TABLES — the permanent guard behind the
// 2026-09-01 harvest bug (lib/fetch-all-rows.ts tells the story). The
// project's PostgREST layer silently caps every request at ~1,000 rows, so
// an unpaginated `.select()` on a table that grows with the operation
// (loads, splits, settlement lines, plantings, positions, per-bale cotton
// tables, …) WILL eventually return an arbitrary subset with no error — on
// this account or any future account with years of history.
//
// This test parses the source tree like the other CI gates (help coverage,
// agronomist RLS): every `.from('<growing table>')` read must, within its
// call chain, either paginate (`.range(` — normally via fetchAllRows /
// allPaged / a local pager) or be provably bounded (a single-row/parent-id
// lookup, a head-only count, an explicit `.limit(`, or a write). Adding a
// new bare select on a listed table fails CI with the offending file:line.
//
// When a NEW table that grows per-event or per-year is added to the schema,
// add it to GROWING_TABLES here — that's part of the new-tenant-table
// checklist.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Tables that grow with the operation. Tier 1 grows per EVENT (unbounded in
// one season at scale); tier 2 accumulates per year and crosses 1,000 rows
// over an account's lifetime at 100k-load scale.
const GROWING_TABLES = [
  // per event
  'loads', 'load_splits', 'load_attachments',
  'settlements', 'settlement_lines', 'settlement_discount_items',
  'combine_yield_entries', 'bin_transfers', 'bin_inventory_adjustments',
  'gin_receipts', 'gin_receipt_loads', 'cotton_loads', 'cotton_bales',
  'cotton_bale_grades', 'cotton_bale_dispositions',
  'ccc_loan_bales', 'cotton_ldp_bales',
  'harvest_price_estimates', // grows daily during every discovery window
  // per year, unbounded over an account's lifetime
  'contracts', 'contract_attachments',
  'field_plantings', 'field_planting_varieties',
  'futures_positions', 'options_positions',
  'crop_insurance_policies', 'arc_plc_payments', 'other_government_payments',
  'cotton_sales_contracts', 'cotton_pool_payments', 'cotton_fees',
  'ccc_loans', 'cotton_ldp_records',
  'seed_contract_details', 'seed_contract_premiums', 'seed_pricing_elections',
  'seed_contract_payments', 'seed_contract_plantings',
  'lease_terms', 'rent_settlements',
] as const

// A read is fine when its chain (the window after `.from('t')`) shows any of:
const BOUNDED_MARKERS = [
  '.range(',        // paginated (fetchAllRows / allPaged / local pager)
  '.single()', '.maybeSingle()',
  'head: true',     // count-only probe
  '.limit(',        // an explicit, deliberate bound
  '.insert(', '.update(', '.upsert(', '.delete(', // writes
  // Bounded per-parent lookups (one record's children):
  ".eq('id'", ".in('id'",
  ".eq('load_id'", ".in('load_id'",
  ".eq('settlement_id'", ".in('settlement_id'",
  ".eq('contract_id'", ".in('contract_id'",
  ".eq('planting_id'", ".in('planting_id'",
  ".eq('bale_id'", ".in('bale_id'",
  ".eq('loan_id'", ".in('loan_id'",
  ".eq('ldp_id'", ".in('ldp_id'",
  ".eq('gin_receipt_id'", ".in('gin_receipt_id'",
  ".eq('field_id'", ".in('field_id'",
  ".eq('ticket_number'", ".ilike('ticket_number'",
]

// How far past `.from('t')` the chain is inspected. Generous so multi-line
// builders (query vars ending in `.range(f, t)`) and long embed selects
// ending in `.single()` are seen.
const CHAIN_WINDOW = 1100

const ROOTS = ['app', 'components', 'lib']
const SKIP_FILES = new Set(['help-content.generated.ts'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      out.push(...sourceFiles(p))
      continue
    }
    if (!/\.(ts|tsx)$/.test(name)) continue
    if (/\.test\.(ts|tsx)$/.test(name)) continue
    if (SKIP_FILES.has(name)) continue
    out.push(p)
  }
  return out
}

describe('growing-table reads (CI gate)', () => {
  it('every read of a growing table is paginated or provably bounded', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8')
        for (const table of GROWING_TABLES) {
          const needle = `.from('${table}')`
          let idx = text.indexOf(needle)
          while (idx !== -1) {
            const window = text.slice(idx, idx + CHAIN_WINDOW)
            if (!BOUNDED_MARKERS.some((m) => window.includes(m))) {
              const line = text.slice(0, idx).split('\n').length
              offenders.push(`${file.replace(/\\/g, '/')}:${line} — bare read of '${table}'`)
            }
            idx = text.indexOf(needle, idx + needle.length)
          }
        }
      }
    }
    expect(
      offenders,
      `Unpaginated reads of growing tables (the ~1,000-row cap silently truncates them at scale).\n` +
        `Wrap each in fetchAllRows((f, t) => <query>.order('id').range(f, t)) — see lib/fetch-all-rows.ts:\n` +
        offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([])
  })
})
