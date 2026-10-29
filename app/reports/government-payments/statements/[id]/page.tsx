'use client'

// One FSA Payment Statement on its own page (0099): the header, the four
// checks recomputed from what was saved, the lines by farm and program with
// their crop amounts and the implied rate behind each ARC/PLC crop amount
// (against the farm's base data), the PDF, and Delete (owner only — the
// lines, crop amounts and any other-payment rows it produced go with it).

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { reportError } from '@/lib/friendly-error'
import { fmtDate } from '@/lib/format-date'
import { ConfirmDialog } from '@/components/app-dialog'
import PdfViewer from '@/components/pdf-viewer'
import { ReportHeader, EmptyState, theadCls, fmtUsd, fmtInt, fmtPct } from '@/components/reports/report-kit'
import { useViewerScope } from '@/lib/use-viewer-scope'
import { PROGRAM_CODE_LABEL } from '@/lib/fsa-payment-statement'
import { impliedRate } from '@/lib/fsa-actuals'
import { resolveProgramYearConfig } from '@/lib/program-config'
import type { CoveredCommodity, Entity, Farm, FarmBaseAcres, FsaPaymentCropAmount, FsaPaymentLine, FsaPaymentStatement, ProgramYearConfig } from '@/lib/types'

export default function FsaStatementDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const viewer = useViewerScope(supabase)
  const [statement, setStatement] = useState<FsaPaymentStatement | null>(null)
  const [missing, setMissing] = useState(false)
  const [lines, setLines] = useState<FsaPaymentLine[]>([])
  const [crops, setCrops] = useState<FsaPaymentCropAmount[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [commodities, setCommodities] = useState<CoveredCommodity[]>([])
  const [baseAcres, setBaseAcres] = useState<FarmBaseAcres[]>([])
  const [configs, setConfigs] = useState<ProgramYearConfig[]>([])
  const [askDelete, setAskDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [st, ln, fa, en, cc, ba, pc] = await Promise.all([
        supabase.from('fsa_payment_statements').select('*').eq('id', id).maybeSingle(),
        fetchAllRows((f, t) => supabase.from('fsa_payment_lines').select('*').eq('statement_id', id).order('page_number').order('id').range(f, t)),
        supabase.from('farms').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('covered_commodities').select('*').order('name'),
        supabase.from('farm_base_acres').select('*'),
        supabase.from('program_year_config').select('*'),
      ])
      if (cancelled) return
      const s = (st.data as FsaPaymentStatement | null) ?? null
      setStatement(s); setMissing(!s)
      const ls = (ln.data as FsaPaymentLine[]) ?? []
      setLines(ls)
      setFarms((fa.data as Farm[]) ?? []); setEntities((en.data as Entity[]) ?? []); setCommodities((cc.data as CoveredCommodity[]) ?? [])
      setBaseAcres((ba.data as FarmBaseAcres[]) ?? []); setConfigs((pc.data as ProgramYearConfig[]) ?? [])
      if (ls.length > 0) {
        const cr = await fetchAllRows((f, t) => supabase.from('fsa_payment_crop_amounts').select('*').in('line_id', ls.map((l) => l.id)).order('id').range(f, t))
        if (!cancelled) setCrops((cr.data as FsaPaymentCropAmount[]) ?? [])
      }
    })()
    return () => { cancelled = true }
  }, [supabase, id])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const commodityById = useMemo(() => new Map(commodities.map((c) => [c.id, c])), [commodities])
  const cropsByLine = useMemo(() => {
    const m = new Map<string, FsaPaymentCropAmount[]>()
    for (const c of crops) { const g = m.get(c.line_id) ?? []; g.push(c); m.set(c.line_id, g) }
    return m
  }, [crops])

  const checks = useMemo(() => {
    if (!statement) return []
    const eq = (a: number, b: number) => Math.abs(a - b) < 0.005
    const cropBad = lines.filter((l) => { const rows = cropsByLine.get(l.id) ?? []; if (rows.length === 0) return false; return !eq(rows.reduce((s, c) => s + Number(c.amount), 0), Number(l.gross_payment)) })
    const netBad = lines.filter((l) => !eq(Number(l.gross_payment) - Number(l.deductions), Number(l.net_payment)))
    const sum = lines.reduce((s, l) => s + Number(l.net_payment), 0)
    return [
      { label: 'Crop amounts add up to each block’s gross', ok: cropBad.length === 0, detail: cropBad.length ? cropBad.map((l) => `farm ${l.fsa_farm_number ?? '?'}`).join(', ') : `${lines.length} lines` },
      { label: 'Gross minus deductions equals net', ok: netBad.length === 0, detail: netBad.length ? netBad.map((l) => `farm ${l.fsa_farm_number ?? '?'}`).join(', ') : `${lines.length} lines` },
      { label: 'Lines add up to the statement net', ok: eq(sum, Number(statement.net_payment)), detail: `${fmtUsd(sum, 2)} vs ${fmtUsd(Number(statement.net_payment), 2)}` },
    ]
  }, [statement, lines, cropsByLine])

  // Lines grouped by farm, in page order.
  const groups = useMemo(() => {
    const m = new Map<string, FsaPaymentLine[]>()
    for (const l of lines) { const k = l.farm_id ?? `#${l.fsa_farm_number ?? '?'}`; const g = m.get(k) ?? []; g.push(l); m.set(k, g) }
    return [...m.entries()]
  }, [lines])

  const implied = (l: FsaPaymentLine, c: FsaPaymentCropAmount) => {
    if (l.program_code === 'OTHER' || !l.farm_id || !c.commodity_id) return null
    const b = baseAcres.find((x) => x.farm_id === l.farm_id && x.commodity_id === c.commodity_id && !x.is_unassigned)
    if (!b) return null
    const cfg = resolveProgramYearConfig(l.program_year ?? new Date().getFullYear(), configs)
    return impliedRate({ program: l.program_code, actual: Number(c.amount), baseAcres: Number(b.base_acres), plcYield: Number(b.plc_yield), sequesterPct: l.sequester_pct != null ? Number(l.sequester_pct) : cfg.sequestrationPct, paymentFactor: cfg.paymentFactor })
  }

  async function remove() {
    setDeleting(true); setErr(null)
    const { error } = await supabase.from('fsa_payment_statements').delete().eq('id', id)
    setDeleting(false)
    if (error) { setErr(reportError(error, { action: 'delete the statement', noun: 'statement' })); setAskDelete(false); return }
    router.push('/reports/government-payments')
  }

  if (missing) return <EmptyState message="That statement is not on file (it may have been deleted)." linkHref="/reports/government-payments" linkLabel="Back to the Payment Tracker" role={viewer.role} />
  if (!statement) return <p className="text-slate-500">Loading…</p>

  const payee = statement.payee_entity_id ? entityById.get(statement.payee_entity_id)?.name ?? statement.payee_name : statement.payee_name
  const years = [...new Set(lines.map((l) => l.program_year).filter((y): y is number => y != null))].sort()
  const canEdit = viewer.role === 'owner'

  return (
    <div className="space-y-4 print-area">
      <nav className="text-sm text-slate-500 no-print"><Link href="/reports/government-payments" className="underline">Government Payment Tracker</Link> › FSA statement {fmtDate(statement.statement_date)}</nav>
      <ReportHeader
        title={`FSA Payment Statement — ${fmtDate(statement.statement_date)}`}
        filterSummary={`${payee} · ${statement.office_name ?? 'FSA office'}${years.length ? ` · program year${years.length === 1 ? '' : 's'} ${years.join(', ')}` : ''}`}
        actions={canEdit ? <button type="button" onClick={() => setAskDelete(true)} className="rounded-lg bg-white border border-red-300 text-red-700 px-3 min-h-11 text-sm font-semibold">Delete statement</button> : undefined}
      />
      {err && <p className="text-sm text-red-600">{err}</p>}

      <section className="bg-white rounded-xl shadow p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div><div className="text-xs text-slate-500">Gross payment</div><div className="text-xl font-bold tabular-nums">{fmtUsd(Number(statement.gross_payment), 2)}</div></div>
        <div><div className="text-xs text-slate-500">Deductions</div><div className="text-xl font-bold tabular-nums">{fmtUsd(Number(statement.deductions), 2)}</div></div>
        <div><div className="text-xs text-slate-500">Net payment</div><div className="text-xl font-bold tabular-nums text-green-700">{fmtUsd(Number(statement.net_payment), 2)}</div></div>
        <div><div className="text-xs text-slate-500">Lines · pages</div><div className="text-xl font-bold tabular-nums">{lines.length} · {statement.page_count ?? '—'}</div></div>
        <div className="col-span-2 sm:col-span-4 text-xs text-slate-500">
          {statement.office_name}{statement.office_address ? ` · ${statement.office_address}` : ''}{statement.office_phone ? ` · ${statement.office_phone}` : ''} — payee {statement.payee_name}{statement.payee_address ? `, ${statement.payee_address}` : ''}
        </div>
        <ul className="col-span-2 sm:col-span-4 flex flex-wrap gap-2 text-xs">
          {checks.map((c) => <li key={c.label} className={`rounded-full px-2 py-1 ${c.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{c.ok ? '✓' : '✗'} {c.label} <span className="opacity-75">· {c.detail}</span></li>)}
        </ul>
      </section>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-bold text-lg">Payments by farm</h2>
        {groups.map(([key, rows]) => {
          const farm = rows[0].farm_id ? farmById.get(rows[0].farm_id) : null
          return (
            <div key={key} className="rounded-lg border border-slate-200 p-3">
              <div className="font-semibold mb-1">
                {farm ? <Link href={`/settings/farms`} className="underline decoration-slate-300">{farm.name}</Link> : <span className="text-amber-700">FSA farm {rows[0].fsa_farm_number ?? '?'} — not in Turnrow</span>}
                {farm && <span className="ml-2 text-xs font-normal text-slate-500">FSA {rows[0].fsa_farm_number ?? farm.fsa_number ?? ''}</span>}
              </div>
              <table className="min-w-full text-sm">
                <thead className={theadCls}><tr><th className="text-left px-2 py-1">Program</th><th className="text-left px-2 py-1">Crops</th><th className="text-right px-2 py-1">Gross</th><th className="text-right px-2 py-1">Net</th><th className="text-left px-2 py-1">Paid</th><th className="text-left px-2 py-1">Implied rate</th></tr></thead>
                <tbody>
                  {rows.map((l) => {
                    const cs = cropsByLine.get(l.id) ?? []
                    return (
                      <tr key={l.id} className="border-t border-slate-100 align-top">
                        <td className="px-2 py-1 whitespace-nowrap">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${l.program_code === 'PLC' ? 'bg-sky-100 text-sky-800' : l.program_code === 'OTHER' ? 'bg-slate-100 text-slate-700' : 'bg-violet-100 text-violet-800'}`}>{PROGRAM_CODE_LABEL[l.program_code]}</span>
                          <div className="text-xs text-slate-500">{l.program_name_raw}</div>
                          <div className="text-xs text-slate-500">program year {l.program_year ?? '—'} · ID {l.fsa_payment_id}{l.transaction_control_number ? ` · TCN ${l.transaction_control_number}` : ''}{l.page_number ? ` · p.${l.page_number}` : ''}</div>
                        </td>
                        <td className="px-2 py-1">
                          {cs.length === 0 && <span className="text-slate-400">—</span>}
                          {cs.map((c) => <div key={c.id} className="whitespace-nowrap">{c.commodity_id ? commodityById.get(c.commodity_id)?.name ?? c.raw_crop : <span className="text-amber-700">{c.raw_crop}</span>} <b className="tabular-nums">{fmtUsd(Number(c.amount), 2)}</b></div>)}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(Number(l.gross_payment), 2)}{Number(l.deductions) !== 0 && <div className="text-xs text-slate-500">− {fmtUsd(Number(l.deductions), 2)}</div>}</td>
                        <td className="px-2 py-1 text-right tabular-nums font-semibold">{fmtUsd(Number(l.net_payment), 2)}</td>
                        <td className="px-2 py-1 text-xs text-slate-600 whitespace-nowrap">
                          {l.payment_date ? `${l.payment_method ?? ''} ${fmtDate(l.payment_date)}` : '—'}
                          {l.bank_name && <div>{l.bank_name}{l.account_last4 ? ` …${l.account_last4}` : ''}</div>}
                          {l.sequester_pct != null && <div>sequester {fmtPct(Number(l.sequester_pct) * 100, 1)}</div>}
                        </td>
                        <td className="px-2 py-1 text-xs text-slate-600">
                          {cs.map((c) => {
                            const r = implied(l, c)
                            if (!r) return <div key={c.id} className="text-slate-400">{l.program_code === 'OTHER' ? '—' : 'no base data'}</div>
                            const unit = c.commodity_id && commodityById.get(c.commodity_id)?.unit === 'pound' ? 'lb' : 'bu'
                            return <div key={c.id} className="whitespace-nowrap">{r.program === 'PLC' ? `$${r.implied.toFixed(4)}/${unit}` : `$${r.implied.toFixed(2)}/base ac`} <span className="text-slate-400">÷ {fmtInt(r.denominator)}</span></div>
                          })}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        })}
        {lines.length === 0 && <p className="text-sm text-slate-500">No lines on this statement.</p>}
      </section>

      {statement.document_url && (
        <section className="bg-white rounded-xl shadow p-4 no-print">
          <h2 className="font-bold text-lg mb-2">The statement</h2>
          <PdfViewer url={statement.document_url} className="h-[36rem] w-full" title="FSA payment statement" />
        </section>
      )}

      <ConfirmDialog
        open={askDelete}
        title="Delete this statement?"
        body={<p>Its {lines.length} payment line{lines.length === 1 ? '' : 's'}, crop amounts and any other-USDA entries it created are removed too. The reports go back to the projections for these farms.</p>}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setAskDelete(false)}
      />
    </div>
  )
}
