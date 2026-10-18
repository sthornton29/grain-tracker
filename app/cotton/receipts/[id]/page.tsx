'use client'

// One gin receipt (Statement of Ginning) on its own page — the cotton load
// page's twin: the statement's identity, its totals and the gin's Farm YTD,
// the loads it ginned (each a link to its own page, removable from the
// statement), the bale list with any classing, and the field's yield.
// Edit the header in place, delete the whole receipt (its bales and load
// links go with it; the loads themselves stay), export / print.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import ExportBar from '@/components/export-bar'
import { ConfirmDialog } from '@/components/app-dialog'
import { fmtInt, fmtPct } from '@/components/reports/report-kit'
import { CottonPageHeader, YieldFigure } from '@/components/cotton/cotton-page-header'
import { useCottonFieldYields } from '@/lib/use-cotton-field-yields'
import { perAcre } from '@/lib/cotton-field-yields'
import { lintTurnoutPct } from '@/lib/cotton'
import { isSynthesizedReceiptNumber, receiptDisplayName, synthesizeReceiptNumber } from '@/lib/gin-statements'
import { updateReceipt } from '@/lib/gin-receipt-writes'
import { reportError } from '@/lib/friendly-error'
import { fmtDate } from '@/lib/format-date'
import { plural } from '@/components/use-dialogs'
import type { ExportPayload, ExportSection } from '@/lib/exports'
import type { CottonLoad, Entity, Farm, Field, Gin, GinReceipt } from '@/lib/types'
import { keptWithoutPlanting, scopeToPlanted } from '@/lib/planted-scope'

type BaleGrade = { class_date: string | null; color_grade: string | null; leaf_grade: string | null; staple_32nds: number | null; micronaire: number | null; strength_g_tex: number | null; composite_grade: string | null }
type Bale = { id: string; pbi_number: string; net_weight_lbs: number; grade: BaleGrade | null }
type LoadLink = { id: string; load: CottonLoad }

type Draft = {
  receipt_date: string; statement_number: string; gin_id: string; entity_id: string; farm_id: string; field_id: string
  modules: string; seed_cotton: string; bales: string; lint: string; seed_lbs: string; turnout: string; lint_per_bale: string; notes: string
}

