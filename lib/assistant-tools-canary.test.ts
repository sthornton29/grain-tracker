// The RLS canary for the curated tools, in code: every tool reads ONLY
// through the Supabase client it is handed (the caller's session — RLS
// scopes every row), never a service-role client. So a user whose session
// sees no rows (the beta test-org user of docs/BETA_ACCEPTANCE.md check (f))
// gets an honest "nothing found" from every tool — never Turnrow's cotton
// rows. This runs each NEW tool against a client that returns nothing and
// pins that outcome, and scans the tool sources for any service-role escape.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runAssistantTool, toolNamesForRole } from '@/lib/assistant-tools'

// A session client whose every read returns zero rows (what RLS hands a user
// with no data in their org) and whose RPCs return nothing.
function emptySessionClient(tablesTouched: Set<string>): SupabaseClient {
  const builder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {}
    const self = () => b
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'range', 'limit', 'ilike', 'is', 'not', 'or', 'filter']) b[m] = self
    b.maybeSingle = async () => ({ data: null, error: null })
    b.single = async () => ({ data: null, error: null })
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve)
    return b
  }
  return {
    from: (table: string) => { tablesTouched.add(table); return builder() },
    rpc: async () => ({ data: [], error: null }),
  } as unknown as SupabaseClient
}

const NEW_TOOLS = [
  ['get_cotton_marketing', { crop_year: 2026, buyer: "Victoria's Secret" }],
  ['get_cotton_production', { crop_year: 2026 }],
  ['get_seed_contracts', { crop_year: 2026 }],
  ['get_settlements', { crop_year: 2026 }],
  ['get_bin_transfers', {}],
  ['get_combine_entries', { crop_year: 2026 }],
  ['get_rent_settlements', { crop_year: 2026 }],
  ['get_budget', { year: 2026 }],
] as const

describe('RLS canary — a session that sees no rows gets nothing from every new tool', () => {
  for (const [name, input] of NEW_TOOLS) {
    it(`${name}: empty session → honest empty result, no error, no Turnrow rows`, async () => {
      const touched = new Set<string>()
      const result = (await runAssistantTool(emptySessionClient(touched), { role: 'owner', grantedEntityIds: null }, name, input)) as Record<string, unknown>
      expect(result.error, `${name} errored: ${String(result.error)}`).toBeUndefined()
      const text = JSON.stringify(result)
      // Nothing that looks like a real record leaked in (the tool may echo the
      // buyer filter it was asked for — that is the question, not a row).
      expect(text).not.toMatch(/Turnrow Farm|ZCZ26|"contract_number":"[^"]+"|"loan_number":"[^"]+"/i)
      // The tool reports emptiness explicitly (count 0 / empty lists / a note).
      const count = (result.count ?? result.contract_count ?? (Array.isArray(result.receipts) ? result.receipts.length : undefined)) as number | undefined
      if (count != null) expect(count).toBe(0)
      expect(typeof result.note).toBe('string')
      expect(touched.size, `${name} read no tables`).toBeGreaterThan(0)
    })
  }

  it('the viewer canary: the same empty session, viewer role, on every viewer-visible new tool', async () => {
    for (const [name, input] of NEW_TOOLS) {
      if (!toolNamesForRole('viewer').includes(name)) continue
      const result = (await runAssistantTool(emptySessionClient(new Set()), { role: 'viewer', grantedEntityIds: [] }, name, input)) as Record<string, unknown>
      expect(result.error).toBeUndefined()
      expect(JSON.stringify(result)).not.toMatch(/Turnrow Farm|"contract_number":"[^"]+"|"loan_number":"[^"]+"/i)
    }
  })

  it('tools hidden from a role are refused before any read', async () => {
    const touched = new Set<string>()
    const result = (await runAssistantTool(emptySessionClient(touched), { role: 'gin', grantedEntityIds: null }, 'get_cotton_marketing', { crop_year: 2026 })) as Record<string, unknown>
    expect(result.error).toMatch(/not available for your role/)
    expect(touched.size).toBe(0)
  })

  it('no tool source imports a service-role client or key', () => {
    for (const f of ['assistant-tools.ts', 'assistant-tools-modules.ts', 'assistant-tools-shared.ts', 'assistant-turn.ts']) {
      const src = readFileSync(join(process.cwd(), 'lib', f), 'utf8')
      // Code, not comments: the comments SAY "never the service role".
      expect(src, `${f} must only use the caller's session client`).not.toMatch(/createServiceClient|SUPABASE_SERVICE_ROLE|['"]service_role['"]|serviceRoleClient/)
    }
  })
})
