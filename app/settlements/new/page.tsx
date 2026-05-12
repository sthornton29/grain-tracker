'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { parseCsv } from '@/lib/csv'
import { findBestMatch } from '@/lib/fuzzy'
import {
  MAX_PDF_BYTES,
  PdfTooLargeError,
  parseDocument,
  uploadPdfToStorage,
} from '@/lib/pdf-upload'
import PdfViewer from '@/components/pdf-viewer'
import type { Buyer } from '@/lib/types'

type LoadMatch = {
  id: string
  date: string
  ticket_number: string | null
  crop_id: string | null
  crop: { name: string } | null
  contract_id: string | null
}

type RowDraft = {
  ticket_number: string
  net_bushels: string
  gross_revenue: string
  discounts: string
  notes: string
}

const emptyRow = (): RowDraft => ({
  ticket_number: '',
  net_bushels: '',
  gross_revenue: '',
  discounts: '',
  notes: '',
})

function num(s: string): number | null {
  if (s == null || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function computed(r: RowDraft) {
  const gross = num(r.gross_revenue) ?? 0
  const disc = num(r.discounts) ?? 0
  const net = num(r.net_bushels) ?? 0
  const netRev = gross - disc
  const price = net > 0 ? netRev / net : null
  return { netRev, price }
}

function rowIssues(r: RowDraft) {
  const net = num(r.net_bushels)
  const gross = num(r.gross_revenue) ?? 0
  const disc = num(r.discounts) ?? 0
  return {
    ticket: !r.ticket_number.trim(),
    net: net == null || net <= 0,
    gross: gross === 0,
    discounts: disc > gross && gross > 0,
  }
}

const TEMPLATE_HEADERS = ['ticket_number', 'net_bushels', 'gross_revenue', 'discounts']

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_HEADERS.join(',') + '\n'], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'settlement-template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export default function NewSettlementPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [loadsByTicket, setLoadsByTicket] = useState<Map<string, LoadMatch>>(new Map())
  const [buyerId, setBuyerId] = useState('')
  const [settlementDate, setSettlementDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [settlementNumber, setSettlementNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<RowDraft[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // AI-assisted PDF extraction state.
  const [aiFile, setAiFile] = useState<File | null>(null)
  const [aiStage, setAiStage] = useState<string | null>(null)
  const [aiBanner, setAiBanner] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const [b, l] = await Promise.all([
        supabase.from('buyers').select('*').order('name'),
        supabase.from('loads').select('id, date, ticket_number, crop_id, crop:crops(name), contract_id'),
      ])
      setBuyers((b.data as Buyer[]) || [])
      const map = new Map<string, LoadMatch>()
      for (const row of ((l.data as unknown) as LoadMatch[]) ?? []) {
        if (!row.ticket_number) continue
        const key = row.ticket_number.trim().toLowerCase()
        // If duplicate ticket numbers exist, mark ambiguous by skipping.
        if (map.has(key)) map.set(key, { ...row, id: '__ambiguous__' })
        else map.set(key, row)
      }
      setLoadsByTicket(map)
    })()
  }, [supabase])

  function matchFor(ticket: string): LoadMatch | null | 'ambiguous' {
    const key = ticket.trim().toLowerCase()
    if (!key) return null
    const hit = loadsByTicket.get(key)
    if (!hit) return null
    if (hit.id === '__ambiguous__') return 'ambiguous'
    return hit
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setErr(null)
    try {
      const text = await file.text()
      const { headers, rows: csvRows } = parseCsv(text)
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
      const idx: Record<string, number> = {}
      for (const h of TEMPLATE_HEADERS) {
        const i = headers.findIndex((raw) => norm(raw) === norm(h))
        if (i >= 0) idx[h] = i
      }
      if (!('ticket_number' in idx)) {
        setErr('CSV is missing a ticket_number column.')
        return
      }
      const next: RowDraft[] = csvRows.map((r) => ({
        ticket_number: r[idx.ticket_number] ?? '',
        net_bushels: r[idx.net_bushels] ?? '',
        gross_revenue: r[idx.gross_revenue] ?? '',
        discounts: r[idx.discounts] ?? '',
        notes: '',
      }))
      setRows((prev) => [...prev, ...next])
      e.target.value = ''
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to read file')
    }
  }

  async function onPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErr(null)
    setAiBanner(null)
    if (file.size > MAX_PDF_BYTES) {
      setErr('That PDF is larger than 20 MB. Please use a smaller file.')
      return
    }
    setAiFile(file)
    setAiStage('Reading document…')
    try {
      // Give the user a beat to see the first stage label before it flips.
      await new Promise((r) => setTimeout(r, 250))
      setAiStage('Extracting data…')
      const data = await parseDocument(file, 'settlement')

      const extractedLines = Array.isArray(data.line_items) ? data.line_items : []
      if (extractedLines.length === 0) {
        setErr('No records found in this document. The scan may be too blurry or the format may not be readable.')
        setAiStage(null)
        return
      }

      // Fuzzy-match buyer to existing dropdown.
      const buyerHit = findBestMatch(data.buyer_name, buyers, (b) => b.name)
      if (buyerHit) setBuyerId(buyerHit.id)

      if (data.settlement_date && /^\d{4}-\d{2}-\d{2}$/.test(data.settlement_date)) {
        setSettlementDate(data.settlement_date)
      }
      if (data.settlement_number != null) setSettlementNumber(String(data.settlement_number))

      const nextRows: RowDraft[] = extractedLines.map((li) => ({
        ticket_number: li.ticket_number != null ? String(li.ticket_number) : '',
        net_bushels: li.net_bushels != null ? String(li.net_bushels) : '',
        gross_revenue: li.gross_revenue != null ? String(li.gross_revenue) : '',
        discounts: li.discounts != null ? String(li.discounts) : '',
        notes: '',
      }))
      setRows(nextRows)
      setAiBanner(
        `AI extracted ${nextRows.length} line item${nextRows.length === 1 ? '' : 's'} from settlement PDF. Please review before saving.`,
      )
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) {
        setErr(e.message)
      } else {
        setErr(
          e?.message
            ? `Couldn't read this PDF: ${e.message}. Try uploading a clearer scan or use the manual entry method.`
            : "Couldn't read this PDF. Try uploading a clearer scan or use the manual entry method.",
        )
      }
    } finally {
      setAiStage(null)
    }
  }

  function discardPdf() {
    setAiFile(null)
    setAiBanner(null)
    setAiStage(null)
    setRows([])
  }

  function updateRow(i: number, patch: Partial<RowDraft>) {
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
  }

  function deleteRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i))
  }

  async function save() {
    setErr(null)
    if (!buyerId) { setErr('Pick a buyer.'); return }
    if (!settlementDate) { setErr('Pick a settlement date.'); return }
    if (rows.length === 0) { setErr('Add at least one line.'); return }
    setSaving(true)

    let pdfUrl: string | null = null
    if (aiFile) {
      try {
        pdfUrl = await uploadPdfToStorage(supabase, aiFile, 'settlements')
      } catch (e: any) {
        setSaving(false)
        setErr(e?.message ?? 'Could not upload settlement PDF.')
        return
      }
    }

    const { data: settlement, error: sErr } = await supabase
      .from('settlements')
      .insert({
        buyer_id: buyerId,
        settlement_date: settlementDate,
        settlement_number: settlementNumber.trim() || null,
        notes: notes.trim() || null,
        source_pdf_url: pdfUrl,
      })
      .select('id')
      .single()
    if (sErr || !settlement) {
      setSaving(false); setErr(sErr?.message ?? 'Could not save settlement.'); return
    }

    const lines = rows.map((r) => {
      const m = matchFor(r.ticket_number)
      return {
        settlement_id: settlement.id,
        ticket_number: r.ticket_number.trim() || null,
        load_id: m && m !== 'ambiguous' ? m.id : null,
        net_bushels: num(r.net_bushels) ?? 0,
        gross_revenue: num(r.gross_revenue) ?? 0,
        discounts: num(r.discounts) ?? 0,
        notes: r.notes.trim() || null,
      }
    })

    const { error: lErr } = await supabase.from('settlement_lines').insert(lines)
    setSaving(false)
    if (lErr) { setErr('Settlement saved but lines failed: ' + lErr.message); return }
    router.push(`/settlements/${settlement.id}`)
  }

  const totals = rows.reduce(
    (acc, r) => {
      const { netRev } = computed(r)
      const m = matchFor(r.ticket_number)
      if (m && m !== 'ambiguous') acc.matched++
      else if (r.ticket_number.trim()) acc.unmatched++
      else acc.blank++
      acc.netBu += num(r.net_bushels) ?? 0
      acc.netRev += netRev
      return acc
    },
    { matched: 0, unmatched: 0, blank: 0, netBu: 0, netRev: 0 }
  )

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm w-full'
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const fmt4 = (n: number | null) => n == null ? '' : n.toLocaleString(undefined, { maximumFractionDigits: 4 })

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">New Settlement</h1>
        <Link href="/settlements" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Cancel</Link>
      </div>

      <div className="bg-white rounded-xl shadow p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
        <label className="text-sm text-slate-700">
          Buyer
          <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className={`w-full ${inputCls}`}>
            <option value="">— select —</option>
            {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-700">
          Settlement date
          <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} className={`w-full ${inputCls}`} />
        </label>
        <label className="text-sm text-slate-700">
          Settlement # <span className="text-xs text-slate-400">optional</span>
          <input value={settlementNumber} onChange={(e) => setSettlementNumber(e.target.value)} className={`w-full ${inputCls}`} />
        </label>
        <label className="text-sm text-slate-700">
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`w-full ${inputCls}`} />
        </label>
      </div>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <h2 className="font-semibold flex-1">Lines</h2>
          <button type="button" onClick={downloadTemplate} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
            Download CSV template
          </button>
          <label className="text-sm rounded-lg bg-slate-700 text-white px-3 py-2 cursor-pointer">
            Upload CSV
            <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="hidden" />
          </label>
          <label className={`text-sm rounded-lg px-3 py-2 cursor-pointer text-white ${aiStage ? 'bg-slate-400 cursor-wait' : 'bg-green-700'}`}>
            {aiStage ? aiStage : 'Upload Settlement PDF (AI)'}
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={onPdf}
              disabled={aiStage != null}
              className="hidden"
            />
          </label>
          {aiFile && !aiStage && (
            <button
              type="button"
              onClick={discardPdf}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
            >
              Discard &amp; Start Over
            </button>
          )}
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, emptyRow()])}
            className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
          >
            + Add row
          </button>
        </div>

        {aiBanner && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
            {aiBanner}
          </div>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className={aiFile ? 'grid grid-cols-1 lg:grid-cols-2 gap-4' : ''}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {['Ticket #', 'Match', 'Net bu', 'Gross $', 'Discounts $', 'Net $', '$/bu', 'Notes', '']
                    .map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">Upload a CSV, upload a PDF (AI), or add rows manually.</td></tr>
                )}
                {rows.map((r, i) => {
                  const { netRev, price } = computed(r)
                  const m = matchFor(r.ticket_number)
                  const issues = rowIssues(r)
                  const flagCls = 'bg-amber-50'
                  let status: React.ReactNode
                  if (!r.ticket_number.trim()) {
                    status = <span className="text-slate-400 text-xs">—</span>
                  } else if (m === 'ambiguous') {
                    status = <span className="text-amber-700 text-xs">Ambiguous (multiple loads)</span>
                  } else if (m) {
                    status = <span className="text-green-700 text-xs">Matched · {m.date} · {m.crop?.name ?? '—'}</span>
                  } else {
                    status = <span className="text-amber-700 text-xs">No match</span>
                  }
                  return (
                    <tr key={i} className="border-t border-slate-100 align-top">
                      <td className={`px-2 py-1 ${issues.ticket ? flagCls : ''}`} style={{ minWidth: 120 }}>
                        <input value={r.ticket_number} onChange={(e) => updateRow(i, { ticket_number: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 180 }}>{status}</td>
                      <td className={`px-2 py-1 ${issues.net ? flagCls : ''}`} style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" value={r.net_bushels} onChange={(e) => updateRow(i, { net_bushels: e.target.value })} className={inputCls} />
                      </td>
                      <td className={`px-2 py-1 ${issues.gross ? flagCls : ''}`} style={{ minWidth: 100 }}>
                        <input type="number" step="0.01" value={r.gross_revenue} onChange={(e) => updateRow(i, { gross_revenue: e.target.value })} className={inputCls} />
                      </td>
                      <td className={`px-2 py-1 ${issues.discounts ? flagCls : ''}`} style={{ minWidth: 100 }}>
                        <input type="number" step="0.01" value={r.discounts} onChange={(e) => updateRow(i, { discounts: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1 text-right font-mono">${fmt(netRev)}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmt4(price)}</td>
                      <td className="px-2 py-1" style={{ minWidth: 140 }}>
                        <input value={r.notes} onChange={(e) => updateRow(i, { notes: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1"><button type="button" onClick={() => deleteRow(i)} className="text-red-600 text-sm">✕</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {aiFile && (
            <div className="lg:sticky lg:top-3 self-start h-[70vh] min-h-[400px]">
              <div className="text-xs text-slate-500 mb-1">Source PDF — cross-reference while reviewing</div>
              <PdfViewer file={aiFile} className="h-full" title="Settlement PDF" />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm bg-slate-50 rounded-lg p-3">
          <Stat label="Total rows" value={String(rows.length)} />
          <Stat label="Matched" value={String(totals.matched)} tone="green" />
          <Stat label="Unmatched" value={String(totals.unmatched)} tone={totals.unmatched > 0 ? 'amber' : 'slate'} />
          <Stat label="Net revenue" value={`$${fmt(totals.netRev)}`} />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving || rows.length === 0 || !buyerId}
            className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Settlement'}
          </button>
          <Link href="/settlements" className="rounded-lg bg-white border border-slate-300 px-4 py-2 text-sm">Cancel</Link>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'slate' | 'green' | 'amber' }) {
  const color =
    tone === 'green' ? 'text-green-700'
    : tone === 'amber' ? 'text-amber-700'
    : 'text-slate-700'
  return (
    <div>
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
    </div>
  )
}
