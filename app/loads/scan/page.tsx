'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import type { Bin, Buyer, Contract, Crop, Field, FieldPlanting, Truck } from '@/lib/types'

type Row = {
  // Original AI-extracted values, kept for display when no match found.
  raw_truck: string | null
  raw_crop: string | null
  raw_from: string | null
  raw_to: string | null
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
}

function numStr(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '' : String(n)
}

function num(s: string): number | null {
  if (s === '' || s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

function ticketToRow(
  t: TicketExtraction,
  crops: Crop[],
  trucks: Truck[],
  fields: Field[],
  bins: Bin[],
  buyers: Buyer[],
  plantings: FieldPlanting[],
): Row {
  // Crop first — most other matches depend on it.
  const crop = findBestMatch(t.crop, crops, (c) => c.name)
  const truck = findBestMatch(t.truck, trucks, (tr) => tr.name_or_number)

  // From: type from AI, fallback to inferring from name match.
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

  void plantings

  return {
    raw_truck: t.truck,
    raw_crop: t.crop,
    raw_from: t.from_name,
    raw_to: t.to_name,
    date: t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : todayISO(),
    time: t.time && /^\d{2}:\d{2}$/.test(t.time) ? t.time : '',
    ticket_number: t.ticket_number ?? '',
    truck_id: truck?.id ?? '',
    crop_id: crop?.id ?? '',
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
  }
}

function rowStatus(r: Row, cropYear: string): 'ready' | 'review' {
  if (!cropYear) return 'review'
  if (!r.date) return 'review'
  if (!r.crop_id) return 'review'
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
  const [aiStage, setAiStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const [saveSummary, setSaveSummary] = useState<{ savedCount: number; remaining: number } | null>(null)
  const savedIdsRef = useRef<string[]>([])

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

  const seasonYearOptions = useMemo(
    () =>
      cropYearOptionsFromPlantings(
        plantings.map((p) => p.season_year),
        cropYear === '' ? null : Number(cropYear),
      ),
    [plantings, cropYear],
  )

  function fieldsForCrop(crop_id: string): Field[] {
    if (!crop_id) return fields
    const yearNum = cropYear === '' ? null : Number(cropYear)
    const ids = new Set(
      plantings
        .filter((p) => p.crop_id === crop_id && (yearNum == null || p.season_year === yearNum))
        .map((p) => p.field_id),
    )
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
    setAiStage('Reading document…')
    try {
      await new Promise((r) => setTimeout(r, 250))
      setAiStage('Extracting data…')
      // Chunked parse for big ticket stacks (PDF pages or photo batches):
      // per-chunk retry, failed pages reported, a ticket repeated across a
      // batch boundary resolves once (mergeTickets).
      const { data, warning } = await parseDocumentChunked<TicketsExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'tickets',
        { onProgress: setAiStage, merge: mergeTickets },
      )
      const tickets = Array.isArray(data.tickets) ? data.tickets : []
      if (tickets.length === 0) {
        setErr(warning ?? 'No records found in this document. The scan may be too blurry or the format may not be readable.')
        return
      }
      if (warning) setErr(warning)
      const next = tickets.map((t) => ticketToRow(t, crops, trucks, fields, bins, buyers, plantings))
      setRows(next)
      setBanner(`AI extracted ${next.length} ticket${next.length === 1 ? '' : 's'}. Please review before saving.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else {
        setErr(
          e?.message
            ? `Couldn't read this PDF: ${e.message}. Try uploading a clearer scan or use the manual entry method.`
            : "Couldn't read this PDF. Try uploading a clearer scan or use the manual entry method.",
        )
      }
    } finally {
      setAiStage(null)
    }
  }

  function discard() {
    setSource(null)
    setRows([])
    setBanner(null)
    setErr(null)
    setSaveSummary(null)
  }

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((rs) =>
      rs.map((r, j) => {
        if (i !== j) return r
        const next = { ...r, ...patch }
        // Auto-recompute net when gross or tare changes via this update.
        if ('gross_weight' in patch || 'tare_weight' in patch) {
          const g = num(next.gross_weight)
          const tr = num(next.tare_weight)
          if (g != null && tr != null) next.net_weight = String(+(g - tr).toFixed(2))
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

  async function saveAll() {
    if (readyCount === 0) {
      setErr('No rows are ready to save.')
      return
    }
    const confirmMsg =
      reviewCount > 0
        ? `Save ${readyCount} load${readyCount === 1 ? '' : 's'}? ${reviewCount} load${reviewCount === 1 ? '' : 's'} still need review and will not be saved.`
        : `Save ${readyCount} load${readyCount === 1 ? '' : 's'}?`
    if (!window.confirm(confirmMsg)) return

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
        setErr(e?.message ?? 'Could not upload the ticket PDF.')
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

    const { data, error } = await supabase.from('loads').insert(payloads).select('id')
    setSaving(false)
    if (error) {
      setErr(`Could not save: ${error.message}`)
      return
    }
    savedIdsRef.current = (data as Array<{ id: string }> | null)?.map((d) => d.id) ?? []
    rememberHarvestEntryPath('load')
    // Drop saved rows; keep unready rows for the user to finish.
    const remaining = rows.filter((r) => statusFor(r) !== 'ready')
    setRows(remaining)
    setSaveSummary({ savedCount: payloads.length, remaining: remaining.length })
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm w-full bg-white'

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Scan Tickets</h1>
        <Link href="/loads/new" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">
          Manual entry
        </Link>
        <Link href="/loads" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">
          Cancel
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-slate-700">
            Crop year
            <select
              value={cropYear}
              onChange={(e) => setCropYear(e.target.value)}
              className="mt-1 w-40 rounded-lg border border-slate-300 px-3 py-2 text-base bg-white"
            >
              <option value="">— select —</option>
              {seasonYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <DocumentCapture
            onSource={onSource}
            busy={aiStage != null}
            stageLabel={aiStage}
            pdfLabel="Upload Ticket PDF or Image"
          />
          {source && !aiStage && (
            <button
              type="button"
              onClick={discard}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
            >
              Discard &amp; Start Over
            </button>
          )}
          <div className="flex-1" />
          {refsLoaded && rows.length > 0 && (
            <div className="text-sm text-slate-600">
              <span className="font-semibold text-green-700">{readyCount}</span> ready ·{' '}
              <span className="font-semibold text-amber-700">{reviewCount}</span> need review
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
            <span>{saveSummary.savedCount} load{saveSummary.savedCount === 1 ? '' : 's'} saved successfully.</span>
            <Link href="/loads" className="underline">View loads list</Link>
            {saveSummary.remaining > 0 && (
              <span className="text-amber-800">
                {saveSummary.remaining} row{saveSummary.remaining === 1 ? '' : 's'} still need review — finish and save again, or discard.
              </span>
            )}
          </div>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>

      {!source && !aiStage && rows.length === 0 && (
        <div className="bg-white rounded-xl shadow p-6 text-center text-slate-500">
          Take a photo or upload a PDF of scanned scale tickets to extract loads. Each ticket becomes one editable row.
        </div>
      )}

      {(source || rows.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl shadow p-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {['Status', 'Date', 'Time', 'Ticket #', 'Truck', 'Crop', 'Gross lb', 'Tare lb', 'Net lb', 'Moisture %', 'Test wt', 'From', 'To', 'Contract', 'Bushels', '']
                    .map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={16} className="px-3 py-6 text-center text-slate-400">
                    {aiStage ? 'Working…' : 'No tickets yet — take a photo or upload a PDF.'}
                  </td></tr>
                )}
                {rows.map((r, i) => {
                  const st = statusFor(r)
                  const crop = crops.find((c) => c.id === r.crop_id)
                  const { wetBushels, dryBushels } = computeBushels({
                    netWeightLb: num(r.net_weight),
                    moisturePct: num(r.moisture),
                    baseMoisturePct: crop?.base_moisture_pct ?? null,
                    baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
                  })
                  const ff = fieldsForCrop(r.crop_id)
                  const bb = binsForCrop(r.crop_id)
                  const cc = contractsFor(r.to_buyer_id, r.crop_id)
                  const hl = (cond: boolean) => (cond ? 'bg-amber-50' : '')
                  return (
                    <tr key={i} className="border-t border-slate-100 align-top">
                      <td className="px-2 py-1 whitespace-nowrap">
                        {st === 'ready' ? (
                          <span className="inline-block rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs font-semibold">Ready</span>
                        ) : (
                          <span className="inline-block rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-semibold">Needs Review</span>
                        )}
                      </td>
                      <td className={`px-2 py-1 ${hl(!r.date)}`} style={{ minWidth: 130 }}>
                        <input type="date" value={r.date} onChange={(e) => updateRow(i, { date: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 100 }}>
                        <input type="time" value={r.time} onChange={(e) => updateRow(i, { time: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 110 }}>
                        <input value={r.ticket_number} onChange={(e) => updateRow(i, { ticket_number: e.target.value })} className={inputCls} />
                      </td>
                      <td className={`px-2 py-1 ${hl(!r.truck_id)}`} style={{ minWidth: 130 }}>
                        <select value={r.truck_id} onChange={(e) => updateRow(i, { truck_id: e.target.value })} className={inputCls}>
                          <option value="">— select —</option>
                          {trucks.map((t) => <option key={t.id} value={t.id}>{t.name_or_number}</option>)}
                        </select>
                        {!r.truck_id && r.raw_truck && (
                          <div className="text-xs text-amber-700 mt-1">AI: “{r.raw_truck}”</div>
                        )}
                      </td>
                      <td className={`px-2 py-1 ${hl(!r.crop_id)}`} style={{ minWidth: 130 }}>
                        <select value={r.crop_id} onChange={(e) => updateRow(i, { crop_id: e.target.value })} className={inputCls}>
                          <option value="">— select —</option>
                          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {!r.crop_id && r.raw_crop && (
                          <div className="text-xs text-amber-700 mt-1">AI: “{r.raw_crop}”</div>
                        )}
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" inputMode="decimal" value={r.gross_weight} onChange={(e) => updateRow(i, { gross_weight: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" inputMode="decimal" value={r.tare_weight} onChange={(e) => updateRow(i, { tare_weight: e.target.value })} className={inputCls} />
                      </td>
                      <td className={`px-2 py-1 ${hl((num(r.net_weight) ?? 0) <= 0)}`} style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" inputMode="decimal" value={r.net_weight} onChange={(e) => updateRow(i, { net_weight: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 80 }}>
                        <input type="number" step="0.01" inputMode="decimal" value={r.moisture} onChange={(e) => updateRow(i, { moisture: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 80 }}>
                        <input type="number" step="0.01" inputMode="decimal" value={r.test_weight} onChange={(e) => updateRow(i, { test_weight: e.target.value })} className={inputCls} />
                      </td>
                      <td className={`px-2 py-1 ${hl(!r.from_type || (r.from_type === 'field' && !r.from_field_id) || (r.from_type === 'bin' && !r.from_bin_id))}`} style={{ minWidth: 200 }}>
                        <div className="flex gap-1 mb-1">
                          {(['field', 'bin'] as const).map((typ) => (
                            <button
                              key={typ}
                              type="button"
                              onClick={() => updateRow(i, { from_type: typ })}
                              className={`flex-1 text-xs px-2 py-1 rounded border ${r.from_type === typ ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white border-slate-300'}`}
                            >
                              {typ === 'field' ? 'Field' : 'Bin'}
                            </button>
                          ))}
                        </div>
                        {r.from_type === 'field' && (
                          <select value={r.from_field_id} onChange={(e) => updateRow(i, { from_field_id: e.target.value })} className={inputCls}>
                            <option value="">— select field —</option>
                            {ff.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
                          </select>
                        )}
                        {r.from_type === 'field' && isMixedField(r.from_field_id, r.crop_id) && (
                          <div className="flex gap-1 mt-1">
                            {(['irrigated', 'dryland'] as const).map((p) => (
                              <button
                                key={p}
                                type="button"
                                onClick={() => updateRow(i, { practice: r.practice === p ? '' : p })}
                                className={`flex-1 text-xs px-2 py-1 rounded border ${r.practice === p ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white border-slate-300'}`}
                                title="Optional — this field has both irrigated and dryland acres"
                              >
                                {p === 'irrigated' ? 'Irrigated' : 'Dryland'}
                              </button>
                            ))}
                          </div>
                        )}
                        {r.from_type === 'bin' && (
                          <select value={r.from_bin_id} onChange={(e) => updateRow(i, { from_bin_id: e.target.value })} className={inputCls}>
                            <option value="">— select bin —</option>
                            {bb.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
                          </select>
                        )}
                        {((r.from_type === 'field' && !r.from_field_id) || (r.from_type === 'bin' && !r.from_bin_id) || !r.from_type) && r.raw_from && (
                          <div className="text-xs text-amber-700 mt-1">AI: “{r.raw_from}”</div>
                        )}
                      </td>
                      <td className={`px-2 py-1 ${hl(!r.to_type || (r.to_type === 'bin' && !r.to_bin_id) || (r.to_type === 'buyer' && !r.to_buyer_id))}`} style={{ minWidth: 200 }}>
                        <div className="flex gap-1 mb-1">
                          {(['bin', 'buyer'] as const).map((typ) => (
                            <button
                              key={typ}
                              type="button"
                              onClick={() => updateRow(i, { to_type: typ })}
                              className={`flex-1 text-xs px-2 py-1 rounded border ${r.to_type === typ ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white border-slate-300'}`}
                            >
                              {typ === 'bin' ? 'Bin' : 'Buyer'}
                            </button>
                          ))}
                        </div>
                        {r.to_type === 'bin' && (
                          <select value={r.to_bin_id} onChange={(e) => updateRow(i, { to_bin_id: e.target.value })} className={inputCls}>
                            <option value="">— select bin —</option>
                            {bb.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
                          </select>
                        )}
                        {r.to_type === 'buyer' && (
                          <select value={r.to_buyer_id} onChange={(e) => updateRow(i, { to_buyer_id: e.target.value })} className={inputCls}>
                            <option value="">— select buyer —</option>
                            {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        )}
                        {((r.to_type === 'bin' && !r.to_bin_id) || (r.to_type === 'buyer' && !r.to_buyer_id) || !r.to_type) && r.raw_to && (
                          <div className="text-xs text-amber-700 mt-1">AI: “{r.raw_to}”</div>
                        )}
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 140 }}>
                        {r.to_type === 'buyer' ? (
                          <select
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
                        )}
                      </td>
                      <td className="px-2 py-1 text-right font-mono whitespace-nowrap" style={{ minWidth: 110 }}>
                        <div className="text-xs text-slate-500">wet</div>
                        <div>{wetBushels != null ? wetBushels.toFixed(2) : '—'}</div>
                        <div className="text-xs text-slate-500 mt-1">dry</div>
                        <div>{dryBushels != null ? dryBushels.toFixed(2) : '—'}</div>
                      </td>
                      <td className="px-2 py-1"><button type="button" onClick={() => deleteRow(i)} className="text-red-600 text-sm">✕</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="xl:sticky xl:top-3 self-start h-[80vh] min-h-[400px]">
            <div className="text-xs text-slate-500 mb-1">Source document — cross-reference while reviewing</div>
            <SourcePreview source={source} className="h-full" title="Tickets" />
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="sticky bottom-3 bg-white rounded-xl shadow p-3 flex flex-wrap items-center gap-3">
          <div className="text-sm text-slate-700 flex-1">
            <span className="font-semibold text-green-700">{readyCount}</span> ready ·{' '}
            <span className="font-semibold text-amber-700">{reviewCount}</span> need review
            {!cropYear && <span className="ml-2 text-red-600">Pick a crop year above.</span>}
          </div>
          <button
            type="button"
            onClick={saveAll}
            disabled={saving || readyCount === 0 || !cropYear}
            className="rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold py-3 px-5 disabled:opacity-50"
          >
            {saving ? 'Saving…' : `Save All Loads (${readyCount})`}
          </button>
          <button
            type="button"
            onClick={() => router.push('/loads')}
            className="rounded-xl bg-white border border-slate-300 px-4 py-3 text-sm"
          >
            Done
          </button>
        </div>
      )}
    </div>
  )
}
