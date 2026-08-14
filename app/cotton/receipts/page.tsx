'use client'

// Cotton module — Gin Receipts (Statements of Ginning). Multiple receipts per
// field allowed. AI upload extracts the header/totals, the load table, and
// the FULL bale list; review matches farm/field, matches load lines to
// existing cotton_loads by load_number (creating missing ones inline), and
// flags a bale-count mismatch before the receipt + bales save together.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, type GinReceiptExtraction } from '@/lib/pdf-upload'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeGinReceipts } from '@/lib/parse-merge'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { reconcileBaleCount, lintTurnoutPct } from '@/lib/cotton'
import type { GinReceipt, Gin, Farm, Field, Entity, CottonLoad } from '@/lib/types'

const lbs = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString())
const num = (s: string): number | null => { const n = Number(s); return s.trim() !== '' && Number.isFinite(n) ? n : null }

export default function GinReceiptsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [receipts, setReceipts] = useState<GinReceipt[]>([])
  const [balesByReceipt, setBalesByReceipt] = useState<Map<string, number>>(new Map())
  const [gins, setGins] = useState<Gin[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [loads, setLoads] = useState<CottonLoad[]>([])
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // AI review
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [x, setX] = useState<GinReceiptExtraction | null>(null)
  const [farmId, setFarmId] = useState('')
  const [fieldId, setFieldId] = useState('')
  const [createMissing, setCreateMissing] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  // manual form
  const [m, setM] = useState({ receipt_number: '', receipt_date: '', gin_id: '', farm_id: '', field_id: '', modules: '', seedwt: '', bales: '', balewt: '', seedlbs: '' })

  async function refresh() {
    const [r, b, g, f, fl, en, l] = await Promise.all([
      supabase.from('gin_receipts').select('*').order('receipt_date', { ascending: false }),
      supabase.from('cotton_bales').select('gin_receipt_id'),
      supabase.from('gins').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('cotton_loads').select('*'),
    ])
    setReceipts((r.data as GinReceipt[]) || [])
    const counts = new Map<string, number>()
    for (const row of ((b.data as { gin_receipt_id: string }[]) || [])) counts.set(row.gin_receipt_id, (counts.get(row.gin_receipt_id) ?? 0) + 1)
    setBalesByReceipt(counts)
    setGins((g.data as Gin[]) || [])
    setFarms((f.data as Farm[]) || [])
    setFields((fl.data as Field[]) || [])
    setEntities((en.data as Entity[]) || [])
    setLoads((l.data as CottonLoad[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const ginById = useMemo(() => new Map(gins.map((g) => [g.id, g])), [gins])
  const yearReceipts = receipts.filter((r) => r.crop_year === cropYear)
  const yearLoadsByNumber = useMemo(
    () => new Map(loads.filter((l) => l.crop_year === cropYear).map((l) => [l.load_number.trim(), l])),
    [loads, cropYear],
  )

  async function ensureGin(name: string | null): Promise<string | null> {
    if (!name?.trim()) return null
    const existing = gins.find((g) => g.name.trim().toLowerCase() === name.trim().toLowerCase())
    if (existing) return existing.id
    const { data, error } = await supabase.from('gins').insert({ name: name.trim(), address: x?.gin_address ?? null, phone: x?.gin_phone ?? null }).select('id').single()
    if (error || !data) return null
    return (data as { id: string }).id
  }

  async function onSource(src: DocumentSource) {
    setErr(null); setMsg(null); setSource(src); setX(null)
    setStage('Reading the Statement of Ginning…')
    try {
      // A statement is one document, but its bale list can run many pages —
      // chunked parse keeps each call under the time limit; the merge takes
      // header fields from the first page and dedupes loads/bales that repeat
      // across a batch boundary (mergeGinReceipts).
      const { data, warning } = await parseDocumentChunked<GinReceiptExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'gin_receipt',
        { onProgress: setStage, merge: mergeGinReceipts },
      )
      if (warning) setErr(warning)
      setX({ ...data, loads: data.loads ?? [], bales: data.bales ?? [] })
      const farm = (data.farm_number ? farms.find((f) => (f.fsa_number ?? '').trim() === data.farm_number!.trim()) : null)
        ?? (data.farm_name ? findBestMatch(data.farm_name, farms, (f) => f.name) : null)
        ?? (data.producer ? findBestMatch(data.producer, farms, (f) => f.name) : null)
      setFarmId(farm?.id ?? '')
      const farmFields = fields.filter((f) => !farm || f.farm_id === farm.id)
      setFieldId(data.field ? findBestMatch(data.field, farmFields, (f) => f.name_or_number)?.id ?? '' : '')
      setCreateMissing(new Set((data.loads ?? []).map((_, i) => i).filter((i) => {
        const ln = data.loads[i]?.load_number?.trim()
        return !!ln && !yearLoadsByNumber.has(ln)
      })))
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(e?.message ? `Couldn't read this document: ${e.message}` : "Couldn't read this document.")
    } finally {
      setStage(null)
    }
  }

  async function saveExtracted() {
    if (!x) return
    if (!x.receipt_number?.trim()) { setErr('The statement needs a receipt/gin #.'); return }
    setSaving(true); setErr(null)
    let receiptId: string | null = null
    try {
      const gin_id = await ensureGin(x.gin_name)
      const year = x.crop_year ?? cropYear
      const balesRows = (x.bales ?? []).filter((b) => b.pbi_number && b.net_weight_lbs != null)
      const { data: rec, error: recErr } = await supabase.from('gin_receipts').insert({
        gin_id, receipt_number: x.receipt_number.trim(), receipt_date: x.receipt_date, crop_year: year,
        entity_id: farmId ? farmById.get(farmId)?.entity_id ?? null : null,
        farm_id: farmId || null, field_id: fieldId || null,
        modules_count: x.modules_count, total_seed_cotton_weight: x.total_seed_cotton_weight,
        bales_count: x.bales_count, total_bale_weight: x.total_bale_weight, avg_bale_weight: x.avg_bale_weight,
        seed_lbs: x.seed_lbs, lint_turnout_pct: x.lint_turnout_pct, lint_lbs_per_bale: x.lint_lbs_per_bale,
        source: 'document_import',
      }).select('id').single()
      if (recErr || !rec) { setErr(recErr?.message ?? 'Could not save the receipt.'); return }
      receiptId = (rec as { id: string }).id

      // Load lines: link existing by load_number; create the checked missing ones.
      const linkIds: string[] = []
      for (let i = 0; i < (x.loads ?? []).length; i++) {
        const line = x.loads[i]
        const ln = line.load_number?.trim()
        if (!ln) continue
        const existing = yearLoadsByNumber.get(ln)
        if (existing) { linkIds.push(existing.id); continue }
        if (!createMissing.has(i)) continue
        const { data: nl, error: nlErr } = await supabase.from('cotton_loads').insert({
          load_number: ln, crop_year: year, farm_id: farmId || null, field_id: fieldId || null,
          entity_id: farmId ? farmById.get(farmId)?.entity_id ?? null : null,
          gross_weight: line.gross, tare_weight: line.tare,
          net_weight: line.net ?? (line.gross != null && line.tare != null ? line.gross - line.tare : null),
          gin_id, source: 'document_import',
        }).select('id').single()
        if (nlErr || !nl) throw new Error(nlErr?.message ?? `Could not create load ${ln}.`)
        linkIds.push((nl as { id: string }).id)
      }
      if (linkIds.length > 0) {
        const { error } = await supabase.from('gin_receipt_loads').insert(linkIds.map((id) => ({ receipt_id: receiptId, cotton_load_id: id })))
        if (error) throw new Error(error.message)
      }
      if (balesRows.length > 0) {
        const { error } = await supabase.from('cotton_bales').insert(balesRows.map((b) => ({
          gin_receipt_id: receiptId, crop_year: year, pbi_number: String(b.pbi_number).trim(), net_weight_lbs: b.net_weight_lbs,
        })))
        if (error) throw new Error(error.message)
      }
      setMsg(`Saved receipt ${x.receipt_number} with ${balesRows.length} bales and ${linkIds.length} linked loads.`)
      setX(null); setSource(null); refresh()
    } catch (e: any) {
      // Best-effort atomicity: a failure after the receipt insert removes the
      // receipt (bales/links cascade) so a partial statement never lingers.
      if (receiptId) await supabase.from('gin_receipts').delete().eq('id', receiptId)
      setErr(`Could not save the statement: ${e?.message ?? 'unknown error'} — nothing was kept.`)
    } finally {
      setSaving(false)
    }
  }

  async function addManual(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!m.receipt_number.trim()) { setErr('Receipt # required.'); return }
    const lint = num(m.balewt)
    const seedcotton = num(m.seedwt)
    const { error } = await supabase.from('gin_receipts').insert({
      receipt_number: m.receipt_number.trim(), receipt_date: m.receipt_date || null, crop_year: cropYear,
      gin_id: m.gin_id || null, farm_id: m.farm_id || null, field_id: m.field_id || null,
      entity_id: m.farm_id ? farmById.get(m.farm_id)?.entity_id ?? null : null,
      modules_count: num(m.modules), total_seed_cotton_weight: seedcotton, bales_count: num(m.bales),
      total_bale_weight: lint, seed_lbs: num(m.seedlbs),
      lint_turnout_pct: lint != null && seedcotton != null ? lintTurnoutPct(lint, seedcotton) : null,
      avg_bale_weight: lint != null && num(m.bales) ? Math.round((lint / num(m.bales)!) * 100) / 100 : null,
      source: 'manual',
    })
    if (error) { setErr(error.message); return }
    setM({ receipt_number: '', receipt_date: '', gin_id: m.gin_id, farm_id: m.farm_id, field_id: '', modules: '', seedwt: '', bales: '', balewt: '', seedlbs: '' })
    setMsg('Receipt saved — add its bales via the Bales & Grades CSV/AI flows or re-upload the statement.')
    refresh()
  }

  async function deleteReceipt(id: string) {
    if (!confirm('Delete this gin receipt (its bales and load links go with it)?')) return
    await supabase.from('gin_receipts').delete().eq('id', id)
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const baleCheck = x ? reconcileBaleCount(x.bales_count, (x.bales ?? []).filter((b) => b.pbi_number && b.net_weight_lbs != null).length) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-bold flex-1">Gin Receipts</h1>
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year</span>
          <input type="number" value={cropYear} onChange={(e) => setCropYear(Number(e.target.value))} className={`${inputCls} w-24`} />
        </label>
      </div>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Upload Statement of Ginning (AI)</h2>
        <DocumentCapture onSource={onSource} busy={stage != null} stageLabel={stage} pdfLabel="Upload Statement PDF or Photo (AI)" />
        {x && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-3 items-end">
              <span className="font-semibold">{x.gin_name ?? 'Gin'} — statement {x.receipt_number ?? '—'} · {x.receipt_date ?? 'no date'}</span>
              <select value={farmId} onChange={(e) => { setFarmId(e.target.value); setFieldId('') }} className={inputCls}>
                <option value="">— farm —</option>
                {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <select value={fieldId} onChange={(e) => setFieldId(e.target.value)} className={inputCls}>
                <option value="">— field —</option>
                {fields.filter((f) => !farmId || f.farm_id === farmId).map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
              </select>
              {(x.farm_name || x.producer || x.field) && <span className="text-xs text-amber-700">AI: {x.producer ?? x.farm_name}{x.farm_number ? ` #${x.farm_number}` : ''}{x.field ? ` · ${x.field}` : ''}</span>}
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded bg-slate-50 border border-slate-200 px-2 py-1">{x.modules_count ?? '—'} modules</span>
              <span className="rounded bg-slate-50 border border-slate-200 px-2 py-1">{lbs(x.total_seed_cotton_weight)} lbs seed cotton</span>
              <span className="rounded bg-slate-50 border border-slate-200 px-2 py-1">{x.bales_count ?? '—'} bales · {lbs(x.total_bale_weight)} lbs lint</span>
              <span className="rounded bg-slate-50 border border-slate-200 px-2 py-1">{lbs(x.seed_lbs)} lbs cottonseed</span>
              <span className="rounded bg-slate-50 border border-slate-200 px-2 py-1">turnout {x.lint_turnout_pct ?? '—'}%</span>
              <span className="rounded bg-slate-50 border border-slate-200 px-2 py-1">{(x.bales ?? []).length} bale rows extracted</span>
            </div>
            {baleCheck && !baleCheck.ok && <p className="text-amber-700 text-xs font-semibold">{baleCheck.message}</p>}
            {(x.loads ?? []).length > 0 && (
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="text-slate-500"><tr>{['Load #', 'Net lbs', 'Match', ''].map((h) => <th key={h} className="text-left px-1 py-1">{h}</th>)}</tr></thead>
                  <tbody>
                    {x.loads.map((l, i) => {
                      const ln = l.load_number?.trim() ?? ''
                      const existing = ln ? yearLoadsByNumber.get(ln) : undefined
                      return (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-1 py-1 font-mono">{ln || '—'}</td>
                          <td className="px-1 py-1 text-right">{lbs(l.net)}</td>
                          <td className="px-1 py-1">
                            {existing
                              ? <span className="text-green-700">matches existing load</span>
                              : <span className="text-amber-700">not in the app</span>}
                          </td>
                          <td className="px-1 py-1">
                            {!existing && ln && (
                              <label className="flex items-center gap-1">
                                <input type="checkbox" checked={createMissing.has(i)} onChange={(e) => setCreateMissing((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n })} />
                                create load
                              </label>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={saveExtracted} disabled={saving} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">
                {saving ? 'Saving…' : 'Save receipt + bales'}
              </button>
              <button onClick={() => { setX(null); setSource(null) }} className="rounded-lg bg-white border border-slate-300 px-4 py-2">Discard</button>
            </div>
            {source && <span className="text-xs text-slate-400">Confirm against the document before saving.</span>}
          </div>
        )}
      </section>

      <form onSubmit={addManual} className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">Add Receipt Manually</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <input placeholder="Receipt # *" value={m.receipt_number} onChange={(e) => setM({ ...m, receipt_number: e.target.value })} className={inputCls} />
          <input type="date" value={m.receipt_date} onChange={(e) => setM({ ...m, receipt_date: e.target.value })} className={inputCls} />
          <select value={m.gin_id} onChange={(e) => setM({ ...m, gin_id: e.target.value })} className={inputCls}>
            <option value="">— gin —</option>
            {gins.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select value={m.farm_id} onChange={(e) => setM({ ...m, farm_id: e.target.value, field_id: '' })} className={inputCls}>
            <option value="">— farm —</option>
            {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select value={m.field_id} onChange={(e) => setM({ ...m, field_id: e.target.value })} className={inputCls}>
            <option value="">— field —</option>
            {fields.filter((f) => !m.farm_id || f.farm_id === m.farm_id).map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
          </select>
          <input type="number" placeholder="Modules" value={m.modules} onChange={(e) => setM({ ...m, modules: e.target.value })} className={inputCls} />
          <input type="number" placeholder="Seed cotton lbs" value={m.seedwt} onChange={(e) => setM({ ...m, seedwt: e.target.value })} className={inputCls} />
          <input type="number" placeholder="Bales" value={m.bales} onChange={(e) => setM({ ...m, bales: e.target.value })} className={inputCls} />
          <input type="number" placeholder="Lint lbs" value={m.balewt} onChange={(e) => setM({ ...m, balewt: e.target.value })} className={inputCls} />
          <input type="number" placeholder="Cottonseed lbs" value={m.seedlbs} onChange={(e) => setM({ ...m, seedlbs: e.target.value })} className={inputCls} />
        </div>
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">Add Receipt</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}

      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700"><tr>{['Receipt #', 'Date', 'Gin', 'Farm', 'Field', 'Bales', 'Lint lbs', 'Turnout', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>
            {yearReceipts.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">No {cropYear} gin receipts yet.</td></tr>}
            {yearReceipts.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono">{r.receipt_number}</td>
                <td className="px-3 py-2">{r.receipt_date ?? '—'}</td>
                <td className="px-3 py-2">{r.gin_id ? ginById.get(r.gin_id)?.name ?? '—' : '—'}</td>
                <td className="px-3 py-2">{r.farm_id ? farmById.get(r.farm_id)?.name ?? '—' : '—'}</td>
                <td className="px-3 py-2">{r.field_id ? fieldById.get(r.field_id)?.name_or_number ?? '—' : '—'}</td>
                <td className="px-3 py-2 text-right">{balesByReceipt.get(r.id) ?? r.bales_count ?? '—'}</td>
                <td className="px-3 py-2 text-right font-mono">{lbs(r.total_bale_weight)}</td>
                <td className="px-3 py-2 text-right">{r.lint_turnout_pct != null ? `${Number(r.lint_turnout_pct)}%` : '—'}</td>
                <td className="px-3 py-2"><button onClick={() => deleteReceipt(r.id)} className="text-red-600 text-xs">Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
