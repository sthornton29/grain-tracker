'use client'

import { useState } from 'react'
import Link from 'next/link'
import { parsePrice, fmtPrice } from '@/lib/hedging'
import {
  cashFromFuturesBasis,
  futuresFromCashBasis,
  basisFromCashFutures,
  pricingStatusFor,
  contractMonthOptionsForCrop,
  type ContractType,
} from '@/lib/contracts'
import type { Buyer, Contract, Crop, DeliveryLocation, Entity } from '@/lib/types'

export type ContractFormState = {
  contract_number: string
  buyer_id: string
  crop_id: string
  entity_id: string
  crop_year: string
  contracted_bushels: string
  delivery_type: 'pickup' | 'delivered'
  delivery_location_id: string
  delivery_start_date: string
  delivery_end_date: string
  notes: string
  contract_type: ContractType
  contract_month: string
  futures_price: string
  basis: string
  cash_price: string
  service_fee: string
  futures_set_date: string
  basis_set_date: string
}

export const emptyContractForm: ContractFormState = {
  contract_number: '', buyer_id: '', crop_id: '', entity_id: '', crop_year: '',
  contracted_bushels: '', delivery_type: 'pickup', delivery_location_id: '',
  delivery_start_date: '', delivery_end_date: '', notes: '',
  contract_type: 'forward', contract_month: '',
  futures_price: '', basis: '', cash_price: '', service_fee: '',
  futures_set_date: '', basis_set_date: '',
}

const s = (n: number | null | undefined) => (n == null ? '' : String(n))

export function contractToForm(c: Contract): ContractFormState {
  return {
    contract_number: c.contract_number,
    buyer_id: c.buyer_id ?? '',
    crop_id: c.crop_id ?? '',
    entity_id: c.entity_id ?? '',
    crop_year: c.crop_year != null ? String(c.crop_year) : '',
    contracted_bushels: c.contracted_bushels?.toString() ?? '',
    delivery_type: c.delivery_type,
    delivery_location_id: c.delivery_location_id ?? '',
    delivery_start_date: c.delivery_start_date ?? '',
    delivery_end_date: c.delivery_end_date ?? '',
    notes: c.notes ?? '',
    contract_type: c.contract_type ?? 'forward',
    contract_month: c.contract_month ?? '',
    futures_price: s(c.futures_price),
    basis: s(c.basis),
    cash_price: s(c.cash_price ?? c.price_per_bushel),
    service_fee: c.service_fee ? String(c.service_fee) : '',
    futures_set_date: c.futures_set_date ?? '',
    basis_set_date: c.basis_set_date ?? '',
  }
}

// Build the DB payload. cash_price is canonical; price_per_bushel is kept in
// sync so existing readers (cash flow, contract list/detail) keep working.
export function contractFormToPayload(f: ContractFormState) {
  const futures = parsePrice(f.futures_price)
  const basis = parsePrice(f.basis)
  const fee = parsePrice(f.service_fee) ?? 0
  const pricing_status = pricingStatusFor(f.contract_type, { futures, basis })
  // Cash is known only when fully priced; otherwise it's pending.
  const cash = pricing_status === 'fully_priced'
    ? (parsePrice(f.cash_price) ?? (futures != null && basis != null ? cashFromFuturesBasis(futures, basis, fee) : null))
    : null
  return {
    contract_number: f.contract_number.trim(),
    buyer_id: f.buyer_id || null,
    crop_id: f.crop_id || null,
    entity_id: f.entity_id || null,
    crop_year: f.crop_year === '' ? null : Number(f.crop_year),
    contracted_bushels: f.contracted_bushels === '' ? 0 : Number(f.contracted_bushels),
    delivery_type: f.delivery_type,
    delivery_location_id: f.delivery_type === 'delivered' ? (f.delivery_location_id || null) : null,
    delivery_start_date: f.delivery_start_date || null,
    delivery_end_date: f.delivery_end_date || null,
    notes: f.notes || null,
    contract_type: f.contract_type,
    contract_month: f.contract_month || null,
    futures_price: futures,
    basis,
    service_fee: fee,
    cash_price: cash,
    price_per_bushel: cash, // keep legacy column in sync
    futures_set_date: f.futures_set_date || null,
    basis_set_date: f.basis_set_date || null,
    pricing_status,
  }
}

