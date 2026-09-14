// Role-based tool availability for the data assistant. RLS is the real
// enforcement (each tool runs on the user's session); this map only hides
// tools a role's policies would return empty results for, so the model
// doesn't chase them.
//
// Behavior pinned:
//   * owner gets every tool; every role gets query_data (RLS scopes it);
//   * agronomist (Yields-only SELECT allowlist) gets only yields/loads/
//     combine entries/cotton production + query_data — never the financial tools;
//   * gin gets the cotton production surface + query_data;
//   * viewer loses the whole-operation tools their reports also lack
//     (bin inventory, cash flow, settlements, bin transfers, budgets) and
//     keeps the entity-scoped ones (cotton, seed, rent, combine);
//   * every advertised tool has an input schema and a status label.

import { describe, expect, it } from 'vitest'
import { ASSISTANT_TOOLS, toolNamesForRole, toolsForRole, toolStatusLabel } from './assistant-tools'

const MODULE_TOOL_NAMES = ['get_cotton_marketing', 'get_cotton_production', 'get_seed_contracts', 'get_settlements', 'get_checkoff_paid', 'get_bin_transfers', 'get_combine_entries', 'get_rent_settlements', 'get_budget']

describe('toolNamesForRole', () => {
  it('owner: every tool, including the eight module tools', () => {
    expect(new Set(toolNamesForRole('owner'))).toEqual(new Set(ASSISTANT_TOOLS.map((t) => t.name)))
    for (const n of MODULE_TOOL_NAMES) expect(toolNamesForRole('owner')).toContain(n)
  })

  it('agronomist: the Yields read surface only — no financial tools', () => {
    const names = toolNamesForRole('agronomist')
    expect(new Set(names)).toEqual(new Set(['get_yields', 'get_loads', 'get_combine_entries', 'get_cotton_production', 'query_data']))
    for (const n of ['get_marketing_summary', 'get_hedging_positions', 'get_cotton_marketing', 'get_seed_contracts', 'get_settlements', 'get_rent_settlements', 'get_budget', 'get_bin_transfers']) {
      expect(names).not.toContain(n)
    }
  })

  it('viewer: no whole-operation tools (bin inventory, cash flow, settlements, transfers, budget); keeps the entity-scoped module tools', () => {
    const names = toolNamesForRole('viewer')
    for (const n of ['get_bin_inventory', 'get_cash_flow', 'get_settlements', 'get_checkoff_paid', 'get_bin_transfers', 'get_budget']) expect(names).not.toContain(n)
    for (const n of ['get_yields', 'get_marketing_summary', 'get_cotton_marketing', 'get_cotton_production', 'get_seed_contracts', 'get_rent_settlements', 'get_combine_entries']) expect(names).toContain(n)
  })

  it('viewer keeps the buyer discount tools (the report is viewer-included)', () => {
    const names = toolNamesForRole('viewer')
    expect(names).toContain('get_buyer_discount_schedule')
    expect(names).toContain('get_buyer_discount_history')
    // Agronomist never sees them (financial surface).
    expect(toolNamesForRole('agronomist')).not.toContain('get_buyer_discount_schedule')
    expect(toolNamesForRole('agronomist')).not.toContain('get_buyer_discount_history')
  })

  it('gin: cotton production + query_data only', () => {
    expect(toolNamesForRole('gin')).toEqual(['get_cotton_production', 'query_data'])
  })

  it('every role keeps query_data (RLS scopes what it can see)', () => {
    for (const role of ['owner', 'gin', 'viewer', 'agronomist'] as const) {
      expect(toolNamesForRole(role)).toContain('query_data')
    }
  })
})

describe('tool registry', () => {
  it('toolsForRole returns full Anthropic tool definitions for the allowed names', () => {
    const tools = toolsForRole('agronomist')
    expect(tools.map((t) => t.name).sort()).toEqual(['get_combine_entries', 'get_cotton_production', 'get_loads', 'get_yields', 'query_data'])
    for (const t of tools) expect(t.input_schema.type).toBe('object')
  })

  it('every tool has a description and a running-status label', () => {
    for (const t of ASSISTANT_TOOLS) {
      expect((t.description ?? '').length).toBeGreaterThan(20)
      expect(toolStatusLabel(t.name)).toMatch(/…$/)
    }
  })

  it('the module tools are registered with their required inputs', () => {
    const byName = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]))
    for (const n of MODULE_TOOL_NAMES) expect(byName.has(n), `${n} missing from ASSISTANT_TOOLS`).toBe(true)
    expect(byName.get('get_cotton_marketing')!.input_schema.required).toEqual(['crop_year'])
    expect(byName.get('get_cotton_marketing')!.description).toMatch(/bales committed \/ delivered \/ remaining/)
    expect(byName.get('get_seed_contracts')!.description).toMatch(/expected price walk/)
    expect(byName.get('get_settlements')!.description).toMatch(/ITEMIZED discounts/)
    expect(byName.get('get_budget')!.input_schema.required).toEqual(['year'])
    expect(byName.get('query_data')!.description).toMatch(/every table in the account/i)
  })

  it('buyer discount tool shapes: schedule takes buyer (+optional readings), history requires crop_year', () => {
    const sched = ASSISTANT_TOOLS.find((t) => t.name === 'get_buyer_discount_schedule')!
    expect(sched.input_schema.required).toEqual(['buyer'])
    const schedProps = sched.input_schema.properties as Record<string, unknown>
    for (const p of ['buyer', 'crop', 'moisture', 'test_weight', 'price_per_bu']) expect(schedProps).toHaveProperty(p)
    // The description pins the contract: the RULE ENGINE does the math.
    expect(sched.description).toMatch(/RULE ENGINE|rule engine/i)

    const hist = ASSISTANT_TOOLS.find((t) => t.name === 'get_buyer_discount_history')!
    expect(hist.input_schema.required).toEqual(['crop_year'])
    const histProps = hist.input_schema.properties as Record<string, unknown>
    for (const p of ['crop_year', 'buyer', 'crop']) expect(histProps).toHaveProperty(p)
  })
})
