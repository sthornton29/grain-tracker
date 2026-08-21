// Client-side fetch for a truck's tare history (lib/truck-tare.ts). Reads
// only the columns the seam needs, newest first, capped — a truck's last few
// hundred loads are plenty for a median. Own trucks by truck_id; hauler
// trucks by the name as written (case-insensitive).

import type { SupabaseClient } from '@supabase/supabase-js'
import { TARE_HISTORY_SELECT, type TareHistoryLoad } from '@/lib/truck-tare'

const LIMIT = 400

export async function fetchTruckTareHistory(
  supabase: SupabaseClient,
  sel: { truck_id?: string | null; hauler_truck?: string | null },
): Promise<TareHistoryLoad[]> {
  let q = supabase
    .from('loads')
    .select(TARE_HISTORY_SELECT)
    .not('tare_weight', 'is', null)
    .gt('tare_weight', 0)
    .order('date', { ascending: false })
    .order('time', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  if (sel.truck_id) q = q.eq('truck_id', sel.truck_id)
  else if (sel.hauler_truck?.trim()) q = q.ilike('hauler_truck', sel.hauler_truck.trim())
  else return []
  const { data, error } = await q
  if (error) return []
  return (data ?? []) as TareHistoryLoad[]
}

/** History for several own trucks at once (the scan review table). */
export async function fetchTrucksTareHistory(supabase: SupabaseClient, truckIds: readonly string[]): Promise<TareHistoryLoad[]> {
  const ids = Array.from(new Set(truckIds.filter(Boolean)))
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('loads')
    .select(TARE_HISTORY_SELECT)
    .in('truck_id', ids)
    .not('tare_weight', 'is', null)
    .gt('tare_weight', 0)
    .order('date', { ascending: false })
    .order('time', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(LIMIT * Math.min(ids.length, 10))
  if (error) return []
  return (data ?? []) as TareHistoryLoad[]
}
