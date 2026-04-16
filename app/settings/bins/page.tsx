'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import type { Bin, Crop } from '@/lib/types'

export default function BinsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [bins, setBins] = useState<Bin[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [name, setName] = useState('')
  const [cropId, setCropId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCropId, setEditCropId] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const [b, c] = await Promise.all([
      supabase.from('bins').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
    ])
    setBins((b.data as Bin[]) || [])
    setCrops((c.data as Crop[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    const { error } = await supabase.from('bins').insert({
      name_or_number: name.trim(),
      crop_id: cropId || null,
    })
    if (error) { setErr(error.message); return }
    setName(''); setErr(null); refresh()
  }

  async function save(id: string) {
    if (!editName.trim()) return
    const { error } = await supabase.from('bins').update({
      name_or_number: editName.trim(),
      crop_id: editCropId || null,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this bin?')) return
    const { error } = await supabase.from('bins').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const cropName = (id: string | null) => crops.find((c) => c.id === id)?.name ?? ''
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Bins</h1>
      <p className="text-sm text-slate-500">
        Designate each bin to a crop so the load entry screen only shows matching bins when that crop is selected.
      </p>

      <CsvImport
        config={{
          tableName: 'bins',
          uniqueKey: 'name_or_number',
          columns: [
            { key: 'name_or_number', label: 'name', required: true },
            { key: 'crop_id', label: 'crop', fk: { table: 'crops', matchColumn: 'name' } },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bin name or number"
          className={inputCls}
        />
        <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
          <option value="">— crop (optional) —</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {bins.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No bins yet.</li>}
        {bins.map((b) => (
          <li key={b.id} className="px-4 py-2 flex items-center gap-2 flex-wrap">
            {editingId === b.id ? (
              <>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className={`flex-1 min-w-0 ${inputCls}`}
                />
                <select
                  value={editCropId}
                  onChange={(e) => setEditCropId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">— no crop —</option>
                  {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button onClick={() => save(b.id)} className="text-green-700 font-semibold">Save</button>
                <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
              </>
            ) : (
              <>
                <span className="flex-1">
                  {b.name_or_number}
                  {b.crop_id
                    ? <span className="text-slate-400 text-sm"> · {cropName(b.crop_id)}</span>
                    : <span className="text-amber-600 text-xs"> · no crop assigned</span>}
                </span>
                <button
                  onClick={() => { setEditingId(b.id); setEditName(b.name_or_number); setEditCropId(b.crop_id ?? '') }}
                  className="text-sky-700"
                >Edit</button>
                <button onClick={() => remove(b.id)} className="text-red-600">Delete</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
