'use client'

// Cotton module — Bales & Grades: every bale (from gin receipts) with its HVI
// classing data. Classing CSVs import DETERMINISTICALLY (lib/cotton-grades) —
// no AI: preamble skipped, columns mapped by header name, each row matched to
// a bale by PBI number. Unmatched rows (receipt not entered yet) stay visible
// with a "no matching bale" flag and import later; NetWt cross-checks the
// bale's receipt weight (>1% flagged). Standard preview → confirm → save.
// DUPLICATES (2026-11-14): lib/cotton-grades planGradeImport is the one rule —
// a bale already graded with the same values is skipped, a changed grade is
// held until the user ticks "replace", a bale the file repeats is kept once
// (or held out when the copies disagree). The import stays closed until the
// bales have loaded: a file dropped onto the empty list matched nothing.
// The list sorts by PBI # or by harvest date — the picked dates of the seed
// cotton loads on the bale's gin receipt (lib/bale-quality-report
// harvestSpanOf, the same span the Bale Quality report groups by).

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { parseGradeCsv, planGradeImport, type ParsedGradeRow } from '@/lib/cotton-grades'
import { cottonLoadDate } from '@/lib/cotton'
import { harvestSpanOf } from '@/lib/bale-quality-report'
import type { CottonBale, CottonBaleGrade, GinReceipt, Farm, Field } from '@/lib/types'
import Dropzone, { rejectMessage } from '@/components/dropzone'
import { reportError } from '@/lib/friendly-error'
import { fmtDate } from '@/lib/format-date'
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
  const [receiptLoads, setReceiptLoads] = useState<Array<{ receipt_id: string; cotton_load_id: string }>>([])
  const [loadDates, setLoadDates] = useState<Array<{ id: string; picked_date: string | null; delivered_date: string | null }>>([])
  const [sort, setSort] = usePersistentState<{ key: 'pbi' | 'harvest'; dir: 1 | -1 }>('cotton:bales:sort', { key: 'pbi', dir: 1 })
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // The parsed file; the plan is DERIVED from it and the loaded bales/grades,
  // so it can never be computed against a list that has not arrived yet.
  const [fileRows, setFileRows] = useState<ParsedGradeRow[] | null>(null)
  const [replaceChanged, setReplaceChanged] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  async function refresh() {
    const [b, g, r, f, fl, rl, ld] = await Promise.all([
      fetchAllRows((f, t) => supabase.from('cotton_bales').select('*').order('pbi_number').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('cotton_bale_grades').select('*').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('gin_receipts').select('*').order('id').range(f, t)),
      supabase.from('farms').select('*'),
      supabase.from('fields').select('*'),
      fetchAllRows((f, t) => supabase.from('gin_receipt_loads').select('receipt_id, cotton_load_id').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('cotton_loads').select('id, picked_date, delivered_date').order('id').range(f, t)),
    ])
    setBales((b.data as CottonBale[]) || [])
    setGrades((g.data as CottonBaleGrade[]) || [])
    setReceipts((r.data as GinReceipt[]) || [])
    setFarms((f.data as Farm[]) || [])
    setFields((fl.data as Field[]) || [])
    setReceiptLoads((rl.data as Array<{ receipt_id: string; cotton_load_id: string }>) || [])
    setLoadDates((ld.data as Array<{ id: string; picked_date: string | null; delivered_date: string | null }>) || [])
    const failed = [b, g, r].find((x) => x.error)
    if (failed?.error) { setErr(reportError(failed.error, { action: 'load your bales', noun: 'bale' })); return }
    setLoaded(true)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  // Each receipt's harvest span, from its loads' ticket dates.
  const harvestByReceipt = useMemo(() => {
    const dateOf = new Map(loadDates.map((l) => [l.id, cottonLoadDate(l)]))
    const dates = new Map<string, Array<string | null>>()
    for (const k of receiptLoads) dates.set(k.receipt_id, [...(dates.get(k.receipt_id) ?? []), dateOf.get(k.cotton_load_id) ?? null])
    return new Map([...dates].map(([id, ds]) => [id, harvestSpanOf(ds)]))
  }, [receiptLoads, loadDates])
  const yearBales = useMemo(() => {
    const ys = bales.filter((b) => b.crop_year === cropYear)
    if (sort.key === 'pbi') return sort.dir === 1 ? ys : [...ys].reverse()
    const key = (b: CottonBale) => { const h = harvestByReceipt.get(b.gin_receipt_id); return h?.from ? `${h.from}|${h.to}` : null }
    // Undated bales stay last either way; PBI order within a day.
    return [...ys].sort((a, z) => {
      const ka = key(a), kz = key(z)
      if (ka == null || kz == null) return ka == null && kz == null ? 0 : ka == null ? 1 : -1
      return (ka < kz ? -1 : ka > kz ? 1 : 0) * sort.dir || a.pbi_number.localeCompare(z.pbi_number, undefined, { numeric: true })
    })
  }, [bales, cropYear, sort, harvestByReceipt])
  const toggleSort = (key: 'pbi' | 'harvest') => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  const gradeByBale = useMemo(() => new Map(grades.map((g) => [g.bale_id, g])), [grades])
  const receiptById = useMemo(() => new Map(receipts.map((r) => [r.id, r])), [receipts])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])

  const preview = useMemo(() => {
    if (!fileRows || !loaded) return null
    const savedGrades = new Map(grades.map((g) => [g.bale_id, g as unknown as Record<string, string | number | null>]))
    return planGradeImport(fileRows, yearBales, savedGrades, bales.filter((b) => b.crop_year !== cropYear))
  }, [fileRows, loaded, grades, yearBales, bales, cropYear])

  async function onCsv(file: File) {
    setErr(null); setMsg(null); setFileRows(null); setReplaceChanged(false)
    const text = await file.text()
    const parsed = parseGradeCsv(text)
    if (parsed.error) { setErr(parsed.error); return }
    if (parsed.rows.length === 0) { setErr('No bale rows found in the CSV.'); return }
    setFileRows(parsed.rows)
    const undated = parsed.rows.filter((r) => r.class_date == null).length
    setMsg(`Read ${fmtInt(parsed.rows.length)} bale${parsed.rows.length === 1 ? '' : 's'} from ${file.name}${parsed.preambleClassDate ? `, classed ${fmtDate(parsed.preambleClassDate)}` : ''}${parsed.unknownHeaders.length ? ` (columns not used: ${parsed.unknownHeaders.join(', ')})` : ''}${undated ? ` — ${undated} with no class date printed` : ''}.`)
  }

  async function saveGrades() {
    if (!preview) return
    setSaving(true); setErr(null)
    try {
      const toRow = ({ row, bale }: { row: ParsedGradeRow; bale: { id: string } }) => ({
        bale_id: bale.id,
        class_date: row.class_date,
        color_grade: row.color_grade, leaf_grade: row.leaf_grade, staple_32nds: row.staple_32nds,
        micronaire: row.micronaire, strength_g_tex: row.strength_g_tex, composite_grade: row.composite_grade,
        rd: row.rd, plus_b: row.plus_b, trash_pct: row.trash_pct, uniformity_pct: row.uniformity_pct,
        length_100ths: row.length_100ths, extraneous: row.extraneous, remarks: row.remarks,
        loan_value_total: row.loan_value_total, loan_value_cents_per_lb: row.loan_value_cents_per_lb,
        source: 'csv_import',
      })
      const fresh = preview.new.map(toRow)
      const replaced = replaceChanged ? preview.changed.map(toRow) : []
      if (fresh.length + replaced.length === 0) { setErr('Nothing new to save from this file.'); return }
      // New grades never overwrite: a grade saved meanwhile (another device) is left alone.
      for (let i = 0; i < fresh.length; i += 500) {
        const { error } = await supabase.from('cotton_bale_grades').upsert(fresh.slice(i, i + 500), { onConflict: 'bale_id', ignoreDuplicates: true })
        if (error) { setErr(reportError(error, { action: 'save the classing data', noun: 'bale' })); return }
      }
      for (let i = 0; i < replaced.length; i += 500) {
        const { error } = await supabase.from('cotton_bale_grades').upsert(replaced.slice(i, i + 500), { onConflict: 'bale_id' })
        if (error) { setErr(reportError(error, { action: 'replace the changed grades', noun: 'bale' })); return }
      }
      const parts = [
        `Saved grades for ${fmtInt(fresh.length)} new bale${fresh.length === 1 ? '' : 's'}`,
        replaced.length ? `replaced ${fmtInt(replaced.length)} changed grade${replaced.length === 1 ? '' : 's'}` : '',
        preview.unchanged.length ? `${fmtInt(preview.unchanged.length)} already on file, left as they were` : '',
        preview.changed.length && !replaced.length ? `${fmtInt(preview.changed.length)} changed grade${preview.changed.length === 1 ? '' : 's'} not replaced` : '',
        preview.unmatched.length ? `${fmtInt(preview.unmatched.length)} with no matching bale yet` : '',
      ].filter(Boolean)
      setMsg(`${parts.join(' · ')}.`)
      setFileRows(null); refresh()
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
        {!loaded ? (
          <p className="text-sm text-slate-600" role="status">Loading your bales — the import opens once they are in, so every row can be checked against them.</p>
        ) : (
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
        )}
        {preview && (() => {
          const otherYears = [...new Set(preview.otherYear.map((o) => o.cropYear))].sort()
          const toSave = preview.new.length + (replaceChanged ? preview.changed.length : 0)
          const weightFlags = [...preview.new, ...preview.changed].filter((m) => m.weightMismatch).length
          const chip = (n: number, label: string, tone: 'good' | 'warn' | 'bad' | 'muted') => (
            <span className={`rounded-full px-2 py-0.5 font-semibold ${n === 0 ? 'bg-slate-100 text-slate-500' : tone === 'good' ? 'bg-green-100 text-green-800' : tone === 'warn' ? 'bg-amber-100 text-amber-800' : tone === 'bad' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'}`}>{fmtInt(n)} {label}</span>
          )
          const gradeCells = (row: ParsedGradeRow) => (
            <>
              <td className="px-1 py-0.5 font-mono">{row.pbi_number}</td>
              <td className="px-1 py-0.5 text-right">{row.net_weight_lbs ?? '—'}</td>
              <td className="px-1 py-0.5">{row.color_grade ?? '—'}</td>
              <td className="px-1 py-0.5">{fmt(row.staple_32nds, 0)}</td>
              <td className="px-1 py-0.5">{fmt(row.micronaire, 1)}</td>
              <td className="px-1 py-0.5">{fmt(row.strength_g_tex, 1)}</td>
              <td className="px-1 py-0.5 text-right">{row.loan_value_cents_per_lb != null ? `$${(Number(row.loan_value_cents_per_lb) / 100).toFixed(4)}` : '—'}</td>
            </>
          )
          return (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2 text-xs">
              {chip(preview.new.length, 'new — will be saved', 'good')}
              {chip(preview.unchanged.length, 'already on file, same grades — skipped', 'muted')}
              {chip(preview.changed.length, 'already on file with different grades', 'warn')}
              {chip(preview.repeatedSame.length, 'repeated in the file — kept once', 'muted')}
              {chip(preview.repeatedConflict.length, 'listed twice with different grades — held out', 'bad')}
              {chip(preview.unmatched.length, 'no matching bale', 'warn')}
              {chip(weightFlags, 'weight differs >1% from the gin receipt', 'bad')}
            </div>
            {otherYears.length > 0 && (
              <p className="text-sm text-amber-800" role="alert">
                {fmtInt(preview.otherYear.length)} bale{preview.otherYear.length === 1 ? ' is' : 's are'} on {otherYears.join(' / ')} gin receipts, not {cropYear}. Switch the crop year at the top to {otherYears[0]} to import {preview.otherYear.length === 1 ? 'it' : 'them'}.
              </p>
            )}
            {preview.changed.length > 0 && (
              <label className="flex items-center gap-2 min-h-11 text-sm">
                <input type="checkbox" className="h-5 w-5" checked={replaceChanged} onChange={(e) => setReplaceChanged(e.target.checked)} />
                Replace the {fmtInt(preview.changed.length)} saved grade{preview.changed.length === 1 ? '' : 's'} that differ with this file’s (a re-class or a corrected file)
              </label>
            )}
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="min-w-full text-xs">
                <thead className="text-slate-500 sticky top-0 bg-white"><tr>{['PBI #', 'NetWt', 'Gr', 'St', 'Mic', 'Str', 'Loan $/lb', 'Status'].map((h) => <th key={h} className="text-left px-1 py-1">{h}</th>)}</tr></thead>
                <tbody>
                  {preview.repeatedConflict.flatMap(({ rows }, i) => rows.map((row, j) => (
                    <tr key={`x${i}-${j}`} className="border-t border-slate-100 bg-red-50">
                      {gradeCells(row)}
                      <td className="px-1 py-0.5 text-red-700">listed {rows.length} times with different grades — not saved; ask the classing office which is right</td>
                    </tr>
                  )))}
                  {preview.changed.map(({ row, diffs, weightMismatch }, i) => (
                    <tr key={`c${i}`} className="border-t border-slate-100 bg-amber-50">
                      {gradeCells(row)}
                      <td className="px-1 py-0.5 text-amber-800">{replaceChanged ? 'will replace' : 'kept as saved'}: {diffs.join(', ')}{weightMismatch ? ' · NetWt differs >1%' : ''}</td>
                    </tr>
                  ))}
                  {preview.new.map(({ row, weightMismatch }, i) => (
                    <tr key={`m${i}`} className="border-t border-slate-100">
                      {gradeCells(row)}
                      <td className="px-1 py-0.5">{weightMismatch ? <span className="text-red-700">new · NetWt differs &gt;1% from the receipt bale</span> : <span className="text-green-700">new</span>}</td>
                    </tr>
                  ))}
                  {preview.otherYear.map(({ row, cropYear: y }, i) => (
                    <tr key={`o${i}`} className="border-t border-slate-100 bg-amber-50">
                      <td className="px-1 py-0.5 font-mono">{row.pbi_number}</td>
                      <td className="px-1 py-0.5 text-right">{row.net_weight_lbs ?? '—'}</td>
                      <td className="px-1 py-0.5" colSpan={5}>{row.farm ? `farm ${row.farm}` : ''} {row.field_id_text ?? ''}</td>
                      <td className="px-1 py-0.5 text-amber-800">on a {y} gin receipt — switch the crop year to import</td>
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
            {preview.unchanged.length > 0 && <p className="text-xs text-slate-600">{fmtInt(preview.unchanged.length)} bale{preview.unchanged.length === 1 ? ' is' : 's are'} already saved with exactly these grades and {preview.unchanged.length === 1 ? 'is' : 'are'} left untouched.</p>}
            <div className="flex gap-2">
              <button onClick={saveGrades} disabled={saving || toSave === 0} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">
                {saving ? 'Saving…' : toSave === 0 ? 'Nothing new to save' : `Save ${fmtInt(toSave)} grade${toSave === 1 ? '' : 's'}`}
              </button>
              <button onClick={() => setFileRows(null)} className="rounded-lg bg-white border border-slate-300 px-4 min-h-11">Cancel</button>
            </div>
          </div>
          )
        })()}
        </div>
      </CottonSection>

      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      {msg && <p className="text-sm text-green-700" role="status">{msg}</p>}

      {!loaded ? (
        <p className="text-sm text-slate-600" role="status">Loading bales…</p>
      ) : yearBales.length === 0 ? (
        <EmptyState message={`No ${cropYear} bales yet.`} hint="Bales come from gin receipts — upload a Statement of Ginning and they appear here." linkHref="/cotton/receipts" linkLabel="Open Gin Receipts" />
      ) : (
      <CottonSection title="Bales" sub={`${cropYear} crop · ${fmtInt(yearBales.length)} bales · ${fmtInt(gradedCount)} classed`}>
        <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className={theadCls}><tr>{['PBI #', 'Farm', 'Field', 'Harvested', 'Net lbs', 'Gr', 'Lf', 'St', 'Mic', 'Str', 'Cgr', 'Loan $/lb', 'Loan $'].map((h, k) => {
            const sortKey = h === 'PBI #' ? 'pbi' : h === 'Harvested' ? 'harvest' : null
            return (
              <th key={h} aria-sort={sortKey && sort.key === sortKey ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} className={`${k === 4 || k >= 11 ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap`}>
                {sortKey ? (
                  <button type="button" onClick={() => toggleSort(sortKey)} className="min-h-11 font-semibold hover:underline">{h}{sort.key === sortKey ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>
                ) : h}
              </th>
            )
          })}</tr></thead>
          <tbody>
            {yearBales.map((b) => {
              const g = gradeByBale.get(b.id)
              const r = receiptById.get(b.gin_receipt_id)
              return (
                <tr key={b.id} className={`border-t border-slate-100 ${g ? '' : 'text-slate-500'}`}>
                  <td className="px-3 py-1.5 font-mono font-semibold text-slate-900">{b.pbi_number}{!g && <span className="ml-2 inline-block rounded-full bg-slate-100 text-slate-500 text-[10px] font-medium px-1.5 py-0.5 align-middle">not classed</span>}</td>
                  <td className="px-3 py-1.5">{r?.farm_id ? farmById.get(r.farm_id)?.name ?? '—' : '—'}</td>
                  <td className="px-3 py-1.5">{r?.field_id ? fieldById.get(r.field_id)?.name_or_number ?? '—' : '—'}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{harvestByReceipt.get(b.gin_receipt_id)?.from ? harvestByReceipt.get(b.gin_receipt_id)!.label : '—'}</td>
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
