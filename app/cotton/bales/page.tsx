'use client'

// Cotton module — Bales & Grades: every bale (from gin receipts) with its HVI
// classing data. Classing CSVs import DETERMINISTICALLY (lib/cotton-grades) —
// no AI: preamble skipped, columns mapped by header name, each row matched to
// a bale by PBI number. Unmatched rows (receipt not entered yet) stay visible
// with a "no matching bale" flag and import later; NetWt cross-checks the
// bale's receipt weight (>1% flagged). Standard preview → confirm → save.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { parseGradeCsv, type ParsedGradeRow } from '@/lib/cotton-grades'
import { matchGradesToBales } from '@/lib/cotton'
import type { CottonBale, CottonBaleGrade, GinReceipt, Farm, Field } from '@/lib/types'
import Dropzone, { rejectMessage } from '@/components/dropzone'
import { reportError } from '@/lib/friendly-error'
import { pbiKey } from '@/lib/number-key'
import { EmptyState, SummaryCards, fmtInt, fmtNum, theadCls, type SummaryCardData } from '@/components/reports/report-kit'
import { CottonPageHeader, CottonSection } from '@/components/cotton/cotton-page-header'

const fmt = (n: number | null | undefined, d = 1) => (n == null ? '—' : Number(n).toFixed(d))

