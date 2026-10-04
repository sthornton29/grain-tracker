'use client'

// Client hook over lib/cotton-yield-sources: reads the Cotton module flag and,
// only when it is on, the cotton sources — then hands back the pure model.
// Pages mount this beside their grain reads; with the module off the hook
// settles immediately with an inert model (no cotton reads, no adapter), so
// the page renders byte-for-byte what it rendered before.

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCottonYieldModel, fetchCottonYieldSources, type CottonYieldModel, type CottonYieldSources } from '@/lib/cotton-yield-sources'

export type CottonYieldsState = {
  /** True until the flag (and, when on, the sources) have loaded. */
  loading: boolean
  /** The module flag as read; null while loading. */
  on: boolean | null
  model: CottonYieldModel
  /** Re-read the sources (after a save). */
  refresh: () => void
}

export function useCottonYields(
  supabase: SupabaseClient,
  args: {
    crops: ReadonlyArray<{ id: string; name: string }>
    assumptions: ReadonlyArray<{ crop_id: string; crop_year: number; assumed_turnout_pct?: number | string | null }>
  },
): CottonYieldsState {
  const [sources, setSources] = useState<CottonYieldSources | null>(null)
  const [on, setOn] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await fetchCottonYieldSources(supabase)
        if (cancelled) return
        setSources(s)
        setOn(s != null)
      } catch {
        // A read error degrades to "module off" for this visit — the grain
        // views still work; cotton rows simply classify as before.
        if (cancelled) return
        setSources(null)
        setOn(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [supabase, nonce])

  const model = useMemo(
    () => buildCottonYieldModel({ sources, crops: args.crops, assumptions: args.assumptions }),
    [sources, args.crops, args.assumptions],
  )
  return { loading, on, model, refresh: () => setNonce((n) => n + 1) }
}
