'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { findBestMatch } from '@/lib/fuzzy'
import {
  MAX_PDF_BYTES,
  PdfTooLargeError,
  uploadPdfToStorage,
  type TicketExtraction,
  type TicketsExtraction,
} from '@/lib/pdf-upload'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeTickets } from '@/lib/parse-merge'
import { imagesToPdf } from '@/lib/image-capture'
import { practiceOf } from '@/lib/yields'
import { rememberHarvestEntryPath } from '@/lib/harvest-entry-path'
import { reportError } from '@/lib/friendly-error'
import { effectiveCropYear, resolveTicketDate, yearAssumedNote } from '@/lib/ticket-date'
import {
  cropConflictNote, cropForFieldOnDate, fieldDefaultNote, resolveTicketCrop,
  type CropProvenance, type FieldCropDefault,
} from '@/lib/load-crop-default'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import { ConfirmDialog } from '@/components/app-dialog'
import { fmtInt } from '@/components/reports/report-kit'
import type { Bin, Buyer, Contract, Crop, Field, FieldPlanting, Truck } from '@/lib/types'
import { buildTareStatsIndex, lowTareWarning, truckTareKey, type TareHistoryLoad } from '@/lib/truck-tare'
import { fetchTrucksTareHistory } from '@/lib/truck-tare-fetch'

type Row = {
  // What was read off the ticket, kept for display when no match is found.
  raw_truck: string | null
  raw_crop: string | null
  raw_from: string | null
  raw_to: string | null
  raw_date: string | null
  // Editable form state.
  date: string
  time: string
  ticket_number: string
  truck_id: string
  crop_id: string
  gross_weight: string
  tare_weight: string
  net_weight: string
  moisture: string
  test_weight: string
  from_type: '' | 'field' | 'bin'
  from_field_id: string
  from_bin_id: string
  to_type: '' | 'bin' | 'buyer'
  to_bin_id: string
  to_buyer_id: string
  contract_id: string
  practice: '' | 'irrigated' | 'dryland'
  // Review state (never stored): where the date's year and the crop came from.
  date_year_assumed: boolean
  date_problem: 'unreadable' | 'impossible' | null
  /** The crop the printed commodity fuzzy-matched (the paper evidence). */
  printed_crop_id: string | null
  crop_prov: CropProvenance
  /** The field's planting default for this row's field × crop year × date. */
  crop_default: FieldCropDefault | null
  /** The printed commodity names a crop the field is not planted to. */
  crop_conflict: { ticketCropId: string; fieldCropIds: string[] } | null
}

function numStr(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '' : String(n)
}

