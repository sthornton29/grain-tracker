'use client'

// Cotton module — Gin Receipts (Statements of Ginning). Multiple receipts per
// field allowed. The AI upload reads the PDF page by page; lib/gin-statements
// groups the pages into statements (one PDF can hold several), and each
// statement gets its own review card: load lines matched to Seed Cotton Loads
// through the one cotton number key (lib/gin-receipt-matching — "031633" and
// "31633" are one load; weights corroborate; suggestions, never auto-links,
// when a tick mark changed a number), the bale list against saved bales
// (pbiReview), the stated-vs-captured bale count, the statement identity
// (gin + farm # + field + date + totals — "Gin 40614" is the gin, not the
// statement), and the gin's Farm YTD against what Turnrow holds. "Save all"
// saves each statement as its own receipt.
//
// The gin's CSV export (2026-10-18, lib/gin-receipt-csv) rides the same
// review: it is read here, not by the AI, into the same page shape, and
// grouped by the same rules. The export prints no gin and no statement
// date, so each card gets a gin picker (defaulting to the gin of the matched
// loads) and is dated by the last day its bales were ginned.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/friendly-error'
import { useDialogs } from '@/components/use-dialogs'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, type GinReceiptExtraction } from '@/lib/pdf-upload'
import { GinReceiptCsvError, parseGinReceiptCsv } from '@/lib/gin-receipt-csv'
import { DEFAULT_MAX_TOKENS, parseDocumentChunked } from '@/lib/parse-chunked'
import { planPagesPerBatch } from '@/lib/chunk-plan'
import { mergeGinReceipts } from '@/lib/parse-merge'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { reconcileBaleCount, lintTurnoutPct } from '@/lib/cotton'
import { rollsNum } from '@/lib/cotton-load-writes'
import { pbiReview } from '@/lib/cotton-load-review'
import { numberKey, pbiKeys } from '@/lib/number-key'
import {
  classifyStatement, farmYtdCheck, groupStatementPages, isSynthesizedReceiptNumber, rebaseGinReceiptPages,
  receiptDisplayName, synthesizeReceiptNumber, type FarmYtdOther, type GinStatement, type SavedReceiptLike,
} from '@/lib/gin-statements'
import {
  canCreateLoad, farmFieldFromMatches, matchStatementLoads, matchSummary, printedVsMatchedNote,
  type LineMatch, type MatchableLoad,
} from '@/lib/gin-receipt-matching'
import { fmtDate } from '@/lib/format-date'
import { EmptyState, SummaryCards, ViewTabs, fmtInt, fmtPct, theadCls, type SummaryCardData } from '@/components/reports/report-kit'
import { CottonPageHeader, CottonSection, YieldFigure } from '@/components/cotton/cotton-page-header'
import { useCottonFieldYields } from '@/lib/use-cotton-field-yields'
import { perAcre } from '@/lib/cotton-field-yields'
import type { GinReceipt, Gin, Farm, Field, Entity, CottonLoad } from '@/lib/types'
import Link from 'next/link'
import { scopeToPlanted } from '@/lib/planted-scope'

const lbs = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString())
const num = (s: string): number | null => { const n = Number(s); return s.trim() !== '' && Number.isFinite(n) ? n : null }

/** The 093 columns — stripped and retried when the database has not been updated yet (the 090 pattern). */
const RECEIPT_093_COLUMNS = ['gin_code', 'statement_number', 'printed_farm_number', 'printed_field', 'farm_ytd_modules', 'farm_ytd_seed_cotton_lbs', 'farm_ytd_bales', 'farm_ytd_bale_weight'] as const
const isMissingColumn = (error: { message?: string } | null | undefined) => !!error?.message && /column|schema/i.test(error.message)
const without = (row: Record<string, unknown>, cols: ReadonlyArray<string>) => Object.fromEntries(Object.entries(row).filter(([k]) => !cols.includes(k)))

async function insertReceipt(supabase: SupabaseClient, header: Record<string, unknown>) {
  const first = await supabase.from('gin_receipts').insert(header).select('id').single()
  if (!first.error || !isMissingColumn(first.error)) return first
  return supabase.from('gin_receipts').insert(without(header, RECEIPT_093_COLUMNS)).select('id').single()
}
async function updateReceipt(supabase: SupabaseClient, id: string, header: Record<string, unknown>) {
  const first = await supabase.from('gin_receipts').update(header).eq('id', id)
  if (!first.error || !isMissingColumn(first.error)) return first
  return supabase.from('gin_receipts').update(without(header, RECEIPT_093_COLUMNS)).eq('id', id)
}

type FarmFieldSource = 'matched' | 'printed' | 'user' | 'none'

/** The gin picker's "+ Add a gin…" choice. */
const NEW_GIN = '__new__'

type StatementReview = {
  s: GinStatement
  farmId: string
  fieldId: string
  farmFieldFrom: FarmFieldSource
  /** The gin picked on the card when the statement names none (the CSV export). */
  ginId: string
  ginFromUser: boolean
  /** Line indexes whose missing load the user wants created. */
  createMissing: Set<number>
  /** Suggestions the user accepted: line index → load id. */
  linked: Map<number, string>
  /** Bale-list rows left out of the save. */
  excludedBales: Set<number> | null
  updateReceipt: boolean
}

