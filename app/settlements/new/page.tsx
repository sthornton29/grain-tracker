'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { parseCsv } from '@/lib/csv'
import { findBestMatch } from '@/lib/fuzzy'
import {
  MAX_PDF_BYTES,
  PdfTooLargeError,
  uploadPdfToStorage,
  type SettlementExtraction,
} from '@/lib/pdf-upload'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeSettlements } from '@/lib/parse-merge'
import { flagSummaryLines, reconcileLines } from '@/lib/settlement-lines'
import { imagesToPdf } from '@/lib/image-capture'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import {
  DISCOUNT_CATEGORIES,
  DISCOUNT_CATEGORY_LABELS,
  centsPerBu,
  coerceDeductionKind,
  coerceDiscountCategory,
  sumCheck,
} from '@/lib/settlement-discounts'
import type { Buyer } from '@/lib/types'
import Dropzone, { rejectMessage } from '@/components/dropzone'
import { matchAllTickets, normalizeTicket, type TicketMatch, type TicketMatchResult } from '@/lib/ticket-matching'
import { computeBushels } from '@/lib/shrink'
import type { SettlementGradeReadings } from '@/lib/pdf-upload'

type LoadMatch = {
  id: string
  date: string
  ticket_number: string | null
  crop_id: string | null
  crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
  contract_id: string | null
  to_buyer_id: string | null
  net_weight: number | null
  gross_weight: number | null
  tare_weight: number | null
  moisture: number | null
  test_weight: number | null
  dry_bushels_override: number | null
  truck_id: string | null
  truck: { license_plate: string | null } | null
}

type RowDraft = {
  ticket_number: string
  net_bushels: string
  gross_revenue: string
  discounts: string
  notes: string
  /** Guard verdict (lib/settlement-lines): an excluded row is a summary /
   *  check-stub line, not a load — kept visible, unchecked, one click back. */
  excluded?: boolean
  guard?: string | null
  // 086 — matching keys + the grade block from the statement.
  secondary_ref?: string | null
  delivery_date?: string | null
  vehicle_plate?: string | null
  gross_weight?: number | null
  tare_weight?: number | null
  grade_readings?: SettlementGradeReadings | null
  /** The reviewer's say over the automatic match: 'reject' (import
   *  unmatched) or a load id picked by hand. */
  matchOverride?: 'reject' | string
}

const emptyRow = (): RowDraft => ({
  ticket_number: '',
  net_bushels: '',
  gross_revenue: '',
  discounts: '',
  notes: '',
})

// One itemized discount line (074/075) — the statement's own deduction
// lines, AI-extracted or typed, saved to settlement_discount_items with the
// lines. kind 'price' = dollars off the check; 'weight' = a volume
// deduction (informational — the app values the shrink gap itself).
type DiscountDraft = {
  category: string
  description: string
  amount: string
  rate_note: string
  quantity_basis: string
  deduction_kind: string
}

const emptyDiscount = (): DiscountDraft => ({ category: 'other', description: '', amount: '', rate_note: '', quantity_basis: '', deduction_kind: 'price' })