export default function CottonBalesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [bales, setBales] = useState<CottonBale[]>([])
  const [grades, setGrades] = useState<CottonBaleGrade[]>([])
  const [receipts, setReceipts] = useState<GinReceipt[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<ReturnType<typeof matchGradesToBales<ParsedGradeRow>> | null>(null)
  const [saving, setSaving] = useState(false)

  async function refresh() {
    const [b, g, r, f, fl] = await Promise.all([
      fetchAllRows((f, t) => supabase.from('cotton_bales').select('*').order('pbi_number').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('cotton_bale_grades').select('*').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('gin_receipts').select('*').order('id').range(f, t)),
      supabase.from('farms').select('*'),
      supabase.from('fields').select('*'),
    ])
    setBales((b.data as CottonBale[]) || [])
    setGrades((g.data as CottonBaleGrade[]) || [])
    setReceipts((r.data as GinReceipt[]) || [])
    setFarms((f.data as Farm[]) || [])
    setFields((fl.data as Field[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const yearBales = useMemo(() => bales.filter((b) => b.crop_year === cropYear), [bales, cropYear])
  const gradeByBale = useMemo(() => new Map(grades.map((g) => [g.bale_id, g])), [grades])
  const receiptById = useMemo(() => new Map(receipts.map((r) => [r.id, r])), [receipts])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])

  // PBIs the file repeats: kept once (the first row), named on screen — the
  // same rule the gin-receipt review applies to its bale list.
  const [repeatedInFile, setRepeatedInFile] = useState<string[]>([])

  async function onCsv(file: File) {
    setErr(null); setMsg(null); setPreview(null); setRepeatedInFile([])
    const text = await file.text()
    const parsed = parseGradeCsv(text)
    if (parsed.error) { setErr(parsed.error); return }
    if (parsed.rows.length === 0) { setErr('No bale rows found in the CSV.'); return }
    const seen = new Set<string>()
    const repeats: string[] = []
    const rows = parsed.rows.filter((r) => {
      const k = pbiKey(r.pbi_number) ?? ''
      if (!k) return true
      if (seen.has(k)) { repeats.push(r.pbi_number); return false }
      seen.add(k)
      return true
    })
    setRepeatedInFile(repeats)
    setPreview(matchGradesToBales(rows, yearBales))
    setMsg(`Parsed ${parsed.rows.length} grade rows (${parsed.preambleLines} preamble lines skipped${parsed.unknownHeaders.length ? `; unrecognized columns: ${parsed.unknownHeaders.join(', ')}` : ''})${repeats.length ? ` — ${repeats.length} PBI${repeats.length === 1 ? '' : 's'} repeated in the file, kept once` : ''}.`)
  }

  async function saveGrades() {
    if (!preview) return
    setSaving(true); setErr(null)
    try {
      const rows = preview.matched.map(({ row, bale }) => ({
        bale_id: bale.id,
        class_date: row.class_date,
        color_grade: row.color_grade, leaf_grade: row.leaf_grade, staple_32nds: row.staple_32nds,
        micronaire: row.micronaire, strength_g_tex: row.strength_g_tex, composite_grade: row.composite_grade,
        rd: row.rd, plus_b: row.plus_b, trash_pct: row.trash_pct, uniformity_pct: row.uniformity_pct,
        length_100ths: row.length_100ths, extraneous: row.extraneous, remarks: row.remarks,
        loan_value_total: row.loan_value_total, loan_value_cents_per_lb: row.loan_value_cents_per_lb,
        source: 'csv_import',
      }))
      if (rows.length === 0) { setErr('No rows matched a bale — enter the gin receipt first, then re-import this file.'); return }
      const { error } = await supabase.from('cotton_bale_grades').upsert(rows, { onConflict: 'bale_id' })
      if (error) { setErr(reportError(error, { action: 'save the classing data', noun: 'bale' })); return }
      setMsg(`Saved classing data for ${rows.length} bale${rows.length === 1 ? '' : 's'}${preview.unmatched.length ? ` — ${preview.unmatched.length} unmatched row${preview.unmatched.length === 1 ? '' : 's'} left for later (no matching bale yet)` : ''}.`)
      setPreview(null); refresh()
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11'
  const years = useMemo(() => {
    const ys = new Set<number>([cropYear, new Date().getFullYear(), ...bales.map((b) => b.crop_year)])
    return [...ys].sort((a, b) => b - a)
  }, [bales, cropYear])
  const gradedCount = yearBales.filter((b) => gradeByBale.has(b.id)).length
  const yearLbs = yearBales.reduce((s, b) => s + Number(b.net_weight_lbs), 0)
  const graded = yearBales.map((b) => gradeByBale.get(b.id)).filter((g): g is CottonBaleGrade => g != null)
  const loanTotal = graded.reduce((s, g) => s + Number(g.loan_value_total ?? 0), 0)
  const loanLbs = graded.reduce((s, g) => s + (g.loan_value_total != null ? Number(yearBales.find((b) => b.id === g.bale_id)?.net_weight_lbs ?? 0) : 0), 0)
  const summaryCards: SummaryCardData[] = [
    { label: `${cropYear} bales`, value: fmtInt(yearBales.length), sub: yearBales.length ? `${fmtInt(yearLbs)} lbs lint · avg ${fmtInt(yearLbs / yearBales.length)} lbs` : 'from gin receipts' },
    { label: 'Classed', value: yearBales.length ? `${fmtInt(gradedCount)} of ${fmtInt(yearBales.length)}` : '—', sub: yearBales.length && gradedCount < yearBales.length ? `${fmtInt(yearBales.length - gradedCount)} waiting on the classing office` : yearBales.length ? 'every bale has grades' : undefined, tone: yearBales.length && gradedCount < yearBales.length ? 'warning' : 'neutral' },
    { label: 'Loan value', value: loanLbs ? `$${fmtNum(loanTotal / loanLbs / 1, 4)} /lb` : '—', sub: loanLbs ? `$${fmtNum(loanTotal, 2)} on ${fmtInt(graded.filter((g) => g.loan_value_total != null).length)} classed bales` : 'from the classing loan values' },
  ]
  void inputCls

  return (
    <div className="space-y-4">
      <CottonPageHeader
        title="Bales & Grades"
        sub="Every bale from your gin receipts, with its HVI classing once the office’s file arrives."
        cropYear={cropYear}
        years={years}
        onCropYear={setCropYear}
      />

      <SummaryCards cards={summaryCards} />

      <CottonSection title="Import classing data" sub="The classing office’s CSV is read as-is: rows match bales by PBI number (leading zeros don’t matter); farm and field columns only double-check.">
        <div className="p-4 space-y-3">
        <Dropzone
          onFiles={(files) => void onCsv(files[0])}
          onReject={(rejected) => setErr(rejectMessage("Use the classing office's CSV file.", rejected))}
          accept=".csv,text/csv"
          hint="Drop the classing CSV here"
          accepts="The classing office's CSV"
          className="inline-block"
        >
          <input
            type="file" accept=".csv,text/csv"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onCsv(f); e.target.value = '' }}
            className="text-sm"
          />
        </Dropzone>
        {preview && (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-green-100 text-green-800 px-2 py-0.5 font-semibold">{preview.matched.length} matched</span>
              <span className={`rounded-full px-2 py-0.5 font-semibold ${preview.unmatched.length ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}>{preview.unmatched.length} no matching bale</span>
              {repeatedInFile.length > 0 && <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 font-semibold" title={repeatedInFile.join(', ')}>{repeatedInFile.length} repeated in the file, kept once: {repeatedInFile.slice(0, 5).join(', ')}{repeatedInFile.length > 5 ? '…' : ''}</span>}
              <span className={`rounded-full px-2 py-0.5 font-semibold ${preview.matched.some((m) => m.weightMismatch) ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-500'}`}>
                {preview.matched.filter((m) => m.weightMismatch).length} weight mismatches (&gt;1%)
              </span>
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="min-w-full text-xs">
                <thead className="text-slate-500 sticky top-0 bg-white"><tr>{['PBI #', 'NetWt', 'Gr', 'St', 'Mic', 'Str', 'Loan $/lb', 'Status'].map((h) => <th key={h} className="text-left px-1 py-1">{h}</th>)}</tr></thead>
                <tbody>
                  {preview.matched.map(({ row, weightMismatch }, i) => (
                    <tr key={`m${i}`} className="border-t border-slate-100">
                      <td className="px-1 py-0.5 font-mono">{row.pbi_number}</td>
                      <td className="px-1 py-0.5 text-right">{row.net_weight_lbs ?? '—'}</td>
                      <td className="px-1 py-0.5">{row.color_grade ?? '—'}</td>
                      <td className="px-1 py-0.5">{fmt(row.staple_32nds, 0)}</td>
                      <td className="px-1 py-0.5">{fmt(row.micronaire, 1)}</td>
                      <td className="px-1 py-0.5">{fmt(row.strength_g_tex, 1)}</td>
                      <td className="px-1 py-0.5 text-right">{row.loan_value_cents_per_lb != null ? `$${(Number(row.loan_value_cents_per_lb) / 100).toFixed(4)}` : '—'}</td>
                      <td className="px-1 py-0.5">{weightMismatch ? <span className="text-red-700">NetWt differs &gt;1% from the receipt bale</span> : <span className="text-green-700">ok</span>}</td>
                    </tr>
                  ))}
                  {preview.unmatched.map((row, i) => (
                    <tr key={`u${i}`} className="border-t border-slate-100 bg-amber-50">
                      <td className="px-1 py-0.5 font-mono">{row.pbi_number}</td>
                      <td className="px-1 py-0.5 text-right">{row.net_weight_lbs ?? '—'}</td>
                      <td className="px-1 py-0.5" colSpan={5}>{row.farm ? `farm ${row.farm}` : ''} {row.field_id_text ?? ''}</td>
                      <td className="px-1 py-0.5 text-amber-800">no matching bale — enter its gin receipt, then re-import</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <button onClick={saveGrades} disabled={saving || preview.matched.length === 0} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">
                {saving ? 'Saving…' : `Save ${preview.matched.length} matched grades`}
              </button>
              <button onClick={() => setPreview(null)} className="rounded-lg bg-white border border-slate-300 px-4 min-h-11">Cancel</button>
            </div>
          </div>
        )}
        </div>
      </CottonSection>

      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      {msg && <p className="text-sm text-green-700" role="status">{msg}</p>}

      {yearBales.length === 0 ? (
        <EmptyState message={`No ${cropYear} bales yet.`} hint="Bales come from gin receipts — upload a Statement of Ginning and they appear here." linkHref="/cotton/receipts" linkLabel="Open Gin Receipts" />
      ) : (
      <CottonSection title="Bales" sub={`${cropYear} crop · ${fmtInt(yearBales.length)} bales · ${fmtInt(gradedCount)} classed`}>
        <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className={theadCls}><tr>{['PBI #', 'Farm', 'Field', 'Net lbs', 'Gr', 'Lf', 'St', 'Mic', 'Str', 'Cgr', 'Loan $/lb', 'Loan $'].map((h, k) => <th key={h} className={`${k === 3 || k >= 10 ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap`}>{h}</th>)}</tr></thead>
          <tbody>
            {yearBales.map((b) => {
              const g = gradeByBale.get(b.id)
              const r = receiptById.get(b.gin_receipt_id)
              return (
                <tr key={b.id} className={`border-t border-slate-100 ${g ? '' : 'text-slate-500'}`}>
                  <td className="px-3 py-1.5 font-mono font-semibold text-slate-900">{b.pbi_number}{!g && <span className="ml-2 inline-block rounded-full bg-slate-100 text-slate-500 text-[10px] font-medium px-1.5 py-0.5 align-middle">not classed</span>}</td>
                  <td className="px-3 py-1.5">{r?.farm_id ? farmById.get(r.farm_id)?.name ?? '—' : '—'}</td>
                  <td className="px-3 py-1.5">{r?.field_id ? fieldById.get(r.field_id)?.name_or_number ?? '—' : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(Number(b.net_weight_lbs))}</td>
                  <td className="px-3 py-1.5">{g?.color_grade ?? '—'}</td>
                  <td className="px-3 py-1.5">{g?.leaf_grade ?? '—'}</td>
                  <td className="px-3 py-1.5">{fmt(g?.staple_32nds, 0)}</td>
                  <td className="px-3 py-1.5">{fmt(g?.micronaire, 1)}</td>
                  <td className="px-3 py-1.5">{fmt(g?.strength_g_tex, 1)}</td>
                  <td className="px-3 py-1.5">{g?.composite_grade ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{g?.loan_value_cents_per_lb != null ? `$${(Number(g.loan_value_cents_per_lb) / 100).toFixed(4)}` : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{g?.loan_value_total != null ? `$${fmtNum(Number(g.loan_value_total), 2)}` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </CottonSection>
      )}
    </div>
  )
}
