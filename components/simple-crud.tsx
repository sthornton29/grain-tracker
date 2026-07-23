'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Row = { id: string } & Record<string, any>

type Props = {
  title: string
  table: string
  /** Column on the row that holds the text value. Usually "name" or "name_or_number". */
  labelColumn: 'name' | 'name_or_number'
  placeholder?: string
}

export default function SimpleCrud({ title, table, labelColumn, placeholder }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Row[]>([])
  const [value, setValue] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const { data, error } = await supabase.from(table).select('*').order(labelColumn)
    if (error) { setErr(error.message); return }
    setRows((data as Row[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const name = value.trim()
    if (!name) return
    const { error } = await supabase.from(table).insert({ [labelColumn]: name })
    if (error) { setErr(error.message); return }
    setValue(''); setErr(null); refresh()
  }

  async function save(id: string) {
    const name = editingValue.trim()
    if (!name) return
    const { error } = await supabase.from(table).update({ [labelColumn]: name }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this item?')) return
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{title}</h1>

      <form onSubmit={add} className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder ?? `Add ${title.toLowerCase()}`}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
        />
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {rows.length === 0 && <li className="px-4 py-6 text-center text-slate-400">None yet.</li>}
        {rows.map((r) => (
          <li key={r.id} className="px-4 py-2 flex items-center gap-2">
            {editingId === r.id ? (
              <>
                <input
                  autoFocus
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
                />
                <button onClick={() => save(r.id)} className="text-green-700 font-semibold">Save</button>
                <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
              </>
            ) : (
              <>
                <span className="flex-1">{r[labelColumn]}</span>
                <button
                  onClick={() => { setEditingId(r.id); setEditingValue(r[labelColumn]) }}
                  className="text-brand-deep"
                >Edit</button>
                <button onClick={() => remove(r.id)} className="text-red-600">Delete</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
