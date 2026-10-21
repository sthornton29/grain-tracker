'use client'

// A cotton sales contract's quality terms on the Marketing page (0097,
// 2026-10-20): the compact view (headline + cap tracker + a link to the
// Bale Quality report pre-filtered to the contract), "Add / Edit quality
// requirements" (the structured editor), and "Read quality terms from
// document" — upload the contract PDF (or use the one already read) and the
// reader's wording becomes rules through lib/cotton-contract-spec; it fills
// or updates ONLY this contract's spec and never creates a contract.

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/friendly-error'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { DEFAULT_MAX_TOKENS, parseDocumentChunked } from '@/lib/parse-chunked'
import { planPagesPerBatch } from '@/lib/chunk-plan'
import { mergeCottonMarketing } from '@/lib/parse-merge'
import type { CottonContractExtract, CottonMarketingExtraction } from '@/lib/cotton-doc-import'
import { EMPTY_SPEC, rulesFromWording, specHasFiberTerms, specSummaryLine, type ContractQualitySpec, type NotUnderstood } from '@/lib/cotton-contract-spec'
import { contractView, type BaleRow } from '@/lib/bale-quality-report'
import { FACTORS } from '@/lib/cotton-quality'
import { fmtInt, toneText } from '@/components/reports/report-kit'
import ContractSpecEditor, { type FarmOption } from '@/components/cotton/contract-spec-editor'
import type { CottonSalesContract } from '@/lib/types'

const btnCls = 'rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-10 text-sm font-semibold disabled:opacity-50'
const btnGray = 'rounded-lg bg-white border border-slate-300 px-3 min-h-10 text-sm disabled:opacity-50'
const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

/** The database row for a spec (what we write). */
export function specRowFor(contractId: string, spec: ContractQualitySpec): Record<string, unknown> {
  return {
    contract_id: contractId,
    allowed_color_codes: spec.allowed_color_codes?.length ? spec.allowed_color_codes : null,
    leaf_max: spec.leaf_max, staple_min: spec.staple_min, mic_min: spec.mic_min, mic_max: spec.mic_max,
    strength_min: spec.strength_min, uniformity_min: spec.uniformity_min, extraneous_rule: spec.extraneous_rule,
    excluded_remarks: spec.excluded_remarks?.length ? spec.excluded_remarks : null,
    eligible_fsa_farms: spec.eligible_fsa_farms?.length ? spec.eligible_fsa_farms : null,
    require_dryland: spec.require_dryland, bale_cap: spec.bale_cap, estimated_bales: spec.estimated_bales,
    base_grade: spec.base_grade, base_price_cents: spec.base_price_cents, off_spec_terms: spec.off_spec_terms,
    other_terms: spec.other_terms, source_clause: spec.source_clause, schedule: spec.schedule,
  }
}

/** Read the quality terms off a contract document through the shared reader. */
export async function readQualityTerms(source: DocumentSource, onProgress?: (s: string | null) => void): Promise<{ extracted: CottonContractExtract | null; warning: string | null }> {
  const { data, warning } = await parseDocumentChunked<CottonMarketingExtraction>(
    source.kind === 'pdf' ? source.file : source.images,
    'cotton_marketing_document',
    { category: 'sales_contract', pagesPerBatch: planPagesPerBatch({ documentType: 'cotton_marketing_document', maxTokens: DEFAULT_MAX_TOKENS }), onProgress, merge: mergeCottonMarketing },
  )
  return { extracted: (data?.extracted as CottonContractExtract | null) ?? null, warning: warning ?? null }
}

