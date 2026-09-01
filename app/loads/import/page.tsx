'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { parseCsv } from '@/lib/csv'
import type { Bin, Buyer, Contract, Crop, Field, Truck } from '@/lib/types'

const TEMPLATE_HEADERS = [
  'date',
  'time',
  'ticket_number',
  'truck',
  'crop',
  'crop_year',
  'gross_weight',
  'tare_weight',
  'net_weight',
  'moisture',
  'test_weight',
  'dry_bushels_override',
  'from_field',
  'from_bin',
  'to_bin',
  'to_buyer',
  'contract_number',
]

const SAMPLE_ROW = [
  '2025-10-15',
  '14:30',
  '12345',
  '1',
  'Corn',
  '2025',
  '82000',
  '32000',
  '',
  '15.2',
  '58',
  '',
  'Field A',
  '',
  '',
  'ADM',
  'C-2025-01',
]

function downloadTemplate() {
  const csv = TEMPLATE_HEADERS.join(',') + '\n' + SAMPLE_ROW.join(',') + '\n'
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'loads-template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

function headerNorm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function num(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

type Built = {
  rowIdx: number
  payload: Record<string, unknown> | null
  ticketKey: string
  issues: string[]
  summary: string
}

export default function LoadsImportPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [fileName, setFileName] = useState<string | null>(null)
  const [skipDupes, setSkipDupes] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: number; skipped: number; failed: Array<{ rowIdx: number; reason: string }> } | null>(null)
  const [showAllFailures, setShowAllFailures] = useState(false)

  // Reference data
  const [trucks, setTrucks] = useState<Truck[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [bins, setBins] = useState<Bin[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [existingTickets, setExistingTickets] = useState<Set<string>>(new Set())

  useEffect(() => {
    ;(async () => {
      const [t, c, f, b, by, ct, ld] = await Promise.all([
        supabase.from('trucks').select('*'),
        supabase.from('crops').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('bins').select('*'),
        supabase.from('buyers').select('*'),
        supabase.from('contracts').select('*'),
        fetchAllRows((f, t) => supabase.from('loads').select('ticket_number').order('id').range(f, t)),
      ])
      setTrucks((t.data as Truck[]) || [])
      setCrops((c.data as Crop[]) || [])
      setFields((f.data as Field[]) || [])
      setBins((b.data as Bin[]) || [])
      setBuyers((by.data as Buyer[]) || [])
      setContracts((ct.data as Contract[]) || [])
      const tickets = new Set<string>()
      for (const r of (ld.data as Array<{ ticket_number: string | null }>) ?? []) {
        if (r.ticket_number) tickets.add(norm(r.ticket_number))
      }
      setExistingTickets(tickets)
    })()
  }, [supabase])

  const truckByName = useMemo(() => new Map(trucks.map((t) => [norm(t.name_or_number), t])), [trucks])
  const cropByName = useMemo(() => new Map(crops.map((c) => [norm(c.name), c])), [crops])
  const fieldByName = useMemo(() => new Map(fields.map((f) => [norm(f.name_or_number), f])), [fields])
  const binByName = useMemo(() => new Map(bins.map((b) => [norm(b.name_or_number), b])), [bins])
  const buyerByName = useMemo(() => new Map(buyers.map((b) => [norm(b.name), b])), [buyers])
  const contractByNumber = useMemo(() => new Map(contracts.map((c) => [norm(c.contract_number), c])), [contracts])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setErr(null); setResult(null)
    setFileName(file.name)
    try {
      const text = await file.text()
      const parsed = parseCsv(text)
      if (parsed.headers.length === 0) { setErr('No header row found.'); setHeaders([]); setRows([]); return }
      setHeaders(parsed.headers)
      setRows(parsed.rows)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to read file')
    }
    e.target.value = ''
  }

  // Find column index by template-header name (case/whitespace-insensitive).
  const colIdx = useMemo(() => {
    const map: Record<string, number> = {}
    const normalized = headers.map((h) => headerNorm(h))
    for (const key of TEMPLATE_HEADERS) {
      const i = normalized.indexOf(headerNorm(key))
      if (i >= 0) map[key] = i
    }
    return map
  }, [headers])

  function cell(row: string[], key: string): string {
    const i = colIdx[key]
    if (i == null) return ''
    return (row[i] ?? '').trim()
  }

  function buildPayload(row: string[], rowIdx: number): Built {
    const issues: string[] = []
    const date = cell(row, 'date')
    if (!date) issues.push('date is required')

    const ticket = cell(row, 'ticket_number')
    const ticketKey = norm(ticket)

    // FK resolutions
    const truckStr = cell(row, 'truck')
    const cropStr = cell(row, 'crop')
    const fromFieldStr = cell(row, 'from_field')
    const fromBinStr = cell(row, 'from_bin')
    const toBinStr = cell(row, 'to_bin')
    const toBuyerStr = cell(row, 'to_buyer')
    const contractStr = cell(row, 'contract_number')

    const truck = truckStr ? truckByName.get(norm(truckStr)) : undefined
    if (truckStr && !truck) issues.push(`truck "${truckStr}" not found`)
    const crop = cropStr ? cropByName.get(norm(cropStr)) : undefined
    if (cropStr && !crop) issues.push(`crop "${cropStr}" not found`)

    // From type inference
    let from_type: 'field' | 'bin' | null = null
    let from_field_id: string | null = null
    let from_bin_id: string | null = null
    if (fromFieldStr && fromBinStr) {
      issues.push('only one of from_field / from_bin allowed')
    } else if (fromFieldStr) {
      const f = fieldByName.get(norm(fromFieldStr))
      if (!f) issues.push(`from_field "${fromFieldStr}" not found`)
      else { from_type = 'field'; from_field_id = f.id }
    } else if (fromBinStr) {
      const b = binByName.get(norm(fromBinStr))
      if (!b) issues.push(`from_bin "${fromBinStr}" not found`)
      else { from_type = 'bin'; from_bin_id = b.id }
    }

    // To type inference
    let to_type: 'bin' | 'buyer' | null = null
    let to_bin_id: string | null = null
    let to_buyer_id: string | null = null
    if (toBinStr && toBuyerStr) {
      issues.push('only one of to_bin / to_buyer allowed')
    } else if (toBinStr) {
      const b = binByName.get(norm(toBinStr))
      if (!b) issues.push(`to_bin "${toBinStr}" not found`)
      else { to_type = 'bin'; to_bin_id = b.id }
    } else if (toBuyerStr) {
      const b = buyerByName.get(norm(toBuyerStr))
      if (!b) issues.push(`to_buyer "${toBuyerStr}" not found`)
      else { to_type = 'buyer'; to_buyer_id = b.id }
    }

    let contract_id: string | null = null
    if (contractStr) {
      const c = contractByNumber.get(norm(contractStr))
      if (!c) issues.push(`contract "${contractStr}" not found`)
      else contract_id = c.id
    }
    if (contract_id && to_type !== 'buyer') {
      issues.push('contract only applies to buyer deliveries')
    }

    const gross = num(cell(row, 'gross_weight'))
    const tare = num(cell(row, 'tare_weight'))
    let net = num(cell(row, 'net_weight'))
    if (net == null && gross != null && tare != null) net = +(gross - tare).toFixed(2)

    const cropYearRaw = cell(row, 'crop_year')
    const cropYear = cropYearRaw === '' ? null : Number(cropYearRaw)
    if (cropYearRaw !== '' && (!Number.isFinite(cropYear) || (cropYear as number) < 1900)) {
      issues.push(`crop_year "${cropYearRaw}" is not a valid year`)
    }

    const timeRaw = cell(row, 'time')

    const payload = issues.length === 0 ? {
      date,
      time: timeRaw || null,
      truck_id: truck?.id ?? null,
      // Truck name snapshot at save time (071) — renames never rewrite history.
      truck_label: truck?.name_or_number ?? null,
      crop_id: crop?.id ?? null,
      crop_year: cropYear,
      gross_weight: gross,
      tare_weight: tare,
      net_weight: net,
      moisture: num(cell(row, 'moisture')),
      test_weight: num(cell(row, 'test_weight')),
      dry_bushels_override: num(cell(row, 'dry_bushels_override')),
      from_type,
      from_field_id,
      from_bin_id,
      to_type,
      to_bin_id,
      to_buyer_id,
      contract_id,
      ticket_number: ticket || null,
      bushels: null,
    } : null

    const summaryParts: string[] = []
    summaryParts.push(date || '(no date)')
    if (ticket) summaryParts.push(`#${ticket}`)
    if (crop) summaryParts.push(crop.name)
    if (from_type === 'field' && from_field_id) summaryParts.push(`← ${fromFieldStr}`)
    if (from_type === 'bin' && from_bin_id) summaryParts.push(`← bin ${fromBinStr}`)
    if (to_type === 'bin' && to_bin_id) summaryParts.push(`→ bin ${toBinStr}`)
    if (to_type === 'buyer' && to_buyer_id) summaryParts.push(`→ ${toBuyerStr}`)

    return { rowIdx, payload, ticketKey, issues, summary: summaryParts.join(' · ') }
  }

  const built = useMemo(() => rows.map((r, i) => buildPayload(r, i)), [rows, colIdx, truckByName, cropByName, fieldByName, binByName, buyerByName, contractByNumber])

  const totals = useMemo(() => {
    let ok = 0, withIssues = 0, dupes = 0
    const seenInFile = new Set<string>()
    for (const b of built) {
      if (b.issues.length > 0) { withIssues++; continue }
      if (skipDupes && b.ticketKey) {
        if (existingTickets.has(b.ticketKey) || seenInFile.has(b.ticketKey)) { dupes++; continue }
        seenInFile.add(b.ticketKey)
      }
      ok++
    }
    return { ok, withIssues, dupes, total: built.length }
  }, [built, skipDupes, existingTickets])

  async function doImport() {
    setErr(null); setResult(null); setBusy(true); setShowAllFailures(false)
    const failed: Array<{ rowIdx: number; reason: string }> = []
    const toInsert: Array<{ rowIdx: number; payload: Record<string, unknown> }> = []
    let skipped = 0
    const seenInFile = new Set<string>()
    for (const b of built) {
      if (b.issues.length > 0) { failed.push({ rowIdx: b.rowIdx, reason: b.issues.join('; ') }); continue }
      if (skipDupes && b.ticketKey) {
        if (existingTickets.has(b.ticketKey) || seenInFile.has(b.ticketKey)) { skipped++; continue }
        seenInFile.add(b.ticketKey)
      }
      toInsert.push({ rowIdx: b.rowIdx, payload: b.payload! })
    }

    let ok = 0
    if (toInsert.length > 0) {
      // Stamp who imported them (073 — per-user last-load defaults). If the
      // column isn't applied yet, the existing per-row fallback path retries
      // each row without it, so an unapplied migration degrades, never fails.
      const { data: { user } } = await supabase.auth.getUser()
      const stamp = (p: Record<string, unknown>) => (user?.id ? { ...p, created_by: user.id } : p)
      const { error } = await supabase.from('loads').insert(toInsert.map((x) => stamp(x.payload)))
      if (error) {
        // Fall back per-row so partial progress still saves.
        for (const { rowIdx, payload } of toInsert) {
          let { error: e2 } = await supabase.from('loads').insert(stamp(payload))
          if (e2 && user?.id && e2.message.includes('created_by')) {
            ;({ error: e2 } = await supabase.from('loads').insert(payload))
          }
          if (e2) failed.push({ rowIdx, reason: e2.message })
          else ok++
        }
      } else {
        ok = toInsert.length
      }
    }
    setBusy(false)
    setResult({ ok, skipped, failed })
    if (ok > 0) {
      // Refresh the local "already seen" set so a re-import skips them next time.
      const next = new Set(existingTickets)
      for (const { payload } of toInsert) {
        const t = norm((payload as any).ticket_number as string | null)
        if (t) next.add(t)
      }
      setExistingTickets(next)
    }
  }

  function reset() {
    setHeaders([]); setRows([]); setFileName(null); setResult(null); setErr(null); setShowAllFailures(false)
  }

  const preview = built.slice(0, 10)
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Import Loads from CSV</h1>
        <Link href="/loads" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Back to loads</Link>
      </div>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <button type="button" onClick={downloadTemplate} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
            Download CSV template
          </button>
          <label className="text-sm rounded-lg bg-slate-700 text-white px-3 py-2 cursor-pointer">
            Upload CSV
            <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="hidden" />
          </label>
          {fileName && <span className="text-xs text-slate-500">{fileName} · {rows.length} row{rows.length === 1 ? '' : 's'}</span>}
          <button type="button" onClick={reset} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2 ml-auto">
            Reset
          </button>
        </div>

        <div className="text-xs text-slate-500">
          Headers expected (any order, case-insensitive):
          <div className="mt-1 font-mono bg-slate-50 p-2 rounded overflow-x-auto">
            {TEMPLATE_HEADERS.join(', ')}
          </div>
          <ul className="mt-2 list-disc ml-5 space-y-0.5">
            <li><code>date</code> is required. Use <code>YYYY-MM-DD</code>.</li>
            <li>Set <code>from_field</code> <strong>or</strong> <code>from_bin</code> (not both) to record a source.</li>
            <li>Set <code>to_bin</code> <strong>or</strong> <code>to_buyer</code> (not both) to record a destination.</li>
            <li>If <code>net_weight</code> is blank, it&rsquo;s computed as <code>gross_weight - tare_weight</code>.</li>
            <li>Truck / crop / field / bin / buyer look up by name (case-insensitive). Contracts look up by <code>contract_number</code>.</li>
            <li>Duplicates are detected by <code>ticket_number</code>.</li>
          </ul>
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Rows in file" value={String(totals.total)} />
            <Stat label="Ready to import" value={String(totals.ok)} tone="green" />
            <Stat label="With issues" value={String(totals.withIssues)} tone={totals.withIssues > 0 ? 'amber' : 'slate'} />
            <Stat label="Duplicates (skip)" value={String(totals.dupes)} tone="slate" />
          </div>

          <div className="bg-white rounded-xl shadow">
            <div className="px-4 py-2 border-b border-slate-100 font-semibold">Preview (first {preview.length} of {built.length})</div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    {['#', 'Status', 'Summary', 'Issues'].map((h) => (
                      <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((b) => (
                    <tr key={b.rowIdx} className={`border-t border-slate-100 ${b.issues.length > 0 ? 'bg-amber-50' : ''}`}>
                      <td className="px-3 py-2 text-slate-400">{b.rowIdx + 2}</td>
                      <td className="px-3 py-2">
                        {b.issues.length > 0
                          ? <span className="text-amber-700 text-xs">Issue</span>
                          : <span className="text-green-700 text-xs">OK</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{b.summary}</td>
                      <td className="px-3 py-2 text-xs text-red-600">{b.issues.join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} />
              Skip duplicates by ticket number
            </label>
            <button
              type="button"
              onClick={doImport}
              disabled={busy || totals.ok === 0}
              className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
            >
              {busy ? 'Importing…' : `Import ${totals.ok} load${totals.ok === 1 ? '' : 's'}`}
            </button>
            {result && result.ok > 0 && (
              <button
                type="button"
                onClick={() => router.push('/loads')}
                className="rounded-lg bg-white border border-slate-300 px-4 py-2 text-sm"
              >
                View loads
              </button>
            )}
          </div>
        </>
      )}

      {result && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm space-y-1">
          <div><span className="font-semibold text-green-700">{result.ok}</span> imported</div>
          {result.skipped > 0 && <div><span className="font-semibold text-slate-600">{result.skipped}</span> skipped as duplicates</div>}
          {result.failed.length > 0 && (
            <div>
              <div><span className="font-semibold text-red-700">{result.failed.length}</span> failed</div>
              <ul className="mt-1 ml-4 list-disc text-xs text-slate-600 space-y-0.5">
                {(showAllFailures ? result.failed : result.failed.slice(0, 10)).map((f, i) => (
                  <li key={i}>Row {f.rowIdx + 2}: {f.reason}</li>
                ))}
              </ul>
              {result.failed.length > 10 && !showAllFailures && (
                <button
                  type="button"
                  onClick={() => setShowAllFailures(true)}
                  className="text-xs text-brand-deep underline mt-1"
                >
                  Show all {result.failed.length}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'slate' | 'green' | 'amber' }) {
  const color =
    tone === 'green' ? 'text-green-700'
    : tone === 'amber' ? 'text-amber-700'
    : 'text-slate-700'
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
    </div>
  )
}
