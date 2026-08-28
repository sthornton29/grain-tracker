// Role-based tool availability for the data assistant. RLS is the real
// enforcement (each tool runs on the user's session); this map only hides
// tools a role's policies would return empty results for, so the model
// doesn't chase them.
//
// Behavior pinned:
//   * owner gets every tool; every role gets query_data (RLS scopes it);
//   * agronomist (Yields-only SELECT allowlist) gets only yields/loads
//     + query_data — never the financial tools;
//   * viewer loses the whole-operation tools their reports also lack
//     (bin inventory, cash flow);
//   * every advertised tool has an input schema and a status label.

import { describe, expect, it } from 'vitest'
import { ASSISTANT_TOOLS, toolNamesForRole, toolsForRole, toolStatusLabel } from './assistant-tools'

describe('toolNamesForRole', () => {
  it('owner: every tool', () => {
    expect(new Set(toolNamesForRole('owner'))).toEqual(new Set(ASSISTANT_TOOLS.map((t) => t.name)))
  })

  it('agronomist: yields + loads + query only — no financial tools', () => {
    const names = toolNamesForRole('agronomist')
    expect(new Set(names)).toEqual(new Set(['get_yields', 'get_loads', 'query_data']))
    expect(names).not.toContain('get_marketing_summary')
    expect(names).not.toContain('get_hedging_positions')
  })

  it('viewer: no whole-operation tools (bin inventory, cash flow)', () => {
    const names = toolNamesForRole('viewer')
    expect(names).not.toContain('get_bin_inventory')
    expect(names).not.toContain('get_cash_flow')
    expect(names).toContain('get_yields')
    expect(names).toContain('get_marketing_summary')
  })

  it('viewer keeps the buyer discount tools (the report is viewer-included)', () => {
    const names = toolNamesForRole('viewer')
    expect(names).toContain('get_buyer_discount_schedule')
    expect(names).toContain('get_buyer_discount_history')
    // Agronomist never sees them (financial surface).
    expect(toolNamesForRole('agronomist')).not.toContain('get_buyer_discount_schedule')
    expect(toolNamesForRole('agronomist')).not.toContain('get_buyer_discount_history')
  })

  it('gin: query_data only', () => {
    expect(toolNamesForRole('gin')).toEqual(['query_data'])
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
    expect(tools.map((t) => t.name).sort()).toEqual(['get_loads', 'get_yields', 'query_data'])
    for (const t of tools) expect(t.input_schema.type).toBe('object')
  })

  it('every tool has a description and a running-status label', () => {
    for (const t of ASSISTANT_TOOLS) {
      expect((t.description ?? '').length).toBeGreaterThan(20)
      expect(toolStatusLabel(t.name)).toMatch(/…$/)
    }
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
