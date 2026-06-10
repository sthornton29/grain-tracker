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

// Persist ticket→load matches for an ENTIRE settlement. Called when the Review
// screen loads so the DB stays in sync with what the screen shows: every
// unlinked line whose ticket matches exactly one of the buyer's delivered loads
// gets its load_id back-filled. Ambiguous tickets (matching more than one load)
// are left null for manual resolution. Returns the number of lines persisted.
export async function relinkSettlementLines(
  supabase: SupabaseClient,
  settlementId: string,
): Promise<number> {
  const { data: settlement } = await supabase
    .from('settlements').select('buyer_id').eq('id', settlementId).single()
  const buyerId = (settlement as { buyer_id: string } | null)?.buyer_id
  if (!buyerId) return 0

  const { data: lines } = await supabase
    .from('settlement_lines')
    .select('id, ticket_number, load_id')
    .eq('settlement_id', settlementId)
  const unlinked = (lines ?? []).filter((l) => !l.load_id && norm(l.ticket_number))
  if (unlinked.length === 0) return 0

  const { data: buyerLoads } = await supabase
    .from('loads')
    .select('id, ticket_number')
    .eq('to_type', 'buyer')
    .eq('to_buyer_id', buyerId)

  // ticket → list of load ids that carry it.
  const byTicket = new Map<string, string[]>()
  for (const l of buyerLoads ?? []) {
    const t = norm(l.ticket_number)
    if (!t) continue
    const arr = byTicket.get(t)
    if (arr) arr.push(l.id)
    else byTicket.set(t, [l.id])
  }

  // load id → line ids to set (only unambiguous, count === 1, matches).
  const updates = new Map<string, string[]>()
  for (const ln of unlinked) {
    const cands = byTicket.get(norm(ln.ticket_number)) ?? []
    if (cands.length !== 1) continue // ambiguous or no match → leave null
    const arr = updates.get(cands[0])
    if (arr) arr.push(ln.id)
    else updates.set(cands[0], [ln.id])
  }

  let persisted = 0
  for (const [loadId, lineIds] of updates) {
    const { error } = await supabase.from('settlement_lines').update({ load_id: loadId }).in('id', lineIds)
    if (!error) persisted += lineIds.length
  }
  return persisted
}
