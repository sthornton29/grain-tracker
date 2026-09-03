-- 079: Freight Math per-location wait times + Dryer Math org settings.
-- Idempotent: safe to re-run.
--
--   1. delivery_locations.wait_hours — nullable, per-location OVERRIDE of the
--      Freight Math global "load/unload + wait" assumption
--      (freight_settings.load_unload_hours). Elevator lines vary wildly and
--      everyone knows which houses make you sit: when set, the calculator
--      uses this location's hours instead of the global figure; blank = the
--      global default. An existing tenant table — the column rides its
--      policies. Edited in the Freight Math assumptions panel's by-buyer
--      distance table (a Wait column beside each location's miles).
--
--   2. dryer_settings — ONE row per org (freight_settings pattern): the
--      Dryer Math depreciation assumption in ¢ per bushel dried (default
--      4.0¢ ≈ $300,000 ÷ 15 yr ÷ 500,000 bu/yr), applied flat per bushel
--      dried — NOT per point — in every above-base row's total; plus the
--      "include depreciation in the dry-vs-haul comparison" toggle (default
--      on; the note in the UI explains why a user may prefer it off for the
--      marginal decision). Full 053/054/042/052/061 policy stack inline
--      (078 loop pattern: gin blocked, viewers write-blocked — the report
--      route is viewer-blocked — agronomists blocked from writes AND reads).

create extension if not exists "pgcrypto";

-- 1. Per-location wait hours ---------------------------------------------------

alter table public.delivery_locations
  add column if not exists wait_hours numeric check (wait_hours >= 0);

-- 2. dryer_settings -----------------------------------------------------------

create table if not exists public.dryer_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  -- Flat per bushel dried (the extension convention), not per point.
  depreciation_cents_per_bu numeric not null default 4.0 check (depreciation_cents_per_bu >= 0),
  include_depreciation_in_comparison boolean not null default true,
  -- The optional mini-calculator's last inputs, so the derivation reopens
  -- where it was left (all nullable: the ¢/bu figure stands on its own).
  dryer_investment numeric check (dryer_investment >= 0),
  useful_life_years numeric check (useful_life_years > 0),
  bushels_dried_per_year numeric check (bushels_dried_per_year > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dryer_settings_org_idx on public.dryer_settings (org_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dryer_settings_org_unique') then
    alter table public.dryer_settings add constraint dryer_settings_org_unique unique (org_id);
  end if;
end $$;

drop trigger if exists dryer_settings_set_updated_at on public.dryer_settings;
create trigger dryer_settings_set_updated_at
  before update on public.dryer_settings
  for each row execute function public.set_updated_at();

-- 3. Policy stack (078 loop pattern) -------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['dryer_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    -- Base permissive policy (mirrors every other tenant table).
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed all') then
      execute format('create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
    -- 054 org isolation.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042: grain-operation tables, gin users blocked.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    -- 052: viewers write-blocked (the report route is viewer-blocked too).
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''viewer'')', t || '_viewer_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_del', t);
    end if;
    -- 061 agronomist: write-blocked AND select-blocked (not the Yields surface).
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_del', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_sel') then
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_sel', t);
    end if;
  end loop;
end $$;
