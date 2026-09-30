'use client'

// Manual match dropdown for an ambiguous or unmatched settlement line. Picking a
// load writes load_id immediately via the server action, then the page
// revalidates. Used on the Review screen for lines we couldn't auto-match.

import { useState, useTransition } from 'react'
import { setSettlementLineLoad } from './actions'

export type LoadOption = { id: string; label: string }

export default function LineMatchSelect({
  settlementId, lineId, currentLoadId, options, ticket,
}: {
  settlementId: string
  lineId: string
  currentLoadId: string | null
  options: LoadOption[]
  /** The line's ticket, for the select's accessible name. */
  ticket?: string | null
}) {
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <select
        value={currentLoadId ?? ''}
        disabled={pending}
        aria-label={`Match ticket ${ticket || 'without a number'} to a load`}
        onChange={(e) => {
          const v = e.target.value || null
          setErr(null)
          startTransition(async () => {
            const res = await setSettlementLineLoad(settlementId, lineId, v)
            if (!res.ok) setErr(res.error ?? 'Turnrow couldn’t save that match. Try again.')
          })
        }}
        className="rounded-lg border border-slate-300 px-2 min-h-10 text-sm bg-white max-w-[18rem]"
      >
        <option value="">{pending ? 'Saving…' : 'Pick the load…'}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {err && <span className="text-xs text-red-700 basis-full">{err}</span>}
    </span>
  )
}
