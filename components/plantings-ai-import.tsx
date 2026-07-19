'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, parseDocument, type PlantingExtraction } from '@/lib/pdf-upload'
import { splitPdfIntoBatches } from '@/lib/pdf-split'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import {
  buildVarietyPlan,
  resolvedName,
  varietyKey,
  type VarietyDecision,
  type VarietyNameRef,
  type VarietyPlan,
  type VarietyPlanItem,
} from '@/lib/variety-resolution'
import { classifyPlantingRow, varietyAdditions, type PlantingRowClass } from '@/lib/planting-import'
import type { Crop, Field, FieldPlanting } from '@/lib/types'

type Props = {
  fields: Field[]
  crops: Crop[]
  existingPlantings: FieldPlanting[]
  /** Distinct existing variety names per crop id (the resolution catalog). */
  existingVarietiesByCrop: Map<string, string[]>
  /** Current variety names per planting id — drives the Update classification
   *  (a row whose variety isn't on the planting yet is an Update, not
   *  Unchanged) and the added-on-save set. */
  existingVarietiesByPlanting: Map<string, string[]>
  /** "Keep both" dismissals per crop id (dismissalKey sets) — a dismissed pair
   *  never re-prompts as a possible match. */
  dismissedPairsByCrop: Map<string, Set<string>>
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

export default function PlantingsAiImport({ fields, crops, existingPlantings, existingVarietiesByCrop, existingVarietiesByPlanting, dismissedPairsByCrop, defaultYear, fieldLabel, onImported }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  // Possible-match choices, keyed `${crop_id}|${varietyKey}` so one decision
  // covers every row mentioning that variety for that crop.
  const [varietyDecisions, setVarietyDecisions] = useState<Record<string, VarietyDecision>>({})

  // Per-crop resolution of EVERY extracted variety against the crop's existing
  // names — regardless of the row's New/Update/Unchanged classification — with
  // within-file collapse: format variants across rows share one plan item, so a
  // new variety is created once under its first-seen spelling. "Keep both"
  // dismissals silence their pairs.
  const varietyPlans = useMemo(() => {
    const refsByCrop = new Map<string, VarietyNameRef[]>()
    rows.forEach((r, i) => {
      if (!r.crop_id) return
      for (const v of r.varieties) {
        if (!v.variety.trim()) continue
        const list = refsByCrop.get(r.crop_id) ?? []
        list.push({ rowIndex: i, name: v.variety })
        refsByCrop.set(r.crop_id, list)
      }
    })
    const plans = new Map<string, VarietyPlan>()
    for (const [cropId, refs] of refsByCrop) {
      plans.set(cropId, buildVarietyPlan(refs, existingVarietiesByCrop.get(cropId) ?? [], dismissedPairsByCrop.get(cropId)))
    }
    return plans
  }, [rows, existingVarietiesByCrop, dismissedPairsByCrop])

  function varietyItemFor(cropId: string, name: string): VarietyPlanItem | null {
    if (!cropId || !name.trim()) return null
    return varietyPlans.get(cropId)?.items.find((it) => it.key === varietyKey(name)) ?? null
  }

  /** Final stored name for a variety mention; null while a possible match is undecided. */
  function finalVarietyName(cropId: string, name: string): string | null {
    const item = varietyItemFor(cropId, name)
    if (!item) return name.trim()
    return resolvedName(item, varietyDecisions[`${cropId}|${item.key}`])
  }

  function rowVarietiesResolved(r: Row): boolean {
    return r.varieties.every((v) => !v.variety.trim() || finalVarietyName(r.crop_id, v.variety) != null)
  }

  const varietyTotals = useMemo(() => {
    const t = { matched: 0, possible: 0, created: 0 }
    for (const plan of varietyPlans.values()) {
      t.matched += plan.matched
      t.possible += plan.possible
      t.created += plan.created
    }
    return t
  }, [varietyPlans])

  // Existing plantings keyed by field|crop|year, so a re-import updates the match
  // instead of inserting a duplicate.
  const existingByKey = useMemo(
    () => new Map(existingPlantings.map((p) => [`${p.field_id}|${p.crop_id}|${p.season_year}`, p])),
    [existingPlantings],
  )

  // Classify a row vs existing plantings — scalars AND varieties (a row whose
  // variety the planting doesn't carry yet is an Update, never Unchanged; only
  // values the row actually has count toward "changed"). Variety names compare
  // by resolved name where decided, raw spelling otherwise — the key-based
  // comparison is stable either way.
  function rowStatus(r: Row): PlantingRowClass & { existingId: string | null } {
    if (!r.field_id || !r.crop_id || !r.season_year) {
      return { kind: 'new', scalarChanged: false, varietyAdds: [], existingId: null }
    }
    const existing = existingByKey.get(`${r.field_id}|${r.crop_id}|${r.season_year}`)
    const cls = classifyPlantingRow(
      {
        planted_acres: num(r.planted_acres),
        irrigated_acres: num(r.irrigated_acres),
        planting_date: r.planting_date,
        notes: r.notes,
        varietyNames: r.varieties
          .filter((v) => v.variety.trim())
          .map((v) => finalVarietyName(r.crop_id, v.variety) ?? v.variety.trim()),
      },
      existing
        ? {
            planted_acres: Number(existing.planted_acres),
            irrigated_acres: Number(existing.irrigated_acres) || 0,
            planting_date: existing.planting_date ?? null,
            notes: existing.notes ?? null,
            varietyNames: existingVarietiesByPlanting.get(existing.id) ?? [],
          }
        : null,
    )
    return { ...cls, existingId: existing?.id ?? null }
  }

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
      const extracted: PlantingExtraction[] = []
      if (src.kind === 'pdf') {
        let batches: File[] = [src.file]
        try { batches = await splitPdfIntoBatches(src.file, 4) } catch { batches = [src.file] }
        for (let i = 0; i < batches.length; i++) {
          setStage(batches.length > 1 ? `Extracting plantings (batch ${i + 1} of ${batches.length})…` : 'Extracting plantings…')
          const data = await parseDocument(batches[i], 'plantings')
          if (Array.isArray(data.plantings)) extracted.push(...data.plantings)
        }
      } else {
        setStage('Extracting plantings…')
        const data = await parseDocument(src.images, 'plantings')
        if (Array.isArray(data.plantings)) extracted.push(...data.plantings)
      }
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
        const varietiesRaw = Array.isArray(p.varieties) ? p.varieties : []
        const varieties: RowVariety[] = varietiesRaw
          .map((v) => ({
            variety: (v.variety ?? '').toString().trim(),
            acres: numStr(v.acres),
          }))
          .filter((v) => v.variety !== '')
        const row: Row = {
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
          include: true,
        }
        // Default to NOT importing rows that exactly match an existing planting.
        return { ...row, include: rowStatus(row).kind !== 'unchanged' }
      })
      setRows(next)
      setBanner(`AI extracted ${next.length} planting${next.length === 1 ? '' : 's'}. Review and edit before saving.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else if (e?.message?.includes('504') || e?.message?.toLowerCase?.().includes('timeout')) {
        setErr('That file took too long to read in one pass. Try fewer rows at a time — or, for a spreadsheet, use the CSV importer above (faster and more accurate for tables).')
      } else setErr(e?.message ? `Couldn't read this document: ${e.message}.` : "Couldn't read this document.")
    } finally {
      setStage(null)
    }
  }

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
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
    setVarietyDecisions({})
  }

  // Both new AND update rows write varieties now, so an unresolved possible
  // match blocks any row that carries one.
  const toSave = rows.filter(
    (r) => r.include && rowReady(r) && rowStatus(r).kind !== 'unchanged' && rowVarietiesResolved(r),
  )
  const varietyBlocked = rows.filter(
    (r) => r.include && rowReady(r) && rowStatus(r).kind !== 'unchanged' && !rowVarietiesResolved(r),
  ).length

  async function saveAll() {
    setErr(null)
    if (toSave.length === 0) {
      setErr('Nothing to save. Each row needs a matched field, crop, season year, and planted acres — and must be new or changed.')
      return
    }
    setSaving(true)

    const newRows = toSave.filter((r) => rowStatus(r).kind === 'new')
    const updateRows = toSave.filter((r) => rowStatus(r).kind === 'update')

    // Inserts: new plantings + their varieties.
    let added = 0
    if (newRows.length > 0) {
      const payloads = newRows.map((r) => {
        const planted = num(r.planted_acres) ?? 0
        const irr = num(r.irrigated_acres) ?? 0
        return {
          field_id: r.field_id, crop_id: r.crop_id, season_year: Number(r.season_year),
          planted_acres: planted, irrigated_acres: irr, dryland_acres: Math.max(0, planted - irr),
          planting_date: r.planting_date || null, notes: r.notes.trim() || null,
        }
      })
      const { data: inserted, error } = await supabase.from('field_plantings').insert(payloads).select('id')
      if (error || !inserted) {
        setSaving(false); setErr(`Could not save: ${error?.message ?? 'unknown error'}`); return
      }
      added = inserted.length
      // Order preserved: map each inserted id back to its source row's varieties.
      const varietyInserts = inserted.flatMap((row, i) => {
        const src = newRows[i]
        if (!src) return []
        // Store the resolved canonical name, and coalesce mentions that resolve
        // to the same variety (two format variants on one row become one row).
        const byName = new Map<string, { variety: string; acres: number }>()
        for (const v of src.varieties) {
          if (!v.variety.trim()) continue
          const name = finalVarietyName(src.crop_id, v.variety) ?? v.variety.trim()
          const prior = byName.get(name)
          if (prior) prior.acres += num(v.acres) ?? 0
          else byName.set(name, { variety: name, acres: num(v.acres) ?? 0 })
        }
        return [...byName.values()].map((v) => ({ planting_id: row.id, variety: v.variety, acres: v.acres }))
      })
      if (varietyInserts.length > 0) {
        const { error: vErr } = await supabase.from('field_planting_varieties').insert(varietyInserts)
        if (vErr) { setSaving(false); setErr(`Plantings saved but varieties failed: ${vErr.message}`); onImported(); return }
      }
    }

    // Updates: patch only the provided, changed scalar fields of the matched
    // planting (preserve-existing) AND add any upload varieties the planting
    // doesn't carry yet (resolved names; existing variety rows are never
    // modified or removed).
    let updated = 0
    for (const r of updateRows) {
      const existing = existingByKey.get(`${r.field_id}|${r.crop_id}|${r.season_year}`)
      if (!existing) continue
      const planted = num(r.planted_acres)
      const irrProvided = r.irrigated_acres.trim() !== ''
      const irr = irrProvided ? (num(r.irrigated_acres) ?? 0) : (Number(existing.irrigated_acres) || 0)
      const effPlanted = planted ?? Number(existing.planted_acres)
      const patch: Record<string, unknown> = {}
      if (planted != null) patch.planted_acres = planted
      if (irrProvided) patch.irrigated_acres = irr
      if (planted != null || irrProvided) patch.dryland_acres = Math.max(0, effPlanted - irr)
      if (r.planting_date !== '') patch.planting_date = r.planting_date
      if (r.notes.trim() !== '') patch.notes = r.notes.trim()
      if (Object.keys(patch).length > 0) {
        const { error } = await supabase.from('field_plantings').update(patch).eq('id', existing.id)
        if (error) { setSaving(false); setErr(`Added ${added}, updated ${updated}; failed on a row: ${error.message}`); onImported(); return }
      }
      // Missing varieties (by normalized key, resolved names) — coalesce the
      // row's mentions per resolved name so two format variants land once.
      const resolved = new Map<string, { variety: string; acres: number }>()
      for (const v of r.varieties) {
        if (!v.variety.trim()) continue
        const name = finalVarietyName(r.crop_id, v.variety) ?? v.variety.trim()
        const prior = resolved.get(name)
        if (prior) prior.acres += num(v.acres) ?? 0
        else resolved.set(name, { variety: name, acres: num(v.acres) ?? 0 })
      }
      const adds = varietyAdditions([...resolved.keys()], existingVarietiesByPlanting.get(existing.id) ?? [])
      const varietyInserts = adds.map((name) => ({
        planting_id: existing.id,
        variety: name,
        acres: resolved.get(name)?.acres ?? 0,
      }))
      if (varietyInserts.length > 0) {
        const { error: vErr } = await supabase.from('field_planting_varieties').insert(varietyInserts)
        if (vErr) { setSaving(false); setErr(`Added ${added}, updated ${updated}; a variety failed to save: ${vErr.message}`); onImported(); return }
      }
      if (Object.keys(patch).length > 0 || varietyInserts.length > 0) updated++
    }

    setSaving(false)
    setBanner(`Saved — ${added} added, ${updated} updated.`)
    setRows([])
    setSource(null)
    setVarietyDecisions({})
    onImported()
  }

  // Resolution badge + controls under a variety input: matched shows the
  // canonical spelling it links to — and, on a row matched to an existing
  // planting, whether it's already on that planting or will be ADDED to it —
  // a possible match demands a choice (use the existing name or create as new —
  // never guessed), new announces creation.
  function varietyBadge(r: Row, v: RowVariety) {
    const item = varietyItemFor(r.crop_id, v.variety)
    if (!item) return null
    const dk = `${r.crop_id}|${item.key}`
    const d = varietyDecisions[dk]
    // Is this variety already on the matched planting (by normalized key)?
    const existingId = existingByKey.get(`${r.field_id}|${r.crop_id}|${r.season_year}`)?.id ?? null
    const onPlanting = existingId != null &&
      (existingVarietiesByPlanting.get(existingId) ?? []).some((n) => varietyKey(n) === item.key)
    const addNote = existingId != null && !onPlanting
      ? <span className="text-sky-700"> — will be added to this planting</span>
      : null
    if (item.resolution.status === 'matched') {
      const same = item.resolution.canonical === v.variety.trim()
      return (
        <div className="text-xs text-green-700">
          ✓ {onPlanting
            ? 'Already on this planting'
            : same
              ? <>Existing variety{addNote}</>
              : <>Matched existing: <span className="font-semibold">{item.resolution.canonical}</span>{addNote}</>}
        </div>
      )
    }
    if (item.resolution.status === 'new') {
      const saveAs = resolvedName(item, d) ?? item.name
      return (
        <div className="text-xs text-sky-700">
          New — will be created{saveAs !== v.variety.trim() && <> as “{saveAs}”</>}
        </div>
      )
    }
    const decided = resolvedName(item, d)
    return (
      <div className="text-xs space-y-0.5">
        <div className={decided == null ? 'text-amber-700 font-semibold' : 'text-slate-600'}>
          {decided == null ? 'Possible match — choose:' : <>Will save as <span className="font-semibold">“{decided}”</span></>}
        </div>
        <div className="flex flex-wrap gap-1">
          {item.resolution.candidates.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setVarietyDecisions((m) => ({ ...m, [dk]: { useExisting: c } }))}
              className={`rounded border px-1.5 py-0.5 ${d?.useExisting === c ? 'border-green-600 bg-green-50 text-green-800 font-semibold' : 'border-slate-300 bg-white'}`}
            >
              Use “{c}”
            </button>
          ))}
          <button
            type="button"
            onClick={() => setVarietyDecisions((m) => ({ ...m, [dk]: { useExisting: null } }))}
            className={`rounded border px-1.5 py-0.5 ${d && d.useExisting == null ? 'border-sky-600 bg-sky-50 text-sky-800 font-semibold' : 'border-slate-300 bg-white'}`}
          >
            Create as new
          </button>
        </div>
      </div>
    )
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
                  const status = rowStatus(r)
                  const unchanged = status.kind === 'unchanged'
                  const needsVarietyReview = ready && status.kind !== 'unchanged' && !rowVarietiesResolved(r)
                  return (
                    <tr key={i} className={`border-t border-slate-100 align-top ${unchanged ? 'opacity-60' : ''}`}>
                      <td className="px-2 py-1">
                        <input type="checkbox" checked={r.include} disabled={unchanged} onChange={(e) => setRow(i, { include: e.target.checked })} />
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {unchanged
                          ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">Unchanged</span>
                          : !ready
                            ? <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Needs review</span>
                            : needsVarietyReview
                              ? <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Variety review</span>
                              : status.kind === 'update'
                                ? <span className="text-xs rounded-full bg-sky-100 text-sky-800 px-2 py-0.5">Update</span>
                                : <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">New</span>}
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
                            <div key={vi} className="space-y-0.5">
                              <div className="grid grid-cols-[1fr_4.5rem_auto] gap-1 items-center">
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
                              {varietyBadge(r, v)}
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
            {(varietyTotals.matched > 0 || varietyTotals.possible > 0 || varietyTotals.created > 0) && (
              <span className="block text-xs text-slate-500 mt-0.5">
                Varieties: {varietyTotals.matched} matched · {varietyTotals.possible} possible match{varietyTotals.possible === 1 ? '' : 'es'}
                {varietyTotals.possible > 0 ? ' need review' : ''} · {varietyTotals.created} new will be created
                {varietyBlocked > 0 && (
                  <span className="text-amber-700 font-semibold"> — {varietyBlocked} row{varietyBlocked === 1 ? '' : 's'} blocked until resolved</span>
                )}
              </span>
            )}
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
