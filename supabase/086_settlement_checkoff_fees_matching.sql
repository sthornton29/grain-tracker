-- 086: Checkoff and fees as first-class settlement categories; the columns
-- the tolerant settlement-to-load matching and the Bunge-shape extraction
-- need. Idempotent: safe to re-run in the Supabase SQL editor.
--
--   1. settlement_discount_items.category gains 'checkoff' (state / national
--      promotion assessments — refundable in some states on request) and
--      'fee' (non-quality service charges: vehicle inspection, grading,
--      unload, administrative). Neither is a QUALITY discount: the settlement
--      summary lists them outside "discounts", the buyer discount history and
--      lost-revenue math exclude them, and the price walk shows them as
--      distinct deductions. Existing 'other' rows whose wording says
--      checkoff / assessment / promotion / board / fee are backfilled.
--   2. settlements gains the payment fields the check / remittance page
--      yields (payment number, check number, payment date — never a ticket)
--      and contract_id (the header contract number linked to the matching
--      contract).
--   3. settlement_lines gains grade_readings (jsonb: moisture, fm, splits,
--      total_damage, heat_damage, test_weight, other_color, oil, protein…
--      as the statement's per-ticket grade block reads), buyer_ref (the
--      buyer's secondary identifier — Bunge's Load Order # — used as a
--      matching key), and match_tier / match_reason (how the line was
--      matched to its load: exact / segment / attribute, and why).
--   4. trucks gains license_plate — the plate a statement prints per ticket
--      corroborates an attribute match.
-- All existing tenant tables: the columns ride their existing policies.

-- 1. Categories -----------------------------------------------------------------

do $$ begin
  alter table public.settlement_discount_items drop constraint if exists settlement_discount_items_category_check;
  alter table public.settlement_discount_items
    add constraint settlement_discount_items_category_check check (category in (
      'moisture_shrink', 'drying', 'test_weight', 'damage', 'heat_damage',
      'foreign_material', 'dockage', 'splits', 'sprout', 'musty_sour',
      'checkoff', 'fee', 'other'));
end $$;

-- Backfill: 'other' rows whose wording is a checkoff / assessment / promotion
-- program (or a named board / commission / council) → checkoff; non-quality
-- service charges → fee. Quality words never move.
update public.settlement_discount_items
   set category = 'checkoff'
 where category = 'other'
   and coalesce(description, '') ~* '(check[- ]?off|promotion|assessment|soybean board|corn board|wheat board|cotton board|commission|council|research and promotion|\mI02\M)';

update public.settlement_discount_items
   set category = 'fee'
 where category = 'other'
   and coalesce(description, '') ~* '(vehicle inspection|inspection fee|grading fee|grade fee|unload(ing)? fee|administrative|admin fee|service (charge|fee)|handling fee|\mI11\M)'
   and coalesce(description, '') !~* '(moisture|test weight|damage|foreign|dockage|shrink|drying|splits|sprout|musty|sour)';

-- 2. settlements: payment fields + contract link ---------------------------------

alter table public.settlements
  add column if not exists contract_id uuid references public.contracts(id) on delete set null,
  add column if not exists payment_number text,
  add column if not exists check_number text,
  add column if not exists payment_date date;

create index if not exists settlements_contract_idx on public.settlements (contract_id) where contract_id is not null;

-- 3. settlement_lines: grade readings + secondary ref + match provenance -------

alter table public.settlement_lines
  add column if not exists grade_readings jsonb,
  add column if not exists buyer_ref text,
  add column if not exists match_tier text check (match_tier in ('exact', 'segment', 'attribute', 'manual')),
  add column if not exists match_reason text;

-- 4. trucks: license plate ----------------------------------------------------

alter table public.trucks
  add column if not exists license_plate text;
