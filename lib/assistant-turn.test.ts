// The Ask Turnrow turn loop with a SCRIPTED model: the never-redirect rule is
// enforced structurally — a data question answered with a deflection is held
// back and re-asked once, and the user only sees the answer that came from a
// tool call. Also pins the classifiers and the outcome record the usage log
// stores.

import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isRedirectAnswer, looksLikeDataQuestion, runAssistantTurn, NEVER_REDIRECT_RULE, SYSTEM_RULES, REDIRECT_CORRECTION,
  type ModelClient, type TurnEvent,
} from '@/lib/assistant-turn'
import { toolsForRole } from '@/lib/assistant-tools'

// ---------- a scripted model ----------
// Each script entry is one model round: the text it "streams" and, optionally,
// a tool call. The fake records every params object it was called with so a
// test can assert what the model saw (tools offered, the correction message).
type Round = { text?: string; tool?: { name: string; input: Record<string, unknown> } }
function scriptedModel(rounds: Round[]) {
  const calls: Anthropic.MessageStreamParams[] = []
  let i = 0
  const client: ModelClient = {
    messages: {
      stream(params) {
        // Snapshot: the loop mutates its messages array between rounds.
        calls.push({ ...params, messages: [...params.messages] })
        const r = rounds[Math.min(i, rounds.length - 1)]
        i++
        const listeners: Array<(t: string) => void> = []
        return {
          on(_ev, cb) { listeners.push(cb); return undefined },
          async finalMessage() {
            if (r.text) for (const chunk of r.text.match(/.{1,12}/gs) ?? []) listeners.forEach((cb) => cb(chunk))
            const content: Anthropic.ContentBlock[] = []
            if (r.text) content.push({ type: 'text', text: r.text, citations: null })
            if (r.tool) content.push({ type: 'tool_use', id: `tu_${i}`, name: r.tool.name, input: r.tool.input } as unknown as Anthropic.ContentBlock)
            return {
              id: 'msg', type: 'message', role: 'assistant', model: 'scripted', content,
              stop_reason: r.tool ? 'tool_use' : 'end_turn', stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
            } as unknown as Anthropic.Message
          },
        }
      },
    },
  }
  return { client, calls }
}

function run(rounds: Round[], question: string, opts?: { toolResult?: unknown }) {
  const { client, calls } = scriptedModel(rounds)
  const events: TurnEvent[] = []
  const toolCalls: Array<{ name: string; input: unknown }> = []
  const runTool = async (_s: SupabaseClient, _c: unknown, name: string, input: unknown) => { toolCalls.push({ name, input }); return opts?.toolResult ?? { rows: [] } }
  const p = runAssistantTurn({
    client, supabase: {} as SupabaseClient, ctx: { role: 'owner', grantedEntityIds: null },
    history: [{ role: 'user', content: question }], system: [{ type: 'text', text: SYSTEM_RULES }], tools: toolsForRole('owner'),
    model: 'scripted', emit: (e) => events.push(e), runTool: runTool as never, now: () => new Date('2026-09-14T12:00:00Z'),
  })
  return p.then((outcome) => ({ outcome, events, toolCalls, calls }))
}
const streamed = (events: TurnEvent[]) => events.filter((e): e is { t: string } => 't' in e).map((e) => e.t).join('')

describe('looksLikeDataQuestion', () => {
  it('recognizes questions about the user’s own records', () => {
    expect(looksLikeDataQuestion('How many bales is our contract with Victoria’s Secret?')).toBe(true)
    expect(looksLikeDataQuestion('What’s my expected price walk on the Pioneer seed contract?')).toBe(true)
    expect(looksLikeDataQuestion('how much corn is in our bins')).toBe(true)
    expect(looksLikeDataQuestion('Which field yielded best?')).toBe(true)
  })
  it('leaves how-to questions alone', () => {
    expect(looksLikeDataQuestion('How do I mark harvest complete?')).toBe(false)
    expect(looksLikeDataQuestion('What does basis mean on the marketing page?')).toBe(false)
    expect(looksLikeDataQuestion('')).toBe(false)
  })
})

