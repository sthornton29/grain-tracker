// ONE crop-year rule for every report:
//   * default to the current crop year (calendar year);
//   * persist the pick per report in localStorage (same JSON convention and
//     keys as lib/use-persistent-state, so existing saved picks carry over);
//   * NEVER overwrite a persisted pick when the data loads — a report that
//     used to "default to the latest year with plantings" only does so when
//     the user has never picked a year on that report;
//   * if the untouched default has no data and the report hands us the years
//     it can show, fall back once to the newest year at or before today
//     (else the newest available) so the page never opens blank.
//
// Reports keep their other filters on usePersistentState as before.

import { useCallback, useEffect, useRef, useState } from 'react'

export type CropYearValue = number | ''

export function currentCropYear(): number {
  return new Date().getFullYear()
}

/** The best year to show when the user has never picked one: the newest
 *  option at or before `now`, else the newest option, else `now`. */
export function fallbackCropYear(options: ReadonlyArray<number>, now = currentCropYear()): number {
  if (options.length === 0) return now
  if (options.includes(now)) return now
  const past = options.filter((y) => y < now)
  if (past.length > 0) return Math.max(...past)
  return Math.min(...options)
}

export function useReportCropYear(
  storageKey: string,
  opts: {
    /** The crop years this report can show (from its data). Used only for the
     *  one-time fallback when nothing is persisted. */
    options?: ReadonlyArray<number>
    /** True once the report's data has loaded (the fallback waits for it). */
    loaded?: boolean
    /** Allow '' = "All crop years" as a value (Cash Flow). Never the default. */
    allowAll?: boolean
    now?: number
  } = {},
): readonly [CropYearValue, (v: CropYearValue) => void] {
  const now = opts.now ?? currentCropYear()
  const [value, setValueState] = useState<CropYearValue>(now)
  // 'unknown' until the browser storage is read; 'stored' when the user has a
  // saved pick; 'default' when they never picked on this report.
  const origin = useRef<'unknown' | 'stored' | 'default' | 'user'>('unknown')
  const fellBack = useRef(false)

  // Read the saved pick once on mount (browser only; SSR renders the default).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw != null) {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed === 'number' && Number.isFinite(parsed)) {
          origin.current = 'stored'
          setValueState(parsed)
          return
        }
        if (parsed === '' && opts.allowAll) {
          origin.current = 'stored'
          setValueState('')
          return
        }
      }
    } catch { /* unreadable storage — keep the default */ }
    origin.current = 'default'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One-time fallback: the untouched default has no data → newest sensible year.
  useEffect(() => {
    if (origin.current !== 'default' || fellBack.current) return
    if (!opts.loaded || !opts.options || opts.options.length === 0) return
    fellBack.current = true
    if (typeof value === 'number' && !opts.options.includes(value)) {
      setValueState(fallbackCropYear(opts.options, now))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.loaded, opts.options])

  const setValue = useCallback((v: CropYearValue) => {
    origin.current = 'user'
    setValueState(v)
    try { window.localStorage.setItem(storageKey, JSON.stringify(v)) } catch { /* private mode — no persistence */ }
  }, [storageKey])

  return [value, setValue] as const
}

/** The dropdown list for a crop-year select: the report's years plus the
 *  current pick and the current calendar year, newest first, no duplicates. */
export function cropYearChoices(options: ReadonlyArray<number | null | undefined>, current: CropYearValue, now = currentCropYear()): number[] {
  const set = new Set<number>()
  for (const y of options) if (y != null && Number.isFinite(y)) set.add(Number(y))
  if (typeof current === 'number') set.add(current)
  set.add(now)
  return [...set].sort((a, b) => b - a)
}
