'use client'

// The load form's Truck controls.
//
// TruckPicker — the operation's OWN trucks with an inline "+ Add truck…"
// (the buyer-location-pickers pattern: compact modal, case-insensitive
// duplicate guard, auto-select on save) and a small ✎ edit affordance for
// renaming the selected truck. Used on non-pickup loads.
//
// HaulerTruckField — the pickup-contract variant: the buyer's trucks load at
// the farm, so the truck is free text (loads.hauler_truck), with previously
// saved hauler trucks offered in a "Hauler trucks" group (with the same ✎
// rename) and the operation's own trucks still selectable at the bottom
// (never the default). A typed truck can be flagged for saving to
// external_trucks — the save itself happens on load submit (the load form
// owns the insert).
//
// THE CLASSIFICATION RULE: a truck saved from a pickup-contract load is
// EXTERNAL (external_trucks — someone else's truck); a truck saved anywhere
// else is OURS (trucks). The two lists never mix.
//
// THE SNAPSHOT RULE (071): renaming a truck changes the picker and future
// loads only — past loads keep the label captured when they were entered
// (loads.truck_label / loads.hauler_truck). Both edit modals say so.
//
// NESTED-FORM WARNING: unlike the buyer/location pickers (whose hosts are
// div-based), these live INSIDE the load page's real <form>. A submit fired
// in a modal's nested <form> BUBBLES to the outer form in React's synthetic
// event system — without stopPropagation the outer form would save a
// half-entered load and navigate away, discarding the modal's result and
// swallowing its errors. Every modal submit handler here must call
// e.stopPropagation() alongside e.preventDefault().

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getOrgId } from '@/lib/org'
import { findExternalTruck, ownTruckInsert } from '@/lib/trucks'
import type { ExternalTruck, Truck } from '@/lib/types'

export { findExternalTruck }

const ADD_NEW = '__add_new__'
const TYPE_IN = '__type_in__'
const INPUT = 'w-full rounded-lg border border-slate-300 px-3 py-2'

const RENAME_RULE = 'Renaming won’t change past loads — they keep the truck name as it was entered.'

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

function ModalButtons({ busy, label, onCancel }: { busy: boolean; label: string; onCancel: () => void }) {
  return (
    <div className="flex gap-2 justify-end">
      <button type="button" onClick={onCancel} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Cancel</button>
      <button type="submit" disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">
        {busy ? 'Saving…' : label}
      </button>
    </div>
  )
}

