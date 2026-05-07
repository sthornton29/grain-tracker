'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
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

export default function EditContractPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const id = params.id

  const [form, setForm] = useState<Form>(empty)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [locations, setLocations] = useState<DeliveryLocation[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [c, b, k, l, en, pl] = await Promise.all([
        supabase.from('contracts').select('*').eq('id', id).single(),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('delivery_locations').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('field_plantings').select('season_year'),
      ])
      if (cancelled) return
      if (c.error || !c.data) {
        setErr(c.error?.message ?? 'Contract not found')
        return
      }
      setForm(toForm(c.data as Contract))
      setBuyers((b.data as Buyer[]) || [])
      setCrops((k.data as Crop[]) || [])
      setLocations((l.data as DeliveryLocation[]) || [])
      setEntities((en.data as Entity[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [id, supabase])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(plantings.map((p) => p.season_year)),
    [plantings],
  )

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))
  function setBuyer(buyerId: string) {
    setForm((f) => {
      const next = { ...f, buyer_id: buyerId }
      if (next.delivery_location_id) {
        const loc = locations.find((l) => l.id === next.delivery_location_id)
        if (!loc || loc.buyer_id !== buyerId) next.delivery_location_id = ''
      }
      return next
    })
  }
  const buyerLocations = locations.filter((l) => l.buyer_id === form.buyer_id)

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.contract_number.trim()) { setErr('Contract # is required'); return }
    if (form.delivery_type === 'delivered' && !form.delivery_location_id) {
      setErr('Pick a delivery location for delivered contracts.')
      return
    }
    setSaving(true)
    setErr(null)
    const { error } = await supabase.from('contracts').update(toPayload(form)).eq('id', id)
    setSaving(false)
    if (error) { setErr(error.message); return }
    router.push(`/contracts/${id}`)
    router.refresh()
  }

  if (!loaded) {
    return <div className="text-sm text-slate-500">{err ?? 'Loading…'}</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href={`/contracts/${id}`} className="text-sm text-sky-700">← Back to contract</Link>
        <h1 className="text-2xl font-bold flex-1">Edit contract</h1>
      </div>

      <form onSubmit={onSave} className="bg-white p-4 rounded-xl shadow space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input placeholder="Contract #" value={form.contract_number} onChange={(e) => set('contract_number', e.target.value)} className={INPUT_CLS} />
          <input type="number" step="0.01" placeholder="Contracted bushels" value={form.contracted_bushels} onChange={(e) => set('contracted_bushels', e.target.value)} className={INPUT_CLS} />
          <select value={form.buyer_id} onChange={(e) => setBuyer(e.target.value)} className={INPUT_CLS}>
            <option value="">— buyer —</option>
            {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select value={form.crop_id} onChange={(e) => set('crop_id', e.target.value)} className={INPUT_CLS}>
            <option value="">— crop —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="number" step="0.0001" placeholder="Price / bushel" value={form.price_per_bushel} onChange={(e) => set('price_per_bushel', e.target.value)} className={INPUT_CLS} />
          <select value={form.crop_year} onChange={(e) => set('crop_year', e.target.value)} className={INPUT_CLS}>
            <option value="">— crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={form.entity_id} onChange={(e) => set('entity_id', e.target.value)} className={INPUT_CLS}>
            <option value="">— entity —</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <label className="text-sm text-slate-700">
            Delivery start
            <input type="date" value={form.delivery_start_date} onChange={(e) => set('delivery_start_date', e.target.value)} className={`w-full ${INPUT_CLS}`} />
          </label>
          <label className="text-sm text-slate-700">
            Delivery end
            <input type="date" value={form.delivery_end_date} onChange={(e) => set('delivery_end_date', e.target.value)} className={`w-full ${INPUT_CLS}`} />
          </label>
          <input placeholder="Notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} className={`sm:col-span-2 ${INPUT_CLS}`} />
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <span className="text-sm font-semibold text-slate-700">Location:</span>
          <label className="text-sm flex items-center gap-1">
            <input
              type="radio"
              checked={form.delivery_type === 'pickup'}
              onChange={() => setForm((f) => ({ ...f, delivery_type: 'pickup', delivery_location_id: '' }))}
            />
            Pickup
          </label>
          <label className="text-sm flex items-center gap-1">
            <input
              type="radio"
              checked={form.delivery_type === 'delivered'}
              onChange={() => set('delivery_type', 'delivered')}
            />
            Delivered
          </label>
          {form.delivery_type === 'delivered' && (
            <>
              <select
                value={form.delivery_location_id}
                onChange={(e) => set('delivery_location_id', e.target.value)}
                className={INPUT_CLS}
                disabled={!form.buyer_id}
              >
                <option value="">{form.buyer_id ? '— delivery location —' : 'pick a buyer first'}</option>
                {buyerLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {form.buyer_id && buyerLocations.length === 0 && (
                <Link href="/settings/buyers" className="text-sm text-sky-700 underline">
                  Add a location for this buyer
                </Link>
              )}
            </>
          )}
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <Link href={`/contracts/${id}`} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
