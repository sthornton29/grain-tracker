// Paginated fetch of the full counties reference table. Supabase caps a
// request at the project db-max-rows limit (~1,000) and there are 3,143
// counties, so a bare .select('*') silently truncates — any county past the
// cap disappears from pickers and benchmark/state resolution. Every counties
// consumer that needs the whole table goes through this.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { County } from '@/lib/types'

export async function fetchAllCounties(supabase: SupabaseClient): Promise<County[]> {
  const PAGE = 1000
  const out: County[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('counties')
      .select('*')
      .order('name', { ascending: true })
      .order('state_code', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as County[]
    out.push(...batch)
    if (batch.length < PAGE) break
  }
  return out
}
