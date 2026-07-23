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

import { useState, type ReactNode } from 'react'

// ---------- number formatting ----------

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return ''
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
export function fmtNum(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return ''
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}
export function fmtUsd(n: number | null | undefined, d = 0): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
}
export function fmtPct(n: number | null | undefined, d = 0): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}%`
}

// ---------- color semantics ----------

export type Tone = 'favorable' | 'unfavorable' | 'warning' | 'muted' | 'neutral'

export function toneText(tone: Tone): string {
  switch (tone) {
    case 'favorable': return 'text-green-700'
    case 'unfavorable': return 'text-red-700'
    case 'warning': return 'text-amber-700'
    case 'muted': return 'text-slate-400'
    default: return 'text-slate-700'
  }
}

// Tone for a signed number: positive favorable, negative unfavorable, else muted.
export function signedTone(n: number | null | undefined): Tone {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) === 0) return 'muted'
  return Number(n) > 0 ? 'favorable' : 'unfavorable'
}

// ---------- shared table class tokens (for hand-built tables) ----------

// Right-aligned tabular figures so columns line up.
export const numCell = 'px-2 py-1 text-right tabular-nums whitespace-nowrap'
export const textCell = 'px-2 py-1'
export const theadCls = 'bg-slate-100 text-slate-700 sticky top-0 z-10'
export const subtotalRowCls = 'bg-slate-50 font-semibold'
export const grandTotalRowCls = 'bg-slate-100 font-bold border-t-2 border-slate-400'

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
}

export function SummaryCards({ cards }: { cards: SummaryCardData[] }) {
  if (cards.length === 0) return null
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {cards.map((c, i) => <SummaryCard key={`${c.label}-${i}`} {...c} />)}
    </div>
  )
}

export function SummaryCard({ label, value, sub, tone = 'neutral' }: SummaryCardData) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${toneText(tone)}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  )
}

// ---------- EmptyState ----------

// Friendly empty state: what's missing + where to fix it.
export function EmptyState({
  message, hint, linkHref, linkLabel,
}: {
  message: string
  hint?: string
  linkHref?: string
  linkLabel?: string
}) {
  return (
    <div className="bg-white rounded-xl shadow p-8 text-center">
      <p className="text-slate-600 font-medium">{message}</p>
      {hint && <p className="text-sm text-slate-400 mt-1">{hint}</p>}
      {linkHref && linkLabel && (
        <a href={linkHref} className="inline-block mt-3 text-brand-deep font-semibold hover:underline">
          {linkLabel} →
        </a>
      )}
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
