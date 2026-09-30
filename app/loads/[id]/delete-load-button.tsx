'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/friendly-error'
import { ConfirmDialog, NoticeDialog } from '@/components/app-dialog'

// Delete action for the load detail page (per-row delete was removed from the
// /loads list, so it lives here now). Confirms in the app's own dialog, then
// deletes the load (splits cascade) and returns to the list.
export default function DeleteLoadButton({ loadId }: { loadId: string }) {
  const router = useRouter()
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onDelete() {
    if (busy) return
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.from('loads').delete().eq('id', loadId)
    if (error) {
      setBusy(false)
      setAsk(false)
      setErr(reportError(error, { action: 'delete this load', noun: 'load' }))
      return
    }
    router.push('/loads')
    router.refresh()
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAsk(true)}
        disabled={busy}
        className="rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm font-semibold text-red-600 disabled:opacity-50"
      >
        {busy ? 'Deleting…' : 'Delete'}
      </button>
      <ConfirmDialog
        open={ask}
        title="Delete this load?"
        body="This can’t be undone. Bin inventory, contract deliveries, and yields will recalculate without it."
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => void onDelete()}
        onCancel={() => { if (!busy) setAsk(false) }}
      />
      <NoticeDialog open={err != null} title="Couldn’t delete" body={err} onClose={() => setErr(null)} />
    </>
  )
}
