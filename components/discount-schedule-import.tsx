'use client'

// "Upload discount schedule (AI)" — shared by Settings → Buyers and the
// Grain Dryer Math page. Reads a buyer's posted discount sheet
// (document_type 'discount_schedule'), shows the extracted rules for review,
// and saves ONLY on confirm: one buyer_discount_schedules row (buyer × crop ×
// effective date, schedule text preserved) plus its rule rows. With
// `showList`, also lists the schedules on file with delete.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { findBestMatch } from '@/lib/fuzzy'
import { imagesToPdf } from '@/lib/image-capture'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeDiscountSchedules } from '@/lib/parse-merge'
import {
  MAX_PDF_BYTES,
  uploadFileToStorage,
  type DiscountScheduleExtraction,
  type DiscountScheduleRuleExtraction,
} from '@/lib/pdf-upload'
import {
  parseTiers,
  summarizeRule,
  type RuleBasis,
  type ScheduleRuleShape,
} from '@/lib/discount-schedules'
import {
  DISCOUNT_CATEGORIES,
  DISCOUNT_CATEGORY_LABELS,
  coerceDiscountCategory,
} from '@/lib/settlement-discounts'
import type { Buyer, BuyerDiscountSchedule, BuyerDiscountScheduleRule, Crop } from '@/lib/types'

const BASIS_LABELS: Record<RuleBasis, string> = {
  weight_shrink_pct: 'Weight shrink %',
  cents_per_bu: '¢/bu',
  pct_of_price: '% of price',
}

function coerceBasis(s: string | null | undefined): RuleBasis {
  return s === 'weight_shrink_pct' || s === 'pct_of_price' ? s : 'cents_per_bu'
}

// The review screen's working copy of one extracted rule.
type RuleDraft = ScheduleRuleShape & { note: string | null }

function toDraft(r: DiscountScheduleRuleExtraction): RuleDraft {
  return {
    factor: coerceDiscountCategory(r.factor),
    basis: coerceBasis(r.basis),
    base_value: r.base_value,
    direction: r.direction === 'below' ? 'below' : 'above',
    rate_per_unit: r.rate_per_unit,
    tiers: parseTiers(r.tiers),
    cumulative: r.cumulative === true,
    rejection_at: r.rejection_at,
    note: r.note ?? null,
  }
}

