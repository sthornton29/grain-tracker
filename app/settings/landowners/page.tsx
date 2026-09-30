'use client'

// Settings → Landowners. Since 089 a landowner is shared BOTH WAYS with
// Turnrow Farm: linked rows stay EDITABLE here (the one exception to the
// managed-land rule, because Grain is where the rent settlement, the partner
// share, and the payee name live), and a field Turnrow Farm changed recently
// carries a "from Turnrow Farm" mark for a day so the farmer knows why it
// looks different. Creating a landowner runs the shared duplicate search
// first (lib/landowner-match.ts, the same normalization Turnrow Farm uses) and
// offers "Use existing" before it will make a second record — a split
// landowner splits their rent, their statements, and their share.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import CsvImport from '@/components/csv-import'
import { landownersImportConfig } from '@/lib/import-configs'
import SettingsDocImport from '@/components/settings-doc-import'
import { landownerDuplicateSearch, LANDOWNER_KINDS } from '@/lib/farm-link-landowners'
import { fmtSyncTime, TURNROW_FARM_URL } from '@/components/farm-link-banner'
import { reportError } from '@/lib/friendly-error'
import { useDialogs, plural } from '@/components/use-dialogs'
import type { Farm, Landowner } from '@/lib/types'

type Draft = {
  name: string
  kind: string
  contact_name: string
  phone: string
  email: string
  address_street: string
  address_city: string
  address_state: string
  address_zip: string
  payee_name: string
  notes: string
}

const emptyDraft = (): Draft => ({
  name: '', kind: '', contact_name: '', phone: '', email: '',
  address_street: '', address_city: '', address_state: '', address_zip: '',
  payee_name: '', notes: '',
})

const KIND_LABEL: Record<string, string> = {
  individual: 'Individual', family: 'Family', company: 'Company',
  trust: 'Trust', estate: 'Estate', government: 'Government', other: 'Other',
}

/** A field Turnrow Farm changed within this window still shows the mark. */
const FARM_MARK_HOURS = 24

type ChangeRow = { landowner_id: string; field: string; changed_at: string; changed_by: string }

const draftToPayload = (d: Draft) => ({
  name: d.name.trim(),
  kind: d.kind.trim() || null,
  contact_name: d.contact_name.trim() || null,
  phone: d.phone.trim() || null,
  email: d.email.trim() || null,
  address_street: d.address_street.trim() || null,
  address_city: d.address_city.trim() || null,
  address_state: d.address_state.trim().toUpperCase() || null,
  address_zip: d.address_zip.trim() || null,
  payee_name: d.payee_name.trim() || null,
  notes: d.notes.trim() || null,
})

