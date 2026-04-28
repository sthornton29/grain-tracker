-- Grain Tracker — bin inventory adjustments
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- Holds two kinds of non-load events that change a bin's on-hand bushels:
--   - 'beginning_inventory': grain that was already in the bin before
--     load tracking started (e.g. onboarding, carryover from a prior crop year)
--   - 'empty_bin': a cleanout event that zeros the bin for a given crop, with
--     `bushels` recording how much was emptied (kept positive for clarity)
-- The application formula is:
--   on_hand = sum(load deliveries TO bin)
--           - sum(load pulls FROM bin)
--           + sum(beginning_inventory.bushels)
--           - sum(empty_bin.bushels)
-- Only adjustments with as_of_date <= the report's view date are included.

create extension if not exists "pgcrypto";

create table if not exists public.bin_inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  bin_id uuid not null references public.bins(id) on delete cascade,
  crop_id uuid not null references public.crops(id) on delete restrict,
  adjustment_type text not null
    check (adjustment_type in ('beginning_inventory', 'empty_bin')),
  bushels numeric(12,2) not null check (bushels >= 0),
  moisture numeric(5,2),
  as_of_date date not null,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists bin_inv_adj_bin_idx
  on public.bin_inventory_adjustments(bin_id);
create index if not exists bin_inv_adj_crop_idx
  on public.bin_inventory_adjustments(crop_id);
create index if not exists bin_inv_adj_date_idx
  on public.bin_inventory_adjustments(as_of_date);
create index if not exists bin_inv_adj_type_idx
  on public.bin_inventory_adjustments(adjustment_type);

alter table public.bin_inventory_adjustments enable row level security;

do $$ begin
  drop policy if exists "authed all" on public.bin_inventory_adjustments;
  create policy "authed all"
    on public.bin_inventory_adjustments
    for all to authenticated
    using (true)
    with check (true);
end $$;
