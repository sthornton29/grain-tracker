import type { SupabaseClient } from '@supabase/supabase-js'

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

// After a buyer-delivered load is created or its ticket number corrected,
// persist the match: any unsettled settlement line for the SAME buyer whose
// ticket number now equals this load's ticket gets its load_id back-filled.
//
// Settlement lines are paired to loads by ticket number when a settlement is
// entered (app/settlements/new/page.tsx). If the load doesn't exist yet, or its
// ticket is wrong at that point, the line is saved with a null load_id. The
// Review screen re-pairs such lines at view time (app/settlements/[id]/page.tsx)
// but never writes back — so the DB stays stale and anything reading load_id
// directly (the list's Unmatched count, exports) keeps showing a mismatch.
// Calling this when the load is saved makes the match stick.
//
// Skips ambiguous tickets (more than one buyer load sharing the ticket) so we
// never auto-link the wrong load — the operator resolves those by hand.
export async function relinkSettlementLinesForLoad(
  supabase: SupabaseClient,
  load: {
    id: string
    to_type: string | null
    to_buyer_id: string | null
    ticket_number: string | null
  },
): Promise<void> {
  const key = norm(load.ticket_number)
  if (load.to_type !== 'buyer' || !load.to_buyer_id || !key) return

  // Ambiguity guard: bail if another buyer load already carries this ticket.
  const { data: buyerLoads } = await supabase
    .from('loads')
    .select('id, ticket_number')
    .eq('to_type', 'buyer')
    .eq('to_buyer_id', load.to_buyer_id)
  const sameTicket = (buyerLoads ?? []).filter((l) => norm(l.ticket_number) === key)
  if (sameTicket.length > 1) return

  const { data: settlements } = await supabase
    .from('settlements')
    .select('id')
    .eq('buyer_id', load.to_buyer_id)
  const settlementIds = (settlements ?? []).map((s) => s.id)
  if (settlementIds.length === 0) return

  const { data: lines } = await supabase
    .from('settlement_lines')
    .select('id, ticket_number')
    .in('settlement_id', settlementIds)
    .is('load_id', null)
  const lineIds = (lines ?? []).filter((l) => norm(l.ticket_number) === key).map((l) => l.id)
  if (lineIds.length === 0) return

  await supabase.from('settlement_lines').update({ load_id: load.id }).in('id', lineIds)
}
