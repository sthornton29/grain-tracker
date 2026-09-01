-- 078: Freight Math — hauling-cost calculator tables.
-- Idempotent: safe to re-run.
--
-- Behind /reports/freight-math (picked-up vs delivered decisions):
--
--   1. freight_settings — ONE row per org: the calculator's assumptions
--      (truck mpg, average speed, load/unload hours, wear $/mi, optional
--      ownership costs) plus the last-used main inputs (diesel $/gal, labor
--      $/hr) and per-crop payload overrides (jsonb crop_id → bushels; the
--      default payload derives from each crop's test weight in code).
--
--   2. freight_distances — estimated/corrected road miles per bin site ×
--      delivery location. Estimates come from AI-geocoded coordinates ×
--      haversine × a 1.25 road factor (confirm-before-save, labeled
--      estimates); a user's inline correction stamps source 'manual' and a
--      re-estimate never overwrites a manual row (lib/freight-math.ts
--      planDistanceSaves).
--
--   3. latitude/longitude caches on bin_sites and delivery_locations so a
--      geocode runs once per address (both are existing tenant tables — the
--      columns ride their policies).
--
-- Both new tables are tenant tables with the full 053/054/042/052/061 stack
-- inline (org_dryers pattern: gin blocked, viewers write-blocked — the
-- report route itself is viewer-blocked like dryer-math — agronomists
-- blocked from writes AND reads).

create extension if not exists "pgcrypto";

-- 1. Coordinate caches on existing tables ------------------------------------

alter table public.bin_sites add column if not exists latitude numeric(9,6);
alter table public.bin_sites add column if not exists longitude numeric(9,6);
alter table public.delivery_locations add column if not exists latitude numeric(9,6);
alter table public.delivery_locations add column if not exists longitude numeric(9,6);

-- 2. freight_settings ---------------------------------------------------------

create table if not exists public.freight_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  truck_mpg numeric not null default 6.0 check (truck_mpg > 0),
  avg_speed_mph numeric not null default 45 check (avg_speed_mph > 0),
  load_unload_hours numeric not null default 0.75 check (load_unload_hours >= 0),
  wear_per_mile numeric not null default 0.20 check (wear_per_mile >= 0),
  include_ownership boolean not null default false,
  ownership_per_mile numeric check (ownership_per_mile >= 0),
  -- Last-used main inputs, so the page reopens where it was left.
  diesel_price numeric check (diesel_price >= 0),
  labor_rate numeric check (labor_rate >= 0),
  -- Per-crop payload overrides: { "<crop_id>": bushels }.
  payload_overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists freight_settings_org_idx on public.freight_settings (org_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'freight_settings_org_unique') then
    alter table public.freight_settings add constraint freight_settings_org_unique unique (org_id);
  end if;
end $$;

drop trigger if exists freight_settings_set_updated_at on public.freight_settings;
create trigger freight_settings_set_updated_at
  before update on public.freight_settings
  for each row execute function public.set_updated_at();

-- 3. freight_distances --------------------------------------------------------

create table if not exists public.freight_distances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  bin_site_id uuid not null references public.bin_sites(id) on delete cascade,
  delivery_location_id uuid not null references public.delivery_locations(id) on delete cascade,
  miles numeric not null check (miles > 0),
  source text not null default 'estimate' check (source in ('estimate', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists freight_distances_org_idx on public.freight_distances (org_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'freight_distances_pair_unique') then
    alter table public.freight_distances add constraint freight_distances_pair_unique
      unique (org_id, bin_site_id, delivery_location_id);
  end if;
end $$;

drop trigger if exists freight_distances_set_updated_at on public.freight_distances;
create trigger freight_distances_set_updated_at
  before update on public.freight_distances
  for each row execute function public.set_updated_at();

-- 4. Policy stack (074 loop pattern) -------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['freight_settings', 'freight_distances'] loop
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
