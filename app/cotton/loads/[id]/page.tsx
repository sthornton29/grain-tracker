'use client'

// One seed cotton load on its own page: identity and logistics, weights and
// rolls, the gin receipt it landed on, and the scanned ticket for THIS load.
// Edit in place, delete (unless it is already on a receipt), export / print.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import ExportBar from '@/components/export-bar'
import { ConfirmDialog, NoticeDialog } from '@/components/app-dialog'
import CottonLoadDocument from '@/components/cotton/cotton-load-document'
import { fmtInt } from '@/components/reports/report-kit'
import { lbsPerRoll } from '@/lib/cotton-loads'
import { rollsNum, updateCottonLoad } from '@/lib/cotton-load-writes'
import { reportError } from '@/lib/friendly-error'
import { fmtDate } from '@/lib/format-date'
import type { ExportPayload, ExportSection } from '@/lib/exports'
import type { CottonLoad, Entity, Farm, Field, Gin } from '@/lib/types'

type Receipt = { id: string; receipt_number: string; receipt_date: string | null; gin_id: string | null; bales_count: number | null; total_seed_cotton_weight: number | null }
type ReceiptLink = { receipt: Receipt | null }

type Draft = {
  load_number: string; entity_id: string; farm_id: string; field_id: string; gin_id: string
  picked_date: string; delivered_date: string; truck: string
  gross_weight: string; tare_weight: string; rolls: string; notes: string
}

