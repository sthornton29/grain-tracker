'use client'

import { useState } from 'react'
import { parsePrice, fmtPrice } from '@/lib/hedging'
import { BuyerPicker, DeliveryLocationPicker } from '@/components/buyer-location-pickers'
import EntitySelect from '@/components/entity-select'
import {
  cashFromFuturesBasis,
  futuresFromCashBasis,
  basisFromCashFutures,
  pricingStatusFor,
  effectiveContractType,
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
  date_sold: string
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
  delivery_start_date: '', delivery_end_date: '', date_sold: '', notes: '',
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
    date_sold: c.date_sold ?? '',
    notes: c.notes ?? '',
    // A contract with both legs reads as a forward (see effectiveContractType), so
    // the editor opens with all three price legs visible instead of locking one.
    contract_type: effectiveContractType(c),
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
  // A contract with BOTH a futures price and a basis is a standard forward (fully
  // priced), even if it started as an HTA (basis added later) or a basis contract
  // (futures added later). Promote the stored type so it reads correctly everywhere.
  const contract_type: ContractType = futures != null && basis != null ? 'forward' : f.contract_type
  const pricing_status = pricingStatusFor(contract_type, { futures, basis })
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
    date_sold: f.date_sold || null,
    notes: f.notes || null,
    contract_type,
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

/** Which form field a validation message belongs to, so the form can
 *  highlight it. */
export type ContractFieldKey =
  | 'contract_number' | 'buyer_id' | 'crop_id' | 'crop_year' | 'contracted_bushels'
  | 'delivery_location_id' | 'futures_price' | 'basis' | 'cash_price'
export type ContractFieldErrors = Partial<Record<ContractFieldKey, string>>

/** Every problem on the form, keyed by field — plain sentences a farmer can
 *  act on. Empty object = ready to save. */
export function validateContractFields(f: ContractFormState): ContractFieldErrors {
  const errors: ContractFieldErrors = {}
  if (!f.contract_number.trim()) errors.contract_number = 'Enter the contract number.'
  if (!f.buyer_id) errors.buyer_id = 'Who is this contract with?'
  if (!f.crop_id) errors.crop_id = 'Which crop is this contract for?'
  if (!f.crop_year) errors.crop_year = 'Which crop year does this contract cover?'
  const bu = f.contracted_bushels.trim() === '' ? null : Number(f.contracted_bushels)
  if (bu == null || !Number.isFinite(bu) || bu <= 0) errors.contracted_bushels = 'How many bushels are contracted?'
  if (f.delivery_type === 'delivered' && !f.delivery_location_id) errors.delivery_location_id = 'Pick where this contract delivers to.'
  if (f.contract_type === 'hta' && parsePrice(f.futures_price) == null) errors.futures_price = 'An HTA needs its futures price.'
  if (f.contract_type === 'basis' && parsePrice(f.basis) == null) errors.basis = 'A basis contract needs its basis.'
  // When all three pricing legs are entered they must reconcile.
  const F = parsePrice(f.futures_price)
  const B = parsePrice(f.basis)
  const C = parsePrice(f.cash_price)
  const fee = parsePrice(f.service_fee) ?? 0
  if (F != null && B != null && C != null && Math.abs(C - (F + B - fee)) > 0.005) {
    errors.cash_price = `Cash price should equal futures + basis${fee ? ' − service fee' : ''}. Check the basis sign or the numbers.`
  }
  return errors
}

/** The first problem as one sentence (null when the form is ready to save). */
export function validateContractForm(f: ContractFormState): string | null {
  const errors = validateContractFields(f)
  const order: ContractFieldKey[] = ['contract_number', 'buyer_id', 'crop_id', 'crop_year', 'contracted_bushels', 'delivery_location_id', 'futures_price', 'basis', 'cash_price']
  for (const k of order) if (errors[k]) return errors[k]!
  return null
}

const INPUT_CLS = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11'
const INPUT_ERR = 'border-red-500 bg-red-50'
const PENDING = 'rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-slate-400'

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null
  return <span className="block text-xs text-red-700 mt-0.5" role="alert">{msg}</span>
}

