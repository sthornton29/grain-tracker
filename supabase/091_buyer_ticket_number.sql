-- 091: The buyer's full ticket number on a load. When a settlement line is
-- matched to a load by segment, suffix (a long buyer ticket entered as its
-- short tail), attribute, or by hand, the buyer's ticket as printed is
-- stored here — our own ticket_number is never overwritten — so a re-issued
-- statement and the paid / unpaid badge match exactly the next time.
-- settlement_lines.match_tier gains 'suffix' (lib/ticket-matching tier 2b).
-- Existing tenant tables — the columns ride loads' / settlement_lines'
-- policy stacks. Idempotent.

alter table public.loads
  add column if not exists buyer_ticket_number text;

create index if not exists loads_buyer_ticket_idx
  on public.loads (buyer_ticket_number)
  where buyer_ticket_number is not null;

alter table public.settlement_lines
  drop constraint if exists settlement_lines_match_tier_check;
alter table public.settlement_lines
  add constraint settlement_lines_match_tier_check
  check (match_tier in ('exact', 'segment', 'suffix', 'attribute', 'manual'));
