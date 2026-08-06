// Client side of the viewer's private assumption overrides (052): load the
// user's rows once, save/reset single-field overrides, and lazily delete the
// ones an admin change superseded (resolution itself is pure —
// lib/viewer-assumptions.ts). Owners get an inert instance (no fetch, empty
// overrides), so owner report paths are untouched.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ViewerAssumptionOverride } from '@/lib/types'
import type { ViewerScopeState } from '@/lib/use-viewer-scope'
import {
  buildOverrideUpsert,
  type OverridableCropField,
  type OverridableCountyField,
} from '@/lib/viewer-assumptions'

export type SaveOverrideArgs = {
  scope: 'crop' | 'county'
  cropId: string
  cropYear: number
  countyId?: string | null
  field: OverridableCropField | OverridableCountyField
  // Numeric for every field except reference_contract_month (a 'SEP 26'
  // label); the column is jsonb, so both shapes round-trip unchanged.
  value: number | string | null
  /** The CURRENT shared base row (or null if none) — its updated_at becomes
   *  the staleness snapshot. */
  base: { updated_at: string } | null | undefined
}

export type ViewerAssumptionsApi = {
  /** The viewer's raw override rows (feed to resolveCrop/CountyAssumptions). */
  overrides: ViewerAssumptionOverride[]
  /** True once loading is done (always true for non-viewers). */
  ready: boolean
  /** True (once) when stale overrides were discarded because an admin changed
   *  the underlying assumption — for the one-time notice. */
  superseded: boolean
  dismissSuperseded: () => void
  saveOverride: (args: SaveOverrideArgs) => Promise<void>
  resetOverride: (args: Omit<SaveOverrideArgs, 'value' | 'base'>) => Promise<void>
  /** Reset every override on one base row (all fields at once — the
   *  "back to official" control). */
  resetOverridesFor: (args: { scope: 'crop' | 'county'; cropId: string; cropYear: number; countyId?: string | null }) => Promise<void>
  /** Lazy cleanup: delete overrides a resolution reported stale. */
  cleanupStale: (staleIds: string[]) => void
}

const matches = (o: ViewerAssumptionOverride, a: { scope: string; cropId: string; cropYear: number; countyId?: string | null; field: string }) =>
  o.scope === a.scope && o.crop_id === a.cropId && o.crop_year === a.cropYear &&
  o.field === a.field && (o.scope === 'crop' || (o.county_id ?? null) === (a.countyId ?? null))

export function useViewerAssumptions(supabase: SupabaseClient, viewer: ViewerScopeState): ViewerAssumptionsApi {
  const [overrides, setOverrides] = useState<ViewerAssumptionOverride[]>([])
  const [ready, setReady] = useState(false)
  const [superseded, setSuperseded] = useState(false)
  const userIdRef = useRef<string | null>(null)
  const cleanedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    if (viewer.loading) return
    if (!viewer.isViewer) { setReady(true); return }
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (!cancelled) setReady(true); return }
      userIdRef.current = user.id
      const { data } = await supabase.from('viewer_assumption_overrides').select('*')
      if (!cancelled) {
        setOverrides((data as ViewerAssumptionOverride[] | null) ?? [])
        setReady(true)
      }
    })()
    return () => { cancelled = true }
  }, [supabase, viewer.loading, viewer.isViewer])

  const saveOverride = useCallback(async (args: SaveOverrideArgs) => {
    const userId = userIdRef.current
    if (!userId) return
    const payload = buildOverrideUpsert({
      userId, scope: args.scope, cropId: args.cropId, cropYear: args.cropYear,
      countyId: args.countyId, field: args.field, value: args.value, base: args.base,
    })
    const existing = overrides.find((o) => matches(o, args))
    if (existing) {
      const { data, error } = await supabase.from('viewer_assumption_overrides')
        .update({ value: payload.value, base_updated_at: payload.base_updated_at })
        .eq('id', existing.id).select('*').single()
      if (!error && data) setOverrides((prev) => prev.map((o) => (o.id === existing.id ? (data as ViewerAssumptionOverride) : o)))
    } else {
      const { data, error } = await supabase.from('viewer_assumption_overrides')
        .insert(payload).select('*').single()
      if (!error && data) setOverrides((prev) => [...prev, data as ViewerAssumptionOverride])
    }
  }, [supabase, overrides])

  const resetOverride = useCallback(async (args: Omit<SaveOverrideArgs, 'value' | 'base'>) => {
    const existing = overrides.find((o) => matches(o, args))
    if (!existing) return
    await supabase.from('viewer_assumption_overrides').delete().eq('id', existing.id)
    setOverrides((prev) => prev.filter((o) => o.id !== existing.id))
  }, [supabase, overrides])

  const resetOverridesFor = useCallback(async (args: { scope: 'crop' | 'county'; cropId: string; cropYear: number; countyId?: string | null }) => {
    const ids = overrides
      .filter((o) =>
        o.scope === args.scope && o.crop_id === args.cropId && o.crop_year === args.cropYear &&
        (o.scope === 'crop' || (o.county_id ?? null) === (args.countyId ?? null)))
      .map((o) => o.id)
    if (ids.length === 0) return
    await supabase.from('viewer_assumption_overrides').delete().in('id', ids)
    setOverrides((prev) => prev.filter((o) => !ids.includes(o.id)))
  }, [supabase, overrides])

  const cleanupStale = useCallback((staleIds: string[]) => {
    const fresh = staleIds.filter((id) => !cleanedRef.current.has(id))
    if (fresh.length === 0) return
    fresh.forEach((id) => cleanedRef.current.add(id))
    setSuperseded(true)
    setOverrides((prev) => prev.filter((o) => !fresh.includes(o.id)))
    supabase.from('viewer_assumption_overrides').delete().in('id', fresh).then(() => {})
  }, [supabase])

  return {
    overrides,
    ready,
    superseded,
    dismissSuperseded: useCallback(() => setSuperseded(false), []),
    saveOverride,
    resetOverride,
    resetOverridesFor,
    cleanupStale,
  }
}
