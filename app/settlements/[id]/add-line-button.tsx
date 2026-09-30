'use client'

// "Add line" beside a Missing load on the settlement page: creates a
// settlement line already tied to that load (server action), then the page
// refreshes and the load moves up to Matched loads.

import { useState, useTransition } from 'react'
import { addSettlementLineForLoad } from './actions'

export default function AddLineButton({
  settlementId, loadId, ticketNumber, dryBushels,
}: {
  settlementId: string
  loadId: string
  ticketNumber: string | null
  dryBushels: number
}) {
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setErr(null)
          startTransition(async () => {
            const res = await addSettlementLineForLoad(settlementId, { id: loadId, ticket_number: ticketNumber, dryBushels })
            if (!res.ok) setErr(res.error ?? 'Turnrow couldn’t add that line. Try again.')
          })
        }}
        className="rounded-lg border border-slate-300 bg-white px-3 min-h-10 text-sm font-semibold text-brand-deep disabled:opacity-50"
      >
        {pending ? 'Adding…' : '+ Add line'}
      </button>
      {err && <span className="text-xs text-red-700">{err}</span>}
    </span>
  )
}
