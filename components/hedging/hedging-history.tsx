'use client'

// The hedging history timeline (083): one plain line per event, newest
// first, each expandable to its full detail. Used by the hedging page's
// History view, each position's detail dialog, and the Hedging Summary
// report's "Hedging activity" section (report styling via `report`).

import { useState } from 'react'
import { fmtPnl } from '@/lib/hedging'
import { fmtMd, type TimelineLine } from '@/lib/hedge-events'
import { signedTone, toneText, theadCls } from '@/components/reports/report-kit'

type Props = {
  lines: TimelineLine[]
  /** Report styling (report-kit header row, no card chrome). */
  report?: boolean
  emptyText?: string
  /** Optional per-line action (e.g. "Open position"). */
  renderAction?: (line: TimelineLine) => React.ReactNode
}

const KIND_CHIP: Record<string, string> = {
  roll: 'bg-sky-100 text-sky-800',
  opened: 'bg-green-100 text-green-800',
  roll_open: 'bg-sky-100 text-sky-800',
  closed: 'bg-slate-200 text-slate-700',
  roll_close: 'bg-sky-100 text-sky-800',
  partial_close: 'bg-slate-200 text-slate-700',
  imported: 'bg-slate-200 text-slate-700',
  edited: 'bg-amber-100 text-amber-800',
  crop_year_changed: 'bg-amber-100 text-amber-800',
  deleted: 'bg-red-100 text-red-800',
}
const KIND_LABEL: Record<string, string> = {
  roll: 'Roll', opened: 'Open', roll_open: 'Roll · open', closed: 'Close', roll_close: 'Roll · close',
  partial_close: 'Partial close', imported: 'Import', edited: 'Edit', crop_year_changed: 'Crop year', deleted: 'Delete',
}

export default function HedgingHistory({ lines, report, emptyText, renderAction }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  if (lines.length === 0) {
    return <div className={`px-4 py-6 text-sm text-slate-400 ${report ? '' : ''}`}>{emptyText ?? 'No hedging activity yet.'}</div>
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className={report ? theadCls : 'bg-slate-50 text-slate-600'}>
          <tr>
            <th className="text-left px-3 py-2 whitespace-nowrap w-16">Date</th>
            <th className="text-left px-3 py-2 whitespace-nowrap w-24">Event</th>
            <th className="text-left px-3 py-2">What happened</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Realized</th>
            {renderAction && <th className="px-3 py-2 no-print" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const expanded = open.has(l.id)
            return (
              <FragmentRows key={l.id}>
                <tr className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-slate-600">{fmtMd(l.date)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`text-[11px] rounded-full px-2 py-0.5 ${KIND_CHIP[l.kind] ?? 'bg-slate-200 text-slate-700'}`}>{KIND_LABEL[l.kind] ?? l.kind}</span>
                  </td>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => toggle(l.id)} className="text-left hover:text-brand-deep" title={expanded ? 'Hide detail' : 'Show detail'}>
                      <span className="mr-1 inline-block w-3 text-slate-400 no-print">{expanded ? '▾' : '▸'}</span>
                      {l.headline}
                    </button>
                    <span className="text-slate-400"> · {l.sourceLabel}</span>
                    {expanded && (
                      <ul className="mt-1.5 ml-4 space-y-0.5 text-xs text-slate-600 list-disc pl-4">
                        {l.detail.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${l.realized == null ? 'text-slate-300' : toneText(signedTone(l.realized))}`}>
                    {l.realized == null ? '—' : fmtPnl(l.realized)}
                  </td>
                  {renderAction && <td className="px-3 py-2 whitespace-nowrap text-right no-print">{renderAction(l)}</td>}
                </tr>
              </FragmentRows>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FragmentRows({ children }: { children: React.ReactNode; key?: string }) {
  return <>{children}</>
}