export function TruckPicker({ value, onChange, trucks, onCreated, onUpdated, className }: {
  value: string
  onChange: (id: string) => void
  trucks: Truck[]
  /** Called with the created row so the parent can add it to its list. */
  onCreated?: (t: Truck) => void
  /** Called with the renamed row so the parent can refresh its list. */
  onUpdated?: (t: Truck) => void
  className?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [dupe, setDupe] = useState<Truck | null>(null)

  const selected = trucks.find((t) => t.id === value) ?? null

  function close() { setOpen(false); setEditing(false); setName(''); setErr(null); setDupe(null) }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    e.stopPropagation() // nested in the load <form> — see the header warning
    setErr(null)
    const trimmed = name.trim()
    if (!trimmed) { setErr('Name is required.'); return }
    // Case-insensitive duplicate check → offer the existing record first.
    const existing = trucks.find((t) => t.name_or_number.trim().toLowerCase() === trimmed.toLowerCase())
    if (existing && dupe?.id !== existing.id) { setDupe(existing); return }
    setBusy(true)
    // org_id stamped from the session like every inline-add (054 WITH CHECK).
    const orgId = await getOrgId(supabase)
    const { data, error } = await supabase.from('trucks').insert(ownTruckInsert(trimmed, orgId)).select('*').single()
    setBusy(false)
    if (error || !data) { setErr(error?.message ?? 'Could not create the truck.'); return }
    const created = data as Truck
    onCreated?.(created)
    onChange(created.id)
    close()
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault()
    e.stopPropagation() // nested in the load <form> — see the header warning
    setErr(null)
    const trimmed = name.trim()
    if (!trimmed) { setErr('Name is required.'); return }
    if (!selected) { close(); return }
    const clash = trucks.find(
      (t) => t.id !== selected.id && t.name_or_number.trim().toLowerCase() === trimmed.toLowerCase(),
    )
    if (clash) { setErr(`A truck named ${clash.name_or_number} already exists.`); return }
    setBusy(true)
    const { data, error } = await supabase
      .from('trucks')
      .update({ name_or_number: trimmed })
      .eq('id', selected.id)
      .select('*')
      .single()
    setBusy(false)
    if (error || !data) { setErr(error?.message ?? 'Could not rename the truck.'); return }
    onUpdated?.(data as Truck)
    close()
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        <select
          value={value}
          onChange={(e) => { if (e.target.value === ADD_NEW) setOpen(true); else onChange(e.target.value) }}
          className={`flex-1 min-w-0 ${className ?? INPUT}`}
        >
          <option value="">— select —</option>
          {trucks.map((t) => <option key={t.id} value={t.id}>{t.name_or_number}</option>)}
          <option value={ADD_NEW}>+ Add truck…</option>
        </select>
        {selected && (
          <button
            type="button"
            onClick={() => { setEditing(true); setName(selected.name_or_number) }}
            className="rounded-lg bg-white border border-slate-300 px-2.5 py-2 text-sm text-slate-600"
            title="Edit truck name"
            aria-label="Edit truck name"
          >
            ✎
          </button>
        )}
      </div>
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
            <ModalButtons busy={busy} label="Add Truck" onCancel={close} />
          </form>
        </Modal>
      )}
      {editing && selected && (
        <Modal title="Edit Truck" onClose={close}>
          <form onSubmit={rename} className="space-y-2">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Truck name or number (required)" className={INPUT} />
            <p className="text-xs text-slate-500">{RENAME_RULE}</p>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <ModalButtons busy={busy} label="Save Name" onCancel={close} />
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
  onExternalUpdated,
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
  /** Called with the renamed row so the parent can refresh its list. */
  onExternalUpdated?: (t: ExternalTruck) => void
  className?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const matched = findExternalTruck(externalTrucks, haulerTruck)
  // Typing stays sticky once chosen so a cleared input doesn't snap the
  // select back to the placeholder mid-edit.
  const [typingPicked, setTypingPicked] = useState(false)
  const typing = truckId === '' && (typingPicked || (haulerTruck.trim() !== '' && !matched))
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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

  function closeEdit() { setEditing(false); setName(''); setErr(null) }

  async function rename(e: React.FormEvent) {
    e.preventDefault()
    e.stopPropagation() // nested in the load <form> — see the header warning
    setErr(null)
    const trimmed = name.trim()
    if (!trimmed) { setErr('Name is required.'); return }
    if (!matched) { closeEdit(); return }
    const clash = externalTrucks.find(
      (t) => t.id !== matched.id && t.name.trim().toLowerCase() === trimmed.toLowerCase(),
    )
    if (clash) { setErr(`A hauler truck named ${clash.name} already exists.`); return }
    setBusy(true)
    const { data, error } = await supabase
      .from('external_trucks')
      .update({ name: trimmed })
      .eq('id', matched.id)
      .select('*')
      .single()
    setBusy(false)
    if (error || !data) { setErr(error?.message ?? 'Could not rename the truck.'); return }
    onExternalUpdated?.(data as ExternalTruck)
    // The selection mirrors the free text, so follow the rename — this load
    // (not yet saved) should carry the corrected name.
    onChangeHauler(trimmed)
    closeEdit()
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <select value={selectValue} onChange={(e) => onSelect(e.target.value)} className={`flex-1 min-w-0 ${className ?? INPUT}`}>
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
        {matched && !truckId && (
          <button
            type="button"
            onClick={() => { setEditing(true); setName(matched.name) }}
            className="rounded-lg bg-white border border-slate-300 px-2.5 py-2 text-sm text-slate-600"
            title="Edit truck name"
            aria-label="Edit truck name"
          >
            ✎
          </button>
        )}
      </div>
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
      {editing && matched && (
        <Modal title="Edit Hauler Truck" onClose={closeEdit}>
          <form onSubmit={rename} className="space-y-2">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Truck name or number (required)" className={INPUT} />
            <p className="text-xs text-slate-500">{RENAME_RULE}</p>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <ModalButtons busy={busy} label="Save Name" onCancel={closeEdit} />
          </form>
        </Modal>
      )}
    </div>
  )
}
