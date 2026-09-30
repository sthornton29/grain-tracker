'use client'

// The landowner dropdown for the farm forms, with "+ Add new landowner…"
// that opens a small portaled dialog (the inline-modal rule: this picker
// sits inside forms and labels, so the dialog must live on document.body).

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AppModal } from '@/components/app-dialog'
import { reportError } from '@/lib/friendly-error'
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
  /** Accessible name for the dropdown when there is no visible label. */
  ariaLabel?: string
}

const ADD_NEW = '__add_new__'

export default function LandownerPicker({
  value, onChange, landowners, farms, onCreated, className, ariaLabel = 'Landowner',
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

  function close() { setOpen(false); setErr(null) }

  async function createLandowner(e: React.FormEvent) {
    e.preventDefault()
    e.stopPropagation()
    setErr(null)
    const name = draftName.trim()
    if (!name) { setErr('Enter the landowner’s name.'); return }
    if (landowners.some((l) => l.name.trim().toLowerCase() === name.toLowerCase())) {
      setErr(`A landowner named “${name}” already exists — pick them from the list instead.`)
      return
    }
    setBusy(true)
    const { data, error } = await supabase
      .from('landowners')
      .insert({
        name,
        phone: draftPhone.trim() || null,
        email: draftEmail.trim() || null,
      })
      .select('*')
      .single()
    setBusy(false)
    if (error || !data) { setErr(reportError(error, { action: 'add the landowner', noun: 'landowner', name })); return }
    const created = data as Landowner
    if (onCreated) onCreated(created)
    onChange(created.id)
    setDraftName(''); setDraftPhone(''); setDraftEmail('')
    setOpen(false)
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-11'

  return (
    <>
      <select
        value={value}
        onChange={(e) => handleSelect(e.target.value)}
        aria-label={ariaLabel}
        className={`rounded-lg border border-slate-300 px-3 py-2 min-h-11 ${className ?? ''}`}
      >
        <option value="">— no landowner —</option>
        {landowners.filter((l) => !l.archived_at && !l.merged_into_id).map((l) => (
          <option key={l.id} value={l.id}>{labelFor(l)}</option>
        ))}
        <option value={ADD_NEW}>+ Add new landowner…</option>
      </select>
      <AppModal open={open} title="New landowner" onClose={close} size="sm">
        <form onSubmit={createLandowner} className="space-y-2">
          <label className="block text-sm text-slate-700">
            Name
            <input data-autofocus value={draftName} onChange={(e) => setDraftName(e.target.value)} className={inputCls} />
          </label>
          <label className="block text-sm text-slate-700">
            Phone <span className="text-slate-400">(optional)</span>
            <input type="tel" value={draftPhone} onChange={(e) => setDraftPhone(e.target.value)} className={inputCls} />
          </label>
          <label className="block text-sm text-slate-700">
            Email <span className="text-slate-400">(optional)</span>
            <input type="email" value={draftEmail} onChange={(e) => setDraftEmail(e.target.value)} className={inputCls} />
          </label>
          <p className="text-xs text-slate-500">Address and notes can be added later under Settings → Landowners.</p>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={close} className="rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm">Cancel</button>
            <button type="submit" disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : 'Add landowner'}
            </button>
          </div>
        </form>
      </AppModal>
    </>
  )
}