export function ContractFields({
  value, onChange, buyers, crops, locations, entities, cropYearOptions, onBuyerCreated, onLocationCreated, errors = {},
}: {
  value: ContractFormState
  onChange: (f: ContractFormState) => void
  buyers: Buyer[]
  crops: Crop[]
  locations: DeliveryLocation[]
  entities: Entity[]
  cropYearOptions: number[]
  /** Inline "+ Add new…" creations — the parent appends the row to its list. */
  onBuyerCreated?: (b: Buyer) => void
  onLocationCreated?: (l: DeliveryLocation) => void
  /** Field-level problems from validateContractFields — highlights the
   *  field and prints the sentence under it. */
  errors?: ContractFieldErrors
}) {
  const f = value
  const errCls = (k: ContractFieldKey) => (errors[k] ? ` ${INPUT_ERR}` : '')
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
  const C = parsePrice(f.cash_price)
  const fee = parsePrice(f.service_fee) ?? 0
  const previewCash = F != null && B != null ? cashFromFuturesBasis(F, B, fee) : null
  // Flag when all three legs are present but don't reconcile (e.g. a flipped
  // basis sign): cash should equal futures + basis − fee.
  const priceMismatch = F != null && B != null && C != null && Math.abs(C - (F + B - fee)) > 0.005

  return (
    <div className="space-y-3">
      {/* Contract type */}
      <div>
        <span className="text-sm font-semibold text-slate-700">Contract type</span>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {([['forward', 'Forward'], ['hta', 'HTA'], ['basis', 'Basis']] as const).map(([t, label]) => (
            <button key={t} type="button" onClick={() => setType(t)}
              className={`py-2 rounded-lg border text-sm font-semibold ${f.contract_type === t ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white border-slate-300'}`}>
              {label}
            </button>
          ))}
        </div>
        {f.contract_type === 'hta' && <p className="text-xs text-brand-deep mt-1">Hedge-to-Arrive: lock in futures price now, set basis later.</p>}
        {f.contract_type === 'basis' && <p className="text-xs text-brand-deep mt-1">Basis contract: lock in basis now, set futures price later.</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-sm text-slate-700">
          Contract #
          <input value={f.contract_number} onChange={(e) => set('contract_number', e.target.value)} className={`w-full ${INPUT_CLS}${errCls('contract_number')}`} aria-invalid={!!errors.contract_number} />
          <FieldError msg={errors.contract_number} />
        </label>
        <label className="text-sm text-slate-700">
          Contracted bushels
          <input type="text" inputMode="decimal" placeholder="e.g. 10,000" value={f.contracted_bushels} onChange={(e) => set('contracted_bushels', e.target.value.replace(/,/g, ''))} className={`w-full ${INPUT_CLS}${errCls('contracted_bushels')}`} aria-invalid={!!errors.contracted_bushels} />
          <FieldError msg={errors.contracted_bushels} />
        </label>
        <div className="text-sm text-slate-700">
          <span className="block">Buyer</span>
          <BuyerPicker value={f.buyer_id} onChange={setBuyer} buyers={buyers} onCreated={onBuyerCreated} className={`w-full ${INPUT_CLS}${errCls('buyer_id')}`} />
          <FieldError msg={errors.buyer_id} />
        </div>
        <label className="text-sm text-slate-700">
          Crop
          <select value={f.crop_id} onChange={(e) => onChange({ ...f, crop_id: e.target.value, contract_month: '' })} className={`w-full ${INPUT_CLS}${errCls('crop_id')}`} aria-invalid={!!errors.crop_id}>
            <option value="">— pick a crop —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <FieldError msg={errors.crop_id} />
        </label>
        <label className="text-sm text-slate-700">
          Contract month <span className="text-xs text-slate-400">optional</span>
          <select value={f.contract_month} onChange={(e) => set('contract_month', e.target.value)} className={`w-full ${INPUT_CLS}`}>
            <option value="">— select —</option>
            {f.contract_month && !monthOptions.some((m) => m.label === f.contract_month) && <option value={f.contract_month}>{f.contract_month}</option>}
            {monthOptions.map((m) => <option key={m.label} value={m.label}>{m.label}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-700">
          Crop year
          <select value={f.crop_year} onChange={(e) => set('crop_year', e.target.value)} className={`w-full ${INPUT_CLS}${errCls('crop_year')}`} aria-invalid={!!errors.crop_year}>
            <option value="">— pick a crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <FieldError msg={errors.crop_year} />
        </label>
        <label className="text-sm text-slate-700">
          Entity
          <EntitySelect
            entities={entities}
            value={f.entity_id}
            onChange={(id) => set('entity_id', id)}
            className={`w-full ${INPUT_CLS}`}
            showWhenSingle
          />
        </label>
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
                className={`${autoCls('futures')}${errCls('futures_price')}`}
                aria-invalid={!!errors.futures_price}
              />
            )}
            <FieldError msg={errors.futures_price} />
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
                className={`${autoCls('basis')}${errCls('basis')}`}
                aria-invalid={!!errors.basis}
              />
            )}
            <FieldError msg={errors.basis} />
          </label>
          {/* Cash */}
          <label className="text-sm text-slate-700">
            Cash price
            {f.contract_type === 'forward' ? (
              <>
                <input type="text" inputMode="decimal" placeholder="4.50" value={f.cash_price} onChange={(e) => editForwardLeg('cash', e.target.value)} className={`${autoCls('cash')}${errCls('cash_price')}`} aria-invalid={!!errors.cash_price} />
                <FieldError msg={errors.cash_price} />
              </>
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
        {priceMismatch && (
          <p className="rounded-lg bg-amber-50 border border-amber-200 px-2 py-1 text-xs text-amber-800">
            ⚠ Cash price {fmtPrice(C)} doesn’t equal futures + basis{fee ? ' − fee' : ''} ({fmtPrice(F! + B! - fee)}). Check the basis sign.
          </p>
        )}
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
        <label className="text-sm text-slate-700">
          Date sold <span className="text-slate-400">(optional)</span>
          <input type="date" value={f.date_sold} onChange={(e) => set('date_sold', e.target.value)} className={`w-full ${INPUT_CLS}`} />
        </label>
        <label className="text-sm text-slate-700">
          Notes <span className="text-slate-400">(optional)</span>
          <input value={f.notes} onChange={(e) => set('notes', e.target.value)} className={`w-full ${INPUT_CLS}`} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-slate-700">Delivery:</span>
        <label className="text-sm flex items-center gap-1">
          <input type="radio" checked={f.delivery_type === 'pickup'} onChange={() => onChange({ ...f, delivery_type: 'pickup', delivery_location_id: '' })} />
          Pickup
        </label>
        <label className="text-sm flex items-center gap-1">
          <input type="radio" checked={f.delivery_type === 'delivered'} onChange={() => set('delivery_type', 'delivered')} />
          Delivered
        </label>
        {f.delivery_type === 'delivered' && (
          <div>
            <DeliveryLocationPicker
              value={f.delivery_location_id}
              onChange={(id) => set('delivery_location_id', id)}
              buyerId={f.buyer_id}
              buyerName={buyers.find((b) => b.id === f.buyer_id)?.name ?? null}
              locations={buyerLocations}
              onCreated={onLocationCreated}
              className={`${INPUT_CLS}${errCls('delivery_location_id')}`}
            />
            <FieldError msg={errors.delivery_location_id} />
          </div>
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
