'use client'

// The one header every cotton page opens with (2026-10-12): a small module
// mark + "Cotton" eyebrow (the module's own color — the pink of round-module
// wrap, the same tick the landing tile carries), a display title, a one-line
// sub in plain words, the crop year, and the page's actions (ExportBar…).
// Presentation only.

import type { ReactNode } from 'react'

export function CottonPageHeader({
  title, sub, cropYear, years, onCropYear, actions, eyebrow = 'Cotton',
}: {
  title: ReactNode
  /** Plain-English line under the title ("Module tickets off the field · what is still on the yard"). */
  sub?: string
  cropYear?: number
  /** Years offered in the select (newest first). Omit with onCropYear for a page without a year. */
  years?: number[]
  onCropYear?: (year: number) => void
  actions?: ReactNode
  eyebrow?: string
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-fuchsia-600" />
          {eyebrow}
        </div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 leading-tight mt-0.5">{title}</h1>
        {sub && <p className="text-sm text-slate-500 mt-1">{sub}</p>}
      </div>
      <div className="flex items-end gap-3 flex-wrap no-print">
        {cropYear != null && onCropYear && (
          <label className="text-sm flex flex-col gap-1">
            <span className="text-xs text-slate-500">Crop year</span>
            <select
              value={cropYear}
              onChange={(e) => onCropYear(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-3 min-h-11 text-base sm:text-sm font-semibold tabular-nums"
              aria-label="Crop year"
            >
              {(years ?? [cropYear]).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        )}
        {actions}
      </div>
    </div>
  )
}

/** A white card section with a quiet heading row — the body the cotton pages share. */
export function CottonSection({ title, sub, aside, children, className = '' }: { title?: ReactNode; sub?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-white rounded-xl shadow overflow-hidden ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2 border-b border-slate-100">
          <div className="flex-1 min-w-0">
            {title && <h2 className="font-semibold text-slate-900">{title}</h2>}
            {sub && <p className="text-xs text-slate-500">{sub}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

/** Status pill — the two states a seed cotton load has. */
export function GinnedPill({ ginned, size = 'sm' }: { ginned: boolean; size?: 'sm' | 'md' }) {
  const pad = size === 'md' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs'
  return ginned
    ? <span className={`inline-block rounded-full font-semibold bg-green-100 text-green-800 ${pad}`}>Ginned</span>
    : <span className={`inline-block rounded-full font-semibold bg-amber-100 text-amber-800 ${pad}`}>On the yard</span>
}
