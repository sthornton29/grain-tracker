'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import type { Buyer, DeliveryLocation } from '@/lib/types'

type LocForm = { name: string; address: string }
const emptyLoc: LocForm = { name: '', address: '' }

export default function BuyersPage() {
  const supabase = useMemo(() => createClient(), [])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [locs, setLocs] = useState<DeliveryLocation[]>([])
  const [newBuyerName, setNewBuyerName] = useState('')
  const [editingBuyerId, setEditingBuyerId] = useState<string | null>(null)
  const [editBuyerName, setEditBuyerName] = useState('')
  const [expandedBuyerId, setExpandedBuyerId] = useState<string | null>(null)
  const [newLocByBuyer, setNewLocByBuyer] = useState<Record<string, LocForm>>({})
  const [editingLocId, setEditingLocId] = useState<string | null>(null)
  const [editLocForm, setEditLocForm] = useState<LocForm>(emptyLoc)
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const [b, l] = await Promise.all([
      supabase.from('buyers').select('*').order('name'),
      supabase.from('delivery_locations').select('*').order('name'),
    ])
    setBuyers((b.data as Buyer[]) || [])
    setLocs((l.data as DeliveryLocation[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const locsByBuyer = useMemo(() => {
    const m = new Map<string, DeliveryLocation[]>()
    for (const l of locs) {
      const list = m.get(l.buyer_id) ?? []
      list.push(l)
      m.set(l.buyer_id, list)
    }
    return m
  }, [locs])

  async function addBuyer(e: React.FormEvent) {
    e.preventDefault()
    if (!newBuyerName.trim()) return
    const { error } = await supabase.from('buyers').insert({ name: newBuyerName.trim() })
    if (error) { setErr(error.message); return }
    setNewBuyerName('')
    setErr(null)
    refresh()
  }

  async function saveBuyer(id: string) {
    if (!editBuyerName.trim()) return
    const { error } = await supabase.from('buyers').update({ name: editBuyerName.trim() }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingBuyerId(null)
    setErr(null)
    refresh()
  }

  async function removeBuyer(id: string) {
    const list = locsByBuyer.get(id) ?? []
    const msg = list.length > 0
      ? `Delete this buyer? ${list.length} delivery location${list.length === 1 ? '' : 's'} will also be deleted.`
      : 'Delete this buyer?'
    if (!confirm(msg)) return
    const { error } = await supabase.from('buyers').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  function getNewLoc(buyerId: string): LocForm {
    return newLocByBuyer[buyerId] ?? emptyLoc
  }
  function setNewLoc(buyerId: string, val: LocForm) {
    setNewLocByBuyer((s) => ({ ...s, [buyerId]: val }))
  }

  async function addLoc(buyerId: string, e: React.FormEvent) {
    e.preventDefault()
    const f = getNewLoc(buyerId)
    if (!f.name.trim()) return
    const { error } = await supabase.from('delivery_locations').insert({
      buyer_id: buyerId,
      name: f.name.trim(),
      address: f.address.trim() || null,
    })
    if (error) { setErr(error.message); return }
    setNewLoc(buyerId, emptyLoc)
    setErr(null)
    refresh()
  }

  async function saveLoc(id: string) {
    if (!editLocForm.name.trim()) return
    const { error } = await supabase.from('delivery_locations').update({
      name: editLocForm.name.trim(),
      address: editLocForm.address.trim() || null,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingLocId(null)
    setErr(null)
    refresh()
  }

  async function removeLoc(id: string) {
    if (!confirm('Delete this delivery location? Contracts using it will have their location cleared.')) return
    const { error } = await supabase.from('delivery_locations').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Buyers &amp; Delivery Locations</h1>
      <p className="text-sm text-slate-500">
        Each buyer can have one or more delivery locations (e.g., separate elevators). Expand a buyer to manage its locations.
      </p>

      <CsvImport
        config={{
          tableName: 'buyers',
          uniqueKey: 'name',
          columns: [{ key: 'name', required: true }],
        }}
        onImported={refresh}
      />

      <form onSubmit={addBuyer} className="bg-white rounded-xl shadow p-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
        <input
          value={newBuyerName}
          onChange={(e) => setNewBuyerName(e.target.value)}
          placeholder="Buyer name"
          className={inputCls}
        />
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">Add Buyer</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {buyers.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No buyers yet.</li>}
        {buyers.map((b) => {
          const list = locsByBuyer.get(b.id) ?? []
          const isExpanded = expandedBuyerId === b.id
          const newLoc = getNewLoc(b.id)
          return (
            <li key={b.id} className="px-4 py-3">
              {editingBuyerId === b.id ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    value={editBuyerName}
                    onChange={(e) => setEditBuyerName(e.target.value)}
                    className={`flex-1 min-w-0 ${inputCls}`}
                  />
                  <button onClick={() => saveBuyer(b.id)} className="text-green-700 font-semibold">Save</button>
                  <button onClick={() => setEditingBuyerId(null)} className="text-slate-500">Cancel</button>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">{b.name}</div>
                    <div className="text-sm text-slate-500">
                      {list.length} delivery location{list.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <button
                    onClick={() => setExpandedBuyerId(isExpanded ? null : b.id)}
                    className="text-slate-600 text-sm"
                  >
                    {isExpanded ? 'Hide locations' : 'Show locations'}
                  </button>
                  <button
                    onClick={() => { setEditingBuyerId(b.id); setEditBuyerName(b.name) }}
                    className="text-brand-deep"
                  >Edit</button>
                  <button onClick={() => removeBuyer(b.id)} className="text-red-600">Delete</button>
                </div>
              )}

              {isExpanded && (
                <div className="mt-3 ml-2 border-l-2 border-slate-200 pl-3 space-y-2">
                  <form
                    onSubmit={(e) => addLoc(b.id, e)}
                    className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2"
                  >
                    <input
                      value={newLoc.name}
                      onChange={(e) => setNewLoc(b.id, { ...newLoc, name: e.target.value })}
                      placeholder="Location name"
                      className={inputCls}
                    />
                    <input
                      value={newLoc.address}
                      onChange={(e) => setNewLoc(b.id, { ...newLoc, address: e.target.value })}
                      placeholder="Address (optional)"
                      className={inputCls}
                    />
                    <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 font-semibold text-sm">
                      Add location
                    </button>
                  </form>

                  {list.length === 0 ? (
                    <p className="text-sm text-slate-400 py-2">No delivery locations.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {list.map((l) => (
                        <li key={l.id} className="py-2">
                          {editingLocId === l.id ? (
                            <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto_auto] gap-2">
                              <input
                                value={editLocForm.name}
                                onChange={(e) => setEditLocForm({ ...editLocForm, name: e.target.value })}
                                className={inputCls}
                              />
                              <input
                                value={editLocForm.address}
                                onChange={(e) => setEditLocForm({ ...editLocForm, address: e.target.value })}
                                placeholder="Address"
                                className={inputCls}
                              />
                              <button onClick={() => saveLoc(l.id)} className="text-green-700 font-semibold">Save</button>
                              <button onClick={() => setEditingLocId(null)} className="text-slate-500">Cancel</button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 flex-wrap">
                              <div className="flex-1 min-w-0">
                                <div className="font-medium">{l.name}</div>
                                {l.address && <div className="text-sm text-slate-500">{l.address}</div>}
                              </div>
                              <button
                                onClick={() => { setEditingLocId(l.id); setEditLocForm({ name: l.name, address: l.address ?? '' }) }}
                                className="text-brand-deep text-sm"
                              >Edit</button>
                              <button onClick={() => removeLoc(l.id)} className="text-red-600 text-sm">Delete</button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
