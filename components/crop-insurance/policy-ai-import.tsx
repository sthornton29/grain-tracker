'use client'

// AI import for crop insurance policy documents (coverage summaries, premium
// billing statements). Extracts every crop/county policy plus any SCO/ECO
// endorsements, fuzzy-matches crops and counties, flags duplicates, and lets the
// user review and edit each row before saving. Mirrors the plantings/contract
// AI import patterns already in the app.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, parseDocument, type CropInsurancePolicyExtraction } from '@/lib/pdf-upload'
import { splitPdfIntoBatches } from '@/lib/pdf-split'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import {
  PLAN_TYPES, PLAN_TYPE_SHORT, PRACTICES, PRACTICE_LABEL, projectedPriceFromEstimates, resolveUploadEntityId,
  classifyPolicyUpload, type PolicyUploadStatus, type PlanType, type Practice,
} from '@/lib/crop-insurance'
import { DEFAULT_SCO_TRIGGER, resolveProgramYearConfig } from '@/lib/program-config'
import {
  COVERAGE_LEVELS, emptyPolicyForm, policyFormToPayloads, type PolicyFormState, PolicyLiveSummary,
} from '@/components/crop-insurance/policy-form'
import type {
  Crop, County, Entity, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco,
  HarvestPriceEstimate, ProgramYearConfig,
} from '@/lib/types'

type Props = {
  crops: Crop[]
  counties: County[]
  entities: Entity[]
  existingPolicies: CropInsurancePolicy[]
  // Existing endorsements — dedupe alongside their parent policy.
  existingScos?: CropInsuranceSco[]
  existingEcos?: CropInsuranceEco[]
  defaultYear: number
  defaultEntityId: string
  // RMA projected prices and per-year program parameters (fetched by the page).
  projectedEstimates?: HarvestPriceEstimate[]
  programConfigs?: ProgramYearConfig[]
  onImported: () => void
}

type Row = {
  form: PolicyFormState
  raw_crop: string | null
  raw_county: string | null
  // Whether the EXTRACTION provided these (vs seeded defaults/existing values) —
  // lets a later entity pick re-seed them from the newly-matched policy.
  raw_coverage_provided: boolean
  raw_unit_provided: boolean
  include: boolean
}

const numStr = (n: number | null | undefined) => (n == null || !Number.isFinite(Number(n)) ? '' : String(Number(n)))

// Snap an extracted coverage like 0.8 / 0.825 to the nearest offered level.
function snapCoverage(n: number | null | undefined): string {
  if (n == null) return '0.80'
  const target = Number(n) > 1 ? Number(n) / 100 : Number(n) // tolerate "80" meaning 0.80
  let best = COVERAGE_LEVELS[0] as string
  let bestD = Infinity
  for (const l of COVERAGE_LEVELS) {
    const d = Math.abs(Number(l) - target)
    if (d < bestD) { bestD = d; best = l }
  }
  return best
}

// Identity for dedup: entity + crop + county + crop_year + practice + plan_type
// (a policy is uniquely identified by these; coverage can change without being a
// new row). Entity is included so the same crop/county/practice for two
// different entities are separate policies, not duplicates.
function dedupKey(entity_id: string, crop_id: string, county_id: string, year: string, plan: string, practice: string): string {
  return `${entity_id}|${crop_id}|${county_id}|${year}|${plan}|${practice}`
}

