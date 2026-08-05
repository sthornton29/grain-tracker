// The viewer's entity universe, client-side (052). One fetch per page load:
// role from user_profiles, grants from user_entity_access (RLS lets a user
// read only their own rows, so this cannot be widened from the browser; the
// table row-filters in 052 are the hard enforcement underneath).
//
// Report pages use this to (a) pass grantedEntityIds into buildEntityScope so
// '' means "all MY entities combined", (b) limit the entity dropdown's options
// to the grants, and (c) name the granted entities on the exports' filter
// line. Owners and gin get { isViewer: false } and every helper is a
// pass-through — owner report output is untouched by construction.

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

export type ViewerScopeState = {
  /** True until the role (and, for viewers, the grants) have loaded. Pages
   *  should hold rendering of viewer-scoped numbers until this is false. */
  loading: boolean
  isViewer: boolean
  /** Granted entity ids; null for owners/gin (no restriction). */
  grantedIds: ReadonlyArray<string> | null
}

export const NO_VIEWER_SCOPE: ViewerScopeState = { loading: false, isViewer: false, grantedIds: null }

export function useViewerScope(supabase: SupabaseClient): ViewerScopeState {
  const [state, setState] = useState<ViewerScopeState>({ loading: true, isViewer: false, grantedIds: null })
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (!cancelled) setState(NO_VIEWER_SCOPE); return }
      const { data: profile } = await supabase
        .from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
      if ((profile as { role?: string } | null)?.role !== 'viewer') {
        if (!cancelled) setState(NO_VIEWER_SCOPE)
        return
      }
      const { data: grants } = await supabase
        .from('user_entity_access').select('entity_id').eq('user_id', user.id)
      if (!cancelled) {
        setState({
          loading: false,
          isViewer: true,
          grantedIds: ((grants as Array<{ entity_id: string }> | null) ?? []).map((g) => g.entity_id),
        })
      }
    })()
    return () => { cancelled = true }
  }, [supabase])
  return state
}

/** Dropdown options for the entity filter: a viewer sees ONLY their granted
 *  entities (a single grant then auto-hides the dropdown via EntityFilter's
 *  <=1 rule). Owners get the list unchanged. */
export function entityOptionsFor<T extends { id: string }>(
  viewer: ViewerScopeState,
  entities: ReadonlyArray<T>,
): T[] {
  if (!viewer.isViewer) return [...entities]
  const granted = new Set(viewer.grantedIds ?? [])
  return entities.filter((e) => granted.has(e.id))
}

/** What "All entities" actually means for the current user — for a viewer,
 *  their granted entities by name (the exports' filter line must say so).
 *  Null for owners (keep each report's existing "All entities" wording). */
export function viewerAllEntitiesLabel(
  viewer: ViewerScopeState,
  entities: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  if (!viewer.isViewer) return null
  const granted = new Set(viewer.grantedIds ?? [])
  const names = entities.filter((e) => granted.has(e.id)).map((e) => e.name)
  return names.length > 0 ? names.join(' + ') : null
}
