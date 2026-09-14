import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { coerceAppRole } from '@/lib/app-role'
import { HELP_DIGEST } from '@/lib/help-content.generated'
import { ASSISTANT_SCHEMA_SUMMARY } from '@/lib/assistant-schema'
import { toolsForRole, type AssistantContext } from '@/lib/assistant-tools'
import { runAssistantTurn, SYSTEM_RULES } from '@/lib/assistant-turn'

// "Ask Turnrow" — the data assistant. An Anthropic tool-use loop
// (lib/assistant-turn.ts) whose every data access runs through the CALLER'S
// OWN Supabase session (their JWT) — never the service role. THE
// TENANT-ISOLATION GUARANTEE IS POSTGRES RLS, NOT PROMPT LANGUAGE: the 054
// org isolation and 042/052/061 role policies filter each tool's rows and
// every query_data statement (a SECURITY INVOKER read-only RPC), so a
// prompt-injected or hallucinated query cannot cross orgs or roles — the
// database refuses, not the prompt.
//
// Coverage is structural: the system prompt carries the GENERATED schema
// digest of every tenant table, the never-redirect guard in the turn loop
// re-asks a deflecting answer, and every turn's outcome (which tool answered,
// or none) is written to assistant_usage (084) + a log line.

export const runtime = 'nodejs'
// Fluid-compute ceiling (see parse-document): a turn can run several tool
// fetch+compute rounds plus streaming.
export const maxDuration = 300

const MODEL = 'claude-sonnet-4-6'
const MAX_MESSAGES = 24
const MAX_CHARS = 4000
const MAX_TOOL_ITERATIONS = 8 // tool-use rounds per turn — bounds cost
const RATE_LIMIT = 30 // messages per user per hour

// In-memory fallback for the rate limit if the assistant_usage table (068)
// isn't applied yet — per server instance, resets on cold start.
const rateLog = new Map<string, number[]>()
function memoryRateLimited(userId: string): boolean {
  const now = Date.now()
  const cutoff = now - 60 * 60 * 1000
  const seen = (rateLog.get(userId) ?? []).filter((t) => t > cutoff)
  if (seen.length >= RATE_LIMIT) { rateLog.set(userId, seen); return true }
  seen.push(now)
  rateLog.set(userId, seen)
  return false
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 })
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'The assistant isn’t set up yet — use Contact Support.' }, { status: 503 })
  }

  // Rate limit: durable count via the user's own assistant_usage rows (068);
  // in-memory fallback when the table isn't there yet.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count, error: usageErr } = await supabase
    .from('assistant_usage')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', hourAgo)
  if (usageErr ? memoryRateLimited(user.id) : (count ?? 0) >= RATE_LIMIT) {
    return NextResponse.json({ error: 'That’s a lot of questions this hour — give it a little while and try again.' }, { status: 429 })
  }

  // Role + viewer grants — for tool availability and viewer-correct scoping
  // (RLS enforces regardless; this keeps attribution math report-identical).
  const { data: profile } = await supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
  const role = coerceAppRole((profile as { role?: string } | null)?.role)
  let grantedEntityIds: string[] | null = null
  if (role === 'viewer') {
    const { data: grants } = await supabase.from('user_entity_access').select('entity_id')
    grantedEntityIds = ((grants as Array<{ entity_id: string }> | null) ?? []).map((g) => g.entity_id)
  }
  const ctx: AssistantContext = { role, grantedEntityIds }

  const body = (await req.json().catch(() => null)) as { messages?: Array<{ role?: string; content?: string }> } | null
  const raw = Array.isArray(body?.messages) ? body!.messages! : []
  const history: Anthropic.MessageParam[] = raw
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== '')
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content!.slice(0, MAX_CHARS) }))
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'Nothing to answer.' }, { status: 400 })
  }
  const question = String(history[history.length - 1].content).slice(0, 500)

  // The usage row (rate limit + the answer log filled in at the end). The
  // 084 columns may not exist yet — a bare insert still counts the message.
  let usageId: string | null = null
  if (!usageErr) {
    const ins = await supabase.from('assistant_usage').insert({ role, question }).select('id').maybeSingle()
    if (ins.error) {
      const bare = await supabase.from('assistant_usage').insert({}).select('id').maybeSingle()
      usageId = (bare.data as { id?: string } | null)?.id ?? null
    } else usageId = (ins.data as { id?: string } | null)?.id ?? null
  }

  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: [
        SYSTEM_RULES,
        '',
        `The user's role in this account: ${role}.`,
        `Today's date: ${new Date().toISOString().slice(0, 10)}.`,
        '',
        '==== DATABASE SCHEMA (for query_data — EVERY table in this account) ====',
        ASSISTANT_SCHEMA_SUMMARY,
        '',
        '==== TURNROW DOCUMENTATION (for how-to questions) ====',
        HELP_DIGEST,
      ].join('\n'),
      // The digest + schema are identical across turns and tool rounds —
      // cache them so an 8-round turn doesn't pay for them 8 times.
      cache_control: { type: 'ephemeral' },
    },
  ]

  const client = new Anthropic()
  const tools = toolsForRole(role)
  const encoder = new TextEncoder()

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      const outcome = await runAssistantTurn({
        client, supabase, ctx, history, system, tools, model: MODEL, maxTokens: 1500, maxIterations: MAX_TOOL_ITERATIONS, emit,
      })
      controller.close()

      // Usage log: which tool answered (or none), gaps, guard retries — the
      // record the admin view reads. Never blocks the answer.
      const logLine = {
        tag: 'assistant-turn', user: user.id, role, tools: outcome.usedTools, data_question: outcome.dataQuestion,
        no_tool_on_data_question: outcome.noToolOnDataQuestion, redirect_retry: outcome.redirectRetry,
        answer_chars: outcome.text.length, error: outcome.error, question,
      }
      if (outcome.noToolOnDataQuestion || outcome.redirectRetry || outcome.error) console.warn('[assistant-gap]', JSON.stringify(logLine))
      else console.info('[assistant]', JSON.stringify(logLine))
      if (usageId) {
        await supabase.from('assistant_usage').update({
          tools_used: outcome.usedTools,
          data_question: outcome.dataQuestion,
          no_tool_on_data_question: outcome.noToolOnDataQuestion,
          redirect_retry: outcome.redirectRetry,
          answer_chars: outcome.text.length,
          error: outcome.error,
          answered_at: new Date().toISOString(),
        }).eq('id', usageId).then(() => undefined, () => undefined)
      }
    },
  })
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } })
}