const lbs = (n: number | null | undefined) => (n == null ? '—' : fmtInt(Number(n)))
const num = (s: string): number | null => { if (s.trim() === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null }

export default function CottonLoadDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [load, setLoad] = useState<CottonLoad | null>(null)
  const [missing, setMissing] = useState(false)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [gins, setGins] = useState<Gin[]>([])
  const [isGin, setIsGin] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [askDelete, setAskDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  async function refresh() {
    const [l, r, f, fl, en, g] = await Promise.all([
      supabase.from('cotton_loads').select('*').eq('id', id).maybeSingle(),
      supabase.from('gin_receipt_loads').select('receipt:gin_receipts(id, receipt_number, receipt_date, gin_id, bales_count, total_seed_cotton_weight)').eq('cotton_load_id', id),
      supabase.from('farms').select('*').order('name'),
      fetchAllRows((a, b) => supabase.from('fields').select('*').order('name_or_number').order('id').range(a, b)),
      supabase.from('entities').select('*').order('name'),
      supabase.from('gins').select('*').order('name'),
    ])
    if (!l.data) { setMissing(true); return }
    setLoad(l.data as CottonLoad)
    setReceipts((((r.data as unknown) as ReceiptLink[]) ?? []).map((x) => x.receipt).filter((x): x is Receipt => x != null))
    setFarms((f.data as Farm[]) ?? [])
    setFields((fl.data as Field[]) ?? [])
    setEntities((en.data as Entity[]) ?? [])
    setGins((g.data as Gin[]) ?? [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [id])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const { data } = await supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
      if (!cancelled) setIsGin((data as { role?: string } | null)?.role === 'gin')
    })()
    return () => { cancelled = true }
  }, [supabase])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const ginById = useMemo(() => new Map(gins.map((g) => [g.id, g])), [gins])

  if (missing) {
    return (
      <div className="bg-white rounded-xl shadow p-8 text-center space-y-3">
        <p className="text-slate-600 font-medium">That load isn&rsquo;t here — it may have been deleted.</p>
        <Link href="/cotton/loads" className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm font-semibold text-brand-deep">Back to seed cotton loads</Link>
      </div>
    )
  }
  if (!load) return <p className="text-slate-500">Loading…</p>

  const ginned = receipts.length > 0
  const farm = load.farm_id ? farmById.get(load.farm_id) : null
  const field = load.field_id ? fieldById.get(load.field_id) : null
  const entity = load.entity_id ? entityById.get(load.entity_id) : null
  const gin = load.gin_id ? ginById.get(load.gin_id) : null
  const perRoll = lbsPerRoll(load.net_weight, load.rolls)
  const sub = [`${load.crop_year} crop`, farm?.name, field?.name_or_number, load.delivered_date ? `delivered ${fmtDate(load.delivered_date)}` : null].filter(Boolean).join(' · ')

  function startEdit() {
    if (!load) return
    setDraft({
      load_number: load.load_number, entity_id: load.entity_id ?? '', farm_id: load.farm_id ?? '', field_id: load.field_id ?? '', gin_id: load.gin_id ?? '',
      picked_date: load.picked_date ?? '', delivered_date: load.delivered_date ?? '', truck: load.truck ?? '',
      gross_weight: load.gross_weight != null ? String(load.gross_weight) : '', tare_weight: load.tare_weight != null ? String(load.tare_weight) : '',
      rolls: load.rolls != null ? String(load.rolls) : '', notes: load.notes ?? '',
    })
    setErr(null); setEditing(true)
  }

  async function save() {
    if (!draft || !load) return
    setErr(null)
    if (!draft.load_number.trim()) { setErr('Load # is required.'); return }
    if (draft.rolls.trim() !== '' && rollsNum(draft.rolls) == null) { setErr('Rolls must be a whole number.'); return }
    setSaving(true)
    const gross = num(draft.gross_weight)
    const tare = num(draft.tare_weight)
    const { error } = await updateCottonLoad(supabase, load.id, {
      load_number: draft.load_number.trim(),
      entity_id: draft.entity_id || (draft.farm_id ? farmById.get(draft.farm_id)?.entity_id ?? null : null),
      farm_id: draft.farm_id || null, field_id: draft.field_id || null, gin_id: draft.gin_id || null,
      picked_date: draft.picked_date || null, delivered_date: draft.delivered_date || null,
      truck: draft.truck.trim() || null, gross_weight: gross, tare_weight: tare,
      net_weight: gross != null && tare != null ? gross - tare : gross,
      rolls: rollsNum(draft.rolls), notes: draft.notes.trim() || null,
    })
    setSaving(false)
    if (error) { setErr(reportError(error, { action: 'save this load', noun: 'load', name: draft.load_number.trim() })); return }
    setEditing(false); setDraft(null)
    refresh()
  }

  async function doDelete() {
    if (!load) return
    setDeleting(true)
    const { error } = await supabase.from('cotton_loads').delete().eq('id', load.id)
    if (error) { setDeleting(false); setAskDelete(false); setNotice(reportError(error, { action: 'delete this load', noun: 'load', name: load.load_number })); return }
    router.push('/cotton/loads')
  }

  const KV: ExportSection['columns'] = [{ label: 'Field' }, { label: 'Value', align: 'right' }]
  const payload: ExportPayload = {
    title: `Seed Cotton Load ${load.load_number}`,
    filters: sub,
    filename: `seed-cotton-load-${load.load_number}`,
    singleSheet: true,
    sections: [
      { title: 'Load & Logistics', columns: KV, rows: [
        ['Load #', load.load_number], ['Crop year', String(load.crop_year)], ['Entity', entity?.name ?? '—'], ['Farm', farm?.name ?? '—'], ['Field', field?.name_or_number ?? '—'],
        ['Picked', load.picked_date ? fmtDate(load.picked_date) : '—'], ['Delivered', load.delivered_date ? fmtDate(load.delivered_date) : '—'], ['Truck', load.truck ?? '—'], ['Gin', gin?.name ?? '—'],
        ['Entered', load.source === 'document_import' ? 'from an uploaded ticket' : 'by hand'],
      ] },
      { title: 'Weights & Rolls', columns: KV, rows: [
        ['Gross (lbs)', lbs(load.gross_weight)], ['Tare (lbs)', lbs(load.tare_weight)], ['Net seed cotton (lbs)', lbs(load.net_weight)],
        ['Rolls', load.rolls != null ? fmtInt(load.rolls) : '—'], ['Lbs per roll', perRoll != null ? fmtInt(perRoll) : '—'],
      ] },
      { title: 'Gin receipt', columns: KV, rows: ginned
        ? receipts.map((r) => [`Receipt #${r.receipt_number}`, `${r.receipt_date ? fmtDate(r.receipt_date) : 'undated'}${r.gin_id && ginById.get(r.gin_id) ? ` · ${ginById.get(r.gin_id)!.name}` : ''}`])
        : [['Status', 'On the yard — not on a gin receipt yet']] },
      ...(load.notes ? [{ title: 'Notes', columns: KV, rows: [['Notes', load.notes]] } as ExportSection] : []),
    ],
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full mt-1'
  const labelCls = 'block text-sm text-slate-700'
  const draftFields = fields.filter((f) => !draft?.farm_id || f.farm_id === draft.farm_id)

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold">Seed cotton load {load.load_number}</h1>
          <p className="text-sm text-slate-500">{sub}</p>
        </div>
        <div className="flex gap-2 flex-wrap no-print">
          <Link href="/cotton/loads" className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm">Back</Link>
          {!editing && <button type="button" onClick={startEdit} className="rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm font-semibold text-brand-deep">Edit</button>}
          <button
            type="button"
            onClick={() => ginned ? setNotice(`Load ${load.load_number} is on gin receipt ${receipts.map((r) => `#${r.receipt_number}`).join(', ')}, so it can’t be deleted here. Remove it from the receipt first.`) : setAskDelete(true)}
            className="rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm font-semibold text-red-600"
          >
            Delete
          </button>
          <ExportBar buildPayload={() => payload} />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Net seed cotton" value={`${lbs(load.net_weight)} lbs`} />
        <StatCard label="Rolls" value={load.rolls != null ? fmtInt(load.rolls) : '—'} />
        <StatCard label="Lbs per roll" value={perRoll != null ? fmtInt(perRoll) : '—'} />
        <StatCard label="Status">
          {ginned
            ? <span className="inline-block rounded-full px-3 py-1 text-sm font-semibold bg-green-100 text-green-800">Ginned</span>
            : <span className="inline-block rounded-full px-3 py-1 text-sm font-semibold bg-amber-100 text-amber-800">On the yard</span>}
        </StatCard>
      </div>

      {err && <p className="text-sm text-red-700" role="alert">{err}</p>}

      {editing && draft ? (
        <form onSubmit={(e) => { e.preventDefault(); void save() }} className="bg-white rounded-xl shadow p-4 space-y-3 no-print">
          <h2 className="font-semibold">Edit load</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <label className={labelCls}>Load #<input value={draft.load_number} onChange={(e) => setDraft({ ...draft, load_number: e.target.value })} className={inputCls} /></label>
            {!isGin && entities.length > 1 && (
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
                {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            <label className={labelCls}>Field
              <select value={draft.field_id} onChange={(e) => setDraft({ ...draft, field_id: e.target.value })} className={inputCls}>
                <option value="">—</option>
                {draftFields.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
              </select>
            </label>
            <label className={labelCls}>Picked<input type="date" value={draft.picked_date} onChange={(e) => setDraft({ ...draft, picked_date: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Delivered<input type="date" value={draft.delivered_date} onChange={(e) => setDraft({ ...draft, delivered_date: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Truck<input value={draft.truck} onChange={(e) => setDraft({ ...draft, truck: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Gin
              <select value={draft.gin_id} onChange={(e) => setDraft({ ...draft, gin_id: e.target.value })} className={inputCls}>
                <option value="">—</option>
                {gins.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label className={labelCls}>Gross lbs<input type="number" inputMode="numeric" step="1" value={draft.gross_weight} onChange={(e) => setDraft({ ...draft, gross_weight: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Tare lbs<input type="number" inputMode="numeric" step="1" value={draft.tare_weight} onChange={(e) => setDraft({ ...draft, tare_weight: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Rolls<input type="number" inputMode="numeric" step="1" min="0" value={draft.rolls} onChange={(e) => setDraft({ ...draft, rolls: e.target.value })} className={inputCls} /></label>
            <label className={labelCls}>Notes<input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className={inputCls} /></label>
          </div>
          {num(draft.gross_weight) != null && num(draft.tare_weight) != null && (
            <p className="text-sm text-slate-500">Net: <b>{fmtInt(num(draft.gross_weight)! - num(draft.tare_weight)!)}</b> lbs{rollsNum(draft.rolls) ? <> · <b>{fmtInt((num(draft.gross_weight)! - num(draft.tare_weight)!) / rollsNum(draft.rolls)!)}</b> lbs per roll</> : null}</p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={() => { setEditing(false); setDraft(null); setErr(null) }} className="rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm">Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <Section title="Load & Logistics">
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 px-4 py-3">
              <Def label="Load #" value={load.load_number} />
              <Def label="Crop year" value={String(load.crop_year)} />
              <Def label="Entity" value={entity?.name ?? '—'} />
              <Def label="Farm" value={farm?.name ?? '—'} />
              <Def label="Field" value={field?.name_or_number ?? '—'} />
              <Def label="Picked" value={load.picked_date ? fmtDate(load.picked_date) : '—'} />
              <Def label="Delivered" value={load.delivered_date ? fmtDate(load.delivered_date) : '—'} />
              <Def label="Truck" value={load.truck ?? '—'} />
              <Def label="Gin" value={gin?.name ?? '—'} />
              <Def label="Entered" value={load.source === 'document_import' ? 'from an uploaded ticket' : 'by hand'} sub={fmtDate(load.created_at.slice(0, 10))} />
            </dl>
          </Section>

          <Section title="Weights & Rolls">
            <dl className="grid grid-cols-2 sm:grid-cols-5 gap-x-8 gap-y-2 px-4 py-3">
              <Def label="Gross (lbs)" value={lbs(load.gross_weight)} />
              <Def label="Tare (lbs)" value={lbs(load.tare_weight)} />
              <Def label="Net seed cotton (lbs)" value={lbs(load.net_weight)} />
              <Def label="Rolls" value={load.rolls != null ? fmtInt(load.rolls) : '—'} sub={load.rolls == null ? 'not recorded' : undefined} />
              <Def label="Lbs per roll" value={perRoll != null ? fmtInt(perRoll) : '—'} />
            </dl>
          </Section>

          <Section title="Gin receipt">
            {ginned ? (
              <div className="px-4 py-3 space-y-1 text-sm">
                {receipts.map((r) => (
                  <p key={r.id}>
                    Receipt <b>#{r.receipt_number}</b>{r.receipt_date ? ` · ${fmtDate(r.receipt_date)}` : ''}{r.gin_id && ginById.get(r.gin_id) ? ` · ${ginById.get(r.gin_id)!.name}` : ''}
                    {r.bales_count != null ? ` · ${fmtInt(r.bales_count)} bales` : ''}{r.total_seed_cotton_weight != null ? ` · ${fmtInt(r.total_seed_cotton_weight)} lbs seed cotton on the statement` : ''}
                    {' '}<Link href="/cotton/receipts" className="text-brand-deep underline no-print">Open gin receipts →</Link>
                  </p>
                ))}
              </div>
            ) : (
              <p className="px-4 py-3 text-sm text-slate-500">On the yard — this load is not on a Statement of Ginning yet.</p>
            )}
          </Section>

          {load.notes && (
            <Section title="Notes"><p className="px-4 py-3 text-sm whitespace-pre-wrap">{load.notes}</p></Section>
          )}
        </>
      )}

      <CottonLoadDocument loadId={load.id} loadNumber={load.load_number} currentUrl={load.source_pdf_url} onChanged={refresh} />

      <ConfirmDialog
        open={askDelete}
        title={`Delete load ${load.load_number}?`}
        body="This seed cotton load is removed from the yard. Its ticket document goes with it. This can’t be undone."
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => { if (!deleting) setAskDelete(false) }}
      />
      <NoticeDialog open={notice != null} title="Can’t delete this load" body={notice} onClose={() => setNotice(null)} />
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

function StatCard({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums text-slate-900">{children ?? value}</div>
    </div>
  )
}
