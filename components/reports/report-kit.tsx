'use client'

// Shared report design system. One consistent look for every report:
// header + filter bar + summary cards + tables + empty states, with consistent
// number formatting and color semantics. Presentation only — reports keep their
// own data, calculations, and export wiring.
//
// Color semantics (use the `tone` prop / helpers, don't hand-pick colors):
//   favorable  = green  (profit, gain, on-track)
//   unfavorable= red    (loss, shortfall)
//   warning    = amber  (incomplete, needs attention)
//   muted      = gray   (excluded / not applicable)
//   neutral    = slate  (default)

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { roleAllowsPath } from '@/lib/route-guard'
import type { AppRole } from '@/lib/types'

// ---------- formatting, tones, class tokens ----------
//
// The pure helpers live in report-format.ts (a plain module, callable from
// SERVER components); they are re-exported here so client code keeps one
// import. Server pages must import from './report-format' directly.
export * from './report-format'
import { fmtUsd, grandTotalRowCls, subtotalRowCls, theadCls, toneText, type Tone } from './report-format'

// ---------- FilterField (a labeled select / input) ----------

// Every filter control gets a visible label. Wraps a <select> or <input>.
export function FilterField({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`text-sm flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-slate-500">{label}</span>
      {children}
    </label>
  )
}

// ---------- ReportHeader ----------

export function ReportHeader({
  title, filterSummary, generatedAt, actions,
}: {
  title: string
  // Active filters in plain English, e.g. "2026 Crop Year · All Entities · Corn".
  filterSummary?: string
  // ISO date the report reflects (defaults to today, shown as "Generated …").
  generatedAt?: string
  // Right-aligned actions, typically <ExportBar/>.
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex-1 min-w-0">
        <h1 className="text-xl font-bold text-slate-900">{title}</h1>
        {filterSummary && <p className="text-sm text-slate-500 mt-0.5">{filterSummary}</p>}
        {generatedAt && <p className="text-xs text-slate-400 mt-0.5">Generated {generatedAt}</p>}
      </div>
      {actions && <div className="shrink-0 no-print">{actions}</div>}
    </div>
  )
}

// ---------- ReportFilterBar ----------

// A single horizontal filter row. On narrow screens (iPad portrait / phone) it
// collapses behind a "Filters" button with a count badge of active filters.
export function ReportFilterBar({
  children, activeCount = 0,
}: {
  children: ReactNode
  activeCount?: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="no-print">
      {/* Collapsed control — only on small screens. */}
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="sm:hidden inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium"
      >
        <span>{open ? '▾' : '▸'} Filters</span>
        {activeCount > 0 && (
          <span className="rounded-full bg-slate-800 text-white text-xs px-1.5 py-0.5 leading-none">{activeCount}</span>
        )}
      </button>
      {/* Filters: always visible on sm+, toggle on mobile. */}
      <div className={`${open ? 'flex' : 'hidden'} sm:flex flex-wrap gap-3 items-end mt-2 sm:mt-0`}>
        {children}
      </div>
    </div>
  )
}

// ---------- SummaryCards ----------

export type SummaryCardData = {
  label: string
  value: string
  sub?: string
  tone?: Tone
  /** Makes the card a button — for a drill-down into where the number
   *  comes from. The whole card is the target (iPad-sized). */
  onClick?: () => void
}

export function SummaryCards({ cards }: { cards: SummaryCardData[] }) {
  if (cards.length === 0) return null
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {cards.map((c, i) => <SummaryCard key={`${c.label}-${i}`} {...c} />)}
    </div>
  )
}

export function SummaryCard({ label, value, sub, tone = 'neutral', onClick }: SummaryCardData) {
  const body = (
    <>
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${toneText(tone)}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="bg-white rounded-xl shadow p-4 text-left w-full hover:shadow-md hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand min-h-11"
        aria-label={`${label}: ${value}. Show where it comes from.`}
      >
        {body}
        <div className="text-[11px] text-brand-deep mt-1 no-print">Tap for detail</div>
      </button>
    )
  }
  return <div className="bg-white rounded-xl shadow p-4">{body}</div>
}

// ---------- EmptyState ----------

// Friendly empty state: what's missing + where to fix it. Pass the user's
// `role` (or `canFix`) so a viewer / agronomist is never handed a link to a
// page they cannot open — they get "Ask the operator to …" instead.
export function EmptyState({
  message, hint, linkHref, linkLabel, role, canFix,
}: {
  message: string
  hint?: string
  linkHref?: string
  linkLabel?: string
  /** The current user's role; the link is shown only if the role may open it. */
  role?: AppRole
  /** Explicit override of the role check. */
  canFix?: boolean
}) {
  const allowed = canFix ?? (role == null || !linkHref ? true : roleAllowsPath(role, linkHref))
  const ask = linkLabel ? `Ask the operator to ${linkLabel.charAt(0).toLowerCase()}${linkLabel.slice(1)}.` : null
  return (
    <div className="bg-white rounded-xl shadow p-8 text-center">
      <p className="text-slate-600 font-medium">{message}</p>
      {hint && <p className="text-sm text-slate-400 mt-1">{hint}</p>}
      {linkHref && linkLabel && allowed && (
        <a href={linkHref} className="inline-flex items-center mt-3 min-h-10 px-2 text-brand-deep font-semibold hover:underline">
          {linkLabel} →
        </a>
      )}
      {linkHref && linkLabel && !allowed && ask && (
        <p className="text-sm text-slate-500 mt-3">{ask}</p>
      )}
    </div>
  )
}

// ---------- InfoTip (tap-to-reveal explanation) ----------

// A badge or "?" that opens its explanation on tap/click/keyboard — never a
// title= tooltip, which iPad cannot show. The explanation renders in a small
// popover under the trigger; tap anywhere else or press Escape to close.
export function InfoTip({
  label, children, tone = 'neutral', className, ariaLabel,
}: {
  /** The visible trigger text (e.g. "includes assumptions" or "?"). */
  label: ReactNode
  /** The explanation. */
  children: ReactNode
  tone?: Tone
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent | TouchEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('touchstart', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pill = tone === 'warning'
    ? 'bg-amber-100 text-amber-800'
    : tone === 'favorable'
      ? 'bg-green-100 text-green-800'
      : tone === 'unfavorable'
        ? 'bg-red-100 text-red-800'
        : tone === 'muted'
          ? 'bg-slate-100 text-slate-500'
          : 'bg-slate-100 text-slate-700'
  return (
    <span ref={wrap} className={`relative inline-block align-middle no-print ${className ?? ''}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((s) => !s)}
        className={`inline-flex items-center rounded-full px-2 min-h-6 text-[11px] font-medium leading-none ${pill} hover:brightness-95`}
      >
        {label}
      </button>
      {open && (
        <span
          role="note"
          className="absolute left-0 top-full mt-1 z-30 w-64 max-w-[80vw] rounded-lg border border-slate-200 bg-white p-2 text-xs text-left font-normal text-slate-700 shadow-lg whitespace-normal"
        >
          {children}
        </span>
      )}
    </span>
  )
}

