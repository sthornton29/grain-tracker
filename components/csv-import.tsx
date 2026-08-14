'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isExcelFile } from '@/lib/excel-to-pdf'
import {
  autoMapHeaders,
  extractChildValues,
  parseCsv,
  runImport,
  type ImportConfig,
  type ImportMode,
  type ImportResult,
} from '@/lib/csv'
import {
  buildVarietyPlan,
  resolvedName,
  varietyKey,
  type VarietyDecision,
  type VarietyPlan,
} from '@/lib/variety-resolution'
import { downloadExcelTemplate } from '@/lib/import-template'

// One scope's (e.g. one crop's) resolution plan over the file's child values.
type ScopePlan = { scope: string; plan: VarietyPlan }
type ResolutionState = { scopes: ScopePlan[]; rowScope: Map<number, string> }

type Props = {
  config: ImportConfig
  onImported?: () => void
  /** Expand the panel on first render (e.g. when it's the recommended path). */
  defaultOpen?: boolean
  /** Show a "Recommended" badge in the panel header. */
  recommended?: boolean
}

// Emits a CSV with just the header row matching the import config's column
// labels, so a user can fill in their data offline and import it back here.
// Required columns get a "*" suffix in the header to match the live hint.
function downloadTemplate(config: ImportConfig) {
  const headers = config.columns.map((c) => {
    const base = c.label ?? c.key
    // A column with an auto-assign fallback (single-entity operations) isn't
    // actually required of the file, so it loses the star.
    return c.required && !c.fk?.fallbackId ? `${base}*` : base
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

export default function CsvImport({ config, onImported, defaultOpen, recommended }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(defaultOpen ?? false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<ImportMode>('sync')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [showAllFailures, setShowAllFailures] = useState(false)
  const [resolution, setResolution] = useState<ResolutionState | null>(null)
  const [resolutionBusy, setResolutionBusy] = useState(false)
  // Keyed `${scope-lowercased}|${varietyKey}` — a possible-match group's
  // link-or-create choice, or a new group's edited name.
  const [decisions, setDecisions] = useState<Record<string, VarietyDecision>>({})
  const fileRef = useRef<HTMLInputElement | null>(null)

  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey]

  function reset() {
    setFileName(null); setHeaders([]); setRows([]); setMapping({})
    setErr(null); setResult(null); setShowAllFailures(false)
    setResolution(null); setDecisions({})
    if (fileRef.current) fileRef.current.value = ''
  }

  // Resolve the file's child-column names (e.g. varieties) per scope (crop)
  // whenever the parsed rows or mapping change.
  useEffect(() => {
    const res = config.resolution
    if (!res || rows.length === 0) { setResolution(null); setDecisions({}); return }
    let cancelled = false
    setResolutionBusy(true)
    ;(async () => {
      try {
        const scopeCol = config.columns.find((c) => c.key === res.scopeKey)
        const [existingByScopeId, dismissedByScopeId, lookupRes] = await Promise.all([
          res.loadExisting(supabase),
          res.loadDismissed ? res.loadDismissed(supabase) : Promise.resolve(new Map<string, Set<string>>()),
          scopeCol?.fk
            ? supabase.from(scopeCol.fk.table).select(`id,${scopeCol.fk.matchColumn}`)
            : Promise.resolve({ data: null, error: null }),
        ])
        if (cancelled) return
        const lookup = ((lookupRes.data as unknown) as Array<Record<string, unknown>>) ?? []
        const matchCol = scopeCol?.fk?.matchColumn ?? ''
        const scopeId = (scope: string): string | null => {
          const hit = lookup.find((r) => String(r[matchCol] ?? '').toLowerCase() === scope.toLowerCase())
          return hit ? String(hit.id) : null
        }
        const values = extractChildValues(config, rows, headers, mapping)
        const rowScope = new Map(values.map((v) => [v.rowIndex, v.scope]))
        const byScope = new Map<string, { scope: string; refs: Array<{ rowIndex: number; name: string }> }>()
        for (const v of values) {
          const k = v.scope.toLowerCase()
          const entry = byScope.get(k) ?? { scope: v.scope, refs: [] }
          for (const name of v.names) entry.refs.push({ rowIndex: v.rowIndex, name })
          byScope.set(k, entry)
        }
        const scopes: ScopePlan[] = [...byScope.values()].map(({ scope, refs }) => {
          const id = scopeId(scope)
          const existing = (id ? existingByScopeId.get(id) : undefined) ?? []
          const dismissed = id ? dismissedByScopeId.get(id) : undefined
          return { scope, plan: buildVarietyPlan(refs, existing, dismissed) }
        })
        setResolution({ scopes, rowScope })
        setDecisions({})
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? 'Could not resolve existing names')
      } finally {
        if (!cancelled) setResolutionBusy(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, headers, mapping, supabase])

  const decisionKey = (scope: string, itemKey: string) => `${scope.toLowerCase()}|${itemKey}`
  const unresolvedCount = resolution
    ? resolution.scopes.reduce(
        (n, s) =>
          n +
          s.plan.items.filter(
            (it) => it.resolution.status === 'possible' && resolvedName(it, decisions[decisionKey(s.scope, it.key)]) == null,
          ).length,
        0,
      )
    : 0
  const resolutionReady = !config.resolution || (!resolutionBusy && resolution != null && unresolvedCount === 0)
  const resolutionTotals = resolution
    ? resolution.scopes.reduce(
        (t, s) => ({ matched: t.matched + s.plan.matched, possible: t.possible + s.plan.possible, created: t.created + s.plan.created }),
        { matched: 0, possible: 0, created: 0 },
      )
    : null

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setResult(null); setErr(null); setShowAllFailures(false)
    setFileName(file.name)
    try {
      // Excel: convert a sheet to CSV text so the rest of the structured-import
      // flow (mapping, dedup, sync) works unchanged. With our two-sheet template
      // the data is on the "Data" tab, not the first ("Instructions") tab, so we
      // pick the first sheet whose header row maps every required column and fall
      // back to the first sheet otherwise.
      let text: string
      if (isExcelFile(file)) {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' })
        const required = config.columns.filter((c) => c.required && !c.fk?.fallbackId).map((c) => c.key)
        let chosen = wb.SheetNames[0]
        for (const name of wb.SheetNames) {
          const sheet = wb.Sheets[name]
          if (!sheet) continue
          const map = autoMapHeaders(parseCsv(XLSX.utils.sheet_to_csv(sheet)).headers, config.columns)
          if (required.length > 0 && required.every((k) => map[k])) { chosen = name; break }
        }
        const sheet = wb.Sheets[chosen]
        text = sheet ? XLSX.utils.sheet_to_csv(sheet) : ''
      } else {
        text = await file.text()
      }
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

  // Rewrite each incoming child value (variety spelling) to its resolved name:
  // the matched existing spelling, the user's possible-match pick, or the new
  // group's (possibly edited) creation name shared by all its format variants.
  function childValueTransform(columnKey: string, value: string, rowIndex: number): string {
    const res = config.resolution
    if (!res || !resolution || columnKey !== res.columnKey) return value
    const scope = resolution.rowScope.get(rowIndex)
    if (scope == null) return value
    const scopePlan = resolution.scopes.find((s) => s.scope.toLowerCase() === scope.toLowerCase())
    const item = scopePlan?.plan.items.find((it) => it.key === varietyKey(value))
    if (!item) return value
    return resolvedName(item, decisions[decisionKey(scope, item.key)]) ?? value
  }

  async function doImport() {
    setBusy(true); setErr(null)
    try {
      const r = await runImport(supabase, config, rows, headers, mapping, { mode, childValueTransform })
      setResult(r)
      if (r.added > 0 || r.updated > 0) onImported?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  const preview = rows.slice(0, 5)

  // Live resolution preview for scoped FK columns (the farms county + state
  // pairing): the preview's county cells show which record the value will
  // land on ("Lawrence → Lawrence, AL") or the specific problem, before the
  // user commits the import.
  const [fkPreview, setFkPreview] = useState<Map<string, { text: string; ok: boolean }> | null>(null)
  useEffect(() => {
    const scoped = config.columns.filter((c) => c.fk?.scopeKey && c.fk?.scopeRequired)
    if (scoped.length === 0 || rows.length === 0) { setFkPreview(null); return }
    let cancelled = false
    ;(async () => {
      const map = new Map<string, { text: string; ok: boolean }>()
      for (const col of scoped) {
        const fk = col.fk!
        const colHeader = mapping[col.key]
        if (!colHeader) continue
        const { data } = await supabase.from(fk.table).select(`id, ${fk.matchColumn}, ${fk.scopeKey}`)
        const lookup = (data ?? []) as unknown as Array<Record<string, unknown>>
        const norm = fk.normalizeMatch ?? ((s: string) => s.trim().toLowerCase())
        const hIdx = headers.indexOf(colHeader)
        const scopeHeader = mapping[fk.scopeKey!]
        const sIdx = scopeHeader ? headers.indexOf(scopeHeader) : -1
        for (let i = 0; i < Math.min(rows.length, 5); i++) {
          const value = (rows[i][hIdx] ?? '').trim()
          if (!value) continue
          const scopeStr = sIdx >= 0 ? (rows[i][sIdx] ?? '').trim() : ''
          if (!scopeStr) { map.set(`${col.key}|${i}`, { text: 'needs a state', ok: false }); continue }
          const cands = lookup.filter((r) =>
            norm(String(r[fk.matchColumn] ?? '')) === norm(value) &&
            String(r[fk.scopeKey!] ?? '').trim().toLowerCase() === scopeStr.toLowerCase())
          map.set(`${col.key}|${i}`, cands.length === 1
            ? { text: `${String(cands[0][fk.matchColumn])}, ${String(cands[0][fk.scopeKey!])}`, ok: true }
            : { text: cands.length === 0 ? 'not found' : 'matches multiple', ok: false })
        }
      }
      if (!cancelled) setFkPreview(map.size > 0 ? map : null)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, mapping, headers])

  // header (raw CSV string) → config column key, for preview annotation.
  const headerToColKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const [key, header] of Object.entries(mapping)) m.set(header, key)
    return m
  }, [mapping])

  // Raw cells keyed by column key for each preview row, feeding the config's
  // previewAnnotate hook (e.g. the plantings acres-from-field-acres hint).
  const previewCells = useMemo(() => {
    if (!config.previewAnnotate) return []
    return rows.slice(0, 5).map((r) => {
      const cells: Record<string, string> = {}
      for (const c of config.columns) {
        const h = mapping[c.key]
        const idx = h ? headers.indexOf(h) : -1
        cells[c.key] = idx >= 0 ? (r[idx] ?? '') : ''
      }
      return cells
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, mapping, headers])
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  // A required column is satisfied by a mapped header OR an auto-assign
  // fallback (a single-entity operation importing without an entity column).
  const requiredOk = config.columns
    .filter((c) => c.required && !c.fk?.fallbackId)
    .every((c) => mapping[c.key])

  return (
    <div className="bg-white rounded-xl shadow">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center gap-2 font-semibold"
      >
        <span>{config.title ?? 'Import CSV or Excel'}</span>
        {recommended && (
          <span className="text-xs font-semibold rounded-full bg-green-100 text-green-800 px-2 py-0.5">
            Recommended
          </span>
        )}
        <span className="text-slate-400 text-sm ml-auto">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-100">
          <div className="pt-3">
            <label className="text-sm font-semibold text-slate-700 block mb-1">CSV or Excel file</label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              onChange={onFile}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:text-white file:px-4 file:py-2"
            />
            <p className="text-xs text-slate-500 mt-1">For Excel, fill in the Data tab; the first row is the header.</p>
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
                  {c.required && !c.fk?.fallbackId && <span className="text-red-600">*</span>}
                </span>
              ))}
            </p>
            {config.note && <p className="text-xs text-slate-500 mt-1">{config.note}</p>}
            <button
              type="button"
              onClick={() => (config.template ? downloadExcelTemplate(config) : downloadTemplate(config))}
              className="text-sm text-brand-deep underline mt-2"
            >
              {config.template ? 'Download Excel template' : 'Download template CSV'}
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
                        {c.label ?? c.key}{c.required && !c.fk?.fallbackId && <span className="text-red-600">*</span>}
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

              {config.resolution && (resolutionBusy || (resolution && resolution.scopes.some((s) => s.plan.items.length > 0))) && (
                <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                  <h3 className="text-sm font-semibold text-slate-700 capitalize">{config.resolution.noun} resolution</h3>
                  {resolutionBusy && <p className="text-xs text-slate-500">Checking against existing {config.resolution.noun} names…</p>}
                  {!resolutionBusy && resolutionTotals && (
                    <p className="text-sm">
                      <span className="font-semibold text-green-700">{resolutionTotals.matched}</span> matched
                      {' · '}
                      <span className={`font-semibold ${resolutionTotals.possible > 0 ? 'text-amber-700' : 'text-slate-500'}`}>{resolutionTotals.possible}</span>
                      {' '}possible match{resolutionTotals.possible === 1 ? '' : 'es'}{resolutionTotals.possible > 0 ? ' need review' : ''}
                      {' · '}
                      <span className="font-semibold text-brand-deep">{resolutionTotals.created}</span> new {config.resolution.noun}
                      {resolutionTotals.created === 1 ? '' : config.resolution.noun.endsWith('y') ? '' : 's'} will be created
                    </p>
                  )}
                  {!resolutionBusy && resolution && resolution.scopes.map((s) => (
                    <div key={s.scope} className="space-y-1">
                      {s.plan.items.map((it) => {
                        const dk = decisionKey(s.scope, it.key)
                        const d = decisions[dk]
                        const label = it.spellings.length > 1 ? it.spellings.map((x) => `“${x}”`).join(' / ') : `“${it.name}”`
                        if (it.resolution.status === 'matched') {
                          return (
                            <div key={it.key} className="text-xs text-slate-600">
                              <span className="rounded-full bg-green-100 text-green-800 px-2 py-0.5 mr-1">Matched</span>
                              {label} ({s.scope}) — matched existing: <span className="font-semibold">{it.resolution.canonical}</span>
                            </div>
                          )
                        }
                        if (it.resolution.status === 'new') {
                          return (
                            <div key={it.key} className="text-xs text-slate-600 flex items-center gap-2 flex-wrap">
                              <span className="rounded-full bg-sky-100 text-sky-800 px-2 py-0.5">New — will be created</span>
                              <span>{label} ({s.scope})</span>
                              <input
                                value={d?.newName ?? it.name}
                                onChange={(e) => setDecisions((m) => ({ ...m, [dk]: { useExisting: null, newName: e.target.value } }))}
                                className="rounded border border-slate-300 px-2 py-0.5 text-xs"
                                aria-label={`Name for new ${config.resolution!.noun}`}
                              />
                              {it.rowIndexes.length > 1 && <span className="text-slate-400">({it.rowIndexes.length} rows)</span>}
                            </div>
                          )
                        }
                        const decided = resolvedName(it, d)
                        return (
                          <div key={it.key} className={`text-xs rounded-lg border px-2 py-1.5 space-y-1 ${decided == null ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
                            <div className="text-slate-700">
                              <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 mr-1">Possible match</span>
                              {label} ({s.scope}){decided != null && <> — will save as <span className="font-semibold">{decided}</span></>}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {it.resolution.candidates.map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  onClick={() => setDecisions((m) => ({ ...m, [dk]: { useExisting: c } }))}
                                  className={`rounded-lg border px-2 py-1 ${d?.useExisting === c ? 'border-green-600 bg-green-50 text-green-800 font-semibold' : 'border-slate-300 bg-white'}`}
                                >
                                  Use existing “{c}”
                                </button>
                              ))}
                              <button
                                type="button"
                                onClick={() => setDecisions((m) => ({ ...m, [dk]: { useExisting: null, newName: it.name } }))}
                                className={`rounded-lg border px-2 py-1 ${d && d.useExisting == null ? 'border-sky-600 bg-sky-50 text-sky-800 font-semibold' : 'border-slate-300 bg-white'}`}
                              >
                                Create as new {config.resolution!.noun}
                              </button>
                              {d && d.useExisting == null && (
                                <input
                                  value={d.newName ?? it.name}
                                  onChange={(e) => setDecisions((m) => ({ ...m, [dk]: { useExisting: null, newName: e.target.value } }))}
                                  className="rounded border border-slate-300 px-2 py-0.5"
                                  aria-label={`Name for new ${config.resolution!.noun}`}
                                />
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                  {!resolutionBusy && unresolvedCount > 0 && (
                    <p className="text-xs text-amber-700 font-semibold">
                      Resolve {unresolvedCount} possible match{unresolvedCount === 1 ? '' : 'es'} above before importing.
                    </p>
                  )}
                </div>
              )}

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
                            {headers.map((h, j) => {
                              const colKey = headerToColKey.get(h)
                              let ann = colKey ? fkPreview?.get(`${colKey}|${i}`) : undefined
                              if (!ann && colKey && config.previewAnnotate && previewCells[i]) {
                                ann = config.previewAnnotate(colKey, previewCells[i]) ?? undefined
                              }
                              return (
                                <td key={j} className="px-2 py-1 whitespace-nowrap">
                                  {r[j] ?? ''}
                                  {ann && (
                                    <span className={ann.ok ? 'text-slate-400' : 'text-red-600'}> → {ann.text}</span>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm flex items-center gap-2 flex-wrap">
                  <span>When a row already exists (matched by <code className="bg-slate-100 px-1 rounded">{uniqueKeys.join(' + ')}</code>):</span>
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as ImportMode)}
                    className="rounded-lg border border-slate-300 px-2 py-1"
                  >
                    <option value="sync">Update changed fields{config.columns.some((c) => c.child) ? ` + add new ${config.resolution?.noun ?? 'child'}s` : ''}</option>
                    <option value="add">Skip (leave it unchanged)</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={doImport}
                  disabled={busy || !requiredOk || rows.length === 0 || !resolutionReady}
                  className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
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
              <div><span className="font-semibold text-green-700">{result.added}</span> added</div>
              {result.updated > 0 && <div><span className="font-semibold text-brand-deep">{result.updated}</span> updated</div>}
              {result.unchanged > 0 && <div><span className="font-semibold text-slate-600">{result.unchanged}</span> unchanged</div>}
              {result.skipped > 0 && <div><span className="font-semibold text-slate-600">{result.skipped}</span> skipped</div>}
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
      )}
    </div>
  )
}
