'use client'

// Bale Quality Summary — the HVI quality package a producer shows buyers:
// per field (with farm/entity rollups) per crop year — bales, total lint lbs,
// weighted avg loan ¢/lb, and distributions of the key grades (color grade,
// staple, mic, strength ranges). Cotton-module report; exports through the
// shared layer.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { theadCls, grandTotalRowCls } from '@/components/reports/report-kit'
import type { ExportPayload, ExportCell } from '@/lib/exports'
import type { CottonBale, CottonBaleGrade, GinReceipt, Farm, Field, Entity } from '@/lib/types'

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const MIC_RANGES: Array<[string, (m: number) => boolean]> = [
  ['Mic <3.5 (disc)', (m) => m < 3.5],
  ['Mic 3.5–4.9', (m) => m >= 3.5 && m <= 4.9],
  ['Mic >4.9 (disc)', (m) => m > 4.9],
]
const STAPLE_RANGES: Array<[string, (s: number) => boolean]> = [
  ['St <34', (s) => s < 34],
  ['St 34–36', (s) => s >= 34 && s <= 36],
  ['St ≥37', (s) => s >= 37],
]
const STR_RANGES: Array<[string, (s: number) => boolean]> = [
  ['Str <28', (s) => s < 28],
  ['Str 28–30', (s) => s >= 28 && s <= 30],
  ['Str >30', (s) => s > 30],
]

