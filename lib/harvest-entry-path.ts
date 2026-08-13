// Which harvest-entry path the user last used (062): weighed loads or the
// combine entry. Pure emphasis — the Loads page surfaces the last-used path's
// button as primary — never a lockout. Stored per browser via the same
// localStorage convention as usePersistentState (JSON-encoded under a
// page-scoped key), so the loads page can read it with that hook.

export type HarvestEntryPath = 'load' | 'combine'

export const HARVEST_ENTRY_PATH_KEY = 'loads:harvestEntryPath'

/** Call after a successful save on either entry path. Safe under SSR/private
 *  mode — storage errors are swallowed like usePersistentState's. */
export function rememberHarvestEntryPath(path: HarvestEntryPath): void {
  try {
    window.localStorage.setItem(HARVEST_ENTRY_PATH_KEY, JSON.stringify(path))
  } catch {
    /* storage unavailable — emphasis just won't stick */
  }
}
