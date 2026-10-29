'use client'

// Upload an FSA Payment Statement (0099): the shared dropzone → the chunked
// document reader (document_type 'fsa_payment_statement', even pages
// straightened first) → a review of the statement header, the four code
// checks, the lines grouped by farm (unmatched FSA numbers flagged, a farm
// pickable), the payee matched to an entity (or created), the PAYEE TIE-IN
// ("This statement paid MARTIN FARM for program year 2025 on 23 farms.
// Turnrow has View Celeste / Two Seasons." → one click sets the program-year
// payee) and the PARAMETER TIE-IN (the statement's sequester % vs the program
// year's parameter). Nothing saves until Save; a line whose FSA Payment ID is
// already on file is "already recorded" and never duplicated.

import { useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/friendly-error'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { PdfTooLargeError, deleteStorageObject, uploadFileToStorage } from '@/lib/pdf-upload'
import { imagesToPdf } from '@/lib/image-capture'
import { getPdfPageCount } from '@/lib/pdf-split'
import {
  buildLineReviews, checkStatement, matchPayeeEntity, mergeFsaPaymentStatements, normalizeFsaPaymentStatement, officeCountyName,
  payeeNoticeText, planStatementSave, rebaseFsaPages, reviewTotals, PROGRAM_CODE_LABEL,
  type FsaPaymentStatementExtraction, type StatementCheck, type StatementLineReview,
} from '@/lib/fsa-payment-statement'
import { indexPayees, payeeMismatches } from '@/lib/program-payee'
import { resolveProgramYearConfig } from '@/lib/program-config'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import { fmtUsd, fmtPct, selectCls } from '@/components/reports/report-kit'
import { fmtDate } from '@/lib/format-date'
import type { County, CoveredCommodity, Entity, Farm, FarmProgramPayee, FsaPaymentLine, ProgramYearConfig } from '@/lib/types'

export const FSA_STATEMENT_DOC_PREFIX = 'fsa-statements'

type Props = {
  farms: Farm[]
  entities: Entity[]
  commodities: CoveredCommodity[]
  counties: County[]
  programConfigs: ProgramYearConfig[]
  payees: FarmProgramPayee[]
  existingLines: FsaPaymentLine[]
  /** After a save, a payee change, or a parameter change: refetch. */
  onChanged: () => void
}

type Review = StatementLineReview & { farmId: string | null; include: boolean }

export default function FsaPaymentStatementImport({ farms, entities, commodities, counties, programConfigs, payees, existingLines, onChanged }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [normalized, setNormalized] = useState<File | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [extraction, setExtraction] = useState<FsaPaymentStatementExtraction | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [payeeEntityId, setPayeeEntityId] = useState('')
  const [createPayee, setCreatePayee] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // A second Save while one is in flight (or a replayed click) must not run twice.
  const savingRef = useRef(false)

  const existingIds = useMemo(() => new Set(existingLines.map((l) => l.fsa_payment_id)), [existingLines])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const commodityById = useMemo(() => new Map(commodities.map((c) => [c.id, c])), [commodities])
  const payeeIdx = useMemo(() => indexPayees(payees), [payees])

  /** The county the office serves, resolved against the counties the farms sit in first. */
  function officeCountyId(x: FsaPaymentStatementExtraction): string | null {
    const name = officeCountyName(x.office_name)
    if (!name) return null
    const farmCounties = new Set(farms.map((f) => f.county_id).filter(Boolean))
    const hits = counties.filter((c) => c.name.trim().toLowerCase() === name)
    return hits.find((c) => farmCounties.has(c.id))?.id ?? (hits.length === 1 ? hits[0].id : null)
  }

  async function onSource(src: DocumentSource) {
    setErr(null); setBanner(null); setSource(src); setExtraction(null); setReviews([]); setNormalized(null)
    setStage('Reading the statement…')
    try {
      const input = src.kind === 'pdf' ? src.file : src.images
      const { data, warning, pagesRead } = await parseDocumentChunked<FsaPaymentStatementExtraction>(input, 'fsa_payment_statement', {
        onProgress: setStage,
        rebase: (part, firstPage) => rebaseFsaPages(normalizeFsaPaymentStatement(part), firstPage),
        merge: mergeFsaPaymentStatements,
        onNormalized: setNormalized,
      })
      const blocks = data.blocks ?? []
      if (blocks.length === 0) {
        setErr(warning ?? 'No payment blocks were found in this document. Check it is an FSA Payment Statement and the scan is readable.')
        return
      }
      if (warning) setErr(warning)
      let pages: number | null = pagesRead || null
      if (src.kind === 'pdf') pages = await getPdfPageCount(src.file).catch(() => pages)
      setPageCount(pages)
      setExtraction(data)
      const rows = buildLineReviews({ extraction: data, farms, commodities, existingPaymentIds: existingIds, officeCountyId: officeCountyId(data) })
      setReviews(rows)
      const payee = matchPayeeEntity(data.payee_name, entities)
      setPayeeEntityId(payee?.id ?? '')
      setCreatePayee(!payee && !!data.payee_name)
      const t = reviewTotals(rows, commodities)
      const recorded = rows.filter((r) => r.alreadyRecorded).length
      setBanner(`Read ${rows.length} payment block${rows.length === 1 ? '' : 's'} on ${t.farms} farm${t.farms === 1 ? '' : 's'}, ${fmtUsd(t.net)} net${recorded > 0 ? ` — ${recorded} already recorded` : ''}. Review before saving.`)
    } catch (e: unknown) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(reportError(e as Error, { action: 'read the statement', noun: 'statement' }))
    } finally {
      setStage(null)
    }
  }

  function discard() { setSource(null); setExtraction(null); setReviews([]); setBanner(null); setErr(null); setNormalized(null) }
  function setFarm(key: string, farmId: string) { setReviews((rs) => rs.map((r) => (r.key === key ? { ...r, farmId: farmId || null, farmAmbiguous: false } : r))) }
  function setInclude(key: string, include: boolean) { setReviews((rs) => rs.map((r) => (r.key === key ? { ...r, include } : r))) }

  const checks: StatementCheck[] = useMemo(() => (extraction ? checkStatement(extraction) : []), [extraction])
  const totals = useMemo(() => reviewTotals(reviews, commodities), [reviews, commodities])
  const statementEntityId = payeeEntityId || null

  // The payee tie-in: lines whose program-year payee in Turnrow is not the statement's payee.
  const mismatches = useMemo(() => payeeMismatches({
    lines: reviews.filter((r) => r.programCode !== 'OTHER').map((r) => ({ farm_id: r.farmId, program_year: r.programYear })),
    statementEntityId, farms, payees: payeeIdx,
  }), [reviews, statementEntityId, farms, payeeIdx])

  // The parameter tie-in: the statement's sequester % vs the program year's parameter.
  const sequesterNotices = useMemo(() => {
    const out: Array<{ programYear: number; statement: number; config: number; hasRow: boolean }> = []
    const years = new Set(reviews.map((r) => r.programYear).filter((y): y is number => y != null))
    for (const y of years) {
      const seq = reviews.find((r) => r.programYear === y && r.sequesterPct != null)?.sequesterPct
      if (seq == null) continue
      const cfg = resolveProgramYearConfig(y, programConfigs)
      if (Math.abs(cfg.sequestrationPct - seq) > 1e-6 || cfg.isFallback) out.push({ programYear: y, statement: seq, config: cfg.sequestrationPct, hasRow: !cfg.isFallback })
    }
    return out
  }, [reviews, programConfigs])

  async function applyPayee(programYear: number, farmIds: string[]) {
    if (!statementEntityId) return
    setBusy('payee'); setErr(null)
    try {
      const now = new Date().toISOString()
      const explicit = farmIds.filter((id) => farmById.get(id)?.entity_id !== statementEntityId)
      const defaults = farmIds.filter((id) => farmById.get(id)?.entity_id === statementEntityId)
      if (defaults.length > 0) {
        const { error } = await supabase.from('farm_program_payees').delete().eq('program_year', programYear).in('farm_id', defaults)
        if (error) throw error
      }
      if (explicit.length > 0) {
        const { error } = await supabase.from('farm_program_payees').upsert(
          explicit.map((farm_id) => ({ farm_id, program_year: programYear, entity_id: statementEntityId, note: `Set from the ${extraction?.statement_date ? fmtDate(extraction.statement_date) : ''} FSA payment statement`, updated_at: now })),
          { onConflict: 'org_id,farm_id,program_year' },
        )
        if (error) throw error
      }
      onChanged()
    } catch (e) {
      setErr(reportError(e as Error, { action: 'set the payee', noun: 'payee' }))
    } finally {
      setBusy(null)
    }
  }

  async function applySequester(programYear: number, pct: number) {
    setBusy('seq'); setErr(null)
    try {
      const cfg = resolveProgramYearConfig(programYear, programConfigs)
      const { error } = await supabase.from('program_year_config').upsert({
        crop_year: programYear,
        sco_trigger: cfg.scoTrigger, per_person_payment_limit: cfg.perPersonPaymentLimit, sequestration_pct: pct,
        arc_guarantee_pct: cfg.arcGuaranteePct, arc_payment_cap_pct: cfg.arcPaymentCapPct, erp_olympic_factor: cfg.erpOlympicFactor,
        erp_cap_pct: cfg.erpCapPct, payment_factor: cfg.paymentFactor, arc_ic_payment_factor: cfg.arcIcPaymentFactor,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'crop_year' })
      if (error) throw error
      onChanged()
    } catch (e) {
      setErr(reportError(e as Error, { action: 'update the program parameters', noun: 'program year' }))
    } finally {
      setBusy(null)
    }
  }

  async function saveAll() {
    if (!extraction || savingRef.current) return
    savingRef.current = true
    setSaving(true); setErr(null)
    try {
      let entityId = payeeEntityId || null
      if (!entityId && createPayee && extraction.payee_name) {
        const { data, error } = await supabase.from('entities').insert({ name: titleCase(extraction.payee_name), payment_limit_persons: 1 }).select('id').single()
        if (error || !data) throw error ?? new Error('Could not add the entity')
        entityId = (data as { id: string }).id
      }
      // Ask the database which FSA Payment IDs are on file NOW — the list the
      // page loaded with can be stale (this statement saved moments ago), and a
      // statement row must never be written for lines that then collide.
      const ids = reviews.map((r) => r.block.fsa_payment_id).filter((x): x is string => !!x)
      const onFile = ids.length > 0
        ? await supabase.from('fsa_payment_lines').select('fsa_payment_id').in('fsa_payment_id', ids)
        : { data: [] as Array<{ fsa_payment_id: string }>, error: null }
      if (onFile.error) throw onFile.error
      const onFileIds = new Set(((onFile.data ?? []) as Array<{ fsa_payment_id: string }>).map((r) => r.fsa_payment_id))
      const fresh = reviews.map((r) => (!r.alreadyRecorded && r.block.fsa_payment_id && onFileIds.has(r.block.fsa_payment_id) ? { ...r, alreadyRecorded: true, include: false } : r))
      if (fresh.some((r, i) => r !== reviews[i])) setReviews(fresh)
      const plan = planStatementSave({ extraction, reviews: fresh, payeeEntityId: entityId, pageCount })
      if (plan.blockers.length > 0) { setErr(plan.blockers.join(' ')); return }
      if (plan.lines.length === 0) {
        setBanner(plan.alreadyRecorded.length > 0 ? 'Every payment on this statement is already recorded — nothing new to save.' : 'Nothing is ticked to save.')
        return
      }
      // The document: the straightened PDF (or the photos as one PDF).
      let documentUrl: string | null = null
      let documentPath: string | null = null
      try {
        const file = source?.kind === 'pdf' ? (normalized ?? source.file) : source ? await imagesToPdf(source.images, `fsa-statement-${extraction.statement_date ?? 'scan'}`) : null
        if (file) {
          const up = await uploadFileToStorage(supabase, file, FSA_STATEMENT_DOC_PREFIX, 'application/pdf')
          documentUrl = up.publicUrl; documentPath = up.path
        }
      } catch {
        documentUrl = null; documentPath = null
      }
      const { data: st, error: stErr } = await supabase.from('fsa_payment_statements')
        .insert({ ...plan.statement, document_url: documentUrl, document_path: documentPath })
        .select('id').single()
      if (stErr || !st) throw stErr ?? new Error('Could not save the statement')
      const statementId = (st as { id: string }).id
      const { data: inserted, error: lnErr } = await supabase.from('fsa_payment_lines')
        .insert(plan.lines.map((l) => ({ ...l.row, statement_id: statementId })))
        .select('id, fsa_payment_id')
      if (lnErr || !inserted) {
        // No statement without its lines: take the header row (and its PDF) back out.
        await supabase.from('fsa_payment_statements').delete().eq('id', statementId)
        if (documentPath) await deleteStorageObject(supabase, documentPath).catch(() => undefined)
        throw lnErr ?? new Error('Could not save the payment lines')
      }
      const idByPayment = new Map((inserted as Array<{ id: string; fsa_payment_id: string }>).map((r) => [r.fsa_payment_id, r.id]))
      const cropRows = plan.lines.flatMap((l) => {
        const lineId = idByPayment.get(l.row.fsa_payment_id)
        return lineId ? l.crops.map((c) => ({ ...c, line_id: lineId })) : []
      })
      if (cropRows.length > 0) {
        const { error } = await supabase.from('fsa_payment_crop_amounts').insert(cropRows)
        if (error) throw error
      }
      const otherRows = plan.lines.flatMap((l) => {
        const lineId = idByPayment.get(l.row.fsa_payment_id)
        return l.otherPayment && lineId ? [{ ...l.otherPayment, payment_status: 'received', notes: `FSA Payment ID ${l.row.fsa_payment_id}`, fsa_payment_line_id: lineId }] : []
      })
      if (otherRows.length > 0) {
        const { error } = await supabase.from('other_government_payments').insert(otherRows)
        if (error) throw error
      }
      setBanner(`Saved: ${plan.lines.length} payment line${plan.lines.length === 1 ? '' : 's'} (${fmtUsd(plan.lines.reduce((s, l) => s + l.row.net_payment, 0))})${plan.alreadyRecorded.length > 0 ? `; ${plan.alreadyRecorded.length} already recorded` : ''}.`)
      setExtraction(null); setReviews([]); setSource(null); setNormalized(null)
      onChanged()
    } catch (e) {
      setErr(reportError(e as Error, { action: 'save the statement', noun: 'statement' }))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // Lines grouped by farm (FSA number), in document order.
  const groups = useMemo(() => {
    const m = new Map<string, Review[]>()
    for (const r of reviews) {
      const k = r.farmNumber ?? '(no farm)'
      const g = m.get(k) ?? []
      g.push(r)
      m.set(k, g)
    }
    return [...m.entries()]
  }, [reviews])

  const includedCount = reviews.filter((r) => r.include && !r.alreadyRecorded).length
  const badge = (ok: boolean) => ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 text-sm text-slate-600">
          Drop the FSA <b>Payment Statement</b> (the one headed “Retain for Tax Purposes”). Every program on it is read — ARC/PLC
          lines become the received payment per farm and crop; other programs land under Other USDA payments.
        </div>
        {source && !stage && <button type="button" onClick={discard} className="text-sm rounded-lg bg-white border border-slate-300 px-3 min-h-11">Discard</button>}
      </div>
      <DocumentCapture onSource={onSource} busy={stage != null} stageLabel={stage} pdfLabel="Upload FSA payment statement" />
      {err && <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{err}</p>}
      {banner && <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</p>}

      {extraction && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(16rem,22rem)] gap-4">
          <div className="space-y-4">
            {/* Header + checks */}
            <section className="rounded-lg border border-slate-200 p-3 space-y-2">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div><span className="text-slate-500">Statement date</span> <b>{extraction.statement_date ? fmtDate(extraction.statement_date) : '—'}</b></div>
                <div><span className="text-slate-500">Office</span> <b>{extraction.office_name ?? '—'}</b></div>
                <div><span className="text-slate-500">Payee</span> <b>{extraction.payee_name ?? '—'}</b></div>
                <div><span className="text-slate-500">Gross</span> <b className="tabular-nums">{fmtUsd(extraction.summary?.gross ?? 0)}</b></div>
                <div><span className="text-slate-500">Deductions</span> <b className="tabular-nums">{fmtUsd(extraction.summary?.deductions ?? 0)}</b></div>
                <div><span className="text-slate-500">Net</span> <b className="tabular-nums">{fmtUsd(extraction.summary?.net ?? 0)}</b></div>
                {pageCount != null && <div><span className="text-slate-500">Pages</span> <b>{pageCount}</b></div>}
              </div>
              <ul className="flex flex-wrap gap-2 text-xs">
                {checks.map((c) => (
                  <li key={c.key} className={`rounded-full px-2 py-1 ${badge(c.ok)}`} title={c.detail}>
                    {c.ok ? '✓' : '✗'} {c.label} <span className="opacity-75">· {c.detail}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <span className="text-slate-600">Paid to</span>
                  <select value={payeeEntityId} onChange={(e) => { setPayeeEntityId(e.target.value); setCreatePayee(false) }} className={selectCls} aria-label="Payee entity">
                    <option value="">— pick the entity —</option>
                    {entities.map((e) => <option key={e.id} value={e.id}>{e.name}{e.archived_at ? ' (archived)' : ''}</option>)}
                  </select>
                </label>
                {!payeeEntityId && extraction.payee_name && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="h-5 w-5" checked={createPayee} onChange={(e) => setCreatePayee(e.target.checked)} />
                    <span>Add <b>{titleCase(extraction.payee_name)}</b> as a new entity</span>
                  </label>
                )}
              </div>
            </section>

            {/* Payee tie-in */}
            {statementEntityId && mismatches.map((m) => {
              const names = [...new Set(m.turnrowEntityIds.map((id) => (id ? entityById.get(id)?.name ?? '?' : 'no entity')))]
              return (
                <div key={m.programYear} className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 flex flex-wrap items-center gap-3">
                  <span className="flex-1">{payeeNoticeText({ payeeName: extraction.payee_name ?? entityById.get(statementEntityId)?.name ?? 'the payee', programYear: m.programYear, farmCount: m.farmIds.length, turnrowEntityNames: names })}</span>
                  <button type="button" disabled={busy === 'payee'} onClick={() => applyPayee(m.programYear, m.farmIds)} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-11 text-sm font-semibold disabled:opacity-50">
                    Set the {m.programYear} payee to {entityById.get(statementEntityId)?.name ?? 'this entity'} on {m.farmIds.length} farm{m.farmIds.length === 1 ? '' : 's'}
                  </button>
                </div>
              )
            })}

            {/* Parameter tie-in */}
            {sequesterNotices.map((n) => (
              <div key={n.programYear} className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 flex flex-wrap items-center gap-3">
                <span className="flex-1">
                  The statement applies <b>{fmtPct(n.statement * 100, 1)}</b> sequestration to program year {n.programYear}; Turnrow&apos;s parameter is {fmtPct(n.config * 100, 1)}{n.hasRow ? '' : ' (carried from another year)'}.
                </span>
                <button type="button" disabled={busy === 'seq'} onClick={() => applySequester(n.programYear, n.statement)} className="rounded-lg bg-white border border-amber-300 px-3 min-h-11 text-sm font-semibold disabled:opacity-50">
                  Update {n.programYear} sequestration to {fmtPct(n.statement * 100, 1)}?
                </button>
              </div>
            ))}

            {/* Lines by farm */}
            <div className="space-y-3">
              {groups.map(([farmNumber, rows]) => {
                const first = rows[0]
                const farm = first.farmId ? farmById.get(first.farmId) : null
                const unmatched = !first.farmId
                return (
                  <section key={farmNumber} className={`rounded-lg border p-3 space-y-2 ${unmatched ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200'}`}>
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="font-semibold">
                        FSA farm {farmNumber}
                        {farm && <span className="ml-2 font-normal text-slate-600">— {farm.name}</span>}
                        {unmatched && <span className="ml-2 rounded-full bg-amber-100 text-amber-800 text-xs px-2 py-0.5 font-medium">{first.farmAmbiguous ? 'several farms carry this number' : 'not in Turnrow'}</span>}
                      </div>
                      <label className="text-sm flex items-center gap-2">
                        <span className="text-slate-500">Farm</span>
                        <select value={first.farmId ?? ''} onChange={(e) => rows.forEach((r) => setFarm(r.key, e.target.value))} className={selectCls} aria-label={`Farm for FSA number ${farmNumber}`}>
                          <option value="">keep unmatched (raw number saved)</option>
                          {farms.filter((f) => !f.archived_at).sort((a, b) => a.name.localeCompare(b.name)).map((f) => <option key={f.id} value={f.id}>{f.name}{f.fsa_number ? ` · ${f.fsa_number}` : ''}</option>)}
                        </select>
                      </label>
                    </div>
                    <table className="min-w-full text-sm">
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.key} className={`border-t border-slate-100 align-top ${r.alreadyRecorded ? 'text-slate-400' : ''}`}>
                            <td className="py-1 pr-2">
                              <input type="checkbox" className="h-5 w-5" checked={r.include} disabled={r.alreadyRecorded || r.block.complete === false} onChange={(e) => setInclude(r.key, e.target.checked)} aria-label={`Save ${PROGRAM_CODE_LABEL[r.programCode]} for farm ${farmNumber}`} />
                            </td>
                            <td className="py-1 pr-3 whitespace-nowrap">
                              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.programCode === 'PLC' ? 'bg-sky-100 text-sky-800' : r.programCode === 'OTHER' ? 'bg-slate-100 text-slate-700' : 'bg-violet-100 text-violet-800'}`}>{PROGRAM_CODE_LABEL[r.programCode]}</span>
                              {r.programCode === 'OTHER' && <span className="ml-1 text-xs">{r.block.program_title}</span>}
                              <div className="text-xs text-slate-500">program year {r.programYear ?? '?'} · ID {r.block.fsa_payment_id ?? '—'}{r.block.page ? ` · p.${r.block.page}` : ''}</div>
                            </td>
                            <td className="py-1 pr-3">
                              {r.crops.length === 0 && <span className="text-slate-400">no crop detail</span>}
                              {r.crops.map((c, i) => (
                                <span key={i} className="inline-block mr-3 whitespace-nowrap">
                                  {c.commodityId ? commodityById.get(c.commodityId)?.name ?? c.raw : <span className="text-amber-700" title="No covered commodity matches this crop name">{c.raw || '?'}</span>}{' '}
                                  <b className="tabular-nums">{fmtUsd(c.amount)}</b>
                                </span>
                              ))}
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">
                              <b>{fmtUsd(r.net)}</b>
                              {r.deductions !== 0 && <div className="text-xs text-slate-500">gross {fmtUsd(r.gross)} − {fmtUsd(r.deductions)}</div>}
                            </td>
                            <td className="py-1 whitespace-nowrap text-xs text-slate-600">
                              {r.paymentDate ? `${r.block.payment_method ?? 'paid'} ${fmtDate(r.paymentDate)}` : '—'}
                              {r.block.account_last4 && <div>…{r.block.account_last4}</div>}
                              {r.alreadyRecorded && <div className="rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 inline-block mt-1">already recorded</div>}
                              {r.block.complete === false && <div className="rounded-full bg-red-100 text-red-800 px-2 py-0.5 inline-block mt-1">header page unreadable</div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="text-slate-600">
                {reviews.length} line{reviews.length === 1 ? '' : 's'} · {totals.farms} farm{totals.farms === 1 ? '' : 's'} · net <b className="tabular-nums">{fmtUsd(totals.net)}</b>
                {[...totals.byProgram.entries()].map(([code, v]) => <span key={code} className="ml-3">{PROGRAM_CODE_LABEL[code]} <b className="tabular-nums">{fmtUsd(v)}</b></span>)}
              </span>
              <span className="flex-1" />
              <button type="button" onClick={saveAll} disabled={saving || includedCount === 0} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">
                {saving ? 'Saving…' : `Save ${includedCount} line${includedCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
          <SourcePreview source={source} className="h-[32rem] lg:h-auto" title="FSA payment statement" />
        </div>
      )}
    </div>
  )
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bLlc\b/g, 'LLC')
}