export default function BaleQualityReport({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [bales, setBales] = useState<CottonBale[]>([])
  const [grades, setGrades] = useState<CottonBaleGrade[]>([])
  const [receipts, setReceipts] = useState<GinReceipt[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())

  useEffect(() => {
    ;(async () => {
      const [b, g, r, f, fl, en] = await Promise.all([
        fetchAllRows((f, t) => supabase.from('cotton_bales').select('*').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('cotton_bale_grades').select('*').order('id').range(f, t)),
        supabase.from('gin_receipts').select('*'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('entities').select('*'),
      ])
      setBales((b.data as CottonBale[]) || [])
      setGrades((g.data as CottonBaleGrade[]) || [])
      setReceipts((r.data as GinReceipt[]) || [])
      setFarms((f.data as Farm[]) || [])
      setFields((fl.data as Field[]) || [])
      setEntities((en.data as Entity[]) || [])
    })()
  }, [supabase])

  const rows = useMemo(() => {
    const gradeByBale = new Map(grades.map((g) => [g.bale_id, g]))
    const receiptById = new Map(receipts.map((r) => [r.id, r]))
    const farmById = new Map(farms.map((f) => [f.id, f]))
    const fieldById = new Map(fields.map((f) => [f.id, f]))
    const entityById = new Map(entities.map((e) => [e.id, e]))
    type Agg = {
      key: string; entity: string; farm: string; field: string
      bales: number; lintLbs: number; loanLbs: number; loanValue: number; classed: number
      colors: Map<string, number>; mic: number[]; staple: number[]; str: number[]
    }
    const byField = new Map<string, Agg>()
    for (const b of bales.filter((x) => x.crop_year === cropYear)) {
      const r = receiptById.get(b.gin_receipt_id)
      const farm = r?.farm_id ? farmById.get(r.farm_id) : null
      const field = r?.field_id ? fieldById.get(r.field_id) : null
      const entity = farm?.entity_id ? entityById.get(farm.entity_id) : null
      const key = `${entity?.name ?? '—'}|${farm?.name ?? '—'}|${field?.name_or_number ?? '—'}`
      let a = byField.get(key)
      if (!a) {
        a = { key, entity: entity?.name ?? '—', farm: farm?.name ?? '—', field: field?.name_or_number ?? '—', bales: 0, lintLbs: 0, loanLbs: 0, loanValue: 0, classed: 0, colors: new Map(), mic: [], staple: [], str: [] }
        byField.set(key, a)
      }
      a.bales += 1
      a.lintLbs += Number(b.net_weight_lbs)
      const g = gradeByBale.get(b.id)
      if (g) {
        a.classed += 1
        if (g.loan_value_total != null) { a.loanValue += Number(g.loan_value_total); a.loanLbs += Number(b.net_weight_lbs) }
        if (g.color_grade) a.colors.set(g.color_grade, (a.colors.get(g.color_grade) ?? 0) + 1)
        if (g.micronaire != null) a.mic.push(Number(g.micronaire))
        if (g.staple_32nds != null) a.staple.push(Number(g.staple_32nds))
        if (g.strength_g_tex != null) a.str.push(Number(g.strength_g_tex))
      }
    }
    return Array.from(byField.values()).sort((a, b) => a.key.localeCompare(b.key))
  }, [bales, grades, receipts, farms, fields, entities, cropYear])

  const totals = useMemo(() => {
    const t = { bales: 0, lintLbs: 0, loanLbs: 0, loanValue: 0, classed: 0, colors: new Map<string, number>(), mic: [] as number[], staple: [] as number[], str: [] as number[] }
    for (const r of rows) {
      t.bales += r.bales; t.lintLbs += r.lintLbs; t.loanLbs += r.loanLbs; t.loanValue += r.loanValue; t.classed += r.classed
      for (const [c, n] of r.colors) t.colors.set(c, (t.colors.get(c) ?? 0) + n)
      t.mic.push(...r.mic); t.staple.push(...r.staple); t.str.push(...r.str)
    }
    return t
  }, [rows])

  const avgLoan = (loanValue: number, loanLbs: number) => (loanLbs > 0 ? (loanValue / loanLbs) * 100 : null)
  const dist = (values: number[], ranges: Array<[string, (v: number) => boolean]>) =>
    ranges.map(([label, test]) => `${label}: ${values.filter(test).length}`).join(' · ')
  const colorDist = (colors: Map<string, number>) =>
    Array.from(colors.entries()).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join(' ')

  function buildPayload(): ExportPayload {
    return {
      title: 'Bale Quality Summary',
      filters: `Crop year: ${cropYear}`,
      summary: [
        { label: 'Bales', value: String(totals.bales) },
        { label: 'Lint lbs', value: totals.lintLbs.toLocaleString() },
        { label: 'Avg Loan $/lb', value: (() => { const a = avgLoan(totals.loanValue, totals.loanLbs); return a != null ? `$${(a / 100).toFixed(4)}` : '—' })() },
      ],
      sections: [{
        title: 'Bale Quality by Field',
        columns: [
          { label: 'Entity' }, { label: 'Farm' }, { label: 'Field' },
          { label: 'Bales', align: 'right', format: 'int' }, { label: 'Lint lbs', align: 'right', format: 'int' },
          { label: 'Classed', align: 'right', format: 'int' }, { label: 'Avg Loan $/lb', align: 'right', format: 'cents' },
          { label: 'Color Grades' }, { label: 'Staple' }, { label: 'Mic' }, { label: 'Strength' },
        ],
        rows: [
          ...rows.map((r): ExportCell[] => [
            r.entity, r.farm, r.field, r.bales, Math.round(r.lintLbs), r.classed,
            avgLoan(r.loanValue, r.loanLbs) ?? '',
            colorDist(r.colors), dist(r.staple, STAPLE_RANGES), dist(r.mic, MIC_RANGES), dist(r.str, STR_RANGES),
          ]),
          ['Total', '', '', totals.bales, Math.round(totals.lintLbs), totals.classed, avgLoan(totals.loanValue, totals.loanLbs) ?? '', colorDist(totals.colors), dist(totals.staple, STAPLE_RANGES), dist(totals.mic, MIC_RANGES), dist(totals.str, STR_RANGES)],
        ],
        rowMeta: [...rows.map(() => 'data' as const), 'total'],
      }],
    }
  }
  useEffect(() => {
    if (onPayloadChange) onPayloadChange(() => buildPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, totals, cropYear, onPayloadChange])

  return (
    <div className="space-y-3">
      <label className="text-sm flex items-center gap-2 no-print">
        <span className="text-slate-500">Crop year</span>
        <input type="number" value={cropYear} onChange={(e) => setCropYear(Number(e.target.value))} className="rounded-lg border border-slate-300 px-3 py-2 w-24" />
      </label>
      {rows.length === 0 ? (
        <p className="text-slate-400">No {cropYear} bales — bales come from gin receipts (Cotton → Gin Receipts).</p>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="min-w-full text-sm border-collapse">
            <thead className={theadCls}>
              <tr>{['Entity', 'Farm', 'Field', 'Bales', 'Lint lbs', 'Classed', 'Avg Loan $/lb', 'Color Grades', 'Staple', 'Mic', 'Strength'].map((h, i) => <th key={h} className={`${i >= 3 && i <= 6 ? 'text-right' : 'text-left'} px-2 py-1.5 whitespace-nowrap`}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-slate-100">
                  <td className="px-2 py-1.5">{r.entity}</td>
                  <td className="px-2 py-1.5">{r.farm}</td>
                  <td className="px-2 py-1.5 font-semibold">{r.field}</td>
                  <td className="px-2 py-1.5 text-right">{r.bales}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{Math.round(r.lintLbs).toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right">{r.classed}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{(() => { const a = avgLoan(r.loanValue, r.loanLbs); return a != null ? `$${(a / 100).toFixed(4)}` : '—' })()}</td>
                  <td className="px-2 py-1.5 text-xs">{colorDist(r.colors) || '—'}</td>
                  <td className="px-2 py-1.5 text-xs whitespace-nowrap">{r.staple.length ? dist(r.staple, STAPLE_RANGES) : '—'}</td>
                  <td className="px-2 py-1.5 text-xs whitespace-nowrap">{r.mic.length ? dist(r.mic, MIC_RANGES) : '—'}</td>
                  <td className="px-2 py-1.5 text-xs whitespace-nowrap">{r.str.length ? dist(r.str, STR_RANGES) : '—'}</td>
                </tr>
              ))}
              <tr className={grandTotalRowCls}>
                <td className="px-2 py-1.5" colSpan={3}>Total</td>
                <td className="px-2 py-1.5 text-right">{totals.bales}</td>
                <td className="px-2 py-1.5 text-right font-mono">{Math.round(totals.lintLbs).toLocaleString()}</td>
                <td className="px-2 py-1.5 text-right">{totals.classed}</td>
                <td className="px-2 py-1.5 text-right">{(() => { const a = avgLoan(totals.loanValue, totals.loanLbs); return a != null ? `$${(a / 100).toFixed(4)}` : '—' })()}</td>
                <td className="px-2 py-1.5 text-xs" colSpan={4}>{colorDist(totals.colors)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
