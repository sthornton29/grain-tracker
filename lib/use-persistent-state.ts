import { useEffect, useRef, useState } from 'react'

// A useState that remembers its value in localStorage under `key`, so a filter
// the user picked is still there when they come back to the page. SSR-safe:
// the first render always uses `initial` (matching server output), then the
// stored value is applied on mount — no hydration mismatch.
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial)
  // Skips the first persist so the default doesn't clobber a stored value (and
  // so the load effect's setValue below isn't immediately overwritten).
  const firstRun = useRef(true)

  // Load once on mount (browser only).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw != null) setValue(JSON.parse(raw) as T)
    } catch {
      // Ignore unreadable/parse errors — fall back to the default.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist on every change after the initial commit.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Quota/private-mode errors are non-fatal — the filter just won't persist.
    }
  }, [key, value])

  return [value, setValue] as const
}