/** The compact contract view: headline, cap tracker, link to the report. */
export function ContractSpecSummary({ contractId, label, spec, rows, appEstimatedBales }: { contractId: string; label: string; spec: ContractQualitySpec; rows: ReadonlyArray<BaleRow>; appEstimatedBales: number | null }) {
  const view = useMemo(() => contractView(rows, spec, appEstimatedBales), [rows, spec, appEstimatedBales])
  const s = view.summary
  const capPct = s.cap && s.cap > 0 ? Math.min(1, s.meets / s.cap) : null
  return (
    <div className="space-y-2 text-sm">
      <div className="text-xs text-slate-500">{specSummaryLine(spec)}{spec.eligible_fsa_farms?.length ? ` · ${spec.eligible_fsa_farms.length} eligible FSA farms` : ''}</div>
      <div className="font-semibold">
        {s.eligibleClassed > 0
          ? <>{s.meets.toLocaleString()} of {s.eligibleClassed.toLocaleString()} classed bales from eligible farms meet {label}&rsquo;s spec <span className={toneText(s.passRate != null && s.passRate >= 0.5 ? 'favorable' : 'warning')}>({pct1(s.passRate)})</span> · {fmtInt(s.meetsLbs)} lbs</>
          : <>No classed bales from eligible farms yet</>}
        <span className="font-normal text-slate-500"> · {s.notEligible.toLocaleString()} not eligible · {s.notClassed.toLocaleString()} not yet classed</span>
      </div>
      {s.cap != null && (
        <div className="space-y-1">
          <div className="h-3 rounded bg-slate-100 overflow-hidden"><div className="h-full bg-green-600 rounded-r" style={{ width: `${(capPct ?? 0) * 100}%` }} /></div>
          <div className="text-xs tabular-nums text-slate-600">{s.meets.toLocaleString()} qualifying of the {s.cap.toLocaleString()} cap{s.projection ? ` · ${s.projection.projected.toLocaleString()} projected (estimate: ${pct1(s.passRate)} × ${s.projection.estimatedBales.toLocaleString()})` : ''}</div>
        </div>
      )}
      {s.pareto.length > 0 && (
        <div className="text-xs text-slate-600">Top reasons bales fail: {s.pareto.slice(0, 3).map((p) => `${FACTORS[p.factor].short} ${p.bales}`).join(' · ')}</div>
      )}
      <Link href={`/reports/bale-quality?contract=${encodeURIComponent(contractId)}`} className="inline-flex items-center text-brand-deep font-semibold hover:underline min-h-9">Open in the Bale Quality report →</Link>
    </div>
  )
}