export default function LandownersPage() {
  const supabase = useMemo(() => createClient(), [])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set())
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [changes, setChanges] = useState<ChangeRow[]>([])
  const [add, setAdd] = useState<Draft>(emptyDraft())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [edit, setEdit] = useState<Draft>(emptyDraft())
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const { confirm, dialogs } = useDialogs()

  const refresh = useCallback(async () => {
    const [lo, fa] = await Promise.all([
      fetchAllRows<Landowner>((f, t) => supabase.from('landowners').select('*').order('name').order('id').range(f, t)),
      fetchAllRows<Farm>((f, t) => supabase.from('farms').select('*').order('id').range(f, t)),
    ])
    setLandowners(lo.data ?? [])
    setFarms(fa.data ?? [])
    // 087/089 plumbing — every read below degrades to "not linked" when the
    // migration is not applied, so the page never breaks on a fresh database.
    const ids = await supabase.from('farm_link_ids').select('grain_id').eq('grain_table', 'landowners')
    setLinkedIds(new Set(((ids.data as Array<{ grain_id: string }> | null) ?? []).map((r) => r.grain_id)))
    const link = await supabase.from('farm_links').select('last_sync, status').neq('status', 'revoked').limit(1).maybeSingle()
    const sync = (link.data as { last_sync?: { inbound?: { at?: string } } } | null)?.last_sync?.inbound?.at ?? null
    setLastSyncAt(sync)
    const since = new Date(Date.now() - FARM_MARK_HOURS * 3600_000).toISOString()
    // Bounded on purpose: one day of Turnrow Farm's changes, capped. The mark
    // is cosmetic — a truncated list just means fewer marks, never wrong data.
    const ch = await supabase
      .from('landowner_field_changes')
      .select('landowner_id, field, changed_at, changed_by')
      .eq('changed_by', 'turnrow_farm')
      .gte('changed_at', since)
      .order('changed_at', { ascending: false })
      .limit(500)
    setChanges((ch.data as ChangeRow[] | null) ?? [])
  }, [supabase])
  useEffect(() => { refresh() }, [refresh])

  const farmsByLandowner = useMemo(() => {
    const m = new Map<string, Farm[]>()
    for (const f of farms) {
      if (!f.landowner_id) continue
      const list = m.get(f.landowner_id) ?? []
      list.push(f)
      m.set(f.landowner_id, list)
    }
    return m
  }, [farms])

  /** landowner id → the fields Turnrow Farm changed in the last day. */
  const farmTouched = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const c of changes) {
      const set = m.get(c.landowner_id) ?? new Set<string>()
      set.add(c.field)
      m.set(c.landowner_id, set)
    }
    return m
  }, [changes])

  // The duplicate search, live as the name is typed.
  const dupes = useMemo(() => landownerDuplicateSearch(add.name, landowners), [add.name, landowners])
  const [dupeDismissed, setDupeDismissed] = useState(false)
  useEffect(() => { setDupeDismissed(false) }, [add.name])

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!add.name.trim()) return
    if (dupes.exact && !dupeDismissed) {
      setErr(`${dupes.exact.name} is already a landowner. Use the existing one, or press Add again to create a second record anyway.`)
      setDupeDismissed(true)
      return
    }
    const { error } = await supabase.from('landowners').insert(draftToPayload(add))
    if (error) { setErr(reportError(error, { action: 'add the landowner', noun: 'landowner', name: add.name.trim() })); return }
    setAdd(emptyDraft())
    setDupeDismissed(false)
    refresh()
  }

  function startEdit(l: Landowner) {
    setEditingId(l.id)
    setEdit({
      name: l.name,
      kind: l.kind ?? '',
      contact_name: l.contact_name ?? '',
      phone: l.phone ?? '',
      email: l.email ?? '',
      address_street: l.address_street ?? l.address ?? '',
      address_city: l.address_city ?? '',
      address_state: l.address_state ?? '',
      address_zip: l.address_zip ?? '',
      payee_name: l.payee_name ?? '',
      notes: l.notes ?? '',
    })
  }

  async function save(id: string) {
    setErr(null)
    if (!edit.name.trim()) return
    const { error } = await supabase.from('landowners').update(draftToPayload(edit)).eq('id', id)
    if (error) { setErr(reportError(error, { action: 'save the landowner', noun: 'landowner', name: edit.name.trim() })); return }
    setEditingId(null)
    refresh()
  }

  async function archive(l: Landowner) {
    setErr(null)
    const linked = farmsByLandowner.get(l.id) ?? []
    const ok = await confirm({
      title: `Archive ${l.name}?`,
      body: linked.length > 0
        ? `${l.name} is the landowner on ${plural(linked.length, 'farm')} (${linked.map((f) => f.name).join(', ')}). Archiving hides them from pickers; the farms and every statement already made keep the name.`
        : 'Archiving hides this landowner from pickers and lists. Nothing already recorded changes, and you can show archived landowners again with the checkbox below.',
      confirmLabel: 'Archive',
    })
    if (!ok) return
    const { error } = await supabase.from('landowners').update({ archived_at: new Date().toISOString() }).eq('id', l.id)
    if (error) { setErr(reportError(error, { action: 'archive the landowner', noun: 'landowner', name: l.name })); return }
    refresh()
  }

  async function unarchive(l: Landowner) {
    setErr(null)
    const { error } = await supabase.from('landowners').update({ archived_at: null }).eq('id', l.id)
    if (error) { setErr(reportError(error, { action: 'restore the landowner', noun: 'landowner', name: l.name })); return }
    refresh()
  }

  async function remove(l: Landowner) {
    setErr(null)
    const linked = farmsByLandowner.get(l.id) ?? []
    if (linked.length > 0) {
      setErr(`${l.name} is the landowner on ${plural(linked.length, 'farm')} (${linked.map((f) => f.name).join(', ')}), so they can’t be deleted. Archive them instead, or change the landowner on those farms first.`)
      return
    }
    const ok = await confirm({
      title: `Delete ${l.name}?`,
      body: 'No farms point at this landowner, so the record can be removed. This can’t be undone — archive instead if you might need it again.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const { error } = await supabase.from('landowners').delete().eq('id', l.id)
    if (error) { setErr(reportError(error, { action: 'delete the landowner', noun: 'landowner', name: l.name })); return }
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full'
  const labelCls = 'block text-sm text-slate-700'
  const btnCls = 'min-h-11 px-3 rounded-lg text-sm font-semibold'
  const visible = landowners.filter((l) => {
    if (!showArchived && (l.archived_at || l.merged_into_id)) return false
    if (!q) return true
    const hay = [l.name, l.contact_name, l.payee_name, l.phone, l.email, l.address_street, l.address_city, l.address_state, l.address_zip, l.address, l.notes]
      .filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q.toLowerCase())
  })
  const archivedCount = landowners.filter((l) => l.archived_at || l.merged_into_id).length
  const nameById = new Map(landowners.map((l) => [l.id, l.name]))

  const addressLine = (l: Landowner) => {
    const parts = [l.address_street, [l.address_city, l.address_state].filter(Boolean).join(', '), l.address_zip].filter(Boolean)
    return parts.length > 0 ? parts.join(' · ') : l.address ?? null
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Landowners</h1>

      <SettingsDocImport primaryTarget="landowners" title="Upload a lease or landowner list" onSaved={refresh} />

      <CsvImport config={landownersImportConfig()} onImported={refresh} />

      <form onSubmit={onAdd} className="bg-white p-4 rounded-xl shadow space-y-3">
        <h2 className="font-semibold">Add a landowner</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className={labelCls}>
            Name
            <input value={add.name} onChange={(e) => setAdd((d) => ({ ...d, name: e.target.value }))} placeholder="e.g. Jane Farmer" className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Kind <span className="text-slate-400">(optional)</span>
            <select value={add.kind} onChange={(e) => setAdd((d) => ({ ...d, kind: e.target.value }))} className={`${inputCls} mt-1`}>
              <option value="">—</option>
              {LANDOWNER_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label className={`${labelCls}`}>
            Contact person
            <input value={add.contact_name} onChange={(e) => setAdd((d) => ({ ...d, contact_name: e.target.value }))} className={`${inputCls} mt-1`} />
          </label>
          <label className={`${labelCls}`}>
            Make checks payable to
            <input value={add.payee_name} onChange={(e) => setAdd((d) => ({ ...d, payee_name: e.target.value }))} placeholder="if different from the name" className={`${inputCls} mt-1`} />
          </label>
          <label className={`${labelCls}`}>
            Phone
            <input value={add.phone} onChange={(e) => setAdd((d) => ({ ...d, phone: e.target.value }))} className={`${inputCls} mt-1`} />
          </label>
          <label className={`${labelCls}`}>
            Email
            <input value={add.email} onChange={(e) => setAdd((d) => ({ ...d, email: e.target.value }))} className={`${inputCls} mt-1`} />
          </label>
          <label className={`${labelCls} sm:col-span-2`}>
            Street
            <input value={add.address_street} onChange={(e) => setAdd((d) => ({ ...d, address_street: e.target.value }))} className={`${inputCls} mt-1`} />
          </label>
          <label className={`${labelCls}`}>
            City
            <input value={add.address_city} onChange={(e) => setAdd((d) => ({ ...d, address_city: e.target.value }))} className={`${inputCls} mt-1`} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={`${labelCls}`}>
              State
              <input value={add.address_state} onChange={(e) => setAdd((d) => ({ ...d, address_state: e.target.value }))} placeholder="ST" maxLength={2} className={`${inputCls} mt-1`} />
            </label>
            <label className={`${labelCls}`}>
              ZIP
              <input value={add.address_zip} onChange={(e) => setAdd((d) => ({ ...d, address_zip: e.target.value }))} className={`${inputCls} mt-1`} />
            </label>
          </div>
          <label className={`${labelCls} sm:col-span-2`}>
            Notes
            <input value={add.notes} onChange={(e) => setAdd((d) => ({ ...d, notes: e.target.value }))} className={`${inputCls} mt-1`} />
          </label>
        </div>

        {(dupes.exact || dupes.near.length > 0) && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm space-y-1">
            <p className="font-semibold text-amber-900">
              {dupes.exact ? 'You already have this landowner.' : 'This looks like a landowner you already have.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {[dupes.exact, ...dupes.near].filter(Boolean).slice(0, 4).map((c) => (
                <button
                  key={c!.id} type="button"
                  onClick={() => { setAdd(emptyDraft()); setDupeDismissed(false); startEdit(c!) }}
                  className="rounded-lg border border-amber-400 bg-white px-2.5 py-1 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                >
                  Use {c!.name}
                </button>
              ))}
            </div>
            <p className="text-xs text-amber-800">
              Two records for one landowner split their rent, their statements, and their share.
            </p>
          </div>
        )}

        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold">Add landowner</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search landowners…"
          aria-label="Search landowners"
          className="rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full max-w-md"
        />
        {archivedCount > 0 && (
          <label className="flex items-center gap-1.5 text-sm text-slate-600 select-none">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-4 w-4" />
            Show archived ({archivedCount})
          </label>
        )}
      </div>

      <ul className="bg-white rounded-xl shadow divide-y">
        {visible.length === 0 && (
          <li className="px-4 py-6 text-center text-slate-500">
            {landowners.length === 0 ? 'No landowners yet — add the first one above, or upload a lease.' : 'No landowners match that search.'}
          </li>
        )}
        {visible.map((l) => {
          const linked = farmsByLandowner.get(l.id) ?? []
          const shared = linkedIds.has(l.id)
          const touched = farmTouched.get(l.id) ?? new Set<string>()
          const mark = (field: string) =>
            touched.has(field)
              ? <span className="ml-1 rounded-full bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-800" title="Changed in Turnrow Farm in the last day">from Turnrow Farm</span>
              : null
          return (
            <li key={l.id} className="px-4 py-3">
              {editingId === l.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className={labelCls}>
                      Name
                      <input value={edit.name} onChange={(e) => setEdit((d) => ({ ...d, name: e.target.value }))} className={`${inputCls} mt-1`} />
                    </label>
                    <label className={labelCls}>
                      Kind <span className="text-slate-400">(optional)</span>
                      <select value={edit.kind} onChange={(e) => setEdit((d) => ({ ...d, kind: e.target.value }))} className={`${inputCls} mt-1`}>
                        <option value="">—</option>
                        {LANDOWNER_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </select>
                    </label>
                    <label className={`${labelCls}`}>
                      Contact person
                      <input value={edit.contact_name} onChange={(e) => setEdit((d) => ({ ...d, contact_name: e.target.value }))} className={`${inputCls} mt-1`} />
                    </label>
                    <label className={`${labelCls}`}>
                      Make checks payable to
                      <input value={edit.payee_name} onChange={(e) => setEdit((d) => ({ ...d, payee_name: e.target.value }))} placeholder="if different from the name" className={`${inputCls} mt-1`} />
                    </label>
                    <label className={`${labelCls}`}>
                      Phone
                      <input value={edit.phone} onChange={(e) => setEdit((d) => ({ ...d, phone: e.target.value }))} className={`${inputCls} mt-1`} />
                    </label>
                    <label className={`${labelCls}`}>
                      Email
                      <input value={edit.email} onChange={(e) => setEdit((d) => ({ ...d, email: e.target.value }))} className={`${inputCls} mt-1`} />
                    </label>
                    <label className={`${labelCls} sm:col-span-2`}>
                      Street
                      <input value={edit.address_street} onChange={(e) => setEdit((d) => ({ ...d, address_street: e.target.value }))} className={`${inputCls} mt-1`} />
                    </label>
                    <label className={`${labelCls}`}>
                      City
                      <input value={edit.address_city} onChange={(e) => setEdit((d) => ({ ...d, address_city: e.target.value }))} className={`${inputCls} mt-1`} />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className={`${labelCls}`}>
                        State
                        <input value={edit.address_state} onChange={(e) => setEdit((d) => ({ ...d, address_state: e.target.value }))} placeholder="ST" maxLength={2} className={`${inputCls} mt-1`} />
                      </label>
                      <label className={`${labelCls}`}>
                        ZIP
                        <input value={edit.address_zip} onChange={(e) => setEdit((d) => ({ ...d, address_zip: e.target.value }))} className={`${inputCls} mt-1`} />
                      </label>
                    </div>
                    <label className={`${labelCls} sm:col-span-2`}>
                      Notes
                      <input value={edit.notes} onChange={(e) => setEdit((d) => ({ ...d, notes: e.target.value }))} className={`${inputCls} mt-1`} />
                    </label>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => setEditingId(null)} className={`${btnCls} border border-slate-300 bg-white text-slate-700`}>Cancel</button>
                    <button type="button" onClick={() => save(l.id)} className={`${btnCls} bg-brand hover:bg-brand-deep text-white px-4`}>Save</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-[12rem]">
                    <div className="font-semibold flex items-center gap-2 flex-wrap">
                      {l.name}
                      {mark('name')}
                      {l.kind && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{KIND_LABEL[l.kind] ?? l.kind}</span>}
                      {l.merged_into_id && (
                        <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">
                          merged into {nameById.get(l.merged_into_id) ?? 'another landowner'}
                        </span>
                      )}
                      {!l.merged_into_id && l.archived_at && (
                        <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">archived</span>
                      )}
                    </div>
                    {(l.contact_name || l.payee_name) && (
                      <div className="text-xs text-slate-600">
                        {l.contact_name && <span>Contact: {l.contact_name}{mark('contact_name')}</span>}
                        {l.contact_name && l.payee_name && <span> · </span>}
                        {l.payee_name && <span>Pay to: {l.payee_name}{mark('payee_name')}</span>}
                      </div>
                    )}
                    <div className="text-xs text-slate-500 space-x-2">
                      {l.phone && <span>{l.phone}{mark('phone')}</span>}
                      {l.email && <span>{l.email}{mark('email')}</span>}
                      {addressLine(l) && <span>{addressLine(l)}{mark('address_street')}</span>}
                    </div>
                    {l.notes && <div className="text-xs text-slate-500 mt-1">{l.notes}</div>}
                    <div className="text-xs text-slate-600 mt-1">
                      {linked.length === 0
                        ? <span className="text-slate-400">No farms assigned.</span>
                        : <>Farms: {linked.map((f) => f.name).join(', ')}</>}
                    </div>
                    {shared && (
                      <div className="text-xs text-slate-500 mt-1">
                        Shared with{' '}
                        <a href={TURNROW_FARM_URL} target="_blank" rel="noopener noreferrer" className="text-brand-deep underline">Turnrow Farm</a>
                        {lastSyncAt ? `, last updated from there ${fmtSyncTime(lastSyncAt)}` : ''}. You can edit them here or there.
                      </div>
                    )}
                  </div>
                  {!l.merged_into_id && (
                    <>
                      <button type="button" onClick={() => startEdit(l)} className={`${btnCls} text-brand-deep`}>Edit</button>
                      {l.archived_at
                        ? <button type="button" onClick={() => unarchive(l)} className={`${btnCls} text-slate-600`}>Restore</button>
                        : <button type="button" onClick={() => archive(l)} className={`${btnCls} text-slate-600`}>Archive</button>}
                      {!l.archived_at && linked.length === 0 && (
                        <button type="button" onClick={() => remove(l)} className={`${btnCls} text-red-600`}>Delete</button>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {dialogs}
    </div>
  )
}
