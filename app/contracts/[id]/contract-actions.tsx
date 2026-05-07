'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function ContractActions({
  contractId,
  contractNumber,
}: {
  contractId: string
  contractNumber: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onDelete() {
    if (!confirm(`Delete contract #${contractNumber}? This cannot be undone.`)) return
    setBusy(true)
    setErr(null)
    const supabase = createClient()
    const { error } = await supabase.from('contracts').delete().eq('id', contractId)
    setBusy(false)
    if (error) {
      setErr(error.message)
      return
    }
    router.push('/contracts')
    router.refresh()
  }

  return (
    <div className="flex items-center gap-2">
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
        onClick={onDelete}
        disabled={busy}
        className="rounded-lg bg-red-600 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {busy ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  )
}
