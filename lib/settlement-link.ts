import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { matchTicket, normalizeTicket } from '@/lib/ticket-matching'

// Ticket ↔ load matching persistence — on the SHARED seam (lib/ticket-
// matching, 086): exact after normalization (trim, case, leading zeros),
// then segment (the buyer's ticket inside our dash-delimited internal
// number, or the buyer's Load Order # on the line). Attribute matching
// (date + weight) needs the statement's per-ticket facts and the reviewer's
// confirmation, so it lives only on the upload review screen.

// After a buyer-delivered load is created or its ticket number corrected,
// persist the match: any unsettled settlement line for the SAME buyer whose
// ticket now matches this load's ticket (exact or segment) gets its load_id
// back-filled.
//
// Settlement lines are paired to loads by ticket when a settlement is
// entered (app/settlements/new/page.tsx). If the load doesn't exist yet, or
// its ticket is wrong at that point, the line is saved with a null load_id.
// The Review screen re-pairs such lines at view time
// (app/settlements/[id]/page.tsx) but never writes back — so the DB stays
// stale and anything reading load_id directly (the list's Unmatched count,
// exports) keeps showing a mismatch. Calling this when the load is saved
// makes the match stick.
//
// Skips ambiguous tickets (more than one buyer load matching) so we never
// auto-link the wrong load — the operator resolves those by hand.
export async function relinkSettlementLinesForLoad(
  supabase: SupabaseClient,
  load: {
    id: string
    to_type: string | null
    to_buyer_id: string | null
    ticket_number: string | null
  },
): Promise<void> {
  const key = normalizeTicket(load.ticket_number)
  if (load.to_type !== 'buyer' || !load.to_buyer_id || !key) return

  const { data: buyerLoads } = await fetchAllRows<{ id: string; ticket_number: string | null }>((f, t) =>
    supabase.from('loads').select('id, ticket_number').eq('to_type', 'buyer').eq('to_buyer_id', load.to_buyer_id).order('id').range(f, t),
  )
  const pool = (buyerLoads ?? []).filter((l) => l.id === load.id || normalizeTicket(l.ticket_number))

  const { data: settlements } = await supabase
    .from('settlements')
    .select('id')
    .eq('buyer_id', load.to_buyer_id)
  const settlementIds = (settlements ?? []).map((s) => s.id)
  if (settlementIds.length === 0) return

  const { data: lines } = await supabase
    .from('settlement_lines')
    .select('id, ticket_number, buyer_ref')
    .in('settlement_id', settlementIds)
    .is('load_id', null)
  const byTier = new Map<string, string[]>()
  for (const ln of (lines ?? []) as Array<{ id: string; ticket_number: string | null; buyer_ref?: string | null }>) {
    const r = matchTicket({ ticket_number: ln.ticket_number, secondary_refs: [ln.buyer_ref] }, pool)
    if (r.status !== 'matched' || r.match.loadId !== load.id) continue
    const arr = byTier.get(r.match.tier) ?? []
    arr.push(ln.id)
    byTier.set(r.match.tier, arr)
  }
  for (const [tier, ids] of byTier) {
    await supabase.from('settlement_lines').update({ load_id: load.id, match_tier: tier, match_reason: `ticket ${key} (${tier})` }).in('id', ids)
  }
}

// Persist ticket→load matches for an ENTIRE settlement. Called when the Review
// screen loads so the DB stays in sync with what the screen shows: every
// unambiguous exact or segment match gets its load_id (and tier) written.
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
    .select('id, ticket_number, load_id, buyer_ref')
    .eq('settlement_id', settlementId)
  const unlinked = ((lines ?? []) as Array<{ id: string; ticket_number: string | null; load_id: string | null; buyer_ref?: string | null }>)
    .filter((l) => !l.load_id && (normalizeTicket(l.ticket_number) || normalizeTicket(l.buyer_ref)))
  if (unlinked.length === 0) return 0

  // Paginated (lib/fetch-all-rows): a buyer's loads exceed the ~1,000-row
  // request cap over the years, and a truncated read here would silently
  // leave settlement lines unlinked.
  const { data: buyerLoads } = await fetchAllRows<{ id: string; ticket_number: string | null }>((f, t) =>
    supabase
      .from('loads')
      .select('id, ticket_number')
      .eq('to_type', 'buyer')
      .eq('to_buyer_id', buyerId)
      .order('id')
      .range(f, t),
  )
  const pool = buyerLoads ?? []

  // Text tiers only (exact, segment); each load claimed once; ambiguous or
  // no match → left null for the manual pick.
  const used = new Set<string>()
  const updates: Array<{ lineId: string; loadId: string; tier: string; reason: string }> = []
  for (const ln of unlinked) {
    const r = matchTicket({ ticket_number: ln.ticket_number, secondary_refs: [ln.buyer_ref] }, pool, {}, used)
    if (r.status !== 'matched') continue
    used.add(r.match.loadId)
    updates.push({ lineId: ln.id, loadId: r.match.loadId, tier: r.match.tier, reason: r.match.reason })
  }

  let persisted = 0
  for (const u of updates) {
    const { error } = await supabase.from('settlement_lines').update({ load_id: u.loadId, match_tier: u.tier, match_reason: u.reason }).eq('id', u.lineId)
    if (error) {
      // 086 columns not applied yet — persist the link alone.
      const fallback = await supabase.from('settlement_lines').update({ load_id: u.loadId }).eq('id', u.lineId)
      if (!fallback.error) persisted += 1
    } else persisted += 1
  }
  return persisted
}