describe('isRedirectAnswer', () => {
  it('catches the deflections the rule forbids', () => {
    expect(isRedirectAnswer("Cotton sales contracts aren't accessible through the assistant right now. Please check the Cotton → Marketing page for that information.")).toBe(true)
    expect(isRedirectAnswer("I don't have access to seed contract data. That module lives elsewhere in Turnrow.")).toBe(true)
    expect(isRedirectAnswer('You can find that on the Settlements page instead.')).toBe(true)
    expect(isRedirectAnswer('Seed contracts are tracked in a separate page — head to Contracts → Seed to see them.')).toBe(true)
  })
  it('lets real answers and honest empty results through', () => {
    expect(isRedirectAnswer('**14 bales** are committed on your Victoria’s Secret contract (2026), 9 delivered, 5 remaining; pricing: on-call, awaiting futures. From your Turnrow data right now — verify on Cotton → Marketing.')).toBe(false)
    expect(isRedirectAnswer('No cotton contracts found for Victoria’s Secret in 2026. The buyers with cotton contracts this year are Cargill and Olam.')).toBe(false)
    expect(isRedirectAnswer('Do you mean bushels in the bins, unsold bushels, or total production?')).toBe(false)
  })
})

describe('runAssistantTurn — the never-redirect guard', () => {
  const REDIRECT = "Cotton sales contracts aren't accessible through the assistant. Please check the Cotton → Marketing page for that."

  it('cotton question: a deflecting no-tool answer is held back, the model is re-asked, and a tool call answers', async () => {
    const { outcome, events, toolCalls, calls } = await run(
      [
        { text: REDIRECT },
        { text: 'Let me look that up.', tool: { name: 'get_cotton_marketing', input: { crop_year: 2026 } } },
        { text: '**14 bales** committed with Victoria’s Secret (2026): 9 delivered, 5 remaining, on-call pricing awaiting futures. From your Turnrow data right now.' },
      ],
      'How many bales is our contract with Victoria’s Secret?',
      { toolResult: { contracts: [{ buyer: "Victoria's Secret", committed_bales: 14, delivered_bales: 9, remaining_bales: 5 }] } },
    )
    expect(toolCalls.map((t) => t.name)).toEqual(['get_cotton_marketing'])
    expect(outcome.redirectRetry).toBe(true)
    expect(outcome.usedTools).toEqual(['get_cotton_marketing'])
    expect(outcome.noToolOnDataQuestion).toBe(false)
    // The user never saw the redirect.
    const shown = streamed(events)
    expect(shown).not.toMatch(/accessible through the assistant/)
    expect(shown).toMatch(/14 bales/)
    // The correction went back to the model as the next user message.
    const second = calls[1].messages
    expect(second[second.length - 1]).toEqual({ role: 'user', content: REDIRECT_CORRECTION })
    // The tools offered to the model included the cotton tool and query_data.
    expect(calls[0].tools?.map((t) => t.name)).toContain('get_cotton_marketing')
    expect(calls[0].tools?.map((t) => t.name)).toContain('query_data')
  })

  it('seed-contract question: same guard, answered through query_data', async () => {
    const { outcome, events, toolCalls } = await run(
      [
        { text: "Seed contract details live elsewhere in Turnrow — open the Contracts → Seed page to see the price walk." },
        { tool: { name: 'query_data', input: { sql: "select * from seed_contract_details d join contracts c on c.id = d.contract_id where c.contract_number ilike '%pioneer%'" } } },
        { text: 'Your Pioneer seed contract (2026): 320 acres, forecast 60 bu/ac, elected 40% at $12.10… From your Turnrow data right now.' },
      ],
      'What is the expected price walk on our Pioneer seed contract?',
    )
    expect(toolCalls.map((t) => t.name)).toEqual(['query_data'])
    expect(outcome.redirectRetry).toBe(true)
    expect(streamed(events)).not.toMatch(/live elsewhere/)
    expect(streamed(events)).toMatch(/Pioneer seed contract/)
  })

  it('an honest empty-result answer after a tool call is not a redirect and streams as-is', async () => {
    const { outcome, events } = await run(
      [
        { tool: { name: 'query_data', input: { sql: "select * from cotton_sales_contracts" } } },
        { text: 'No cotton contracts found for Victoria’s Secret in 2026 — the only cotton buyer this year is Olam (2 contracts). From your Turnrow data right now.' },
      ],
      'How many bales is our contract with Victoria’s Secret?',
    )
    expect(outcome.redirectRetry).toBe(false)
    expect(outcome.usedTools).toEqual(['query_data'])
    expect(streamed(events)).toMatch(/No cotton contracts found/)
  })

  it('a data question answered with no tool and no redirect streams (after the hold) and is logged as a gap', async () => {
    const { outcome, events } = await run([{ text: 'Do you mean bales committed, delivered, or remaining?' }], 'How many bales on our cotton contracts?')
    expect(outcome.noToolOnDataQuestion).toBe(true)
    expect(outcome.redirectRetry).toBe(false)
    expect(streamed(events)).toMatch(/Do you mean/)
  })

  it('the guard re-asks at most once: a second deflection is streamed and logged, not looped', async () => {
    const { outcome, events, calls } = await run([{ text: REDIRECT }, { text: REDIRECT }], 'How many bales is our contract with Victoria’s Secret?')
    expect(calls).toHaveLength(2)
    expect(outcome.redirectRetry).toBe(true)
    expect(outcome.noToolOnDataQuestion).toBe(true)
    expect(streamed(events)).toMatch(/accessible through the assistant/)
  })

  it('how-to questions stream live, untouched by the guard', async () => {
    const { outcome, events } = await run([{ text: 'Open **Settings → Crops** and tick Harvest complete.' }], 'How do I mark harvest complete?')
    expect(outcome.dataQuestion).toBe(false)
    expect(outcome.noToolOnDataQuestion).toBe(false)
    expect(streamed(events)).toMatch(/Settings/)
    expect(events.find((e) => 'd' in e)).toBeDefined()
  })

  it('tool results flow back and the end-of-turn marker lists the tools used', async () => {
    const { events, calls } = await run(
      [{ tool: { name: 'get_yields', input: { crop_year: 2026 } } }, { text: 'North 40 led at 185.2 bu/ac.' }],
      'Which field yielded best this year?',
      { toolResult: { rows: [{ field: 'North 40', yield: 185.2 }] } },
    )
    const results = calls[1].messages[calls[1].messages.length - 1].content as Anthropic.ToolResultBlockParam[]
    expect(results[0].type).toBe('tool_result')
    expect(String(results[0].content)).toMatch(/North 40/)
    const d = events.find((e): e is { d: { tools: string[]; at: string } } => 'd' in e)!
    expect(d.d.tools).toEqual(['get_yields'])
    expect(d.d.at).toBe('2026-09-14T12:00:00.000Z')
  })
})

describe('the system rules', () => {
  it('state the never-redirect rule and keep the honesty rules', () => {
    expect(SYSTEM_RULES).toContain(NEVER_REDIRECT_RULE)
    expect(NEVER_REDIRECT_RULE).toMatch(/NEVER say data "isn't accessible through the assistant"/)
    expect(NEVER_REDIRECT_RULE).toMatch(/MUST run query_data/)
    expect(NEVER_REDIRECT_RULE).toMatch(/genuinely empty result/)
    expect(NEVER_REDIRECT_RULE).toMatch(/role restriction/)
    expect(SYSTEM_RULES).toMatch(/Never state a number a tool did not return/)
    expect(SYSTEM_RULES).toMatch(/Always show units/)
    expect(SYSTEM_RULES).toMatch(/ask which they mean/)
  })
})
