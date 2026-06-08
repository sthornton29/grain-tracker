'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, parseDocument, type FieldExtraction } from '@/lib/pdf-upload'
import { splitPdfIntoBatches } from '@/lib/pdf-split'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import type { Farm, Field } from '@/lib/types'

type Props = {
  farms: Farm[]
  existingFields: Field[]
  onImported: () => void
}

type Row = {
  name: string
  farm_id: string
  raw_farm: string | null
  total_acres: string
  irrigated_acres: string
  exists: boolean // a field with this name already exists
  include: boolean
}

const numStr = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '' : String(n)
const num = (s: string): number | null => {
  if (s === '' || s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function rowReady(r: Row): boolean {
  if (!r.name.trim()) return false
  const total = num(r.total_acres)
  const irr = num(r.irrigated_acres) ?? 0
  if (irr < 0) return false
  if (total != null && irr > total) return false
  return true
}

export default function FieldsAiImport({ farms, existingFields, onImported }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)

  const existingNames = useMemo(
    () => new Set(existingFields.map((f) => f.name_or_number.trim().toLowerCase())),
    [existingFields],
  )

  async function onSource(src: DocumentSource) {
    setErr(null)
    setBanner(null)
    setSource(src)
    setRows([])
    setStage('Reading document…')
    try {
      await new Promise((r) => setTimeout(r, 200))
      // A many-row spreadsheet/document becomes a multi-page PDF; one Anthropic
      // call over all of it can time out (504). Split into small page-batches,
      // parse each under the limit, and merge. Photos go in a single call.
      const extracted: FieldExtraction[] = []
      if (src.kind === 'pdf') {
        let batches: File[] = [src.file]
        try { batches = await splitPdfIntoBatches(src.file, 4) } catch { batches = [src.file] }
        for (let i = 0; i < batches.length; i++) {
          setStage(batches.length > 1 ? `Extracting fields (batch ${i + 1} of ${batches.length})…` : 'Extracting fields…')
          const data = await parseDocument(batches[i], 'fields')
          if (Array.isArray(data.fields)) extracted.push(...data.fields)
        }
      } else {
        setStage('Extracting fields…')
        const data = await parseDocument(src.images, 'fields')
        if (Array.isArray(data.fields)) extracted.push(...data.fields)
      }
      if (extracted.length === 0) {
        setErr('No fields found in this document. The scan may be too blurry or the format may not be readable.')
        return
      }
      const next: Row[] = extracted
        .filter((f) => (f.field_name ?? '').trim() !== '')
        .map((f) => {
          const farm = findBestMatch(f.farm_name, farms, (x) => x.name)
          const name = String(f.field_name).trim()
          const exists = existingNames.has(name.toLowerCase())
          return {
            name,
            farm_id: farm?.id ?? '',
            raw_farm: f.farm_name,
            total_acres: numStr(f.total_acres),
            irrigated_acres: numStr(f.irrigated_acres),
            exists,
            include: !exists,
          }
        })
      setRows(next)
      setBanner(`AI extracted ${next.length} field${next.length === 1 ? '' : 's'}. Review and edit before saving.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else if (e?.message?.includes('504') || e?.message?.toLowerCase?.().includes('timeout')) {
        setErr('That file took too long to read in one pass. Try fewer rows at a time — or, for a spreadsheet, use the CSV importer (faster and more accurate for tables).')
      } else setErr(e?.message ? `Couldn't read this document: ${e.message}.` : "Couldn't read this document.")
    } finally {
      setStage(null)
    }
  }

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i))
  }
  function discard() {
    setSource(null)
    setRows([])
    setBanner(null)
    setErr(null)
  }

  const toSave = rows.filter((r) => r.include && rowReady(r))

  async function saveAll() {
    setErr(null)
    if (toSave.length === 0) {
      setErr('No fields are ready to save. Each needs a name; irrigated acres can’t exceed total.')
      return
    }
    setSaving(true)
    const payloads = toSave.map((r) => {
      const total = num(r.total_acres)
      const irr = num(r.irrigated_acres) ?? 0
      return {
        name_or_number: r.name.trim(),
        farm_id: r.farm_id || null,
        county_id: null,
        total_acres: total,
        irrigated_acres: irr,
        dryland_acres: total != null ? Math.max(0, total - irr) : 0,
      }
    })
    const { error } = await supabase.from('fields').insert(payloads)
    setSaving(false)
    if (error) { setErr(`Could not save: ${error.message}`); return }
    setBanner(`Saved ${payloads.length} field${payloads.length === 1 ? '' : 's'}.`)
    setRows([])
    setSource(null)
    onImported()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm w-full bg-white'
  const dryFor = (r: Row) => {
    const total = num(r.total_acres)
    const irr = num(r.irrigated_acres) ?? 0
    return total != null ? Math.max(0, total - irr) : ''
  }

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold flex-1">Import fields from a document (AI)</h2>
        {source && !stage && (
          <button type="button" onClick={discard} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
            Discard
          </button>
        )}
      </div>
      <p className="text-sm text-slate-500">
        Photograph or upload an FSA-578, crop-insurance acreage report, or a field list. The AI pulls each field’s
        name, farm, and acres into a review table — nothing is saved until you press Save All.
      </p>

      <DocumentCapture
        onSource={onSource}
        busy={stage != null}
        stageLabel={stage}
        pdfLabel="Upload Fields PDF or Photo (AI)"
      />

      {banner && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {(source || rows.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {['', 'Status', 'Field name', 'Farm', 'Total ac', 'Irrigated ac', 'Dryland ac', ''].map((h, i) => (
                    <th key={i} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                    {stage ? 'Working…' : 'No fields extracted yet.'}
                  </td></tr>
                )}
                {rows.map((r, i) => {
                  const ready = rowReady(r)
                  return (
                    <tr key={i} className={`border-t border-slate-100 align-top ${r.exists ? 'opacity-60' : ''}`}>
                      <td className="px-2 py-1">
                        <input type="checkbox" checked={r.include} onChange={(e) => setRow(i, { include: e.target.checked })} />
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {r.exists
                          ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">Exists</span>
                          : ready
                            ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Ready</span>
                            : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Needs review</span>}
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 140 }}>
                        <input value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 150 }}>
                        <select value={r.farm_id} onChange={(e) => setRow(i, { farm_id: e.target.value })} className={inputCls}>
                          <option value="">— no farm —</option>
                          {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        {!r.farm_id && r.raw_farm && (
                          <div className="text-xs text-amber-700 mt-1">AI: “{r.raw_farm}”</div>
                        )}
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" min="0" inputMode="decimal" value={r.total_acres}
                          onChange={(e) => setRow(i, { total_acres: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" min="0" inputMode="decimal" value={r.irrigated_acres}
                          onChange={(e) => setRow(i, { irrigated_acres: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1 text-right text-slate-500 whitespace-nowrap" style={{ minWidth: 70 }}>
                        {dryFor(r) === '' ? '—' : String(dryFor(r))}
                      </td>
                      <td className="px-2 py-1">
                        <button type="button" onClick={() => removeRow(i)} className="text-red-600 text-sm">✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="xl:sticky xl:top-3 self-start h-[60vh] min-h-[320px]">
            <div className="text-xs text-slate-500 mb-1">Source document — cross-reference while reviewing</div>
            <SourcePreview source={source} className="h-full" title="Fields document" />
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <div className="text-sm text-slate-600 flex-1">
            <span className="font-semibold text-green-700">{toSave.length}</span> ready to save · {rows.length} total
          </div>
          <button type="button" onClick={saveAll} disabled={saving || toSave.length === 0}
            className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold disabled:opacity-50">
            {saving ? 'Saving…' : `Save All (${toSave.length})`}
          </button>
        </div>
      )}
    </div>
  )
}
