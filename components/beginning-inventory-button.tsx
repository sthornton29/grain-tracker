'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Crop } from '@/lib/types'

type Props = { binId: string; binName: string; crops: Crop[]; defaultCropId: string | null }

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

export default function BeginningInventoryButton({ binId, binName, crops, defaultCropId }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [cropId, setCropId] = useState(defaultCropId ?? '')
  const [bushels, setBushels] = useState('')
  const [moisture, setMoisture] = useState('')
  const [asOf, setAsOf] = useState(todayISO())
  const [notes, setNotes] = useState('Existing inventory at onboarding')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function reset() {
    setCropId(defaultCropId ?? '')
    setBushels('')
    setMoisture('')
    setAsOf(todayISO())
    setNotes('Existing inventory at onboarding')
    setErr(null)
  }

  async function save() {
    setErr(null)
    if (!cropId) { setErr('Pick a crop.'); return }
    const bu = Number(bushels)
    if (!Number.isFinite(bu) || bu <= 0) { setErr('Bushels must be positive.'); return }
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.from('bin_inventory_adjustments').insert({
      bin_id: binId,
      crop_id: cropId,
      adjustment_type: 'beginning_inventory',
      bushels: bu,
      moisture: moisture === '' ? null : Number(moisture),
      as_of_date: asOf,
      notes: notes.trim() || null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setOpen(false)
    reset()
    router.refresh()
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs rounded-lg bg-white border border-slate-300 px-2 py-1 hover:bg-slate-50"
        title={`Add beginning inventory to bin ${binName}`}
      >
        + Beginning inventory
      </button>
    )
  }

  const inputCls = 'w-full rounded-lg border border-slate-300 px-2 py-1 text-sm'

  return (
    <div className="w-full mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
      <div className="text-sm font-semibold">Beginning inventory · Bin {binName}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-slate-700">
          Crop
          <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-700">
          Dry bushels
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={bushels}
            onChange={(e) => setBushels(e.target.value)}
            placeholder="e.g. 5000"
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-700">
          Moisture % <span className="text-slate-400">(optional)</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={moisture}
            onChange={(e) => setMoisture(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-700">
          As-of date
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      <label className="text-xs text-slate-700 block">
        Notes
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder='e.g. "Carried over from 2025 crop year"'
          className={inputCls}
        />
      </label>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="text-xs rounded-lg bg-brand hover:bg-brand-deep text-white font-semibold px-3 py-1 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); reset() }}
          className="text-xs rounded-lg bg-white border border-slate-300 px-3 py-1"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
