'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Buyer, DeliveryLocation } from '@/lib/types'

type Form = { buyer_id: string; name: string; address: string }
const empty: Form = { buyer_id: '', name: '', address: '' }

export default function DeliveryLocationsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [rows, setRows] = useState<DeliveryLocation[]>([])
  const [form, setForm] = useState<Form>(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Form>(empty)
  const [buyerFilter, setBuyerFilter] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const [b, l] = await Promise.all([
      supabase.from('buyers').select('*').order('name'),
      supabase.from('delivery_locations').select('*').order('name'),
    ])
    setBuyers((b.data as Buyer[]) || [])
    setRows((l.data as DeliveryLocation[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!form.buyer_id || !form.name.trim()) {
      setErr('Buyer and name are required.')
      return
    }
    const { error } = await supabase.from('delivery_locations').insert({
      buyer_id: form.buyer_id,
      name: form.name.trim(),
      address: form.address.trim() || null,
    })
    if (error) { setErr(error.message); return }
    setForm({ ...empty, buyer_id: form.buyer_id })
    setErr(null); refresh()
  }

  async function save(id: string) {
    if (!editForm.buyer_id || !editForm.name.trim()) return
    const { error } = await supabase.from('delivery_locations').update({
      buyer_id: editForm.buyer_id,
      name: editForm.name.trim(),
      address: editForm.address.trim() || null,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this delivery location? Contracts using it will have their location cleared.')) return
    const { error } = await supabase.from('delivery_locations').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const buyerName = (id: string) => buyers.find((b) => b.id === id)?.name ?? '—'
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  const visible = buyerFilter ? rows.filter((r) => r.buyer_id === buyerFilter) : rows

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Delivery Locations</h1>
      <p className="text-sm text-slate-500">Where contracts get delivered. A buyer can have multiple locations (e.g., separate elevators).</p>

      <form onSubmit={add} className="bg-white rounded-xl shadow p-4 grid grid-cols-1 sm:grid-cols-[1fr_1fr_2fr_auto] gap-2">
        <select value={form.buyer_id} onChange={(e) => setForm({ ...form, buyer_id: e.target.value })} className={inputCls}>
          <option value="">— buyer —</option>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Location name"
          className={inputCls}
        />
        <input
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          placeholder="Address (optional)"
          className={inputCls}
        />
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-2">
        <label className="text-sm text-slate-600">Filter by buyer</label>
        <select value={buyerFilter} onChange={(e) => setBuyerFilter(e.target.value)} className={inputCls}>
          <option value="">All buyers</option>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      <ul className="bg-white rounded-xl shadow divide-y">
        {visible.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No delivery locations.</li>}
        {visible.map((l) => (
          <li key={l.id} className="px-4 py-2">
            {editingId === l.id ? (
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_2fr_auto_auto] gap-2 items-center">
                <select value={editForm.buyer_id} onChange={(e) => setEditForm({ ...editForm, buyer_id: e.target.value })} className={inputCls}>
                  {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className={inputCls} />
                <input value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} placeholder="Address" className={inputCls} />
                <button onClick={() => save(l.id)} className="text-green-700 font-semibold">Save</button>
                <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{l.name} <span className="text-slate-400 text-sm font-normal">· {buyerName(l.buyer_id)}</span></div>
                  {l.address && <div className="text-sm text-slate-500">{l.address}</div>}
                </div>
                <button
                  onClick={() => { setEditingId(l.id); setEditForm({ buyer_id: l.buyer_id, name: l.name, address: l.address ?? '' }) }}
                  className="text-sky-700"
                >Edit</button>
                <button onClick={() => remove(l.id)} className="text-red-600">Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
