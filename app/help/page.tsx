'use client'

// The Help Center — every topic, grouped the way the app is organized, with
// search across titles, keywords, and content. Available to EVERY role
// (help is never restricted). Content ships with the app; each topic shows
// its last-updated date.

import { useMemo, useState } from 'react'
import { HELP_TOPICS, HELP_GENERATED, type HelpTopic } from '@/lib/help-content.generated'
import { topicForRoute, searchTopics, groupTopics } from '@/lib/help'
import { renderHelpMarkdown } from '@/lib/help-markdown'

export default function HelpCenterPage() {
  const [query, setQuery] = useState('')
  const [openRoute, setOpenRoute] = useState<string | null>(null)
  const results = useMemo(() => searchTopics(HELP_TOPICS, query), [query])
  const groups = useMemo(() => groupTopics(results), [results])
  const open = openRoute ? topicForRoute(HELP_TOPICS, openRoute) : null

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold font-display">Help Center</h1>
        <p className="text-sm text-slate-500 mt-1">
          How every part of Turnrow works. For anything about your own numbers, use Contact Support in
          the <span className="font-semibold">?</span> menu — it reaches a person.
        </p>
      </div>

      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpenRoute(null) }}
        placeholder="Search help — try “basis”, “harvest complete”, “invite”…"
        className="w-full rounded-xl border border-slate-300 px-4 py-2.5 shadow-sm"
      />

      {open ? (
        <div className="bg-white rounded-xl shadow p-5">
          <button type="button" onClick={() => setOpenRoute(null)} className="text-sm text-brand-deep underline decoration-dotted mb-2">
            ← All topics
          </button>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-display font-bold text-xl text-brand-dark">{open.title}</h2>
            <span className="text-xs text-slate-400">updated {open.updated}</span>
          </div>
          <div className="mt-2">{renderHelpMarkdown(open.body)}</div>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.title}>
              <h2 className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-2">{g.title}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {g.topics.map((t: HelpTopic) => (
                  <button key={t.route} type="button" onClick={() => setOpenRoute(t.route)}
                    className="text-left bg-white rounded-xl shadow p-4 hover:bg-slate-50">
                    <div className="font-semibold">{t.title}</div>
                    <div className="text-xs text-slate-400 mt-0.5">updated {t.updated}</div>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {results.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">
              Nothing matched — try different words, or ask the assistant from the <b>?</b> menu.
            </p>
          )}
        </>
      )}

      <p className="text-[11px] text-slate-400 text-center">Help content generated {HELP_GENERATED}.</p>
    </div>
  )
}
