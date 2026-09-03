'use client'

// Rent Settlement — lease-driven landowner settlements (069).
//
// Flow: (1) put a lease on file — upload it (AI reads the terms, you review
// every field before saving; the document stays attached) or enter a
// handshake lease by hand — then (2) pick lease + crop year: the account
// supplies the landowner-share production (the same splits-aware engine as
// the Share Rent report) and actual sale prices where the operator marketed
// the share; the GAP INTERVIEW asks for exactly what the lease requires that
// neither supplies (shared expense totals, reference-price confirmations,
// flex amounts) — generation is blocked until every gap has a value; (3) the
// statement renders and exports under the FARM'S OWN branding (Settings →
// Organization) with zero Turnrow marks, and saves as a regenerable record.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import LandownerPicker from '@/components/landowner-picker'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeLeaseAgreements } from '@/lib/parse-merge'
import { imagesToPdf } from '@/lib/image-capture'
import { uploadFileToStorage, PdfTooLargeError, type LeaseAgreementExtraction } from '@/lib/pdf-upload'
import { fieldCropAggregates } from '@/lib/yields'
import { findBestMatch } from '@/lib/fuzzy'
import { exportToExcel, exportToPdf } from '@/lib/exports'
import { fetchOrgBranding, type OrgBrandingInfo } from '@/lib/branding'
import {
  buildSettlement,
  detectGaps,
  parseLeaseTerms,
  settlementExportPayload,
  type CropProductionInput,
  type ExpenseCategory,
  type LeaseTermsShape,
  type SettlementGap,
  type SettlementStatement,
} from '@/lib/rent-settlement'
import type { Crop, Farm, Field, FieldPlanting, Landowner, LeaseTerm, RentSettlement } from '@/lib/types'

const INPUT = 'rounded-lg border border-slate-300 px-3 py-2 text-sm'
const BTN = 'rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 text-sm font-semibold disabled:opacity-50'
const BTN_GRAY = 'rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm disabled:opacity-50'
const CATS: ExpenseCategory[] = ['drying', 'hauling', 'inputs', 'storage', 'other']

type LoadRow = {
  id: string; date: string; net_weight: number | null; moisture: number | null
  crop_id: string | null; dry_bushels_override: number | null; crop_year: number | null
  from_type: string | null; from_field_id: string | null; ticket_number: string | null
}
type SplitRow = { load_id: string; field_id: string; crop_id: string; dry_bushels: number }
type CombineRow = { id: string; field_id: string; crop_id: string; crop_year: number; stated_total_bushels: number; adjusted_total_bushels: number; adjustment_bu_per_acre: number | null; destination_bin_id: string | null; harvest_complete: boolean; entry_date: string }
type LineRow = { load_id: string | null; ticket_number: string | null; net_bushels: number | null; net_revenue: number | null }

// Editable lease terms (all strings for inputs).
type TermsDraft = {
  landownerId: string
  farmIds: string[]
  leaseType: 'crop_share' | 'cash' | 'flex'
  defaultPct: string
  byCrop: Array<{ crop: string; pct: string }>
  expenses: Array<{ category: ExpenseCategory; pct: string; note: string }>
  pricingMethod: 'landowner_sells_own' | 'operator_actual' | 'reference'
  referenceDescription: string
  cashPerAcre: string
  cashTotal: string
  flex: string[]
  paymentTiming: string
  notes: string
}

const emptyDraft = (): TermsDraft => ({
  landownerId: '', farmIds: [], leaseType: 'crop_share', defaultPct: '', byCrop: [],
  expenses: [], pricingMethod: 'operator_actual', referenceDescription: '',
  cashPerAcre: '', cashTotal: '', flex: [], paymentTiming: '', notes: '',
})

function draftToShape(d: TermsDraft): LeaseTermsShape {
  const n = (s: string) => (s.trim() === '' ? null : Number(s))
  return {
    leaseType: d.leaseType,
    shareTerms: d.leaseType === 'cash' && d.defaultPct.trim() === '' && d.byCrop.length === 0
      ? null
      : {
          defaultPct: n(d.defaultPct),
          byCrop: Object.fromEntries(d.byCrop.filter((r) => r.crop.trim() && n(r.pct) != null).map((r) => [r.crop.trim(), Number(r.pct)])),
        },
    expenseTerms: d.expenses
      .filter((e) => n(e.pct) != null && Number(e.pct) > 0)
      .map((e) => ({ category: e.category, landownerPct: Number(e.pct), note: e.note || null })),
    pricingMethod: { method: d.pricingMethod, reference: d.pricingMethod === 'reference' && d.referenceDescription.trim() ? { description: d.referenceDescription.trim() } : null },
    cashTerms: d.leaseType === 'crop_share' ? null : { perAcre: n(d.cashPerAcre), totalAnnual: n(d.cashTotal) },
    flexTerms: d.flex.filter((f) => f.trim()).map((f) => ({ description: f.trim() })),
    paymentTiming: d.paymentTiming.trim() || null,
  }
}

