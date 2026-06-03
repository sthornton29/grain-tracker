'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, parseDocument } from '@/lib/pdf-upload'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import type { Crop, Field, FieldPlanting } from '@/lib/types'

type Props = {
  fields: Field[]
  crops: Crop[]
  existingPlantings: FieldPlanting[]
  defaultYear: number
  fieldLabel: (id: string) => string
  onImported: () => void
}

type RowVariety = { variety: string; acres: string }

type Row = {
  field_id: string
  raw_field: string | null
  crop_id: string
  raw_crop: string | null
  season_year: string
  planted_acres: string
  irrigated_acres: string
  planting_date: string
  varieties: RowVariety[]
  notes: string
  exists: boolean // a planting for this field+crop+year already exists
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
  if (!r.field_id || !r.crop_id || !r.season_year) return false
  const planted = num(r.planted_acres)
  if (planted == null || planted <= 0) return false
  const irr = num(r.irrigated_acres) ?? 0
  if (irr < 0 || irr > planted) return false
  return true
}

export default function PlantingsAiImport({ fields, crops, existingPlantings, defaultYear, fieldLabel, onImported }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)

  // Existing field|crop|year keys, to flag duplicates we shouldn't re-insert.
  const existingKeys = useMemo(
    () => new Set(existingPlantings.map((p) => `${p.field_id}|${p.crop_id}|${p.season_year}`)),
    [existingPlantings],
  )

  function dupKey(r: Row) {
    return `${r.field_id}|${r.crop_id}|${r.season_year}`
  }

  async function onSource(src: DocumentSource) {
    setErr(null)
    setBanner(null)
    setSource(src)
    setRows([])
    setStage('Reading document…')
    try {
      await new Promise((r) => setTimeout(r, 200))
      setStage('Extracting plantings…')
      const data = await parseDocument(src.kind === 'pdf' ? src.file : src.images, 'plantings')
      const extracted = Array.isArray(data.plantings) ? data.plantings : []
      if (extracted.length === 0) {
        setErr('No plantings found in this document. The scan may be too blurry or the format may not be readable.')
        return
      }
      const next: Row[] = extracted.map((p) => {
        const field = findBestMatch(p.field_name, fields, (f) => f.name_or_number)
        const crop = findBestMatch(p.crop, crops, (c) => c.name)
        const year = p.season_year != null && Number.isFinite(p.season_year) ? String(p.season_year) : String(defaultYear)
        const field_id = field?.id ?? ''
        const crop_id = crop?.id ?? ''
        const exists = !!field_id && !!crop_id && existingKeys.has(`${field_id}|${crop_id}|${year}`)
        const varietiesRaw = Array.isArray(p.varieties) ? p.varieties : []
        const varieties: RowVariety[] = varietiesRaw
          .map((v) => ({
            variety: (v.variety ?? '').toString().trim(),
            acres: numStr(v.acres),
          }))
          .filter((v) => v.variety !== '')
        return {
          field_id,
          raw_field: p.field_name,
          crop_id,
          raw_crop: p.crop,
          season_year: year,
          planted_acres: numStr(p.planted_acres),
          irrigated_acres: numStr(p.irrigated_acres),
          planting_date: p.planting_date && /^\d{4}-\d{2}-\d{2}$/.test(p.planting_date) ? p.planting_date : '',
          varieties,
          notes: p.notes ?? '',
          exists,
          include: !exists,
        }
      })
      setRows(next)
      setBanner(`AI extracted ${next.length} planting${next.length === 1 ? '' : 's'}. Review and edit before saving.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(e?.message ? `Couldn't read this document: ${e.message}.` : "Couldn't read this document.")
    } finally {
      setStage(null)
    }
  }

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => {
      if (i !== j) return r
      const nextRow = { ...r, ...patch }
      // Re-evaluate the duplicate flag whenever the dedup key changes.
      if ('field_id' in patch || 'crop_id' in patch || 'season_year' in patch) {
        nextRow.exists = !!nextRow.field_id && !!nextRow.crop_id && existingKeys.has(dupKey(nextRow))
      }
      return nextRow
    }))
  }
  function setRowVarieties(i: number, varieties: RowVariety[]) {
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, varieties } : r)))
  }
  function addVariety(i: number) {
    const r = rows[i]
    if (!r) return
    setRowVarieties(i, [...r.varieties, { variety: '', acres: '' }])
  }
  function updateVariety(i: number, vi: number, patch: Partial<RowVariety>) {
    const r = rows[i]
    if (!r) return
    setRowVarieties(i, r.varieties.map((v, j) => (j === vi ? { ...v, ...patch } : v)))
  }
  function removeVariety(i: number, vi: number) {
    const r = rows[i]
    if (!r) return
    setRowVarieties(i, r.varieties.filter((_, j) => j !== vi))
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

  const toSave = rows.filter((r) => r.include && rowReady(r) && !r.exists)

  async function saveAll() {
    setErr(null)
    if (toSave.length === 0) {
      setErr('No plantings are ready to save. Each needs a matched field, crop, season year, and planted acres.')
      return
    }
    setSaving(true)
    const payloads = toSave.map((r) => {
      const planted = num(r.planted_acres) ?? 0
      const irr = num(r.irrigated_acres) ?? 0
      return {
        field_id: r.field_id,
        crop_id: r.crop_id,
        season_year: Number(r.season_year),
        planted_acres: planted,
        irrigated_acres: irr,
        dryland_acres: Math.max(0, planted - irr),
        planting_date: r.planting_date || null,
        notes: r.notes.trim() || null,
      }
    })
    const { data: inserted, error } = await supabase
      .from('field_plantings')
      .insert(payloads)
      .select('id')
    if (error || !inserted) {
      setSaving(false)
      setErr(`Could not save: ${error?.message ?? 'unknown error'}`)
      return
    }
    // Map each inserted row back to its source by order — supabase insert
    // preserves input order for the returned rows. Build variety inserts only
    // for rows that have at least one named variety.
    const varietyInserts = inserted.flatMap((row, i) => {
      const src = toSave[i]
      if (!src) return []
      return src.varieties
        .map((v) => ({ variety: v.variety.trim(), acres: num(v.acres) ?? 0 }))
        .filter((v) => v.variety !== '')
        .map((v) => ({ planting_id: row.id, variety: v.variety, acres: v.acres }))
    })
    if (varietyInserts.length > 0) {
      const { error: vErr } = await supabase.from('field_planting_varieties').insert(varietyInserts)
      if (vErr) {
        setSaving(false)
        setErr(`Plantings saved but varieties failed: ${vErr.message}`)
        onImported()
        return
      }
    }
    setSaving(false)
    setBanner(`Saved ${payloads.length} planting${payloads.length === 1 ? '' : 's'}.`)
    setRows([])
    setSource(null)
    onImported()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm w-full bg-white'
  const dryFor = (r: Row) => {
    const planted = num(r.planted_acres)
    const irr = num(r.irrigated_acres) ?? 0
    return planted != null ? Math.max(0, planted - irr) : ''
  }

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold flex-1">Import plantings from a document (AI)</h2>
        {source && !stage && (
          <button type="button" onClick={discard} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
            Discard
          </button>
        )}
      </div>
      <p className="text-sm text-slate-500">
        Photograph or upload an FSA-578, crop-insurance acreage report, or a planting schedule. Each field+crop line
        becomes an editable row, matched to your fields and crops. Unmatched rows must be resolved before saving.
        Season year defaults to {defaultYear} when the document doesn’t show one.
      </p>

      <DocumentCapture
        onSource={onSource}
        busy={stage != null}
        stageLabel={stage}
        pdfLabel="Upload Plantings PDF or Photo (AI)"
      />

      {banner && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {(source || rows.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {['', 'Status', 'Field', 'Crop', 'Year', 'Planted ac', 'Irrigated ac', 'Dryland ac', 'Planted', 'Varieties', ''].map((h, i) => (
                    <th key={i} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={11} className="px-3 py-6 text-center text-slate-400">
                    {stage ? 'Working…' : 'No plantings extracted yet.'}
                  </td></tr>
                )}
                {rows.map((r, i) => {
                  const ready = rowReady(r)
                  return (
                    <tr key={i} className={`border-t border-slate-100 align-top ${r.exists ? 'opacity-60' : ''}`}>
                      <td className="px-2 py-1">
                        <input type="checkbox" checked={r.include} disabled={r.exists} onChange={(e) => setRow(i, { include: e.target.checked })} />
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {r.exists
                          ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">Exists</span>
                          : ready
                            ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Ready</span>
                            : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Needs review</span>}
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 160 }}>
                        <select value={r.field_id} onChange={(e) => setRow(i, { field_id: e.target.value })} className={inputCls}>
                          <option value="">— select field —</option>
                          {fields.map((f) => <option key={f.id} value={f.id}>{fieldLabel(f.id)}</option>)}
                        </select>
                        {!r.field_id && r.raw_field && <div className="text-xs text-amber-700 mt-1">AI: “{r.raw_field}”</div>}
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 130 }}>
                        <select value={r.crop_id} onChange={(e) => setRow(i, { crop_id: e.target.value })} className={inputCls}>
                          <option value="">— select crop —</option>
                          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {!r.crop_id && r.raw_crop && <div className="text-xs text-amber-700 mt-1">AI: “{r.raw_crop}”</div>}
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 80 }}>
                        <input type="number" value={r.season_year} onChange={(e) => setRow(i, { season_year: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" min="0" inputMode="decimal" value={r.planted_acres}
                          onChange={(e) => setRow(i, { planted_acres: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" min="0" inputMode="decimal" value={r.irrigated_acres}
                          onChange={(e) => setRow(i, { irrigated_acres: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1 text-right text-slate-500 whitespace-nowrap" style={{ minWidth: 70 }}>
                        {dryFor(r) === '' ? '—' : String(dryFor(r))}
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 130 }}>
                        <input type="date" value={r.planting_date} onChange={(e) => setRow(i, { planting_date: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 200 }}>
                        <div className="space-y-1">
                          {r.varieties.map((v, vi) => (
                            <div key={vi} className="grid grid-cols-[1fr_4.5rem_auto] gap-1 items-center">
                              <input
                                value={v.variety}
                                onChange={(e) => updateVariety(i, vi, { variety: e.target.value })}
                                placeholder="Variety"
                                className={inputCls}
                              />
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={v.acres}
                                onChange={(e) => updateVariety(i, vi, { acres: e.target.value })}
                                placeholder="ac"
                                className={inputCls}
                              />
                              <button
                                type="button"
                                onClick={() => removeVariety(i, vi)}
                                className="text-red-600 text-sm px-1"
                                aria-label="Remove variety"
                              >×</button>
                            </div>
                          ))}
                          <button type="button" onClick={() => addVariety(i)} className="text-xs text-sky-700">
                            + Add variety
                          </button>
                        </div>
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
            <SourcePreview source={source} className="h-full" title="Plantings document" />
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
