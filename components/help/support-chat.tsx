'use client'

// "Ask the assistant" — the support chatbot thread inside the help drawer.
// Session-only (nothing persists), streams the reply, and always offers the
// escalation path into the Contact Support form with the conversation
// carried along.

import { useRef, useState } from 'react'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export default function SupportChat({ route, onEscalate }: {
  route: string
  /** Hands the conversation transcript to the Contact Support tab. */
  onEscalate: (transcript: string) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  function transcript(): string {
    return messages.map((m) => `${m.role === 'user' ? 'Me' : 'Assistant'}: ${m.content}`).join('\n\n')
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    setErr(null)
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages([...next, { role: 'assistant', content: '' }])
    setInput('')
    setBusy(true)
    try {
      const res = await fetch('/api/support-chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next, route }),
      })
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null)
        throw new Error(json?.error ?? 'The assistant is unavailable right now.')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        const current = acc
        setMessages([...next, { role: 'assistant', content: current }])
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
      }
      if (!acc.trim()) throw new Error('The assistant didn’t answer — try again, or contact support.')
    } catch (error) {
      setMessages(next) // drop the empty assistant bubble
      setErr(error instanceof Error ? error.message : 'The assistant is unavailable right now.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="text-xs text-slate-500 border-b border-slate-100 pb-2">
        Answers come from Turnrow&rsquo;s documentation — for anything about your own account or numbers,
        contact support.
      </p>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400 text-center pt-8">
            Ask anything about using Turnrow — &ldquo;How do I mark harvest complete?&rdquo;,
            &ldquo;What does basis mean on the marketing page?&rdquo;
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-brand text-white rounded-br-sm' : 'bg-slate-100 text-slate-800 rounded-bl-sm'
            }`}>
              {m.content || <span className="opacity-60">…</span>}
            </div>
          </div>
        ))}
      </div>
      {err && <p className="text-sm text-red-600 pb-1">{err}</p>}
      <form onSubmit={send} className="flex gap-2 pt-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a question…"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button type="submit" disabled={busy || !input.trim()}
          className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 text-sm font-semibold disabled:opacity-50">
          Send
        </button>
      </form>
      {messages.length > 0 && (
        <button type="button" onClick={() => onEscalate(transcript())}
          className="mt-2 text-xs text-slate-500 underline decoration-dotted self-start">
          Didn&rsquo;t get what you needed? Send this conversation to support
        </button>
      )}
    </div>
  )
}
