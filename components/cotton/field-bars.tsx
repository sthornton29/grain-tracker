'use client'

// The Seed Cotton Loads "by field" bars (2026-10-28): every cotton field this
// crop year on ONE pounds axis — green = ginned, amber = still on the yard, a
// faint outlined ghost out to what the field is expected to make (planted
// acres × expected lint ÷ turnout, the Yields page's own seams), a small tick
// where the expectation sits when the actual runs past it. Rows tap to filter
// the loads list to that field; the ⓘ (tap, works on iPad) opens the numbers.
// Color is never the only signal: the figure text carries the ginned share
// and the chip carries the status.

import { useState } from 'react'
import { fmtInt, fmtPct } from '@/components/reports/report-kit'
import { SegmentedChips } from '@/components/reports/chip-select'
import {
  FIELD_BAR_SORT_LABEL, FIELD_STATUS_CHIP, FIELD_STATUS_LABEL, axisLabels, sortFieldBars,
  type FieldBarRow, type FieldBarSort,
} from '@/lib/cotton-by-field'

export type FieldBarLabel = { name: string; farm: string | null }

export function FieldBars({
  rows, axisMax, labelFor, onPick, activeFieldId,
}: {
  rows: FieldBarRow[]
  axisMax: number
  /** Field name and its farm (muted) for a field id; null id = loads with no field. */
  labelFor: (fieldId: string | null) => FieldBarLabel
  /** Tap a row → filter the loads list to that field (the page toggles it off on a second tap). */
  onPick?: (fieldId: string | null) => void
  /** The field the list is filtered to, if any (the row reads pressed). */
  activeFieldId?: string | null
}) {
  const [sort, setSort] = useState<FieldBarSort>('default')
  const [openId, setOpenId] = useState<string | null>(null)
  const sorted = sortFieldBars(rows, sort, (id) => labelFor(id).name)
  const axis = axisLabels(axisMax, (n) => fmtInt(n))

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="text-xs text-slate-500 uppercase tracking-wide">By field</div>
        <SegmentedChips<FieldBarSort>
          label=""
          value={sort}
          onChange={setSort}
          options={(['default', 'name', 'pounds', 'pct'] as FieldBarSort[]).map((k) => ({ key: k, label: FIELD_BAR_SORT_LABEL[k] }))}
        />
      </div>
      {/* The shared axis — one scale for every bar below. */}
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,16rem)_1fr_minmax(11rem,auto)_auto] sm:gap-x-3 text-[11px] text-slate-400 tabular-nums">
        <span className="hidden sm:block" />
        <span className="flex justify-between"><span>{axis.left}</span><span>{axis.mid}</span><span>{axis.right}</span></span>
        <span className="hidden sm:block" />
        <span className="hidden sm:block" />
      </div>
      <ul className="divide-y divide-slate-100">
        {sorted.map((r) => {
          const key = r.fieldId ?? '__none__'
          const label = labelFor(r.fieldId)
          const pressed = activeFieldId != null && activeFieldId === r.fieldId
          const figure = r.netLbs > 0
            ? `${fmtInt(r.netLbs)} lb · ${r.pctGinned != null ? fmtPct(r.pctGinned) : '0%'} ginned`
            : 'not started'
          const aria = [
            `${label.farm ? `${label.farm} ` : ''}${label.name}:`,
            r.acres != null ? `${fmtInt(r.acres)} acres,` : '',
            `${fmtInt(r.ginnedLbs)} pounds ginned, ${fmtInt(r.yardLbs)} pounds on the yard,`,
            r.expectedLbs != null ? `${fmtInt(Math.round(r.expectedLbs))} pounds expected (${fmtPct(r.pctOfExpected ?? 0)} of expected),` : 'no expectation on file,',
            FIELD_STATUS_LABEL[r.status],
          ].filter(Boolean).join(' ')
          const pct = (f: number) => `${Math.max(0, Math.min(100, f * 100))}%`
          const Row = (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,16rem)_1fr_minmax(11rem,auto)_auto] items-center gap-x-3 gap-y-1 py-1.5 text-sm">
              <span className="min-w-0 truncate text-slate-800">
                {label.farm && <span className="text-slate-400">{label.farm} · </span>}
                {label.name}
                {r.acres != null && <span className="ml-1 text-xs text-slate-400">{fmtInt(r.acres)} ac</span>}
              </span>
              <span className="sm:hidden justify-self-end">
                <StatusChip status={r.status} />
              </span>
              {/* The bar — full width on a phone under the name. */}
              <span className="col-span-2 sm:col-span-1 relative block h-4" role="img" aria-label={aria}>
                {r.ghostFrac != null && (
                  <span aria-hidden className="absolute inset-y-0 left-0 rounded border border-dashed border-slate-300 bg-slate-50" style={{ width: pct(r.ghostFrac) }} />
                )}
                <span aria-hidden className="absolute inset-y-0 left-0 flex rounded overflow-hidden" style={{ width: pct(r.ginnedFrac + r.yardFrac) }}>
                  <span className="bg-green-600 h-full" style={{ width: r.ginnedFrac + r.yardFrac > 0 ? `${(r.ginnedFrac / (r.ginnedFrac + r.yardFrac)) * 100}%` : '0%' }} />
                  <span className="bg-amber-400 h-full flex-1" />
                </span>
                {r.tickFrac != null && (
                  <span aria-hidden className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-slate-700" style={{ left: pct(r.tickFrac) }} />
                )}
              </span>
              <span className="col-span-2 sm:col-span-1 flex items-center justify-between sm:justify-end gap-2 whitespace-nowrap tabular-nums">
                <span className={r.netLbs > 0 ? 'text-slate-900' : 'text-slate-400'}>{figure}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setOpenId(openId === key ? null : key) }}
                  aria-expanded={openId === key}
                  aria-label={`Details for ${label.name}`}
                  className="inline-flex items-center justify-center rounded-full border border-slate-300 text-slate-500 text-[11px] font-semibold h-6 w-6 min-h-0 shrink-0 hover:bg-slate-50"
                >
                  i
                </button>
              </span>
              <span className="hidden sm:inline-flex justify-end">
                <StatusChip status={r.status} />
              </span>
            </div>
          )
          return (
            <li key={key} className="relative">
              {onPick ? (
                <button
                  type="button"
                  onClick={() => onPick(r.fieldId)}
                  aria-pressed={pressed}
                  className={`w-full text-left min-h-11 rounded px-1 -mx-1 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand ${pressed ? 'bg-green-50' : ''}`}
                  aria-label={`Show ${label.name} loads`}
                >
                  {Row}
                </button>
              ) : Row}
              {openId === key && (
                <div role="note" className="absolute right-0 top-full z-30 mt-1 w-72 max-w-[90vw] rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-lg">
                  <div className="font-semibold text-slate-900 mb-1">{label.farm ? `${label.farm} · ` : ''}{label.name}</div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
                    <dt className="text-slate-500">Acres</dt><dd className="text-right">{r.acres != null ? fmtInt(r.acres) : '—'}</dd>
                    <dt className="text-slate-500">Loads</dt><dd className="text-right">{fmtInt(r.loads)}</dd>
                    <dt className="text-slate-500">Rolls</dt><dd className="text-right">{r.rolls > 0 ? `${fmtInt(r.rolls)}${r.yardRolls > 0 ? ` (${fmtInt(r.yardRolls)} waiting)` : ''}` : '—'}</dd>
                    <dt className="text-slate-500">Ginned</dt><dd className="text-right">{fmtInt(r.ginnedLbs)} lb</dd>
                    <dt className="text-slate-500">On the yard</dt><dd className="text-right">{fmtInt(r.yardLbs)} lb</dd>
                    <dt className="text-slate-500">Expected</dt><dd className="text-right">{r.expectedLbs != null ? `${fmtInt(Math.round(r.expectedLbs))} lb` : '—'}</dd>
                    <dt className="text-slate-500">% of expected</dt><dd className="text-right">{r.pctOfExpected != null ? fmtPct(r.pctOfExpected) : '—'}</dd>
                  </dl>
                  {r.expectationNote && <p className="mt-2 text-amber-800">{r.expectationNote}. Set the expected lint yield under Marketing → Edit Assumptions and the turnout on any Yields view.</p>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-[11px] text-slate-400">
        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-green-600 align-middle" /> ginned ·{' '}
        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400 align-middle" /> on the yard ·{' '}
        <span aria-hidden className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-slate-300 bg-slate-50 align-middle" /> expected from your assumptions and turnout — a bar past the outline made more than expected. Tap a row to see just its loads.
      </p>
    </div>
  )
}

function StatusChip({ status }: { status: FieldBarRow['status'] }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${FIELD_STATUS_CHIP[status]}`}>{FIELD_STATUS_LABEL[status]}</span>
}