export function validateContractForm(f: ContractFormState): string | null {
  if (!f.contract_number.trim()) return 'Contract # is required.'
  if (f.delivery_type === 'delivered' && !f.delivery_location_id) return 'Pick a delivery location for delivered contracts.'
  if (f.contract_type === 'hta' && parsePrice(f.futures_price) == null) return 'HTA contracts need a futures price.'
  if (f.contract_type === 'basis' && parsePrice(f.basis) == null) return 'Basis contracts need a basis.'
  return null
}

const INPUT_CLS = 'rounded-lg border border-slate-300 px-3 py-2'
const PENDING = 'rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-slate-400'

export function ContractFields({
  value, onChange, buyers, crops, locations, entities, cropYearOptions,
}: {
  value: ContractFormState
  onChange: (f: ContractFormState) => void
  buyers: Buyer[]
  crops: Crop[]
  locations: DeliveryLocation[]
  entities: Entity[]
  cropYearOptions: number[]
}) {
  const f = value
  // Order of manually-edited price legs; the leg NOT among the last two is the
  // one auto-derived (forward contracts only).
  const [manualOrder, setManualOrder] = useState<Array<'futures' | 'basis' | 'cash'>>([])
  const [autoField, setAutoField] = useState<'futures' | 'basis' | 'cash' | null>(null)
  // Unlock the deferred leg on HTA (basis) / Basis (futures) contracts.
  const [unlocked, setUnlocked] = useState(false)

  const set = <K extends keyof ContractFormState>(k: K, v: ContractFormState[K]) => onChange({ ...f, [k]: v })

  const cropName = crops.find((c) => c.id === f.crop_id)?.name ?? null
  const monthOptions = contractMonthOptionsForCrop(cropName)
  const buyerLocations = locations.filter((l) => l.buyer_id === f.buyer_id)

  function setBuyer(id: string) {
    const next = { ...f, buyer_id: id }
    if (next.delivery_location_id) {
      const loc = locations.find((l) => l.id === next.delivery_location_id)
      if (!loc || loc.buyer_id !== id) next.delivery_location_id = ''
    }
    onChange(next)
  }

  function setType(t: ContractType) {
    setManualOrder([]); setAutoField(null); setUnlocked(false)
    onChange({ ...f, contract_type: t })
  }

  // Forward auto-calc: editing one leg derives the third when the other two are set.
  function editForwardLeg(leg: 'futures' | 'basis' | 'cash', raw: string) {
    const key = leg === 'futures' ? 'futures_price' : leg === 'basis' ? 'basis' : 'cash_price'
    const order = [...manualOrder.filter((x) => x !== leg), leg].slice(-2)
    let next = { ...f, [key]: raw }
    const fee = parsePrice(next.service_fee) ?? 0
    let auto: typeof autoField = null
    if (order.length === 2) {
      const derived = (['futures', 'basis', 'cash'] as const).find((x) => !order.includes(x))!
      const F = parsePrice(next.futures_price)
      const B = parsePrice(next.basis)
      const C = parsePrice(next.cash_price)
      if (derived === 'cash' && F != null && B != null) { next = { ...next, cash_price: String(cashFromFuturesBasis(F, B, fee)) }; auto = 'cash' }
      else if (derived === 'futures' && C != null && B != null) { next = { ...next, futures_price: String(futuresFromCashBasis(C, B, fee)) }; auto = 'futures' }
      else if (derived === 'basis' && C != null && F != null) { next = { ...next, basis: String(basisFromCashFutures(C, F, fee)) }; auto = 'basis' }
    }
    setManualOrder(order); setAutoField(auto); onChange(next)
  }

  function editServiceFee(raw: string) {
    const next = { ...f, service_fee: raw }
    const fee = parsePrice(raw) ?? 0
    const F = parsePrice(next.futures_price)
    const B = parsePrice(next.basis)
    const C = parsePrice(next.cash_price)
    if (f.contract_type === 'forward') {
      if (autoField === 'cash' && F != null && B != null) next.cash_price = String(cashFromFuturesBasis(F, B, fee))
      else if (autoField === 'futures' && C != null && B != null) next.futures_price = String(futuresFromCashBasis(C, B, fee))
      else if (autoField === 'basis' && C != null && F != null) next.basis = String(basisFromCashFutures(C, F, fee))
    } else {
      next.cash_price = F != null && B != null ? String(cashFromFuturesBasis(F, B, fee)) : ''
    }
    onChange(next)
  }

  // HTA / Basis: cash is always derived from futures + basis − fee once both exist.
  function editDeferredLeg(key: 'futures_price' | 'basis', raw: string) {
    const next = { ...f, [key]: raw }
    const setDateKey = key === 'basis' ? 'basis_set_date' : 'futures_set_date'
    if (raw && !next[setDateKey]) next[setDateKey] = todayISO()
    const F = parsePrice(next.futures_price)
    const B = parsePrice(next.basis)
    const fee = parsePrice(next.service_fee) ?? 0
    next.cash_price = F != null && B != null ? String(cashFromFuturesBasis(F, B, fee)) : ''
    onChange(next)
  }

  const autoCls = (field: 'futures' | 'basis' | 'cash') =>
    `${INPUT_CLS} w-full ${autoField === field ? 'italic text-slate-500 bg-slate-50' : ''}`

  const F = parsePrice(f.futures_price)
  const B = parsePrice(f.basis)
  const fee = parsePrice(f.service_fee) ?? 0
  const previewCash = F != null && B != null ? cashFromFuturesBasis(F, B, fee) : null

  return (
    <div className="space-y-3">
      {/* Contract type */}
      <div>
        <span className="text-sm font-semibold text-slate-700">Contract type</span>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {([['forward', 'Forward'], ['hta', 'HTA'], ['basis', 'Basis']] as const).map(([t, label]) => (
            <button key={t} type="button" onClick={() => setType(t)}
              className={`py-2 rounded-lg border text-sm font-semibold ${f.contract_type === t ? 'bg-green-700 text-white border-green-700' : 'bg-white border-slate-300'}`}>
              {label}
            </button>
          ))}
        </div>
        {f.contract_type === 'hta' && <p className="text-xs text-sky-700 mt-1">Hedge-to-Arrive: lock in futures price now, set basis later.</p>}
        {f.contract_type === 'basis' && <p className="text-xs text-sky-700 mt-1">Basis contract: lock in basis now, set futures price later.</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input placeholder="Contract #" value={f.contract_number} onChange={(e) => set('contract_number', e.target.value)} className={INPUT_CLS} />
        <input type="number" step="0.01" placeholder="Contracted bushels" value={f.contracted_bushels} onChange={(e) => set('contracted_bushels', e.target.value)} className={INPUT_CLS} />
        <select value={f.buyer_id} onChange={(e) => setBuyer(e.target.value)} className={INPUT_CLS}>
          <option value="">— buyer —</option>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select value={f.crop_id} onChange={(e) => onChange({ ...f, crop_id: e.target.value, contract_month: '' })} className={INPUT_CLS}>
          <option value="">— crop —</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="text-sm text-slate-700">
          Contract month <span className="text-xs text-slate-400">optional</span>
          <select value={f.contract_month} onChange={(e) => set('contract_month', e.target.value)} className={`w-full ${INPUT_CLS}`}>
            <option value="">— select —</option>
            {f.contract_month && !monthOptions.some((m) => m.label === f.contract_month) && <option value={f.contract_month}>{f.contract_month}</option>}
            {monthOptions.map((m) => <option key={m.label} value={m.label}>{m.label}</option>)}
          </select>
        </label>
        <select value={f.crop_year} onChange={(e) => set('crop_year', e.target.value)} className={INPUT_CLS}>
          <option value="">— crop year —</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={f.entity_id} onChange={(e) => set('entity_id', e.target.value)} className={INPUT_CLS}>
          <option value="">— entity —</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>

      {/* Pricing block */}
      <fieldset className="border border-slate-200 rounded-lg p-3 space-y-2">
        <legend className="px-2 text-sm font-semibold text-slate-700">Pricing</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {/* Futures */}
          <label className="text-sm text-slate-700">
            Futures price
            {f.contract_type === 'basis' && !unlocked ? (
              <div className="mt-1 flex gap-1">
                <div className={`flex-1 ${PENDING}`}>To be set</div>
                <button type="button" onClick={() => setUnlocked(true)} className="rounded-lg bg-sky-600 text-white px-2 text-xs">Set Futures</button>
              </div>
            ) : (
              <input
                type="text" inputMode="decimal" placeholder="4.80" value={f.futures_price}
                onChange={(e) => (f.contract_type === 'forward' ? editForwardLeg('futures', e.target.value) : editDeferredLeg('futures_price', e.target.value))}
                className={autoCls('futures')}
              />
            )}
          </label>
          {/* Basis */}
          <label className="text-sm text-slate-700">
            Basis
            {f.contract_type === 'hta' && !unlocked ? (
              <div className="mt-1 flex gap-1">
                <div className={`flex-1 ${PENDING}`}>To be set</div>
                <button type="button" onClick={() => setUnlocked(true)} className="rounded-lg bg-sky-600 text-white px-2 text-xs">Set Basis</button>
              </div>
            ) : (
              <input
                type="text" inputMode="decimal" placeholder="-0.30" value={f.basis}
                onChange={(e) => (f.contract_type === 'forward' ? editForwardLeg('basis', e.target.value) : editDeferredLeg('basis', e.target.value))}
                className={autoCls('basis')}
              />
            )}
          </label>
          {/* Cash */}
          <label className="text-sm text-slate-700">
            Cash price
            {f.contract_type === 'forward' ? (
              <input type="text" inputMode="decimal" placeholder="4.50" value={f.cash_price} onChange={(e) => editForwardLeg('cash', e.target.value)} className={autoCls('cash')} />
            ) : (
              <div className={`mt-1 ${PENDING}`}>
                {previewCash != null ? fmtPrice(previewCash) : f.contract_type === 'hta' ? 'Pending — awaiting basis' : 'Pending — awaiting futures'}
              </div>
            )}
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className="text-sm text-slate-700">
            Service fee <span className="text-xs text-slate-400">optional, $/bu</span>
            <input type="text" inputMode="decimal" placeholder="0.00" value={f.service_fee}
              onChange={(e) => editServiceFee(e.target.value)}
              className={`w-full ${INPUT_CLS}`} />
          </label>
          {previewCash != null && f.contract_type !== 'forward' && (
            <div className="text-xs text-slate-500 self-end pb-2 sm:col-span-2">
              Cash = Futures {fmtPrice(F)} + Basis {B! >= 0 ? '+' : ''}{B} − Fee {fee} = <b>{fmtPrice(previewCash)}</b>
            </div>
          )}
        </div>
        {f.contract_type === 'forward' && <p className="text-xs text-slate-500">Enter any two of futures / basis / cash and the third is calculated (shown italic). You can also just enter the flat cash price.</p>}
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-slate-700">Location:</span>
        <label className="text-sm flex items-center gap-1">
          <input type="radio" checked={f.delivery_type === 'pickup'} onChange={() => onChange({ ...f, delivery_type: 'pickup', delivery_location_id: '' })} />
          Pickup
        </label>
        <label className="text-sm flex items-center gap-1">
          <input type="radio" checked={f.delivery_type === 'delivered'} onChange={() => set('delivery_type', 'delivered')} />
          Delivered
        </label>
        {f.delivery_type === 'delivered' && (
          <>
            <select value={f.delivery_location_id} onChange={(e) => set('delivery_location_id', e.target.value)} className={INPUT_CLS} disabled={!f.buyer_id}>
              <option value="">{f.buyer_id ? '— delivery location —' : 'pick a buyer first'}</option>
              {buyerLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {f.buyer_id && buyerLocations.length === 0 && (
              <Link href="/settings/buyers" className="text-sm text-sky-700 underline">Add a location for this buyer</Link>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}
