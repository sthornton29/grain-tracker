'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

// Manually set (or clear) the load a settlement line is matched to, from the
// Review screen's dropdown. Writes load_id immediately and revalidates both the
// detail and list pages so their matched/unmatched counts stay consistent.
export async function setSettlementLineLoad(
  settlementId: string,
  lineId: string,
  loadId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createClient()
  const { error } = await supabase
    .from('settlement_lines')
    .update({ load_id: loadId })
    .eq('id', lineId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/settlements/${settlementId}`)
  revalidatePath('/settlements')
  return { ok: true }
}
