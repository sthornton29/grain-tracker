-- 058: Bin capacity + bin-to-bin grain transfers
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- Adds:
--   * bins.capacity_bushels — optional rated capacity so the Bin Inventory
--     page can show a percent-full bar. Nullable; bins without a capacity
--     render exactly as before.
--   * bin_transfers — grain moved between two bins (e.g. wet bin → dry bin
--     after drying). Bushels are DRY-BASIS, so a wet→dry transfer nets zero
--     across the operation: the source loses X dry bushels, the destination
--     gains the same X. Drying shrink is already handled by the dry-bushel
--     conversion on loads, so transfers never change operation totals.
--
--     method 'entered'   — the user typed the bushel amount directly.
--     method 'estimated' — the amount came from throughput × hours run
--                          (both inputs are stored for the audit trail; the
--                          user could still edit the computed bushels).
--
--   Transfers are NOT loads: they never touch yields, production, contract
--   deliveries, or marketing math. They only shift where grain sits.
--
-- Multi-tenant conventions (053/054): org_id NOT NULL with the
-- current_org_id()/default_org_id() default, RESTRICTIVE org isolation
-- policy, gin write-block (042 pattern), viewer write-block (052 pattern).
-- 'bin_transfers' is also added to the tenant arrays in 053/054 and the
-- verify scripts.

create extension if not exists "pgcrypto";

-- 1. Bin capacity -------------------------------------------------------------

alter table public.bins add column if not exists capacity_bushels numeric(12,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bins_capacity_positive') then
    alter table public.bins
      add constraint bins_capacity_positive
      check (capacity_bushels is null or capacity_bushels > 0);
  end if;
end $$;

-- 2. Bin-to-bin transfers -----------------------------------------------------

create table if not exists public.bin_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  from_bin_id uuid not null references public.bins(id) on delete cascade,
  to_bin_id uuid not null references public.bins(id) on delete cascade,
  crop_id uuid not null references public.crops(id) on delete restrict,
  bushels numeric(12,2) not null check (bushels > 0),
  transfer_date date not null,
  method text not null default 'entered' check (method in ('entered', 'estimated')),
  throughput_bu_per_hr numeric(10,2) check (throughput_bu_per_hr is null or throughput_bu_per_hr > 0),
  hours_run numeric(8,2) check (hours_run is null or hours_run > 0),
  notes text,
  created_at timestamptz not null default now(),
  constraint bin_transfers_distinct_bins check (from_bin_id <> to_bin_id)
);

create index if not exists bin_transfers_from_idx on public.bin_transfers(from_bin_id);
create index if not exists bin_transfers_to_idx on public.bin_transfers(to_bin_id);
create index if not exists bin_transfers_crop_idx on public.bin_transfers(crop_id);
create index if not exists bin_transfers_date_idx on public.bin_transfers(transfer_date);
create index if not exists bin_transfers_org_idx on public.bin_transfers(org_id);

alter table public.bin_transfers enable row level security;

do $$ begin
  -- Base permissive policy (mirrors every other tenant table); the
  -- restrictive policies below carve it down.
  if not exists (select 1 from pg_policies where tablename = 'bin_transfers' and policyname = 'authed all') then
    create policy "authed all" on public.bin_transfers
      for all to authenticated using (true) with check (true);
  end if;

  -- 054 org isolation: rows are visible/writable only inside the member's org.
  if not exists (select 1 from pg_policies where tablename = 'bin_transfers' and policyname = 'bin_transfers_org_isolation') then
    create policy bin_transfers_org_isolation on public.bin_transfers
      as restrictive for all to authenticated
      using (org_id = public.current_org_id())
      with check (org_id = public.current_org_id());
  end if;

  -- 042 pattern: grain tables are fully blocked for gin users.
  if not exists (select 1 from pg_policies where tablename = 'bin_transfers' and policyname = 'bin_transfers_owner_only') then
    create policy bin_transfers_owner_only on public.bin_transfers
      as restrictive for all to authenticated
      using (public.app_role() <> 'gin')
      with check (public.app_role() <> 'gin');
  end if;

  -- 052 pattern: viewers are write-blocked everywhere.
  if not exists (select 1 from pg_policies where tablename = 'bin_transfers' and policyname = 'bin_transfers_viewer_block_ins') then
    create policy bin_transfers_viewer_block_ins on public.bin_transfers
      as restrictive for insert to authenticated
      with check (public.app_role() <> 'viewer');
    create policy bin_transfers_viewer_block_upd on public.bin_transfers
      as restrictive for update to authenticated
      using (public.app_role() <> 'viewer');
    create policy bin_transfers_viewer_block_del on public.bin_transfers
      as restrictive for delete to authenticated
      using (public.app_role() <> 'viewer');
  end if;
end $$;