const lbs = (n: number | null | undefined) => (n == null ? '—' : fmtInt(Number(n)))
const num = (s: string): number | null => { if (s.trim() === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null }

export default function GinReceiptDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [receipt, setReceipt] = useState<GinReceipt | null>(null)
  const [missing, setMissing] = useState(false)
  const [bales, setBales] = useState<Bale[]>([])
  const [loadLinks, setLoadLinks] = useState<LoadLink[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [gins, setGins] = useState<Gin[]>([])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [askDelete, setAskDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [askUnlink, setAskUnlink] = useState<LoadLink | null>(null)
  const [showAllBales, setShowAllBales] = useState(false)
  const fieldYields = useCottonFieldYields(supabase, receipt?.crop_year ?? new Date().getFullYear())

  async function refresh() {
    const [r, b, lk, f, fl, en, g] = await Promise.all([
      supabase.from('gin_receipts').select('*').eq('id', id).maybeSingle(),
      fetchAllRows((a, z) => supabase.from('cotton_bales').select('id, pbi_number, net_weight_lbs, grade:cotton_bale_grades(class_date, color_grade, leaf_grade, staple_32nds, micronaire, strength_g_tex, composite_grade)').eq('gin_receipt_id', id).order('pbi_number').order('id').range(a, z)),
      supabase.from('gin_receipt_loads').select('id, load:cotton_loads(*)').eq('receipt_id', id),
      supabase.from('farms').select('*').order('name'),
      fetchAllRows((a, z) => supabase.from('fields').select('*').order('name_or_number').order('id').range(a, z)),
      supabase.from('entities').select('*').order('name'),
      supabase.from('gins').select('*').order('name'),
    ])
    if (!r.data) { setMissing(true); return }
    setReceipt(r.data as GinReceipt)
    setBales((((b.data as unknown) as Array<{ id: string; pbi_number: string; net_weight_lbs: number; grade: BaleGrade | BaleGrade[] | null }>) ?? []).map((x) => ({
      id: x.id, pbi_number: x.pbi_number, net_weight_lbs: Number(x.net_weight_lbs), grade: Array.isArray(x.grade) ? x.grade[0] ?? null : x.grade,
    })))
    setLoadLinks((((lk.data as unknown) as Array<{ id: string; load: CottonLoad | CottonLoad[] | null }>) ?? [])
      .map((x) => ({ id: x.id, load: Array.isArray(x.load) ? x.load[0] : x.load }))
      .filter((x): x is LoadLink => x.load != null)
      .sort((a, b) => a.load.load_number.localeCompare(b.load.load_number, undefined, { numeric: true })))
    setFarms((f.data as Farm[]) ?? [])
    setFields((fl.data as Field[]) ?? [])
    setEntities((en.data as Entity[]) ?? [])
    setGins((g.data as Gin[]) ?? [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [id])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const ginById = useMemo(() => new Map(gins.map((g) => [g.id, g])), [gins])
  // The pickers offer the farms and fields with a cotton planting in the
  // receipt's crop year; what the receipt already has stays selectable.
  const scope = useMemo(
    () => scopeToPlanted({ fields, farms, plantedFieldIds: fieldYields.plantedFieldIds, keep: { fieldId: receipt?.field_id, farmId: receipt?.farm_id } }),
    [fields, farms, fieldYields.plantedFieldIds, receipt?.field_id, receipt?.farm_id],
  )

  if (missing) {
    return (
      <div className="bg-white rounded-xl shadow p-8 text-center space-y-3">
        <p className="text-slate-600 font-medium">That gin receipt isn&rsquo;t here — it may have been deleted.</p>
        <Link href="/cotton/receipts" className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm font-semibold text-brand-deep">Back to gin receipts</Link>
      </div>
    )
  }
  if (!receipt) return <p className="text-slate-500">Loading…</p>

  const r = receipt
  const gin = r.gin_id ? ginById.get(r.gin_id) : null
  const farm = r.farm_id ? farmById.get(r.farm_id) : null
  const field = r.field_id ? fieldById.get(r.field_id) : null
  const entity = r.entity_id ? entityById.get(r.entity_id) : null
  const ginCode = r.gin_code ?? gin?.gin_code ?? null
  const statementNumber = r.statement_number?.trim() || (isSynthesizedReceiptNumber(r.receipt_number) ? null : r.receipt_number)
  const title = receiptDisplayName({
    gin_name: gin?.name ?? null, gin_code: ginCode, receipt_date: r.receipt_date,
    farm_label: farm?.name ?? r.printed_farm_number ?? null, field_label: field?.name_or_number ?? r.printed_field ?? null,
    statement_number: r.statement_number, receipt_number: r.receipt_number,
  })
  const turnout = r.lint_turnout_pct != null ? Number(r.lint_turnout_pct) : (r.total_bale_weight != null && r.total_seed_cotton_weight != null ? lintTurnoutPct(Number(r.total_bale_weight), Number(r.total_seed_cotton_weight)) : null)
  const baleLint = bales.reduce((s, b) => s + b.net_weight_lbs, 0)
  const graded = bales.filter((b) => b.grade).length
  const loadNet = loadLinks.reduce((s, l) => s + Number(l.load.net_weight ?? 0), 0)
  const acres = fieldYields.acresFor(r.field_id)
  const fieldYield = fieldYields.yieldFor(r.field_id)
  const hasYtd = r.farm_ytd_modules != null || r.farm_ytd_seed_cotton_lbs != null || r.farm_ytd_bales != null || r.farm_ytd_bale_weight != null
  const sub = [`${r.crop_year} crop`, entity?.name, statementNumber ? `statement #${statementNumber}` : 'no statement number printed', r.source === 'document_import' ? 'from an upload' : 'entered by hand'].filter(Boolean).join(' · ')

  function startEdit() {
    if (!receipt) return
    const x = receipt
    setDraft({
      receipt_date: x.receipt_date ?? '', statement_number: x.statement_number ?? '', gin_id: x.gin_id ?? '', entity_id: x.entity_id ?? '',
      farm_id: x.farm_id ?? '', field_id: x.field_id ?? '',
      modules: x.modules_count != null ? String(x.modules_count) : '', seed_cotton: x.total_seed_cotton_weight != null ? String(Number(x.total_seed_cotton_weight)) : '',
      bales: x.bales_count != null ? String(x.bales_count) : '', lint: x.total_bale_weight != null ? String(Number(x.total_bale_weight)) : '',
      seed_lbs: x.seed_lbs != null ? String(Number(x.seed_lbs)) : '', turnout: x.lint_turnout_pct != null ? String(Number(x.lint_turnout_pct)) : '',
      lint_per_bale: x.lint_lbs_per_bale != null ? String(Number(x.lint_lbs_per_bale)) : '', notes: x.notes ?? '',
    })
    setErr(null); setEditing(true)
  }

  async function save() {
    if (!draft || !receipt) return
    setErr(null)
    const lint = num(draft.lint)
    const seedCotton = num(draft.seed_cotton)
    const balesCount = num(draft.bales)
    const modules = num(draft.modules)
    const ginSel = draft.gin_id ? ginById.get(draft.gin_id) : null
    const farmSel = draft.farm_id ? farmById.get(draft.farm_id) : null
    const fieldSel = draft.field_id ? fieldById.get(draft.field_id) : null
    const statement_number = draft.statement_number.trim() || null
    if (!statement_number && !draft.receipt_date) { setErr('Enter the statement number the gin printed, or at least its date.'); return }
    // The identity the statement is told apart by (lib/gin-statements): a
    // synthesized receipt number follows the header; a printed one is kept.
    const identity = {
      gin_code: receipt.gin_code ?? ginSel?.gin_code ?? null, statement_number,
      farm_number: receipt.printed_farm_number ?? farmSel?.fsa_number ?? null, field: receipt.printed_field ?? fieldSel?.name_or_number ?? null,
      receipt_date: draft.receipt_date || null, modules_count: modules, total_seed_cotton_weight: seedCotton, bales_count: balesCount,
    }
    const receipt_number = statement_number ?? (isSynthesizedReceiptNumber(receipt.receipt_number) ? synthesizeReceiptNumber(identity) : receipt.receipt_number)
    setSaving(true)
    const { error } = await updateReceipt(supabase, receipt.id, {
      receipt_number, receipt_date: draft.receipt_date || null, statement_number,
      gin_id: draft.gin_id || null, gin_code: receipt.gin_code ?? ginSel?.gin_code ?? null,
      entity_id: draft.entity_id || farmSel?.entity_id || null,
      farm_id: draft.farm_id || null, field_id: draft.field_id || null,
      modules_count: modules, total_seed_cotton_weight: seedCotton, bales_count: balesCount, total_bale_weight: lint, seed_lbs: num(draft.seed_lbs),
      lint_turnout_pct: num(draft.turnout) ?? (lint != null && seedCotton != null ? lintTurnoutPct(lint, seedCotton) : null),
      avg_bale_weight: lint != null && balesCount ? Math.round((lint / balesCount) * 100) / 100 : null,
      lint_lbs_per_bale: num(draft.lint_per_bale), notes: draft.notes.trim() || null,
    })
    setSaving(false)
    if (error) { setErr(reportError(error, { action: 'save this gin receipt', noun: 'gin receipt', name: statementNumber ?? undefined })); return }
    setEditing(false); setDraft(null)
    refresh(); fieldYields.refresh()
  }

  async function doDelete() {
    if (!receipt) return
    setDeleting(true)
    const { error } = await supabase.from('gin_receipts').delete().eq('id', receipt.id)
    if (error) { setDeleting(false); setAskDelete(false); setErr(reportError(error, { action: 'delete this gin receipt', noun: 'gin receipt' })); return }
    router.push('/cotton/receipts')
  }

  async function doUnlink(link: LoadLink) {
    const { error } = await supabase.from('gin_receipt_loads').delete().eq('id', link.id)
    setAskUnlink(null)
    if (error) { setErr(reportError(error, { action: 'take this load off the statement', noun: 'load', name: link.load.load_number })); return }
    refresh(); fieldYields.refresh()
  }

  const KV: ExportSection['columns'] = [{ label: 'Field' }, { label: 'Value', align: 'right' }]
  const payload: ExportPayload = {
    title: `Gin Receipt — ${title}`,
    filters: sub,
    filename: `gin-receipt-${(r.receipt_date ?? 'undated').replace(/-/g, '')}-${(field?.name_or_number ?? r.printed_field ?? 'statement').replace(/[^A-Za-z0-9]+/g, '-')}`,
    singleSheet: true,
    sections: [
      { title: 'Statement', columns: KV, rows: [
        ['Gin', gin?.name ?? (ginCode ? `Gin ${ginCode}` : '—')], ['Gin code', ginCode ?? '—'], ['Statement #', statementNumber ?? 'none printed'], ['Date', r.receipt_date ? fmtDate(r.receipt_date) : '—'],
        ['Crop year', String(r.crop_year)], ['Entity', entity?.name ?? '—'], ['Farm', farm?.name ?? '—'], ['Field', field?.name_or_number ?? '—'],
        ['Printed farm #', r.printed_farm_number ?? '—'], ['Printed field', r.printed_field ?? '—'],
      ] },
      { title: 'Totals', columns: KV, rows: [
        ['Modules', r.modules_count != null ? fmtInt(r.modules_count) : '—'], ['Seed cotton (lbs)', lbs(r.total_seed_cotton_weight)], ['Bales', r.bales_count != null ? fmtInt(r.bales_count) : '—'],
        ['Lint (lbs)', lbs(r.total_bale_weight)], ['Avg bale (lbs)', lbs(r.avg_bale_weight)], ['Cottonseed (lbs)', lbs(r.seed_lbs)],
        ['Turnout', turnout != null ? fmtPct(turnout, 2) : '—'], ['Seed cotton per 500-lb bale', lbs(r.lint_lbs_per_bale)],
      ] },
      ...(hasYtd ? [{ title: 'Farm year to date (as printed)', columns: KV, rows: [
        ['Modules', r.farm_ytd_modules != null ? fmtInt(r.farm_ytd_modules) : '—'], ['Seed cotton (lbs)', lbs(r.farm_ytd_seed_cotton_lbs)], ['Bales', r.farm_ytd_bales != null ? fmtInt(r.farm_ytd_bales) : '—'], ['Lint (lbs)', lbs(r.farm_ytd_bale_weight)],
      ] } as ExportSection] : []),
      { title: 'Loads on this statement', columns: [{ label: 'Load #' }, { label: 'Field' }, { label: 'Rolls', align: 'right' }, { label: 'Net lbs', align: 'right' }],
        rows: loadLinks.map((l) => [l.load.load_number, l.load.field_id ? fieldById.get(l.load.field_id)?.name_or_number ?? '—' : '—', l.load.rolls != null ? fmtInt(l.load.rolls) : '—', lbs(l.load.net_weight)]) },
      { title: 'Bales', columns: [{ label: 'PBI' }, { label: 'Net lbs', align: 'right' }, { label: 'Grade' }, { label: 'Mic', align: 'right' }, { label: 'Staple', align: 'right' }, { label: 'Strength', align: 'right' }],
        rows: bales.map((b) => [b.pbi_number, fmtInt(b.net_weight_lbs), b.grade?.composite_grade ?? '', b.grade?.micronaire != null ? String(b.grade.micronaire) : '', b.grade?.staple_32nds != null ? String(b.grade.staple_32nds) : '', b.grade?.strength_g_tex != null ? String(b.grade.strength_g_tex) : '']) },
      ...(r.notes ? [{ title: 'Notes', columns: KV, rows: [['Notes', r.notes]] } as ExportSection] : []),
    ],
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full mt-1'
  const labelCls = 'block text-sm text-slate-700'
  const draftFields = scope.fields.filter((f) => !draft?.farm_id || f.farm_id === draft.farm_id)
  const BALES_SHOWN = 60
  const shownBales = showAllBales ? bales : bales.slice(0, BALES_SHOWN)

  return (
    <div className="space-y-4">
      <CottonPageHeader
        eyebrow="Cotton · Gin receipt"
        title={title}
        sub={sub}
        actions={(
          <>
            <Link href="/cotton/receipts" className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm">Back</Link>
            {!editing && <button type="button" onClick={startEdit} className="rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm font-semibold text-brand-deep">Edit</button>}
            <button type="button" onClick={() => setAskDelete(true)} className="rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm font-semibold text-red-600">Delete</button>
            <ExportBar buildPayload={() => payload} />
          </>
        )}
      />

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatCard label="Bales" value={bales.length > 0 ? fmtInt(bales.length) : r.bales_count != null ? fmtInt(r.bales_count) : '—'} sub={bales.length > 0 ? `${graded ? `${fmtInt(graded)} classed` : 'none classed yet'}` : 'from the statement'} />
        <StatCard label="Lint" value={`${lbs(r.total_bale_weight)} lbs`} sub={bales.length > 0 && Math.abs(baleLint - Number(r.total_bale_weight ?? 0)) > 0.5 ? `bale list adds to ${fmtInt(baleLint)}` : undefined} />
        <StatCard label="Seed cotton" value={`${lbs(r.total_seed_cotton_weight)} lbs`} sub={r.modules_count != null ? `${fmtInt(r.modules_count)} module${r.modules_count === 1 ? '' : 's'}` : undefined} />
        <StatCard label="Turnout" value={turnout != null ? fmtPct(turnout, 2) : '—'} sub={r.lint_lbs_per_bale != null ? `${fmtInt(Number(r.lint_lbs_per_bale))} lbs seed cotton per 500-lb bale` : undefined} />
        <StatCard label={`${field?.name_or_number ?? 'Field'} yield`}>
          {!r.field_id ? <span className="text-sm font-normal text-amber-700">no field on the receipt — tap Edit and pick one</span>
            : !fieldYield || !acres ? <span className="text-sm font-normal text-slate-400">no cotton planting on file</span>
            : (
              <div className="space-y-0.5">
                <div><YieldFigure perAcre={fieldYield.lintPerAcre} basis={fieldYield.lintBasis} turnoutLabel={fieldYield.turnout.label} unit="lbs lint/ac" size="lg" /></div>
                <div className="text-xs font-normal text-slate-500">
                  this statement <YieldFigure perAcre={perAcre(r.total_bale_weight, acres)} unit="lbs lint/ac" /> · {fmtInt(acres)} ac
                  {fieldYield.receiptCount > 1 ? ` · ${fmtInt(fieldYield.receiptCount)} statements` : ''}
                </div>
              </div>
            )}
        </StatCard>
      </div>

      {err && <p className="text-sm text-red-700" role="alert">{err}</p>}

      {editing && draft ? (
        <form onSubmit={(e) => { e.preventDefault(); void save() }} className="bg-white rounded-xl shadow p-4 space-y-3 no-print">
          <h2 className="font-semibold">Edit gin receipt</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <label className={labelCls}>Statement date<input type="date" value={draft.receipt_date} onChange={(e) => setDraft({ ...draft, receipt_date: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Statement # <span className="text-slate-400">(if printed)</span><input value={draft.statement_number} onChange={(e) => setDraft({ ...draft, statement_number: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Gin
              <select value={draft.gin_id} onChange={(e) => setDraft({ ...draft, gin_id: e.target.value })} className={inputCls}>
                <option value="">—</option>
                {gins.map((g) => <option key={g.id} value={g.id}>{g.name}{g.gin_code ? ` (${g.gin_code})` : ''}</option>)}
              </select>
            </label>
            {entities.length > 1 && (
              <label className={labelCls}>Entity
                <select value={draft.entity_id} onChange={(e) => setDraft({ ...draft, entity_id: e.target.value })} className={inputCls}>
                  <option value="">— from the farm —</option>
                  {entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
            )}
            <label className={labelCls}>Farm
              <select value={draft.farm_id} onChange={(e) => setDraft({ ...draft, farm_id: e.target.value, field_id: '' })} className={inputCls}>
                <option value="">—</option>
                {scope.farms.map((f) => <option key={f.id} value={f.id}>{f.name}{f.fsa_number ? ` (#${f.fsa_number})` : ''}</option>)}
              </select>
            </label>
            <label className={labelCls}>Field
              <select value={draft.field_id} onChange={(e) => setDraft({ ...draft, field_id: e.target.value })} className={inputCls}>
                <option value="">—</option>
                {draftFields.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
              </select>
              {r.printed_field && !draft.field_id && <span className="block mt-1 text-xs text-amber-700">The statement printed “{r.printed_field}”{r.printed_farm_number ? ` on farm #${r.printed_farm_number}` : ''}. Pick the field it means — the field’s yield counts this statement once it has one.</span>}
              {keptWithoutPlanting(draft.field_id, fieldYields.plantedFieldIds) && (
                <span className="block mt-1 text-xs text-amber-700">This field has no cotton planting on file for {r.crop_year}. It stays on the receipt; the other choices are the fields planted to cotton that year.</span>
              )}
            </label>
            <label className={labelCls}>Modules<input type="number" inputMode="numeric" step="1" value={draft.modules} onChange={(e) => setDraft({ ...draft, modules: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Seed cotton lbs<input type="number" inputMode="numeric" step="1" value={draft.seed_cotton} onChange={(e) => setDraft({ ...draft, seed_cotton: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Bales<input type="number" inputMode="numeric" step="1" value={draft.bales} onChange={(e) => setDraft({ ...draft, bales: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Lint lbs<input type="number" inputMode="numeric" step="1" value={draft.lint} onChange={(e) => setDraft({ ...draft, lint: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Cottonseed lbs<input type="number" inputMode="numeric" step="1" value={draft.seed_lbs} onChange={(e) => setDraft({ ...draft, seed_lbs: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Turnout % <span className="text-slate-400">(blank = lint ÷ seed cotton)</span><input type="number" inputMode="decimal" step="0.01" value={draft.turnout} onChange={(e) => setDraft({ ...draft, turnout: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Seed cotton lbs per 500-lb bale<input type="number" inputMode="numeric" step="1" value={draft.lint_per_bale} onChange={(e) => setDraft({ ...draft, lint_per_bale: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Notes<input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className={inputCls} /></label>
          </div>
          {num(draft.lint) != null && num(draft.seed_cotton) != null && num(draft.seed_cotton)! > 0 && (
            <p className="text-sm text-slate-500">Turnout from these figures: <b>{fmtPct(lintTurnoutPct(num(draft.lint)!, num(draft.seed_cotton)!), 2)}</b>{num(draft.bales) ? <> · <b>{fmtInt(num(draft.lint)! / num(draft.bales)!)}</b> lbs lint per bale</> : null}</p>
          )}
          <p className="text-xs text-slate-500">The bales and the loads on this statement are listed below; they are not changed here.</p>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={() => { setEditing(false); setDraft(null); setErr(null) }} className="rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm">Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <Section title="Statement">
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 px-4 py-3">
              <Def label="Gin" value={gin?.name ?? (ginCode ? `Gin ${ginCode}` : '—')} sub={gin && ginCode ? `code ${ginCode}` : undefined} />
              <Def label="Date" value={r.receipt_date ? fmtDate(r.receipt_date) : '—'} />
              <Def label="Statement #" value={statementNumber ?? '—'} sub={statementNumber ? undefined : 'none printed'} />
              <Def label="Crop year" value={String(r.crop_year)} />
              <Def label="Entity" value={entity?.name ?? '—'} />
              <Def label="Farm" value={farm?.name ?? '—'} sub={r.printed_farm_number ? `printed #${r.printed_farm_number}` : undefined} />
              <Def label="Field" value={field?.name_or_number ?? '—'} sub={r.printed_field ? `printed ${r.printed_field}` : undefined} />
              <Def label="Entered" value={r.source === 'document_import' ? 'from an upload' : 'by hand'} sub={fmtDate(r.created_at.slice(0, 10))} />
            </dl>
          </Section>

          <Section title="Totals">
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 px-4 py-3">
              <Def label="Modules" value={r.modules_count != null ? fmtInt(r.modules_count) : '—'} sub={loadLinks.length > 0 && r.modules_count != null && loadLinks.length !== r.modules_count ? `${fmtInt(loadLinks.length)} loads linked` : undefined} />
              <Def label="Seed cotton (lbs)" value={lbs(r.total_seed_cotton_weight)} sub={loadLinks.length > 0 && Math.abs(loadNet - Number(r.total_seed_cotton_weight ?? 0)) > 20 ? `linked loads weigh ${fmtInt(loadNet)}` : undefined} />
              <Def label="Bales" value={r.bales_count != null ? fmtInt(r.bales_count) : '—'} sub={bales.length > 0 && r.bales_count != null && bales.length !== r.bales_count ? `${fmtInt(bales.length)} on file` : undefined} />
              <Def label="Lint (lbs)" value={lbs(r.total_bale_weight)} />
              <Def label="Avg bale (lbs)" value={lbs(r.avg_bale_weight)} />
              <Def label="Cottonseed (lbs)" value={lbs(r.seed_lbs)} />
              <Def label="Turnout" value={turnout != null ? fmtPct(turnout, 2) : '—'} />
              <Def label="Seed cotton per 500-lb bale" value={lbs(r.lint_lbs_per_bale)} />
            </dl>
          </Section>

          {hasYtd && (
            <Section title="Farm year to date, as the gin printed it">
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 px-4 py-3">
                <Def label="Modules" value={r.farm_ytd_modules != null ? fmtInt(r.farm_ytd_modules) : '—'} />
                <Def label="Seed cotton (lbs)" value={lbs(r.farm_ytd_seed_cotton_lbs)} />
                <Def label="Bales" value={r.farm_ytd_bales != null ? fmtInt(r.farm_ytd_bales) : '—'} />
                <Def label="Lint (lbs)" value={lbs(r.farm_ytd_bale_weight)} />
              </dl>
            </Section>
          )}

          <Section title={`Loads on this statement${loadLinks.length ? ` (${fmtInt(loadLinks.length)})` : ''}`}>
            {loadLinks.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">No seed cotton loads are linked to this statement. Re-upload it on Gin Receipts to match its load table, or add the loads first.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs text-slate-500"><tr>{['Load #', 'Field', 'Delivered', 'Rolls', 'Net lbs', ''].map((h, k) => <th key={h || k} className={`${k >= 3 && k <= 4 ? 'text-right' : 'text-left'} px-4 py-2 whitespace-nowrap`}>{h}</th>)}</tr></thead>
                  <tbody>
                    {loadLinks.map((l) => (
                      <tr key={l.id} className="border-t border-slate-100">
                        <td className="px-4 py-2 font-mono"><Link href={`/cotton/loads/${l.load.id}`} className="text-brand-deep underline">{l.load.load_number}</Link></td>
                        <td className="px-4 py-2">{l.load.field_id ? fieldById.get(l.load.field_id)?.name_or_number ?? '—' : '—'}</td>
                        <td className="px-4 py-2">{l.load.delivered_date ? fmtDate(l.load.delivered_date) : '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{l.load.rolls != null ? fmtInt(l.load.rolls) : '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{lbs(l.load.net_weight)}</td>
                        <td className="px-4 py-2 text-right no-print"><button type="button" onClick={() => setAskUnlink(l)} className="text-xs text-red-600 min-h-11 px-2">Take off statement</button></td>
                      </tr>
                    ))}
                    <tr className="border-t border-slate-200 font-semibold">
                      <td className="px-4 py-2" colSpan={4}>Linked loads</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtInt(loadNet)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title={`Bales${bales.length ? ` (${fmtInt(bales.length)})` : ''}`}>
            {bales.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">No bale numbers on file for this statement. Re-upload the statement to read its bale list, or add bales on <Link href="/cotton/bales" className="text-brand-deep underline">Bales &amp; Grades</Link>.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs text-slate-500"><tr>{['PBI', 'Net lbs', 'Grade', 'Mic', 'Staple', 'Strength', 'Classed'].map((h, k) => <th key={h} className={`${k >= 1 && k <= 5 ? 'text-right' : 'text-left'} px-4 py-2 whitespace-nowrap`}>{h}</th>)}</tr></thead>
                  <tbody>
                    {shownBales.map((b) => (
                      <tr key={b.id} className="border-t border-slate-100">
                        <td className="px-4 py-1.5 font-mono">{b.pbi_number}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtInt(b.net_weight_lbs)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{b.grade?.composite_grade ?? (b.grade?.color_grade ? `${b.grade.color_grade}${b.grade.leaf_grade ? `-${b.grade.leaf_grade}` : ''}` : '—')}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{b.grade?.micronaire ?? '—'}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{b.grade?.staple_32nds ?? '—'}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{b.grade?.strength_g_tex ?? '—'}</td>
                        <td className="px-4 py-1.5 text-slate-500">{b.grade?.class_date ? fmtDate(b.grade.class_date) : b.grade ? 'yes' : '—'}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-slate-200 font-semibold">
                      <td className="px-4 py-2">{fmtInt(bales.length)} bales</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtInt(baleLint)}</td>
                      <td colSpan={5} className="px-4 py-2 text-slate-500 font-normal text-xs">{graded ? `${fmtInt(graded)} classed` : 'none classed yet'}{Math.abs(baleLint - Number(r.total_bale_weight ?? 0)) > 0.5 && r.total_bale_weight != null ? ` · the statement says ${fmtInt(Number(r.total_bale_weight))} lbs` : ''}</td>
                    </tr>
                  </tbody>
                </table>
                {bales.length > BALES_SHOWN && (
                  <div className="px-4 py-2 no-print">
                    <button type="button" onClick={() => setShowAllBales((v) => !v)} className="text-sm text-brand-deep underline min-h-11">{showAllBales ? `Show the first ${BALES_SHOWN}` : `Show all ${fmtInt(bales.length)} bales`}</button>
                  </div>
                )}
              </div>
            )}
          </Section>

          {r.notes && (
            <Section title="Notes"><p className="px-4 py-3 text-sm whitespace-pre-wrap">{r.notes}</p></Section>
          )}
        </>
      )}

      <ConfirmDialog
        open={askDelete}
        title="Delete this gin receipt?"
        body={`${title}. ${bales.length ? `Its ${plural(bales.length, 'bale')} go with it` : 'It has no bales on file'}${loadLinks.length ? `, and its ${plural(loadLinks.length, 'load')} go back to the yard (the loads themselves stay)` : ''}. This can’t be undone.`}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => { if (!deleting) setAskDelete(false) }}
      />
      <ConfirmDialog
        open={askUnlink != null}
        title={`Take load ${askUnlink?.load.load_number ?? ''} off this statement?`}
        body="The load goes back to the yard as not ginned. The load itself is not deleted."
        confirmLabel="Take it off"
        danger
        onConfirm={() => { if (askUnlink) void doUnlink(askUnlink) }}
        onCancel={() => setAskUnlink(null)}
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow overflow-hidden avoid-break">
      <div className="px-4 pt-3 pb-2 border-b border-slate-100"><h2 className="font-semibold">{title}</h2></div>
      {children}
    </div>
  )
}

function Def({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500 uppercase tracking-wide">{label}</dt>
      <dd className="text-sm text-slate-900 tabular-nums">{value}{sub && <span className="ml-1 text-xs text-slate-500">({sub})</span>}</dd>
    </div>
  )
}

function StatCard({ label, value, sub, children }: { label: string; value?: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums text-slate-900">{children ?? value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  )
}
