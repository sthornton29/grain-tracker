// Save the manual lint turnout (092) for a crop × crop year — the one write
// behind every Yields view and the Yields by Landowner report. Owners write
// the shared crop_assumptions row (a minimal upsert — defaults fill the
// rest); viewers (052) a private override, cleared when it matches the
// shared figure. Returns the reloaded shared rows after an owner write.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ViewerAssumptionsApi } from '@/lib/use-viewer-assumptions'
import type { CropAssumption } from '@/lib/types'
import type { FriendlyErrorInput } from '@/lib/friendly-error'

export async function saveTurnoutAssumption(supabase: SupabaseClient, args: {
  cropId: string
  cropYear: number
  value: number | null
  /** The SHARED rows (never the viewer-resolved ones). */
  assumptions: ReadonlyArray<CropAssumption>
  isViewer: boolean
  canEdit: boolean
  viewerA: Pick<ViewerAssumptionsApi, 'saveOverride' | 'resetOverride'>
}): Promise<{ error: FriendlyErrorInput | null; assumptions: CropAssumption[] | null }> {
  const { cropId, cropYear, value } = args
  const base = args.assumptions.find((a) => a.crop_id === cropId && a.crop_year === cropYear) ?? null
  if (args.isViewer) {
    const baseVal = base?.assumed_turnout_pct != null ? Number(base.assumed_turnout_pct) : null
    if (value === baseVal) await args.viewerA.resetOverride({ scope: 'crop', cropId, cropYear, field: 'assumed_turnout_pct' })
    else await args.viewerA.saveOverride({ scope: 'crop', cropId, cropYear, field: 'assumed_turnout_pct', value, base })
    return { error: null, assumptions: null }
  }
  if (!args.canEdit) return { error: null, assumptions: null }
  const { error } = base
    ? await supabase.from('crop_assumptions').update({ assumed_turnout_pct: value, updated_at: new Date().toISOString() }).eq('id', base.id)
    : await supabase.from('crop_assumptions').insert({ crop_id: cropId, crop_year: cropYear, assumed_turnout_pct: value })
  if (error) return { error, assumptions: null }
  const ca = await supabase.from('crop_assumptions').select('*')
  return { error: null, assumptions: (ca.data as CropAssumption[]) || [] }
}
