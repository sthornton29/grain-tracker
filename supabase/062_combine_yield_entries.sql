-- 062: Combine-monitor harvest entry — "Yield from Combine" for farmers
-- without scales. Idempotent: safe to re-run.
--
-- A combine_yield_entries row states a field × crop × crop-year's production
-- as read off the combine monitor (dry basis), entered either as total
-- bushels or as yield/acre (the app computes and stores the total either
-- way). An optional adjustment (± bu/ac calibration offset for yield maps
-- that run consistently high or low) produces adjusted_total_bushels — THE
-- number the app uses. One entry per field × crop × year (upsert semantics:
-- re-entering revises). The netting engine (lib/yields.ts) treats the entry
-- as authoritative for the field's production and dynamically nets weighed
-- loads out of it; the netted remainder optionally posts to destination_bin_id
-- as a non-load inventory component (beginning-inventory/transfers pattern —
-- never a load, never double-counted).
--
-- crops.combine_adjustment_bu_per_acre is the per-org × crop calibration
-- default: the last-used adjustment, pre-filling subsequent combine entries
-- for that crop until changed; clearing the adjustment clears the default.
--
-- Multi-tenant conventions (053/054): org_id NOT NULL with the
-- current_org_id()/default_org_id() default, RESTRICTIVE org isolation
-- policy, gin write-block (042 pattern), viewer write-blocks (052 pattern)
-- plus a viewer row-scope (field-keyed), and agronomist write-blocks (061
-- pattern; the table is Yields-page readable, so it is ALSO added to 061's
-- AGRONOMIST_READABLE_TABLES array). 'combine_yield_entries' is also added
-- to the tenant arrays in 053/054 and the verify scripts.

create extension if not exists "pgcrypto";

-- 1. Per-crop calibration default ---------------------------------------------

alter table public.crops add column if not exists combine_adjustment_bu_per_acre numeric;

-- 2. The entries table --------------------------------------------------------

create table if not exists public.combine_yield_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  field_id uuid not null references public.fields(id) on delete cascade,
  crop_id uuid not null references public.crops(id) on delete restrict,
  crop_year integer not null,
  -- How the user entered it; both modes store the computed total.
  entry_mode text not null check (entry_mode in ('total_bushels', 'yield_per_acre')),
  stated_yield_per_acre numeric check (stated_yield_per_acre is null or stated_yield_per_acre >= 0),
  -- Dry-basis total as stated (yield mode: yield × the planting's acres).
  stated_total_bushels numeric not null check (stated_total_bushels >= 0),
  -- Calibration offset applied (null = none); adjusted = stated ± offset × acres.
  adjustment_bu_per_acre numeric,
  -- THE number the app uses for the field's production.
  adjusted_total_bushels numeric not null check (adjusted_total_bushels >= 0),
  -- Optional irr/dry sub-entry for mixed-practice fields (write-through to the
  -- planting's manual breakout on save; null = single combined figure, which
  -- flows to the post-harvest allocation exactly like load-based fields).
  stated_irrigated_bushels numeric check (stated_irrigated_bushels is null or stated_irrigated_bushels >= 0),
  stated_dryland_bushels numeric check (stated_dryland_bushels is null or stated_dryland_bushels >= 0),
  -- Where the netted-to-storage remainder sits; null = production without a
  -- storage location (fine).
  destination_bin_id uuid references public.bins(id) on delete set null,
  -- "This field is finished" — feeds the harvest-status logic exactly like a
  -- completed load-based field.
  harvest_complete boolean not null default true,
  entry_date date not null default current_date,
  notes text,
  source text not null default 'manual' check (source in ('manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- FK-keyed (org-safe per the 053 rule): one entry per field × crop × year.
  constraint combine_yield_entries_one_per_planting unique (field_id, crop_id, crop_year)
);

create index if not exists combine_yield_entries_field_idx on public.combine_yield_entries (field_id);
create index if not exists combine_yield_entries_crop_year_idx on public.combine_yield_entries (crop_id, crop_year);
create index if not exists combine_yield_entries_bin_idx on public.combine_yield_entries (destination_bin_id);
create index if not exists combine_yield_entries_org_idx on public.combine_yield_entries (org_id);

drop trigger if exists combine_yield_entries_set_updated_at on public.combine_yield_entries;
create trigger combine_yield_entries_set_updated_at
  before update on public.combine_yield_entries
  for each row execute function public.set_updated_at();

alter table public.combine_yield_entries enable row level security;

-- 3. Policies -----------------------------------------------------------------

do $$
begin
  -- Permissive base (single-org-era default, restricted by the blocks below).
  if not exists (select 1 from pg_policies where tablename = 'combine_yield_entries' and policyname = 'authed all') then
    create policy "authed all" on public.combine_yield_entries for all to authenticated
      using (true) with check (true);
  end if;

  -- 054 org isolation.
  if not exists (select 1 from pg_policies where tablename = 'combine_yield_entries' and policyname = 'combine_yield_entries_org_isolation') then
    create policy combine_yield_entries_org_isolation on public.combine_yield_entries as restrictive for all to authenticated
      using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());
  end if;

  -- 042 gin block: gin operators never touch grain-side production.
  if not exists (select 1 from pg_policies where tablename = 'combine_yield_entries' and policyname = 'combine_yield_entries_owner_only') then
    create policy combine_yield_entries_owner_only on public.combine_yield_entries as restrictive for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;

  -- 052 viewer write-blocks + field-keyed row scope (the Yields page shows
  -- combine entries, so viewers see only their granted entities' fields).
  if not exists (select 1 from pg_policies where tablename = 'combine_yield_entries' and policyname = 'combine_yield_entries_viewer_block_ins') then
    create policy combine_yield_entries_viewer_block_ins on public.combine_yield_entries as restrictive for insert to authenticated
      with check (public.app_role() <> 'viewer');
    create policy combine_yield_entries_viewer_block_upd on public.combine_yield_entries as restrictive for update to authenticated
      using (public.app_role() <> 'viewer');
    create policy combine_yield_entries_viewer_block_del on public.combine_yield_entries as restrictive for delete to authenticated
      using (public.app_role() <> 'viewer');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'combine_yield_entries' and policyname = 'combine_yield_entries_viewer_scope') then
    create policy combine_yield_entries_viewer_scope on public.combine_yield_entries as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or field_id in (select public.viewer_field_ids()));
  end if;

  -- 061 agronomist write-blocks (read stays open — the table is in 061's
  -- readable allowlist; no select-block here).
  if not exists (select 1 from pg_policies where tablename = 'combine_yield_entries' and policyname = 'combine_yield_entries_agronomist_block_ins') then
    create policy combine_yield_entries_agronomist_block_ins on public.combine_yield_entries as restrictive for insert to authenticated
      with check (public.app_role() <> 'agronomist');
    create policy combine_yield_entries_agronomist_block_upd on public.combine_yield_entries as restrictive for update to authenticated
      using (public.app_role() <> 'agronomist');
    create policy combine_yield_entries_agronomist_block_del on public.combine_yield_entries as restrictive for delete to authenticated
      using (public.app_role() <> 'agronomist');
  end if;
end $$;
