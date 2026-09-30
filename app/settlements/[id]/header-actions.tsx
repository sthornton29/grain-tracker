'use client'

// Edit / Delete for a settlement, on its detail page. Edit covers the header
// fields (date, settlement #, notes) inline; Delete removes the settlement
// and its lines/discount items after the app's confirmation dialog.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ConfirmDialog } from '@/components/app-dialog'
import { reportError } from '@/lib/friendly-error'

export default function SettlementHeaderActions({
  settlementId, settlementDate, settlementNumber, notes,
}: {
  settlementId: string
  settlementDate: string
  settlementNumber: string | null
  notes: string | null
}) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [date, setDate] = useState(settlementDate)
  const [number, setNumber] = useState(settlementNumber ?? '')
  const [noteText, setNoteText] = useState(notes ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [askDelete, setAskDelete] = useState(false)

  async function save() {
    if (!date) { setErr('Pick a settlement date.'); return }
    setBusy(true)
    setErr(null)
    const { error } = await supabase
      .from('settlements')
      .update({
        settlement_date: date,
        settlement_number: number.trim() || null,
        notes: noteText.trim() || null,
      })
      .eq('id', settlementId)
    setBusy(false)
    if (error) { setErr(reportError(error, { action: 'save this settlement', noun: 'settlement' })); return }
    setEditing(false)
    router.refresh()
  }

  async function remove() {
    setBusy(true)
    setErr(null)
    const { error } = await supabase.from('settlements').delete().eq('id', settlementId)
    setBusy(false)
    setAskDelete(false)
    if (error) { setErr(reportError(error, { action: 'delete this settlement', noun: 'settlement' })); return }
    router.push('/settlements')
    router.refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 min-h-10 text-sm'

  const dialog = (
    <ConfirmDialog
      open={askDelete}
      title="Delete this settlement?"
      body={<p>Its lines and discount detail are deleted too, and the loads it paid go back to Unpaid. This can&rsquo;t be undone.</p>}
      confirmLabel="Delete settlement"
      danger
      busy={busy}
      onConfirm={() => void remove()}
      onCancel={() => setAskDelete(false)}
    />
  )

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        {err && <span className="text-sm text-red-700">{err}</span>}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-lg bg-white border border-slate-300 px-3 min-h-10 text-sm"
        >Edit</button>
        <button
          type="button"
          onClick={() => setAskDelete(true)}
          disabled={busy}
          className="rounded-lg bg-white border border-red-200 text-red-700 px-3 min-h-10 text-sm disabled:opacity-50"
        >Delete</button>
        {dialog}
      </div>
    )
  }

  return (
    <div className="flex items-end gap-2 flex-wrap bg-white rounded-xl shadow px-3 py-2">
      <label className="text-xs text-slate-600">
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`block mt-0.5 ${inputCls}`} />
      </label>
      <label className="text-xs text-slate-600">
        Settlement #
        <input value={number} onChange={(e) => setNumber(e.target.value)} className={`block mt-0.5 w-32 ${inputCls}`} />
      </label>
      <label className="text-xs text-slate-600">
        Notes
        <input value={noteText} onChange={(e) => setNoteText(e.target.value)} className={`block mt-0.5 w-48 ${inputCls}`} />
      </label>
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-10 text-sm font-semibold disabled:opacity-50"
      >{busy ? 'Saving…' : 'Save'}</button>
      <button
        type="button"
        onClick={() => { setEditing(false); setErr(null) }}
        className="rounded-lg bg-white border border-slate-300 px-3 min-h-10 text-sm"
      >Cancel</button>
      {err && <span className="text-sm text-red-700">{err}</span>}
      {dialog}
    </div>
  )
}
