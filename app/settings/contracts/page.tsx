'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import type { Buyer, Contract, Crop, DeliveryLocation, Entity, FieldPlanting } from '@/lib/types'

type Form = {
  contract_number: string
  buyer_id: string
  crop_id: string
  entity_id: string
  crop_year: string
  contracted_bushels: string
  price_per_bushel: string
  delivery_type: 'pickup' | 'delivered'
  delivery_location_id: string
  delivery_start_date: string
  delivery_end_date: string
  notes: string
}

const empty: Form = {
  contract_number: '',
  buyer_id: '',
  crop_id: '',
  entity_id: '',
  crop_year: '',
  contracted_bushels: '',
  price_per_bushel: '',
  delivery_type: 'pickup',
  delivery_location_id: '',
  delivery_start_date: '',
  delivery_end_date: '',
  notes: '',
}

function toForm(c: Contract): Form {
  return {
    contract_number: c.contract_number,
    buyer_id: c.buyer_id ?? '',
    crop_id: c.crop_id ?? '',
    entity_id: c.entity_id ?? '',
    crop_year: c.crop_year != null ? String(c.crop_year) : '',
    contracted_bushels: c.contracted_bushels?.toString() ?? '',
    price_per_bushel: c.price_per_bushel?.toString() ?? '',
    delivery_type: c.delivery_type,
    delivery_location_id: c.delivery_location_id ?? '',
    delivery_start_date: c.delivery_start_date ?? '',
    delivery_end_date: c.delivery_end_date ?? '',
    notes: c.notes ?? '',
  }
}

function toPayload(f: Form) {
  return {
    contract_number: f.contract_number.trim(),
    buyer_id: f.buyer_id || null,
    crop_id: f.crop_id || null,
    entity_id: f.entity_id || null,
    crop_year: f.crop_year === '' ? null : Number(f.crop_year),
    contracted_bushels: f.contracted_bushels === '' ? 0 : Number(f.contracted_bushels),
    price_per_bushel: f.price_per_bushel === '' ? null : Number(f.price_per_bushel),
    delivery_type: f.delivery_type,
    delivery_location_id: f.delivery_type === 'delivered' ? (f.delivery_location_id || null) : null,
    delivery_start_date: f.delivery_start_date || null,
    delivery_end_date: f.delivery_end_date || null,
    notes: f.notes || null,
  }
}

const INPUT_CLS = 'rounded-lg border border-slate-300 px-3 py-2'

