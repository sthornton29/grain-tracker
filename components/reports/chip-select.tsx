'use client'

// Multi-select chips for report filters (2026-10-20). A short option list
// renders as toggle chips in a row; a long one (farms, fields, receipts)
// renders as a button that opens a searchable checklist — every control
// stays a 44px touch target for the iPad in the truck. Nothing here knows
// what it filters; the report keeps its own state.

import { useEffect, useMemo, useRef, useState } from 'react'

export type ChipOption = { id: string; label: string; hint?: string }

const chipOn = 'rounded-full bg-brand hover:bg-brand-deep text-white px-3 min-h-10 text-xs font-semibold'
const chipOff = 'rounded-full bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-3 min-h-10 text-xs'

export function ChipMultiSelect({
  label, options, value, onChange, inlineUpTo = 6, allLabel = 'All', searchable,
}: {
  label: string
  options: ChipOption[]
  value: string[]
  onChange: (next: string[]) => void
  /** Up to this many options render inline as chips; more open a checklist. */
  inlineUpTo?: number
  allLabel?: string
  /** Force the checklist (with its search box) even for short lists. */
  searchable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const inline = !searchable && options.length <= inlineUpTo

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent | TouchEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('touchstart', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  const selectedLabels = useMemo(() => options.filter((o) => value.includes(o.id)).map((o) => o.label), [options, value])
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? options.filter((o) => o.label.toLowerCase().includes(t) || (o.hint ?? '').toLowerCase().includes(t)) : options
  }, [options, q])

  if (inline) {
    return (
      <div className="text-sm flex flex-col gap-1">
        <span className="text-slate-500">{label}</span>
        <div className="flex flex-wrap gap-1.5 items-center">
          {options.map((o) => {
            const on = value.includes(o.id)
            return (
              <button key={o.id} type="button" aria-pressed={on} onClick={() => toggle(o.id)} className={on ? chipOn : chipOff}>{o.label}</button>
            )
          })}
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="text-xs text-slate-500 underline px-2 min-h-10">Clear</button>
          )}
        </div>
      </div>
    )
  }

  const summary = value.length === 0 ? allLabel : value.length <= 2 ? selectedLabels.join(', ') : `${value.length} selected`
  return (
    <div className="text-sm flex flex-col gap-1 relative" ref={wrap}>
      <span className="text-slate-500">{label}</span>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
        className={`rounded-lg border px-3 min-h-10 text-left text-sm bg-white max-w-[16rem] truncate ${value.length ? 'border-brand text-brand-deep font-semibold' : 'border-slate-300 text-slate-700'}`}
      >
        {summary} <span className="text-slate-400 ml-1">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 top-full mt-1 left-0 w-72 max-w-[90vw] rounded-xl border border-slate-200 bg-white shadow-lg p-2 space-y-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${label.toLowerCase()}…`}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm min-h-10"
            aria-label={`Search ${label}`}
          />
          <div className="max-h-64 overflow-y-auto divide-y divide-slate-100" role="listbox" aria-multiselectable="true">
            {filtered.length === 0 && <div className="text-xs text-slate-400 px-2 py-3">Nothing matches.</div>}
            {filtered.map((o) => {
              const on = value.includes(o.id)
              return (
                <label key={o.id} className="flex items-center gap-2 px-2 min-h-11 cursor-pointer hover:bg-slate-50">
                  <input type="checkbox" checked={on} onChange={() => toggle(o.id)} className="h-4 w-4 accent-[#36B449]" />
                  <span className="flex-1 text-sm truncate">{o.label}</span>
                  {o.hint && <span className="text-xs text-slate-400 whitespace-nowrap">{o.hint}</span>}
                </label>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button type="button" onClick={() => onChange([])} className="text-xs text-slate-500 underline px-2 min-h-10">Clear</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-slate-800 text-white text-xs font-semibold px-3 min-h-10">Done</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** A two- or three-way toggle (weighting, mode) as segmented chips. */
export function SegmentedChips<T extends string>({ label, options, value, onChange }: {
  label?: string
  options: Array<{ key: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="text-sm flex flex-col gap-1">
      {label && <span className="text-slate-500">{label}</span>}
      <div className="inline-flex rounded-lg border border-slate-300 bg-white overflow-hidden">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
            className={`px-3 min-h-10 text-xs font-semibold ${value === o.key ? 'bg-slate-800 text-white' : 'text-slate-700 hover:bg-slate-50'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
