'use client'

// "Assign bales from file" — bulk bale selection for the CCC loan, LDP, and
// contract-delivery workflows on /cotton/marketing. Accepts a CSV/text file
// (a PBI column or a bare list) or a PDF/photo (the AI extracts the bale-number
// list — gin and merchant recap sheets are long PBI columns), partitions the
// numbers into matched / conflicts / unmatched against cotton_bales, and adds
// all clean matches to the page's picked set in one action — the existing
// confirmed save paths (loan / LDP / contract assign) stay the single batch
// write. This is how hundreds of bales get onto a loan without hand-picking.

import { useState } from 'react'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { parseDocument } from '@/lib/pdf-upload'
import {
  parseBaleNumberList, partitionBaleAssignment,
  type AssignTarget, type BaleForAssign, type BaleListExtract, type BalePartition,
} from '@/lib/cotton-doc-import'
import type { CottonDisposition } from '@/lib/types'

const btnGray = 'rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50'
const btnCls = 'rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50'
const lbs0 = (n: number) => Math.round(n).toLocaleString()

type Props = {
  target: AssignTarget
  bales: ReadonlyArray<BaleForAssign>
  dispositionByBale: ReadonlyMap<string, CottonDisposition>
  loanedBaleIds: ReadonlySet<string>
  ldpBaleIds: ReadonlySet<string>
  /** Adds the clean matches to the page's picked set. */
  onAddMatches: (baleIds: string[]) => void
}

export default function BaleFileAssign({ target, bales, dispositionByBale, loanedBaleIds, ldpBaleIds, onAddMatches }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sourceNote, setSourceNote] = useState<string | null>(null)
  const [partition, setPartition] = useState<BalePartition | null>(null)
  const [showMatched, setShowMatched] = useState(false)

  function runPartition(tokens: string[], note: string) {
    const p = partitionBaleAssignment({ tokens, bales, dispositionByBale, loanedBaleIds, ldpBaleIds, target })
    setPartition(p)
    setSourceNote(note)
    setErr(tokens.length === 0 ? 'No bale numbers found in that file.' : null)
  }

  async function onCsvFile(file: File) {
    setBusy(true); setErr(null); setPartition(null)
    try {
      const text = await file.text()
      const parsed = parseBaleNumberList(text)
      runPartition(
        parsed.entries.map((e) => e.raw),
        `${file.name}: ${parsed.entries.length} bale numbers${parsed.duplicateCount > 0 ? ` (${parsed.duplicateCount} duplicate rows folded)` : ''}${parsed.usedHeaderColumn ? ' — PBI column detected' : ''}`,
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read that file.')
    } finally { setBusy(false) }
  }

  async function onDocSource(src: DocumentSource) {
    setBusy(true); setErr(null); setPartition(null)
    try {
      const result = await parseDocument(src.kind === 'pdf' ? src.file : src.images, 'cotton_marketing_document', { category: 'bale_list' })
      const pbis = ((result.extracted as BaleListExtract | null)?.bale_pbis ?? []).map(String)
      runPartition(pbis, `AI extracted ${pbis.length} bale numbers from the document`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Extraction failed.')
    } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <button type="button" className={btnGray} onClick={() => setOpen(true)}>Assign bales from file…</button>
    )
  }

  return (
    <div className="rounded-lg border border-slate-300 bg-slate-50/50 p-3 space-y-2 w-full">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold flex-1">Assign bales from file — CSV/text (PBI column or bare list) or PDF/photo (AI reads the list)</span>
        <button type="button" className={btnGray} onClick={() => { setOpen(false); setPartition(null); setErr(null) }}>Close</button>
      </div>
      <div className="flex items-start gap-3 flex-wrap">
        <label className={`${btnGray} cursor-pointer`}>
          {busy ? 'Reading…' : 'Upload CSV / text file'}
          <input
            type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onCsvFile(f); e.target.value = '' }}
          />
        </label>
        <DocumentCapture onSource={(src) => void onDocSource(src)} busy={busy} stageLabel={busy ? 'Extracting…' : null} pdfLabel="Upload PDF / photo (AI)" />
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {sourceNote && <p className="text-xs text-slate-500">{sourceNote}</p>}

      {partition && (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="rounded-full bg-green-100 text-green-800 px-2.5 py-0.5 text-xs font-semibold tabular-nums">
              {partition.matchedCount} matched · {lbs0(partition.matchedLbs)} lbs
            </span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${partition.conflicts.length > 0 ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-500'}`}>
              {partition.conflicts.length} blocked
            </span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${partition.unmatched.length > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}>
              {partition.unmatched.length} not on file
            </span>
            <button
              type="button" className={btnCls} disabled={partition.matchedCount === 0}
              onClick={() => { onAddMatches(partition.matched.map((m) => m.baleId)); setOpen(false); setPartition(null) }}
            >
              Add {partition.matchedCount} matched bales to the selection
            </button>
          </div>

          {partition.matchedCount > 0 && (
            <button type="button" className="text-xs text-sky-700" onClick={() => setShowMatched((s) => !s)}>
              {showMatched ? 'Hide matched bales' : 'Show matched bales'}
            </button>
          )}
          {showMatched && (
            <div className="max-h-40 overflow-y-auto rounded border border-slate-200 bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 sticky top-0"><tr><th className="text-left px-2 py-1">PBI #</th><th className="text-left px-2 py-1">Lbs</th><th className="text-left px-2 py-1">Current status</th></tr></thead>
                <tbody>
                  {partition.matched.map((m) => (
                    <tr key={m.baleId} className="border-t border-slate-100 tabular-nums">
                      <td className="px-2 py-0.5 font-mono">{m.pbi}</td>
                      <td className="px-2 py-0.5">{lbs0(m.lbs)}</td>
                      <td className="px-2 py-0.5">{m.disposition}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {partition.conflicts.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50/50 p-2">
              <div className="text-xs font-semibold text-red-800 mb-1">Blocked — these bales cannot go on this {target === 'loan' ? 'loan' : target === 'ldp' ? 'LDP' : 'contract'}:</div>
              <div className="max-h-40 overflow-y-auto">
                <table className="min-w-full text-xs">
                  <tbody>
                    {partition.conflicts.map((c) => (
                      <tr key={c.baleId} className="border-t border-red-100">
                        <td className="px-2 py-0.5 font-mono">{c.pbi}</td>
                        <td className="px-2 py-0.5 tabular-nums">{lbs0(c.lbs)} lbs</td>
                        <td className="px-2 py-0.5 text-red-700">{c.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {partition.unmatched.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50/50 p-2">
              <div className="text-xs font-semibold text-amber-800 mb-1">Not on file — no bale with these numbers (check the gin receipts are imported):</div>
              <div className="text-xs font-mono text-amber-900 break-words">{partition.unmatched.join(', ')}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
