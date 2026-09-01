'use client'

// "Ask Turnrow" — the data assistant thread (help-drawer tab + /assistant).
// Session-only: the conversation array is resent each turn and nothing
// persists beyond the page. The server does the tool work; this component
// only renders the stream.
//
// Stream protocol (newline-delimited JSON from /api/data-assistant):
//   {"t":"…"}                       text delta — append to the reply
//   {"s":"Checking your yields…"}   transient status while a tool runs
//   {"d":{"tools":["get_yields"],"at":"ISO"}}  end-of-turn: which data tools
//                                   ran, for the "from your Turnrow data as
//                                   of …" footer with report links
//   {"e":"message"}                 error surfaced mid-stream

import { useRef, useState } from 'react'
import type { AppRole } from '@/lib/types'

export type AssistantMessage = { role: 'user' | 'assistant'; content: string }

type TurnMeta = { tools: string[]; at: string }

// Tool → the report page where the same number can be verified.
const TOOL_LINKS: Record<string, { label: string; href: string }> = {
  get_marketing_summary: { label: 'Marketing', href: '/reports/marketing' },
  get_yields: { label: 'Yields', href: '/yields' },
  get_revenue_projection: { label: 'Revenue Projections', href: '/reports/revenue-projections' },
  get_contracts: { label: 'Contracts', href: '/contracts' },
  get_hedging_positions: { label: 'Hedging', href: '/hedging' },
  get_insurance_estimates: { label: 'Crop Insurance', href: '/reports/crop-insurance' },
  get_government_payments: { label: 'Government Payments', href: '/reports/government-payments' },
  get_cash_flow: { label: 'Cash Flow', href: '/reports/cash-flow' },
  get_loads: { label: 'Loads', href: '/loads' },
  get_bin_inventory: { label: 'Bin Inventory', href: '/inventory' },
}

const STARTERS: Record<AppRole, string[]> = {
  owner: [
    'What’s my average corn price this crop year?',
    'Which field yielded best?',
    'How many bushels are unsold?',
    'What’s sitting in the bins right now?',
    'What would my buyers dock me for 17% moisture corn?',
    'Which buyer’s discounts cost me the most last year?',
  ],
  viewer: [
    'Which field yielded best this year?',
    'How is marketing going for my entities?',
    'What was delivered on our contracts?',
  ],
  agronomist: [
    'Which field yielded best this year?',
    'Compare irrigated vs dryland corn yields.',
    'Which varieties performed best?',
  ],
  gin: [
    'How many cotton loads came in this week?',
    'Which gin receipts are missing bale weights?',
  ],
}

export default function AssistantChat({ role, autoFocus }: { role: AppRole; autoFocus?: boolean }) {
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [metaByIndex, setMetaByIndex] = useState<Record<number, TurnMeta>>({})
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  async function ask(text: string) {
    if (!text.trim() || busy) return
    setErr(null)
    const next: AssistantMessage[] = [...messages, { role: 'user', content: text.trim() }]
    const replyIndex = next.length
    setMessages([...next, { role: 'assistant', content: '' }])
    setInput('')
    setBusy(true)
    try {
      const res = await fetch('/api/data-assistant', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      })
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null)
        throw new Error(json?.error ?? 'The assistant is unavailable right now.')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      let buffer = ''
      let streamError: string | null = null
      const handleLine = (line: string) => {
        if (!line.trim()) return
        let ev: { t?: string; s?: string; d?: TurnMeta; e?: string }
        try { ev = JSON.parse(line) } catch { return }
        if (typeof ev.t === 'string') {
          acc += ev.t
          setStatus(null)
          const current = acc
          setMessages([...next, { role: 'assistant', content: current }])
        } else if (typeof ev.s === 'string') {
          setStatus(ev.s)
        } else if (ev.d) {
          const meta = ev.d
          setMetaByIndex((m) => ({ ...m, [replyIndex]: meta }))
        } else if (typeof ev.e === 'string') {
          streamError = ev.e
        }
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) handleLine(line)
      }
      if (buffer.trim()) handleLine(buffer)
      if (streamError) throw new Error(streamError)
      if (!acc.trim()) throw new Error('The assistant didn’t answer — try again.')
    } catch (error) {
      setMessages(next) // drop the empty assistant bubble
      setErr(error instanceof Error ? error.message : 'The assistant is unavailable right now.')
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  function footer(meta: TurnMeta) {
    const links = meta.tools.map((t) => TOOL_LINKS[t]).filter(Boolean)
    const at = new Date(meta.at)
    const stamp = isNaN(at.getTime()) ? '' : ` as of ${at.toLocaleString()}`
    return (
      <p className="text-[11px] text-slate-400 mt-1">
        From your Turnrow data{stamp}
        {links.length > 0 && (
          <>
            {' — verify in '}
            {links.map((l, i) => (
              <span key={l.href}>
                {i > 0 && ', '}
                <a href={l.href} className="underline decoration-dotted">{l.label}</a>
              </span>
            ))}
          </>
        )}
      </p>
    )
  }

  const starters = STARTERS[role] ?? STARTERS.owner

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="text-xs text-slate-500 border-b border-slate-100 pb-2">
        Answers come from <b>your own account&rsquo;s data</b> — the same numbers as your reports.
        Nothing here is visible to anyone outside your operation.
      </p>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-3 space-y-3">
        {messages.length === 0 && (
          <div className="pt-6 space-y-2">
            <p className="text-sm text-slate-400 text-center">Ask about your own numbers — try one of these:</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {starters.map((q) => (
                <button
                  key={q} type="button" onClick={() => void ask(q)}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-brand hover:text-brand-deep"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start'}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-brand text-white rounded-br-sm' : 'bg-slate-100 text-slate-800 rounded-bl-sm'
            }`}>
              {m.content || <span className="opacity-60">{status ?? '…'}</span>}
            </div>
            {m.role === 'assistant' && m.content && metaByIndex[i] && footer(metaByIndex[i])}
          </div>
        ))}
        {busy && status && messages[messages.length - 1]?.content && (
          <p className="text-xs text-slate-400 italic">{status}</p>
        )}
      </div>
      {err && <p className="text-sm text-red-600 pb-1">{err}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void ask(input) }} className="flex gap-2 pt-1">
        <input
          value={input}
          autoFocus={autoFocus}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your data…"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
        />
        <button type="submit" disabled={busy || !input.trim()}
          className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 text-sm font-semibold disabled:opacity-50">
          Ask
        </button>
      </form>
    </div>
  )
}
