'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import SettingsDocImport from '@/components/settings-doc-import'
import type { Farm, Landowner } from '@/lib/types'

type Draft = {
  name: string
  phone: string
  email: string
  address: string
  notes: string
}

const emptyDraft = (): Draft => ({ name: '', phone: '', email: '', address: '', notes: '' })

export default function LandownersPage() {
  const supabase = useMemo(() => createClient(), [])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [add, setAdd] = useState<Draft>(emptyDraft())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [edit, setEdit] = useState<Draft>(emptyDraft())
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')

  async function refresh() {
    const [lo, fa] = await Promise.all([
      supabase.from('landowners').select('*').order('name'),
      supabase.from('farms').select('*'),
    ])
    setLandowners((lo.data as Landowner[]) || [])
    setFarms((fa.data as Farm[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

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

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!add.name.trim()) return
    const payload = {
      name: add.name.trim(),
      phone: add.phone.trim() || null,
      email: add.email.trim() || null,
      address: add.address.trim() || null,
      notes: add.notes.trim() || null,
    }
    const { error } = await supabase.from('landowners').insert(payload)
    if (error) { setErr(error.message); return }
    setAdd(emptyDraft())
    refresh()
  }

  function startEdit(l: Landowner) {
    setEditingId(l.id)
    setEdit({
      name: l.name,
      phone: l.phone ?? '',
      email: l.email ?? '',
      address: l.address ?? '',
      notes: l.notes ?? '',
    })
  }

  async function save(id: string) {
    setErr(null)
    if (!edit.name.trim()) return
    const payload = {
      name: edit.name.trim(),
      phone: edit.phone.trim() || null,
      email: edit.email.trim() || null,
      address: edit.address.trim() || null,
      notes: edit.notes.trim() || null,
    }
    const { error } = await supabase.from('landowners').update(payload).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null)
    refresh()
  }

  async function remove(l: Landowner) {
    setErr(null)
    const linked = farmsByLandowner.get(l.id) ?? []
    if (linked.length > 0) {
      setErr(`${l.name} is linked to ${linked.length} farm${linked.length === 1 ? '' : 's'}. Unassign them first.`)
      return
    }
    if (!confirm(`Delete landowner "${l.name}"?`)) return
    const { error } = await supabase.from('landowners').delete().eq('id', l.id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const visible = landowners.filter((l) => {
    if (!q) return true
    const hay = [l.name, l.phone, l.email, l.address, l.notes].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q.toLowerCase())
  })

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Landowners</h1>

      <SettingsDocImport primaryTarget="landowners" title="Upload a Lease or Landowner List (AI)" onSaved={refresh} />

      <CsvImport
        config={{
          tableName: 'landowners',
          uniqueKey: 'name',
          title: 'Import landowners from a spreadsheet',
          note: 'One row per landowner. Only Name is required — import these before farms so the farms import can match landowner names.',
          columns: [
            { key: 'name', required: true },
            { key: 'phone' },
            { key: 'email' },
            { key: 'address' },
            { key: 'notes' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={onAdd} className="bg-white p-4 rounded-xl shadow space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input value={add.name} onChange={(e) => setAdd((d) => ({ ...d, name: e.target.value }))} placeholder="Name (required)" className={inputCls} />
          <input value={add.phone} onChange={(e) => setAdd((d) => ({ ...d, phone: e.target.value }))} placeholder="Phone" className={inputCls} />
          <input value={add.email} onChange={(e) => setAdd((d) => ({ ...d, email: e.target.value }))} placeholder="Email" className={inputCls} />
          <input value={add.address} onChange={(e) => setAdd((d) => ({ ...d, address: e.target.value }))} placeholder="Address" className={inputCls} />
          <input value={add.notes} onChange={(e) => setAdd((d) => ({ ...d, notes: e.target.value }))} placeholder="Notes" className={`${inputCls} sm:col-span-2`} />
        </div>
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">Add Landowner</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search landowners…"
        className="rounded-lg border border-slate-300 px-3 py-2 w-full max-w-md"
      />

      <ul className="bg-white rounded-xl shadow divide-y">
        {visible.length === 0 && (
          <li className="px-4 py-6 text-center text-slate-400">
            {landowners.length === 0 ? 'No landowners yet.' : 'No landowners match.'}
          </li>
        )}
        {visible.map((l) => {
          const linked = farmsByLandowner.get(l.id) ?? []
          return (
            <li key={l.id} className="px-4 py-3">
              {editingId === l.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input value={edit.name} onChange={(e) => setEdit((d) => ({ ...d, name: e.target.value }))} className={inputCls} />
                    <input value={edit.phone} onChange={(e) => setEdit((d) => ({ ...d, phone: e.target.value }))} className={inputCls} placeholder="Phone" />
                    <input value={edit.email} onChange={(e) => setEdit((d) => ({ ...d, email: e.target.value }))} className={inputCls} placeholder="Email" />
                    <input value={edit.address} onChange={(e) => setEdit((d) => ({ ...d, address: e.target.value }))} className={inputCls} placeholder="Address" />
                    <input value={edit.notes} onChange={(e) => setEdit((d) => ({ ...d, notes: e.target.value }))} className={`${inputCls} sm:col-span-2`} placeholder="Notes" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => save(l.id)} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1.5 text-sm font-semibold">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-slate-600 text-sm">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-[12rem]">
                    <div className="font-semibold">{l.name}</div>
                    <div className="text-xs text-slate-500 space-x-2">
                      {l.phone && <span>{l.phone}</span>}
                      {l.email && <span>{l.email}</span>}
                      {l.address && <span>{l.address}</span>}
                    </div>
                    {l.notes && <div className="text-xs text-slate-500 mt-1">{l.notes}</div>}
                    <div className="text-xs text-slate-600 mt-1">
                      {linked.length === 0
                        ? <span className="text-slate-400">No farms assigned.</span>
                        : <>Farms: {linked.map((f) => f.name).join(', ')}</>}
                    </div>
                  </div>
                  <button onClick={() => startEdit(l)} className="text-brand-deep text-sm">Edit</button>
                  <button onClick={() => remove(l)} className="text-red-600 text-sm" disabled={linked.length > 0} title={linked.length > 0 ? 'Unassign farms first' : ''}>Delete</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