export default function DiscountScheduleImport({
  showList = false,
  onChanged,
  lockedBuyerId,
  bare = false,
}: {
  /** Also list the schedules on file (per buyer/crop) with delete. */
  showList?: boolean
  onChanged?: () => void
  /** Pin the schedule to ONE buyer (the per-buyer card on Settings →
   *  Buyers): the buyer select is preset and locked. */
  lockedBuyerId?: string
  /** Render without the outer card/header (embedding inside another card). */
  bare?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(showList || bare)
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [schedules, setSchedules] = useState<BuyerDiscountSchedule[]>([])
  const [ruleCounts, setRuleCounts] = useState<Map<string, number>>(new Map())

  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  // Review state (null until a parse succeeds).
  const [buyerId, setBuyerId] = useState('')
  const [cropId, setCropId] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [scheduleText, setScheduleText] = useState('')
  const [rules, setRules] = useState<RuleDraft[] | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    const [b, c, s, r] = await Promise.all([
      supabase.from('buyers').select('*').order('name'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('buyer_discount_schedules').select('*').order('effective_date', { ascending: false }),
      supabase.from('buyer_discount_schedule_rules').select('id, schedule_id'),
    ])
    setBuyers((b.data as Buyer[]) || [])
    setCrops((c.data as Crop[]) || [])
    setSchedules((s.data as BuyerDiscountSchedule[]) || [])
    const counts = new Map<string, number>()
    for (const row of ((r.data as Array<{ schedule_id: string }>) || [])) {
      counts.set(row.schedule_id, (counts.get(row.schedule_id) ?? 0) + 1)
    }
    setRuleCounts(counts)
  }, [supabase])
  useEffect(() => { refresh() }, [refresh])

  async function onSource(src: DocumentSource) {
    setErr(null)
    setSaved(null)
    if (src.kind === 'pdf' && src.file.size > MAX_PDF_BYTES) {
      setErr('That PDF is larger than 20 MB. Please use a smaller file.')
      return
    }
    setSource(src)
    setStage('Reading the schedule…')
    try {
      const { data, warning } = await parseDocumentChunked<DiscountScheduleExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'discount_schedule',
        { onProgress: setStage, merge: mergeDiscountSchedules },
      )
      if (warning) setErr(warning)
      const extractedRules = Array.isArray(data.rules) ? data.rules : []
      if (extractedRules.length === 0) {
        setErr('No discount rules found in this document. The scan may be unclear, or it may not be a discount schedule.')
        setSource(null)
        return
      }
      const buyerHit = findBestMatch(data.buyer_name, buyers, (b) => b.name)
      setBuyerId(lockedBuyerId ?? buyerHit?.id ?? '')
      const cropHit = findBestMatch(data.crop, crops, (c) => c.name)
      setCropId(cropHit?.id ?? '')
      setEffectiveDate(
        data.effective_date && /^\d{4}-\d{2}-\d{2}$/.test(data.effective_date)
          ? data.effective_date
          : new Date().toISOString().slice(0, 10),
      )
      setScheduleText(data.schedule_text ?? '')
      setRules(extractedRules.map(toDraft))
    } catch (e: any) {
      setErr(e?.message ? `Couldn't read this document: ${e.message}` : "Couldn't read this document. Try a clearer scan.")
      setSource(null)
    } finally {
      setStage(null)
    }
  }

  function discard() {
    setSource(null)
    setRules(null)
    setErr(null)
  }

  function updateRule(i: number, patch: Partial<RuleDraft>) {
    setRules((rs) => (rs ? rs.map((r, j) => (i === j ? { ...r, ...patch } : r)) : rs))
  }

  async function save() {
    if (!rules) return
    if (!buyerId) { setErr('Pick the buyer this schedule belongs to.'); return }
    if (!cropId) { setErr('Pick the crop the schedule covers.'); return }
    if (!effectiveDate) { setErr('Set the effective date.'); return }
    setSaving(true)
    setErr(null)

    // Keep the source document attached (like settlements).
    let pdfUrl: string | null = null
    if (source) {
      try {
        const file = source.kind === 'pdf' ? source.file : await imagesToPdf(source.images, 'discount-schedule')
        const { publicUrl } = await uploadFileToStorage(supabase, file, 'discount-schedules', 'application/pdf')
        pdfUrl = publicUrl
      } catch (e: any) {
        setSaving(false)
        setErr(e?.message ?? 'Could not store the schedule document.')
        return
      }
    }

    const { data: schedule, error: sErr } = await supabase
      .from('buyer_discount_schedules')
      .insert({
        buyer_id: buyerId,
        crop_id: cropId,
        effective_date: effectiveDate,
        schedule_text: scheduleText.trim() || null,
        source_pdf_url: pdfUrl,
      })
      .select('id')
      .single()
    if (sErr || !schedule) {
      setSaving(false)
      setErr(sErr?.message ?? 'Could not save the schedule.')
      return
    }
    const { error: rErr } = await supabase.from('buyer_discount_schedule_rules').insert(
      rules.map((r) => ({
        schedule_id: schedule.id,
        factor: r.factor,
        basis: r.basis,
        base_value: r.base_value,
        direction: r.direction,
        rate_per_unit: r.rate_per_unit,
        tiers: r.tiers,
        cumulative: r.cumulative,
        rejection_at: r.rejection_at,
        note: r.note,
      })),
    )
    setSaving(false)
    if (rErr) { setErr('Schedule saved but its rules failed: ' + rErr.message); return }
    setSaved(`Discount schedule saved — ${rules.length} rule${rules.length === 1 ? '' : 's'}.`)
    setSource(null)
    setRules(null)
    refresh()
    onChanged?.()
  }

  async function removeSchedule(s: BuyerDiscountSchedule) {
    if (!confirm('Delete this discount schedule? Its rules are deleted too, and the report stops auditing against it.')) return
    const { error } = await supabase.from('buyer_discount_schedules').delete().eq('id', s.id)
    if (error) { setErr(error.message); return }
    refresh()
    onChanged?.()
  }

  const buyerName = (id: string) => buyers.find((b) => b.id === id)?.name ?? '—'
  const cropName = (id: string) => crops.find((c) => c.id === id)?.name ?? '—'
  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm'

  if (bare) {
    return (
      <div className="space-y-3 no-print">
        {renderBody()}
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3 no-print">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Buyer discount schedules</div>
          <div className="text-sm text-slate-500">
            Upload a buyer&rsquo;s posted discount sheet and Turnrow reads its rules — then Ask Turnrow can quote
            them and the Grain Dryer Math tool can compare against what the sheet says. Schedules live with the
            buyer (Settings → Buyers).
          </div>
        </div>
        {!showList && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm"
          >
            {open ? 'Hide' : 'Manage schedules'}
          </button>
        )}
      </div>
      {renderBody()}
    </div>
  )

  function renderBody() {
    return (open || rules != null) && (
        <div className="space-y-3">
          {rules == null && (
            <DocumentCapture
              onSource={onSource}
              busy={stage != null}
              stageLabel={stage}
              pdfLabel="Upload discount schedule (AI)"
            />
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}
          {saved && <p className="text-sm rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-green-900">{saved}</p>}

          {rules != null && (
            <div className="space-y-3">
              <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-amber-900">
                Review what was read before saving — nothing is recorded until you confirm. The schedule&rsquo;s own text is kept with it.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm text-slate-700">
                  Buyer
                  <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} disabled={!!lockedBuyerId} className={`block mt-0.5 ${inputCls} disabled:bg-slate-100`}>
                    <option value="">— select —</option>
                    {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
                <label className="text-sm text-slate-700">
                  Crop
                  <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={`block mt-0.5 ${inputCls}`}>
                    <option value="">— select —</option>
                    {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="text-sm text-slate-700">
                  Effective date
                  <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={`block mt-0.5 ${inputCls}`} />
                </label>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      {['Factor', 'How it charges', 'Starts at', 'Rate', 'Reject at', ''].map((h, i) => (
                        <th key={h || i} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r, i) => (
                      <tr key={i} className="border-t border-slate-100 align-top">
                        <td className="px-2 py-1">
                          <select value={r.factor} onChange={(e) => updateRule(i, { factor: coerceDiscountCategory(e.target.value) })} className={inputCls}>
                            {DISCOUNT_CATEGORIES.map((c) => <option key={c} value={c}>{DISCOUNT_CATEGORY_LABELS[c]}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <select value={r.basis} onChange={(e) => updateRule(i, { basis: coerceBasis(e.target.value) })} className={inputCls}>
                            {(Object.keys(BASIS_LABELS) as RuleBasis[]).map((b) => <option key={b} value={b}>{BASIS_LABELS[b]}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number" step="0.1" value={r.base_value ?? ''}
                            onChange={(e) => updateRule(i, { base_value: e.target.value === '' ? null : Number(e.target.value) })}
                            className={`${inputCls} w-20 text-right`}
                          />
                          <select
                            value={r.direction}
                            onChange={(e) => updateRule(i, { direction: e.target.value === 'below' ? 'below' : 'above' })}
                            className={`${inputCls} ml-1`}
                          >
                            <option value="above">and over</option>
                            <option value="below">and under</option>
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          {r.tiers.length > 0 ? (
                            <span className="text-slate-600">{summarizeRule(r)}</span>
                          ) : (
                            <input
                              type="number" step="0.01" value={r.rate_per_unit ?? ''}
                              onChange={(e) => updateRule(i, { rate_per_unit: e.target.value === '' ? null : Number(e.target.value) })}
                              className={`${inputCls} w-24 text-right`}
                              title="Charge per point (or per lb) past the threshold, in the selected units"
                            />
                          )}
                          {r.note && <div className="text-xs text-slate-400 mt-0.5">{r.note}</div>}
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number" step="0.1" value={r.rejection_at ?? ''}
                            onChange={(e) => updateRule(i, { rejection_at: e.target.value === '' ? null : Number(e.target.value) })}
                            className={`${inputCls} w-20 text-right`}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <button type="button" onClick={() => setRules((rs) => (rs ? rs.filter((_, j) => j !== i) : rs))} className="text-red-600 text-sm">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <label className="block text-sm text-slate-700">
                Schedule text (kept with the record)
                <textarea
                  value={scheduleText}
                  onChange={(e) => setScheduleText(e.target.value)}
                  rows={3}
                  className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
                />
              </label>

              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !buyerId || !cropId}
                  className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Confirm & Save Schedule'}
                </button>
                <button type="button" onClick={discard} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">
                  Discard
                </button>
              </div>
            </div>
          )}

          {showList && rules == null && (
            schedules.length === 0 ? (
              <p className="text-sm text-slate-400">No discount schedules on file yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {schedules.map((s) => (
                  <li key={s.id} className="px-3 py-2 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">
                        {buyerName(s.buyer_id)} · {cropName(s.crop_id)}
                        <span className="text-slate-500 font-normal"> · effective {s.effective_date}</span>
                      </div>
                      <div className="text-xs text-slate-500">
                        {ruleCounts.get(s.id) ?? 0} rule{(ruleCounts.get(s.id) ?? 0) === 1 ? '' : 's'}
                        {s.source_pdf_url && (
                          <> · <a href={s.source_pdf_url} target="_blank" rel="noreferrer" className="text-brand-deep">original ↗</a></>
                        )}
                      </div>
                      {s.schedule_text && (
                        <details className="text-xs text-slate-500 mt-1">
                          <summary className="cursor-pointer">Schedule text</summary>
                          <pre className="whitespace-pre-wrap font-sans mt-1">{s.schedule_text}</pre>
                        </details>
                      )}
                    </div>
                    <button type="button" onClick={() => removeSchedule(s)} className="text-red-600 text-sm">Delete</button>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )
  }
}
