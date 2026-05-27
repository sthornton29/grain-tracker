'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import {
  ContractFields,
  contractToForm,
  contractFormToPayload,
  validateContractForm,
  emptyContractForm,
  type ContractFormState,
} from '@/components/contract-form'
import { CONTRACT_TYPE_LABEL, PRICING_STATUS_LABEL } from '@/lib/contracts'
import type { Buyer, Contract, Crop, DeliveryLocation, Entity, FieldPlanting } from '@/lib/types'

export default function ContractsSettingsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [locations, setLocations] = useState<DeliveryLocation[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [rows, setRows] = useState<Contract[]>([])
  const [form, setForm] = useState<ContractFormState>(emptyContractForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<ContractFormState>(emptyContractForm)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')

  async function refresh() {
    const [b, c, k, l, en, pl] = await Promise.all([
      supabase.from('buyers').select('*').order('name'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('contracts').select('*').order('contract_number'),
      supabase.from('delivery_locations').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('field_plantings').select('season_year'),
    ])
    setBuyers((b.data as Buyer[]) || [])
    setCrops((c.data as Crop[]) || [])
    setRows((k.data as Contract[]) || [])
    setLocations((l.data as DeliveryLocation[]) || [])
    setEntities((en.data as Entity[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(plantings.map((p) => p.season_year)),
    [plantings],
  )

  // Default the new-contract form's entity to the most recent contract's entity.
  useEffect(() => {
    if (rows.length === 0) return
    const latest = [...rows].filter((r) => r.entity_id).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0]
    if (!latest?.entity_id) return
    setForm((f) => (f.entity_id === '' ? { ...f, entity_id: latest.entity_id! } : f))
  }, [rows])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const v = validateContractForm(form)
    if (v) { setErr(v); return }
    const { error } = await supabase.from('contracts').insert(contractFormToPayload(form))
    if (error) { setErr(error.message); return }
    setForm(emptyContractForm); setErr(null); refresh()
  }

  async function save(id: string) {
    const v = validateContractForm(editForm)
    if (v) { setErr(v); return }
    const { error } = await supabase.from('contracts').update(contractFormToPayload(editForm)).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this contract?')) return
    const { error } = await supabase.from('contracts').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const buyerName = (id: string | null) => buyers.find((b) => b.id === id)?.name ?? ''
  const cropName = (id: string | null) => crops.find((c) => c.id === id)?.name ?? ''
  const locName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? ''
  const entityName = (id: string | null) => entities.find((e) => e.id === id)?.name ?? ''

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Contracts</h1>

      <CsvImport
        config={{
          tableName: 'contracts',
          uniqueKey: 'contract_number',
          columns: [
            { key: 'contract_number', required: true },
            { key: 'buyer_id', label: 'buyer', fk: { table: 'buyers', matchColumn: 'name' } },
            { key: 'crop_id', label: 'crop', fk: { table: 'crops', matchColumn: 'name' } },
            { key: 'entity_id', label: 'entity', fk: { table: 'entities', matchColumn: 'name' } },
            { key: 'crop_year', type: 'number' },
            { key: 'contracted_bushels', type: 'number' },
            { key: 'price_per_bushel', type: 'number' },
            { key: 'cash_price', type: 'number' },
            { key: 'contract_month' },
            { key: 'delivery_type', enum: ['pickup', 'delivered'], default: 'pickup' },
            { key: 'delivery_location_id', label: 'delivery_location', fk: { table: 'delivery_locations', matchColumn: 'name', scopeKey: 'buyer_id' } },
            { key: 'delivery_start_date', type: 'date' },
            { key: 'delivery_end_date', type: 'date' },
            { key: 'notes' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="space-y-2 bg-white p-4 rounded-xl shadow">
        <ContractFields value={form} onChange={setForm} buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions} />
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add Contract</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      {(() => { const visible = rows.filter((c) => {
        if (!q) return true
        const hay = [c.contract_number, buyerName(c.buyer_id), cropName(c.crop_id), entityName(c.entity_id), String(c.crop_year ?? ''), c.notes ?? ''].join(' ').toLowerCase()
        return hay.includes(q.toLowerCase())
      }); return (
      <>
      <div className="flex items-center gap-2 flex-wrap">
        <input type="search" placeholder="Search contract #, buyer, crop, year, notes…" value={q} onChange={(e) => setQ(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 flex-1 min-w-[12rem]" />
        {visible.length > 0 && (
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={visible.every((c) => selected.has(c.id))}
              onChange={() => {
                const allOn = visible.every((c) => selected.has(c.id))
                setSelected((s) => {
                  if (allOn) { const next = new Set(s); visible.forEach((c) => next.delete(c.id)); return next }
                  const next = new Set(s); visible.forEach((c) => next.add(c.id)); return next
                })
              }} />
            Select all
          </label>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <span className="font-semibold">{selected.size} selected</span>
          <button
            onClick={async () => {
              if (!confirm(`Delete ${selected.size} contract${selected.size === 1 ? '' : 's'}? This cannot be undone.`)) return
              const ids = [...selected]
              const CHUNK = 50
              for (let i = 0; i < ids.length; i += CHUNK) {
                const batch = ids.slice(i, i + CHUNK)
                const { error } = await supabase.from('contracts').delete().in('id', batch)
                if (error) { setErr(`Failed after ${i} of ${ids.length}: ${error.message}`); refresh(); return }
              }
              setSelected(new Set()); refresh()
            }}
            className="rounded-lg bg-red-600 text-white px-3 py-1.5 text-sm font-semibold"
          >
            Delete selected
          </button>
          <button onClick={() => setSelected(new Set())} className="text-slate-600">Clear</button>
        </div>
      )}

      <ul className="bg-white rounded-xl shadow divide-y">
        {visible.length === 0 && <li className="px-4 py-6 text-center text-slate-400">{rows.length === 0 ? 'No contracts yet.' : 'No contracts match.'}</li>}
        {visible.map((c) => (
          <li key={c.id} className={`px-4 py-3 space-y-2 ${selected.has(c.id) ? 'bg-sky-50' : ''}`}>
            {editingId === c.id ? (
              <>
                <ContractFields value={editForm} onChange={setEditForm} buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions} />
                <div className="flex gap-2">
                  <button onClick={() => save(c.id)} className="text-green-700 font-semibold">Save</button>
                  <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n })} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold flex items-center gap-2">
                    #{c.contract_number}
                    <span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{CONTRACT_TYPE_LABEL[c.contract_type ?? 'forward']}</span>
                    {c.pricing_status !== 'fully_priced' && (
                      <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">{PRICING_STATUS_LABEL[c.pricing_status]}</span>
                    )}
                  </div>
                  <div className="text-sm text-slate-500">
                    {buyerName(c.buyer_id)} · {cropName(c.crop_id)}
                    {c.contract_month && <> · {c.contract_month}</>}
                    {c.entity_id && <> · {entityName(c.entity_id)}</>}
                    {c.crop_year != null && <> · {c.crop_year} crop</>}
                    {' · '}{Number(c.contracted_bushels).toLocaleString()} bu
                    {c.cash_price != null ? <> · ${Number(c.cash_price).toFixed(4)}/bu</>
                      : c.pricing_status === 'awaiting_basis' ? <> · futures ${Number(c.futures_price ?? 0).toFixed(4)}</>
                      : c.pricing_status === 'awaiting_futures' ? <> · basis {Number(c.basis ?? 0).toFixed(4)}</> : null}
                    {' · '}
                    {c.delivery_type === 'delivered' ? <>Delivered → {locName(c.delivery_location_id) || '—'}</> : 'Pickup'}
                    {(c.delivery_start_date || c.delivery_end_date) && <> · {c.delivery_start_date ?? '?'} → {c.delivery_end_date ?? '?'}</>}
                  </div>
                  {c.notes && <div className="text-xs text-slate-400">{c.notes}</div>}
                </div>
                <button onClick={() => { setEditingId(c.id); setEditForm(contractToForm(c)) }} className="text-sky-700">Edit</button>
                <button onClick={() => remove(c.id)} className="text-red-600">Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      </>
      ) })()}
    </div>
  )
}
