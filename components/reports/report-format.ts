// Pure formatting, color semantics, and class tokens shared by every report —
// a PLAIN module (no 'use client') so SERVER components can call these too.
// components/reports/report-kit.tsx re-exports everything here, so client
// code keeps importing from the kit; server pages import from this file.
// Importing a function from a 'use client' module into a server component
// gives a client reference, and calling it throws at request time — see
// lib/server-client-imports.test.ts, the gate that catches it.

// ---------- number formatting ----------

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return ''
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
export function fmtNum(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return ''
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}
// Dollars: negatives in parentheses — the financial convention every export
// already follows (lib/exports.ts). This is THE on-screen dollar formatter;
// reports must not keep private `usd` helpers that print "$-1,234".
export function fmtUsd(n: number | null | undefined, d = 0): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  const body = `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
  return v < 0 ? `(${body})` : body
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

// Fill color for a bar segment with the same semantics as toneText.
export function toneFill(tone: Tone): string {
  switch (tone) {
    case 'favorable': return 'bg-green-600'
    case 'unfavorable': return 'bg-red-600'
    case 'warning': return 'bg-amber-500'
    case 'muted': return 'bg-slate-300'
    default: return 'bg-slate-600'
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
// Sticky first column for wide tables on iPad: put `stickyColCls` on the first
// <th> and <td> of each row (the government-payments pattern). Header cells
// need `${theadCls}` behind them so the sticky header keeps its background.
export const stickyColCls = 'sticky left-0 z-[1] bg-white shadow-[inset_-1px_0_0_#e2e8f0]'
export const stickyColHeadCls = 'sticky left-0 z-20 bg-slate-100 shadow-[inset_-1px_0_0_#e2e8f0]'
// Every tappable control at least 40px tall (iPad-in-truck).
export const touchTarget = 'min-h-10 min-w-10'
// The one filter <select> look.
export const selectCls = 'rounded-lg border border-slate-300 px-3 py-2 bg-white text-sm min-h-10'
export const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 bg-white text-sm min-h-10'

// Plain-English filter summary: joins the non-blank parts with " · ".
export function filterSummaryOf(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join(' · ')
}

// "2026 Crop Year" / "All crop years".
export function cropYearLabel(y: number | '' | null | undefined): string {
  return y === '' || y == null ? 'All crop years' : `${y} Crop Year`
}
