'use client'

// Cotton module — Seed Cotton Loads: the gin's module/load weight tickets.
// Yard inventory until they appear on a gin receipt. Manual entry mirrors the
// grain load form patterns (session-persistent crop year, farm → field
// cascade); AI upload parses Module List PDFs/photos (one load per page)
// through the shared /api/parse-document infra with the standard
// review-then-batch-save UX.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, type CottonLoadsExtraction, type CottonLoadExtraction } from '@/lib/pdf-upload'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeCottonLoads } from '@/lib/parse-merge'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { yardInventoryByField } from '@/lib/cotton'
import type { CottonLoad, Gin, Farm, Field, Entity } from '@/lib/types'

const lbs = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString())
const num = (s: string): number | null => {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

type Draft = {
  load_number: string; entity_id: string; farm_id: string; field_id: string
  picked_date: string; delivered_date: string; truck: string
  gross_weight: string; tare_weight: string; gin_id: string; notes: string
}
const emptyDraft: Draft = {
  load_number: '', entity_id: '', farm_id: '', field_id: '', picked_date: '', delivered_date: '',
  truck: '', gross_weight: '', tare_weight: '', gin_id: '', notes: '',
}

type AiRow = CottonLoadExtraction & { farm_id: string; field_id: string; include: boolean }

export default function CottonLoadsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [loads, setLoads] = useState<CottonLoad[]>([])
  const [gins, setGins] = useState<Gin[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [ginnedIds, setGinnedIds] = useState<Set<string>>(new Set())
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [newGin, setNewGin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // AI review state
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [aiRows, setAiRows] = useState<AiRow[]>([])
  const [saving, setSaving] = useState(false)

  async function refresh() {
    const [l, g, f, fl, en, jr] = await Promise.all([
      fetchAllRows((f, t) => supabase.from('cotton_loads').select('*').order('delivered_date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(f, t)),
      supabase.from('gins').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('entities').select('*').order('name'),
      fetchAllRows((f, t) => supabase.from('gin_receipt_loads').select('cotton_load_id').order('id').range(f, t)),
    ])
    setLoads((l.data as CottonLoad[]) || [])
    setGins((g.data as Gin[]) || [])
    setFarms((f.data as Farm[]) || [])
    setFields((fl.data as Field[]) || [])
    setEntities((en.data as Entity[]) || [])
    setGinnedIds(new Set(((jr.data as { cotton_load_id: string }[]) || []).map((r) => r.cotton_load_id)))
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const yearLoads = useMemo(() => loads.filter((l) => l.crop_year === cropYear), [loads, cropYear])
  const draftFields = fields.filter((f) => !draft.farm_id || f.farm_id === draft.farm_id)

  // Yard inventory: delivered but not on any gin receipt, by field.
  const yard = useMemo(() => yardInventoryByField(yearLoads, ginnedIds), [yearLoads, ginnedIds])
  const yardTotal = useMemo(() => Array.from(yard.values()).reduce((s, v) => s + v, 0), [yard])

  async function ensureGin(name: string): Promise<string | null> {
    const existing = gins.find((g) => g.name.trim().toLowerCase() === name.trim().toLowerCase())
    if (existing) return existing.id
    const { data, error } = await supabase.from('gins').insert({ name: name.trim() }).select('id').single()
    if (error || !data) { setErr(error?.message ?? 'Could not create the gin.'); return null }
    return (data as { id: string }).id
  }

  async function addManual(e: React.FormEvent) {
    e.preventDefault()
    setErr(null); setMsg(null)
    if (!draft.load_number.trim()) { setErr('Load # is required.'); return }
    let gin_id: string | null = draft.gin_id || null
    if (!gin_id && newGin.trim()) gin_id = await ensureGin(newGin)
    const gross = num(draft.gross_weight)
    const tare = num(draft.tare_weight)
    const { error } = await supabase.from('cotton_loads').insert({
      load_number: draft.load_number.trim(), crop_year: cropYear,
      entity_id: draft.entity_id || null, farm_id: draft.farm_id || null, field_id: draft.field_id || null,
      picked_date: draft.picked_date || null, delivered_date: draft.delivered_date || null,
      truck: draft.truck.trim() || null, gross_weight: gross, tare_weight: tare,
      net_weight: gross != null && tare != null ? gross - tare : gross,
      gin_id, notes: draft.notes.trim() || null, source: 'manual',
    })
    if (error) { setErr(error.message.includes('duplicate') ? `Load ${draft.load_number} already exists for ${cropYear}.` : error.message); return }
    setDraft({ ...emptyDraft, entity_id: draft.entity_id, farm_id: draft.farm_id, field_id: draft.field_id, gin_id: draft.gin_id })
    setNewGin(''); setMsg('Load saved.'); refresh()
  }

  function extractionToRow(x: CottonLoadExtraction): AiRow {
    const farm = (x.farm_number ? farms.find((f) => (f.fsa_number ?? '').trim() === x.farm_number!.trim()) : null)
      ?? (x.producer ? findBestMatch(x.producer, farms, (f) => f.name) : null)
    const farmFields = fields.filter((f) => !farm || f.farm_id === farm.id)
    const field = x.field ? findBestMatch(x.field, farmFields, (f) => f.name_or_number) : null
    return { ...x, farm_id: farm?.id ?? '', field_id: field?.id ?? '', include: true }
  }

  async function onSource(src: DocumentSource) {
    setErr(null); setMsg(null); setSource(src); setAiRows([])
    setStage('Reading module tickets…')
    try {
      // Chunked parse: page/photo batches with per-chunk retry; a load number
      // repeated across a batch boundary resolves once (mergeCottonLoads).
      const { data, warning } = await parseDocumentChunked<CottonLoadsExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'cotton_weight_ticket',
        { pagesPerBatch: 4, onProgress: setStage, merge: mergeCottonLoads },
      )
      const extracted: CottonLoadExtraction[] = Array.isArray(data.loads) ? data.loads : []
      if (extracted.length === 0) { setErr(warning ?? 'No loads found in this document.'); return }
      if (warning) setErr(warning)
      setAiRows(extracted.map(extractionToRow))
      setMsg(`Extracted ${extracted.length} load${extracted.length === 1 ? '' : 's'} — review and save.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(e?.message ? `Couldn't read this document: ${e.message}` : "Couldn't read this document.")
    } finally {
      setStage(null)
    }
  }

  async function saveAiRows() {
    setSaving(true); setErr(null)
    try {
      const existing = new Set(yearLoads.map((l) => l.load_number.trim()))
      const rows = aiRows.filter((r) => r.include && r.load_number && !existing.has(r.load_number.trim()))
      const dupes = aiRows.filter((r) => r.include && r.load_number && existing.has(r.load_number.trim())).length
      if (rows.length === 0) { setErr(dupes > 0 ? 'Every included load already exists for this crop year.' : 'Nothing to save.'); return }
      const { error } = await supabase.from('cotton_loads').insert(rows.map((r) => ({
        load_number: r.load_number!.trim(), crop_year: r.crop_year ?? cropYear,
        farm_id: r.farm_id || null, field_id: r.field_id || null,
        entity_id: r.farm_id ? farmById.get(r.farm_id)?.entity_id ?? null : null,
        picked_date: r.picked_date, delivered_date: r.delivered_date, truck: r.truck,
        gross_weight: r.gross_weight, tare_weight: r.tare_weight,
        net_weight: r.net_weight ?? (r.gross_weight != null && r.tare_weight != null ? r.gross_weight - r.tare_weight : null),
        source: 'document_import',
      })))
      if (error) { setErr(error.message); return }
      setMsg(`Saved ${rows.length} load${rows.length === 1 ? '' : 's'}${dupes > 0 ? ` (${dupes} skipped — already entered)` : ''}.`)
      setAiRows([]); setSource(null); refresh()
    } finally {
      setSaving(false)
    }
  }

  async function deleteLoad(id: string) {
    if (!confirm('Delete this seed cotton load?')) return
    await supabase.from('cotton_loads').delete().eq('id', id)
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const years = useMemo(() => {
    const ys = new Set<number>([cropYear, new Date().getFullYear(), ...loads.map((l) => l.crop_year)])
    return [...ys].sort((a, b) => b - a)
  }, [loads, cropYear])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-bold flex-1">Seed Cotton Loads</h1>
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year</span>
          <select value={cropYear} onChange={(e) => setCropYear(Number(e.target.value))} className={inputCls}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      </div>

      {/* Yard inventory — delivered but not yet on a gin receipt. */}
      <section className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">Yard Inventory <span className="text-sm font-normal text-slate-500">seed cotton delivered, awaiting gin</span></h2>
        {yardTotal === 0 ? (
          <p className="text-sm text-slate-400">Nothing on the yard — every {cropYear} load is on a gin receipt.</p>
        ) : (
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 font-semibold">{lbs(yardTotal)} lbs total</span>
            {Array.from(yard.entries()).filter(([, v]) => v > 0).map(([fieldId, v]) => {
              const f = fieldId ? fieldById.get(fieldId) : null
              const farm = f?.farm_id ? farmById.get(f.farm_id) : null
              return <span key={fieldId ?? 'none'} className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-1.5">{farm ? `${farm.name} · ` : ''}{f?.name_or_number ?? 'no field'}: {lbs(v)} lbs</span>
            })}
          </div>
        )}
      </section>

      {/* AI intake */}
      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Upload Module List (AI)</h2>
        <p className="text-sm text-slate-500">PDF or photos of the gin&apos;s module/load tickets — one load per page. Review before saving.</p>
        <DocumentCapture onSource={onSource} busy={stage != null} stageLabel={stage} pdfLabel="Upload Module List PDF or Photo (AI)" />
        {aiRows.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="text-slate-500"><tr>{['', 'Load #', 'Farm', 'Field', 'Picked', 'Delivered', 'Truck', 'Gross', 'Tare', 'Net'].map((h) => <th key={h} className="text-left px-1 py-1">{h}</th>)}</tr></thead>
                <tbody>
                  {aiRows.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-1 py-1"><input type="checkbox" checked={r.include} onChange={(e) => setAiRows((xs) => xs.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} /></td>
                      <td className="px-1 py-1 font-mono">{r.load_number ?? '—'}</td>
                      <td className="px-1 py-1">
                        <select value={r.farm_id} onChange={(e) => setAiRows((xs) => xs.map((x, j) => j === i ? { ...x, farm_id: e.target.value, field_id: '' } : x))} className="rounded border border-slate-300 px-1 py-0.5">
                          <option value="">— farm —</option>
                          {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        {!r.farm_id && r.producer && <div className="text-amber-700">AI: {r.producer}{r.farm_number ? ` #${r.farm_number}` : ''}</div>}
                      </td>
                      <td className="px-1 py-1">
                        <select value={r.field_id} onChange={(e) => setAiRows((xs) => xs.map((x, j) => j === i ? { ...x, field_id: e.target.value } : x))} className="rounded border border-slate-300 px-1 py-0.5">
                          <option value="">— field —</option>
                          {fields.filter((f) => !r.farm_id || f.farm_id === r.farm_id).map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
                        </select>
                        {!r.field_id && r.field && <div className="text-amber-700">AI: {r.field}</div>}
                      </td>
                      <td className="px-1 py-1">{r.picked_date ?? '—'}</td>
                      <td className="px-1 py-1">{r.delivered_date ?? '—'}</td>
                      <td className="px-1 py-1">{r.truck ?? '—'}</td>
                      <td className="px-1 py-1 text-right">{lbs(r.gross_weight)}</td>
                      <td className="px-1 py-1 text-right">{lbs(r.tare_weight)}</td>
                      <td className="px-1 py-1 text-right font-semibold">{lbs(r.net_weight)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={saveAiRows} disabled={saving} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">
              {saving ? 'Saving…' : `Save ${aiRows.filter((r) => r.include).length} loads`}
            </button>
          </>
        )}
      </section>

      {/* Manual entry */}
      <form onSubmit={addManual} className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">Add Load Manually</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <input placeholder="Load # *" value={draft.load_number} onChange={(e) => setDraft({ ...draft, load_number: e.target.value })} className={inputCls} />
          <select value={draft.entity_id} onChange={(e) => setDraft({ ...draft, entity_id: e.target.value })} className={inputCls}>
            <option value="">— entity —</option>
            {entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <select value={draft.farm_id} onChange={(e) => setDraft({ ...draft, farm_id: e.target.value, field_id: '' })} className={inputCls}>
            <option value="">— farm —</option>
            {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select value={draft.field_id} onChange={(e) => setDraft({ ...draft, field_id: e.target.value })} className={inputCls}>
            <option value="">— field —</option>
            {draftFields.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
          </select>
          <label className="text-xs text-slate-500">Picked<input type="date" value={draft.picked_date} onChange={(e) => setDraft({ ...draft, picked_date: e.target.value })} className={`${inputCls} w-full`} /></label>
          <label className="text-xs text-slate-500">Delivered<input type="date" value={draft.delivered_date} onChange={(e) => setDraft({ ...draft, delivered_date: e.target.value })} className={`${inputCls} w-full`} /></label>
          <input placeholder="Truck" value={draft.truck} onChange={(e) => setDraft({ ...draft, truck: e.target.value })} className={inputCls} />
          <select value={draft.gin_id} onChange={(e) => setDraft({ ...draft, gin_id: e.target.value })} className={inputCls}>
            <option value="">— gin —</option>
            {gins.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <input type="number" step="1" placeholder="Gross lbs" value={draft.gross_weight} onChange={(e) => setDraft({ ...draft, gross_weight: e.target.value })} className={inputCls} />
          <input type="number" step="1" placeholder="Tare lbs" value={draft.tare_weight} onChange={(e) => setDraft({ ...draft, tare_weight: e.target.value })} className={inputCls} />
          <input placeholder="New gin name (if not listed)" value={newGin} onChange={(e) => setNewGin(e.target.value)} className={inputCls} />
          <input placeholder="Notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className={inputCls} />
        </div>
        {num(draft.gross_weight) != null && num(draft.tare_weight) != null && (
          <p className="text-sm text-slate-500">Net: <b>{lbs(num(draft.gross_weight)! - num(draft.tare_weight)!)}</b> lbs seed cotton</p>
        )}
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">Add Load</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}

      {/* Load list */}
      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700"><tr>{['Load #', 'Farm', 'Field', 'Delivered', 'Truck', 'Net lbs', 'Status', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>
            {yearLoads.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No {cropYear} seed cotton loads yet.</td></tr>}
            {yearLoads.map((l) => {
              const f = l.field_id ? fieldById.get(l.field_id) : null
              return (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono">{l.load_number}</td>
                  <td className="px-3 py-2">{l.farm_id ? farmById.get(l.farm_id)?.name ?? '—' : '—'}</td>
                  <td className="px-3 py-2">{f?.name_or_number ?? '—'}</td>
                  <td className="px-3 py-2">{l.delivered_date ?? '—'}</td>
                  <td className="px-3 py-2">{l.truck ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{lbs(l.net_weight)}</td>
                  <td className="px-3 py-2">
                    {ginnedIds.has(l.id)
                      ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">ginned</span>
                      : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">on yard</span>}
                  </td>
                  <td className="px-3 py-2"><button onClick={() => deleteLoad(l.id)} className="text-red-600 text-xs">Delete</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
