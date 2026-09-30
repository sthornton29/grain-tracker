'use client'

// The Help drawer: opens from the "?" in the nav (or any "Learn more" link
// via lib/help-bus). Three tabs:
//   Help    — the topic for the current page first, with "All topics" and
//             search underneath;
//   Ask     — Ask Turnrow, with a My numbers / How Turnrow works switch over
//             the two chats (your own data vs. the how-to guide);
//   Support — the contact form (reaches a person).
// Content ships with the app (lib/help-content.generated.ts — built by
// `npm run help:build`); each topic shows its last-updated date so stale
// docs are visible. A one-time callout under the "?" tells a new person
// where help lives; it goes away once dismissed or once the drawer opens.

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

type Tab = 'help' | 'ask' | 'support'
type AskMode = 'data' | 'howto'

const CALLOUT_KEY = 'turnrow:help-callout-seen'

export default function HelpDrawer({ role = 'owner' }: { role?: AppRole }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('help')
  const [askMode, setAskMode] = useState<AskMode>('data')
  const [topic, setTopic] = useState<HelpTopic | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [query, setQuery] = useState('')
  const [transcript, setTranscript] = useState<string | undefined>(undefined)
  const [callout, setCallout] = useState(false)

  useEffect(() => {
    try { if (!window.localStorage.getItem(CALLOUT_KEY)) setCallout(true) } catch { /* no storage */ }
  }, [])
  function dismissCallout() {
    setCallout(false)
    try { window.localStorage.setItem(CALLOUT_KEY, '1') } catch { /* fine */ }
  }

  // Deep-open requests from anywhere in the app ("Learn more" links).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<HelpOpenDetail>).detail
      const target = topicForRoute(HELP_TOPICS, detail?.route ?? pathname)
      setTopic(target)
      setBrowsing(false)
      setTab('help')
      setOpen(true)
    }
    window.addEventListener(HELP_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(HELP_OPEN_EVENT, onOpen)
  }, [pathname])

  function openFromButton() {
    setTopic(topicForRoute(HELP_TOPICS, pathname))
    setBrowsing(false)
    setTab('help')
    setOpen(true)
    if (callout) dismissCallout()
  }

  const results = useMemo(() => searchTopics(HELP_TOPICS, query), [query])
  const current = topic ?? topicForRoute(HELP_TOPICS, pathname)

  const tabCls = (active: boolean) =>
    `flex-1 min-h-11 px-2 rounded-t-lg font-medium text-sm ${active ? 'bg-slate-100 text-brand-dark' : 'text-slate-500 hover:text-slate-800'}`

  return (
    <>
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={openFromButton}
          title="Help & Support"
          aria-label="Help & Support"
          className="ml-1 sm:ml-2 h-11 w-11 shrink-0 rounded-full border border-white/30 text-white/85 hover:text-white hover:border-white/60 active:bg-white/10 text-base font-semibold leading-none"
        >
          ?
        </button>
        {callout && !open && (
          <div role="status" className="absolute right-0 top-full mt-2 w-60 rounded-xl bg-white text-slate-800 shadow-xl border border-slate-200 p-3 text-sm z-20">
            <span aria-hidden className="absolute -top-1.5 right-4 h-3 w-3 rotate-45 bg-white border-l border-t border-slate-200" />
            <div className="font-semibold">Help for every page lives here.</div>
            <div className="text-slate-600 text-xs mt-0.5">Tap <b>?</b> on any page for a guide to it, to ask a question, or to reach support.</div>
            <button type="button" onClick={dismissCallout} className="mt-2 text-xs text-brand-deep underline decoration-dotted min-h-8">Got it</button>
          </div>
        )}
      </div>
      {open && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          {/* text-slate-800 matters: the drawer mounts inside the nav, which
              sets text-white — without the reset every input inherits
              white-on-white (invisible typing). */}
          <div role="dialog" aria-modal="true" aria-label="Help" className="absolute right-0 top-0 h-full w-full max-w-md bg-white text-slate-800 shadow-xl flex flex-col">
            <div className="border-b border-slate-200 px-4 py-2 flex items-center gap-2">
              <h2 className="font-display font-bold text-lg text-brand-dark flex-1">Help</h2>
              <a href="/help" className="text-xs text-brand-deep underline decoration-dotted min-h-11 inline-flex items-center">Help center</a>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close help"
                className="ml-2 text-slate-400 hover:text-slate-700 font-bold min-h-11 min-w-11">✕</button>
            </div>

            <div className="border-b border-slate-100 px-3 pt-2 flex gap-1" role="tablist">
              {([
                ['help', 'Help'],
                ['ask', 'Ask'],
                ['support', 'Support'],
              ] as Array<[Tab, string]>).map(([t, label]) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={tabCls(tab === t)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
              {tab === 'help' && (
                <div className="space-y-4">
                  {!browsing && (
                    current ? (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-slate-400">This page</div>
                        <div className="flex items-baseline justify-between gap-2">
                          <h3 className="font-display font-bold text-brand-dark text-lg">{current.title}</h3>
                          <span className="text-[11px] text-slate-400 whitespace-nowrap">updated {current.updated}</span>
                        </div>
                        <div className="mt-1">{renderHelpMarkdown(current.body)}</div>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500 pt-4 text-center">
                        No guide for this page yet — browse all topics below, or ask a question on the Ask tab.
                      </p>
                    )
                  )}

                  <div className={browsing ? '' : 'border-t border-slate-100 pt-3'}>
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-semibold text-sm text-slate-700">All topics</h4>
                      {browsing && (
                        <button type="button" onClick={() => setBrowsing(false)} className="text-xs text-brand-deep underline decoration-dotted min-h-11">
                          ← Back to this page
                        </button>
                      )}
                    </div>
                    <input
                      value={query}
                      onFocus={() => setBrowsing(true)}
                      onChange={(e) => { setQuery(e.target.value); setBrowsing(true) }}
                      placeholder="Search help…"
                      aria-label="Search help"
                      className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 min-h-11 text-sm text-slate-900 placeholder:text-slate-400"
                    />
                    {(browsing || query) ? (
                      <ul className="divide-y divide-slate-100 mt-1">
                        {results.map((t) => (
                          <li key={t.route}>
                            <button type="button" onClick={() => { setTopic(t); setBrowsing(false); setQuery('') }}
                              className="w-full text-left py-2 min-h-11 hover:bg-slate-50 rounded px-1">
                              <span className="font-medium text-sm">{t.title}</span>
                              <span className="block text-[11px] text-slate-400">updated {t.updated}</span>
                            </button>
                          </li>
                        ))}
                        {results.length === 0 && <li className="py-4 text-sm text-slate-400 text-center">Nothing matched — try different words.</li>}
                      </ul>
                    ) : (
                      <button type="button" onClick={() => setBrowsing(true)} className="mt-1 text-sm text-brand-deep underline decoration-dotted min-h-11">
                        Browse all {HELP_TOPICS.length} topics
                      </button>
                    )}
                  </div>
                </div>
              )}

              {tab === 'ask' && (
                <div className="h-full min-h-0 flex flex-col">
                  <div className="flex items-center gap-2 pb-2">
                    <div role="group" aria-label="What to ask about" className="flex-1 grid grid-cols-2 rounded-lg border border-slate-300 overflow-hidden text-sm">
                      <button type="button" aria-pressed={askMode === 'data'} onClick={() => setAskMode('data')}
                        className={`min-h-11 px-2 font-medium ${askMode === 'data' ? 'bg-brand text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                        My numbers
                      </button>
                      <button type="button" aria-pressed={askMode === 'howto'} onClick={() => setAskMode('howto')}
                        className={`min-h-11 px-2 font-medium ${askMode === 'howto' ? 'bg-brand text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                        How Turnrow works
                      </button>
                    </div>
                    {askMode === 'data' && (
                      <a href="/assistant" className="text-[11px] text-brand-deep underline decoration-dotted whitespace-nowrap min-h-11 inline-flex items-center">Full page ↗</a>
                    )}
                  </div>
                  <div className="flex-1 min-h-0">
                    {askMode === 'data'
                      ? <AssistantChat role={role} />
                      : <SupportChat route={pathname ?? '/'} onEscalate={(t) => { setTranscript(t); setTab('support') }} />}
                  </div>
                </div>
              )}

              {tab === 'support' && <SupportForm route={pathname ?? '/'} transcript={transcript} />}
            </div>

            {tab === 'help' && (
              <div className="border-t border-slate-200 px-4 py-2.5 flex gap-2">
                <button type="button" onClick={() => setTab('ask')}
                  className="flex-1 rounded-lg border border-slate-300 px-3 min-h-11 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  Ask Turnrow
                </button>
                <button type="button" onClick={() => setTab('support')}
                  className="flex-1 rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-11 text-sm font-semibold">
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