export default function RentSettlementReport() {
  const supabase = useMemo(() => createClient(), [])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<SplitRow[]>([])
  const [combineEntries, setCombineEntries] = useState<CombineRow[]>([])
  const [lines, setLines] = useState<LineRow[]>([])
  const [leases, setLeases] = useState<LeaseTerm[]>([])
  const [settlements, setSettlements] = useState<RentSettlement[]>([])
  const [branding, setBranding] = useState<OrgBrandingInfo | null>(null)
  const [tablesMissing, setTablesMissing] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [lo, fa, fi, cr, pl, ld, sp, ce, sl, lt, rs] = await Promise.all([
      supabase.from('landowners').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      fetchAllRows((f, t) => supabase.from('loads').select('id, date, time, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, ticket_number').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels').order('id').range(f, t)),
      supabase.from('combine_yield_entries').select('*'),
      fetchAllRows((f, t) => supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('lease_terms').select('*').order('created_at', { ascending: false }).order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('rent_settlements').select('*').order('generated_at', { ascending: false }).order('id').range(f, t)),
    ])
    setLandowners((lo.data as Landowner[]) || [])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setLoads((ld.data as LoadRow[]) || [])
    setSplits((sp.data as SplitRow[]) || [])
    setCombineEntries((ce.data as CombineRow[]) || [])
    setLines((sl.data as LineRow[]) || [])
    setLeases((lt.data as LeaseTerm[]) || [])
    setSettlements((rs.data as RentSettlement[]) || [])
    setTablesMissing(lt.error != null || rs.error != null)
    setBranding(await fetchOrgBranding(supabase))
  }, [supabase])
  useEffect(() => { void refresh() }, [refresh])

  const landownerById = useMemo(() => new Map(landowners.map((l) => [l.id, l])), [landowners])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])

  // ---- lease intake ----
  const [draft, setDraft] = useState<TermsDraft | null>(null)
  const [editingLeaseId, setEditingLeaseId] = useState<string | null>(null)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [extractNote, setExtractNote] = useState<string | null>(null)
  const [aiStage, setAiStage] = useState<string | null>(null)
  const [savingLease, setSavingLease] = useState(false)

  async function onLeaseSource(src: DocumentSource) {
    setErr(null); setExtractNote(null)
    try {
      const { data, warning } = await parseDocumentChunked<LeaseAgreementExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'lease_agreement',
        { onProgress: setAiStage, merge: mergeLeaseAgreements },
      )
      if (warning) setErr(warning)
      // Keep the source document to attach on save (photos become one PDF).
      setSourceFile(src.kind === 'pdf' ? src.file : await imagesToPdf(src.images, 'lease'))
      // Landowner + farms resolve through the standard fuzzy matching; the
      // review form below shows everything for confirmation before save.
      const lo = data.landowner_name ? findBestMatch(data.landowner_name, landowners, (l) => l.name) : null
      const matchedFarms = (data.farm_names ?? [])
        .map((n) => findBestMatch(n, farms, (f) => `${f.name} ${f.fsa_number ?? ''}`))
        .filter((f): f is Farm => f != null)
      setDraft({
        landownerId: lo?.id ?? '',
        farmIds: Array.from(new Set(matchedFarms.map((f) => f.id))),
        leaseType: data.lease_type ?? 'crop_share',
        defaultPct: data.share_terms?.default_pct != null ? String(data.share_terms.default_pct) : '',
        byCrop: Object.entries(data.share_terms?.by_crop ?? {}).map(([crop, pct]) => ({ crop, pct: String(pct) })),
        expenses: (data.expense_terms ?? []).map((e) => ({
          category: (CATS.includes(e.category as ExpenseCategory) ? e.category : 'other') as ExpenseCategory,
          pct: String(e.landowner_pct ?? ''),
          note: e.note ?? '',
        })),
        pricingMethod: data.pricing_method?.method ?? 'operator_actual',
        referenceDescription: data.pricing_method?.reference?.description ?? '',
        cashPerAcre: data.cash_terms?.per_acre != null ? String(data.cash_terms.per_acre) : '',
        cashTotal: data.cash_terms?.total_annual != null ? String(data.cash_terms.total_annual) : '',
        flex: (data.flex_terms ?? []).map((f) => f.description),
        paymentTiming: data.payment_timing ?? '',
        notes: data.notes ?? '',
      })
      setEditingLeaseId(null)
      setExtractNote(
        `Read the lease${data.landowner_name ? ` for ${data.landowner_name}` : ''}${lo ? ` (matched to ${lo.name})` : data.landowner_name ? ' — no matching landowner found, pick one below' : ''}. Review every field before saving.${data.source ? ` Source: ${data.source}` : ''}`,
      )
    } catch (e) {
      setErr(e instanceof PdfTooLargeError ? e.message : e instanceof Error ? `Couldn't read this lease: ${e.message}` : "Couldn't read this lease.")
    } finally {
      setAiStage(null)
    }
  }

  async function saveLease() {
    if (!draft) return
    if (!draft.landownerId) { setErr('Pick the landowner for this lease.'); return }
    setSavingLease(true); setErr(null)
    try {
      const shape = draftToShape(draft)
      let source: { url: string; path: string; name: string } | null = null
      if (sourceFile) {
        const up = await uploadFileToStorage(supabase, sourceFile, 'lease-agreements')
        source = { url: up.publicUrl, path: up.path, name: sourceFile.name }
      }
      const payload = {
        landowner_id: draft.landownerId,
        farm_ids: draft.farmIds,
        lease_type: shape.leaseType,
        share_terms: shape.shareTerms,
        expense_terms: shape.expenseTerms,
        pricing_method: shape.pricingMethod,
        cash_terms: shape.cashTerms,
        flex_terms: shape.flexTerms,
        payment_timing: shape.paymentTiming,
        notes: draft.notes.trim() || null,
        ...(source ? { source_file_url: source.url, source_file_path: source.path, source_file_name: source.name } : {}),
      }
      const res = editingLeaseId
        ? await supabase.from('lease_terms').update(payload).eq('id', editingLeaseId)
        : await supabase.from('lease_terms').insert(payload)
      if (res.error) throw new Error(res.error.message)
      setDraft(null); setSourceFile(null); setExtractNote(null); setEditingLeaseId(null)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the lease.')
    } finally {
      setSavingLease(false)
    }
  }

  function editLease(l: LeaseTerm) {
    const shape = parseLeaseTerms(l)
    setEditingLeaseId(l.id)
    setSourceFile(null)
    setExtractNote(l.source_file_name ? `Editing — the attached lease (${l.source_file_name}) stays attached.` : null)
    setDraft({
      landownerId: l.landowner_id,
      farmIds: l.farm_ids ?? [],
      leaseType: shape.leaseType,
      defaultPct: shape.shareTerms?.defaultPct != null ? String(shape.shareTerms.defaultPct) : '',
      byCrop: Object.entries(shape.shareTerms?.byCrop ?? {}).map(([crop, pct]) => ({ crop, pct: String(pct) })),
      expenses: (shape.expenseTerms ?? []).map((e) => ({ category: e.category, pct: String(e.landownerPct), note: e.note ?? '' })),
      pricingMethod: shape.pricingMethod?.method ?? 'operator_actual',
      referenceDescription: shape.pricingMethod?.reference?.description ?? '',
      cashPerAcre: shape.cashTerms?.perAcre != null ? String(shape.cashTerms.perAcre) : '',
      cashTotal: shape.cashTerms?.totalAnnual != null ? String(shape.cashTerms.totalAnnual) : '',
      flex: (shape.flexTerms ?? []).map((f) => f.description),
      paymentTiming: shape.paymentTiming ?? '',
      notes: l.notes ?? '',
    })
  }

  // ---- generation ----
  const [genLeaseId, setGenLeaseId] = useState('')
  const [genYear, setGenYear] = useState('')
  const [gapValues, setGapValues] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<SettlementStatement | null>(null)
  const [refSuggestion, setRefSuggestion] = useState<Record<string, { price: number | null; note: string; confidence: string } | 'loading'>>({})
  const [savingSettlement, setSavingSettlement] = useState(false)

  const genLease = leases.find((l) => l.id === genLeaseId) ?? null
  const genTerms = useMemo(() => (genLease ? parseLeaseTerms(genLease) : null), [genLease])
  const yearOptions = useMemo(() => {
    const s = new Set<number>(plantings.map((p) => p.season_year))
    s.add(new Date().getFullYear())
    return [...s].sort((a, b) => b - a)
  }, [plantings])

  const coveredFarmIds = useMemo(() => {
    if (!genLease) return new Set<string>()
    if (genLease.farm_ids?.length) return new Set(genLease.farm_ids)
    return new Set(farms.filter((f) => f.landowner_id === genLease.landowner_id).map((f) => f.id))
  }, [genLease, farms])
  const coveredFieldIds = useMemo(
    () => new Set(fields.filter((f) => f.farm_id && coveredFarmIds.has(f.farm_id)).map((f) => f.id)),
    [fields, coveredFarmIds],
  )

  const production = useMemo((): { rows: CropProductionInput[]; totalAcres: number } => {
    const year = Number(genYear)
    if (!genLease || !Number.isFinite(year)) return { rows: [], totalAcres: 0 }
    // Splits-aware dry bushels per field × crop — the same engine the Share
    // Rent report uses, restricted to the lease's farms.
    const aggByKey = fieldCropAggregates(loads, splits, cropById, { cropYear: year, combineEntries })
    const buByCrop = new Map<string, number>()
    for (const [key, agg] of aggByKey) {
      const [fieldId, cropId] = key.split('|')
      if (!coveredFieldIds.has(fieldId)) continue
      buByCrop.set(cropId, (buByCrop.get(cropId) ?? 0) + agg.dryBu)
    }
    const acresByCrop = new Map<string, number>()
    let totalAcres = 0
    for (const p of plantings) {
      if (p.season_year !== year || !coveredFieldIds.has(p.field_id)) continue
      const a = Number(p.planted_acres) || 0
      acresByCrop.set(p.crop_id, (acresByCrop.get(p.crop_id) ?? 0) + a)
      totalAcres += a
    }
    // Actual price: settled sales of loads hauled straight off these fields.
    const byLoadId = new Map(lines.filter((l) => l.load_id).map((l) => [l.load_id as string, l]))
    const byTicket = new Map(lines.filter((l) => l.ticket_number).map((l) => [String(l.ticket_number).trim().toLowerCase(), l]))
    const rev = new Map<string, { bu: number; usd: number }>()
    for (const l of loads) {
      if (l.crop_year !== year || l.from_type !== 'field' || !l.from_field_id || !l.crop_id) continue
      if (!coveredFieldIds.has(l.from_field_id)) continue
      const line = byLoadId.get(l.id) ?? (l.ticket_number ? byTicket.get(l.ticket_number.trim().toLowerCase()) : undefined)
      if (!line || !line.net_bushels || line.net_revenue == null) continue
      const cur = rev.get(l.crop_id) ?? { bu: 0, usd: 0 }
      cur.bu += Number(line.net_bushels); cur.usd += Number(line.net_revenue)
      rev.set(l.crop_id, cur)
    }
    const cropIds = new Set([...buByCrop.keys(), ...acresByCrop.keys()])
    const rows = [...cropIds].map((cropId): CropProductionInput => {
      const r = rev.get(cropId)
      return {
        cropName: cropById.get(cropId)?.name ?? cropId,
        totalBu: Math.round((buByCrop.get(cropId) ?? 0) * 100) / 100,
        acres: Math.round((acresByCrop.get(cropId) ?? 0) * 10) / 10,
        actualPricePerBu: r && r.bu > 0 ? Math.round((r.usd / r.bu) * 100) / 100 : null,
      }
    }).sort((a, b) => b.totalBu - a.totalBu)
    return { rows, totalAcres }
  }, [genLease, genYear, loads, splits, combineEntries, cropById, coveredFieldIds, plantings, lines])

  const gaps = useMemo((): SettlementGap[] => {
    if (!genTerms || !genYear) return []
    return detectGaps({ terms: genTerms, production: production.rows, totalAcres: production.totalAcres })
  }, [genTerms, genYear, production])
  const unresolved = gaps.filter((g) => {
    const v = gapValues[g.key]
    return v == null || v.trim() === '' || !Number.isFinite(Number(v))
  })

  async function suggestReferencePrice(gap: SettlementGap) {
    if (!genTerms?.pricingMethod?.reference || !gap.cropName) return
    setRefSuggestion((m) => ({ ...m, [gap.key]: 'loading' }))
    try {
      const res = await fetch('/api/reference-price-lookup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: genTerms.pricingMethod.reference.description, crop: gap.cropName, crop_year: Number(genYear) }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error ?? 'Lookup failed.')
      const d = json?.data as { price_usd_per_bu?: number | null; source_note?: string; as_of?: string; confidence?: string } | null
      setRefSuggestion((m) => ({
        ...m,
        [gap.key]: { price: d?.price_usd_per_bu ?? null, note: [d?.source_note, d?.as_of].filter(Boolean).join(' · ') || 'No source note.', confidence: d?.confidence ?? 'low' },
      }))
    } catch (e) {
      setRefSuggestion((m) => ({ ...m, [gap.key]: { price: null, note: e instanceof Error ? e.message : 'Lookup failed.', confidence: 'low' } }))
    }
  }

  function generate() {
    if (!genTerms || !genLease) return
    setErr(null)
    const values: Record<string, number> = {}
    for (const [k, v] of Object.entries(gapValues)) if (v.trim() !== '' && Number.isFinite(Number(v))) values[k] = Number(v)
    const result = buildSettlement({
      terms: genTerms,
      production: production.rows,
      totalAcres: production.totalAcres,
      gapValues: values,
      cropYear: Number(genYear),
      landownerName: landownerById.get(genLease.landowner_id)?.name ?? 'Landowner',
      generatedAt: new Date().toISOString(),
    })
    if (!result.ok) { setErr(`Still missing: ${result.gaps.map((g) => g.label).join('; ')}`); return }
    setPreview(result.statement)
  }

  async function saveSettlement() {
    if (!preview || !genLease) return
    setSavingSettlement(true); setErr(null)
    const { error } = await supabase.from('rent_settlements').insert({
      landowner_id: genLease.landowner_id,
      lease_term_id: genLease.id,
      crop_year: preview.cropYear,
      statement: preview,
      total_due: preview.totalDue,
    })
    setSavingSettlement(false)
    if (error) { setErr(error.message); return }
    await refresh()
  }

  async function exportStatement(statement: SettlementStatement, kind: 'pdf' | 'excel') {
    const b = branding ?? (await fetchOrgBranding(supabase))
    const lo = landowners.find((l) => l.name === statement.landownerName)
    const payload = {
      ...settlementExportPayload({ statement, landownerAddress: lo?.address ?? null }),
      branding: { mode: 'org' as const, ...b },
    }
    if (kind === 'pdf') await exportToPdf(payload)
    else await exportToExcel(payload)
  }

  async function deleteSettlement(id: string) {
    if (!confirm('Delete this saved settlement? The lease and production data are untouched.')) return
    await supabase.from('rent_settlements').delete().eq('id', id)
    await refresh()
  }

  function leaseLabel(l: LeaseTerm): string {
    const name = landownerById.get(l.landowner_id)?.name ?? '?'
    const farmNames = (l.farm_ids?.length ? l.farm_ids : farms.filter((f) => f.landowner_id === l.landowner_id).map((f) => f.id))
      .map((id) => farmById.get(id)?.name)
      .filter(Boolean)
    const type = l.lease_type === 'crop_share' ? 'crop share' : l.lease_type
    return `${name} — ${type}${farmNames.length ? ` · ${farmNames.join(', ')}` : ''}`
  }

  const fmtUsd = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <div className="space-y-5">
      {tablesMissing && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This report isn&rsquo;t fully set up on your account yet — contact support if this message doesn&rsquo;t clear.
        </p>
      )}

      {/* ---- 1. Leases on file ---- */}
      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Leases on file</h2>
        {leases.length === 0 && <p className="text-sm text-slate-400">No leases yet — upload one or enter it by hand.</p>}
        <ul className="divide-y divide-slate-100">
          {leases.map((l) => (
            <li key={l.id} className="py-2 flex items-center gap-3">
              <span className="flex-1 text-sm">{leaseLabel(l)}</span>
              {l.source_file_url && (
                <a href={l.source_file_url} target="_blank" rel="noreferrer" className="text-xs text-brand-deep underline decoration-dotted">lease doc</a>
              )}
              <button type="button" onClick={() => editLease(l)} className="text-sm text-brand-deep">Edit</button>
            </li>
          ))}
        </ul>
        <div className="flex items-start gap-3 flex-wrap border-t border-slate-100 pt-3">
          <DocumentCapture onSource={(s) => void onLeaseSource(s)} busy={aiStage != null} stageLabel={aiStage} pdfLabel="Upload lease (AI)" />
          <button type="button" className={BTN_GRAY} onClick={() => { setDraft(emptyDraft()); setSourceFile(null); setEditingLeaseId(null); setExtractNote('Entering a lease by hand — same terms, no document needed (fine for handshake leases).') }}>
            Enter a lease by hand
          </button>
        </div>
        {extractNote && !draft && <p className="text-sm text-slate-500">{extractNote}</p>}

        {draft && (
          <div className="rounded-xl border border-brand/40 bg-slate-50/60 p-3 space-y-3">
            <h3 className="font-semibold text-sm">{editingLeaseId ? 'Edit lease' : 'Review lease terms'}</h3>
            {extractNote && <p className="text-xs text-slate-600">{extractNote}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-xs text-slate-600">
                Landowner
                <LandownerPicker
                  value={draft.landownerId}
                  onChange={(id) => setDraft({ ...draft, landownerId: id })}
                  landowners={landowners}
                  farms={farms}
                  onCreated={() => void refresh()}
                  className={`${INPUT} w-full mt-1`}
                />
              </label>
              <label className="text-xs text-slate-600">
                Lease type
                <select value={draft.leaseType} onChange={(e) => setDraft({ ...draft, leaseType: e.target.value as TermsDraft['leaseType'] })} className={`${INPUT} w-full mt-1`}>
                  <option value="crop_share">Crop share</option>
                  <option value="cash">Cash</option>
                  <option value="flex">Flex / hybrid</option>
                </select>
              </label>
            </div>
            <div className="text-xs text-slate-600">
              Farms covered <span className="text-slate-400">— none checked = every farm linked to the landowner</span>
              <div className="flex flex-wrap gap-2 mt-1">
                {farms.filter((f) => !draft.landownerId || f.landowner_id === draft.landownerId || draft.farmIds.includes(f.id)).map((f) => (
                  <label key={f.id} className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
                    <input
                      type="checkbox"
                      checked={draft.farmIds.includes(f.id)}
                      onChange={(e) => setDraft({ ...draft, farmIds: e.target.checked ? [...draft.farmIds, f.id] : draft.farmIds.filter((id) => id !== f.id) })}
                    />
                    {f.name}
                  </label>
                ))}
              </div>
            </div>
            {draft.leaseType !== 'cash' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="text-xs text-slate-600">
                  Landowner share % (all crops)
                  <input type="number" step="0.01" value={draft.defaultPct} onChange={(e) => setDraft({ ...draft, defaultPct: e.target.value })} placeholder="33.33" className={`${INPUT} w-full mt-1`} />
                </label>
                <div className="text-xs text-slate-600">
                  Different % by crop
                  {draft.byCrop.map((r, i) => (
                    <div key={i} className="flex gap-1 mt-1">
                      <input value={r.crop} onChange={(e) => setDraft({ ...draft, byCrop: draft.byCrop.map((x, j) => (i === j ? { ...x, crop: e.target.value } : x)) })} placeholder="Crop" className={`${INPUT} flex-1`} />
                      <input type="number" step="0.01" value={r.pct} onChange={(e) => setDraft({ ...draft, byCrop: draft.byCrop.map((x, j) => (i === j ? { ...x, pct: e.target.value } : x)) })} placeholder="%" className={`${INPUT} w-20`} />
                      <button type="button" onClick={() => setDraft({ ...draft, byCrop: draft.byCrop.filter((_, j) => j !== i) })} className="text-red-600 px-1">×</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setDraft({ ...draft, byCrop: [...draft.byCrop, { crop: '', pct: '' }] })} className="text-brand-deep mt-1">+ crop share</button>
                </div>
              </div>
            )}
            {draft.leaseType !== 'crop_share' && (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-600">
                  Cash rent $/acre
                  <input type="number" step="0.01" value={draft.cashPerAcre} onChange={(e) => setDraft({ ...draft, cashPerAcre: e.target.value })} className={`${INPUT} w-full mt-1`} />
                </label>
                <label className="text-xs text-slate-600">
                  …or total $/year
                  <input type="number" step="0.01" value={draft.cashTotal} onChange={(e) => setDraft({ ...draft, cashTotal: e.target.value })} className={`${INPUT} w-full mt-1`} />
                </label>
              </div>
            )}
            {draft.leaseType !== 'cash' && (
              <>
                <div className="text-xs text-slate-600">
                  Shared expenses (landowner&rsquo;s %)
                  {draft.expenses.map((e2, i) => (
                    <div key={i} className="flex gap-1 mt-1 items-center">
                      <select value={e2.category} onChange={(ev) => setDraft({ ...draft, expenses: draft.expenses.map((x, j) => (i === j ? { ...x, category: ev.target.value as ExpenseCategory } : x)) })} className={INPUT}>
                        {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input type="number" step="1" value={e2.pct} onChange={(ev) => setDraft({ ...draft, expenses: draft.expenses.map((x, j) => (i === j ? { ...x, pct: ev.target.value } : x)) })} placeholder="%" className={`${INPUT} w-20`} />
                      <input value={e2.note} onChange={(ev) => setDraft({ ...draft, expenses: draft.expenses.map((x, j) => (i === j ? { ...x, note: ev.target.value } : x)) })} placeholder="note" className={`${INPUT} flex-1`} />
                      <button type="button" onClick={() => setDraft({ ...draft, expenses: draft.expenses.filter((_, j) => j !== i) })} className="text-red-600 px-1">×</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setDraft({ ...draft, expenses: [...draft.expenses, { category: 'drying', pct: '50', note: '' }] })} className="text-brand-deep mt-1">+ shared expense</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="text-xs text-slate-600">
                    How is the landowner&rsquo;s grain priced?
                    <select value={draft.pricingMethod} onChange={(e) => setDraft({ ...draft, pricingMethod: e.target.value as TermsDraft['pricingMethod'] })} className={`${INPUT} w-full mt-1`}>
                      <option value="operator_actual">Operator sells it — actual sale prices</option>
                      <option value="landowner_sells_own">Landowner markets their own share</option>
                      <option value="reference">A named reference price</option>
                    </select>
                  </label>
                  {draft.pricingMethod === 'reference' && (
                    <label className="text-xs text-slate-600">
                      Reference price (as the lease states it)
                      <input value={draft.referenceDescription} onChange={(e) => setDraft({ ...draft, referenceDescription: e.target.value })} placeholder="average October price at Farmers Elevator" className={`${INPUT} w-full mt-1`} />
                    </label>
                  )}
                </div>
              </>
            )}
            <div className="text-xs text-slate-600">
              Flex / bonus clauses
              {draft.flex.map((f, i) => (
                <div key={i} className="flex gap-1 mt-1">
                  <input value={f} onChange={(e) => setDraft({ ...draft, flex: draft.flex.map((x, j) => (i === j ? e.target.value : x)) })} className={`${INPUT} flex-1`} />
                  <button type="button" onClick={() => setDraft({ ...draft, flex: draft.flex.filter((_, j) => j !== i) })} className="text-red-600 px-1">×</button>
                </div>
              ))}
              <button type="button" onClick={() => setDraft({ ...draft, flex: [...draft.flex, ''] })} className="text-brand-deep mt-1">+ flex clause</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-xs text-slate-600">
                Payment timing
                <input value={draft.paymentTiming} onChange={(e) => setDraft({ ...draft, paymentTiming: e.target.value })} placeholder="within 30 days of harvest" className={`${INPUT} w-full mt-1`} />
              </label>
              <label className="text-xs text-slate-600">
                Notes
                <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className={`${INPUT} w-full mt-1`} />
              </label>
            </div>
            {sourceFile && <p className="text-xs text-slate-500">Lease document attached on save: {sourceFile.name}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => void saveLease()} disabled={savingLease} className={BTN}>
                {savingLease ? 'Saving…' : editingLeaseId ? 'Save changes' : 'Save lease'}
              </button>
              <button type="button" onClick={() => { setDraft(null); setSourceFile(null); setExtractNote(null); setEditingLeaseId(null) }} className={BTN_GRAY}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      {/* ---- 2. Generate a settlement ---- */}
      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Generate a settlement</h2>
        <div className="flex gap-2 flex-wrap">
          <select value={genLeaseId} onChange={(e) => { setGenLeaseId(e.target.value); setPreview(null); setGapValues({}) }} className={INPUT}>
            <option value="">— lease —</option>
            {leases.map((l) => <option key={l.id} value={l.id}>{leaseLabel(l)}</option>)}
          </select>
          <select value={genYear} onChange={(e) => { setGenYear(e.target.value); setPreview(null); setGapValues({}) }} className={INPUT}>
            <option value="">— crop year —</option>
            {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {genLease && genYear && (
          <>
            <div className="text-sm text-slate-600">
              <span className="font-semibold">From your records:</span>{' '}
              {production.rows.length === 0
                ? 'no production found on these farms for that year.'
                : production.rows.map((p) => `${p.cropName} ${Math.round(p.totalBu).toLocaleString()} bu on ${p.acres.toLocaleString()} ac${p.actualPricePerBu != null ? ` (settled avg $${p.actualPricePerBu.toFixed(2)}/bu)` : ''}`).join(' · ')}
            </div>

            {gaps.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2">
                <p className="text-sm font-semibold text-amber-900">The lease needs {gaps.length} figure{gaps.length === 1 ? '' : 's'} from you:</p>
                {gaps.map((g) => {
                  const sug = refSuggestion[g.key]
                  return (
                    <div key={g.key} className="text-sm space-y-1">
                      <label className="flex flex-wrap items-center gap-2">
                        <span className="text-slate-700">{g.label}</span>
                        <input
                          type="number" step="0.01"
                          value={gapValues[g.key] ?? ''}
                          onChange={(e) => { setGapValues((m) => ({ ...m, [g.key]: e.target.value })); setPreview(null) }}
                          className={`${INPUT} w-32`}
                        />
                        {g.kind === 'price' && genTerms?.pricingMethod?.method === 'reference' && (
                          <button type="button" className={BTN_GRAY} onClick={() => void suggestReferencePrice(g)} disabled={sug === 'loading'}>
                            {sug === 'loading' ? 'Looking…' : 'Look it up (AI)'}
                          </button>
                        )}
                      </label>
                      {sug && sug !== 'loading' && (
                        <p className="text-xs text-slate-600 ml-1">
                          {sug.price != null ? (
                            <>
                              Suggested: <b>${sug.price.toFixed(2)}/bu</b> ({sug.confidence} confidence) — {sug.note}{' '}
                              <button type="button" className="text-brand-deep underline decoration-dotted" onClick={() => { setGapValues((m) => ({ ...m, [g.key]: String(sug.price) })); setPreview(null) }}>use it</button>
                            </>
                          ) : (
                            <>No verifiable figure found — {sug.note}</>
                          )}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <button type="button" onClick={generate} disabled={unresolved.length > 0 || production.rows.length === 0 && genTerms?.leaseType === 'crop_share'} className={BTN}>
              {unresolved.length > 0 ? `Answer ${unresolved.length} more to generate` : 'Generate settlement'}
            </button>
          </>
        )}

        {preview && (
          <div className="rounded-xl border border-slate-200 p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold flex-1">
                {preview.landownerName} — {preview.cropYear} · {preview.bushelsOnly ? 'balance' : 'total due'} {fmtUsd(preview.totalDue)}
              </h3>
              <button type="button" className={BTN_GRAY} onClick={() => void exportStatement(preview, 'pdf')}>Download PDF</button>
              <button type="button" className={BTN_GRAY} onClick={() => void exportStatement(preview, 'excel')}>Excel</button>
              <button type="button" className={BTN} onClick={() => void saveSettlement()} disabled={savingSettlement}>
                {savingSettlement ? 'Saving…' : 'Save settlement'}
              </button>
            </div>
            {preview.sections.map((sec) => (
              <div key={sec.title} className="text-sm">
                <p className="font-semibold text-slate-700">{sec.title}</p>
                <ul className="ml-3">
                  {sec.lines.map((l, i) => (
                    <li key={i} className="flex justify-between gap-3 py-0.5">
                      <span>{l.label} <span className="text-[10px] text-slate-400">[{l.source}]</span></span>
                      <span className="tabular-nums">{l.amount != null ? fmtUsd(l.amount) : l.quantityBu != null ? `${l.quantityBu.toLocaleString()} bu` : ''}</span>
                    </li>
                  ))}
                  <li className="flex justify-between gap-3 border-t border-slate-100 font-semibold py-0.5">
                    <span>Subtotal</span><span className="tabular-nums">{fmtUsd(sec.subtotal)}</span>
                  </li>
                </ul>
              </div>
            ))}
            <p className="text-xs text-slate-500">
              The PDF renders under <b>{branding?.displayName ?? 'your operation'}</b>&rsquo;s branding (Settings → Organization) — no Turnrow marks.
            </p>
          </div>
        )}
      </section>

      {/* ---- 3. Saved settlements ---- */}
      <section className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">Saved settlements</h2>
        {settlements.length === 0 && <p className="text-sm text-slate-400">None yet.</p>}
        <ul className="divide-y divide-slate-100">
          {settlements.map((s) => (
            <li key={s.id} className="py-2 flex items-center gap-3 text-sm">
              <span className="flex-1">
                {landownerById.get(s.landowner_id)?.name ?? '?'} — {s.crop_year}
                <span className="text-slate-400"> · generated {s.generated_at.slice(0, 10)}</span>
              </span>
              <span className="tabular-nums font-semibold">{s.total_due != null ? fmtUsd(Number(s.total_due)) : ''}</span>
              <button type="button" className={BTN_GRAY} onClick={() => void exportStatement(s.statement as SettlementStatement, 'pdf')}>PDF</button>
              <button type="button" className="text-red-600 text-sm" onClick={() => void deleteSettlement(s.id)}>Delete</button>
            </li>
          ))}
        </ul>
      </section>

      {err && <p className="text-sm text-red-600">{err}</p>}
    </div>
  )
}
