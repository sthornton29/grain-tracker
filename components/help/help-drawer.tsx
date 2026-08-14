'use client'

// The Help drawer: opens from the "?" in the nav (or any "Learn more" link
// via lib/help-bus). Auto-lands on the topic for the current page, with
// search across every topic, the support chatbot, and the contact-support
// form. Content ships with the app (lib/help-content.generated.ts — built by
// `npm run help:build`); each topic shows its last-updated date so stale
// docs are visible.

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { HELP_TOPICS, type HelpTopic } from '@/lib/help-content.generated'
import { topicForRoute, searchTopics } from '@/lib/help'
import { renderHelpMarkdown } from '@/lib/help-markdown'
import { HELP_OPEN_EVENT, type HelpOpenDetail } from '@/lib/help-bus'
import SupportChat from '@/components/help/support-chat'
import SupportForm from '@/components/help/support-form'
import AssistantChat from '@/components/assistant/assistant-chat'
import type { AppRole } from '@/lib/types'

type Tab = 'topic' | 'browse' | 'data' | 'chat' | 'support'

export default function HelpDrawer({ role = 'owner' }: { role?: AppRole }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('topic')
  const [topic, setTopic] = useState<HelpTopic | null>(null)
  const [query, setQuery] = useState('')
  const [transcript, setTranscript] = useState<string | undefined>(undefined)

  // Deep-open requests from anywhere in the app ("Learn more" links).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<HelpOpenDetail>).detail
      const target = topicForRoute(HELP_TOPICS, detail?.route ?? pathname)
      setTopic(target)
      setTab('topic')
      setOpen(true)
    }
    window.addEventListener(HELP_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(HELP_OPEN_EVENT, onOpen)
  }, [pathname])

  function openFromButton() {
    setTopic(topicForRoute(HELP_TOPICS, pathname))
    setTab('topic')
    setOpen(true)
  }

  const results = useMemo(() => searchTopics(HELP_TOPICS, query), [query])
  const current = topic ?? topicForRoute(HELP_TOPICS, pathname)

  return (
    <>
      <button
        type="button"
        onClick={openFromButton}
        title="Help & Support"
        aria-label="Help & Support"
        className="ml-1 sm:ml-2 h-10 w-10 shrink-0 rounded-full border border-white/30 text-white/85 hover:text-white hover:border-white/60 active:bg-white/10 text-base font-semibold leading-none"
      >
        ?
      </button>
      {open && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          {/* text-slate-800 matters: the drawer mounts inside the nav, which
              sets text-white — without the reset every input inherits
              white-on-white (invisible typing). */}
          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white text-slate-800 shadow-xl flex flex-col">
            <div className="border-b border-slate-200 px-4 py-3 flex items-center gap-2">
              <h2 className="font-display font-bold text-lg text-brand-dark flex-1">Help</h2>
              <a href="/help" className="text-xs text-brand-deep underline decoration-dotted">Help center</a>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close help"
                className="ml-2 text-slate-400 hover:text-slate-700 font-bold">✕</button>
            </div>

            <div className="border-b border-slate-100 px-4 pt-2 flex gap-1 text-sm">
              {([
                ['topic', 'This page'],
                ['browse', 'All topics'],
                ['data', 'Ask Turnrow'],
                ['chat', 'How-to chat'],
                ['support', 'Contact support'],
              ] as Array<[Tab, string]>).map(([t, label]) => (
                <button key={t} type="button" onClick={() => setTab(t)}
                  className={`px-2.5 py-1.5 rounded-t-lg font-medium ${tab === t ? 'bg-slate-100 text-brand-dark' : 'text-slate-500 hover:text-slate-800'}`}>
                  {label}
                </button>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
              {tab === 'topic' && (
                current ? (
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="font-display font-bold text-brand-dark text-lg">{current.title}</h3>
                      <span className="text-[11px] text-slate-400 whitespace-nowrap">updated {current.updated}</span>
                    </div>
                    <div className="mt-1">{renderHelpMarkdown(current.body)}</div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500 pt-6 text-center">
                    No help topic for this page yet — browse all topics, or ask the assistant.
                  </p>
                )
              )}

              {tab === 'browse' && (
                <div className="space-y-2">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search help…"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                  <ul className="divide-y divide-slate-100">
                    {results.map((t) => (
                      <li key={t.route}>
                        <button type="button" onClick={() => { setTopic(t); setTab('topic') }}
                          className="w-full text-left py-2 hover:bg-slate-50 rounded px-1">
                          <span className="font-medium text-sm">{t.title}</span>
                          <span className="block text-[11px] text-slate-400">updated {t.updated}</span>
                        </button>
                      </li>
                    ))}
                    {results.length === 0 && <li className="py-4 text-sm text-slate-400 text-center">No matches.</li>}
                  </ul>
                </div>
              )}

              {tab === 'data' && (
                <div className="h-full min-h-0 flex flex-col">
                  <div className="flex justify-end pb-1">
                    <a href="/assistant" className="text-[11px] text-brand-deep underline decoration-dotted">Open full page ↗</a>
                  </div>
                  <div className="flex-1 min-h-0">
                    <AssistantChat role={role} />
                  </div>
                </div>
              )}

              {tab === 'chat' && (
                <SupportChat route={pathname ?? '/'} onEscalate={(t) => { setTranscript(t); setTab('support') }} />
              )}

              {tab === 'support' && <SupportForm route={pathname ?? '/'} transcript={transcript} />}
            </div>

            {(tab === 'topic' || tab === 'browse') && (
              <div className="border-t border-slate-200 px-4 py-2.5 flex gap-2">
                <button type="button" onClick={() => setTab('chat')}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  Ask the assistant
                </button>
                <button type="button" onClick={() => setTab('support')}
                  className="flex-1 rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold">
                  Contact support
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
