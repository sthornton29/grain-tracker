'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/friendly-error'
import { ConfirmDialog } from '@/components/app-dialog'

export default function ContractActions({
  contractId,
  contractNumber,
  isManuallyComplete,
  isAutoComplete,
  editHref,
  hideEdit = false,
}: {
  contractId: string
  contractNumber: string
  isManuallyComplete: boolean
  isAutoComplete: boolean
  /** Where Edit goes. Defaults to the grain editor; a seed contract passes
   *  its own editor so the grain form never overwrites seed terms. */
  editHref?: string
  /** Leave the Edit button out entirely (the caller renders its own). */
  hideEdit?: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<null | 'delete' | 'complete'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ask, setAsk] = useState<null | 'delete' | 'reopen' | 'complete'>(null)

  async function doDelete() {
    setBusy('delete')
    setErr(null)
    const supabase = createClient()
    const { error } = await supabase.from('contracts').delete().eq('id', contractId)
    setBusy(null)
    setAsk(null)
    if (error) {
      setErr(reportError(error, { action: 'delete this contract', noun: 'contract' }))
      return
    }
    router.push('/contracts')
    router.refresh()
  }

  async function doToggleComplete() {
    const supabase = createClient()
    setBusy('complete')
    setErr(null)
    const { error } = isManuallyComplete
      ? await supabase.from('contracts').update({ completed_at: null }).eq('id', contractId)
      : await supabase.from('contracts').update({ completed_at: new Date().toISOString() }).eq('id', contractId)
    setBusy(null)
    setAsk(null)
    if (error) {
      setErr(reportError(error, { action: isManuallyComplete ? 'reopen this contract' : 'mark this contract complete', noun: 'contract' }))
      return
    }
    router.refresh()
  }

  const completeLabel = isManuallyComplete
    ? (busy === 'complete' ? 'Reopening…' : 'Reopen')
    : (busy === 'complete' ? 'Completing…' : 'Complete contract')

  const btn = 'rounded-lg px-3 min-h-10 text-sm font-semibold disabled:opacity-50'

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {err && <span className="text-sm text-red-700">{err}</span>}
      <button type="button" onClick={() => window.print()} className={`${btn} border border-slate-300 bg-white`}>
        Print
      </button>
      {!hideEdit && (
        <Link href={editHref ?? `/contracts/${contractId}/edit`} className={`${btn} inline-flex items-center bg-sky-700 text-white`}>
          Edit
        </Link>
      )}
      <button
        type="button"
        onClick={() => setAsk(isManuallyComplete ? 'reopen' : 'complete')}
        disabled={busy !== null}
        className={`${btn} ${isManuallyComplete ? 'border border-slate-300 bg-white text-slate-700' : 'bg-slate-900 text-white'}`}
      >
        {completeLabel}
      </button>
      <button
        type="button"
        onClick={() => setAsk('delete')}
        disabled={busy !== null}
        className={`${btn} bg-red-600 text-white`}
      >
        {busy === 'delete' ? 'Deleting…' : 'Delete'}
      </button>

      <ConfirmDialog
        open={ask === 'delete'}
        title={`Delete contract #${contractNumber}?`}
        body={<p>Loads delivered against it stay on the Loads page, but they will no longer be tied to a contract. This can&rsquo;t be undone.</p>}
        confirmLabel="Delete contract"
        danger
        busy={busy === 'delete'}
        onConfirm={doDelete}
        onCancel={() => setAsk(null)}
      />
      <ConfirmDialog
        open={ask === 'reopen'}
        title={`Reopen contract #${contractNumber}?`}
        body={<p>It goes back to open, and any delivery or pricing reminders start again.</p>}
        confirmLabel="Reopen"
        busy={busy === 'complete'}
        onConfirm={doToggleComplete}
        onCancel={() => setAsk(null)}
      />
      <ConfirmDialog
        open={ask === 'complete'}
        title={`Mark #${contractNumber} complete?`}
        body={
          <p>
            {isAutoComplete
              ? 'Delivered bushels already meet the contracted amount — this just records that the contract is closed out.'
              : 'It isn’t fully delivered yet. Marking it complete stops the reminders and stops it projecting future revenue in reports.'}
          </p>
        }
        confirmLabel="Mark complete"
        busy={busy === 'complete'}
        onConfirm={doToggleComplete}
        onCancel={() => setAsk(null)}
      />
    </div>
  )
}
