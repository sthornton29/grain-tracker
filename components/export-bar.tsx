'use client'

import { useState } from 'react'
import { exportToCsv, exportToExcel, exportToPdf, printReport, type ExportPayload } from '@/lib/exports'
import { reportError } from '@/lib/friendly-error'

export type ExportFormat = 'xlsx' | 'pdf' | 'csv' | 'print'

type Props = {
  /** Called when the user clicks an export. Recomputes the payload on the
   *  fly so the export reflects current filters without leaking state. */
  buildPayload: () => ExportPayload
  /** Which buttons to show, in order. Defaults to Excel / PDF / Print; a
   *  page whose users want a plain spreadsheet file adds 'csv'. */
  formats?: ExportFormat[]
  /** Compact buttons for a selection bar or a card. */
  size?: 'sm' | 'md'
  className?: string
}

const DEFAULT_FORMATS: ExportFormat[] = ['xlsx', 'pdf', 'print']

const LABEL: Record<ExportFormat, string> = { xlsx: 'Export Excel', pdf: 'Export PDF', csv: 'Export CSV', print: 'Print' }

// Hides itself when printing — no Export/Print/PDF buttons on the printed page.
export default function ExportBar({ buildPayload, formats = DEFAULT_FORMATS, size = 'md', className }: Props) {
  const [busy, setBusy] = useState<null | ExportFormat>(null)
  const [err, setErr] = useState<string | null>(null)

  async function go(kind: ExportFormat) {
    if (kind === 'print') { printReport(); return }
    setBusy(kind)
    setErr(null)
    try {
      const payload = buildPayload()
      if (kind === 'xlsx') await exportToExcel(payload)
      else if (kind === 'pdf') await exportToPdf(payload)
      else await exportToCsv(payload)
    } catch (e) {
      setErr(reportError(e as Error, { action: 'build this export' }))
    } finally {
      setBusy(null)
    }
  }

  // Both sizes keep the 44px touch floor; 'sm' only tightens the width.
  const pad = size === 'sm' ? 'px-2.5 min-h-11 text-sm' : 'px-3 min-h-11 text-sm'
  const cls: Record<ExportFormat, string> = {
    xlsx: `rounded-lg bg-brand hover:bg-brand-deep text-white font-semibold disabled:opacity-50 ${pad}`,
    pdf: `rounded-lg bg-slate-700 text-white font-semibold disabled:opacity-50 ${pad}`,
    csv: `rounded-lg bg-white border border-slate-300 font-semibold disabled:opacity-50 ${pad}`,
    print: `rounded-lg bg-white border border-slate-300 ${pad}`,
  }

  return (
    <div className={`flex flex-wrap gap-2 no-print ${className ?? ''}`}>
      {formats.map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => go(kind)}
          disabled={busy != null}
          className={cls[kind]}
        >
          {busy === kind ? 'Exporting…' : LABEL[kind]}
        </button>
      ))}
      {err && <span className="text-sm text-red-600 self-center">{err}</span>}
    </div>
  )
}
