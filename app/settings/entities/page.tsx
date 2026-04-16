'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import type { Entity } from '@/lib/types'

type Form = { name: string; notes: string }
const empty: Form = { name: '', notes: '' }

export default function EntitiesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Entity[]>([])
  const [form, setForm] = useState<Form>(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Form>(empty)
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const { data, error } = await supabase.from('entities').select('*').order('name')
    if (error) { setErr(error.message); return }
    setRows((data as Entity[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    const { error } = await supabase.from('entities').insert({
      name: form.name.trim(),
      notes: form.notes.trim() || null,
    })
    if (error) { setErr(error.message); return }
    setForm(empty); setErr(null); refresh()
  }

  async function save(id: string) {
    if (!editForm.name.trim()) return
    const { error } = await supabase.from('entities').update({
      name: editForm.name.trim(),
      notes: editForm.notes.trim() || null,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this entity? Farms will be unassigned but not deleted.')) return
    const { error } = await supabase.from('entities').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Entities</h1>
      <p className="text-sm text-slate-500">
        Farming business entities (LLCs, partnerships, corporations) that own or operate the farms.
      </p>

      <CsvImport
        config={{
          tableName: 'entities',
          uniqueKey: 'name',
          columns: [
            { key: 'name', required: true },
            { key: 'notes' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2 bg-white p-4 rounded-xl shadow">
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Entity name"
          className={inputCls}
        />
        <input
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Notes (optional)"
          className={inputCls}
        />
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {rows.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No entities yet.</li>}
        {rows.map((e) => (
          <li key={e.id} className="px-4 py-3">
            {editingId === e.id ? (
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto_auto] gap-2 items-center">
                <input
                  value={editForm.name}
                  onChange={(ev) => setEditForm({ ...editForm, name: ev.target.value })}
                  className={inputCls}
                />
                <input
                  value={editForm.notes}
                  onChange={(ev) => setEditForm({ ...editForm, notes: ev.target.value })}
                  className={inputCls}
                  placeholder="Notes"
                />
                <button onClick={() => save(e.id)} className="text-green-700 font-semibold">Save</button>
                <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{e.name}</div>
                  {e.notes && <div className="text-sm text-slate-500">{e.notes}</div>}
                </div>
                <button
                  onClick={() => { setEditingId(e.id); setEditForm({ name: e.name, notes: e.notes ?? '' }) }}
                  className="text-sky-700"
                >Edit</button>
                <button onClick={() => remove(e.id)} className="text-red-600">Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
