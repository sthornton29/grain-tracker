'use client'

// The load form's Truck controls.
//
// TruckPicker — the operation's OWN trucks with an inline "+ Add truck…"
// (the buyer-location-pickers pattern: compact modal, case-insensitive
// duplicate guard, auto-select on save). Used on non-pickup loads.
//
// HaulerTruckField — the pickup-contract variant: the buyer's trucks load at
// the farm, so the truck is free text (loads.hauler_truck), with previously
// saved hauler trucks offered in a "Hauler trucks" group and the operation's
// own trucks still selectable at the bottom (never the default). A typed
// truck can be flagged for saving to external_trucks — the save itself
// happens on load submit (the load form owns the insert).
//
// THE CLASSIFICATION RULE: a truck saved from a pickup-contract load is
// EXTERNAL (external_trucks — someone else's truck); a truck saved anywhere
// else is OURS (trucks). The two lists never mix.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { findExternalTruck } from '@/lib/trucks'
import type { ExternalTruck, Truck } from '@/lib/types'

export { findExternalTruck }

const ADD_NEW = '__add_new__'
const TYPE_IN = '__type_in__'
const INPUT = 'w-full rounded-lg border border-slate-300 px-3 py-2'

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4 no-print" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-4 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-lg">{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function TruckPicker({ value, onChange, trucks, onCreated, className }: {
  value: string
  onChange: (id: string) => void
  trucks: Truck[]
  /** Called with the created row so the parent can add it to its list. */
  onCreated?: (t: Truck) => void
  className?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [dupe, setDupe] = useState<Truck | null>(null)

  function close() { setOpen(false); setName(''); setErr(null); setDupe(null) }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    const trimmed = name.trim()
    if (!trimmed) { setErr('Name is required.'); return }
    // Case-insensitive duplicate check → offer the existing record first.
    const existing = trucks.find((t) => t.name_or_number.trim().toLowerCase() === trimmed.toLowerCase())
    if (existing && dupe?.id !== existing.id) { setDupe(existing); return }
    setBusy(true)
    const { data, error } = await supabase.from('trucks').insert({ name_or_number: trimmed }).select('*').single()
    setBusy(false)
    if (error || !data) { setErr(error?.message ?? 'Could not create the truck.'); return }
    const created = data as Truck
    onCreated?.(created)
    onChange(created.id)
    close()
  }

  return (
    <>
      <select
        value={value}
        onChange={(e) => { if (e.target.value === ADD_NEW) setOpen(true); else onChange(e.target.value) }}
        className={className ?? INPUT}
      >
        <option value="">— select —</option>
        {trucks.map((t) => <option key={t.id} value={t.id}>{t.name_or_number}</option>)}
        <option value={ADD_NEW}>+ Add truck…</option>
      </select>
      {open && (
        <Modal title="New Truck" onClose={close}>
          <form onSubmit={create} className="space-y-2">
            <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setDupe(null) }} placeholder="Truck name or number (required)" className={INPUT} />
            <p className="text-xs text-slate-500">Saves to your truck list (Settings → Trucks).</p>
            {dupe && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 space-y-1.5">
                <p>A truck named <b>{dupe.name_or_number}</b> already exists.</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { onChange(dupe.id); close() }} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1.5 text-sm font-semibold">Use existing</button>
                  <button type="submit" className="rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm">Create anyway</button>
                </div>
              </div>
            )}
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={close} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">
                {busy ? 'Saving…' : 'Add Truck'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

export function HaulerTruckField({
  haulerTruck,
  truckId,
  onChangeHauler,
  onChangeTruckId,
  externalTrucks,
  trucks,
  saveTruck,
  onChangeSaveTruck,
  className,
}: {
  /** Free-text hauler truck (loads.hauler_truck). */
  haulerTruck: string
  /** Own-truck id — only when the user explicitly hauls it themselves. */
  truckId: string
  onChangeHauler: (text: string) => void
  onChangeTruckId: (id: string) => void
  externalTrucks: ExternalTruck[]
  trucks: Truck[]
  /** "Save this truck" — the parent inserts into external_trucks on submit. */
  saveTruck: boolean
  onChangeSaveTruck: (v: boolean) => void
  className?: string
}) {
  const matched = findExternalTruck(externalTrucks, haulerTruck)
  // Typing stays sticky once chosen so a cleared input doesn't snap the
  // select back to the placeholder mid-edit.
  const [typingPicked, setTypingPicked] = useState(false)
  const typing = truckId === '' && (typingPicked || (haulerTruck.trim() !== '' && !matched))

  const selectValue = truckId
    ? `own:${truckId}`
    : typing
    ? TYPE_IN
    : matched
    ? `ext:${matched.id}`
    : ''

  function onSelect(v: string) {
    if (v === TYPE_IN) {
      setTypingPicked(true)
      onChangeTruckId('')
      return
    }
    setTypingPicked(false)
    if (v === '') { onChangeTruckId(''); onChangeHauler(''); onChangeSaveTruck(false); return }
    if (v.startsWith('ext:')) {
      const t = externalTrucks.find((x) => x.id === v.slice(4))
      onChangeTruckId('')
      onChangeHauler(t?.name ?? '')
      onChangeSaveTruck(false)
      return
    }
    if (v.startsWith('own:')) {
      onChangeTruckId(v.slice(4))
      onChangeHauler('')
      onChangeSaveTruck(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <select value={selectValue} onChange={(e) => onSelect(e.target.value)} className={className ?? INPUT}>
        <option value="">— hauler’s truck —</option>
        {externalTrucks.length > 0 && (
          <optgroup label="Hauler trucks">
            {externalTrucks.map((t) => <option key={t.id} value={`ext:${t.id}`}>{t.name}</option>)}
          </optgroup>
        )}
        <option value={TYPE_IN}>✎ Type a truck…</option>
        {trucks.length > 0 && (
          <optgroup label="Your trucks (if you haul it yourself)">
            {trucks.map((t) => <option key={t.id} value={`own:${t.id}`}>{t.name_or_number}</option>)}
          </optgroup>
        )}
      </select>
      {typing && (
        <>
          <input
            value={haulerTruck}
            onChange={(e) => onChangeHauler(e.target.value)}
            placeholder="Hauler’s truck (e.g. JD Trucking 12)"
            className={className ?? INPUT}
          />
          {haulerTruck.trim() !== '' && !matched && (
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={saveTruck} onChange={(e) => onChangeSaveTruck(e.target.checked)} />
              Save this truck for future pickup loads
            </label>
          )}
        </>
      )}
      <p className="text-[11px] text-slate-500">
        Pickup contract — the buyer’s truck loads at your farm. Type or pick the hauler’s truck; your own trucks are at the bottom if you haul it yourself.
      </p>
    </div>
  )
}
