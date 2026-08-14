'use client'

// The unified settings document upload (every settings page + the catch-all).
// One extraction reads EVERYTHING settings-relevant out of any document; this
// component renders the cross-fill review — sections grouped by settings area,
// the host page's section first — and saves ONLY what the user checked, in
// FK order, rolling the batch back on failure (lib/settings-extraction.ts).

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import { PdfTooLargeError, type RawSettingsExtraction } from '@/lib/pdf-upload'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { fetchAllCounties } from '@/lib/counties'
import { dismissalKey, type VarietyDecision } from '@/lib/variety-resolution'
import {
  normalizeSettingsExtraction, mergeSettingsExtractions, buildSettingsReview,
  planSettingsSave, executeSettingsSave, SECTION_LABELS,
  type SettingsSection, type SettingsReview, type SettingsReviewRow, type NormalizedSettingsExtraction,
} from '@/lib/settings-extraction'

const pill = (cls: SettingsReviewRow['cls']) =>
  cls === 'exists' ? 'bg-slate-200 text-slate-600'
  : cls === 'update' ? 'bg-sky-100 text-sky-800'
  : cls === 'possible' ? 'bg-amber-100 text-amber-800'
  : 'bg-green-100 text-green-800'

const pillLabel = (cls: SettingsReviewRow['cls']) =>
  cls === 'exists' ? 'Already exists' : cls === 'update' ? 'Update available' : cls === 'possible' ? 'Possible match' : 'New'