export default function ContractSpecPanel({ contract, label, spec, farms, rows, appEstimatedBales, onSaved }: {
  contract: CottonSalesContract
  label: string
  spec: ContractQualitySpec | null
  farms: ReadonlyArray<FarmOption>
  rows: ReadonlyArray<BaleRow>
  appEstimatedBales: number | null
  onSaved: (msg: string) => Promise<void> | void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [mode, setMode] = useState<'view' | 'edit' | 'read'>('view')
  const [draft, setDraft] = useState<ContractQualitySpec>(spec ?? EMPTY_SPEC)
  const [notUnderstood, setNotUnderstood] = useState<NotUnderstood[]>([])
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [readNote, setReadNote] = useState<string | null>(null)

  const startEdit = () => { setDraft(spec ?? EMPTY_SPEC); setNotUnderstood([]); setErr(null); setReadNote(null); setMode('edit') }

  async function runRead(source: DocumentSource) {
    setBusy(true); setErr(null); setReadNote(null)
    try {
      const { extracted, warning } = await readQualityTerms(source, setStage)
      if (warning) setErr(warning)
      const q = extracted?.quality ?? null
      if (!q) {
        setReadNote('The reader found no quality requirements in this document. You can enter them by hand below.')
        setDraft(spec ?? EMPTY_SPEC)
        setNotUnderstood([])
      } else {
        const { spec: read, notUnderstood: miss } = rulesFromWording(q)
        // Reading fills or updates ONLY this contract's spec: keep what the
        // existing spec says where the document is silent.
        const base = spec ?? EMPTY_SPEC
        setDraft({
          ...base, ...read,
          allowed_color_codes: read.allowed_color_codes ?? base.allowed_color_codes,
          leaf_max: read.leaf_max ?? base.leaf_max, staple_min: read.staple_min ?? base.staple_min,
          mic_min: read.mic_min ?? base.mic_min, mic_max: read.mic_max ?? base.mic_max,
          strength_min: read.strength_min ?? base.strength_min, uniformity_min: read.uniformity_min ?? base.uniformity_min,
          eligible_fsa_farms: read.eligible_fsa_farms ?? base.eligible_fsa_farms, schedule: read.schedule ?? base.schedule,
          bale_cap: read.bale_cap ?? base.bale_cap ?? (contract.committed_bales != null ? Number(contract.committed_bales) : null),
          estimated_bales: read.estimated_bales ?? base.estimated_bales,
          base_grade: read.base_grade ?? base.base_grade, base_price_cents: read.base_price_cents ?? base.base_price_cents,
          off_spec_terms: read.off_spec_terms ?? base.off_spec_terms, other_terms: read.other_terms ?? base.other_terms,
          source_clause: read.source_clause ?? base.source_clause,
          require_dryland: base.require_dryland,
        })
        setNotUnderstood(miss)
        setReadNote(`Read ${[read.allowed_color_codes && 'color', read.leaf_max != null && 'leaf', read.staple_min != null && 'staple', (read.mic_min != null || read.mic_max != null) && 'micronaire', read.strength_min != null && 'strength', read.uniformity_min != null && 'uniformity', read.eligible_fsa_farms && `${read.eligible_fsa_farms.length} farms`].filter(Boolean).join(', ') || 'nothing mappable'} from the document. Check it against the wording, then save.`)
      }
      setMode('edit')
    } catch (e) {
      setErr(reportError(e as Error, { action: 'read the contract document' }))
    } finally { setBusy(false); setStage(null) }
  }

  async function save() {
    setBusy(true); setErr(null)
    try {
      const { error } = await supabase.from('cotton_contract_specs').upsert(specRowFor(contract.id, draft), { onConflict: 'contract_id' })
      if (error) throw error
      setMode('view')
      await onSaved(`Quality requirements saved for ${label}.`)
    } catch (e) {
      setErr(reportError(e as Error, { action: 'save the quality requirements', noun: 'contract' }))
    } finally { setBusy(false) }
  }

  async function remove() {
    setBusy(true); setErr(null)
    try {
      const { error } = await supabase.from('cotton_contract_specs').delete().eq('contract_id', contract.id)
      if (error) throw error
      setMode('view')
      await onSaved(`Quality requirements removed from ${label}.`)
    } catch (e) {
      setErr(reportError(e as Error, { action: 'remove the quality requirements', noun: 'contract' }))
    } finally { setBusy(false) }
  }

  const hasSpec = spec != null && specHasFiberTerms(spec)

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-semibold text-sm flex-1">Quality requirements — {label}</div>
        {mode === 'view' && (
          <>
            <button type="button" className={btnGray} onClick={startEdit}>{hasSpec ? 'Edit' : 'Add quality requirements'}</button>
            <button type="button" className={btnGray} onClick={() => { setErr(null); setReadNote(null); setMode('read') }}>Read quality terms from document</button>
            {spec && <button type="button" className="text-sm text-red-700 px-2 min-h-10" onClick={() => void remove()} disabled={busy}>Remove</button>}
          </>
        )}
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}

      {mode === 'view' && (
        hasSpec
          ? <ContractSpecSummary contractId={contract.id} label={label} spec={spec!} rows={rows} appEstimatedBales={appEstimatedBales} />
          : <p className="text-sm text-slate-500">No quality requirements on this contract. Add them by hand, or read them from the contract document — every classed bale is then scored against them on the Bale Quality report.</p>
      )}

      {mode === 'read' && (
        <div className="space-y-2">
          <DocumentCapture onSource={(s) => void runRead(s)} busy={busy} stageLabel={busy ? stage ?? 'Reading the contract…' : null} pdfLabel="Upload the contract PDF" />
          <p className="text-xs text-slate-500">The reader lifts the quality clause and the farm schedule as written; Turnrow turns the wording into rules and shows them for review. Nothing saves until you press Save, and this never creates a new contract.</p>
          <button type="button" className={btnGray} onClick={() => setMode('view')} disabled={busy}>Cancel</button>
        </div>
      )}

      {mode === 'edit' && (
        <div className="space-y-3">
          {readNote && <p className="text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">{readNote}</p>}
          <ContractSpecEditor value={draft} onChange={setDraft} farms={farms} notUnderstood={notUnderstood} clause={spec?.source_clause ?? null} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnCls} onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save quality requirements'}</button>
            <button type="button" className={btnGray} onClick={() => setMode('view')} disabled={busy}>Cancel</button>
            {mode === 'edit' && <button type="button" className={btnGray} onClick={() => setMode('read')} disabled={busy}>Read from document instead</button>}
          </div>
        </div>
      )}
    </div>
  )
}
