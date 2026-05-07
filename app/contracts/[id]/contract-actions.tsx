'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function ContractActions({
  contractId,
  contractNumber,
  isManuallyComplete,
  isAutoComplete,
}: {
  contractId: string
  contractNumber: string
  isManuallyComplete: boolean
  isAutoComplete: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<null | 'delete' | 'complete'>(null)
  const [err, setErr] = useState<string | null>(null)

  async function onDelete() {
    if (!confirm(`Delete contract #${contractNumber}? This cannot be undone.`)) return
    setBusy('delete')
    setErr(null)
    const supabase = createClient()
    const { error } = await supabase.from('contracts').delete().eq('id', contractId)
    setBusy(null)
    if (error) {
      setErr(error.message)
      return
    }
    router.push('/contracts')
    router.refresh()
  }

  async function onToggleComplete() {
    const supabase = createClient()
    if (isManuallyComplete) {
      if (!confirm(`Reopen contract #${contractNumber}?`)) return
      setBusy('complete')
      setErr(null)
      const { error } = await supabase.from('contracts').update({ completed_at: null }).eq('id', contractId)
      setBusy(null)
      if (error) { setErr(error.message); return }
      router.refresh()
      return
    }
    const msg = isAutoComplete
      ? `Mark #${contractNumber} complete? Delivered already meets the contracted amount; this just records the close.`
      : `Mark #${contractNumber} complete now, even though it isn't fully delivered?`
    if (!confirm(msg)) return
    setBusy('complete')
    setErr(null)
    const { error } = await supabase
      .from('contracts')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', contractId)
    setBusy(null)
    if (error) { setErr(error.message); return }
    router.refresh()
  }

  const completeLabel = isManuallyComplete
    ? (busy === 'complete' ? 'Reopening…' : 'Reopen')
    : (busy === 'complete' ? 'Completing…' : 'Complete contract')

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {err && <span className="text-sm text-red-600">{err}</span>}
      <button
        onClick={() => window.print()}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
      >
        Print
      </button>
      <Link
        href={`/contracts/${contractId}/edit`}
        className="rounded-lg bg-sky-700 text-white px-3 py-2 text-sm font-semibold"
      >
        Edit
      </Link>
      <button
        onClick={onToggleComplete}
        disabled={busy !== null}
        className={`rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${
          isManuallyComplete
            ? 'border border-slate-300 bg-white text-slate-700'
            : 'bg-slate-900 text-white'
        }`}
      >
        {completeLabel}
      </button>
      <button
        onClick={onDelete}
        disabled={busy !== null}
        className="rounded-lg bg-red-600 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {busy === 'delete' ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  )
}