export default function SettingsDocImport({
  primaryTarget,
  title,
  intro,
  onSaved,
}: {
  /** The host settings page's section — ordered first and expanded. */
  primaryTarget?: SettingsSection
  title?: string
  intro?: string
  /** Host pages pass their refresh so new rows appear without a reload. */
  onSaved?: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  // Existing data — the review classifies against ALL of it, whatever page
  // the upload started from.
  const [ctxData, setCtxData] = useState<Parameters<typeof buildSettingsReview>[1] | null>(null)
  useEffect(() => {
    ;(async () => {
      const [en, lo, fa, fi, pl, bu, dl, bs, bi, gi, tr, cr, va, dm] = await Promise.all([
        supabase.from('entities').select('id, name'),
        supabase.from('landowners').select('id, name, phone, email, address'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('id, farm_id, name_or_number, total_acres, irrigated_acres, county_id'),
        supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres'),
        supabase.from('buyers').select('id, name'),
        supabase.from('delivery_locations').select('id, buyer_id, name'),
        supabase.from('bin_sites').select('id, name'),
        supabase.from('bins').select('id, bin_site_id, name_or_number, capacity_bushels'),
        supabase.from('gins').select('id, name'),
        supabase.from('trucks').select('id, name_or_number'),
        supabase.from('crops').select('id, name'),
        supabase.from('field_planting_varieties').select('variety'),
        supabase.from('variety_match_dismissals').select('key_a, key_b'),
      ])
      const counties = await fetchAllCounties(supabase)
      setCtxData({
        entities: (en.data as never[]) ?? [], landowners: (lo.data as never[]) ?? [],
        farms: (fa.data as never[]) ?? [], fields: (fi.data as never[]) ?? [],
        plantings: (pl.data as never[]) ?? [], buyers: (bu.data as never[]) ?? [],
        deliveryLocations: (dl.data as never[]) ?? [], binSites: (bs.data as never[]) ?? [],
        bins: (bi.data as never[]) ?? [], gins: (gi.data as never[]) ?? [],
        trucks: (tr.data as never[]) ?? [], crops: (cr.data as never[]) ?? [],
        counties,
        existingVarietyNames: [...new Set((((va.data as Array<{ variety: string }>) ?? []).map((v) => v.variety)))],
        dismissedVarietyPairs: new Set(
          (((dm.data as Array<{ key_a: string; key_b: string }>) ?? [])).map((d) => dismissalKey(d.key_a, d.key_b)),
        ),
      })
    })()
  }, [supabase])

  const [source, setSource] = useState<DocumentSource | null>(null)
  const [busy, setBusy] = useState(false)
  // Null, not '' — DocumentCapture shows the stage INSTEAD of the button
  // label whenever one is present, so an empty string blanks the button.
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [review, setReview] = useState<SettingsReview | null>(null)
  const [include, setInclude] = useState<Map<string, boolean>>(new Map())
  const [possible, setPossible] = useState<Map<string, 'existing' | 'new'>>(new Map())
  const [varDecisions, setVarDecisions] = useState<Map<string, VarietyDecision>>(new Map())
  const [open, setOpen] = useState<Set<SettingsSection>>(new Set(primaryTarget ? [primaryTarget] : []))

  async function handleSource(src: DocumentSource) {
    if (!ctxData) return
    setErr(null); setBanner(null); setReview(null); setSource(src)
    setBusy(true)
    try {
      // Chunked parse: page batches with per-chunk retry and partial-failure
      // reporting; records straddling a batch boundary dedupe in the merge.
      const { data: merged, warning } = await parseDocumentChunked<RawSettingsExtraction, NormalizedSettingsExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'settings_document',
        {
          primaryTarget,
          onProgress: setStage,
          merge: (parts) => mergeSettingsExtractions(parts.map(normalizeSettingsExtraction)),
        },
      )
      if (warning) setBanner(warning)
      const built = buildSettingsReview(merged, ctxData, primaryTarget ?? null)
      if (built.sections.length === 0) {
        setBanner('Nothing settings-shaped was found in that document. Try a clearer copy, or enter it by hand below.')
      } else {
        setReview(built)
        setInclude(new Map(built.sections.flatMap((s) => s.rows.map((r) => [r.key, r.include]))))
        setPossible(new Map())
        setVarDecisions(new Map())
        setOpen(new Set([built.sections[0].section]))
      }
    } catch (e) {
      setErr(e instanceof PdfTooLargeError ? 'That PDF is over the 20 MB limit — split it and try again.' : e instanceof Error ? e.message : 'Extraction failed.')
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  function discard() {
    setReview(null); setSource(null); setErr(null); setBanner(null)
  }

  const decidedReview = useMemo(() => {
    if (!review) return null
    // Fold the checkbox state back onto the rows (the lib rows are the source
    // of truth for everything else).
    for (const s of review.sections) for (const r of s.rows) r.include = include.get(r.key) ?? r.include
    return review
  }, [review, include])

  const unresolvedVarieties = useMemo(
    () => review?.varietyPlan.items.filter((it) => it.resolution.status === 'possible' && !varDecisions.get(it.key)) ?? [],
    [review, varDecisions],
  )

  async function saveSections(only: SettingsSection | null) {
    if (!decidedReview) return
    setErr(null)
    setBusy(true)
    setStage('Saving…')
    // A section-scoped save treats other sections as unchecked — dependencies
    // on unchecked parents surface as skips with reasons, never silent.
    const scoped: SettingsReview = only
      ? {
          ...decidedReview,
          sections: decidedReview.sections.map((s) =>
            s.section === only ? s : { ...s, rows: s.rows.map((r) => ({ ...r, include: false })) },
          ),
        }
      : decidedReview
    try {
      const plan = planSettingsSave(scoped, { possible, varieties: varDecisions })
      if (plan.steps.length === 0) {
        setBanner(plan.skipped.length > 0
          ? `Nothing saved — ${plan.skipped.map((s) => `${s.label}: ${s.reason}`).join('; ')}.`
          : 'Nothing is checked to save.')
        return
      }
      const result = await executeSettingsSave(supabase, plan)
      const skippedNote = plan.skipped.length > 0
        ? ` Skipped: ${plan.skipped.map((s) => `${s.label} (${s.reason})`).join('; ')}.`
        : ''
      setBanner(`Saved ${result.inserted} new and ${result.updated} updated record${result.inserted + result.updated === 1 ? '' : 's'}.${skippedNote}`)
      setReview(null)
      setSource(null)
      onSaved?.()
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  const counts = useMemo(() => {
    if (!decidedReview) return null
    const all = decidedReview.sections.flatMap((s) => s.rows)
    return {
      exists: all.filter((r) => r.cls === 'exists').length,
      updates: all.filter((r) => r.cls === 'update').length,
      created: all.filter((r) => r.cls === 'new' || r.cls === 'possible').length,
      checked: all.filter((r) => (include.get(r.key) ?? false) && r.cls !== 'exists').length,
      total: all.length,
    }
  }, [decidedReview, include])

  const alsoFound = useMemo(() => {
    if (!decidedReview || decidedReview.sections.length <= 1) return null
    return decidedReview.sections.slice(1)
      .map((s) => `${s.rows.length} ${SECTION_LABELS[s.section].toLowerCase()}`)
      .join(', ')
  }, [decidedReview])

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="font-semibold flex-1">{title ?? 'Upload a document (AI)'}</h2>
        {(review || source) && (
          <button type="button" onClick={discard} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
            Discard
          </button>
        )}
      </div>
      <p className="text-sm text-slate-500">
        {intro ?? 'Upload leases, FSA records, field lists, plantings — Turnrow will sort the information into the right places for your confirmation. Nothing is saved until you check it and press Save.'}
      </p>
      {!review && <DocumentCapture onSource={handleSource} busy={busy} stageLabel={stage} pdfLabel="Upload PDF, Photo, or Spreadsheet (AI)" />}
      {banner && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {decidedReview && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="space-y-3">
            {alsoFound && (
              <p className="text-sm text-slate-600">
                Also found beyond {SECTION_LABELS[decidedReview.sections[0].section].toLowerCase()}: {alsoFound}.
              </p>
            )}
            {decidedReview.sections.map((sec) => {
              const isOpen = open.has(sec.section)
              const secChecked = sec.rows.filter((r) => (include.get(r.key) ?? false) && r.cls !== 'exists').length
              return (
                <div key={sec.section} className="rounded-lg border border-slate-300 overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 text-left"
                    onClick={() => setOpen((prev) => {
                      const next = new Set(prev)
                      if (next.has(sec.section)) next.delete(sec.section); else next.add(sec.section)
                      return next
                    })}
                  >
                    <span className="font-semibold">{SECTION_LABELS[sec.section]}</span>
                    <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">{sec.rows.length}</span>
                    {secChecked > 0 && <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">{secChecked} to save</span>}
                    <span className="ml-auto text-slate-400">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  {isOpen && (
                    <div className="p-3 space-y-2">
                      {sec.rows.map((r) => {
                        const checked = include.get(r.key) ?? false
                        const disabled = r.cls === 'exists'
                        return (
                          <div key={r.key} className={`rounded-lg border p-3 space-y-1.5 ${disabled ? 'border-slate-200 opacity-70' : 'border-slate-300'}`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <input
                                type="checkbox"
                                checked={checked && !disabled}
                                disabled={disabled}
                                onChange={(e) => setInclude((prev) => new Map(prev).set(r.key, e.target.checked))}
                                className="h-4 w-4"
                              />
                              <span className={`text-xs rounded-full px-2 py-0.5 ${pill(r.cls)}`}>{pillLabel(r.cls)}</span>
                              <span className="font-medium">{r.label}</span>
                              {r.detail && <span className="text-sm text-slate-500">{r.detail}</span>}
                            </div>
                            {r.source && (
                              <p className="text-xs text-slate-500 rounded bg-slate-50 border border-slate-200 px-2 py-1">From the document: “{r.source}”</p>
                            )}
                            {r.diffs.length > 0 && (
                              <div className="rounded bg-sky-50 border border-sky-200 px-2 py-1 text-xs space-x-3">
                                <span className="font-semibold text-sky-900">Changes:</span>
                                {r.diffs.map((d, i) => (
                                  <span key={i} className="whitespace-nowrap">
                                    {d.label}: <span className="line-through text-slate-500">{d.existing}</span> → <span className="font-semibold">{d.incoming}</span>
                                  </span>
                                ))}
                              </div>
                            )}
                            {r.hints.map((h, i) => (
                              <p key={i} className="text-xs text-amber-700">AI: {h}</p>
                            ))}
                            {r.cls === 'possible' && r.candidate && (
                              <div className="text-sm flex flex-wrap gap-x-4 gap-y-1">
                                <label className="flex items-center gap-1.5">
                                  <input
                                    type="radio"
                                    name={`possible-${r.key}`}
                                    checked={possible.get(r.key) === 'existing'}
                                    onChange={() => setPossible((prev) => new Map(prev).set(r.key, 'existing'))}
                                  />
                                  <span>Same as <b>{r.candidate.label}</b></span>
                                </label>
                                <label className="flex items-center gap-1.5">
                                  <input
                                    type="radio"
                                    name={`possible-${r.key}`}
                                    checked={possible.get(r.key) === 'new'}
                                    onChange={() => setPossible((prev) => new Map(prev).set(r.key, 'new'))}
                                  />
                                  <span>Different — create new</span>
                                </label>
                              </div>
                            )}
                          </div>
                        )
                      })}
                      {sec.section === 'plantings' && unresolvedVarieties.length > 0 && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2 text-sm">
                          <p className="font-semibold text-amber-900">Variety review — is this the same variety?</p>
                          {unresolvedVarieties.map((it) => (
                            <div key={it.key} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span className="font-medium">“{it.name}”</span>
                              {it.resolution.status === 'possible' && it.resolution.candidates.map((c) => (
                                <label key={c} className="flex items-center gap-1.5">
                                  <input type="radio" name={`var-${it.key}`}
                                    onChange={() => setVarDecisions((prev) => new Map(prev).set(it.key, { useExisting: c }))} />
                                  <span>same as <b>{c}</b></span>
                                </label>
                              ))}
                              <label className="flex items-center gap-1.5">
                                <input type="radio" name={`var-${it.key}`}
                                  onChange={() => setVarDecisions((prev) => new Map(prev).set(it.key, { useExisting: null }))} />
                                <span>new variety</span>
                              </label>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={busy || secChecked === 0}
                          onClick={() => saveSections(sec.section)}
                          className="rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                        >
                          Save {SECTION_LABELS[sec.section].toLowerCase()} only ({secChecked})
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {counts && (
              <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
                <p className="text-sm text-slate-600 flex-1">
                  {counts.exists} already exist · {counts.updates} updates · {counts.created} new
                  <span className="block text-xs text-slate-400">
                    {counts.checked} checked to save · {counts.total} extracted — nothing is written until you save
                  </span>
                </p>
                <button
                  type="button"
                  disabled={busy || counts.checked === 0}
                  onClick={() => saveSections(null)}
                  className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
                >
                  Save All ({counts.checked})
                </button>
              </div>
            )}
          </div>
          {source && <SourcePreview source={source} className="xl:sticky xl:top-3 self-start h-[60vh] min-h-[320px]" />}
        </div>
      )}
    </div>
  )
}
