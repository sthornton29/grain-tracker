'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { friendlyError } from '@/lib/friendly-error'

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
  if (error) {
    console.error('[turnrow] match settlement line', error)
    return { ok: false, error: friendlyError(error, { action: 'match this line to the load', noun: 'line' }) }
  }
  revalidatePath(`/settlements/${settlementId}`)
  revalidatePath('/settlements')
  return { ok: true }
}

// "Add line" on a Missing load: a new settlement line already tied to that
// load, seeded with our dry bushels so the user only types the dollars.
// Gross/discounts start at zero — the detail page shows the line under
// Matched loads, where the amounts can be filled in.
export async function addSettlementLineForLoad(
  settlementId: string,
  load: { id: string; ticket_number: string | null; dryBushels: number },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createClient()
  const { error } = await supabase.from('settlement_lines').insert({
    settlement_id: settlementId,
    load_id: load.id,
    ticket_number: load.ticket_number?.trim() || null,
    net_bushels: Math.round(load.dryBushels * 100) / 100,
    gross_revenue: 0,
    discounts: 0,
    notes: 'Added from Missing loads — enter the dollars from the statement.',
  })
  if (error) {
    console.error('[turnrow] add settlement line for load', error)
    return { ok: false, error: friendlyError(error, { action: 'add this line', noun: 'line' }) }
  }
  revalidatePath(`/settlements/${settlementId}`)
  revalidatePath('/settlements')
  return { ok: true }
}
