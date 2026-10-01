'use client'

// Cotton module — Seed Cotton Loads: the gin's module/load weight tickets.
// Yard inventory until they appear on a gin receipt. Manual entry mirrors the
// grain load form patterns (session-persistent crop year, farm → field
// cascade); AI upload parses Module List PDFs/photos (one load per page)
// through the shared /api/parse-document infra with the standard
// review-then-batch-save UX, and keeps each load's own page as its ticket.
// The list works like the grain Loads page: filters, sortable columns,
// select + bulk delete, exports, tap a row for the load's own page.

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, type CottonLoadsExtraction, type CottonLoadExtraction } from '@/lib/pdf-upload'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeCottonLoads } from '@/lib/parse-merge'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import ExportBar from '@/components/export-bar'
import { ConfirmDialog, NoticeDialog } from '@/components/app-dialog'
import { ReportFilterBar, SummaryCards, theadCls, fmtInt, fmtNum, type SummaryCardData } from '@/components/reports/report-kit'
import { yardInventoryByField } from '@/lib/cotton'
import {
  EMPTY_COTTON_FILTERS, filterCottonLoads, lbsPerRoll, rollsSummary, sortCottonLoads,
  type CottonLoadFilters, type CottonSortContext, type CottonSortKey,
} from '@/lib/cotton-loads'
import { documentsForLoads, fileToLoadDocument, insertCottonLoads, rollsNum, updateCottonLoad, uploadLoadDocument } from '@/lib/cotton-load-writes'
import {
  classificationSummary, classifyAgainstSaved, collapseExtractedLoads, loadNumberKey, reviewRolls,
  type LoadClassification, type ReviewLoad,
} from '@/lib/cotton-load-review'
import Link from 'next/link'
import { reportError } from '@/lib/friendly-error'
import { fmtDate } from '@/lib/format-date'
import type { ExportCell, ExportPayload } from '@/lib/exports'
import type { CottonLoad, Gin, Farm, Field, Entity } from '@/lib/types'

