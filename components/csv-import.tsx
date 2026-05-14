'use client'

import { useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  autoMapHeaders,
  parseCsv,
  runImport,
  type ImportConfig,
  type ImportResult,
} from '@/lib/csv'

type Props = {
  config: ImportConfig
  onImported?: () => void
}

// Emits a CSV with just the header row matching the import config's column
// labels, so a user can fill in their data offline and import it back here.
// Required columns get a "*" suffix in the header to match the live hint.
function downloadTemplate(config: ImportConfig) {
  const headers = config.columns.map((c) => {
    const base = c.label ?? c.key
    return c.required ? `${base}*` : base
  })
  const csv = headers.join(',') + '\n'
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${config.tableName}-template.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function CsvImport({ config, onImported }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [skipDupes, setSkipDupes] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [showAllFailures, setShowAllFailures] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey]

  function reset() {
    setFileName(null); setHeaders([]); setRows([]); setMapping({})
    setErr(null); setResult(null); setShowAllFailures(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setResult(null); setErr(null); setShowAllFailures(false)
    setFileName(file.name)
    try {
      const text = await file.text()
      const parsed = parseCsv(text)
      if (parsed.headers.length === 0) {
        setErr('No header row found.'); setHeaders([]); setRows([]); return
      }
      setHeaders(parsed.headers)
      setRows(parsed.rows)
      setMapping(autoMapHeaders(parsed.headers, config.columns))
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to read file')
    }
  }

  async function doImport() {
    setBusy(true); setErr(null)
    try {
      const r = await runImport(supabase, config, rows, headers, mapping, { skipDuplicates: skipDupes })
      setResult(r)
      if (r.ok > 0) onImported?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  const preview = rows.slice(0, 5)
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const requiredOk = config.columns
    .filter((c) => c.required)
    .every((c) => mapping[c.key])

  return (
    <div className="bg-white rounded-xl shadow">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center gap-2 font-semibold"
      >
        <span>Import CSV</span>
        <span className="text-slate-400 text-sm ml-auto">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-100">
          <div className="pt-3">
            <label className="text-sm font-semibold text-slate-700 block mb-1">CSV file</label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={onFile}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:text-white file:px-4 file:py-2"
            />
            {fileName && (
              <p className="text-xs text-slate-500 mt-1">
                {fileName} · {rows.length} data row{rows.length === 1 ? '' : 's'}
              </p>
            )}
            <p className="text-xs text-slate-500 mt-2">
              Expected columns:{' '}
              {config.columns.map((c, i) => (
                <span key={c.key}>
                  {i > 0 && ', '}
                  <code className="bg-slate-100 px-1 rounded">{c.label ?? c.key}</code>
                  {c.required && <span className="text-red-600">*</span>}
                </span>
              ))}
            </p>
            <button
              type="button"
              onClick={() => downloadTemplate(config)}
              className="text-sm text-sky-700 underline mt-2"
            >
              Download template CSV
            </button>
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}

          {headers.length > 0 && (
            <>
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-2">Column mapping</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {config.columns.map((c) => (
                    <label key={c.key} className="text-sm flex items-center gap-2">
                      <span className="w-36 shrink-0 text-slate-700">
                        {c.label ?? c.key}{c.required && <span className="text-red-600">*</span>}
                      </span>
                      <select
                        value={mapping[c.key] ?? ''}
                        onChange={(e) => setMapping((m) => ({ ...m, [c.key]: e.target.value }))}
                        className={`flex-1 min-w-0 ${inputCls}`}
                      >
                        <option value="">— ignore —</option>
                        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                {!requiredOk && (
                  <p className="text-xs text-red-600 mt-2">
                    Map all required columns (marked *) before importing.
                  </p>
                )}
              </div>

              {preview.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">Preview (first {preview.length} of {rows.length})</h3>
                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-100">
                        <tr>{headers.map((h) => <th key={h} className="px-2 py-1 text-left whitespace-nowrap">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {preview.map((r, i) => (
                          <tr key={i} className="border-t border-slate-100">
                            {headers.map((_, j) => <td key={j} className="px-2 py-1 whitespace-nowrap">{r[j] ?? ''}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm flex items-center gap-2">
                  <input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} />
                  Skip duplicates (match by <code className="bg-slate-100 px-1 rounded">{uniqueKeys.join(' + ')}</code>)
                </label>
                <button
                  type="button"
                  onClick={doImport}
                  disabled={busy || !requiredOk || rows.length === 0}
                  className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold disabled:opacity-50"
                >
                  {busy ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
                </button>
                <button type="button" onClick={reset} className="rounded-lg bg-white border border-slate-300 px-4 py-2 text-sm">
                  Reset
                </button>
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
                      <li key={i}>
                        Row {f.rowIndex >= 0 ? f.rowIndex + 2 : '?'}: {f.reason}
                      </li>
                    ))}
                  </ul>
                  {result.failed.length > 10 && !showAllFailures && (
                    <button
                      type="button"
                      onClick={() => setShowAllFailures(true)}
                      className="text-xs text-sky-700 underline mt-1"
                    >
                      Show all {result.failed.length}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
