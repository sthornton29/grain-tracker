'use client'

// Cotton module — Bales & Grades: every bale (from gin receipts) with its HVI
// classing data. Classing CSVs import DETERMINISTICALLY (lib/cotton-grades) —
// no AI: preamble skipped, columns mapped by header name, each row matched to
// a bale by PBI number. Unmatched rows (receipt not entered yet) stay visible
// with a "no matching bale" flag and import later; NetWt cross-checks the
// bale's receipt weight (>1% flagged). Standard preview → confirm → save.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import { parseGradeCsv, type ParsedGradeRow } from '@/lib/cotton-grades'
import { matchGradesToBales } from '@/lib/cotton'
import type { CottonBale, CottonBaleGrade, GinReceipt, Farm, Field } from '@/lib/types'

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
      supabase.from('cotton_bales').select('*').order('pbi_number'),
      supabase.from('cotton_bale_grades').select('*'),
      supabase.from('gin_receipts').select('*'),
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

  async function onCsv(file: File) {
    setErr(null); setMsg(null); setPreview(null)
    const text = await file.text()
    const parsed = parseGradeCsv(text)
    if (parsed.error) { setErr(parsed.error); return }
    if (parsed.rows.length === 0) { setErr('No bale rows found in the CSV.'); return }
    setPreview(matchGradesToBales(parsed.rows, yearBales))
    setMsg(`Parsed ${parsed.rows.length} grade rows (${parsed.preambleLines} preamble lines skipped${parsed.unknownHeaders.length ? `; unrecognized columns: ${parsed.unknownHeaders.join(', ')}` : ''}).`)
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
      if (error) { setErr(error.message); return }
      setMsg(`Saved classing data for ${rows.length} bale${rows.length === 1 ? '' : 's'}${preview.unmatched.length ? ` — ${preview.unmatched.length} unmatched row${preview.unmatched.length === 1 ? '' : 's'} left for later (no matching bale yet)` : ''}.`)
      setPreview(null); refresh()
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const gradedCount = yearBales.filter((b) => gradeByBale.has(b.id)).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-bold flex-1">Bales &amp; Grades</h1>
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year</span>
          <input type="number" value={cropYear} onChange={(e) => setCropYear(Number(e.target.value))} className={`${inputCls} w-24`} />
        </label>
      </div>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Import Classing Data (CSV)</h2>
        <p className="text-sm text-slate-500">
          The classing office&apos;s CSV parses directly (no AI): the preamble is skipped and columns map by header
          name. Rows match bales by <b>Bale # (PBI)</b>; Farm/Field columns are corroboration only.
        </p>
        <input
          type="file" accept=".csv,text/csv"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onCsv(f); e.target.value = '' }}
          className="text-sm"
        />
        {preview && (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-green-100 text-green-800 px-2 py-0.5 font-semibold">{preview.matched.length} matched</span>
              <span className={`rounded-full px-2 py-0.5 font-semibold ${preview.unmatched.length ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}>{preview.unmatched.length} no matching bale</span>
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
              <button onClick={saveGrades} disabled={saving || preview.matched.length === 0} className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold disabled:opacity-50">
                {saving ? 'Saving…' : `Save ${preview.matched.length} matched grades`}
              </button>
              <button onClick={() => setPreview(null)} className="rounded-lg bg-white border border-slate-300 px-4 py-2">Cancel</button>
            </div>
          </div>
        )}
      </section>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}

      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <div className="px-3 pt-3 text-sm text-slate-500">{yearBales.length} bales · {gradedCount} classed</div>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700"><tr>{['PBI #', 'Farm', 'Field', 'Net lbs', 'Gr', 'Lf', 'St', 'Mic', 'Str', 'Cgr', 'Loan $/lb', 'Loan $'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>
            {yearBales.length === 0 && <tr><td colSpan={12} className="px-3 py-6 text-center text-slate-400">No {cropYear} bales yet — they come from gin receipts.</td></tr>}
            {yearBales.map((b) => {
              const g = gradeByBale.get(b.id)
              const r = receiptById.get(b.gin_receipt_id)
              return (
                <tr key={b.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 font-mono">{b.pbi_number}</td>
                  <td className="px-3 py-1.5">{r?.farm_id ? farmById.get(r.farm_id)?.name ?? '—' : '—'}</td>
                  <td className="px-3 py-1.5">{r?.field_id ? fieldById.get(r.field_id)?.name_or_number ?? '—' : '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(b.net_weight_lbs).toLocaleString()}</td>
                  <td className="px-3 py-1.5">{g?.color_grade ?? '—'}</td>
                  <td className="px-3 py-1.5">{g?.leaf_grade ?? '—'}</td>
                  <td className="px-3 py-1.5">{fmt(g?.staple_32nds, 0)}</td>
                  <td className="px-3 py-1.5">{fmt(g?.micronaire, 1)}</td>
                  <td className="px-3 py-1.5">{fmt(g?.strength_g_tex, 1)}</td>
                  <td className="px-3 py-1.5">{g?.composite_grade ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right">{g?.loan_value_cents_per_lb != null ? `$${(Number(g.loan_value_cents_per_lb) / 100).toFixed(4)}` : '—'}</td>
                  <td className="px-3 py-1.5 text-right">{g?.loan_value_total != null ? `$${Number(g.loan_value_total).toFixed(2)}` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