export default function GinReceiptsPage() {
  const { confirmText, promptText, dialogs } = useDialogs()
  const supabase = useMemo(() => createClient(), [])
  const [receipts, setReceipts] = useState<GinReceipt[]>([])
  const [balesByReceipt, setBalesByReceipt] = useState<Map<string, number>>(new Map())
  const [gins, setGins] = useState<Gin[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [loads, setLoads] = useState<CottonLoad[]>([])
  const [links, setLinks] = useState<Array<{ receipt_id: string; cotton_load_id: string }>>([])
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // AI review
  const [source, setSource] = useState<DocumentSource | null>(null)
  /** The gin's CSV export being reviewed (its file name), instead of a scanned document. */
  const [csvName, setCsvName] = useState<string | null>(null)
  /** Figures in the export that do not add up — shown, never blocking. */
  const [notes, setNotes] = useState<string[]>([])
  const [stage, setStage] = useState<string | null>(null)
  const [reviews, setReviews] = useState<StatementReview[]>([])
  const [intake, setIntake] = useState<'upload' | 'hand'>('upload')
  // Field and farm-wide yields — the Yields page's cotton model.
  const fieldYields = useCottonFieldYields(supabase, cropYear)
  const [saving, setSaving] = useState(false)
  const [existingBales, setExistingBales] = useState<Array<{ pbi_number: string; crop_year: number; gin_receipt_id: string }>>([])
  // manual form
  const [m, setM] = useState({ receipt_number: '', receipt_date: '', gin_id: '', farm_id: '', field_id: '', modules: '', seedwt: '', bales: '', balewt: '', seedlbs: '' })

  async function refresh() {
    const [r, b, g, f, fl, en, l, lk] = await Promise.all([
      supabase.from('gin_receipts').select('*').order('receipt_date', { ascending: false }),
      fetchAllRows((f, t) => supabase.from('cotton_bales').select('gin_receipt_id, pbi_number, crop_year').order('id').range(f, t)),
      supabase.from('gins').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('entities').select('*').order('name'),
      fetchAllRows((f, t) => supabase.from('cotton_loads').select('*').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('gin_receipt_loads').select('receipt_id, cotton_load_id').order('id').range(f, t)),
    ])
    setReceipts((r.data as GinReceipt[]) || [])
    const counts = new Map<string, number>()
    const baleRows = ((b.data as { gin_receipt_id: string; pbi_number: string; crop_year: number }[]) || [])
    for (const row of baleRows) counts.set(row.gin_receipt_id, (counts.get(row.gin_receipt_id) ?? 0) + 1)
    setBalesByReceipt(counts)
    setExistingBales(baleRows)
    setGins((g.data as Gin[]) || [])
    setFarms((f.data as Farm[]) || [])
    setFields((fl.data as Field[]) || [])
    setEntities((en.data as Entity[]) || [])
    setLoads((l.data as CottonLoad[]) || [])
    setLinks((lk.data as Array<{ receipt_id: string; cotton_load_id: string }>) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])
  void entities

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  // Every farm/field picker here — the statement review rows, hand entry,
  // the printed farm/field match — offers only the farms and fields with a
  // cotton planting THIS crop year (lib/planted-scope).
  const scope = useMemo(
    () => scopeToPlanted({ fields, farms, plantedFieldIds: fieldYields.plantedFieldIds }),
    [fields, farms, fieldYields.plantedFieldIds],
  )
  useEffect(() => {
    if (!scope.narrowed) return
    const fieldOk = (id: string) => !id || scope.fields.some((f) => f.id === id)
    const farmOk = (id: string) => !id || scope.farms.some((f) => f.id === id)
    setM((x) => (fieldOk(x.field_id) && farmOk(x.farm_id) ? x : { ...x, field_id: fieldOk(x.field_id) ? x.field_id : '', farm_id: farmOk(x.farm_id) ? x.farm_id : '' }))
  }, [scope])
  const ginById = useMemo(() => new Map(gins.map((g) => [g.id, g])), [gins])
  const receiptById = useMemo(() => new Map(receipts.map((r) => [r.id, r])), [receipts])
  const loadGinById = useMemo(() => new Map(loads.map((l) => [l.id, l.gin_id])), [loads])
  /** A statement that names no gin (the CSV export) takes the gin picked on
   *  its card: name and gin code, so identity, PBI matching and the Farm
   *  YTD check see the same gin a scanned statement would print. */
  const statementNamesGin = (s: GinStatement) => !!(s.gin_code || s.gin_name)
  const effectiveStatement = (rv: StatementReview): GinStatement => {
    if (statementNamesGin(rv.s) || !rv.ginId) return rv.s
    const g = ginById.get(rv.ginId)
    return g ? { ...rv.s, gin_name: g.name, gin_code: g.gin_code ?? null } : rv.s
  }
  const yearReceipts = receipts.filter((r) => r.crop_year === cropYear)

  // How a saved receipt is named everywhere on this page.
  const receiptGinCode = (r: GinReceipt): string | null => r.gin_code ?? (r.gin_id ? ginById.get(r.gin_id)?.gin_code ?? null : null)
  const receiptFarmNumber = (r: GinReceipt): string | null => r.printed_farm_number ?? (r.farm_id ? farmById.get(r.farm_id)?.fsa_number ?? null : null)
  const receiptField = (r: GinReceipt): string | null => r.printed_field ?? (r.field_id ? fieldById.get(r.field_id)?.name_or_number ?? null : null)
  const receiptName = (r: GinReceipt): string => receiptDisplayName({
    gin_name: r.gin_id ? ginById.get(r.gin_id)?.name : null, gin_code: receiptGinCode(r), receipt_date: r.receipt_date,
    farm_label: receiptFarmNumber(r), field_label: receiptField(r), statement_number: r.statement_number, receipt_number: r.receipt_number,
  })

  const savedReceiptLikes = useMemo((): SavedReceiptLike[] => receipts.map((r) => ({
    id: r.id, receipt_number: r.receipt_number, crop_year: r.crop_year, receipt_date: r.receipt_date,
    gin_code: receiptGinCode(r), statement_number: r.statement_number ?? null,
    printed_farm_number: receiptFarmNumber(r), printed_field: receiptField(r),
    modules_count: r.modules_count, total_seed_cotton_weight: r.total_seed_cotton_weight, bales_count: r.bales_count, total_bale_weight: r.total_bale_weight,
  })), [receipts, gins, farms, fields]) // eslint-disable-line react-hooks/exhaustive-deps

  const matchable = useMemo((): MatchableLoad[] => loads.map((l) => ({
    id: l.id, load_number: l.load_number, crop_year: l.crop_year, net_weight: l.net_weight, gross_weight: l.gross_weight, tare_weight: l.tare_weight, farm_id: l.farm_id, field_id: l.field_id,
  })), [loads])
  const onReceipt = useMemo(() => {
    const m = new Map<string, string>()
    for (const lk of links) { const r = receiptById.get(lk.receipt_id); if (r) m.set(lk.cotton_load_id, receiptName(r)) }
    return m
  }, [links, receiptById, gins, farms, fields]) // eslint-disable-line react-hooks/exhaustive-deps
  const receiptIdByLoad = useMemo(() => new Map(links.map((lk) => [lk.cotton_load_id, lk.receipt_id])), [links])
  const existingBaleLikes = useMemo(() => existingBales.map((b) => {
    const r = receiptById.get(b.gin_receipt_id)
    return { pbi_number: b.pbi_number, crop_year: b.crop_year, receipt_number: r?.receipt_number ?? null, receipt_label: r ? receiptName(r) : null }
  }), [existingBales, receiptById, gins, farms, fields]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- per-statement derived review ----------
  type Derived = {
    year: number
    rows: LineMatch[]
    summary: ReturnType<typeof matchSummary>
    matchedFarmField: ReturnType<typeof farmFieldFromMatches>
    farmFieldNote: string | null
    classification: ReturnType<typeof classifyStatement>
    baleReview: ReturnType<typeof pbiReview<GinStatement['bales'][number]>>
    excluded: Set<number>
    includedBales: number
    baleCheck: ReturnType<typeof reconcileBaleCount>
    turnout: number | null
    ytd: ReturnType<typeof farmYtdCheck>
  }
  const derived: Derived[] = useMemo(() => reviews.map((rv, idx) => {
    const s = effectiveStatement(rv)
    const year = s.crop_year ?? cropYear
    const classification = classifyStatement(s, savedReceiptLikes, year)
    const thisReceiptId = classification.status !== 'new' ? classification.existingId : null
    const rows = matchStatementLoads(s.loads, matchable, { cropYear: year, onReceipt, receiptIdByLoad, thisReceiptId, farmId: rv.farmId || null, fieldId: rv.fieldId || null, linked: rv.linked })
    const matchedFarmField = farmFieldFromMatches(rows)
    const farmFieldNote = matchedFarmField ? printedVsMatchedNote({
      printedFarmNumber: s.farm_number, printedField: s.field,
      matchedFarmFsa: matchedFarmField.farmId ? farmById.get(matchedFarmField.farmId)?.fsa_number ?? null : null,
      matchedFieldName: matchedFarmField.fieldId ? fieldById.get(matchedFarmField.fieldId)?.name_or_number ?? null : null,
    }) : null
    const baleReview = pbiReview(s.bales, existingBaleLikes.filter((b) => !thisReceiptId || receiptById.get(existingBales.find((e) => e.pbi_number === b.pbi_number && e.crop_year === b.crop_year)?.gin_receipt_id ?? '')?.id !== thisReceiptId), year, s.gin_code)
    const excluded = rv.excludedBales ?? new Set(baleReview.map((r, i) => (r.flags.length > 0 ? i : -1)).filter((i) => i >= 0))
    const includedBales = s.bales.filter((b, i) => b.pbi_number && b.net_weight_lbs != null && !excluded.has(i)).length
    const baleCheck = reconcileBaleCount(s.bales_count, s.bales.filter((b) => b.pbi_number && b.net_weight_lbs != null).length)
    const turnout = s.lint_turnout_pct ?? (s.total_bale_weight != null && s.total_seed_cotton_weight != null ? lintTurnoutPct(s.total_bale_weight, s.total_seed_cotton_weight) : null)
    // Farm YTD: saved receipts for this gin + farm (not the one this statement updates) + the other statements in this upload that are not already saved.
    const others: FarmYtdOther[] = [
      ...receipts.filter((r) => r.id !== thisReceiptId && r.crop_year === year).map((r) => ({
        gin_code: receiptGinCode(r), farm_number: receiptFarmNumber(r), receipt_date: r.receipt_date,
        modules_count: r.modules_count, total_seed_cotton_weight: r.total_seed_cotton_weight, bales_count: r.bales_count, total_bale_weight: r.total_bale_weight,
      })),
      ...reviews.map((o) => effectiveStatement(o)).filter((o, j) => j !== idx && classifyStatement(o, savedReceiptLikes, o.crop_year ?? cropYear).status === 'new').map((o) => ({
        gin_code: o.gin_code, farm_number: o.farm_number, receipt_date: o.receipt_date,
        modules_count: o.modules_count, total_seed_cotton_weight: o.total_seed_cotton_weight, bales_count: o.bales_count, total_bale_weight: o.total_bale_weight,
      })),
    ]
    const ytd = farmYtdCheck(s, others)
    return { year, rows, summary: matchSummary(rows), matchedFarmField, farmFieldNote, classification, baleReview, excluded, includedBales, baleCheck, turnout, ytd }
  }), [reviews, cropYear, savedReceiptLikes, matchable, onReceipt, receiptIdByLoad, farmById, fieldById, existingBaleLikes, existingBales, receiptById, receipts, ginById]) // eslint-disable-line react-hooks/exhaustive-deps

  // Default the farm/field from the matched loads when they all agree (chip
  // "from matched loads"); the printed farm # / field is the fallback. A
  // statement that names no gin takes the gin of its matched loads when they
  // all agree, else the only gin on file — until the user picks one.
  useEffect(() => {
    setReviews((rs) => {
      let changed = false
      const next = rs.map((rv, i) => {
        const d = derived[i]
        if (!d) return rv
        let out = rv
        if (rv.farmFieldFrom !== 'user') {
          const mf = d.matchedFarmField
          if (mf && !d.farmFieldNote && (mf.farmId !== (rv.farmId || null) || mf.fieldId !== (rv.fieldId || null) || rv.farmFieldFrom !== 'matched')) {
            changed = true
            out = { ...out, farmId: mf.farmId ?? '', fieldId: mf.fieldId ?? '', farmFieldFrom: 'matched' as const }
          }
        }
        if (!statementNamesGin(rv.s) && !rv.ginFromUser) {
          const ginIds = new Set(d.rows.filter((r) => r.load).map((r) => loadGinById.get(r.load!.id) ?? null).filter((g): g is string => !!g))
          const pick = ginIds.size === 1 ? [...ginIds][0] : gins.length === 1 ? gins[0].id : rv.ginId
          if (pick !== rv.ginId) { changed = true; out = { ...out, ginId: pick } }
        }
        return out
      })
      return changed ? next : rs
    })
  }, [derived, gins, loadGinById]) // eslint-disable-line react-hooks/exhaustive-deps

  async function ensureGin(s: GinStatement): Promise<string | null> {
    const code = numberKey(s.gin_code)
    const byCode = code ? gins.find((g) => numberKey(g.gin_code) === code) : null
    if (byCode) return byCode.id
    const name = s.gin_name?.trim()
    const byName = name ? gins.find((g) => g.name.trim().toLowerCase() === name.toLowerCase()) : null
    if (byName) {
      if (s.gin_code && !byName.gin_code) await supabase.from('gins').update({ gin_code: s.gin_code }).eq('id', byName.id) // best effort (093)
      return byName.id
    }
    if (!name && !s.gin_code) return null
    const row = { name: name || `Gin ${s.gin_code}`, address: s.gin_address ?? null, phone: s.gin_phone ?? null, gin_code: s.gin_code ?? null }
    let ins = await supabase.from('gins').insert(row).select('id').single()
    if (ins.error && isMissingColumn(ins.error)) ins = await supabase.from('gins').insert(without(row, ['gin_code'])).select('id').single()
    if (ins.error || !ins.data) return null
    return (ins.data as { id: string }).id
  }

  /** "+ Add a gin…" on a statement's gin picker: name it, save it, pick it. */
  async function addGinFor(i: number) {
    const name = (await promptText('Name the gin', '', { title: 'Add a gin', confirmLabel: 'Add gin', numeric: false }))?.trim()
    if (!name) return
    const existing = gins.find((g) => g.name.trim().toLowerCase() === name.toLowerCase())
    let id = existing?.id ?? null
    if (!id) {
      const { data, error } = await supabase.from('gins').insert({ name }).select('id').single()
      if (error || !data) { setErr(reportError(error, { action: 'add the gin', noun: 'gin', name })); return }
      id = (data as { id: string }).id
      const { data: fresh } = await supabase.from('gins').select('*').order('name')
      setGins((fresh as Gin[]) || [])
    }
    patchReview(i, { ginId: id, ginFromUser: true })
  }

  function printedFarmField(s: GinStatement): { farmId: string; fieldId: string } {
    const farm = (s.farm_number ? scope.farms.find((f) => numberKey(f.fsa_number) === numberKey(s.farm_number)) : null)
      ?? (s.farm_name ? findBestMatch(s.farm_name, scope.farms, (f) => f.name) : null)
      ?? (s.producer ? findBestMatch(s.producer, scope.farms, (f) => f.name) : null)
    const farmFields = scope.fields.filter((f) => !farm || f.farm_id === farm.id)
    const field = s.field ? findBestMatch(s.field, farmFields, (f) => f.name_or_number) : null
    return { farmId: farm?.id ?? '', fieldId: field?.id ?? '' }
  }

  /** One review card per statement, farm/field from the printed names, the gin from the card. */
  function startReviews(statements: GinStatement[]) {
    setReviews(statements.map((s) => {
      const printed = printedFarmField(s)
      return {
        s, farmId: printed.farmId, fieldId: printed.fieldId, farmFieldFrom: printed.farmId || printed.fieldId ? 'printed' : 'none',
        ginId: '', ginFromUser: false,
        createMissing: new Set<number>(), linked: new Map<number, string>(), excludedBales: null, updateReceipt: false,
      }
    }))
  }

  /** The gin's CSV export: read here (no AI), one statement per block. */
  async function onCsv(file: File) {
    setErr(null); setMsg(null); setNotes([]); setSource(null); setReviews([]); setCsvName(file.name)
    setStage('Reading the gin’s export…')
    try {
      const { pages, warnings } = parseGinReceiptCsv(await file.text(), { cropYear })
      const statements = groupStatementPages(pages)
      if (statements.length === 0) { setErr('No statement could be read from this file.'); setCsvName(null); return }
      startReviews(statements)
      setNotes(warnings)
      const n = statements.length
      setMsg(`Read ${n} statement${n === 1 ? '' : 's'} from ${file.name}. The export prints no gin and no statement date, so each statement is dated by the last day its bales were ginned${gins.length > 1 ? ' and takes the gin picked on its card' : ''}. Review each, then save.`)
    } catch (e: any) {
      setCsvName(null)
      setErr(e instanceof GinReceiptCsvError ? e.message : reportError(e, { action: 'read this file' }))
    } finally {
      setStage(null)
    }
  }

  async function onSource(src: DocumentSource) {
    setErr(null); setMsg(null); setNotes([]); setCsvName(null); setSource(src); setReviews([])
    setStage('Reading the Statement of Ginning…')
    try {
      // Page by page, in chunks; pages rebased to the whole document, merged
      // on page number, then grouped into statements (totals block / header
      // date / bale rows restarting at 1) — chunk 3 of an 18-page PDF can
      // straddle two statements and still comes out as two.
      const { data, warning } = await parseDocumentChunked<GinReceiptExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'gin_receipt',
        // Pages per call from the density plan (lib/chunk-plan: ≈25 tokens a
        // bale + 300 a page → 3 pages at the default cap).
        { pagesPerBatch: planPagesPerBatch({ documentType: 'gin_receipt', maxTokens: DEFAULT_MAX_TOKENS }), onProgress: setStage, merge: mergeGinReceipts, rebase: rebaseGinReceiptPages },
      )
      if (warning) setErr(warning)
      const statements = groupStatementPages(data.pages ?? [])
      if (statements.length === 0) { setErr('No statement could be read from this document.'); return }
      startReviews(statements)
      setMsg(`Read ${statements.length} statement${statements.length === 1 ? '' : 's'} from ${data.pages?.length ?? 0} page${(data.pages?.length ?? 0) === 1 ? '' : 's'}. Review each, then save.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(reportError(e, { action: 'read this document' }))
    } finally {
      setStage(null)
    }
  }

  const patchReview = (i: number, patch: Partial<StatementReview> | ((rv: StatementReview) => Partial<StatementReview>)) =>
    setReviews((rs) => rs.map((rv, j) => (j === i ? { ...rv, ...(typeof patch === 'function' ? patch(rv) : patch) } : rv)))

  async function saveAll() {
    if (reviews.length === 0) return
    setSaving(true); setErr(null)
    const done: string[] = []
    const skipped: string[] = []
    try {
      for (let i = 0; i < reviews.length; i++) {
        const rv = reviews[i]
        const d = derived[i]
        const s = effectiveStatement(rv)
        const name = receiptDisplayName({ gin_name: s.gin_name, gin_code: s.gin_code, receipt_date: s.receipt_date, farm_label: s.farm_number, field_label: s.field, statement_number: s.statement_number })
        if (d.classification.status !== 'new' && !rv.updateReceipt) { skipped.push(name); continue }
        if (d.rows.some((r) => r.status === 'ambiguous')) throw new Error(`${name}: two saved loads share a number. Merge them on Seed Cotton Loads, then re-check.`)
        let receiptId: string | null = null
        let insertedNew = false
        try {
          const gin_id = (!statementNamesGin(rv.s) && rv.ginId) || await ensureGin(s)
          const year = d.year
          const header: Record<string, unknown> = {
            gin_id, receipt_number: synthesizeReceiptNumber(s), receipt_date: s.receipt_date, crop_year: year,
            entity_id: rv.farmId ? farmById.get(rv.farmId)?.entity_id ?? null : null,
            farm_id: rv.farmId || null, field_id: rv.fieldId || null,
            modules_count: s.modules_count, total_seed_cotton_weight: s.total_seed_cotton_weight,
            bales_count: s.bales_count, total_bale_weight: s.total_bale_weight, avg_bale_weight: s.avg_bale_weight,
            seed_lbs: s.seed_lbs, lint_turnout_pct: d.turnout, lint_lbs_per_bale: s.lint_lbs_per_bale,
            source: 'document_import',
            gin_code: s.gin_code, statement_number: s.statement_number, printed_farm_number: s.farm_number, printed_field: s.field,
            farm_ytd_modules: s.farm_ytd?.modules ?? null, farm_ytd_seed_cotton_lbs: s.farm_ytd?.seed_cotton_lbs ?? null,
            farm_ytd_bales: s.farm_ytd?.bales ?? null, farm_ytd_bale_weight: s.farm_ytd?.bale_weight ?? null,
          }
          let alreadyLinked = new Set<string>()
          if (d.classification.status !== 'new') {
            receiptId = d.classification.existingId
            const { error: upErr } = await updateReceipt(supabase, receiptId, header)
            if (upErr) throw new Error(upErr.message)
            alreadyLinked = new Set(links.filter((lk) => lk.receipt_id === receiptId).map((lk) => lk.cotton_load_id))
          } else {
            const { data: rec, error: recErr } = await insertReceipt(supabase, header)
            if (recErr || !rec) throw new Error(recErr?.message ?? 'Could not save the receipt.')
            receiptId = (rec as { id: string }).id
            insertedNew = true
          }

          // Load lines: link matched loads; create the ticked missing ones
          // (never one whose key a saved load already answers to).
          const linkIds: string[] = []
          for (const row of d.rows) {
            if (row.load) { linkIds.push(row.load.id); continue }
            if (!canCreateLoad(row) || !rv.createMissing.has(row.index)) continue
            const ln = row.line.load_number!.trim()
            const newLoad = {
              load_number: ln, crop_year: year, farm_id: rv.farmId || null, field_id: rv.fieldId || null,
              entity_id: rv.farmId ? farmById.get(rv.farmId)?.entity_id ?? null : null,
              gross_weight: row.line.gross, tare_weight: row.line.tare,
              net_weight: row.line.net ?? (row.line.gross != null && row.line.tare != null ? row.line.gross - row.line.tare : null),
              gin_id, source: 'document_import',
            }
            let ins = await supabase.from('cotton_loads').insert({ ...newLoad, rolls: rollsNum(row.line.rolls) }).select('id').single()
            if (ins.error && /rolls/.test(ins.error.message) && isMissingColumn(ins.error)) ins = await supabase.from('cotton_loads').insert(newLoad).select('id').single()
            if (ins.error || !ins.data) throw new Error(ins.error?.message ?? `Could not create load ${ln}.`)
            linkIds.push((ins.data as { id: string }).id)
          }
          const newLinks = [...new Set(linkIds)].filter((id) => !alreadyLinked.has(id))
          if (newLinks.length > 0) {
            const { error } = await supabase.from('gin_receipt_loads').insert(newLinks.map((id) => ({ receipt_id: receiptId, cotton_load_id: id })))
            if (error) throw new Error(error.message)
          }
          // Bales: the rows left in, never a PBI already saved this crop year.
          const savedKeys = new Set(existingBaleLikes.filter((b) => b.crop_year === year).flatMap((b) => pbiKeys(b.pbi_number, s.gin_code)))
          const balesRows = s.bales.filter((b, k) => b.pbi_number && b.net_weight_lbs != null && !d.excluded.has(k) && !pbiKeys(b.pbi_number, s.gin_code).some((key) => savedKeys.has(key)))
          if (balesRows.length > 0) {
            const { error } = await supabase.from('cotton_bales').insert(balesRows.map((b) => ({
              gin_receipt_id: receiptId, crop_year: year, pbi_number: String(b.pbi_number).trim(), net_weight_lbs: b.net_weight_lbs,
            })))
            if (error) throw new Error(error.message)
          }
          const leftOut = s.bales.length - balesRows.length
          done.push(`${insertedNew ? 'Saved' : 'Updated'} ${name}: ${balesRows.length} bale${balesRows.length === 1 ? '' : 's'}${leftOut > 0 ? ` (${leftOut} left out)` : ''}, ${linkIds.length} load${linkIds.length === 1 ? '' : 's'}`)
        } catch (e: any) {
          // Best-effort atomicity per statement: a failure after a NEW receipt
          // insert removes that receipt (bales/links cascade).
          if (receiptId && insertedNew) await supabase.from('gin_receipts').delete().eq('id', receiptId)
          throw new Error(`${name}: ${reportError(e, { action: 'save the statement', noun: 'gin receipt' })} That statement was not kept.${done.length ? ` Already saved: ${done.join('; ')}.` : ''}`)
        }
      }
      setMsg([...done, ...(skipped.length ? [`Left alone (already saved): ${skipped.join('; ')}`] : [])].join(' · '))
      setReviews([]); setSource(null); setCsvName(null); setNotes([]); refresh(); fieldYields.refresh()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
      refresh()
    } finally {
      setSaving(false)
    }
  }

  async function addManual(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    const lint = num(m.balewt)
    const seedcotton = num(m.seedwt)
    const gin = m.gin_id ? ginById.get(m.gin_id) : null
    const farm = m.farm_id ? farmById.get(m.farm_id) : null
    const field = m.field_id ? fieldById.get(m.field_id) : null
    const identity = {
      gin_code: gin?.gin_code ?? null, statement_number: m.receipt_number.trim() || null,
      farm_number: farm?.fsa_number ?? null, field: field?.name_or_number ?? null, receipt_date: m.receipt_date || null,
      modules_count: num(m.modules), total_seed_cotton_weight: seedcotton, bales_count: num(m.bales),
    }
    if (!identity.statement_number && !m.receipt_date) { setErr('Enter the statement number the gin printed, or at least its date.'); return }
    const header: Record<string, unknown> = {
      receipt_number: synthesizeReceiptNumber(identity), receipt_date: m.receipt_date || null, crop_year: cropYear,
      gin_id: m.gin_id || null, farm_id: m.farm_id || null, field_id: m.field_id || null,
      entity_id: farm?.entity_id ?? null,
      modules_count: num(m.modules), total_seed_cotton_weight: seedcotton, bales_count: num(m.bales),
      total_bale_weight: lint, seed_lbs: num(m.seedlbs),
      lint_turnout_pct: lint != null && seedcotton != null ? lintTurnoutPct(lint, seedcotton) : null,
      avg_bale_weight: lint != null && num(m.bales) ? Math.round((lint / num(m.bales)!) * 100) / 100 : null,
      source: 'manual',
      gin_code: identity.gin_code, statement_number: identity.statement_number, printed_farm_number: identity.farm_number, printed_field: identity.field,
    }
    const { error } = await insertReceipt(supabase, header)
    if (error) { setErr(reportError(error, { action: 'save the gin receipt', noun: 'gin receipt', name: m.receipt_number.trim() || undefined })); return }
    setM({ receipt_number: '', receipt_date: '', gin_id: m.gin_id, farm_id: m.farm_id, field_id: '', modules: '', seedwt: '', bales: '', balewt: '', seedlbs: '' })
    setMsg('Receipt saved — add its bales via the Bales & Grades CSV/AI flows or re-upload the statement.')
    refresh()
  }

  async function deleteReceipt(id: string) {
    if (!(await confirmText('Delete this gin receipt? Its bales and load links go with it.'))) return
    await supabase.from('gin_receipts').delete().eq('id', id)
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11'
  const chip = 'rounded bg-slate-50 border border-slate-200 px-2 py-1'
  const years = useMemo(() => {
    const ys = new Set<number>([cropYear, new Date().getFullYear(), ...receipts.map((r) => r.crop_year)])
    return [...ys].sort((a, b) => b - a)
  }, [receipts, cropYear])
  const yearBales = useMemo(() => existingBales.filter((b) => b.crop_year === cropYear).length, [existingBales, cropYear])
  const yearLint = yearReceipts.reduce((s, r) => s + Number(r.total_bale_weight ?? 0), 0)
  const yearSeed = yearReceipts.reduce((s, r) => s + Number(r.total_seed_cotton_weight ?? 0), 0)
  const summaryCards: SummaryCardData[] = [
    { label: `${cropYear} statements`, value: fmtInt(yearReceipts.length), sub: yearReceipts.length ? `${fmtInt(yearReceipts.reduce((s, r) => s + Number(r.modules_count ?? 0), 0))} modules ginned` : 'none yet' },
    { label: 'Bales', value: yearBales ? fmtInt(yearBales) : (yearReceipts.length ? fmtInt(yearReceipts.reduce((s, r) => s + Number(r.bales_count ?? 0), 0)) : '—'), sub: yearBales ? 'with PBI numbers on file' : 'from the statements' },
    { label: 'Lint', value: yearLint ? `${fmtInt(yearLint)} lbs` : '—', sub: yearSeed ? `from ${fmtInt(yearSeed)} lbs seed cotton` : undefined },
    { label: 'Turnout', value: yearLint && yearSeed ? fmtPct((yearLint / yearSeed) * 100, 2) : '—', sub: 'lint ÷ seed cotton, all statements', tone: 'neutral' },
    {
      label: 'Lint per acre',
      value: fieldYields.farm.lintPerAcre != null ? `${fmtInt(Math.round(fieldYields.farm.lintPerAcre))} lbs/ac` : '—',
      sub: fieldYields.farm.acresPicked > 0
        ? `${fieldYields.farm.lintBasis === 'actual' ? 'ginned lint' : fieldYields.farm.lintBasis === 'mixed' ? 'part estimated' : 'estimated'} on ${fmtInt(fieldYields.farm.acresPicked)} ac picked · seed cotton ${fieldYields.farm.seedPerAcre != null ? fmtInt(Math.round(fieldYields.farm.seedPerAcre)) : '—'} lbs/ac`
        : 'needs a cotton planting with acres on the field',
      tone: fieldYields.farm.lintBasis && fieldYields.farm.lintBasis !== 'actual' ? 'warning' : 'neutral',
    },
  ]
  const anyAmbiguous = derived.some((d) => d.rows.some((r) => r.status === 'ambiguous'))
  const allAlreadySaved = reviews.length > 0 && reviews.every((rv, i) => derived[i]?.classification.status !== 'new' && !rv.updateReceipt)

  return (
    <div className="space-y-4">
      <CottonPageHeader
        title="Gin Receipts"
        sub="The gin’s Statements of Ginning: modules in, bales and lint out, matched to your loads."
        cropYear={cropYear}
        years={years}
        onCropYear={setCropYear}
      />

      <SummaryCards cards={summaryCards} />

      <CottonSection title="Add a statement" sub="Upload the gin’s Statement of Ginning — a PDF, photos, or the gin’s CSV export; one file can hold several — or type one in. Nothing saves until you review it.">
        <div className="px-4 pt-2">
          <ViewTabs ariaLabel="How to add a statement" value={intake} onChange={setIntake} tabs={[{ key: 'upload', label: 'Upload a statement' }, { key: 'hand', label: 'Add by hand' }]} />
        </div>
        {intake === 'upload' && (
        <div className="p-4 space-y-3">
        <DocumentCapture onSource={onSource} onCsv={onCsv} busy={stage != null} stageLabel={stage} pdfLabel="Upload statement PDF, photos, or CSV" />
        {notes.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1" role="status">
            <div className="font-semibold">Figures in the export that don’t add up — check them against the statement:</div>
            <ul className="list-disc pl-4 space-y-0.5">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        )}
        {reviews.length > 0 && (
          <div className="space-y-4 text-sm">
            {reviews.map((rv, i) => {
              const s = effectiveStatement(rv)
              const d = derived[i]
              if (!d) return null
              const flagged = d.baleReview.map((r, k) => ({ ...r, k })).filter((r) => r.flags.length > 0)
              const title = receiptDisplayName({ gin_name: s.gin_name, gin_code: s.gin_code, receipt_date: s.receipt_date, farm_label: s.farm_number, field_label: s.field, statement_number: s.statement_number })
              const needsGin = !statementNamesGin(rv.s)
              return (
                <article key={i} className="rounded-xl border border-slate-200 p-3 space-y-3" aria-label={`Statement ${i + 1}: ${title}`}>
                  <div className="flex flex-wrap gap-3 items-end">
                    <div className="flex-1 min-w-[16rem]">
                      <div className="font-semibold">{reviews.length > 1 ? `Statement ${i + 1} of ${reviews.length} · ` : ''}{title}</div>
                      <div className="text-xs text-slate-500">
                        {csvName
                          ? `From the gin’s export${s.receipt_date ? ` · dated ${fmtDate(s.receipt_date)}, the last day its bales were ginned` : ' · no ginning dates in the file'}`
                          : `Pages ${s.pages.length === 1 ? s.pages[0] : `${s.pages[0]}–${s.pages[s.pages.length - 1]}`}`}
                        {s.gin_code ? ` · gin code ${s.gin_code}` : ''}
                        {s.statement_number ? ` · statement #${s.statement_number}` : ' · no statement number printed (identified by gin, farm, field, date and totals)'}
                        {` · crop year ${d.year}`}
                      </div>
                    </div>
                    {needsGin && (
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-slate-500">Gin</span>
                        <select
                          value={rv.ginId}
                          onChange={(e) => {
                            if (e.target.value === NEW_GIN) { void addGinFor(i); return }
                            patchReview(i, { ginId: e.target.value, ginFromUser: true })
                          }}
                          className={`${inputCls} ${!rv.ginId ? 'border-amber-400' : ''}`}
                          aria-label={`Gin for statement ${i + 1}`}
                        >
                          <option value="">— gin —</option>
                          {gins.map((g) => <option key={g.id} value={g.id}>{g.name}{g.gin_code ? ` (${g.gin_code})` : ''}</option>)}
                          <option value={NEW_GIN}>+ Add a gin…</option>
                        </select>
                      </label>
                    )}
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-slate-500">Farm</span>
                      <select value={rv.farmId} onChange={(e) => patchReview(i, { farmId: e.target.value, fieldId: '', farmFieldFrom: 'user' })} className={inputCls}>
                        <option value="">— farm —</option>
                        {scope.farms.map((f) => <option key={f.id} value={f.id}>{f.name}{f.fsa_number ? ` (#${f.fsa_number})` : ''}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-slate-500">Field</span>
                      <select value={rv.fieldId} onChange={(e) => patchReview(i, { fieldId: e.target.value, farmFieldFrom: 'user' })} className={inputCls}>
                        <option value="">— field —</option>
                        {scope.fields.filter((f) => !rv.farmId || f.farm_id === rv.farmId).map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
                      </select>
                    </label>
                    {rv.farmFieldFrom === 'matched' && <span className="text-xs rounded-full bg-green-50 border border-green-200 text-green-800 px-2 py-0.5">from matched loads</span>}
                    {rv.farmFieldFrom === 'printed' && <span className="text-xs rounded-full bg-slate-50 border border-slate-200 text-slate-700 px-2 py-0.5">from the statement</span>}
                    {(s.farm_name || s.producer || s.field || s.farm_number) && <span className="text-xs text-amber-700">Printed: {s.producer ?? s.farm_name}{s.farm_number ? ` · farm #${s.farm_number}` : ''}{s.field ? ` · ${s.field}` : ''}</span>}
                  </div>
                  {d.farmFieldNote && <p className="text-amber-700 text-xs font-semibold" role="status">{d.farmFieldNote}</p>}
                  {rv.fieldId && fieldYields.acresFor(rv.fieldId) != null && s.total_bale_weight != null && (
                    <p className="text-xs text-slate-600">
                      This statement on {fieldById.get(rv.fieldId)?.name_or_number ?? 'the field'}’s {fmtInt(fieldYields.acresFor(rv.fieldId)!)} ac: <YieldFigure perAcre={perAcre(s.total_bale_weight, fieldYields.acresFor(rv.fieldId))} unit="lbs lint/ac" /> · <YieldFigure perAcre={perAcre(s.total_seed_cotton_weight, fieldYields.acresFor(rv.fieldId))} unit="lbs seed/ac" />
                      {fieldYields.yieldFor(rv.fieldId) && fieldYields.yieldFor(rv.fieldId)!.receiptCount > 0 && <> · field to date <YieldFigure perAcre={fieldYields.yieldFor(rv.fieldId)!.lintPerAcre} basis={fieldYields.yieldFor(rv.fieldId)!.lintBasis} turnoutLabel={fieldYields.yieldFor(rv.fieldId)!.turnout.label} unit="lbs lint/ac" /></>}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className={chip}>{s.modules_count ?? '—'} modules</span>
                    <span className={chip}>{lbs(s.total_seed_cotton_weight)} lbs seed cotton</span>
                    <span className={chip}>{s.bales_count ?? '—'} bales · {lbs(s.total_bale_weight)} lbs lint</span>
                    <span className={chip}>{lbs(s.seed_lbs)} lbs cottonseed</span>
                    <span className={chip}>turnout {d.turnout ?? '—'}%</span>
                    <span className={chip}>{s.bales.length} bale rows read</span>
                  </div>
                  {!d.baleCheck.ok && <p className="text-amber-700 text-xs font-semibold">{d.baleCheck.message}</p>}

                  {/* Farm YTD — informational, never blocks. */}
                  {d.ytd.status === 'match' && <p className="text-xs text-green-700" role="status">{d.ytd.message}</p>}
                  {(d.ytd.status === 'short' || d.ytd.status === 'over') && <p className="text-xs text-amber-700" role="status">{d.ytd.message}</p>}
                  {d.ytd.status === 'printed_before' && <p className="text-xs text-slate-400" role="status">{d.ytd.message}</p>}

                  {/* The statement against what is saved: never a silent second receipt. */}
                  {d.classification.status !== 'new' && (
                    <div className={`rounded-lg border px-3 py-2 ${rv.updateReceipt ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-slate-50 border-slate-300 text-slate-700'}`} role="status">
                      <span className="font-semibold">{d.classification.status === 'saved' ? 'Already saved' : 'Update available'}</span> — this statement is on file for {d.year}.
                      {d.classification.status === 'update' && <span className="block text-xs">Changes in this scan: {d.classification.diffs.join(' · ')}</span>}
                      <label className="inline-flex items-center gap-2 min-h-8 ml-2">
                        <input type="checkbox" className="h-5 w-5" checked={rv.updateReceipt} onChange={(e) => patchReview(i, { updateReceipt: e.target.checked })} />
                        Update that receipt (header, new loads, and new bales; nothing is removed)
                      </label>
                    </div>
                  )}

                  {flagged.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1">
                      <div className="font-semibold">{flagged.length} bale{flagged.length === 1 ? '' : 's'} left out of the save — tick one to keep it:</div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {flagged.map((b) => (
                          <label key={b.k} className="inline-flex items-center gap-1 min-h-7">
                            <input type="checkbox" className="h-4 w-4" checked={!d.excluded.has(b.k)} onChange={(e) => patchReview(i, () => { const n = new Set(d.excluded); if (e.target.checked) n.delete(b.k); else n.add(b.k); return { excludedBales: n } })} />
                            <span className="font-mono">{b.bale.pbi_number}</span> <span>{b.flags.join(' · ')}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {d.rows.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-xs">
                        <thead className="text-slate-500"><tr>{['Load #', 'Net lbs', 'Match', ''].map((h) => <th key={h} className="text-left px-1 py-1">{h}</th>)}</tr></thead>
                        <tbody>
                          {d.rows.map((row) => <LoadLineRow key={row.index} row={row} rv={rv} onPatch={(p) => patchReview(i, p)} />)}
                        </tbody>
                      </table>
                      <p className="text-xs text-slate-600 mt-1 font-semibold" role="status">{d.summary.text}</p>
                    </div>
                  )}
                </article>
              )
            })}
            <div className="flex flex-wrap gap-2 items-center">
              <button onClick={saveAll} disabled={saving || anyAmbiguous || allAlreadySaved} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">
                {saving ? 'Saving…' : reviews.length > 1 ? `Save all (${reviews.length} receipts)` : 'Save receipt + bales'}
              </button>
              <button onClick={() => { setReviews([]); setSource(null); setCsvName(null); setNotes([]) }} className="rounded-lg bg-white border border-slate-300 px-4 py-2">Discard</button>
              {anyAmbiguous && <span className="text-xs text-red-700">A load number is shared by two saved loads — merge them on Seed Cotton Loads, then re-check.</span>}
              {allAlreadySaved && !anyAmbiguous && <span className="text-xs text-slate-600">Every statement in this file is already saved. Tick &quot;Update that receipt&quot; to change one, or discard.</span>}
              {source && !anyAmbiguous && !allAlreadySaved && <span className="text-xs text-slate-400">Confirm against the document before saving.</span>}
              {csvName && !anyAmbiguous && !allAlreadySaved && reviews.some((rv) => !statementNamesGin(rv.s) && !rv.ginId) && <span className="text-xs text-amber-700">Pick the gin on each statement — the export does not name it.</span>}
            </div>
          </div>
        )}
        </div>
        )}
        {intake === 'hand' && (
      <form onSubmit={addManual} className="p-4 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <input placeholder="Statement # (if printed)" value={m.receipt_number} onChange={(e) => setM({ ...m, receipt_number: e.target.value })} className={inputCls} />
          <input type="date" value={m.receipt_date} onChange={(e) => setM({ ...m, receipt_date: e.target.value })} className={inputCls} aria-label="Statement date" />
          <select value={m.gin_id} onChange={(e) => setM({ ...m, gin_id: e.target.value })} className={inputCls}>
            <option value="">— gin —</option>
            {gins.map((g) => <option key={g.id} value={g.id}>{g.name}{g.gin_code ? ` (${g.gin_code})` : ''}</option>)}
          </select>
          <select value={m.farm_id} onChange={(e) => setM({ ...m, farm_id: e.target.value, field_id: '' })} className={inputCls}>
            <option value="">— farm —</option>
            {scope.farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select value={m.field_id} onChange={(e) => setM({ ...m, field_id: e.target.value })} className={inputCls}>
            <option value="">— field —</option>
            {scope.fields.filter((f) => !m.farm_id || f.farm_id === m.farm_id).map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
          </select>
          <input type="number" placeholder="Modules" value={m.modules} onChange={(e) => setM({ ...m, modules: e.target.value })} className={inputCls} />
          <input type="number" placeholder="Seed cotton lbs" value={m.seedwt} onChange={(e) => setM({ ...m, seedwt: e.target.value })} className={inputCls} />
          <input type="number" placeholder="Bales" value={m.bales} onChange={(e) => setM({ ...m, bales: e.target.value })} className={inputCls} />
          <input type="number" placeholder="Lint lbs" value={m.balewt} onChange={(e) => setM({ ...m, balewt: e.target.value })} className={inputCls} />
          <input type="number" placeholder="Cottonseed lbs" value={m.seedlbs} onChange={(e) => setM({ ...m, seedlbs: e.target.value })} className={inputCls} />
        </div>
        {scope.narrowed && scope.fields.length === 0 && (
          <p className="text-xs text-amber-700">
            No fields have cotton planted for {cropYear}, so there is no farm or field to pick yet.{' '}
            <Link href="/settings/plantings" className="underline">Add the cotton plantings</Link> and they show up here.
          </p>
        )}
        <p className="text-xs text-slate-500">A statement with no printed number is identified by its gin, farm, field, date and totals.</p>
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold">Add receipt</button>
      </form>
        )}
      </CottonSection>

      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      {msg && <p className="text-sm text-green-700" role="status">{msg}</p>}

      {yearReceipts.length === 0 ? (
        <EmptyState message={`No ${cropYear} gin receipts yet.`} hint="Upload the gin’s Statement of Ginning above — the bales and lint come from it." />
      ) : (
      <CottonSection title="Statements" sub={`${cropYear} crop · ${yearReceipts.length} statement${yearReceipts.length === 1 ? '' : 's'}`}>
        <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className={theadCls}><tr>{['Statement', 'Date', 'Gin', 'Farm', 'Field', 'Bales', 'Lint lbs', 'Turnout', 'Field lint / ac', ''].map((h, k) => <th key={h || k} className={`${k >= 5 && k <= 8 ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap`}>{h}</th>)}</tr></thead>
          <tbody>
            {yearReceipts.map((r) => {
              const sn = r.statement_number?.trim() || (isSynthesizedReceiptNumber(r.receipt_number) ? null : r.receipt_number)
              return (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    {sn ? <span className="font-mono">#{sn}</span> : <span className="text-slate-500 text-xs">no number printed</span>}
                    {receiptGinCode(r) && <span className="block text-xs text-slate-400">gin code {receiptGinCode(r)}</span>}
                  </td>
                  <td className="px-3 py-2">{r.receipt_date ? fmtDate(r.receipt_date) : '—'}</td>
                  <td className="px-3 py-2">{r.gin_id ? ginById.get(r.gin_id)?.name ?? '—' : '—'}</td>
                  <td className="px-3 py-2">{r.farm_id ? farmById.get(r.farm_id)?.name ?? '—' : r.printed_farm_number ? `#${r.printed_farm_number}` : '—'}</td>
                  <td className="px-3 py-2">{r.field_id ? fieldById.get(r.field_id)?.name_or_number ?? '—' : r.printed_field ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{balesByReceipt.get(r.id) ?? r.bales_count ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{lbs(r.total_bale_weight)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.lint_turnout_pct != null ? `${Number(r.lint_turnout_pct)}%` : '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {(() => { const y = fieldYields.yieldFor(r.field_id); return y ? <YieldFigure perAcre={y.lintPerAcre} basis={y.lintBasis} turnoutLabel={y.turnout.label} /> : <span className="text-slate-400">—</span> })()}
                  </td>
                  <td className="px-3 py-2 text-right"><button onClick={() => deleteReceipt(r.id)} className="text-red-600 text-xs min-h-11 px-2">Delete</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </CottonSection>
      )}
      {dialogs}
    </div>
  )
}

function LoadLineRow({ row, rv, onPatch }: { row: LineMatch; rv: StatementReview; onPatch: (p: Partial<StatementReview> | ((rv: StatementReview) => Partial<StatementReview>)) => void }) {
  const ln = row.line.load_number?.trim() ?? ''
  const tone =
    row.status === 'matched' ? 'text-green-700'
    : row.status === 'weight_differs' || row.status === 'suggested' || row.status === 'suggested_many' ? 'text-amber-700'
    : row.status === 'ambiguous' || row.status === 'on_other_receipt' || row.status === 'duplicate_line' ? 'text-red-700'
    : 'text-slate-600'
  const label =
    row.status === 'matched' ? `matches ${row.load!.load_number}`
    : row.status === 'weight_differs' ? `linked to ${row.load!.load_number}`
    : row.status === 'ambiguous' ? 'two saved loads share this number'
    : row.status === 'on_other_receipt' ? 'on another receipt'
    : row.status === 'suggested' ? 'no number match'
    : row.status === 'suggested_many' ? 'no number match'
    : row.status === 'duplicate_line' ? 'repeated in this table'
    : row.status === 'blank' ? 'no number read'
    : 'not in the app'
  const link = (loadId: string) => onPatch((cur) => { const n = new Map(cur.linked); n.set(row.index, loadId); return { linked: n } })
  const unlink = () => onPatch((cur) => { const n = new Map(cur.linked); n.delete(row.index); return { linked: n } })
  const userLinked = rv.linked.has(row.index)
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-1 py-1 font-mono">{ln || '—'}</td>
      <td className="px-1 py-1 text-right">{row.line.net == null ? '—' : Number(row.line.net).toLocaleString()}</td>
      <td className="px-1 py-1">
        <span className={tone}>{label}</span>
        {row.note && <span className={`block text-[11px] ${row.status === 'new' ? 'text-slate-400' : tone}`}>{row.note}</span>}
      </td>
      <td className="px-1 py-1">
        {canCreateLoad(row) && (
          <label className="flex items-center gap-1 min-h-7">
            <input type="checkbox" checked={rv.createMissing.has(row.index)} onChange={(e) => onPatch((cur) => { const n = new Set(cur.createMissing); if (e.target.checked) n.add(row.index); else n.delete(row.index); return { createMissing: n } })} />
            Create load
          </label>
        )}
        {(row.status === 'suggested' || row.status === 'suggested_many') && (
          <div className="flex flex-wrap gap-1">
            {row.candidates.map((c) => (
              <button key={c.id} type="button" onClick={() => link(c.id)} className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-900 min-h-7">Link {c.load_number}</button>
            ))}
          </div>
        )}
        {userLinked && <button type="button" onClick={unlink} className="rounded border border-slate-300 px-2 py-0.5 text-slate-700 min-h-7">Unlink</button>}
      </td>
    </tr>
  )
}
