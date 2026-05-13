-- Grain Tracker — split loads (one load sourced from multiple fields).
-- Idempotent: safe to re-run.
--
-- A "split load" is a load whose grain came from more than one field. We keep
-- the parent load row intact (same ticket, same buyer, same payment, same bin
-- inflow) and break out per-field allocation rows. The parent's from_field_id
-- is NULL for split loads; loads.from_type stays 'field' so existing filters
-- continue to work.

create table if not exists public.load_splits (
  id uuid primary key default gen_random_uuid(),
  load_id uuid not null references public.loads(id) on delete cascade,
  field_id uuid not null references public.fields(id) on delete restrict,
  crop_id uuid not null references public.crops(id) on delete restrict,
  net_weight numeric(10,2) not null check (net_weight > 0),
  percentage numeric(6,3) not null check (percentage > 0 and percentage <= 100),
  wet_bushels numeric(12,2),
  dry_bushels numeric(12,2),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists load_splits_load_idx  on public.load_splits(load_id);
create index if not exists load_splits_field_idx on public.load_splits(field_id);
create index if not exists load_splits_crop_idx  on public.load_splits(crop_id);

alter table public.load_splits enable row level security;
drop policy if exists "load_splits authed all" on public.load_splits;
create policy "load_splits authed all" on public.load_splits
  for all to authenticated using (true) with check (true);
