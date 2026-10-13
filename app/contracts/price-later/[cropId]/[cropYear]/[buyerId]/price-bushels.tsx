'use client'

// "Price bushels" on a price-later pool: a small form (bushels, price, date,
// optional contract number + notes), a confirmation, then the server action
// creates the contract and moves the oldest bushels onto it.

import { useState, useTransition } from 'react'
import { ConfirmDialog } from '@/components/app-dialog'
import { fmtInt, fmtUsd } from '@/components/reports/report-kit'
import { priceBushels } from './actions'

const INPUT_CLS = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function PriceBushels({
  cropId, cropYear, buyerId, poolBushels,
}: {
  cropId: string
  cropYear: number
  buyerId: string
  poolBushels: number
}) {
  const [open, setOpen] = useState(false)
  const [bushels, setBushels] = useState(String(Math.round(poolBushels * 1000) / 1000))
  const [price, setPrice] = useState('')
  const [date, setDate] = useState(todayIso())
  const [contractNumber, setContractNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  const bu = Math.min(Number(bushels) || 0, poolBushels)
  const px = Number(price) || 0

  function validate(): string | null {
    if (!(Number(bushels) > 0)) return 'Enter how many bushels to price.'
    if (!(px > 0)) return 'Enter the price per bushel.'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Pick the date.'
    return null
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const v = validate()
    if (v) { setErr(v); return }
    setErr(null)
    setConfirming(true)
  }

  function doPrice() {
    startTransition(async () => {
      const res = await priceBushels({
        cropId, cropYear, buyerId,
        bushels: bu, pricePerBushel: px, date,
        contractNumber: contractNumber.trim() || null,
        notes: notes.trim() || null,
      })
      // On success the action redirects to the new contract; only a failure returns.
      if (res && !res.ok) { setErr(res.error); setConfirming(false) }
    })
  }

  const btn = 'rounded-lg px-4 min-h-11 text-sm font-semibold disabled:opacity-50'

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">Price bushels</h2>
          <p className="text-sm text-slate-500">Lock in a price with the buyer: this creates a contract and moves the oldest bushels onto it.</p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className={`${btn} bg-brand text-white hover:bg-brand-deep`}>
            Price bushels
          </button>
        )}
      </div>
      {open && (
        <form onSubmit={onSubmit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Bushels to price</span>
            <input type="number" inputMode="decimal" step="any" min="0" max={poolBushels} value={bushels} onChange={(e) => setBushels(e.target.value)} className={INPUT_CLS} />
            <span className="text-xs text-slate-400">{fmtInt(poolBushels)} bu unpriced</span>
          </label>
          <label className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Price $/bu</span>
            <input type="number" inputMode="decimal" step="0.0001" min="0" value={price} onChange={(e) => setPrice(e.target.value)} className={INPUT_CLS} placeholder="13.50" />
          </label>
          <label className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Date priced</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT_CLS} />
          </label>
          <label className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Contract number <span className="text-slate-400">(optional)</span></span>
            <input type="text" value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} className={INPUT_CLS} placeholder="fill in when the buyer confirms" />
          </label>
          <label className="text-sm flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
            <span className="text-slate-500">Notes <span className="text-slate-400">(optional)</span></span>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={INPUT_CLS} />
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" disabled={pending} className={`${btn} bg-brand text-white hover:bg-brand-deep`}>
              {pending ? 'Pricing…' : 'Price bushels'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setErr(null) }} className={`${btn} border border-slate-300 bg-white text-slate-700`}>
              Cancel
            </button>
          </div>
          {err && <p className="text-sm text-red-700 sm:col-span-2 lg:col-span-4" role="alert">{err}</p>}
        </form>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Price ${fmtInt(bu)} bu at ${fmtUsd(px, 2)}?`}
        body={
          <p>
            Price {fmtInt(bu)} bu at {fmtUsd(px, 2)} — this creates a contract and moves the oldest {fmtInt(bu)} bu onto it.
            {bu < poolBushels ? ` The other ${fmtInt(poolBushels - bu)} bu stay unpriced.` : ''}
          </p>
        }
        confirmLabel="Price bushels"
        busy={pending}
        onConfirm={doPrice}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
