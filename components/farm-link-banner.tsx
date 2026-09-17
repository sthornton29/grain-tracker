'use client'

// The land pages' "Managed in Turnrow Farm" banner (087) and the per-row
// "not linked" chip. Shown only once the link is active and has synced land;
// before that the pages behave exactly as before.

import Link from 'next/link'
import type { FarmLinkStatus } from '@/lib/use-farm-link'

export const TURNROW_FARM_URL = 'https://turnrowfm.com'

export function fmtSyncTime(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function FarmLinkBanner({ status, noun }: { status: FarmLinkStatus; noun: string }) {
  if (!status.managed) return null
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 flex items-center gap-2 flex-wrap">
      <span className="font-semibold">Managed in Turnrow Farm</span>
      <span className="text-sky-800">
        · {noun} come from Turnrow Farm and are edited there; last synced {fmtSyncTime(status.lastSyncAt)}.
        Rows marked <span className="rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5 text-xs font-medium">not linked</span> were
        created here and can still be edited — match them in Turnrow Farm to link them.
      </span>
      <a href={TURNROW_FARM_URL} target="_blank" rel="noopener noreferrer" className="ml-auto text-brand-deep font-semibold underline">Open Turnrow Farm ↗</a>
      <Link href="/settings/farm-link" className="text-brand-deep underline">Link settings</Link>
    </div>
  )
}

export function NotLinkedChip() {
  return (
    <span
      className="ml-2 rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-medium align-middle"
      title="Created in Turnrow Grain and not matched to a Turnrow Farm record yet. Match it in Turnrow Farm; until then it can be edited here."
    >
      not linked
    </span>
  )
}

export function ManagedChip() {
  return (
    <span className="ml-2 rounded-full bg-sky-100 text-sky-800 px-2 py-0.5 text-xs font-medium align-middle" title="Managed in Turnrow Farm — edit it there.">
      Turnrow Farm
    </span>
  )
}
