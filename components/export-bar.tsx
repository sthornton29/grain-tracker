'use client'

import { useState } from 'react'
import { exportToExcel, exportToPdf, printReport, type ExportPayload } from '@/lib/exports'

type Props = {
  /** Called when the user clicks an export. Recomputes the payload on the
   *  fly so the export reflects current filters without leaking state. */
  buildPayload: () => ExportPayload
  className?: string
}

// Hides itself when printing — no Export/Print/PDF buttons on the printed page.
export default function ExportBar({ buildPayload, className }: Props) {
  const [busy, setBusy] = useState<null | 'xlsx' | 'pdf'>(null)
  const [err, setErr] = useState<string | null>(null)

  async function go(kind: 'xlsx' | 'pdf') {
    setBusy(kind)
    setErr(null)
    try {
      const payload = buildPayload()
      if (kind === 'xlsx') await exportToExcel(payload)
      else await exportToPdf(payload)
    } catch (e: any) {
      setErr(e?.message ?? `Couldn't export ${kind.toUpperCase()}.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={`flex flex-wrap gap-2 no-print ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => go('xlsx')}
        disabled={busy != null}
        className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {busy === 'xlsx' ? 'Exporting…' : 'Export Excel'}
      </button>
      <button
        type="button"
        onClick={() => go('pdf')}
        disabled={busy != null}
        className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {busy === 'pdf' ? 'Exporting…' : 'Export PDF'}
      </button>
      <button
        type="button"
        onClick={() => printReport()}
        className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm"
      >
        Print
      </button>
      {err && <span className="text-sm text-red-600 self-center">{err}</span>}
    </div>
  )
}
