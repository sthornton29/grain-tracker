'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Farm, Landowner } from '@/lib/types'

type Props = {
  /** Currently selected landowner id (empty string = none). */
  value: string
  onChange: (id: string) => void
  landowners: Landowner[]
  /** All farms so the picker can show "Smith (Hill, Bottom)" hints. */
  farms: Farm[]
  /** Called after a new landowner is created so the parent can refresh its list. */
  onCreated?: (newLandowner: Landowner) => void
  className?: string
}

const ADD_NEW = '__add_new__'

export default function LandownerPicker({
  value, onChange, landowners, farms, onCreated, className,
}: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftPhone, setDraftPhone] = useState('')
  const [draftEmail, setDraftEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const farmsByLandowner = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const f of farms) {
      if (!f.landowner_id) continue
      const list = m.get(f.landowner_id) ?? []
      list.push(f.name)
      m.set(f.landowner_id, list)
    }
    return m
  }, [farms])

  function labelFor(l: Landowner): string {
    const farmNames = farmsByLandowner.get(l.id) ?? []
    if (farmNames.length === 0) return l.name
    return `${l.name} (${farmNames.slice(0, 3).join(', ')}${farmNames.length > 3 ? ', …' : ''})`
  }

  function handleSelect(v: string) {
    if (v === ADD_NEW) {
      setOpen(true)
      return
    }
    onChange(v)
  }

  async function createLandowner(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!draftName.trim()) { setErr('Name is required.'); return }
    setBusy(true)
    const { data, error } = await supabase
      .from('landowners')
      .insert({
        name: draftName.trim(),
        phone: draftPhone.trim() || null,
        email: draftEmail.trim() || null,
      })
      .select('*')
      .single()
    setBusy(false)
    if (error || !data) { setErr(error?.message ?? 'Could not create landowner.'); return }
    const created = data as Landowner
    if (onCreated) onCreated(created)
    onChange(created.id)
    setDraftName(''); setDraftPhone(''); setDraftEmail('')
    setOpen(false)
  }

  return (
    <>
      <select
        value={value}
        onChange={(e) => handleSelect(e.target.value)}
        className={`rounded-lg border border-slate-300 px-3 py-2 ${className ?? ''}`}
      >
        <option value="">— no landowner —</option>
        {landowners.map((l) => (
          <option key={l.id} value={l.id}>{labelFor(l)}</option>
        ))}
        <option value={ADD_NEW}>+ Add new landowner…</option>
      </select>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white rounded-xl shadow-xl p-4 w-full max-w-md space-y-3">
            <h3 className="font-semibold text-lg">New Landowner</h3>
            <form onSubmit={createLandowner} className="space-y-2">
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Name (required)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <input
                value={draftPhone}
                onChange={(e) => setDraftPhone(e.target.value)}
                placeholder="Phone (optional)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <input
                value={draftEmail}
                onChange={(e) => setDraftEmail(e.target.value)}
                placeholder="Email (optional)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <p className="text-xs text-slate-500">Address and notes can be added later under Settings → Landowners.</p>
              {err && <p className="text-sm text-red-600">{err}</p>}
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => { setOpen(false); setErr(null) }}
                  className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Add Landowner'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
