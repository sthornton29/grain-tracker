'use client'

// The new-operation setup checklist on the landing page. The server
// (app/page.tsx) decides what's done from head counts; this client piece
// only adds the "Hide setup" choice, remembered per browser, and the
// progress line. Renders nothing until mounted so the hidden state never
// flashes.

import Link from 'next/link'
import { useEffect, useState } from 'react'

export type ChecklistItem = {
  label: string
  href: string
  done: boolean
  hint: string
  /** Shown as "Review" instead of a number/check — something to look over, not a gate. */
  review?: boolean
  optional?: boolean
}

const KEY = 'turnrow:setup-hidden'

export default function FirstRunChecklist({ items }: { items: ChecklistItem[] }) {
  const [hidden, setHidden] = useState<boolean | null>(null)

  useEffect(() => {
    try { setHidden(window.localStorage.getItem(KEY) === '1') } catch { setHidden(false) }
  }, [])

  if (hidden == null || hidden) return null

  const counted = items.filter((i) => !i.optional)
  const doneCount = counted.filter((i) => i.done).length

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 space-y-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[12rem]">
          <h2 className="text-xl font-bold font-display">Welcome — let&rsquo;s set up your operation</h2>
          <p className="text-sm text-slate-500 mt-1">
            Work down the list; each step opens the page that does it. Most of this is uploading paperwork you already have.
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold text-slate-700">{doneCount} of {counted.length} done</div>
          <button
            type="button"
            onClick={() => { try { window.localStorage.setItem(KEY, '1') } catch { /* fine */ } setHidden(true) }}
            className="text-xs text-slate-500 underline decoration-dotted min-h-11"
          >
            Hide setup
          </button>
        </div>
      </div>
      <ol className="space-y-2">
        {items.map((item, i) => (
          <li key={item.href + item.label}>
            <Link href={item.href} className="flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 hover:bg-slate-50 min-h-11">
              <span
                aria-hidden
                className={`mt-0.5 h-6 shrink-0 rounded-full text-xs font-bold flex items-center justify-center px-1.5 ${
                  item.done ? 'bg-green-600 text-white w-6' : item.review ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-600 w-6'
                }`}
              >
                {item.done ? '✓' : item.review ? 'Review' : i + 1}
              </span>
              <span>
                <span className={`font-semibold ${item.done ? 'text-slate-400 line-through' : ''}`}>
                  {item.label}
                  {item.optional && <span className="ml-2 text-xs font-normal text-slate-400">optional</span>}
                </span>
                <span className="block text-xs text-slate-500">{item.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  )
}
