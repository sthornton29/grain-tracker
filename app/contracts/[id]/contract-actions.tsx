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
  contractedBu,
  deliveredBu,
  originalContractedBu = null,
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
  /** 0105 close short: the contract's bushels, the delivered bushels, and what was signed when closed short. */
  contractedBu?: number
  deliveredBu?: number
  originalContractedBu?: number | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<null | 'delete' | 'complete' | 'short'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ask, setAsk] = useState<null | 'delete' | 'reopen' | 'complete' | 'short'>(null)

  async function doDelete() {
    setBusy('delete')
    setErr(null)
    const supabase = createClient()
    // 094: loads applied to the contract hold it (ON DELETE RESTRICT). Say
    // how many instead of surfacing the generic in-use sentence.
    const [{ count: saleCount }, { count: mirrorCount }] = await Promise.all([
      supabase.from('load_sales').select('id', { count: 'exact', head: true }).eq('contract_id', contractId),
      supabase.from('loads').select('id', { count: 'exact', head: true }).eq('contract_id', contractId),
    ])
    const applied = Math.max(saleCount ?? 0, mirrorCount ?? 0)
    if (applied > 0) {
      setBusy(null)
      setAsk(null)
      setErr(`${applied.toLocaleString('en-US')} load${applied === 1 ? ' is' : 's are'} applied to this contract, so it can't be deleted. Move ${applied === 1 ? 'that load' : 'those loads'} to another sale first.`)
      return
    }
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
    // Reopening a contract closed short (0105) restores what was signed.
    const { error } = isManuallyComplete
      ? await supabase.from('contracts').update(originalContractedBu != null ? { completed_at: null, contracted_bushels: originalContractedBu, original_contracted_bushels: null } : { completed_at: null }).eq('id', contractId)
      : await supabase.from('contracts').update({ completed_at: new Date().toISOString() }).eq('id', contractId)
    setBusy(null)
    setAsk(null)
    if (error) {
      setErr(reportError(error, { action: isManuallyComplete ? 'reopen this contract' : 'mark this contract complete', noun: 'contract' }))
      return
    }
    router.refresh()
  }

  // Close short (0105): the contract keeps the bushels delivered, the
  // signed amount is kept beside it, and every engine values the delivered
  // bushels only. Reopen puts the signed amount back.
  const canCloseShort = !isManuallyComplete && !isAutoComplete && contractedBu != null && deliveredBu != null && deliveredBu > 0 && deliveredBu < contractedBu
  async function doCloseShort() {
    if (contractedBu == null || deliveredBu == null) return
    const supabase = createClient()
    setBusy('short')
    setErr(null)
    const { error } = await supabase.from('contracts').update({ original_contracted_bushels: contractedBu, contracted_bushels: Math.round(deliveredBu * 100) / 100, completed_at: new Date().toISOString() }).eq('id', contractId)
    setBusy(null)
    setAsk(null)
    if (error) {
      setErr(reportError(error, { action: 'close this contract short', noun: 'contract' }))
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
      {canCloseShort && (
        <button type="button" onClick={() => setAsk('short')} disabled={busy !== null} className={`${btn} border border-slate-300 bg-white text-slate-700`}>
          {busy === 'short' ? 'Closing…' : 'Close short'}
        </button>
      )}
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
        open={ask === 'short'}
        title={`Close #${contractNumber} short?`}
        body={<p>It keeps the {Math.round(deliveredBu ?? 0).toLocaleString('en-US')} bu delivered and is complete; the {Math.round(contractedBu ?? 0).toLocaleString('en-US')} bu signed for stay on record. Marketing and revenue then count only what was delivered, and the rest of your production shows as unsold (or kept for seed). Reopen puts the signed amount back.</p>}
        confirmLabel="Close short"
        busy={busy === 'short'}
        onConfirm={doCloseShort}
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
