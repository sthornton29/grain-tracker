'use client'

// Read the agent's Trigger Yield Summary Report (0101). The document reader
// pulls one unit per page; the review groups them by insured (matched to an
// entity, or to a share-rent landlord insuring their own share), lets the
// farmer fix any match, then saves — replacing what was on file for that
// insured × crop year × crop. The Claim Check report reads the rows.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PdfTooLargeError, type InsuranceTriggerReportExtraction } from '@/lib/pdf-upload'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeInsuranceTriggerReport } from '@/lib/parse-merge'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { reportError } from '@/lib/friendly-error'
import { cropYearOf, groupTriggerReport, rowsForGroup, type ImportGroup } from '@/lib/trigger-report-import'
import { selectCls } from '@/components/reports/report-kit'

type Named = { id: string; name: string }

type Props = {
  entities: Named[]
  landowners: Named[]
  crops: Named[]
  counties: Array<{ id: string; name: string; state?: string | null; state_code?: string | null }>
  defaultYear: number
  onSaved: (cropYear: number) => void
}

const fmt1 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))

export default function TriggerReportImport({ entities, landowners, crops, counties, defaultYear, onSaved }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [extraction, setExtraction] = useState<InsuranceTriggerReportExtraction | null>(null)
  const [groups, setGroups] = useState<ImportGroup[]>([])
  const [cropYear, setCropYear] = useState(defaultYear)
  const [saving, setSaving] = useState(false)

  async function onSource(src: DocumentSource) {
    setErr(null); setNotice(null); setGroups([]); setExtraction(null)
    setStage('Reading the report…')
    try {
      const { data, warning } = await parseDocumentChunked<InsuranceTriggerReportExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'insurance_trigger_report',
        { pagesPerBatch: 3, onProgress: setStage, merge: mergeInsuranceTriggerReport },
      )
      const g = groupTriggerReport({ extraction: data, entities, landowners, crops, counties })
      if (g.length === 0) {
        setErr(warning ?? 'No trigger yields found in this document. Make sure it is your agent’s trigger yield report.')
        return
      }
      if (warning) setErr(warning)
      setExtraction(data)
      setCropYear(cropYearOf(data, defaultYear))
      setGroups(g)
    } catch (e) {
      setErr(e instanceof PdfTooLargeError ? e.message : reportError(e as Error, { action: 'read this report' }))
    } finally {
      setStage(null)
    }
  }

  const setGroup = (i: number, patch: Partial<ImportGroup>) => setGroups((gs) => gs.map((g, j) => (j === i ? { ...g, ...patch } : g)))
  const setUnit = (gi: number, ui: number, patch: Partial<ImportGroup['units'][number]>) =>
    setGroups((gs) => gs.map((g, j) => (j !== gi ? g : { ...g, units: g.units.map((u, k) => (k === ui ? { ...u, ...patch } : u)) })))

  const meta = { report_date: extraction?.report_date ?? null, agency: extraction?.agency ?? null }
  const ready = groups.filter((g) => g.insured && rowsForGroup(g, cropYear, meta).length > 0)
  const unmatched = groups.filter((g) => !g.insured)

  async function save() {
    setSaving(true); setErr(null)
    try {
      let saved = 0
      for (const g of ready) {
        const rows = rowsForGroup(g, cropYear, meta)
        const cropIds = Array.from(new Set(rows.map((r) => r.crop_id)))
        let del = supabase.from('insurance_trigger_yields').delete().eq('crop_year', cropYear).in('crop_id', cropIds)
        del = g.insured!.kind === 'entity' ? del.eq('entity_id', g.insured!.id) : del.eq('landowner_id', g.insured!.id)
        const d = await del
        if (d.error) throw d.error
        const ins = await supabase.from('insurance_trigger_yields').insert(rows)
        if (ins.error) throw ins.error
        saved += rows.length
      }
      setNotice(`Saved ${saved} unit${saved === 1 ? '' : 's'} from your agent’s report.`)
      setGroups([]); setExtraction(null)
      onSaved(cropYear)
    } catch (e) {
      setErr(reportError(e as Error, { action: 'save these trigger yields', noun: 'trigger yield' }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Upload the trigger yield report your crop insurance agent sent. Turnrow reads each unit’s trigger yield, acres,
        APH and approved yield, then checks them against your harvest and your policies.
      </p>
      <DocumentCapture onSource={onSource} busy={stage != null || saving} stageLabel={stage} pdfLabel="Upload the agent’s report" />
      {err && <p className="text-sm text-amber-700" role="alert">{err}</p>}
      {notice && <p className="text-sm text-green-700">{notice}</p>}

      {groups.length > 0 && (
        <div className="space-y-4">
          <label className="text-sm flex items-center gap-2">
            <span className="text-slate-500">Crop year</span>
            <input type="number" inputMode="numeric" value={cropYear} onChange={(e) => setCropYear(Number(e.target.value) || defaultYear)} className="rounded-lg border border-slate-300 px-3 min-h-11 w-28 text-sm" />
          </label>
          {groups.map((g, gi) => (
            <div key={gi} className="rounded-xl border border-slate-200 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="font-semibold">{g.insuredName}</div>
                <select
                  aria-label={`Who is ${g.insuredName} in Turnrow`}
                  className={`${selectCls} min-h-11`}
                  value={g.insured ? `${g.insured.kind}:${g.insured.id}` : ''}
                  onChange={(e) => {
                    const [kind, id] = e.target.value.split(':')
                    setGroup(gi, { insured: id ? { kind: kind as 'entity' | 'landowner', id } : null })
                  }}
                >
                  <option value="">Pick who this is…</option>
                  <optgroup label="Your entities">
                    {entities.map((e) => <option key={e.id} value={`entity:${e.id}`}>{e.name}</option>)}
                  </optgroup>
                  <optgroup label="Landowners insuring their own share">
                    {landowners.map((l) => <option key={l.id} value={`landowner:${l.id}`}>{l.name}</option>)}
                  </optgroup>
                </select>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-slate-500 text-left">
                    <tr>
                      <th className="px-2 py-1">Save</th><th className="px-2 py-1">Crop</th><th className="px-2 py-1">County</th><th className="px-2 py-1">Practice</th>
                      <th className="px-2 py-1 text-right">Acres</th><th className="px-2 py-1 text-right">APH</th><th className="px-2 py-1 text-right">Approved</th><th className="px-2 py-1 text-right">Trigger</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.units.map((u, ui) => (
                      <tr key={ui} className="border-t border-slate-100">
                        <td className="px-2 py-1">
                          <input type="checkbox" className="h-5 w-5" aria-label="Save this unit" checked={u.include} onChange={(e) => setUnit(gi, ui, { include: e.target.checked })} />
                        </td>
                        <td className="px-2 py-1">
                          <select className={`${selectCls} min-h-11`} value={u.cropId} onChange={(e) => setUnit(gi, ui, { cropId: e.target.value })} aria-label="Crop">
                            <option value="">{u.raw.crop ?? 'Pick a crop'}…</option>
                            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <select className={`${selectCls} min-h-11`} value={u.countyId} onChange={(e) => setUnit(gi, ui, { countyId: e.target.value })} aria-label="County">
                            <option value="">{u.raw.county ?? 'Pick a county'}…</option>
                            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}{c.state_code ? `, ${c.state_code}` : ''}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <select className={`${selectCls} min-h-11`} value={u.practice} onChange={(e) => setUnit(gi, ui, { practice: e.target.value as 'irrigated' | 'non_irrigated' })} aria-label="Practice">
                            <option value="non_irrigated">Dryland</option>
                            <option value="irrigated">Irrigated</option>
                          </select>
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmt1(u.raw.acres)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmt1(u.raw.aph_yield)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmt1(u.raw.approved_yield)}</td>
                        <td className="px-2 py-1 text-right tabular-nums font-semibold">{fmt1(u.raw.trigger_yield)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {unmatched.length > 0 && (
            <p className="text-sm text-amber-700">Pick who {unmatched.map((g) => g.insuredName).join(', ')} is before saving — or leave it unpicked to skip it.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={save} disabled={saving || ready.length === 0} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold disabled:opacity-50">
              {saving ? 'Saving…' : `Save ${ready.reduce((s, g) => s + rowsForGroup(g, cropYear, meta).length, 0)} units`}
            </button>
            <button type="button" onClick={() => { setGroups([]); setExtraction(null) }} className="rounded-lg border border-slate-300 px-4 min-h-11 text-sm">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