// ---------- SourceChip (small muted tag, e.g. where a line came from) ----------

export function SourceChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-block rounded-full bg-slate-100 text-slate-500 text-[10px] font-medium px-1.5 py-0.5 align-middle whitespace-nowrap ${className ?? ''}`}>
      {children}
    </span>
  )
}

// ---------- Disclosure (a collapsed "Needs attention (N)" panel) ----------

export function Disclosure({
  title, count, children, defaultOpen = false, tone = 'warning', className,
}: {
  title: string
  count?: number
  children: ReactNode
  defaultOpen?: boolean
  tone?: Tone
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const border = tone === 'warning'
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : tone === 'unfavorable'
      ? 'border-red-200 bg-red-50 text-red-900'
      : 'border-slate-200 bg-slate-50 text-slate-800'
  return (
    <div className={`rounded-lg border ${border} no-print ${className ?? ''}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
        className="w-full flex items-center gap-2 px-3 min-h-10 text-sm font-semibold text-left"
      >
        <span aria-hidden className="text-xs">{open ? '▾' : '▸'}</span>
        <span className="flex-1">
          {title}{count != null && <span className="font-normal"> ({count})</span>}
        </span>
      </button>
      {open && <div className="px-3 pb-3 text-sm space-y-2">{children}</div>}
    </div>
  )
}

// ---------- ViewTabs (a row of view switches sharing one filter strip) ----------