function num(s: string): number | null {
  if (s == null || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function computed(r: RowDraft) {
  const gross = num(r.gross_revenue) ?? 0
  const disc = num(r.discounts) ?? 0
  const net = num(r.net_bushels) ?? 0
  const netRev = gross - disc
  const price = net > 0 ? netRev / net : null
  return { netRev, price }
}

function rowIssues(r: RowDraft) {
  const net = num(r.net_bushels)
  const gross = num(r.gross_revenue) ?? 0
  const disc = num(r.discounts) ?? 0
  return {
    ticket: !r.ticket_number.trim(),
    net: net == null || net <= 0,
    gross: gross === 0,
    discounts: disc > gross && gross > 0,
  }
}

const TEMPLATE_HEADERS = ['ticket_number', 'net_bushels', 'gross_revenue', 'discounts']

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_HEADERS.join(',') + '\n'], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'settlement-template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export default function NewSettlementPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [loads, setLoads] = useState<LoadMatch[]>([])
  const [contracts, setContracts] = useState<Array<{ id: string; contract_number: string; buyer_id: string | null; crop_id: string | null }>>([])
  const [buyerId, setBuyerId] = useState('')
  const [settlementDate, setSettlementDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [settlementNumber, setSettlementNumber] = useState('')
  // 086 — the header contract number and the remittance page's payment facts.
  const [contractNumber, setContractNumber] = useState('')
  const [payment, setPayment] = useState<{ payment_number: string; check_number: string; payment_date: string }>({ payment_number: '', check_number: '', payment_date: '' })
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<RowDraft[]>([])
  // The statement's own grand total as the AI read it (reconciliation only).
  const [reportedTotal, setReportedTotal] = useState<string>('')
  const [discountRows, setDiscountRows] = useState<DiscountDraft[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // AI-assisted extraction state. `source` is the PDF or captured photos.
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [aiStage, setAiStage] = useState<string | null>(null)
  const [aiBanner, setAiBanner] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const [b, l, c] = await Promise.all([
        supabase.from('buyers').select('*').order('name'),
        fetchAllRows((f, t) => supabase.from('loads')
          .select('id, date, ticket_number, crop_id, crop:crops(name, base_moisture_pct, base_lb_per_bushel), contract_id, to_buyer_id, net_weight, gross_weight, tare_weight, moisture, test_weight, dry_bushels_override, truck_id, truck:trucks(license_plate)')
          .eq('to_type', 'buyer').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('contracts').select('id, contract_number, buyer_id, crop_id').order('contract_number').order('id').range(f, t)),
      ])
      setBuyers((b.data as Buyer[]) || [])
      setLoads(((l.data as unknown) as LoadMatch[]) ?? [])
      setContracts(((c.data as unknown) as Array<{ id: string; contract_number: string; buyer_id: string | null; crop_id: string | null }>) ?? [])
    })()
  }, [supabase])

  const loadById = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads])
  // The header contract (086): the buyer's contract whose number matches.
  const headerContract = useMemo(() => {
    const n = normalizeTicket(contractNumber)
    if (!n) return null
    return contracts.find((c) => (!buyerId || c.buyer_id === buyerId) && normalizeTicket(c.contract_number) === n)
      ?? contracts.find((c) => (!buyerId || c.buyer_id === buyerId) && normalizeTicket(c.contract_number).replace(/-.*$/, '') === n.replace(/-.*$/, ''))
      ?? null
  }, [contractNumber, contracts, buyerId])

  // Tolerant matching (lib/ticket-matching, 086): exact → segment → attribute,
  // each load claimed once, in row order. Our dry bushels per load come from
  // the shrink math so a Bunge net-bushel figure can be compared.
  const matchResults: TicketMatchResult[] = useMemo(() => {
    const pool = loads.map((l) => ({
      id: l.id,
      ticket_number: l.ticket_number,
      crop_id: l.crop_id,
      to_buyer_id: l.to_buyer_id,
      date: l.date,
      dry_bushels: computeBushels({
        netWeightLb: l.net_weight, moisturePct: l.moisture,
        baseMoisturePct: l.crop?.base_moisture_pct ?? null, baseLbPerBushel: l.crop?.base_lb_per_bushel ?? null,
        dryBushelsOverride: l.dry_bushels_override,
      }).dryBushels,
      gross_weight: l.gross_weight,
      tare_weight: l.tare_weight,
      truck_id: l.truck_id,
      license_plate: l.truck?.license_plate ?? null,
    }))
    const ctx = { buyer_id: buyerId || null, crop_id: headerContract?.crop_id ?? null }
    // Excluded (total) rows never match; rejected rows never claim a load.
    const raw = matchAllTickets(
      rows.map((r) => r.excluded || r.matchOverride === 'reject'
        ? { ticket_number: null }
        : { ticket_number: r.ticket_number, secondary_refs: [r.secondary_ref], net_bushels: num(r.net_bushels), gross_weight: r.gross_weight, tare_weight: r.tare_weight, delivery_date: r.delivery_date, vehicle_plate: r.vehicle_plate }),
      pool,
      ctx,
    )
    return raw
  }, [rows, loads, buyerId, headerContract])

  type RowMatch = { load: LoadMatch | null; match: TicketMatch | null; candidates: TicketMatch[]; status: 'matched' | 'ambiguous' | 'unmatched' | 'rejected' | 'manual' }
  function matchFor(i: number): RowMatch {
    const r = rows[i]
    if (!r) return { load: null, match: null, candidates: [], status: 'unmatched' }
    if (r.matchOverride === 'reject') return { load: null, match: null, candidates: [], status: 'rejected' }
    if (r.matchOverride) {
      const load = loadById.get(r.matchOverride) ?? null
      return { load, match: load ? { tier: 'exact', confidence: 'high', loadId: load.id, reason: 'picked by hand' } : null, candidates: [], status: load ? 'manual' : 'unmatched' }
    }
    const res = matchResults[i]
    if (!res) return { load: null, match: null, candidates: [], status: 'unmatched' }
    if (res.status === 'matched') return { load: loadById.get(res.match.loadId) ?? null, match: res.match, candidates: res.candidates, status: 'matched' }
    if (res.status === 'ambiguous') return { load: null, match: null, candidates: res.candidates, status: 'ambiguous' }
    return { load: null, match: null, candidates: [], status: 'unmatched' }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await readCsv(file)
    e.target.value = ''
  }

  async function readCsv(file: File) {
    setErr(null)
    try {
      const text = await file.text()
      const { headers, rows: csvRows } = parseCsv(text)
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
      const idx: Record<string, number> = {}
      for (const h of TEMPLATE_HEADERS) {
        const i = headers.findIndex((raw) => norm(raw) === norm(h))
        if (i >= 0) idx[h] = i
      }
      if (!('ticket_number' in idx)) {
        setErr('CSV is missing a ticket_number column.')
        return
      }
      const next: RowDraft[] = csvRows.map((r) => ({
        ticket_number: r[idx.ticket_number] ?? '',
        net_bushels: r[idx.net_bushels] ?? '',
        gross_revenue: r[idx.gross_revenue] ?? '',
        discounts: r[idx.discounts] ?? '',
        notes: '',
      }))
      setRows((prev) => [...prev, ...next])
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to read file')
    }
  }

  async function onSource(src: DocumentSource) {
    setErr(null)
    setAiBanner(null)
    if (src.kind === 'pdf' && src.file.size > MAX_PDF_BYTES) {
      setErr('That PDF is larger than 20 MB. Please use a smaller file.')
      return
    }
    setSource(src)
    setAiStage('Reading document…')
    try {
      // Give the user a beat to see the first stage label before it flips.
      await new Promise((r) => setTimeout(r, 250))
      setAiStage('Extracting data…')
      // Chunked parse for long settlement statements: per-chunk retry, failed
      // pages reported, line items repeated across a batch boundary resolve
      // once (mergeSettlements — dedupe by ticket number).
      const { data, warning } = await parseDocumentChunked<SettlementExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'settlement',
        { onProgress: setAiStage, merge: mergeSettlements },
      )

      const extractedLines = Array.isArray(data.line_items) ? data.line_items : []
      if (extractedLines.length === 0) {
        setErr(warning ?? 'No records found in this document. The scan may be too blurry or the format may not be readable.')
        setAiStage(null)
        return
      }
      if (warning) setErr(warning)

      // Fuzzy-match buyer to existing dropdown.
      const buyerHit = findBestMatch(data.buyer_name, buyers, (b) => b.name)
      if (buyerHit) setBuyerId(buyerHit.id)

      if (data.settlement_date && /^\d{4}-\d{2}-\d{2}$/.test(data.settlement_date)) {
        setSettlementDate(data.settlement_date)
      }
      if (data.settlement_number != null) setSettlementNumber(String(data.settlement_number))
      // 086 — the header contract number and the check page's payment facts.
      setContractNumber(data.contract_number != null ? String(data.contract_number) : '')
      setPayment({
        payment_number: data.payment_number != null ? String(data.payment_number) : '',
        check_number: data.check_number != null ? String(data.check_number) : '',
        payment_date: data.payment_date && /^\d{4}-\d{2}-\d{2}$/.test(String(data.payment_date)) ? String(data.payment_date) : '',
      })

      // Belt and suspenders under the prompt: a TOTAL row or a check-stub line
      // that came back as a "ticket" is flagged and shown excluded. The
      // payment / check numbers are references too — a "ticket" equal to one
      // of them is the remittance restated.
      const refs = [data.settlement_number, data.payment_number, data.check_number].filter((x): x is string => !!x)
      const guards = extractedLines.map((li, i) => {
        const g = flagSummaryLines(extractedLines, { settlementNumber: data.settlement_number })[i]
        if (g.flagged) return g
        const tk = normalizeTicket(li.ticket_number).replace(/\D+/g, '')
        return tk && refs.some((r) => normalizeTicket(r).replace(/\D+/g, '') === tk)
          ? { flagged: true, reason: 'looks like the settlement total — not a load (its number is the payment or check number)' }
          : g
      })
      const nextRows: RowDraft[] = extractedLines.map((li, i) => ({
        ticket_number: li.ticket_number != null ? String(li.ticket_number) : '',
        net_bushels: li.net_bushels != null ? String(li.net_bushels) : '',
        gross_revenue: li.gross_revenue != null ? String(li.gross_revenue) : '',
        discounts: li.discounts != null ? String(li.discounts) : '',
        notes: '',
        excluded: guards[i].flagged,
        guard: guards[i].reason,
        secondary_ref: li.secondary_ref ?? null,
        delivery_date: li.delivery_date ?? null,
        vehicle_plate: li.vehicle_plate ?? null,
        gross_weight: li.gross_weight ?? null,
        tare_weight: li.tare_weight ?? null,
        grade_readings: li.grade_readings ?? null,
      }))
      setRows(nextRows)
      setReportedTotal(data.statement_reported_total != null ? String(data.statement_reported_total) : '')
      const flaggedCount = guards.filter((g) => g.flagged).length
      const extractedItems = Array.isArray(data.discount_items) ? data.discount_items : []
      setDiscountRows(extractedItems.map((di) => ({
        category: coerceDiscountCategory(di.category),
        description: di.description ?? '',
        amount: di.amount != null ? String(di.amount) : '',
        rate_note: di.rate_note ?? '',
        quantity_basis: di.quantity_basis ?? '',
        deduction_kind: coerceDeductionKind(di.deduction_kind),
      })))
      setAiBanner(
        `AI extracted ${nextRows.length - flaggedCount} ticket line${nextRows.length - flaggedCount === 1 ? '' : 's'}` +
        (extractedItems.length > 0 ? ` and ${extractedItems.length} itemized discount${extractedItems.length === 1 ? '' : 's'}` : '') +
        ' from settlement PDF.' +
        (flaggedCount > 0 ? ` ${flaggedCount} line${flaggedCount === 1 ? '' : 's'} looked like the settlement total (a TOTAL row or check stub) and ${flaggedCount === 1 ? 'is' : 'are'} left out — tick ${flaggedCount === 1 ? 'it' : 'them'} back in if that's wrong.` : '') +
        ' Please review before saving.',
      )
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) {
        setErr(e.message)
      } else {
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

  function discardPdf() {
    setSource(null)
    setAiBanner(null)
    setAiStage(null)
    setRows([])
    setDiscountRows([])
  }

  function updateRow(i: number, patch: Partial<RowDraft>) {
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
  }

  function deleteRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i))
  }

  async function save() {
    setErr(null)
    if (!buyerId) { setErr('Pick a buyer.'); return }
    if (!settlementDate) { setErr('Pick a settlement date.'); return }
    const includedRows = rows.filter((r) => !r.excluded)
    if (includedRows.length === 0) { setErr('Add at least one line.'); return }
    setSaving(true)

    let pdfUrl: string | null = null
    if (source) {
      try {
        const fileToStore = source.kind === 'pdf'
          ? source.file
          : await imagesToPdf(source.images, 'settlement')
        pdfUrl = await uploadPdfToStorage(supabase, fileToStore, 'settlements')
      } catch (e: any) {
        setSaving(false)
        setErr(e?.message ?? 'Could not upload settlement PDF.')
        return
      }
    }

    const baseHeader = {
      buyer_id: buyerId,
      settlement_date: settlementDate,
      settlement_number: settlementNumber.trim() || null,
      notes: notes.trim() || null,
      source_pdf_url: pdfUrl,
    }
    const header086 = {
      contract_id: headerContract?.id ?? null,
      payment_number: payment.payment_number.trim() || null,
      check_number: payment.check_number.trim() || null,
      payment_date: payment.payment_date || null,
    }
    let inserted = await supabase.from('settlements').insert({ ...baseHeader, ...header086 }).select('id').single()
    // 086 columns not applied yet → save the header without them.
    if (inserted.error) inserted = await supabase.from('settlements').insert(baseHeader).select('id').single()
    const settlement = inserted.data as { id: string } | null
    if (inserted.error || !settlement) {
      setSaving(false); setErr(inserted.error?.message ?? 'Could not save settlement.'); return
    }

    const matched = includedRows.map((r) => matchFor(rows.indexOf(r)))
    const baseLines = includedRows.map((r, i) => ({
      settlement_id: settlement.id,
      ticket_number: r.ticket_number.trim() || null,
      load_id: matched[i].load?.id ?? null,
      net_bushels: num(r.net_bushels) ?? 0,
      gross_revenue: num(r.gross_revenue) ?? 0,
      discounts: num(r.discounts) ?? 0,
      notes: r.notes.trim() || null,
    }))
    const lines086 = includedRows.map((r, i) => ({
      ...baseLines[i],
      buyer_ref: r.secondary_ref?.trim() || null,
      grade_readings: r.grade_readings && Object.values(r.grade_readings).some((v) => v != null) ? r.grade_readings : null,
      match_tier: matched[i].status === 'manual' ? 'manual' : matched[i].match?.tier ?? null,
      match_reason: matched[i].match?.reason ?? null,
    }))
    let lErr = (await supabase.from('settlement_lines').insert(lines086)).error
    if (lErr) lErr = (await supabase.from('settlement_lines').insert(baseLines)).error
    if (lErr) { setSaving(false); setErr('Settlement saved but lines failed: ' + lErr.message); return }

    // Write-backs (086), best effort: (a) a load matched by attributes gets the
    // buyer's ticket when it had none — the next statement matches exactly;
    // (b) moisture / test weight from the grade block fill a matched load's
    // EMPTY fields (never overwrite what was weighed in).
    for (let i = 0; i < includedRows.length; i++) {
      const m = matched[i]
      const r = includedRows[i]
      if (!m.load) continue
      const patch: Record<string, unknown> = {}
      if (m.match?.tier === 'attribute' && !normalizeTicket(m.load.ticket_number) && r.ticket_number.trim()) patch.ticket_number = r.ticket_number.trim()
      const g = r.grade_readings
      if (g?.moisture != null && m.load.moisture == null) patch.moisture = g.moisture
      if (g?.test_weight != null && m.load.test_weight == null) patch.test_weight = g.test_weight
      if (Object.keys(patch).length > 0) await supabase.from('loads').update(patch).eq('id', m.load.id)
    }

    const items = discountRows
      .filter((d) => d.description.trim() || num(d.amount) != null)
      .map((d) => ({
        settlement_id: settlement.id,
        category: coerceDiscountCategory(d.category),
        description: d.description.trim() || null,
        amount: num(d.amount) ?? 0,
        rate_note: d.rate_note.trim() || null,
        quantity_basis: d.quantity_basis.trim() || null,
        deduction_kind: coerceDeductionKind(d.deduction_kind),
      }))
    if (items.length > 0) {
      const { error: dErr } = await supabase.from('settlement_discount_items').insert(items)
      if (dErr) { setSaving(false); setErr('Settlement saved but its discount detail failed: ' + dErr.message); return }
    }
    setSaving(false)
    router.push(`/settlements/${settlement.id}`)
  }

  const totals = rows.reduce(
    (acc, r, i) => {
      if (r.excluded) return acc
      const { netRev } = computed(r)
      const m = matchFor(i)
      if (m.load) acc.matched++
      else if (r.ticket_number.trim()) acc.unmatched++
      else acc.blank++
      acc.netBu += num(r.net_bushels) ?? 0
      acc.netRev += netRev
      return acc
    },
    { matched: 0, unmatched: 0, blank: 0, netBu: 0, netRev: 0 }
  )

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm w-full'
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const fmt4 = (n: number | null) => n == null ? '' : n.toLocaleString(undefined, { maximumFractionDigits: 4 })

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">New Settlement</h1>
        <Link href="/settlements" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Cancel</Link>
      </div>

      <div className="bg-white rounded-xl shadow p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
        <label className="text-sm text-slate-700">
          Buyer
          <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className={`w-full ${inputCls}`}>
            <option value="">— select —</option>
            {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-700">
          Settlement date
          <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} className={`w-full ${inputCls}`} />
        </label>
        <label className="text-sm text-slate-700">
          Settlement # <span className="text-xs text-slate-400">optional</span>
          <input value={settlementNumber} onChange={(e) => setSettlementNumber(e.target.value)} className={`w-full ${inputCls}`} />
        </label>
        <label className="text-sm text-slate-700">
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`w-full ${inputCls}`} />
        </label>
      </div>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <h2 className="font-semibold flex-1">Lines</h2>
          <button type="button" onClick={downloadTemplate} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
            Download CSV template
          </button>
        </div>

        {/* Three ways to add lines, presented as one evenly-aligned set: AI from a
            PDF/photo, a CSV upload, or manual entry. `items-start` keeps every
            control's top edge on the same line even though the AI capture carries
            helper text beneath its button; matched `px-3 py-2 text-sm` heights and
            a shared gap keep them consistently sized and spaced. */}
        <div className="flex flex-wrap items-start gap-2">
          <DocumentCapture
            onSource={onSource}
            busy={aiStage != null}
            stageLabel={aiStage}
            pdfLabel="Settlement PDF or Photo (AI)"
          />
          <Dropzone
            onFiles={(files) => void readCsv(files[0])}
            onReject={(rejected) => setErr(rejectMessage('Use a CSV file, or the PDF/photo button for the settlement itself.', rejected))}
            accept=".csv,text/csv,text/plain"
            hint="Drop the CSV here"
            variant="compact"
            accepts="CSV"
            className="inline-block"
          >
            <label className="text-sm rounded-lg bg-slate-700 text-white px-3 py-2 cursor-pointer inline-block">
              Upload CSV
              <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="hidden" />
            </label>
          </Dropzone>
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, emptyRow()])}
            className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
          >
            + Add row manually
          </button>
          {source && !aiStage && (
            <button
              type="button"
              onClick={discardPdf}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
            >
              Discard &amp; Start Over
            </button>
          )}
        </div>

        {aiBanner && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
            {aiBanner}
          </div>
        )}
        {/* 086 — header contract + payment facts from the statement / check page. */}
        {(contractNumber || payment.payment_number || payment.check_number || payment.payment_date) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            {contractNumber && (
              <span>Contract <b>{contractNumber}</b>{headerContract ? <span className="text-green-700"> · linked to #{headerContract.contract_number}</span> : <span className="text-amber-700"> · no matching contract for this buyer</span>}</span>
            )}
            {payment.payment_number && <span>Payment # <b>{payment.payment_number}</b></span>}
            {payment.check_number && <span>Check # <b>{payment.check_number}</b></span>}
            {payment.payment_date && <span>Paid <b>{payment.payment_date}</b></span>}
          </div>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className={source ? 'grid grid-cols-1 lg:grid-cols-2 gap-4' : ''}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {['', 'Ticket #', 'Match', 'Net bu', 'Gross $', 'Discounts $', 'Net $', '$/bu', 'Notes', '']
                    .map((h, i) => <th key={i} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">Upload a CSV, take a photo or upload a PDF (AI), or add rows manually.</td></tr>
                )}
                {rows.map((r, i) => {
                  const { netRev, price } = computed(r)
                  const m = matchFor(i)
                  const issues = rowIssues(r)
                  const flagCls = 'bg-amber-50'
                  let status: React.ReactNode
                  const tierChip = (t: TicketMatch['tier'], confidence: TicketMatch['confidence']) => (
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${t === 'exact' ? 'bg-green-100 text-green-800' : t === 'segment' ? 'bg-sky-100 text-sky-800' : 'bg-amber-100 text-amber-800'}`}>
                      {t === 'exact' ? 'exact' : t === 'segment' ? 'ticket inside ours' : `date + weight${confidence === 'medium' ? ' · check' : ''}`}
                    </span>
                  )
                  const pickList = (cands: TicketMatch[]) => (
                    <select
                      value=""
                      onChange={(e) => { if (e.target.value) updateRow(i, { matchOverride: e.target.value }) }}
                      className="rounded border border-slate-300 px-1 py-0.5 text-xs bg-white max-w-[220px]"
                      title="Pick the load this line paid"
                    >
                      <option value="">Pick the load…</option>
                      {cands.map((c) => { const ld = loadById.get(c.loadId); return ld ? <option key={c.loadId} value={c.loadId}>{ld.date} · {ld.ticket_number ?? 'no ticket'} · {ld.crop?.name ?? ''} · {c.reason}</option> : null })}
                    </select>
                  )
                  if (!r.ticket_number.trim() && m.status !== 'manual') {
                    status = <span className="text-slate-400 text-xs">—</span>
                  } else if (m.status === 'rejected') {
                    status = <span className="text-xs text-slate-600">Import unmatched <button type="button" className="underline ml-1" onClick={() => updateRow(i, { matchOverride: undefined })}>undo</button></span>
                  } else if (m.status === 'ambiguous') {
                    status = <span className="text-amber-700 text-xs flex flex-col gap-1"><span>Several loads fit — {m.candidates[0]?.reason}</span>{pickList(m.candidates)}</span>
                  } else if (m.load && m.match) {
                    status = (
                      <span className="text-xs flex flex-wrap items-center gap-1">
                        <span className="text-green-700">Matched · {m.load.date} · {m.load.crop?.name ?? '—'}{m.load.ticket_number && normalizeTicket(m.load.ticket_number) !== normalizeTicket(r.ticket_number) ? ` · our #${m.load.ticket_number}` : ''}</span>
                        {m.status === 'manual' ? <span className="rounded-full bg-slate-200 text-slate-700 px-1.5 py-0.5 text-[10px] font-semibold">picked by hand</span> : tierChip(m.match.tier, m.match.confidence)}
                        <span className="text-slate-500" title={m.match.reason}>{m.match.reason}</span>
                        {(m.match.tier !== 'exact' || m.status === 'manual') && (
                          <button type="button" onClick={() => updateRow(i, { matchOverride: m.status === 'manual' ? undefined : 'reject' })} className="underline text-slate-600" title="Not this load — import the line unmatched">not this load</button>
                        )}
                      </span>
                    )
                  } else {
                    status = <span className="text-amber-700 text-xs">No match</span>
                  }
                  if (r.excluded) {
                    // The guard's verdict: shown, not counted. One click re-includes.
                    return (
                      <tr key={i} className="border-t border-amber-200 bg-amber-50 text-amber-900 align-top">
                        <td className="px-2 py-1">
                          <input type="checkbox" checked={false} onChange={() => updateRow(i, { excluded: false })} aria-label="Include this line" title="Include this line after all" />
                        </td>
                        <td className="px-2 py-1 font-mono text-sm">{r.ticket_number || '—'}</td>
                        <td className="px-2 py-1 text-xs" colSpan={6}>
                          <span className="font-semibold">Left out:</span> {r.guard ?? 'looks like the settlement total — not a load'}.{' '}
                          <span className="text-amber-700">{r.net_bushels ? `${fmt(num(r.net_bushels) ?? 0)} bu` : ''}{r.gross_revenue ? ` · $${fmt((num(r.gross_revenue) ?? 0) - (num(r.discounts) ?? 0))}` : ''}</span>{' '}
                          <button type="button" onClick={() => updateRow(i, { excluded: false })} className="underline font-semibold">Include it</button>
                        </td>
                        <td className="px-2 py-1" />
                        <td className="px-2 py-1"><button type="button" onClick={() => deleteRow(i)} className="text-red-600 text-sm" title="Remove">✕</button></td>
                      </tr>
                    )
                  }
                  return (
                    <tr key={i} className="border-t border-slate-100 align-top">
                      <td className="px-2 py-1">
                        {r.guard
                          ? <input type="checkbox" checked onChange={() => updateRow(i, { excluded: true })} aria-label="Included (was flagged as a total)" title={`Included — the guard had flagged it: ${r.guard}`} />
                          : null}
                      </td>
                      <td className={`px-2 py-1 ${issues.ticket ? flagCls : ''}`} style={{ minWidth: 120 }}>
                        <input value={r.ticket_number} onChange={(e) => updateRow(i, { ticket_number: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1" style={{ minWidth: 180 }}>{status}</td>
                      <td className={`px-2 py-1 ${issues.net ? flagCls : ''}`} style={{ minWidth: 90 }}>
                        <input type="number" step="0.01" value={r.net_bushels} onChange={(e) => updateRow(i, { net_bushels: e.target.value })} className={inputCls} />
                      </td>
                      <td className={`px-2 py-1 ${issues.gross ? flagCls : ''}`} style={{ minWidth: 100 }}>
                        <input type="number" step="0.01" value={r.gross_revenue} onChange={(e) => updateRow(i, { gross_revenue: e.target.value })} className={inputCls} />
                      </td>
                      <td className={`px-2 py-1 ${issues.discounts ? flagCls : ''}`} style={{ minWidth: 100 }}>
                        <input type="number" step="0.01" value={r.discounts} onChange={(e) => updateRow(i, { discounts: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1 text-right font-mono">${fmt(netRev)}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmt4(price)}</td>
                      <td className="px-2 py-1" style={{ minWidth: 140 }}>
                        <input value={r.notes} onChange={(e) => updateRow(i, { notes: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-2 py-1"><button type="button" onClick={() => deleteRow(i)} className="text-red-600 text-sm">✕</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {/* Ticket lines vs the statement's own grand total (as the AI read
                it, editable): the reconciliation the guard exists to protect. */}
            {(rows.length > 0 || reportedTotal !== '') && (() => {
              const rec = reconcileLines(rows.map((r) => ({ ...r, excluded: !!r.excluded })), reportedTotal)
              return (
                <div className={`mt-2 flex flex-wrap items-center gap-2 text-xs rounded-lg border px-2 py-1.5 ${rec.mismatch === true ? 'bg-amber-50 border-amber-300 text-amber-900' : rec.mismatch === false ? 'bg-green-50 border-green-200 text-green-800' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  <span>Ticket lines total <span className="font-mono font-semibold">${fmt(rec.linesTotal)}</span></span>
                  <label className="inline-flex items-center gap-1">
                    · settlement total
                    <span className="text-slate-400">$</span>
                    <input type="number" step="0.01" value={reportedTotal} onChange={(e) => setReportedTotal(e.target.value)} placeholder="from the statement" className="w-28 rounded border border-slate-300 px-1.5 py-0.5 text-xs text-right bg-white" />
                  </label>
                  {rec.mismatch === true && <span className="font-semibold">— off by ${fmt(Math.abs(rec.delta ?? 0))}. Check for a missed or doubled line.</span>}
                  {rec.mismatch === false && <span className="font-semibold">— matches.</span>}
                  {rec.mismatch == null && <span>— enter the statement&rsquo;s total to check the lines add up.</span>}
                </div>
              )
            })()}
          </div>

          {source && (
            <div className="lg:sticky lg:top-3 self-start h-[70vh] min-h-[400px]">
              <div className="text-xs text-slate-500 mb-1">Source document — cross-reference while reviewing</div>
              <SourcePreview source={source} className="h-full" title="Settlement" />
            </div>
          )}
        </div>

        {/* Itemized discounts (074): the statement's own deduction lines. The
            AI fills these from the upload; under-itemized statements and
            manual entries get rows added here. Saved with the settlement. */}
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold">Itemized discounts</h3>
              <p className="text-xs text-slate-500">
                Each deduction on the statement, by type — this powers the ¢/bu breakdown and Ask Turnrow&rsquo;s buyer-discount answers.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDiscountRows((ds) => [...ds, emptyDiscount()])}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
            >
              + Add discount line
            </button>
          </div>

          {(() => {
            const lineDiscTotal = rows.reduce((s, r) => s + (num(r.discounts) ?? 0), 0)
            const check = sumCheck(discountRows.map((d) => ({ category: d.category, amount: num(d.amount) ?? 0, deduction_kind: d.deduction_kind })), lineDiscTotal)
            return check.mismatch ? (
              <p className="text-sm rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-amber-900">
                The itemized lines add to ${fmt(check.itemizedTotal)}, but the line discounts total ${fmt(lineDiscTotal)}.
                Part of the statement may not be itemized — review before saving.
              </p>
            ) : null
          })()}

          {discountRows.length === 0 ? (
            <p className="text-sm text-slate-400">
              None yet — the AI upload fills these in when the statement shows its deductions.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    {['Type', 'Kind', 'Statement wording', '$', '¢/bu', 'Rate', ''].map((h, i) => (
                      <th key={h || i} className={`px-2 py-2 whitespace-nowrap ${h === '$' || h === '¢/bu' ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {discountRows.map((d, i) => {
                    const isWeight = d.deduction_kind === 'weight'
                    const cents = isWeight ? null : centsPerBu(num(d.amount) ?? 0, totals.netBu)
                    return (
                      <tr key={i} className="border-t border-slate-100 align-top">
                        <td className="px-2 py-1">
                          <select
                            value={d.category}
                            onChange={(e) => setDiscountRows((ds) => ds.map((x, j) => (i === j ? { ...x, category: e.target.value } : x)))}
                            className={inputCls}
                          >
                            {DISCOUNT_CATEGORIES.map((c) => <option key={c} value={c}>{DISCOUNT_CATEGORY_LABELS[c]}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={d.deduction_kind}
                            onChange={(e) => setDiscountRows((ds) => ds.map((x, j) => (i === j ? { ...x, deduction_kind: e.target.value } : x)))}
                            className={inputCls}
                            title="Price = dollars off the check. Weight = bushels/pounds taken instead — Turnrow values that from its own load reconciliation."
                          >
                            <option value="price">Price $</option>
                            <option value="weight">Weight</option>
                          </select>
                        </td>
                        <td className="px-2 py-1" style={{ minWidth: 160 }}>
                          <input
                            value={d.description}
                            onChange={(e) => setDiscountRows((ds) => ds.map((x, j) => (i === j ? { ...x, description: e.target.value } : x)))}
                            className={inputCls}
                          />
                        </td>
                        <td className="px-2 py-1" style={{ minWidth: 90 }}>
                          <input
                            type="number" step="0.01" value={d.amount}
                            onChange={(e) => setDiscountRows((ds) => ds.map((x, j) => (i === j ? { ...x, amount: e.target.value } : x)))}
                            className={`${inputCls} text-right`}
                          />
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-slate-500">
                          {cents != null ? `${cents.toLocaleString(undefined, { maximumFractionDigits: 1 })}¢` : ''}
                        </td>
                        <td className="px-2 py-1" style={{ minWidth: 140 }}>
                          <input
                            value={d.rate_note}
                            onChange={(e) => setDiscountRows((ds) => ds.map((x, j) => (i === j ? { ...x, rate_note: e.target.value } : x)))}
                            placeholder="e.g. 4¢/lb under 54"
                            className={inputCls}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <button
                            type="button"
                            onClick={() => setDiscountRows((ds) => ds.filter((_, j) => j !== i))}
                            className="text-red-600 text-sm"
                          >✕</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm bg-slate-50 rounded-lg p-3">
          <Stat label="Total rows" value={String(rows.length)} />
          <Stat label="Matched" value={String(totals.matched)} tone="green" />
          <Stat label="Unmatched" value={String(totals.unmatched)} tone={totals.unmatched > 0 ? 'amber' : 'slate'} />
          <Stat label="Net revenue" value={`$${fmt(totals.netRev)}`} />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving || rows.length === 0 || !buyerId}
            className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Settlement'}
          </button>
          <Link href="/settlements" className="rounded-lg bg-white border border-slate-300 px-4 py-2 text-sm">Cancel</Link>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'slate' | 'green' | 'amber' }) {
  const color =
    tone === 'green' ? 'text-green-700'
    : tone === 'amber' ? 'text-amber-700'
    : 'text-slate-700'
  return (
    <div>
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
    </div>
  )
}
