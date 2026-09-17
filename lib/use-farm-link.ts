'use client'

// The Turnrow Farm link as the browser sees it (087): the organization's live
// link row (RLS-scoped to the caller's org) plus the id map for one land
// table, so the land pages can render "Managed in Turnrow Farm" and the
// per-row "not linked" chip, and the importers can refuse. Read-only here;
// /settings/farm-link does the writes.

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { landManagedByFarm, type FarmLinkRow, type GrainLinkTable } from '@/lib/farm-link'

export type FarmLinkStatus = {
  /** Null while loading, or when the organization has no live link. */
  link: FarmLinkRow | null
  loaded: boolean
  /** Land records are managed in Turnrow Farm (active link + a completed inbound sync). */
  managed: boolean
  /** Grain ids of the table's rows that are in the id map. */
  linkedIds: Set<string>
  lastSyncAt: string | null
  /** The database has not been updated for the link yet (087 pending). */
  unavailable: boolean
}

export async function fetchFarmLink(supabase: SupabaseClient): Promise<{ link: FarmLinkRow | null; unavailable: boolean }> {
  const { data, error } = await supabase.from('farm_links').select('*').neq('status', 'revoked').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) return { link: null, unavailable: true }
  return { link: (data as FarmLinkRow | null) ?? null, unavailable: false }
}

export function useFarmLink(supabase: SupabaseClient, table?: GrainLinkTable): FarmLinkStatus {
  const [link, setLink] = useState<FarmLinkRow | null>(null)
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { link: row, unavailable: missing } = await fetchFarmLink(supabase)
      if (cancelled) return
      setLink(row)
      setUnavailable(missing)
      if (row && table) {
        const ids = await fetchAllRows<{ grain_id: string }>((f, t) =>
          supabase.from('farm_link_ids').select('grain_id').eq('grain_table', table).order('id').range(f, t))
        if (cancelled) return
        setLinkedIds(new Set((ids.data ?? []).map((r) => r.grain_id)))
      }
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [supabase, table])

  return useMemo(() => ({
    link, loaded, unavailable, linkedIds,
    managed: landManagedByFarm(link),
    lastSyncAt: link?.last_sync?.inbound?.at ?? null,
  }), [link, loaded, unavailable, linkedIds])
}
