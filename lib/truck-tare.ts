// Per-truck tare baseline — the ONE seam behind the low-tare warning (new /
// edit load forms, the AI ticket-scan review table, the load log's subtle
// badge) and the "Use last tare" shortcut on the new-load form.
//
// A truck is keyed by what the load actually stores: our own trucks by
// loads.truck_id; hauler trucks (067) by the free-text loads.hauler_truck,
// normalised (trimmed, case-folded, whitespace-collapsed) so "JD Trucking 12"
// and "jd trucking  12" are the same truck. From that truck's historical
// loads we take the most recent load's tare ("last tare") and a robust
// "normal" tare — the MEDIAN of its tares — which only exists once the truck
// has at least TARE_BASELINE_MIN_LOADS usable loads. Loads with a null or
// zero tare never count. A split load is ONE truck trip (load_splits is an
// allocation table under the parent), so history is de-duplicated by load id
// in case a caller hands in parent rows joined to their splits.
//
// The warning is advisory only — never blocks a save; a real ticket can be
// odd (a trailer dropped, a different tractor). Pure module, no I/O; the
// fetch helper that feeds it lives in lib/truck-tare-fetch.ts.

/** Flag a tare at or below (1 − this) × the truck's normal tare: 0.5 ⇒ 50%
 *  or more below normal. Named so it can become a setting later. */
export const LOW_TARE_WARN_FRACTION = 0.5

/** Historical usable loads a truck needs before a "normal" tare exists. */
export const TARE_BASELINE_MIN_LOADS = 3

export type TareHistoryLoad = {
  id: string
  date: string
  time?: string | null
  created_at?: string | null
  tare_weight: number | string | null
  truck_id: string | null
  hauler_truck: string | null
}

export type TruckTareStats = {
  /** The most recent usable load's tare (by date, then time, then created_at). */
  lastTare: number | null
  /** That load's date (YYYY-MM-DD), for the "Use last tare" hover. */
  lastTareDate: string | null
  /** Median tare over the truck's usable loads; null until the truck has
   *  TARE_BASELINE_MIN_LOADS of them. */
  normalTare: number | null
  /** Usable loads behind the stats. */
  sampleCount: number
}

export const EMPTY_TARE_STATS: TruckTareStats = { lastTare: null, lastTareDate: null, normalTare: null, sampleCount: 0 }

export function normalizeHaulerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** The history key for a truck selection: own trucks by id, hauler trucks
 *  by normalised name. Null when nothing is selected. */
export function truckTareKey(sel: { truck_id?: string | null; hauler_truck?: string | null }): string | null {
  if (sel.truck_id) return `own:${sel.truck_id}`
  const hauler = sel.hauler_truck ? normalizeHaulerName(sel.hauler_truck) : ''
  return hauler ? `hauler:${hauler}` : null
}

const tareOf = (l: TareHistoryLoad): number | null => {
  const n = Number(l.tare_weight)
  return l.tare_weight == null || !Number.isFinite(n) || n <= 0 ? null : n
}

// Most recent first: date, then time, then created_at (all string-comparable).
function recencyDesc(a: TareHistoryLoad, b: TareHistoryLoad): number {
  return (
    b.date.localeCompare(a.date) ||
    (b.time ?? '').localeCompare(a.time ?? '') ||
    (b.created_at ?? '').localeCompare(a.created_at ?? '')
  )
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Stats for one truck from its (or a mixed set of) historical loads. Pass
 *  `excludeLoadId` on the edit form so a load never baselines itself. */
export function truckTareStats(
  loads: readonly TareHistoryLoad[],
  key: string | null,
  opts?: { excludeLoadId?: string | null },
): TruckTareStats {
  if (!key) return EMPTY_TARE_STATS
  const seen = new Set<string>()
  const usable: TareHistoryLoad[] = []
  for (const l of loads) {
    if (seen.has(l.id)) continue // split parents joined to their splits count once
    seen.add(l.id)
    if (opts?.excludeLoadId && l.id === opts.excludeLoadId) continue
    if (truckTareKey(l) !== key) continue
    if (tareOf(l) == null) continue
    usable.push(l)
  }
  if (usable.length === 0) return EMPTY_TARE_STATS
  usable.sort(recencyDesc)
  const last = usable[0]
  const tares = usable.map((l) => tareOf(l)!)
  return {
    lastTare: tareOf(last),
    lastTareDate: last.date,
    normalTare: usable.length >= TARE_BASELINE_MIN_LOADS ? median(tares) : null,
    sampleCount: usable.length,
  }
}

/** Stats for every truck present in `loads` at once (review tables, the log). */
export function buildTareStatsIndex(loads: readonly TareHistoryLoad[]): Map<string, TruckTareStats> {
  const keys = new Set<string>()
  for (const l of loads) {
    const k = truckTareKey(l)
    if (k) keys.add(k)
  }
  const out = new Map<string, TruckTareStats>()
  for (const k of keys) out.set(k, truckTareStats(loads, k))
  return out
}

/** True when `tare` is LOW_TARE_WARN_FRACTION or more below the normal tare
 *  (exactly 50% below flags; 49% below does not). */
export function isLowTare(tare: number | null | undefined, normalTare: number | null | undefined): boolean {
  if (tare == null || normalTare == null || !(normalTare > 0) || !(tare > 0)) return false
  // Compare in integer-ish space to keep the 50% boundary exact under floats.
  return tare * 1e6 <= Math.round(normalTare * (1 - LOW_TARE_WARN_FRACTION) * 1e6)
}

const fmtLbs = (n: number) => Math.round(n).toLocaleString('en-US')

/** The inline warning for a tare against a truck's stats, or null. */
export function lowTareWarning(tare: number | null | undefined, stats: TruckTareStats | null | undefined): string | null {
  if (!stats || stats.normalTare == null || tare == null) return null
  if (!isLowTare(tare, stats.normalTare)) return null
  return `Tare ${fmtLbs(tare)} lbs is well below this truck's usual ~${fmtLbs(stats.normalTare)} lbs. Double-check the ticket; a low tare overstates net weight.`
}

/** Columns the fetch helpers select — one place to keep them in step. */
export const TARE_HISTORY_SELECT = 'id, date, time, created_at, tare_weight, truck_id, hauler_truck'