function num(s: string): number | null {
  if (s === '' || s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

type Refs = { crops: Crop[]; trucks: Truck[]; fields: Field[]; bins: Bin[]; buyers: Buyer[]; plantings: FieldPlanting[] }

/**
 * The crop rule on a row (lib/load-crop-default), re-run whenever the field,
 * the date, or the page's crop year changes — unless the user has picked the
 * crop ('user'), which nothing overwrites. Order: the date is already
 * resolved → the crop year (the existing rule: the page's crop year, else the
 * date's year) → the field's planting → precedence against the printed crop.
 * Rows sourced from a bin have no field default and keep the printed crop.
 */
function applyCropRule(r: Row, refs: Refs, pageCropYear: string): Row {
  if (r.crop_prov === 'user') return r
  const cropYear = effectiveCropYear(pageCropYear, r.date || null)
  const fieldDefault = r.from_type === 'field' && r.from_field_id
    ? cropForFieldOnDate({ plantings: refs.plantings, crops: refs.crops, fieldId: r.from_field_id, cropYear, date: r.date || null })
    : null
  const res = resolveTicketCrop({ printedCropId: r.printed_crop_id, fieldDefault, fallbackCropId: r.printed_crop_id ?? '' })
  return { ...r, crop_id: res.cropId, crop_prov: res.provenance, crop_default: fieldDefault, crop_conflict: res.conflict }
}

function ticketToRow(t: TicketExtraction, refs: Refs, pageCropYear: string, today: Date): Row {
  const { crops, trucks, fields, bins, buyers } = refs
  // The printed commodity is evidence on paper — matched, then weighed
  // against the field's plantings in applyCropRule.
  const printedCrop = findBestMatch(t.crop, crops, (c) => c.name)
  const truck = findBestMatch(t.truck, trucks, (tr) => tr.name_or_number)

  // From: type as read, fallback to inferring from name match.
  let from_type: '' | 'field' | 'bin' = (t.from_type as any) || ''
  let from_field_id = ''
  let from_bin_id = ''
  if (t.from_name) {
    const fieldHit = findBestMatch(t.from_name, fields, (f) => f.name_or_number)
    const binHit = findBestMatch(t.from_name, bins, (b) => b.name_or_number)
    if (from_type === 'field' && fieldHit) from_field_id = fieldHit.id
    else if (from_type === 'bin' && binHit) from_bin_id = binHit.id
    else if (!from_type) {
      if (fieldHit) { from_type = 'field'; from_field_id = fieldHit.id }
      else if (binHit) { from_type = 'bin'; from_bin_id = binHit.id }
    }
  }

  let to_type: '' | 'bin' | 'buyer' = (t.to_type as any) || ''
  let to_bin_id = ''
  let to_buyer_id = ''
  if (t.to_name) {
    const binHit = findBestMatch(t.to_name, bins, (b) => b.name_or_number)
    const buyerHit = findBestMatch(t.to_name, buyers, (b) => b.name)
    if (to_type === 'bin' && binHit) to_bin_id = binHit.id
    else if (to_type === 'buyer' && buyerHit) to_buyer_id = buyerHit.id
    else if (!to_type) {
      if (buyerHit) { to_type = 'buyer'; to_buyer_id = buyerHit.id }
      else if (binHit) { to_type = 'bin'; to_bin_id = binHit.id }
    }
  }

  // Net = gross - tare if missing.
  let net = t.net_weight
  if (net == null && t.gross_weight != null && t.tare_weight != null) {
    net = +(t.gross_weight - t.tare_weight).toFixed(2)
  }

  // The date exactly as printed → a load date. THE CODE decides the year:
  // printed → as printed; missing → this year (last year when that would put
  // the ticket more than a week ahead); unreadable or impossible → blank, so
  // the row needs a look instead of silently landing on today.
  const dateText = t.date_text ?? t.date ?? null
  const resolved = resolveTicketDate(dateText, today, { yearPrinted: t.year_printed })

  const base: Row = {
    raw_truck: t.truck,
    raw_crop: t.crop,
    raw_from: t.from_name,
    raw_to: t.to_name,
    raw_date: dateText,
    date: resolved.date ?? '',
    time: t.time && /^\d{2}:\d{2}$/.test(t.time) ? t.time : '',
    ticket_number: t.ticket_number ?? '',
    truck_id: truck?.id ?? '',
    crop_id: printedCrop?.id ?? '',
    gross_weight: numStr(t.gross_weight),
    tare_weight: numStr(t.tare_weight),
    net_weight: numStr(net),
    moisture: numStr(t.moisture),
    test_weight: numStr(t.test_weight),
    from_type,
    from_field_id,
    from_bin_id,
    to_type,
    to_bin_id,
    to_buyer_id,
    contract_id: '',
    practice: '',
    date_year_assumed: resolved.yearAssumed,
    date_problem: resolved.problem,
    printed_crop_id: printedCrop?.id ?? null,
    crop_prov: printedCrop ? 'ticket' : 'fallback',
    crop_default: null,
    crop_conflict: null,
  }
  return applyCropRule(base, refs, pageCropYear)
}

function rowStatus(r: Row, cropYear: string): 'ready' | 'review' {
  if (!cropYear) return 'review'
  if (!r.date) return 'review'
  if (!r.crop_id) return 'review'
  // The ticket names one crop and the field is planted to another: a person decides.
  if (r.crop_conflict && r.crop_prov !== 'user') return 'review'
  if (!r.truck_id) return 'review'
  const net = num(r.net_weight)
  if (net == null || net <= 0) return 'review'
  if (r.from_type === 'field' && !r.from_field_id) return 'review'
  if (r.from_type === 'bin' && !r.from_bin_id) return 'review'
  if (!r.from_type) return 'review'
  if (r.to_type === 'bin' && !r.to_bin_id) return 'review'
  if (r.to_type === 'buyer' && !r.to_buyer_id) return 'review'
  if (!r.to_type) return 'review'
  return 'ready'
}

const COLUMNS = ['Status', 'Date', 'Time', 'Ticket #', 'Truck', 'Crop', 'Gross lb', 'Tare lb', 'Net lb', 'Moisture %', 'Test wt', 'From', 'To', 'Contract', 'Bushels', ''] as const

// A labelled cell in the stacked-card layout. Module-level on purpose: a
// component defined inside render remounts its inputs on every keystroke.
function Field({ label, children, span }: { label: string; children: ReactNode; span?: boolean }) {
  return (
    <div className={span ? 'col-span-2' : ''}>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      {children}
    </div>
  )
}

export default function ScanTicketsPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const [trucks, setTrucks] = useState<Truck[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [bins, setBins] = useState<Bin[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [refsLoaded, setRefsLoaded] = useState(false)

  const [cropYear, setCropYear] = useState<string>('')
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [readStage, setReadStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const [saveAsk, setSaveAsk] = useState(false)
  const [saveSummary, setSaveSummary] = useState<{ savedCount: number; remaining: number } | null>(null)
  const savedIdsRef = useRef<string[]>([])
  // Tare history for the trucks on the review rows (lib/truck-tare): a
  // mis-read tare gets the low-tare badge before save. Advisory only.
  const [tareHistory, setTareHistory] = useState<TareHistoryLoad[]>([])
  const fetchedTruckIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    ;(async () => {
      const [t, c, f, b, by, ct, pl, recent] = await Promise.all([
        supabase.from('trucks').select('*').order('name_or_number'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('fields').select('*').order('name_or_number'),
        supabase.from('bins').select('*').order('name_or_number'),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('contracts').select('*').order('contract_number'),
        supabase.from('field_plantings').select('*'),
        supabase
          .from('loads')
          .select('crop_year')
          .order('date', { ascending: false })
          .order('time', { ascending: false })
          .limit(1),
      ])
      setTrucks((t.data as Truck[]) || [])
      setCrops((c.data as Crop[]) || [])
      setFields((f.data as Field[]) || [])
      setBins((b.data as Bin[]) || [])
      setBuyers((by.data as Buyer[]) || [])
      setContracts((ct.data as Contract[]) || [])
      const pls = (pl.data as FieldPlanting[]) || []
      setPlantings(pls)
      const recentYear = (recent.data as Array<{ crop_year: number | null }> | null)?.[0]?.crop_year
      if (recentYear != null) setCropYear(String(recentYear))
      else if (pls[0]) setCropYear(String(pls[0].season_year))
      setRefsLoaded(true)
    })()
  }, [supabase])

  const refs: Refs = useMemo(() => ({ crops, trucks, fields, bins, buyers, plantings }), [crops, trucks, fields, bins, buyers, plantings])

  const seasonYearOptions = useMemo(
    () =>
      cropYearOptionsFromPlantings(
        plantings.map((p) => p.season_year),
        cropYear === '' ? null : Number(cropYear),
      ),
    [plantings, cropYear],
  )

  // The page's crop year is part of the crop rule (which plantings count), so
  // changing it re-runs the rule on every row the user hasn't settled.
  function changeCropYear(v: string) {
    setCropYear(v)
    setRows((rs) => rs.map((r) => applyCropRule(r, refs, v)))
  }

  function fieldsForCrop(crop_id: string, keepFieldId = ''): Field[] {
    if (!crop_id) return fields
    const yearNum = cropYear === '' ? null : Number(cropYear)
    const ids = new Set(
      plantings
        .filter((p) => p.crop_id === crop_id && (yearNum == null || p.season_year === yearNum))
        .map((p) => p.field_id),
    )
    // The row's own field stays listed even when it is planted to another
    // crop — that is exactly the conflict the row is flagged for.
    if (keepFieldId) ids.add(keepFieldId)
    return fields.filter((f) => ids.has(f.id))
  }

  function binsForCrop(crop_id: string): Bin[] {
    if (!crop_id) return bins
    return bins.filter((b) => b.crop_id === crop_id)
  }

  // Mixed-practice check for the optional Irrigated/Dryland tag: only fields
  // whose planting (for the row's crop + the page's crop year) has both
  // irrigated and dryland acres get the toggle — pure fields never ask.
  function isMixedField(field_id: string, crop_id: string): boolean {
    if (!field_id || !crop_id) return false
    const yearNum = cropYear === '' ? null : Number(cropYear)
    const matches = plantings.filter(
      (p) =>
        p.field_id === field_id &&
        p.crop_id === crop_id &&
        (yearNum == null || p.season_year === yearNum),
    )
    if (matches.length === 0) return false
    const planting = matches.sort((a, b) => b.season_year - a.season_year)[0]
    return practiceOf(planting) === 'mixed'
  }

  function contractsFor(buyer_id: string, crop_id: string): Contract[] {
    const y = cropYear === '' ? null : Number(cropYear)
    if (y == null) return []
    return contracts.filter(
      (c) =>
        (!buyer_id || c.buyer_id === buyer_id) &&
        (!crop_id || c.crop_id === crop_id) &&
        c.crop_year === y,
    )
  }

  async function onSource(src: DocumentSource) {
    setErr(null)
    setBanner(null)
    setSaveSummary(null)
    if (src.kind === 'pdf' && src.file.size > MAX_PDF_BYTES) {
      setErr('That PDF is larger than 20 MB. Please use a smaller file.')
      return
    }
    setSource(src)
    setRows([])
    setReadStage('Reading the tickets…')
    try {
      await new Promise((r) => setTimeout(r, 250))
      setReadStage('Reading the tickets…')
      // Chunked parse for big ticket stacks (PDF pages or photo batches):
      // per-chunk retry, failed pages reported, a ticket repeated across a
      // batch boundary resolves once (mergeTickets).
      const { data, warning } = await parseDocumentChunked<TicketsExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'tickets',
        { onProgress: setReadStage, merge: mergeTickets },
      )
      const tickets = Array.isArray(data.tickets) ? data.tickets : []
      if (tickets.length === 0) {
        setErr(warning ?? 'No tickets were found in this document. The photo may be too blurry, or the layout may not be readable.')
        return
      }
      if (warning) setErr(warning)
      const today = new Date()
      const next = tickets.map((t) => ticketToRow(t, refs, cropYear, today))
      setRows(next)
      setBanner(`Turnrow read ${next.length} ticket${next.length === 1 ? '' : 's'} — please check them against the original before saving.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else {
        reportError(e, { action: 'read these tickets' })
        setErr("Turnrow couldn't read this document. Try a clearer photo or scan, or enter the loads at New Load.")
      }
    } finally {
      setReadStage(null)
    }
  }

  function discard() {
    setSource(null)
    setRows([])
    setBanner(null)
    setErr(null)
    setSaveSummary(null)
  }

  // Pull history for any truck newly present on the review rows (once per
  // truck per session); the stats index recomputes from it.
  useEffect(() => {
    const missing = Array.from(new Set(rows.map((r) => r.truck_id).filter((id) => id && !fetchedTruckIdsRef.current.has(id))))
    if (missing.length === 0) return
    for (const id of missing) fetchedTruckIdsRef.current.add(id)
    let cancelled = false
    ;(async () => {
      const loads = await fetchTrucksTareHistory(supabase, missing)
      if (!cancelled) setTareHistory((prev) => [...prev, ...loads])
    })()
    return () => { cancelled = true }
  }, [rows, supabase])
  const tareStatsIndex = useMemo(() => buildTareStatsIndex(tareHistory), [tareHistory])

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((rs) =>
      rs.map((r, j) => {
        if (i !== j) return r
        let next: Row = { ...r, ...patch }
        // Auto-recompute net when gross or tare changes via this update.
        if ('gross_weight' in patch || 'tare_weight' in patch) {
          const g = num(next.gross_weight)
          const tr = num(next.tare_weight)
          if (g != null && tr != null) next.net_weight = String(+(g - tr).toFixed(2))
        }
        // The user picked the crop: it is theirs from here on — nothing
        // (field change, date change, crop year change) overwrites it.
        if ('crop_id' in patch) {
          next.crop_prov = 'user'
          next.crop_conflict = null
        }
        // A typed date clears the "year assumed" chip and any read problem.
        if ('date' in patch) {
          next.date_year_assumed = false
          next.date_problem = null
        }
        // Field, source type, or date changed → re-run the crop rule (unless
        // the user has chosen the crop).
        if ('from_field_id' in patch || 'from_type' in patch || 'date' in patch) {
          next = applyCropRule(next, refs, cropYear)
        }
        // When crop changes, drop selections that no longer fit the crop filter.
        if ('crop_id' in patch) {
          const ff = fieldsForCrop(next.crop_id)
          const bb = binsForCrop(next.crop_id)
          if (next.from_field_id && !ff.some((x) => x.id === next.from_field_id)) next.from_field_id = ''
          if (next.from_bin_id && !bb.some((x) => x.id === next.from_bin_id)) next.from_bin_id = ''
          if (next.to_bin_id && !bb.some((x) => x.id === next.to_bin_id)) next.to_bin_id = ''
          next.contract_id = ''
        }
        if ('to_buyer_id' in patch) next.contract_id = ''
        // The practice tag belongs to a specific mixed field — drop it when the
        // field/crop changes or the field is no longer mixed.
        if (('from_field_id' in patch || 'crop_id' in patch || 'from_type' in patch) &&
            !isMixedField(next.from_type === 'field' ? next.from_field_id : '', next.crop_id)) {
          next.practice = ''
        }
        return next
      }),
    )
  }

  function deleteRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i))
  }

  function statusFor(r: Row) {
    return rowStatus(r, cropYear)
  }

  const readyCount = rows.filter((r) => statusFor(r) === 'ready').length
  const reviewCount = rows.length - readyCount

  function askSave() {
    if (readyCount === 0) {
      setErr('No tickets are ready to save yet.')
      return
    }
    setSaveAsk(true)
  }

  async function saveAll() {
    setSaveAsk(false)
    setSaving(true)
    setErr(null)
    setBanner(null)

    let pdfUrl: string | null = null
    if (source) {
      try {
        const fileToStore = source.kind === 'pdf'
          ? source.file
          : await imagesToPdf(source.images, 'tickets')
        pdfUrl = await uploadPdfToStorage(supabase, fileToStore, 'tickets')
      } catch (e: any) {
        setSaving(false)
        setErr(reportError(e, { action: 'store the ticket document' }))
        return
      }
    }

    const cropYearNum = Number(cropYear)
    const readyIdx: number[] = []
    const payloads = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => statusFor(r) === 'ready')
      .map(({ r, i }) => {
        readyIdx.push(i)
        return {
          date: r.date,
          time: r.time || null,
          truck_id: r.truck_id || null,
          // Truck name snapshot at save time (071) — renames never rewrite history.
          truck_label: r.truck_id ? trucks.find((t) => t.id === r.truck_id)?.name_or_number ?? null : null,
          crop_id: r.crop_id || null,
          crop_year: cropYearNum,
          gross_weight: num(r.gross_weight),
          tare_weight: num(r.tare_weight),
          net_weight: num(r.net_weight),
          moisture: num(r.moisture),
          test_weight: num(r.test_weight),
          bushels: null,
          dry_bushels_override: null,
          from_type: r.from_type || null,
          from_field_id: r.from_type === 'field' ? r.from_field_id || null : null,
          from_bin_id: r.from_type === 'bin' ? r.from_bin_id || null : null,
          to_type: r.to_type || null,
          to_bin_id: r.to_type === 'bin' ? r.to_bin_id || null : null,
          to_buyer_id: r.to_type === 'buyer' ? r.to_buyer_id || null : null,
          contract_id: r.to_type === 'buyer' ? r.contract_id || null : null,
          ticket_number: r.ticket_number || null,
          source_pdf_url: pdfUrl,
          practice:
            r.from_type === 'field' && isMixedField(r.from_field_id, r.crop_id)
              ? r.practice || null
              : null,
        }
      })

    // Stamp who entered them (073 — per-user last-load defaults). Retries
    // without the column so an unapplied migration degrades, never fails.
    const { data: { user } } = await supabase.auth.getUser()
    const stamped = user?.id ? payloads.map((p) => ({ ...p, created_by: user.id })) : payloads
    let res = await supabase.from('loads').insert(stamped).select('id')
    if (res.error && user?.id && res.error.message.includes('created_by')) {
      res = await supabase.from('loads').insert(payloads).select('id')
    }
    const { data, error } = res
    setSaving(false)
    if (error) {
      setErr(reportError(error, { action: 'save these loads', noun: 'load' }))
      return
    }
    savedIdsRef.current = (data as Array<{ id: string }> | null)?.map((d) => d.id) ?? []
    rememberHarvestEntryPath('load')
    // Drop saved rows; keep unready rows for the user to finish.
    const remaining = rows.filter((r) => statusFor(r) !== 'ready')
    setRows(remaining)
    setSaveSummary({ savedCount: payloads.length, remaining: remaining.length })
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 min-h-11 text-base xl:text-sm w-full bg-white'
  const toggleCls = (active: boolean) =>
    `flex-1 text-sm px-2 min-h-11 rounded-lg border ${active ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white border-slate-300'}`
  const hl = (cond: boolean) => (cond ? 'bg-amber-50 rounded-lg' : '')
  const readHint = (text: string | null) => text ? <div className="text-xs text-amber-700 mt-1">Ticket says “{text}”</div> : null

  const cropName = (id: string) => crops.find((c) => c.id === id)?.name ?? '—'
  const quickPick = (i: number, id: string, label?: string) => (
    <button key={id} type="button" onClick={() => updateRow(i, { crop_id: id })} className="inline-flex items-center min-h-10 px-2 rounded-lg border border-slate-300 bg-white text-brand-deep text-xs font-semibold no-print">
      {label ?? `Use ${cropName(id)}`}
    </button>
  )
  // Where the row's crop came from, in plain words — and the one-tap switches.
  function cropNote(r: Row, i: number): ReactNode {
    const rowCropYear = effectiveCropYear(cropYear, r.date || null)
    const fieldName = r.from_type === 'field' && r.from_field_id ? fields.find((f) => f.id === r.from_field_id)?.name_or_number ?? 'this field' : null
    const d = r.crop_default
    if (r.crop_prov === 'user') return null
    // 3. Paper says one crop, the field is planted to another: keep the
    //    ticket's crop, flag it, offer the field's crop(s).
    if (r.crop_conflict && r.crop_id) {
      return (
        <div className="text-xs text-amber-800 space-y-1">
          <div>{cropConflictNote({ ticketCrop: cropName(r.crop_id), fieldName: fieldName ?? 'this field', fieldCrops: r.crop_conflict.fieldCropIds.map(cropName), cropYear: rowCropYear })}</div>
          <div className="flex flex-wrap gap-1">{r.crop_conflict.fieldCropIds.map((id) => quickPick(i, id))}</div>
        </div>
      )
    }
    // 1. From the ticket, and the field agrees.
    if (r.crop_prov === 'ticket' && r.crop_id) {
      return <div className="text-xs text-slate-500">{d && d.fieldCropIds.includes(r.crop_id) ? 'from ticket, matches field' : 'from ticket'}</div>
    }
    // 2. From the field's planting — the spring/fall pair offers the switch.
    if (r.crop_prov === 'field_planting' && d?.cropId) {
      return (
        <div className="text-xs text-slate-500 flex flex-wrap items-center gap-1">
          <span>{d.reason === 'spring_fall_by_date' ? fieldDefaultNote(d, cropName, rowCropYear) : `from field (${rowCropYear ?? ''} planting)`}</span>
          {d.reason === 'spring_fall_by_date' && d.alternatives.map((id) => quickPick(i, id, `Switch to ${cropName(id)}`))}
        </div>
      )
    }
    // 4. Nothing decided it: say why, with the field's crops as quick picks.
    if (!r.crop_id) {
      const note = d ? fieldDefaultNote(d, cropName, rowCropYear) : null
      return (
        <div className="text-xs text-amber-700 space-y-1">
          {note && <div>{note}</div>}
          {d && d.alternatives.length > 0 && <div className="flex flex-wrap gap-1">{d.alternatives.map((id) => quickPick(i, id))}</div>}
          {readHint(r.raw_crop)}
        </div>
      )
    }
    return null
  }

  // One set of controls per ticket, rendered into the wide table (xl+) and
  // into stacked cards (below xl) — the same inputs, two layouts.
  function fieldsFor(r: Row, i: number): Record<(typeof COLUMNS)[number], ReactNode> & { tareWarn: string | null } {
    const st = statusFor(r)
    const crop = crops.find((c) => c.id === r.crop_id)
    const { wetBushels, dryBushels } = computeBushels({
      netWeightLb: num(r.net_weight),
      moisturePct: num(r.moisture),
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
    })
    const ff = fieldsForCrop(r.crop_id, r.from_type === 'field' ? r.from_field_id : '')
    const bb = binsForCrop(r.crop_id)
    const cc = contractsFor(r.to_buyer_id, r.crop_id)
    const tareWarn = lowTareWarning(num(r.tare_weight), tareStatsIndex.get(truckTareKey({ truck_id: r.truck_id }) ?? ''))
    const fromMissing = !r.from_type || (r.from_type === 'field' && !r.from_field_id) || (r.from_type === 'bin' && !r.from_bin_id)
    const toMissing = !r.to_type || (r.to_type === 'bin' && !r.to_bin_id) || (r.to_type === 'buyer' && !r.to_buyer_id)
    return {
      tareWarn,
      Status: st === 'ready' ? (
        <span className="inline-block rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs font-semibold">Ready</span>
      ) : (
        <span className="inline-block rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-semibold">Needs a look</span>
      ),
      Date: (
        <div className={hl(!r.date)}>
          <input type="date" aria-label="Date" value={r.date} onChange={(e) => updateRow(i, { date: e.target.value })} className={inputCls} />
          {r.date && r.date_year_assumed && <div className="text-xs text-amber-700 mt-1">{yearAssumedNote(r.date)}</div>}
          {!r.date && r.date_problem && (
            <div className="text-xs text-amber-700 mt-1">{r.date_problem === 'impossible' ? "That isn't a real date" : "Couldn't read the date"}{r.raw_date ? ` — ticket says “${r.raw_date}”` : ''}</div>
          )}
        </div>
      ),
      Time: <input type="time" aria-label="Time" value={r.time} onChange={(e) => updateRow(i, { time: e.target.value })} className={inputCls} />,
      'Ticket #': <input aria-label="Ticket number" value={r.ticket_number} onChange={(e) => updateRow(i, { ticket_number: e.target.value })} className={inputCls} />,
      Truck: (
        <div className={hl(!r.truck_id)}>
          <select aria-label="Truck" value={r.truck_id} onChange={(e) => updateRow(i, { truck_id: e.target.value })} className={inputCls}>
            <option value="">— select —</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.name_or_number}</option>)}
          </select>
          {!r.truck_id && readHint(r.raw_truck)}
        </div>
      ),
      Crop: (
        <div className={`${hl(!r.crop_id || (r.crop_conflict != null && r.crop_prov !== 'user'))} space-y-1`}>
          <select aria-label="Crop" value={r.crop_id} onChange={(e) => updateRow(i, { crop_id: e.target.value })} className={inputCls}>
            <option value="">— select —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {cropNote(r, i)}
        </div>
      ),
      'Gross lb': <input type="number" step="0.01" inputMode="decimal" aria-label="Gross pounds" value={r.gross_weight} onChange={(e) => updateRow(i, { gross_weight: e.target.value })} className={`${inputCls} tabular-nums`} />,
      'Tare lb': (
        <div className={hl(!!tareWarn)}>
          <input type="number" step="0.01" inputMode="decimal" aria-label="Tare pounds" value={r.tare_weight} onChange={(e) => updateRow(i, { tare_weight: e.target.value })} className={`${inputCls} tabular-nums ${tareWarn ? 'border-amber-400' : ''}`} />
          {tareWarn && (
            <div className="mt-1" title={tareWarn}>
              <span className="inline-block rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-semibold">Low tare?</span>
              <div className="text-xs text-amber-800 mt-0.5 max-w-[220px]">{tareWarn}</div>
            </div>
          )}
        </div>
      ),
      'Net lb': <input type="number" step="0.01" inputMode="decimal" aria-label="Net pounds" value={r.net_weight} onChange={(e) => updateRow(i, { net_weight: e.target.value })} className={`${inputCls} tabular-nums ${hl((num(r.net_weight) ?? 0) <= 0)}`} />,
      'Moisture %': <input type="number" step="0.01" inputMode="decimal" aria-label="Moisture percent" value={r.moisture} onChange={(e) => updateRow(i, { moisture: e.target.value })} className={`${inputCls} tabular-nums`} />,
      'Test wt': <input type="number" step="0.01" inputMode="decimal" aria-label="Test weight" value={r.test_weight} onChange={(e) => updateRow(i, { test_weight: e.target.value })} className={`${inputCls} tabular-nums`} />,
      From: (
        <div className={`${hl(fromMissing)} space-y-1`}>
          <div className="flex gap-1">
            {(['field', 'bin'] as const).map((typ) => (
              <button key={typ} type="button" onClick={() => updateRow(i, { from_type: typ })} aria-pressed={r.from_type === typ} className={toggleCls(r.from_type === typ)}>
                {typ === 'field' ? 'Field' : 'Bin'}
              </button>
            ))}
          </div>
          {r.from_type === 'field' && (
            <select aria-label="From field" value={r.from_field_id} onChange={(e) => updateRow(i, { from_field_id: e.target.value })} className={inputCls}>
              <option value="">— select field —</option>
              {ff.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
            </select>
          )}
          {r.from_type === 'field' && isMixedField(r.from_field_id, r.crop_id) && (
            <div className="flex gap-1">
              {(['irrigated', 'dryland'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => updateRow(i, { practice: r.practice === p ? '' : p })}
                  aria-pressed={r.practice === p}
                  className={toggleCls(r.practice === p)}
                  title="Optional — this field has both irrigated and dryland acres"
                >
                  {p === 'irrigated' ? 'Irrigated' : 'Dryland'}
                </button>
              ))}
            </div>
          )}
          {r.from_type === 'bin' && (
            <select aria-label="From bin" value={r.from_bin_id} onChange={(e) => updateRow(i, { from_bin_id: e.target.value })} className={inputCls}>
              <option value="">— select bin —</option>
              {bb.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
            </select>
          )}
          {fromMissing && readHint(r.raw_from)}
        </div>
      ),
      To: (
        <div className={`${hl(toMissing)} space-y-1`}>
          <div className="flex gap-1">
            {(['bin', 'buyer'] as const).map((typ) => (
              <button key={typ} type="button" onClick={() => updateRow(i, { to_type: typ })} aria-pressed={r.to_type === typ} className={toggleCls(r.to_type === typ)}>
                {typ === 'bin' ? 'Bin' : 'Buyer'}
              </button>
            ))}
          </div>
          {r.to_type === 'bin' && (
            <select aria-label="To bin" value={r.to_bin_id} onChange={(e) => updateRow(i, { to_bin_id: e.target.value })} className={inputCls}>
              <option value="">— select bin —</option>
              {bb.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
            </select>
          )}
          {r.to_type === 'buyer' && (
            <select aria-label="Buyer" value={r.to_buyer_id} onChange={(e) => updateRow(i, { to_buyer_id: e.target.value })} className={inputCls}>
              <option value="">— select buyer —</option>
              {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          {toMissing && readHint(r.raw_to)}
        </div>
      ),
      Contract: r.to_type === 'buyer' ? (
        <select
          aria-label="Contract"
          value={r.contract_id}
          onChange={(e) => updateRow(i, { contract_id: e.target.value })}
          className={inputCls}
          disabled={!cropYear}
        >
          <option value="">{cropYear ? '— none —' : 'Select crop year first'}</option>
          {cc.map((c) => <option key={c.id} value={c.id}>{c.contract_number}</option>)}
        </select>
      ) : (
        <span className="text-xs text-slate-400">—</span>
      ),
      Bushels: (
        <div className="text-right tabular-nums whitespace-nowrap">
          <div className="text-xs text-slate-500">wet</div>
          <div>{wetBushels != null ? fmtInt(wetBushels) : '—'}</div>
          <div className="text-xs text-slate-500 mt-1">dry</div>
          <div className="font-semibold">{dryBushels != null ? fmtInt(dryBushels) : '—'}</div>
        </div>
      ),
      '': (
        <button type="button" onClick={() => deleteRow(i)} className="text-red-600 text-base min-h-11 min-w-11 rounded-lg" aria-label={`Remove ticket ${r.ticket_number || i + 1}`}>✕</button>
      ),
    }
  }

  const hasRows = rows.length > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Scan tickets</h1>
        <Link href="/loads/new" className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm">
          Enter by hand
        </Link>
        <Link href="/loads" className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm">
          Cancel
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-slate-700">
            Crop year
            <select
              value={cropYear}
              onChange={(e) => changeCropYear(e.target.value)}
              className="mt-1 w-40 rounded-lg border border-slate-300 px-3 min-h-11 text-base bg-white"
            >
              <option value="">— select —</option>
              {seasonYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <DocumentCapture
            onSource={onSource}
            busy={readStage != null}
            stageLabel={readStage}
            pdfLabel="Upload ticket PDF or photo"
          />
          {source && !readStage && (
            <button
              type="button"
              onClick={discard}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 min-h-11"
            >
              Start over
            </button>
          )}
          <div className="flex-1" />
          {refsLoaded && hasRows && (
            <div className="text-sm text-slate-600">
              <span className="font-semibold text-green-700">{readyCount}</span> ready ·{' '}
              <span className="font-semibold text-amber-700">{reviewCount}</span> need a look
            </div>
          )}
        </div>

        {banner && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
            {banner}
          </div>
        )}
        {saveSummary && (
          <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-900 flex items-center gap-3 flex-wrap">
            <span>{saveSummary.savedCount} load{saveSummary.savedCount === 1 ? '' : 's'} saved.</span>
            <Link href="/loads" className="underline">View the load list</Link>
            {saveSummary.remaining > 0 && (
              <span className="text-amber-800">
                {saveSummary.remaining} ticket{saveSummary.remaining === 1 ? '' : 's'} still need a look — finish and save again, or start over.
              </span>
            )}
          </div>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>

      {!source && !readStage && !hasRows && (
        <div className="bg-white rounded-xl shadow p-6 text-center text-slate-500">
          Take a photo or upload a PDF of your scale tickets. Each ticket becomes one load you can check and fix before saving.
        </div>
      )}

      {(source || hasRows) && (
        <div className="flex flex-col xl:grid xl:grid-cols-2 gap-4">
          {/* Source preview: ABOVE the tickets below xl, beside them at xl+. */}
          <div className="order-first xl:order-last xl:sticky xl:top-3 self-start w-full h-[45vh] xl:h-[80vh] min-h-[280px] xl:min-h-[400px]">
            <div className="text-xs text-slate-500 mb-1">The original — check each ticket against it</div>
            <SourcePreview source={source} className="h-full" title="Tickets" />
          </div>

          {/* Wide table at xl+. */}
          <div className="hidden xl:block bg-white rounded-xl shadow p-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {COLUMNS.map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {!hasRows && (
                  <tr><td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-slate-400">
                    {readStage ? 'Working…' : 'No tickets yet — take a photo or upload a PDF.'}
                  </td></tr>
                )}
                {rows.map((r, i) => {
                  const f = fieldsFor(r, i)
                  return (
                    <tr key={i} className="border-t border-slate-100 align-top">
                      <td className="px-2 py-1 whitespace-nowrap">{f.Status}</td>
                      <td className="px-2 py-1" style={{ minWidth: 130 }}>{f.Date}</td>
                      <td className="px-2 py-1" style={{ minWidth: 100 }}>{f.Time}</td>
                      <td className="px-2 py-1" style={{ minWidth: 110 }}>{f['Ticket #']}</td>
                      <td className="px-2 py-1" style={{ minWidth: 130 }}>{f.Truck}</td>
                      <td className="px-2 py-1" style={{ minWidth: 130 }}>{f.Crop}</td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>{f['Gross lb']}</td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>{f['Tare lb']}</td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>{f['Net lb']}</td>
                      <td className="px-2 py-1" style={{ minWidth: 80 }}>{f['Moisture %']}</td>
                      <td className="px-2 py-1" style={{ minWidth: 80 }}>{f['Test wt']}</td>
                      <td className="px-2 py-1" style={{ minWidth: 200 }}>{f.From}</td>
                      <td className="px-2 py-1" style={{ minWidth: 200 }}>{f.To}</td>
                      <td className="px-2 py-1" style={{ minWidth: 140 }}>{f.Contract}</td>
                      <td className="px-2 py-1" style={{ minWidth: 110 }}>{f.Bushels}</td>
                      <td className="px-2 py-1">{f['']}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Stacked cards below xl — one ticket per card, fields labelled. */}
          <div className="xl:hidden space-y-3">
            {!hasRows && (
              <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">
                {readStage ? 'Working…' : 'No tickets yet — take a photo or upload a PDF.'}
              </div>
            )}
            {rows.map((r, i) => {
              const f = fieldsFor(r, i)
              return (
                <div key={i} className="bg-white rounded-xl shadow p-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-700 flex-1">Ticket {i + 1}{r.ticket_number ? ` · #${r.ticket_number}` : ''}</span>
                    {f.Status}
                    {f['']}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Date">{f.Date}</Field>
                    <Field label="Time">{f.Time}</Field>
                    <Field label="Ticket #">{f['Ticket #']}</Field>
                    <Field label="Truck">{f.Truck}</Field>
                    <Field label="Crop" span>{f.Crop}</Field>
                    <Field label="Gross lb">{f['Gross lb']}</Field>
                    <Field label="Tare lb">{f['Tare lb']}</Field>
                    <Field label="Net lb">{f['Net lb']}</Field>
                    <Field label="Moisture %">{f['Moisture %']}</Field>
                    <Field label="Test wt">{f['Test wt']}</Field>
                    <Field label="Bushels"><div className="flex justify-end">{f.Bushels}</div></Field>
                    <Field label="From" span>{f.From}</Field>
                    <Field label="To" span>{f.To}</Field>
                    {r.to_type === 'buyer' && <Field label="Contract" span>{f.Contract}</Field>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {hasRows && (
        <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-white/95 backdrop-blur border-t border-slate-200 flex flex-wrap items-center gap-3 no-print">
          <div className="text-sm text-slate-700 flex-1">
            <span className="font-semibold text-green-700">{readyCount}</span> ready ·{' '}
            <span className="font-semibold text-amber-700">{reviewCount}</span> need a look
            {!cropYear && <span className="ml-2 text-red-600">Pick a crop year above.</span>}
          </div>
          <button
            type="button"
            onClick={askSave}
            disabled={saving || readyCount === 0 || !cropYear}
            className="rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold min-h-12 px-5 disabled:opacity-50"
          >
            {saving ? 'Saving…' : `Save ${readyCount} load${readyCount === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            onClick={() => router.push('/loads')}
            className="rounded-xl bg-white border border-slate-300 px-4 min-h-12 text-sm"
          >
            Done
          </button>
        </div>
      )}

      <ConfirmDialog
        open={saveAsk}
        title={`Save ${readyCount} load${readyCount === 1 ? '' : 's'}?`}
        body={reviewCount > 0
          ? `${reviewCount} ticket${reviewCount === 1 ? '' : 's'} still need a look and won’t be saved yet — they stay on screen so you can finish them.`
          : undefined}
        confirmLabel="Save"
        onConfirm={() => void saveAll()}
        onCancel={() => setSaveAsk(false)}
      />
    </div>
  )
}