export function ViewTabs<T extends string>({
  tabs, value, onChange, ariaLabel = 'View',
}: {
  tabs: Array<{ key: T; label: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex flex-wrap gap-1 border-b border-slate-200 no-print">
      {tabs.map((t) => {
        const active = t.key === value
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={`min-h-10 px-3 text-sm font-medium -mb-px border-b-2 ${active ? 'border-brand text-brand-dark' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------- MonthlyBars (a stacked bar per period, no chart library) ----------

export type MonthlyBarSeries = { key: string; label: string; className: string }
export type MonthlyBarRow = { key: string; label: string; values: Record<string, number> }

// One stacked bar per month, all bars on a shared scale, with a legend. Values
// below zero are ignored (outflows are listed in the table underneath).
export function MonthlyBars({
  series, rows, format = (n) => fmtUsd(n, 0), height = 'h-32',
}: {
  series: MonthlyBarSeries[]
  rows: MonthlyBarRow[]
  format?: (n: number) => string
  height?: string
}) {
  const totals = rows.map((r) => series.reduce((s, x) => s + Math.max(0, r.values[x.key] ?? 0), 0))
  const max = Math.max(0, ...totals)
  if (rows.length === 0 || max <= 0) return null
  return (
    <div className="space-y-2">
      <div className={`flex items-end gap-1 ${height} overflow-x-auto px-1`}>
        {rows.map((r, i) => (
          <div key={r.key} className="flex-1 min-w-[1.25rem] h-full flex flex-col justify-end" title={`${r.label}: ${format(totals[i])}`}>
            <div className="flex flex-col-reverse rounded-t overflow-hidden" style={{ height: `${(totals[i] / max) * 100}%` }}>
              {series.map((s) => {
                const v = Math.max(0, r.values[s.key] ?? 0)
                if (v <= 0 || totals[i] <= 0) return null
                return <div key={s.key} className={s.className} style={{ height: `${(v / totals[i]) * 100}%` }} aria-label={`${s.label} ${format(v)}`} />
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-1 px-1 text-[10px] text-slate-500">
        {rows.map((r) => (
          <div key={r.key} className="flex-1 min-w-[1.25rem] text-center truncate">{r.label}</div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span className={`inline-block w-3 h-3 rounded-sm ${s.className}`} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------- DataTable (generic flat table) ----------

export type ColumnAlign = 'left' | 'right'
export type DataColumn = { label: string; align?: ColumnAlign }
export type CellValue = { content: ReactNode; align?: ColumnAlign; tone?: Tone; className?: string }
export type DataRow = {
  key: string
  cells: Array<ReactNode | CellValue>
  // 'subtotal' = light gray semibold; 'total' = darker bold with a top border.
  kind?: 'normal' | 'subtotal' | 'total'
}

function cellOf(c: ReactNode | CellValue): CellValue {
  return c != null && typeof c === 'object' && 'content' in (c as object)
    ? (c as CellValue)
    : { content: c as ReactNode }
}

// A consistently-styled table: sticky header, zebra striping, right-aligned
// tabular numbers, visually distinct subtotal/grand-total rows. For tables with
// grouped/multi-row headers, use the exported class tokens on a hand-built table.
export function DataTable({ columns, rows, dense }: { columns: DataColumn[]; rows: DataRow[]; dense?: boolean }) {
  const pad = dense ? 'px-2 py-1' : 'px-3 py-2'
  return (
    <div className="overflow-x-auto bg-white rounded-xl shadow">
      <table className="min-w-full text-sm border-collapse">
        <thead className={theadCls}>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={`${pad} ${c.align === 'right' ? 'text-right' : 'text-left'} font-semibold whitespace-nowrap`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => {
            const rowCls = r.kind === 'total'
              ? grandTotalRowCls
              : r.kind === 'subtotal'
                ? subtotalRowCls
                : ri % 2 === 1 ? 'bg-slate-50/50' : ''
            return (
              <tr key={r.key} className={`border-t border-slate-100 ${rowCls}`}>
                {r.cells.map((raw, ci) => {
                  const c = cellOf(raw)
                  const align = c.align ?? columns[ci]?.align ?? 'left'
                  return (
                    <td
                      key={ci}
                      className={`${pad} ${align === 'right' ? 'text-right tabular-nums whitespace-nowrap' : ''} ${c.tone ? toneText(c.tone) : ''} ${c.className ?? ''}`}
                    >
                      {c.content}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------- StackedBar (proportional position bar) ----------

export type StackedSegment = { value: number; className: string; label?: string }

// A horizontal stacked bar showing segment proportions of a total. Used by the
// marketing "Marketing Position" visual (sold / hedged / unpriced).
export function StackedBar({ segments, height = 'h-5' }: { segments: StackedSegment[]; height?: string }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0)
  return (
    <div className={`flex w-full ${height} rounded-md overflow-hidden bg-slate-100`}>
      {total > 0 && segments.map((seg, i) => {
        const pct = (Math.max(0, seg.value) / total) * 100
        if (pct <= 0) return null
        return (
          <div
            key={i}
            className={`${seg.className} flex items-center justify-center overflow-hidden`}
            style={{ width: `${pct}%` }}
            title={seg.label}
          >
            {pct >= 12 && seg.label && <span className="text-[10px] font-semibold text-white/95 px-1 truncate">{seg.label}</span>}
          </div>
        )
      })}
    </div>
  )
}
