'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// Delete action for the load detail page (per-row delete was removed from the
// /loads list, so it lives here now). Confirms first, then deletes the load
// (splits cascade) and returns to the list.
export default function DeleteLoadButton({ loadId }: { loadId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function onDelete() {
    if (busy) return
    if (!confirm('Delete this load? This cannot be undone.')) return
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.from('loads').delete().eq('id', loadId)
    if (error) { alert(error.message); setBusy(false); return }
    router.push('/loads')
    router.refresh()
  }

  return (
    <button
      type="button"
      onClick={onDelete}
      disabled={busy}
      className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm font-semibold text-red-600 disabled:opacity-50"
    >
      {busy ? 'Deleting…' : 'Delete'}
    </button>
  )
}
