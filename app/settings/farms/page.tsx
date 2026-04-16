'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import type { Entity, Farm } from '@/lib/types'

export default function FarmsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [farms, setFarms] = useState<Farm[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [fsaNumber, setFsaNumber] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editEntityId, setEditEntityId] = useState('')
  const [editFsaNumber, setEditFsaNumber] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  async function refresh() {
    const [fa, en] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
    ])
    setFarms((fa.data as Farm[]) || [])
    setEntities((en.data as Entity[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    const { error } = await supabase.from('farms').insert({
      name: name.trim(),
      entity_id: entityId || null,
      fsa_number: fsaNumber.trim() || null,
    })
    if (error) { setErr(error.message); return }
    setName(''); setEntityId(''); setFsaNumber(''); setErr(null); refresh()
  }

  async function save(id: string) {
    if (!editName.trim()) return
    const { error } = await supabase.from('farms').update({
      name: editName.trim(),
      entity_id: editEntityId || null,
      fsa_number: editFsaNumber.trim() || null,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this farm? Fields under it will also be deleted.')) return
    const { error } = await supabase.from('farms').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const entityName = (id: string | null) => entities.find((e) => e.id === id)?.name ?? ''
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Farms</h1>

      <CsvImport
        config={{
          tableName: 'farms',
          uniqueKey: 'name',
          columns: [
            { key: 'name', required: true },
            { key: 'entity_id', label: 'entity', fk: { table: 'entities', matchColumn: 'name' } },
            { key: 'fsa_number', label: 'fsa_number' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_160px_auto] gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Farm name"
          className={inputCls}
        />
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
          <option value="">— entity (optional) —</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <input
          value={fsaNumber}
          onChange={(e) => setFsaNumber(e.target.value)}
          placeholder="FSA #"
          className={inputCls}
        />
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          placeholder="Search farms…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 flex-1 min-w-[12rem]"
        />
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
        >
          Name {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {(() => {
        const visible = farms
          .filter((f) => {
            if (!q) return true
            const hay = [f.name, entityName(f.entity_id), f.fsa_number ?? ''].join(' ').toLowerCase()
            return hay.includes(q.toLowerCase())
          })
          .sort((a, b) => (sortDir === 'asc' ? 1 : -1) * a.name.localeCompare(b.name))
        return (
      <ul className="bg-white rounded-xl shadow divide-y">
        {visible.length === 0 && <li className="px-4 py-6 text-center text-slate-400">{farms.length === 0 ? 'No farms yet.' : 'No farms match.'}</li>}
        {visible.map((f) => (
          <li key={f.id} className="px-4 py-2 flex items-center gap-2 flex-wrap">
            {editingId === f.id ? (
              <>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className={`flex-1 min-w-0 ${inputCls}`}
                />
                <select
                  value={editEntityId}
                  onChange={(e) => setEditEntityId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">— no entity —</option>
                  {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <input
                  value={editFsaNumber}
                  onChange={(e) => setEditFsaNumber(e.target.value)}
                  placeholder="FSA #"
                  className={`w-32 ${inputCls}`}
                />
                <button onClick={() => save(f.id)} className="text-green-700 font-semibold">Save</button>
                <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
              </>
            ) : (
              <>
                <span className="flex-1">
                  {f.name}
                  {f.entity_id && <span className="text-slate-400 text-sm"> · {entityName(f.entity_id)}</span>}
                  {f.fsa_number && <span className="text-slate-400 text-sm"> · FSA #{f.fsa_number}</span>}
                </span>
                <button
                  onClick={() => {
                    setEditingId(f.id)
                    setEditName(f.name)
                    setEditEntityId(f.entity_id ?? '')
                    setEditFsaNumber(f.fsa_number ?? '')
                  }}
                  className="text-sky-700"
                >Edit</button>
                <button onClick={() => remove(f.id)} className="text-red-600">Delete</button>
              </>
            )}
          </li>
        ))}
      </ul>
      ) })()}
    </div>
  )
}