export default function PolicyAiImport({ crops, counties, entities, existingPolicies, existingScos = [], existingEcos = [], defaultYear, defaultEntityId, projectedEstimates = [], programConfigs = [], onImported }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  // The insured entity for this upload — one crop-insurance document belongs to
  // one entity, applied to every extracted policy. Single-entity ops auto-assign.
  const [importEntityId, setImportEntityId] = useState(
    defaultEntityId || (entities.length === 1 ? entities[0].id : ''),
  )

  // Existing policies keyed by entity+crop+county+year+plan+practice, so a
  // re-import updates the match instead of inserting a duplicate.
  const existingByKey = useMemo(
    () => new Map(existingPolicies.map((p) =>
      [dedupKey(p.entity_id ?? '', p.crop_id, p.county_id ?? '', String(p.crop_year), p.plan_type, p.practice ?? 'non_irrigated'), p] as const)),
    [existingPolicies],
  )
  const scoByPolicy = useMemo(() => new Map(existingScos.map((s) => [s.policy_id, s])), [existingScos])
  const ecoByPolicy = useMemo(() => new Map(existingEcos.map((e) => [e.policy_id, e])), [existingEcos])

  // Apply a chosen entity to every reviewed row (the whole upload is one
  // entity). The dedup match key includes the entity, so re-seed the values the
  // extraction didn't provide (coverage/unit/attestation) from the policy the
  // row NOW matches — otherwise a late entity pick would diff seeded defaults
  // against the stored policy and flag false updates.
  function applyImportEntity(id: string) {
    setImportEntityId(id)
    setRows((rs) => rs.map((r) => {
      const existing = existingByKey.get(dedupKey(id, r.form.crop_id, r.form.county_id, r.form.crop_year, r.form.plan_type, r.form.practice)) ?? null
      const patch: Partial<PolicyFormState> = { entity_id: id }
      if (existing) {
        if (!r.raw_coverage_provided) patch.coverage_level = snapCoverage(existing.coverage_level)
        if (!r.raw_unit_provided) patch.unit_structure = existing.unit_structure
        patch.covers_all_planted_acres = existing.covers_all_planted_acres
        patch.coverage_note = existing.coverage_note ?? ''
      }
      return { ...r, form: { ...r.form, ...patch } }
    }))
  }

  // Entities load asynchronously on the page, so the useState seed above can be
  // stale (empty entities → ''). Once they arrive, auto-assign the resolved
  // entity (a single-entity op's only entity, or a provided default) when the
  // user hasn't chosen one — and stamp it onto any already-extracted rows so the
  // dedup key and the insert both carry it. Never overrides a user's selection.
  useEffect(() => {
    const resolved = resolveUploadEntityId({ entities, chosen: importEntityId, fallback: defaultEntityId })
    if (resolved && resolved !== importEntityId) applyImportEntity(resolved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities, defaultEntityId, importEntityId])

  function extractionToForm(p: CropInsurancePolicyExtraction): { form: PolicyFormState; raw_crop: string | null; raw_county: string | null; raw_coverage_provided: boolean; raw_unit_provided: boolean } {
    const crop = findBestMatch(p.crop, crops, (c) => c.name)
    const county = findBestMatch(
      [p.county, p.state].filter(Boolean).join(' '),
      counties,
      (c) => `${c.name} ${c.state} ${c.state_code}`,
    )
    const year = p.crop_year != null && Number.isFinite(p.crop_year) ? String(p.crop_year) : String(defaultYear)
    const plan: PlanType = p.plan_type && (PLAN_TYPES as readonly string[]).includes(p.plan_type) ? p.plan_type : 'RP'
    const projected = p.projected_price ?? (crop ? projectedPriceFromEstimates(projectedEstimates, crop.id, Number(year)) : null)
    const scoTriggerDefault = Number.isFinite(Number(year))
      ? resolveProgramYearConfig(Number(year), programConfigs).scoTrigger
      : DEFAULT_SCO_TRIGGER
    const sco = p.sco
    const eco = p.eco
    const practice: Practice = p.practice === 'irrigated' ? 'irrigated' : 'non_irrigated'
    // Seed the "covers all planted acres" attestation — and any value the
    // extraction did NOT provide (coverage level, unit structure) — from a
    // matching existing policy, so a re-import reflects what's on file instead
    // of flagging a default-vs-stored false difference. A brand-new policy
    // defaults to unattested / 80% / enterprise.
    const existing = existingByKey.get(dedupKey(importEntityId, crop?.id ?? '', county?.id ?? '', year, plan, practice)) ?? null
    const form: PolicyFormState = {
      ...emptyPolicyForm,
      entity_id: importEntityId,
      crop_id: crop?.id ?? '',
      crop_year: year,
      county_id: county?.id ?? '',
      policy_number: p.policy_number ?? '',
      plan_type: plan,
      practice,
      covers_all_planted_acres: existing?.covers_all_planted_acres ?? false,
      coverage_note: existing?.coverage_note ?? '',
      coverage_level: p.coverage_level != null
        ? snapCoverage(p.coverage_level)
        : existing != null ? snapCoverage(existing.coverage_level) : snapCoverage(null),
      unit_structure: p.unit_structure && ['enterprise', 'basic', 'optional'].includes(p.unit_structure)
        ? p.unit_structure
        : existing?.unit_structure ?? 'enterprise',
      aph_yield: numStr(p.aph_yield),
      projected_price: numStr(projected),
      insured_acres: numStr(p.insured_acres),
      premium_per_acre: numStr(p.premium_per_acre),
      total_premium: numStr(p.total_premium),
      premium_subsidy_pct: numStr(p.premium_subsidy_pct),
      sco_enabled: !!sco?.present,
      sco_coverage_trigger: numStr(sco?.coverage_trigger) || String(scoTriggerDefault),
      sco_expected_county_yield: numStr(sco?.expected_county_yield),
      sco_premium_per_acre: numStr(sco?.premium_per_acre),
      sco_total_premium: numStr(sco?.total_premium),
      eco_enabled: !!eco?.present,
      eco_trigger_level: eco?.trigger_level ? String(eco.trigger_level) : '0.9',
      eco_expected_county_yield: numStr(eco?.expected_county_yield),
      eco_premium_per_acre: numStr(eco?.premium_per_acre),
      eco_total_premium: numStr(eco?.total_premium),
    }
    return {
      form,
      raw_crop: p.crop,
      raw_county: [p.county, p.state].filter(Boolean).join(', ') || null,
      raw_coverage_provided: p.coverage_level != null,
      raw_unit_provided: !!(p.unit_structure && ['enterprise', 'basic', 'optional'].includes(p.unit_structure)),
    }
  }

  // Classify a row vs existing policies (entity+crop+county+year+practice+plan
  // match key) — 'exists' (identical, skipped) / 'update' (material diffs, the
  // EXISTING policy is patched in place, never duplicated) / 'new'. The pure
  // logic + field-level diffs live in lib/crop-insurance.ts
  // (classifyPolicyUpload); SCO/ECO endorsements dedupe with their parent.
  function policyStatus(form: PolicyFormState): PolicyUploadStatus {
    if (!form.crop_id || !form.crop_year) return { kind: 'new', existing: null, diffs: [] }
    const existing = existingByKey.get(dedupKey(form.entity_id, form.crop_id, form.county_id, form.crop_year, form.plan_type, form.practice)) ?? null
    return classifyPolicyUpload(
      form,
      existing,
      existing ? scoByPolicy.get(existing.id) : null,
      existing ? ecoByPolicy.get(existing.id) : null,
    )
  }

  async function onSource(src: DocumentSource) {
    setErr(null); setBanner(null); setSource(src); setRows([])
    setStage('Reading policy…')
    try {
      await new Promise((r) => setTimeout(r, 200))
      // Split a multi-page policy packet into small batches so one long call
      // can't time out (504); photos go in a single call.
      const extracted: CropInsurancePolicyExtraction[] = []
      if (src.kind === 'pdf') {
        let batches: File[] = [src.file]
        try { batches = await splitPdfIntoBatches(src.file, 4) } catch { batches = [src.file] }
        for (let i = 0; i < batches.length; i++) {
          setStage(batches.length > 1 ? `Extracting policies (batch ${i + 1} of ${batches.length})…` : 'Extracting policies…')
          const data = await parseDocument(batches[i], 'crop_insurance_policy')
          if (Array.isArray(data.policies)) extracted.push(...data.policies)
        }
      } else {
        setStage('Extracting policies…')
        const data = await parseDocument(src.images, 'crop_insurance_policy')
        if (Array.isArray(data.policies)) extracted.push(...data.policies)
      }
      if (extracted.length === 0) {
        setErr('No policies found in this document. The scan may be unclear or the format may not be readable.')
        return
      }
      const next: Row[] = extracted.map((p) => {
        const { form, raw_crop, raw_county, raw_coverage_provided, raw_unit_provided } = extractionToForm(p)
        // Already-existing policies start unchecked (skipped); new rows and
        // available updates start checked.
        return { form, raw_crop, raw_county, raw_coverage_provided, raw_unit_provided, include: policyStatus(form).kind !== 'exists' }
      })
      setRows(next)
      setBanner(`AI extracted ${next.length} polic${next.length === 1 ? 'y' : 'ies'}. Review and edit before saving.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(e?.message ? `Couldn't read this document: ${e.message}.` : "Couldn't read this document.")
    } finally {
      setStage(null)
    }
  }

  function setRowForm(i: number, patch: Partial<PolicyFormState>) {
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, form: { ...r.form, ...patch } } : r)))
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i))
  }
  function discard() {
    setSource(null); setRows([]); setBanner(null); setErr(null)
  }

  const toSave = rows.filter((r) => r.include && r.form.crop_id && r.form.crop_year && policyStatus(r.form).kind !== 'exists')

  // Summary counts for the footer ("X already exist · Y updates · Z new").
  const statusCounts = rows.reduce(
    (t, r) => {
      const k = policyStatus(r.form).kind
      if (k === 'exists') t.exists++
      else if (k === 'update') t.updates++
      else t.added++
      return t
    },
    { exists: 0, updates: 0, added: 0 },
  )

  async function saveAll() {
    setErr(null)
    if (entities.length > 1 && !importEntityId) {
      setErr('Select the entity these policies belong to before saving.')
      return
    }
    if (toSave.length === 0) {
      setErr('Nothing to save — each row needs a matched crop and crop year, and must be new or changed.')
      return
    }
    setSaving(true)
    try {
      let added = 0, updated = 0
      for (const r of toSave) {
        const status = policyStatus(r.form)
        const { policy, sco, eco } = policyFormToPayloads(r.form, 'document_import')
        if (status.kind === 'update' && status.existing) {
          // Preserve-existing: patch only the provided text/number fields; keep
          // the existing plan/entity (part of the match key). Coverage level and
          // unit structure ARE patched — they're material corrections, and the
          // form seeded them from the existing policy when the extraction
          // lacked them, so an unchanged value is a no-op. Endorsements are
          // added/refreshed when present but never removed.
          const f = r.form
          const patch: Record<string, unknown> = {}
          const setNum = (k: string, s: string) => { if (s.trim() !== '' && Number.isFinite(Number(s))) patch[k] = Number(s) }
          setNum('coverage_level', f.coverage_level)
          if (f.unit_structure) patch.unit_structure = f.unit_structure
          setNum('aph_yield', f.aph_yield)
          setNum('projected_price', f.projected_price)
          setNum('harvest_price', f.harvest_price)
          setNum('insured_acres', f.insured_acres)
          setNum('premium_per_acre', f.premium_per_acre)
          setNum('total_premium', f.total_premium)
          setNum('premium_subsidy_pct', f.premium_subsidy_pct)
          setNum('volatility_factor', f.volatility_factor)
          if (f.policy_number.trim() !== '') patch.policy_number = f.policy_number.trim()
          // Attestation is a definite reviewed choice (not AI-extracted), so apply
          // it directly — the row was seeded from the existing policy, so leaving
          // it as-is is a no-op and toggling it persists.
          patch.covers_all_planted_acres = f.covers_all_planted_acres
          patch.coverage_note = f.covers_all_planted_acres ? (f.coverage_note.trim() || null) : null
          if (Object.keys(patch).length > 0) {
            const { error } = await supabase.from('crop_insurance_policies').update(patch).eq('id', status.existing.id)
            if (error) throw new Error(error.message)
          }
          if (sco) {
            const { error } = await supabase.from('crop_insurance_sco').upsert({ ...sco, policy_id: status.existing.id }, { onConflict: 'policy_id' })
            if (error) throw new Error(error.message)
          }
          if (eco) {
            const { error } = await supabase.from('crop_insurance_eco').upsert({ ...eco, policy_id: status.existing.id }, { onConflict: 'policy_id' })
            if (error) throw new Error(error.message)
          }
          updated++
        } else {
          // The whole upload belongs to one insured entity — write it onto every
          // new policy authoritatively (rows are kept in sync, so this matches
          // the dedup key used above and can't create a cross-entity duplicate).
          const { data, error } = await supabase.from('crop_insurance_policies')
            .insert({ ...policy, entity_id: importEntityId || null })
            .select('id').single()
          if (error || !data) throw new Error(error?.message ?? 'insert failed')
          const policyId = (data as { id: string }).id
          if (sco) {
            const { error: e2 } = await supabase.from('crop_insurance_sco').insert({ ...sco, policy_id: policyId })
            if (e2) throw new Error(e2.message)
          }
          if (eco) {
            const { error: e3 } = await supabase.from('crop_insurance_eco').insert({ ...eco, policy_id: policyId })
            if (e3) throw new Error(e3.message)
          }
          added++
        }
      }
      setBanner(`Saved — ${added} added, ${updated} updated.`)
      setRows([]); setSource(null)
      onImported()
    } catch (e: any) {
      setErr(`Could not save: ${e?.message ?? 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm w-full bg-white'

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold flex-1">Upload Policy Document (AI)</h2>
        {source && !stage && (
          <button type="button" onClick={discard} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">Discard</button>
        )}
      </div>
      <p className="text-sm text-slate-500">
        Photograph or upload a crop-insurance coverage summary, premium billing statement, or confirmation. Each
        crop/county policy becomes an editable row matched to your crops and counties, with SCO/ECO endorsements
        carried over. Each row is checked against the policies on file: unchanged ones are marked
        “Already exists” and skipped, corrections show as “Update available” with the exact field
        changes (the existing policy is updated, never duplicated), and only genuinely new
        policies import as new — so re-uploading a full policy packet is safe.
      </p>

      <DocumentCapture onSource={onSource} busy={stage != null} stageLabel={stage} pdfLabel="Upload Policy PDF or Photo (AI)" />

      {banner && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {(source || rows.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="space-y-3">
            {/* Insured entity for this upload — applied to every extracted policy.
                Multi-entity ops must pick (save is blocked until then); single-
                entity ops are auto-assigned and shown read-only. */}
            {entities.length > 1 ? (
              <label className={`block rounded-lg border px-3 py-2 ${importEntityId ? 'border-slate-200 bg-slate-50' : 'border-amber-300 bg-amber-50'}`}>
                <span className="text-sm font-medium text-slate-700">Insured entity (applied to all policies) *</span>
                <select value={importEntityId} onChange={(e) => applyImportEntity(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white">
                  <option value="">— select entity —</option>
                  {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
                </select>
                {!importEntityId && <span className="block text-xs text-amber-700 mt-1">Pick the entity before saving — these policies belong to one insured entity.</span>}
              </label>
            ) : entities.length === 1 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                Insured entity: <span className="font-medium text-slate-800">{entities[0].name}</span>
              </div>
            ) : null}
            {rows.length === 0 && (
              <p className="text-sm text-slate-400">{stage ? 'Working…' : 'No policies extracted yet.'}</p>
            )}
            {rows.map((r, i) => {
              const status = policyStatus(r.form)
              const exists = status.kind === 'exists'
              const planCov = `${PLAN_TYPE_SHORT[r.form.plan_type]} · ${PRACTICE_LABEL[r.form.practice]} · ${Math.round(Number(r.form.coverage_level) * 100)}%`
              return (
              <div key={i} className={`rounded-lg border p-3 space-y-2 ${exists ? 'border-slate-200 opacity-70' : 'border-slate-300'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <input type="checkbox" checked={r.include} disabled={exists} onChange={(e) => setRows((rs) => rs.map((x, j) => (i === j ? { ...x, include: e.target.checked } : x)))} />
                  {exists
                    ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">Already exists · {planCov}</span>
                    : status.kind === 'update'
                      ? <span className="text-xs rounded-full bg-sky-100 text-sky-800 px-2 py-0.5">Update available · {planCov}</span>
                      : <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">New · {planCov}</span>}
                  <button type="button" onClick={() => removeRow(i)} className="ml-auto text-red-600 text-sm">✕ Remove</button>
                </div>
                {exists && status.existing && (
                  <div className="text-xs text-slate-500 rounded bg-slate-50 border border-slate-200 px-2 py-1">
                    Matches the policy on file — APH {status.existing.aph_yield}, {status.existing.insured_acres} ac
                    {status.existing.premium_per_acre != null && <>, ${status.existing.premium_per_acre}/ac premium</>}
                    {status.existing.policy_number && <>, #{status.existing.policy_number}</>}. Nothing to import.
                  </div>
                )}
                {status.kind === 'update' && (
                  <div className="text-xs rounded bg-sky-50 border border-sky-200 px-2 py-1 space-y-0.5">
                    <div className="font-semibold text-sky-900">Checking this row updates the existing policy (existing → extracted):</div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                      {status.diffs.map((d) => (
                        <span key={d.label} className="whitespace-nowrap text-sky-800">
                          {d.label}: <span className="line-through text-slate-500">{d.existing}</span> → <span className="font-semibold">{d.incoming}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">Crop</span>
                    <select value={r.form.crop_id} onChange={(e) => setRowForm(i, { crop_id: e.target.value })} className={inputCls}>
                      <option value="">— crop —</option>
                      {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    {!r.form.crop_id && r.raw_crop && <span className="text-amber-700">AI: “{r.raw_crop}”</span>}
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">County</span>
                    <select value={r.form.county_id} onChange={(e) => setRowForm(i, { county_id: e.target.value })} className={inputCls}>
                      <option value="">— county —</option>
                      {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
                    </select>
                    {!r.form.county_id && r.raw_county && <span className="text-amber-700">AI: “{r.raw_county}”</span>}
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">Year</span>
                    <input type="number" value={r.form.crop_year} onChange={(e) => setRowForm(i, { crop_year: e.target.value })} className={inputCls} />
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">Plan</span>
                    <select value={r.form.plan_type} onChange={(e) => setRowForm(i, { plan_type: e.target.value as PlanType })} className={inputCls}>
                      {PLAN_TYPES.map((t) => <option key={t} value={t}>{PLAN_TYPE_SHORT[t]}</option>)}
                    </select>
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">Practice</span>
                    <select value={r.form.practice} onChange={(e) => setRowForm(i, { practice: e.target.value as Practice })} className={inputCls}>
                      {PRACTICES.map((pr) => <option key={pr} value={pr}>{PRACTICE_LABEL[pr]}</option>)}
                    </select>
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">Coverage</span>
                    <select value={r.form.coverage_level} onChange={(e) => setRowForm(i, { coverage_level: e.target.value })} className={inputCls}>
                      {COVERAGE_LEVELS.map((l) => <option key={l} value={l}>{Math.round(Number(l) * 100)}%</option>)}
                    </select>
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">APH (bu/ac)</span>
                    <input type="number" step="0.1" value={r.form.aph_yield} onChange={(e) => setRowForm(i, { aph_yield: e.target.value })} className={inputCls} />
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">Projected $</span>
                    <input type="number" step="0.01" value={r.form.projected_price} onChange={(e) => setRowForm(i, { projected_price: e.target.value })} className={inputCls} />
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">Insured acres</span>
                    <input type="number" step="0.01" value={r.form.insured_acres} onChange={(e) => setRowForm(i, { insured_acres: e.target.value })} className={inputCls} />
                  </label>
                  <label className="text-xs flex flex-col gap-1">
                    <span className="text-slate-500">Premium / ac</span>
                    <input type="number" step="0.01" value={r.form.premium_per_acre} onChange={(e) => setRowForm(i, { premium_per_acre: e.target.value })} className={inputCls} />
                  </label>
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={r.form.sco_enabled} onChange={(e) => setRowForm(i, { sco_enabled: e.target.checked })} /> SCO
                  </label>
                  {r.form.sco_enabled && (
                    <input type="number" step="0.1" placeholder="SCO county yield" value={r.form.sco_expected_county_yield}
                      onChange={(e) => setRowForm(i, { sco_expected_county_yield: e.target.value })} className="rounded border border-slate-300 px-2 py-0.5 w-32" />
                  )}
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={r.form.eco_enabled} onChange={(e) => setRowForm(i, { eco_enabled: e.target.checked })} /> ECO
                  </label>
                  {r.form.eco_enabled && (
                    <input type="number" step="0.1" placeholder="ECO county yield" value={r.form.eco_expected_county_yield}
                      onChange={(e) => setRowForm(i, { eco_expected_county_yield: e.target.value })} className="rounded border border-slate-300 px-2 py-0.5 w-32" />
                  )}
                </div>
                {/* Attest coverage up front so the saved policy is already
                    reconciled — no separate post-save step needed. */}
                <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 space-y-1">
                  <label className="flex items-start gap-1.5 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={r.form.covers_all_planted_acres}
                      onChange={(e) => setRowForm(i, { covers_all_planted_acres: e.target.checked })} />
                    <span>Covers <strong>all planted acres</strong> for this crop · county · practice (insured acres may differ from planted)</span>
                  </label>
                  {r.form.covers_all_planted_acres && (
                    <input type="text" placeholder="Coverage note (optional) — e.g. confirmed with agent 6/2026"
                      value={r.form.coverage_note} onChange={(e) => setRowForm(i, { coverage_note: e.target.value })}
                      className="w-full rounded border border-slate-300 px-2 py-1 text-xs" />
                  )}
                </div>
                <PolicyLiveSummary value={r.form} />
              </div>
              )
            })}
          </div>
          <div className="xl:sticky xl:top-3 self-start h-[60vh] min-h-[320px]">
            <div className="text-xs text-slate-500 mb-1">Source document — cross-reference while reviewing</div>
            <SourcePreview source={source} className="h-full" title="Policy document" />
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <div className="text-sm text-slate-600 flex-1">
            <span className="font-semibold text-slate-700">{statusCounts.exists}</span> already exist ·{' '}
            <span className="font-semibold text-sky-700">{statusCounts.updates}</span> update{statusCounts.updates === 1 ? '' : 's'} ·{' '}
            <span className="font-semibold text-green-700">{statusCounts.added}</span> new
            <span className="block text-xs text-slate-500">
              <span className="font-semibold text-green-700">{toSave.length}</span> checked to save · {rows.length} extracted — nothing is written until Save All
            </span>
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