const lbs = (n: number | null | undefined) => (n == null ? '—' : fmtInt(Number(n)))
const num = (s: string): number | null => {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

type Draft = {
  load_number: string; entity_id: string; farm_id: string; field_id: string
  picked_date: string; delivered_date: string; truck: string
  gross_weight: string; tare_weight: string; rolls: string; gin_id: string; notes: string
}
const emptyDraft: Draft = {
  load_number: '', entity_id: '', farm_id: '', field_id: '', picked_date: '', delivered_date: '',
  truck: '', gross_weight: '', tare_weight: '', rolls: '', gin_id: '', notes: '',
}

// One review row per distinct load in the scan (lib/cotton-load-review):
// the pages it came from, the farm / field picks, whether it saves, and
// whether the user took a handwritten roll count over the printed one.
type AiRow = ReviewLoad & { farm_id: string; field_id: string; include: boolean; usedHandwritten: boolean }

export default function CottonLoadsPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [loads, setLoads] = useState<CottonLoad[]>([])
  const [gins, setGins] = useState<Gin[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [ginnedIds, setGinnedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [draftDoc, setDraftDoc] = useState<File | null>(null)
  // Hand entry of a load number that is already saved: blocked unless the
  // user chooses to update that load instead.
  const [updateExisting, setUpdateExisting] = useState(false)
  const [newGin, setNewGin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // AI review state
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [aiRows, setAiRows] = useState<AiRow[]>([])
  const [saving, setSaving] = useState(false)
  // Gin operators enter loads for the farm in front of them — they can't know
  // the entity, so the entity comes from the farm (hidden for that role).
  const [isGin, setIsGin] = useState(false)
  // List state — filters, sort, selection (grain Loads page conventions).
  const [filters, setFilters] = useState<CottonLoadFilters>(EMPTY_COTTON_FILTERS)
  const [sortKey, setSortKey] = useState<CottonSortKey>('delivered')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleteAsk, setDeleteAsk] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const { data } = await supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
      if (!cancelled) setIsGin((data as { role?: string } | null)?.role === 'gin')
    })()
    return () => { cancelled = true }
  }, [supabase])

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
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const ginById = useMemo(() => new Map(gins.map((g) => [g.id, g])), [gins])
  const yearLoads = useMemo(() => loads.filter((l) => l.crop_year === cropYear), [loads, cropYear])
  const draftFields = fields.filter((f) => !draft.farm_id || f.farm_id === draft.farm_id)

  const ctx: CottonSortContext = useMemo(() => ({
    farmName: (id) => (id ? farmById.get(id)?.name ?? '' : ''),
    fieldName: (id) => (id ? fieldById.get(id)?.name_or_number ?? '' : ''),
    ginName: (id) => (id ? ginById.get(id)?.name ?? '' : ''),
    ginned: (id) => ginnedIds.has(id),
  }), [farmById, fieldById, ginById, ginnedIds])

  // The saved load the hand-entry form's load number already names, if any.
  const draftExisting = useMemo(() => {
    const key = loadNumberKey(draft.load_number)
    return key ? yearLoads.find((l) => loadNumberKey(l.load_number) === key) ?? null : null
  }, [draft.load_number, yearLoads])
  useEffect(() => { setUpdateExisting(false) }, [draftExisting?.id])

  // Each scanned row against what is saved for the crop year: new / already
  // saved / update available (with the field diff).
  const aiClassified = useMemo(() => aiRows.map((r): LoadClassification => classifyAgainstSaved(r, yearLoads, r.crop_year ?? cropYear)), [aiRows, yearLoads, cropYear])
  const aiSummary = useMemo(() => classificationSummary(aiClassified), [aiClassified])

  const filtered = useMemo(() => filterCottonLoads(yearLoads, filters, ctx), [yearLoads, filters, ctx])
  const sorted = useMemo(() => sortCottonLoads(filtered, sortKey, sortDir, ctx), [filtered, sortKey, sortDir, ctx])
  const filterFields = fields.filter((f) => !filters.farmId || f.farm_id === filters.farmId)

  // Yard inventory: delivered but not on any gin receipt, by field.
  const yard = useMemo(() => yardInventoryByField(yearLoads, ginnedIds), [yearLoads, ginnedIds])
  const yardTotal = useMemo(() => Array.from(yard.values()).reduce((s, v) => s + v, 0), [yard])
  // Rolls (090): the year, what's on the yard, and what the filters show.
  const yearRolls = useMemo(() => rollsSummary(yearLoads), [yearLoads])
  const yardRolls = useMemo(() => rollsSummary(yearLoads.filter((l) => !ginnedIds.has(l.id))), [yearLoads, ginnedIds])
  const shownRolls = useMemo(() => rollsSummary(sorted), [sorted])

  async function ensureGin(name: string): Promise<string | null> {
    const existing = gins.find((g) => g.name.trim().toLowerCase() === name.trim().toLowerCase())
    if (existing) return existing.id
    const { data, error } = await supabase.from('gins').insert({ name: name.trim() }).select('id').single()
    if (error || !data) { setErr(reportError(error, { action: 'add the gin', noun: 'gin', name: name.trim() })); return null }
    return (data as { id: string }).id
  }

  async function addManual(e: React.FormEvent) {
    e.preventDefault()
    setErr(null); setMsg(null)
    if (!draft.load_number.trim()) { setErr('Load # is required.'); return }
    if (draft.rolls.trim() !== '' && rollsNum(draft.rolls) == null) { setErr('Rolls must be a whole number.'); return }
    let gin_id: string | null = draft.gin_id || null
    if (!gin_id && newGin.trim()) gin_id = await ensureGin(newGin)
    const gross = num(draft.gross_weight)
    const tare = num(draft.tare_weight)
    // Already saved this crop year: never a second row. Update it instead
    // when the user asked to, with only the fields they filled in.
    if (draftExisting) {
      if (!updateExisting) { setErr(`Load ${draftExisting.load_number} is already saved for ${cropYear}. Open it, or tick "Update that load" to change it.`); return }
      const patch: Record<string, unknown> = {}
      if (draft.entity_id) patch.entity_id = draft.entity_id
      if (draft.farm_id) { patch.farm_id = draft.farm_id; if (!draft.entity_id) patch.entity_id = farmById.get(draft.farm_id)?.entity_id ?? null }
      if (draft.field_id) patch.field_id = draft.field_id
      if (draft.picked_date) patch.picked_date = draft.picked_date
      if (draft.delivered_date) patch.delivered_date = draft.delivered_date
      if (draft.truck.trim()) patch.truck = draft.truck.trim()
      if (gross != null) patch.gross_weight = gross
      if (tare != null) patch.tare_weight = tare
      if (gross != null && tare != null) patch.net_weight = gross - tare
      else if (gross != null) patch.net_weight = gross
      if (draft.rolls.trim() !== '') patch.rolls = rollsNum(draft.rolls)
      if (gin_id) patch.gin_id = gin_id
      if (draft.notes.trim()) patch.notes = draft.notes.trim()
      if (draftDoc) {
        try { patch.source_pdf_url = await uploadLoadDocument(supabase, await fileToLoadDocument(draftDoc, `load-${draft.load_number.trim()}`)) }
        catch (e: any) { setErr(e?.message && /20 MB|photo of the ticket/.test(e.message) ? e.message : reportError(e, { action: 'store the ticket', noun: 'document' })); return }
      }
      if (Object.keys(patch).length === 0) { setErr('Nothing new to update — fill in the fields that changed.'); return }
      const { error } = await updateCottonLoad(supabase, draftExisting.id, patch)
      if (error) { setErr(reportError(error, { action: 'update the load', noun: 'load', name: draftExisting.load_number })); return }
      setDraft({ ...emptyDraft, entity_id: draft.entity_id, farm_id: draft.farm_id, field_id: draft.field_id, gin_id: draft.gin_id })
      setDraftDoc(null); setNewGin(''); setMsg(`Load ${draftExisting.load_number} updated.`); refresh()
      return
    }
    let source_pdf_url: string | null = null
    if (draftDoc) {
      try {
        source_pdf_url = await uploadLoadDocument(supabase, await fileToLoadDocument(draftDoc, `load-${draft.load_number.trim()}`))
      } catch (e: any) {
        setErr(e?.message && /20 MB|photo of the ticket/.test(e.message) ? e.message : reportError(e, { action: 'store the ticket', noun: 'document' }) + ' The load was not saved.')
        return
      }
    }
    const { error } = await insertCottonLoads(supabase, [{
      load_number: draft.load_number.trim(), crop_year: cropYear,
      entity_id: draft.entity_id || (draft.farm_id ? farmById.get(draft.farm_id)?.entity_id ?? null : null), farm_id: draft.farm_id || null, field_id: draft.field_id || null,
      picked_date: draft.picked_date || null, delivered_date: draft.delivered_date || null,
      truck: draft.truck.trim() || null, gross_weight: gross, tare_weight: tare,
      net_weight: gross != null && tare != null ? gross - tare : gross,
      rolls: rollsNum(draft.rolls),
      gin_id, notes: draft.notes.trim() || null, source: 'manual', source_pdf_url,
    }])
    if (error) { setErr(reportError(error, { action: 'save the load', noun: 'load', name: `${draft.load_number.trim()} (${cropYear})` })); return }
    setDraft({ ...emptyDraft, entity_id: draft.entity_id, farm_id: draft.farm_id, field_id: draft.field_id, gin_id: draft.gin_id })
    setDraftDoc(null); setNewGin(''); setMsg('Load saved.'); refresh()
  }

  function extractionToRow(x: ReviewLoad): AiRow {
    const farm = (x.farm_number ? farms.find((f) => (f.fsa_number ?? '').trim() === x.farm_number!.trim()) : null)
      ?? (x.producer ? findBestMatch(x.producer, farms, (f) => f.name) : null)
    const farmFields = fields.filter((f) => !farm || f.farm_id === farm.id)
    const field = x.field ? findBestMatch(x.field, farmFields, (f) => f.name_or_number) : null
    return { ...x, farm_id: farm?.id ?? '', field_id: field?.id ?? '', include: true, usedHandwritten: false }
  }

  async function onSource(src: DocumentSource) {
    setErr(null); setMsg(null); setSource(src); setAiRows([])
    setStage('Reading module tickets…')
    try {
      // Chunked parse: 4-page batches with per-chunk retry. Each load's page
      // number is rebased to the whole document, so the same load number on
      // two pages collapses into ONE review row that knows both pages.
      const { data, warning } = await parseDocumentChunked<CottonLoadsExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'cotton_weight_ticket',
        {
          pagesPerBatch: 4, onProgress: setStage, merge: mergeCottonLoads,
          rebase: (part, first) => ({ loads: (part.loads ?? []).map((l) => ({ ...l, page: l.page != null && Number.isFinite(Number(l.page)) ? Number(l.page) + first - 1 : null })) }),
        },
      )
      const extracted: CottonLoadExtraction[] = Array.isArray(data.loads) ? data.loads : []
      if (extracted.length === 0) { setErr(warning ?? 'No loads found in this document.'); return }
      if (warning) setErr(warning)
      const rows = collapseExtractedLoads(extracted)
      setAiRows(rows.map(extractionToRow))
      const twice = rows.filter((r) => r.pages.length > 1).length
      setMsg(`Read ${extracted.length} page${extracted.length === 1 ? '' : 's'} — ${rows.length} load${rows.length === 1 ? '' : 's'}${twice > 0 ? ` (${twice} scanned twice)` : ''}. Review and save.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(reportError(e, { action: 'read this document' }))
    } finally {
      setStage(null)
    }
  }

  async function saveAiRows() {
    setSaving(true); setErr(null)
    try {
      // New numbers insert; "update available" rows the user left ticked
      // update the saved load with the scan's values; "already saved" rows
      // never save again (a raw unique-constraint error is never reached).
      const picked = aiRows.map((r, i) => ({ r, i, c: aiClassified[i] })).filter(({ r, c }) => r.include && r.load_number && c.status !== 'saved')
      const inserts = picked.filter(({ c }) => c.status === 'new')
      const updates = picked.filter(({ c }) => c.status === 'update')
      if (picked.length === 0) { setErr(aiSummary.saved > 0 ? 'Every ticked load is already saved for this crop year.' : 'Nothing to save — tick at least one load.'); return }
      // Each load keeps its own ticket page(s) — stored first, so a load is
      // never saved without it.
      const docUrls = new Map<number, string>()
      if (source) {
        try {
          const docs = await documentsForLoads(source, picked.map(({ r }) => r.pages), setStage)
          let n = 0
          for (let k = 0; k < picked.length; k++) {
            const f = docs[k]
            if (!f) continue
            n += 1
            setStage(`Storing ticket ${n} of ${picked.length}…`)
            docUrls.set(picked[k].i, await uploadLoadDocument(supabase, f))
          }
        } catch (e: any) {
          setErr(reportError(e, { action: 'store the tickets', noun: 'document' }) + ' Nothing was saved — try again.')
          return
        } finally {
          setStage(null)
        }
      }
      const notesFor = (r: AiRow) => (r.handwritten_note ?? '').trim() || null
      if (inserts.length > 0) {
        const { error } = await insertCottonLoads(supabase, inserts.map(({ r, i }) => ({
          load_number: r.load_number!.trim(), crop_year: r.crop_year ?? cropYear,
          farm_id: r.farm_id || null, field_id: r.field_id || null,
          entity_id: r.farm_id ? farmById.get(r.farm_id)?.entity_id ?? null : null,
          picked_date: r.picked_date, delivered_date: r.delivered_date, truck: r.truck,
          gross_weight: r.gross_weight, tare_weight: r.tare_weight,
          net_weight: r.net_weight ?? (r.gross_weight != null && r.tare_weight != null ? r.gross_weight - r.tare_weight : null),
          rolls: rollsNum(r.rolls), notes: notesFor(r),
          source: 'document_import', source_pdf_url: docUrls.get(i) ?? null,
        })))
        if (error) { setErr(reportError(error, { action: 'save the loads', noun: 'load' })); return }
      }
      let updated = 0
      for (const { r, i, c } of updates) {
        if (c.status !== 'update') continue
        const patch: Record<string, unknown> = {}
        for (const d of c.diffs) {
          if (d.field === 'rolls') patch.rolls = rollsNum(r.rolls)
          else patch[d.field] = r[d.field] ?? null
        }
        if (patch.gross_weight != null || patch.tare_weight != null) {
          const g = (patch.gross_weight as number | undefined) ?? c.existing.gross_weight
          const t = (patch.tare_weight as number | undefined) ?? c.existing.tare_weight
          if (patch.net_weight == null && g != null && t != null) patch.net_weight = Number(g) - Number(t)
        }
        const note = notesFor(r)
        if (note) patch.notes = note
        if (r.farm_id) { patch.farm_id = r.farm_id; patch.entity_id = farmById.get(r.farm_id)?.entity_id ?? null }
        if (r.field_id) patch.field_id = r.field_id
        const doc = docUrls.get(i)
        if (doc) patch.source_pdf_url = doc
        const { error } = await updateCottonLoad(supabase, c.existing.id, patch)
        if (error) { setErr(reportError(error, { action: 'update the load', noun: 'load', name: c.existing.load_number })); return }
        updated += 1
      }
      setMsg(`Saved ${inserts.length} new load${inserts.length === 1 ? '' : 's'}${updated > 0 ? ` and updated ${updated}` : ''}${aiSummary.saved > 0 ? ` · ${aiSummary.saved} already saved, left alone` : ''}.`)
      setAiRows([]); setSource(null); refresh()
    } finally {
      setSaving(false)
    }
  }

  // ---- list actions ----
  function toggleSort(k: CottonSortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir(k === 'load' || k === 'farm' || k === 'field' || k === 'truck' || k === 'gin' ? 'asc' : 'desc') }
  }
  function toggleRow(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function toggleAllVisible() {
    setSelected((s) => {
      const ids = sorted.map((r) => r.id)
      const allOn = ids.every((id) => s.has(id))
      if (allOn) return new Set([...s].filter((id) => !ids.includes(id)))
      const n = new Set(s); ids.forEach((id) => n.add(id)); return n
    })
  }
  const selectedRows = () => sorted.filter((r) => selected.has(r.id))
  const deletable = () => selectedRows().filter((r) => !ginnedIds.has(r.id))
  const skippedGinned = () => selectedRows().length - deletable().length

  async function bulkDelete() {
    const ids = deletable().map((r) => r.id)
    if (ids.length === 0) { setDeleteAsk(false); return }
    setDeleting(true)
    const CHUNK = 50
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK)
      const { error } = await supabase.from('cotton_loads').delete().in('id', batch)
      if (error) {
        setDeleting(false); setDeleteAsk(false)
        setNotice({ title: 'Some loads weren’t deleted', body: `${i} of ${ids.length} loads were deleted before it stopped. ${reportError(error, { action: 'delete the rest', noun: 'load' })}` })
        setSelected(new Set()); refresh()
        return
      }
    }
    const skipped = skippedGinned()
    setDeleting(false); setDeleteAsk(false); setSelected(new Set()); refresh()
    if (skipped > 0) setNotice({ title: 'Ginned loads were kept', body: `${skipped} selected load${skipped === 1 ? ' is' : 's are'} already on a gin receipt, so ${skipped === 1 ? 'it was' : 'they were'} not deleted. Remove ${skipped === 1 ? 'it' : 'them'} from the receipt first.` })
  }

  const activeFilterCount = [filters.q, filters.farmId, filters.fieldId, filters.ginId, filters.status, filters.from, filters.to].filter(Boolean).length
  function filterSummary(count = sorted.length): string {
    const parts: string[] = [`${cropYear} crop`]
    if (filters.farmId) parts.push(ctx.farmName(filters.farmId) || 'Farm')
    if (filters.fieldId) parts.push(ctx.fieldName(filters.fieldId) || 'Field')
    if (filters.ginId) parts.push(ctx.ginName(filters.ginId) || 'Gin')
    if (filters.status) parts.push(filters.status === 'yard' ? 'on the yard' : 'ginned')
    if (filters.from || filters.to) parts.push(`delivered ${filters.from ? fmtDate(filters.from) : '…'} to ${filters.to ? fmtDate(filters.to) : '…'}`)
    if (filters.q) parts.push(`“${filters.q}”`)
    parts.push(`${count} load${count === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  function buildPayload(rowsToExport: CottonLoad[] = sorted, suffix = ''): ExportPayload {
    const s = rollsSummary(rowsToExport)
    return {
      title: 'Seed Cotton Loads',
      filters: filterSummary(rowsToExport.length),
      filename: `seed-cotton-loads${suffix}-${new Date().toISOString().slice(0, 10)}`,
      summary: [
        { label: 'Loads', value: fmtInt(s.loads) },
        { label: 'Net lbs', value: `${fmtInt(s.netLbs)} lbs` },
        { label: 'Rolls', value: fmtInt(s.rolls) },
        { label: 'Avg lbs / roll', value: s.avgLbsPerRoll != null ? fmtInt(s.avgLbsPerRoll) : '—' },
      ],
      sections: [{
        columns: [
          { label: 'Load #' }, { label: 'Farm' }, { label: 'Field' }, { label: 'Gin' }, { label: 'Picked' }, { label: 'Delivered' }, { label: 'Truck' },
          { label: 'Gross lbs', align: 'right', format: 'lbs' }, { label: 'Tare lbs', align: 'right', format: 'lbs' }, { label: 'Net lbs', align: 'right', format: 'lbs' },
          { label: 'Rolls', align: 'right', format: 'int' }, { label: 'Lbs / roll', align: 'right', format: 'int' }, { label: 'Status' }, { label: 'Notes' },
        ],
        rows: [
          ...rowsToExport.map((l): ExportCell[] => [
            l.load_number, ctx.farmName(l.farm_id), ctx.fieldName(l.field_id), ctx.ginName(l.gin_id),
            l.picked_date ? fmtDate(l.picked_date) : '', l.delivered_date ? fmtDate(l.delivered_date) : '', l.truck ?? '',
            l.gross_weight ?? '', l.tare_weight ?? '', l.net_weight ?? '', l.rolls ?? '',
            lbsPerRoll(l.net_weight, l.rolls) != null ? Math.round(lbsPerRoll(l.net_weight, l.rolls)!) : '',
            ginnedIds.has(l.id) ? { v: 'Ginned', tone: 'favorable' as const } : { v: 'On yard', tone: 'warning' as const },
            l.notes ?? '',
          ]),
          ['Totals', '', '', '', '', '', '', '', '', s.netLbs, s.rolls, s.avgLbsPerRoll != null ? Math.round(s.avgLbsPerRoll) : '', '', ''],
        ],
        rowMeta: [...rowsToExport.map(() => 'data' as const), 'total'],
      }],
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full'
  const labelCls = 'block text-sm text-slate-700'
  const filterSelect = 'rounded-lg border border-slate-300 px-3 min-h-11 bg-white text-base sm:text-sm'
  const filterLabel = 'flex flex-col gap-1 text-xs text-slate-600 min-w-[9rem] flex-1 sm:flex-none'
  const quietBtn = 'inline-flex items-center rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm'
  const years = useMemo(() => {
    const ys = new Set<number>([cropYear, new Date().getFullYear(), ...loads.map((l) => l.crop_year)])
    return [...ys].sort((a, b) => b - a)
  }, [loads, cropYear])

  const summaryCards: SummaryCardData[] = [
    { label: `${cropYear} loads`, value: fmtInt(yearRolls.loads), sub: `${fmtInt(yearRolls.netLbs)} lbs seed cotton` },
    { label: 'Rolls', value: yearRolls.rolls > 0 ? fmtInt(yearRolls.rolls) : '—', sub: yearRolls.loadsWithRolls < yearRolls.loads && yearRolls.loads > 0 ? `${fmtInt(yearRolls.loads - yearRolls.loadsWithRolls)} load${yearRolls.loads - yearRolls.loadsWithRolls === 1 ? '' : 's'} without a roll count` : 'every load counted' },
    { label: 'Avg lbs per roll', value: yearRolls.avgLbsPerRoll != null ? fmtInt(yearRolls.avgLbsPerRoll) : '—', sub: yearRolls.avgLbsPerRoll != null ? `${fmtInt(yearRolls.netLbsWithRolls)} lbs ÷ ${fmtInt(yearRolls.rolls)} rolls` : 'enter rolls on the loads to see this', tone: 'neutral' },
    { label: 'On the yard', value: `${fmtInt(yardTotal)} lbs`, sub: yardRolls.rolls > 0 ? `${fmtInt(yardRolls.rolls)} rolls waiting${yardRolls.avgLbsPerRoll != null ? ` · ${fmtInt(yardRolls.avgLbsPerRoll)} lbs/roll` : ''}` : 'awaiting the gin', tone: yardTotal > 0 ? 'warning' : 'muted' },
  ]

  const nothingYet = !loading && yearLoads.length === 0
  const nothingMatches = !loading && yearLoads.length > 0 && sorted.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-bold flex-1">Seed Cotton Loads</h1>
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year</span>
          <select value={cropYear} onChange={(e) => { setCropYear(Number(e.target.value)); setSelected(new Set()) }} className={inputCls}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      </div>

      <SummaryCards cards={summaryCards} />

      {/* Yard inventory — delivered but not yet on a gin receipt. */}
      <section className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">Yard Inventory <span className="text-sm font-normal text-slate-500">seed cotton delivered, awaiting gin</span></h2>
        {yardTotal === 0 ? (
          <p className="text-sm text-slate-400">Nothing on the yard — every {cropYear} load is on a gin receipt.</p>
        ) : (
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 font-semibold">{lbs(yardTotal)} lbs total{yardRolls.rolls > 0 ? ` · ${fmtInt(yardRolls.rolls)} rolls` : ''}</span>
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
        <h2 className="font-semibold">Upload a module list</h2>
        <p className="text-sm text-slate-500">PDF or photos of the gin&apos;s module/load tickets — one load per page. Review before saving. Each load keeps its own page as its ticket.</p>
        <DocumentCapture onSource={onSource} busy={stage != null} stageLabel={stage} pdfLabel="Upload module list PDF or photo" />
        {aiRows.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="text-slate-500"><tr>{['', 'Load #', 'Farm', 'Field', 'Picked', 'Delivered', 'Truck', 'Rolls', 'Gross', 'Tare', 'Net', 'Lbs/roll'].map((h) => <th key={h} className="text-left px-1 py-1">{h}</th>)}</tr></thead>
                <tbody>
                  {aiRows.map((r, i) => {
                    const c = aiClassified[i]
                    const rr = reviewRolls(r)
                    const rowCls = r.pageConflict ? 'bg-red-50' : c.status === 'saved' ? 'bg-slate-50 text-slate-500' : c.status === 'update' ? 'bg-amber-50' : ''
                    return (
                    <tr key={i} className={`border-t border-slate-100 align-top ${rowCls}`}>
                      <td className="px-1 py-1"><input type="checkbox" className="h-5 w-5" checked={r.include && c.status !== 'saved'} disabled={c.status === 'saved'} onChange={(e) => setAiRows((xs) => xs.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} aria-label={`Save load ${r.load_number ?? i + 1}`} /></td>
                      <td className="px-1 py-1 font-mono">
                        {r.load_number ?? '—'}
                        {r.pages.length > 1 && <span className="block font-sans text-[10px] rounded bg-sky-100 text-sky-800 px-1 py-0.5 mt-0.5 whitespace-nowrap">appears twice in this scan (pages {r.pages.slice(0, -1).join(', ')} and {r.pages[r.pages.length - 1]})</span>}
                        {r.pageConflict && <span className="block font-sans text-[10px] rounded bg-red-100 text-red-800 px-1 py-0.5 mt-0.5">pages disagree: {r.pageConflict} — check</span>}
                        {c.status === 'saved' && <span className="block font-sans text-[10px] rounded bg-slate-200 text-slate-700 px-1 py-0.5 mt-0.5 whitespace-nowrap">Already saved · <Link href={`/cotton/loads/${c.existing.id}`} className="underline">open</Link></span>}
                        {c.status === 'update' && (
                          <span className="block font-sans text-[10px] rounded bg-amber-100 text-amber-900 px-1 py-0.5 mt-0.5">
                            Update available · <Link href={`/cotton/loads/${c.existing.id}`} className="underline">open</Link>
                            {c.diffs.map((d) => <span key={d.field} className="block">{d.label}: {d.saved} → <b>{d.scanned}</b></span>)}
                          </span>
                        )}
                        {r.sequence_mark && <span className="block font-sans text-[10px] text-slate-400 mt-0.5">mark {r.sequence_mark} (sequence, not rolls)</span>}
                      </td>
                      <td className="px-1 py-1">
                        <select value={r.farm_id} onChange={(e) => setAiRows((xs) => xs.map((x, j) => j === i ? { ...x, farm_id: e.target.value, field_id: '' } : x))} className="rounded border border-slate-300 px-1 py-0.5 min-h-9">
                          <option value="">— farm —</option>
                          {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        {!r.farm_id && r.producer && <div className="text-amber-700">From the document: {r.producer}{r.farm_number ? ` #${r.farm_number}` : ''}</div>}
                      </td>
                      <td className="px-1 py-1">
                        <select value={r.field_id} onChange={(e) => setAiRows((xs) => xs.map((x, j) => j === i ? { ...x, field_id: e.target.value } : x))} className="rounded border border-slate-300 px-1 py-0.5 min-h-9">
                          <option value="">— field —</option>
                          {fields.filter((f) => !r.farm_id || f.farm_id === r.farm_id).map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
                        </select>
                        {!r.field_id && r.field && <div className="text-amber-700">From the document: {r.field}</div>}
                      </td>
                      <td className="px-1 py-1">{r.picked_date ? fmtDate(r.picked_date) : '—'}</td>
                      <td className="px-1 py-1">{r.delivered_date ? fmtDate(r.delivered_date) : '—'}</td>
                      <td className="px-1 py-1">{r.truck ?? '—'}</td>
                      <td className="px-1 py-1">
                        <input
                          type="number" inputMode="numeric" step="1" min="0"
                          value={r.rolls ?? ''}
                          onChange={(e) => setAiRows((xs) => xs.map((x, j) => j === i ? { ...x, rolls: rollsNum(e.target.value), usedHandwritten: false } : x))}
                          className="rounded border border-slate-300 px-1 py-0.5 w-16 text-right min-h-9"
                          aria-label={`Rolls on load ${r.load_number ?? i + 1}`}
                        />
                        {/* A handwritten count that differs from the printed one:
                            shown, never picked for the user. One tap takes it. */}
                        {rr.chip && !r.usedHandwritten && (
                          <span className="block mt-0.5 rounded bg-amber-100 text-amber-900 px-1 py-0.5 text-[10px] max-w-[14rem]">
                            {rr.chip}{' '}
                            <button type="button" onClick={() => setAiRows((xs) => xs.map((x, j) => j === i ? { ...x, rolls: rr.handwritten, usedHandwritten: true } : x))} className="underline font-semibold min-h-6">Use {rr.handwritten}</button>
                          </span>
                        )}
                        {r.usedHandwritten && <span className="block mt-0.5 text-[10px] text-amber-800">handwritten count used · printed {rr.printed ?? '—'}</span>}
                        {r.handwritten_note && !rr.chip && <span className="block mt-0.5 text-[10px] text-slate-500">note: {r.handwritten_note}</span>}
                      </td>
                      <td className="px-1 py-1 text-right">{lbs(r.gross_weight)}</td>
                      <td className="px-1 py-1 text-right">{lbs(r.tare_weight)}</td>
                      <td className="px-1 py-1 text-right font-semibold">{lbs(r.net_weight)}</td>
                      <td className="px-1 py-1 text-right text-slate-500">{lbsPerRoll(r.net_weight, r.rolls) != null ? fmtInt(lbsPerRoll(r.net_weight, r.rolls)) : '—'}</td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={saveAiRows} disabled={saving} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">
                {saving ? (stage ?? 'Saving…') : `Save ${aiRows.filter((r, i) => r.include && aiClassified[i].status === 'new').length} new${aiRows.filter((r, i) => r.include && aiClassified[i].status === 'update').length > 0 ? ` · update ${aiRows.filter((r, i) => r.include && aiClassified[i].status === 'update').length}` : ''}`}
              </button>
              <span className="text-sm text-slate-600">{aiSummary.text}</span>
              {aiRows.some((r) => r.pageConflict) && <span className="text-sm text-red-700">Pages that disagree are marked in red — check the weights before saving.</span>}
            </div>
          </>
        )}
      </section>

      {/* Manual entry */}
      <form onSubmit={addManual} className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">Add a load by hand</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <label className={labelCls}>
            Load #
            <input value={draft.load_number} onChange={(e) => setDraft({ ...draft, load_number: e.target.value })} className={`${inputCls} mt-1 ${draftExisting && !updateExisting ? 'border-amber-400 bg-amber-50' : ''}`} aria-describedby={draftExisting ? 'draft-existing' : undefined} />
          </label>
          {draftExisting && (
            <div id="draft-existing" className="col-span-2 sm:col-span-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex flex-wrap items-center gap-x-3 gap-y-1" role="status">
              <span>
                Load <b>{draftExisting.load_number}</b> is already saved ({draftExisting.delivered_date ? fmtDate(draftExisting.delivered_date) : draftExisting.picked_date ? fmtDate(draftExisting.picked_date) : 'no date'}, {draftExisting.net_weight != null ? `${fmtInt(draftExisting.net_weight)} lbs` : 'no weight'}{draftExisting.rolls != null ? `, ${draftExisting.rolls} rolls` : ''}).{' '}
                <Link href={`/cotton/loads/${draftExisting.id}`} className="underline font-semibold">Open it?</Link>
              </span>
              <label className="inline-flex items-center gap-2 min-h-8">
                <input type="checkbox" className="h-5 w-5" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
                Update that load with what I fill in here
              </label>
            </div>
          )}
          {!isGin && entities.length > 1 && (
            <label className={labelCls}>
              Entity
              <select value={draft.entity_id} onChange={(e) => setDraft({ ...draft, entity_id: e.target.value })} className={`${inputCls} mt-1`}>
                <option value="">— from the farm —</option>
                {entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
          <label className={labelCls}>
            Farm
            <select value={draft.farm_id} onChange={(e) => setDraft({ ...draft, farm_id: e.target.value, field_id: '' })} className={`${inputCls} mt-1`}>
              <option value="">—</option>
              {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Field
            <select value={draft.field_id} onChange={(e) => setDraft({ ...draft, field_id: e.target.value })} className={`${inputCls} mt-1`}>
              <option value="">—</option>
              {draftFields.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Picked
            <input type="date" value={draft.picked_date} onChange={(e) => setDraft({ ...draft, picked_date: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Delivered
            <input type="date" value={draft.delivered_date} onChange={(e) => setDraft({ ...draft, delivered_date: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Truck
            <input value={draft.truck} onChange={(e) => setDraft({ ...draft, truck: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Gin
            <select value={draft.gin_id} onChange={(e) => setDraft({ ...draft, gin_id: e.target.value })} className={`${inputCls} mt-1`}>
              <option value="">—</option>
              {gins.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Gross lbs
            <input type="number" inputMode="numeric" step="1" value={draft.gross_weight} onChange={(e) => setDraft({ ...draft, gross_weight: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Tare lbs
            <input type="number" inputMode="numeric" step="1" value={draft.tare_weight} onChange={(e) => setDraft({ ...draft, tare_weight: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Rolls <span className="text-slate-400">(round modules on the load)</span>
            <input type="number" inputMode="numeric" step="1" min="0" value={draft.rolls} onChange={(e) => setDraft({ ...draft, rolls: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            New gin name <span className="text-slate-400">(if not listed)</span>
            <input value={newGin} onChange={(e) => setNewGin(e.target.value)} className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Notes
            <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Ticket photo or PDF <span className="text-slate-400">(optional)</span>
            <input type="file" accept="application/pdf,.pdf,image/*" onChange={(e) => setDraftDoc(e.target.files?.[0] ?? null)} className={`${inputCls} mt-1 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1`} />
          </label>
        </div>
        {(num(draft.gross_weight) != null && num(draft.tare_weight) != null) && (
          <p className="text-sm text-slate-500">
            Net: <b>{lbs(num(draft.gross_weight)! - num(draft.tare_weight)!)}</b> lbs seed cotton
            {rollsNum(draft.rolls) != null && rollsNum(draft.rolls)! > 0 && <> · <b>{fmtInt((num(draft.gross_weight)! - num(draft.tare_weight)!) / rollsNum(draft.rolls)!)}</b> lbs per roll</>}
          </p>
        )}
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50" disabled={!!draftExisting && !updateExisting}>
          {draftExisting ? (updateExisting ? `Update load ${draftExisting.load_number}` : 'Already saved') : 'Add load'}
        </button>
      </form>

      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}

      {/* Load list — filters, sort, select, export, delete; tap a row to open it. */}
      <ReportFilterBar activeCount={activeFilterCount}>
        <label className={`${filterLabel} sm:min-w-[14rem]`}>
          Search
          <input type="search" placeholder="Load #, truck, farm, field, gin…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} className={filterSelect} />
        </label>
        <label className={filterLabel}>
          Farm
          <select value={filters.farmId} onChange={(e) => setFilters({ ...filters, farmId: e.target.value, fieldId: '' })} className={filterSelect}>
            <option value="">All farms</option>
            {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label className={filterLabel}>
          Field
          <select value={filters.fieldId} onChange={(e) => setFilters({ ...filters, fieldId: e.target.value })} className={filterSelect}>
            <option value="">All fields</option>
            {filterFields.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
          </select>
        </label>
        <label className={filterLabel}>
          Gin
          <select value={filters.ginId} onChange={(e) => setFilters({ ...filters, ginId: e.target.value })} className={filterSelect}>
            <option value="">All gins</option>
            {gins.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label className={filterLabel}>
          Status
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as CottonLoadFilters['status'] })} className={filterSelect}>
            <option value="">On yard + ginned</option>
            <option value="yard">On the yard</option>
            <option value="ginned">Ginned</option>
          </select>
        </label>
        <label className={filterLabel}>
          Delivered from
          <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} className={filterSelect} />
        </label>
        <label className={filterLabel}>
          Delivered to
          <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} className={filterSelect} />
        </label>
        {activeFilterCount > 0 && (
          <button type="button" onClick={() => setFilters(EMPTY_COTTON_FILTERS)} className={`${quietBtn} self-end`}>Clear filters</button>
        )}
      </ReportFilterBar>

      {sorted.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-500 flex-1">
            {filterSummary()}{shownRolls.rolls > 0 ? ` · ${fmtInt(shownRolls.rolls)} rolls · ${fmtInt(shownRolls.avgLbsPerRoll ?? 0)} lbs/roll` : ''}
          </span>
          <ExportBar buildPayload={() => buildPayload()} formats={['xlsx', 'pdf', 'csv', 'print']} />
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <span className="font-semibold">{selected.size} selected</span>
          <ExportBar buildPayload={() => buildPayload(selectedRows(), '-selected')} formats={['xlsx', 'csv']} size="sm" />
          <button type="button" onClick={() => setDeleteAsk(true)} className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 min-h-11 text-sm font-semibold">Delete selected</button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-slate-600 min-h-11 px-2">Clear selection</button>
        </div>
      )}

      {nothingYet ? (
        <div className="bg-white rounded-xl shadow p-8 text-center text-slate-500">No {cropYear} seed cotton loads yet. Upload a module list or add one by hand above.</div>
      ) : nothingMatches ? (
        <div className="bg-white rounded-xl shadow p-8 text-center space-y-3">
          <p className="text-slate-600 font-medium">No loads match these filters.</p>
          <button type="button" onClick={() => setFilters(EMPTY_COTTON_FILTERS)} className={`${quietBtn} font-semibold text-brand-deep`}>Clear filters</button>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-500">Tap any load to see its details and ticket. Tap a rolls figure to change it in place.</p>
          <div className="overflow-x-auto bg-white rounded-xl shadow">
            <table className="min-w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className="px-2 py-1 w-11">
                    <label className="flex items-center justify-center min-h-11 min-w-11 cursor-pointer">
                      <input type="checkbox" aria-label="Select all loads shown" className="h-5 w-5" checked={sorted.length > 0 && sorted.every((r) => selected.has(r.id))} onChange={toggleAllVisible} />
                    </label>
                  </th>
                  <SortTh onClick={() => toggleSort('load')} active={sortKey === 'load'} dir={sortDir}>Load #</SortTh>
                  <SortTh onClick={() => toggleSort('farm')} active={sortKey === 'farm'} dir={sortDir}>Farm</SortTh>
                  <SortTh onClick={() => toggleSort('field')} active={sortKey === 'field'} dir={sortDir}>Field</SortTh>
                  <SortTh onClick={() => toggleSort('picked')} active={sortKey === 'picked'} dir={sortDir} className="hidden md:table-cell">Picked</SortTh>
                  <SortTh onClick={() => toggleSort('delivered')} active={sortKey === 'delivered'} dir={sortDir}>Delivered</SortTh>
                  <SortTh onClick={() => toggleSort('truck')} active={sortKey === 'truck'} dir={sortDir}>Truck</SortTh>
                  <SortTh onClick={() => toggleSort('gin')} active={sortKey === 'gin'} dir={sortDir} className="hidden md:table-cell">Gin</SortTh>
                  <SortTh onClick={() => toggleSort('rolls')} active={sortKey === 'rolls'} dir={sortDir} align="right">Rolls</SortTh>
                  <SortTh onClick={() => toggleSort('net')} active={sortKey === 'net'} dir={sortDir} align="right">Net lbs</SortTh>
                  <SortTh onClick={() => toggleSort('perRoll')} active={sortKey === 'perRoll'} dir={sortDir} align="right">Lbs/roll</SortTh>
                  <SortTh onClick={() => toggleSort('status')} active={sortKey === 'status'} dir={sortDir}>Status</SortTh>
                  <th className="px-2 py-1 text-left whitespace-nowrap">Ticket</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={13} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
                {sorted.map((l) => {
                  const perRoll = lbsPerRoll(l.net_weight, l.rolls)
                  return (
                    <Fragment key={l.id}>
                      <tr
                        onClick={() => router.push(`/cotton/loads/${l.id}`)}
                        className={`border-t border-slate-100 cursor-pointer hover:bg-slate-50 ${selected.has(l.id) ? 'bg-sky-50 hover:bg-sky-100' : ''}`}
                      >
                        <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                          <label className="flex items-center justify-center min-h-11 min-w-11 cursor-pointer">
                            <input type="checkbox" aria-label={`Select load ${l.load_number}`} className="h-5 w-5" checked={selected.has(l.id)} onChange={() => toggleRow(l.id)} />
                          </label>
                        </td>
                        <td className="px-3 py-2 font-mono font-semibold text-brand-deep">{l.load_number}</td>
                        <td className="px-3 py-2">{ctx.farmName(l.farm_id) || '—'}</td>
                        <td className="px-3 py-2">{ctx.fieldName(l.field_id) || '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap hidden md:table-cell">{l.picked_date ? fmtDate(l.picked_date) : '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{l.delivered_date ? fmtDate(l.delivered_date) : '—'}</td>
                        <td className="px-3 py-2">{l.truck ?? '—'}</td>
                        <td className="px-3 py-2 hidden md:table-cell">{ctx.ginName(l.gin_id) || '—'}</td>
                        <td className="px-1 py-1 text-right tabular-nums" onClick={(e) => e.stopPropagation()}>
                          <RollsCell load={l} onSaved={refresh} onError={setErr} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{lbs(l.net_weight)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">{perRoll != null ? fmtInt(perRoll) : '—'}</td>
                        <td className="px-3 py-2">
                          {ginnedIds.has(l.id)
                            ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">ginned</span>
                            : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">on yard</span>}
                        </td>
                        <td className="px-2 py-1 text-xs">
                          {l.source_pdf_url
                            ? <span className="text-slate-600">on file</span>
                            : <span className="text-slate-400">none</span>}
                        </td>
                      </tr>
                    </Fragment>
                  )
                })}
                {sorted.length > 0 && (
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                    <td className="px-3 py-2" colSpan={8}>{sorted.length} load{sorted.length === 1 ? '' : 's'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{shownRolls.rolls > 0 ? fmtInt(shownRolls.rolls) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtInt(shownRolls.netLbs)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{shownRolls.avgLbsPerRoll != null ? fmtInt(shownRolls.avgLbsPerRoll) : '—'}</td>
                    <td colSpan={2} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ConfirmDialog
        open={deleteAsk}
        title={`Delete ${deletable().length} load${deletable().length === 1 ? '' : 's'}?`}
        body={
          <div className="space-y-1">
            <p>This can’t be undone. Yard inventory and cotton yields will recalculate without {deletable().length === 1 ? 'it' : 'them'}.</p>
            {skippedGinned() > 0 && <p className="text-amber-800">{skippedGinned()} selected load{skippedGinned() === 1 ? ' is' : 's are'} already on a gin receipt and will be kept.</p>}
          </div>
        }
        confirmLabel={`Delete ${deletable().length}`}
        danger
        busy={deleting}
        onConfirm={() => void bulkDelete()}
        onCancel={() => { if (!deleting) setDeleteAsk(false) }}
      />
      <NoticeDialog open={notice != null} title={notice?.title ?? ''} body={notice?.body} onClose={() => setNotice(null)} />
    </div>
  )
}

function SortTh({ children, onClick, active, dir, align = 'left', className = '' }: {
  children: React.ReactNode
  onClick: () => void
  active: boolean
  dir: 'asc' | 'desc'
  align?: 'left' | 'right'
  className?: string
}) {
  const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`px-1 py-0 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <button type="button" onClick={onClick} className={`w-full min-h-11 px-2 rounded hover:bg-slate-200 font-semibold ${align === 'right' ? 'text-right' : 'text-left'} ${active ? 'text-slate-900' : ''}`}>
        {children}{arrow}
      </button>
    </th>
  )
}

// Rolls on a saved load (090): shown as a number, tap to edit in place — the
// count usually arrives after the load (the gin's ticket, or a recount).
function RollsCell({ load, onSaved, onError }: { load: CottonLoad; onSaved: () => void; onError: (m: string | null) => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(load.rolls != null ? String(load.rolls) : '')
  useEffect(() => { setVal(load.rolls != null ? String(load.rolls) : '') }, [load.rolls])

  async function commit() {
    setEditing(false)
    const next = rollsNum(val)
    if (val.trim() !== '' && next == null) { onError('Rolls must be a whole number.'); setVal(load.rolls != null ? String(load.rolls) : ''); return }
    if (next === (load.rolls ?? null)) return
    const { error } = await updateCottonLoad(supabase, load.id, { rolls: next })
    if (error) { onError(reportError(error, { action: 'save the rolls', noun: 'load', name: load.load_number })); return }
    onError(null)
    onSaved()
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="min-h-11 min-w-11 px-2 rounded-lg hover:bg-slate-100 text-right w-full" aria-label={`Rolls on load ${load.load_number}: ${load.rolls ?? 'not recorded'}. Tap to edit.`}>
        {load.rolls != null ? fmtInt(load.rolls) : <span className="text-slate-400">—</span>}
      </button>
    )
  }
  return (
    <input
      type="number" inputMode="numeric" step="1" min="0" autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commit() } if (e.key === 'Escape') { setEditing(false); setVal(load.rolls != null ? String(load.rolls) : '') } }}
      className="rounded-lg border border-slate-300 px-2 min-h-11 w-20 text-right"
      aria-label={`Rolls on load ${load.load_number}`}
    />
  )
}
