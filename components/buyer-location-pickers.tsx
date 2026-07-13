'use client'

// Inline "+ Add new…" pickers for buyers and delivery locations — the same
// pattern as the landowner inline-add on the farm form: a select whose last
// option opens a compact modal, creating the record in the SAME table the
// settings pages manage (no parallel storage), auto-selecting it on save.
// Both dedupe case-insensitively against the existing list and offer to
// select the match instead of creating a twin.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Buyer, DeliveryLocation } from '@/lib/types'

const ADD_NEW = '__add_new__'
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

export function BuyerPicker({ value, onChange, buyers, onCreated, className }: {
  value: string
  onChange: (id: string) => void
  buyers: Buyer[]
  /** Called with the created row so the parent can add it to its list. */
  onCreated?: (b: Buyer) => void
  className?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [dupe, setDupe] = useState<Buyer | null>(null)

  function close() { setOpen(false); setName(''); setErr(null); setDupe(null) }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    const trimmed = name.trim()
    if (!trimmed) { setErr('Name is required.'); return }
    // Case-insensitive duplicate check → offer the existing record first.
    const existing = buyers.find((b) => b.name.trim().toLowerCase() === trimmed.toLowerCase())
    if (existing && dupe?.id !== existing.id) { setDupe(existing); return }
    setBusy(true)
    const { data, error } = await supabase.from('buyers').insert({ name: trimmed }).select('*').single()
    setBusy(false)
    if (error || !data) { setErr(error?.message ?? 'Could not create the buyer.'); return }
    const created = data as Buyer
    onCreated?.(created)
    onChange(created.id)
    close()
  }

  return (
    <>
      <select
        value={value}
        onChange={(e) => { if (e.target.value === ADD_NEW) setOpen(true); else onChange(e.target.value) }}
        className={className ?? 'rounded-lg border border-slate-300 px-3 py-2'}
      >
        <option value="">— buyer —</option>
        {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        <option value={ADD_NEW}>+ Add new buyer…</option>
      </select>
      {open && (
        <Modal title="New Buyer" onClose={close}>
          <form onSubmit={create} className="space-y-2">
            <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setDupe(null) }} placeholder="Buyer name (required)" className={INPUT} />
            <p className="text-xs text-slate-500">Delivery locations can be added right after, or later under Settings → Buyers.</p>
            {dupe && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 space-y-1.5">
                <p>A buyer named <b>{dupe.name}</b> already exists.</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { onChange(dupe.id); close() }} className="rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold">Use existing</button>
                  <button type="submit" className="rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm">Create anyway</button>
                </div>
              </div>
            )}
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={close} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={busy} className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">
                {busy ? 'Saving…' : 'Add Buyer'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

export function DeliveryLocationPicker({ value, onChange, buyerId, buyerName, locations, onCreated, className }: {
  value: string
  onChange: (id: string) => void
  /** Locations belong to a buyer — the picker is disabled until one is selected. */
  buyerId: string
  buyerName?: string | null
  /** The SELECTED BUYER's locations (pre-filtered by the caller). */
  locations: DeliveryLocation[]
  onCreated?: (l: DeliveryLocation) => void
  className?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [dupe, setDupe] = useState<DeliveryLocation | null>(null)

  function close() { setOpen(false); setName(''); setAddress(''); setErr(null); setDupe(null) }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    const trimmed = name.trim()
    if (!trimmed) { setErr('Name is required.'); return }
    const existing = locations.find((l) => l.name.trim().toLowerCase() === trimmed.toLowerCase())
    if (existing && dupe?.id !== existing.id) { setDupe(existing); return }
    setBusy(true)
    const { data, error } = await supabase
      .from('delivery_locations')
      .insert({ buyer_id: buyerId, name: trimmed, address: address.trim() || null })
      .select('*')
      .single()
    setBusy(false)
    if (error || !data) { setErr(error?.message ?? 'Could not create the delivery location.'); return }
    const created = data as DeliveryLocation
    onCreated?.(created)
    onChange(created.id)
    close()
  }

  return (
    <>
      <select
        value={value}
        onChange={(e) => { if (e.target.value === ADD_NEW) setOpen(true); else onChange(e.target.value) }}
        disabled={!buyerId}
        className={className ?? 'rounded-lg border border-slate-300 px-3 py-2'}
      >
        <option value="">{buyerId ? '— delivery location —' : 'pick a buyer first'}</option>
        {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        {buyerId && <option value={ADD_NEW}>+ Add new location…</option>}
      </select>
      {open && (
        <Modal title={`New Delivery Location${buyerName ? ` — ${buyerName}` : ''}`} onClose={close}>
          <form onSubmit={create} className="space-y-2">
            <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setDupe(null) }} placeholder="Location name (required)" className={INPUT} />
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address (optional)" className={INPUT} />
            {dupe && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 space-y-1.5">
                <p>{buyerName ?? 'This buyer'} already has a location named <b>{dupe.name}</b>.</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { onChange(dupe.id); close() }} className="rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold">Use existing</button>
                  <button type="submit" className="rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm">Create anyway</button>
                </div>
              </div>
            )}
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={close} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={busy} className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">
                {busy ? 'Saving…' : 'Add Location'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