function FormFields({
  value,
  onChange,
  buyers,
  crops,
  locations,
  entities,
  cropYearOptions,
}: {
  value: Form
  onChange: (f: Form) => void
  buyers: Buyer[]
  crops: Crop[]
  locations: DeliveryLocation[]
  entities: Entity[]
  cropYearOptions: number[]
}) {
  const f = value
  const set = <K extends keyof Form>(k: K, v: Form[K]) => onChange({ ...f, [k]: v })
  // If buyer changes, clear delivery location (it might no longer match the buyer).
  function setBuyer(id: string) {
    const next = { ...f, buyer_id: id }
    if (next.delivery_location_id) {
      const loc = locations.find((l) => l.id === next.delivery_location_id)
      if (!loc || loc.buyer_id !== id) next.delivery_location_id = ''
    }
    onChange(next)
  }
  const buyerLocations = locations.filter((l) => l.buyer_id === f.buyer_id)
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input placeholder="Contract #" value={f.contract_number} onChange={(e) => set('contract_number', e.target.value)} className={INPUT_CLS} />
        <input type="number" step="0.01" placeholder="Contracted bushels" value={f.contracted_bushels} onChange={(e) => set('contracted_bushels', e.target.value)} className={INPUT_CLS} />
        <select value={f.buyer_id} onChange={(e) => setBuyer(e.target.value)} className={INPUT_CLS}>
          <option value="">— buyer —</option>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select value={f.crop_id} onChange={(e) => set('crop_id', e.target.value)} className={INPUT_CLS}>
          <option value="">— crop —</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="number" step="0.0001" placeholder="Price / bushel" value={f.price_per_bushel} onChange={(e) => set('price_per_bushel', e.target.value)} className={INPUT_CLS} />
        <select value={f.crop_year} onChange={(e) => set('crop_year', e.target.value)} className={INPUT_CLS}>
          <option value="">— crop year —</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={f.entity_id} onChange={(e) => set('entity_id', e.target.value)} className={INPUT_CLS}>
          <option value="">— entity —</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <label className="text-sm text-slate-700">
          Delivery start
          <input type="date" value={f.delivery_start_date} onChange={(e) => set('delivery_start_date', e.target.value)} className={`w-full ${INPUT_CLS}`} />
        </label>
        <label className="text-sm text-slate-700">
          Delivery end
          <input type="date" value={f.delivery_end_date} onChange={(e) => set('delivery_end_date', e.target.value)} className={`w-full ${INPUT_CLS}`} />
        </label>
        <input placeholder="Notes" value={f.notes} onChange={(e) => set('notes', e.target.value)} className={`sm:col-span-2 ${INPUT_CLS}`} />
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <span className="text-sm font-semibold text-slate-700">Location:</span>
        <label className="text-sm flex items-center gap-1">
          <input
            type="radio"
            checked={f.delivery_type === 'pickup'}
            onChange={() => onChange({ ...f, delivery_type: 'pickup', delivery_location_id: '' })}
          />
          Pickup
        </label>
        <label className="text-sm flex items-center gap-1">
          <input
            type="radio"
            checked={f.delivery_type === 'delivered'}
            onChange={() => set('delivery_type', 'delivered')}
          />
          Delivered
        </label>
        {f.delivery_type === 'delivered' && (
          <>
            <select
              value={f.delivery_location_id}
              onChange={(e) => set('delivery_location_id', e.target.value)}
              className={INPUT_CLS}
              disabled={!f.buyer_id}
            >
              <option value="">{f.buyer_id ? '— delivery location —' : 'pick a buyer first'}</option>
              {buyerLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {f.buyer_id && buyerLocations.length === 0 && (
              <Link href="/settings/buyers" className="text-sm text-sky-700 underline">
                Add a location for this buyer
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default function ContractsSettingsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [locations, setLocations] = useState<DeliveryLocation[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [rows, setRows] = useState<Contract[]>([])
  const [form, setForm] = useState<Form>(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Form>(empty)
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

  // Default the new-contract form's entity to the most recently created
  // contract's entity (the "last entity you entered a contract under").
  // Only applies when the user hasn't yet picked one for this draft.
  useEffect(() => {
    if (rows.length === 0) return
    const latest = [...rows]
      .filter((r) => r.entity_id)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0]
    if (!latest?.entity_id) return
    setForm((f) => (f.entity_id === '' ? { ...f, entity_id: latest.entity_id! } : f))
  }, [rows])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!form.contract_number.trim()) return
    if (form.delivery_type === 'delivered' && !form.delivery_location_id) {
      setErr('Pick a delivery location for delivered contracts.')
      return
    }
    const { error } = await supabase.from('contracts').insert(toPayload(form))
    if (error) { setErr(error.message); return }
    setForm(empty); setErr(null); refresh()
  }

  async function save(id: string) {
    if (editForm.delivery_type === 'delivered' && !editForm.delivery_location_id) {
      setErr('Pick a delivery location for delivered contracts.')
      return
    }
    const { error } = await supabase.from('contracts').update(toPayload(editForm)).eq('id', id)
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

  const inputCls = INPUT_CLS

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
        <FormFields value={form} onChange={setForm} buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions} />
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
        <input
          type="search"
          placeholder="Search contract #, buyer, crop, year, notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 flex-1 min-w-[12rem]"
        />
        {visible.length > 0 && (
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={visible.every((c) => selected.has(c.id))}
              onChange={() => {
                const allOn = visible.every((c) => selected.has(c.id))
                setSelected((s) => {
                  if (allOn) { const next = new Set(s); visible.forEach((c) => next.delete(c.id)); return next }
                  const next = new Set(s); visible.forEach((c) => next.add(c.id)); return next
                })
              }}
            />
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
                <FormFields value={editForm} onChange={setEditForm} buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions} />
                <div className="flex gap-2">
                  <button onClick={() => save(c.id)} className="text-green-700 font-semibold">Save</button>
                  <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => setSelected((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n })}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">#{c.contract_number}</div>
                  <div className="text-sm text-slate-500">
                    {buyerName(c.buyer_id)} · {cropName(c.crop_id)}
                    {c.entity_id && <> · {entityName(c.entity_id)}</>}
                    {c.crop_year != null && <> · {c.crop_year} crop</>}
                    {' · '}{Number(c.contracted_bushels).toLocaleString()} bu
                    {c.price_per_bushel != null && <> · ${Number(c.price_per_bushel).toFixed(4)}/bu</>}
                    {' · '}
                    {c.delivery_type === 'delivered'
                      ? <>Delivered → {locName(c.delivery_location_id) || '—'}</>
                      : 'Pickup'}
                    {(c.delivery_start_date || c.delivery_end_date) && (
                      <> · {c.delivery_start_date ?? '?'} → {c.delivery_end_date ?? '?'}</>
                    )}
                  </div>
                  {c.notes && <div className="text-xs text-slate-400">{c.notes}</div>}
                </div>
                <button onClick={() => { setEditingId(c.id); setEditForm(toForm(c)) }} className="text-sky-700">Edit</button>
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
