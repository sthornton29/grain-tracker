-- 067: Hauler (external) trucks for pickup contracts + loads.hauler_truck.
-- Idempotent: safe to re-run.
--
-- On a PICKUP contract (contracts.delivery_type = 'pickup', 003) the buyer's
-- trucks load at the farm, so the truck on such a load is usually NOT one of
-- the operation's own trucks. The load form writes the hauler's truck as
-- free text into loads.hauler_truck, and can save it to external_trucks —
-- an org-scoped list of OTHER PEOPLE'S trucks kept strictly separate from
-- public.trucks (ours). The classification rule, enforced in the UI and
-- stated in help: a truck saved from a pickup-contract load is external;
-- a truck saved anywhere else is ours.
--
-- loads.hauler_truck is plain text (the cotton_loads.truck precedent, 042):
-- the load keeps the name as entered, so renaming or deleting a saved
-- external truck never rewrites history. external_trucks is only the picker
-- list for subsequent pickup loads ("Hauler trucks" group).
--
-- No DB unique on (org_id, name): the inline save dedupes case-insensitively
-- in app code, same as public.trucks. If a natural-key unique is ever added
-- it must be org-scoped per the 053 rule.
--
-- Multi-tenant conventions (053/054): org_id NOT NULL with the
-- current_org_id()/default_org_id() default, RESTRICTIVE org isolation
-- policy, gin write-block (042 pattern), viewer write-blocks (052 pattern;
-- no row scope — like trucks it's a name list), agronomist write-blocks AND
-- select-block (061 — the Yields drill-down reads loads.hauler_truck, never
-- this table). 'external_trucks' is also added to the tenant arrays in
-- 053/054 and the verify scripts.

create extension if not exists "pgcrypto";

-- 1. The external-trucks list -------------------------------------------------

create table if not exists public.external_trucks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  -- The truck as written on the load ("JD Trucking 12", "Red Peterbilt").
  name text not null,
  -- Optional association: whose trucks these are (the pickup contract's buyer
  -- at save time). Null = unknown/independent hauler.
  buyer_id uuid references public.buyers(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists external_trucks_org_idx on public.external_trucks (org_id);
create index if not exists external_trucks_buyer_idx on public.external_trucks (buyer_id);

alter table public.external_trucks enable row level security;

-- 2. loads.hauler_truck -------------------------------------------------------

alter table public.loads add column if not exists hauler_truck text;

-- 3. Policies -----------------------------------------------------------------

do $$
begin
  -- Permissive base (single-org-era default, restricted by the blocks below).
  if not exists (select 1 from pg_policies where tablename = 'external_trucks' and policyname = 'authed all') then
    create policy "authed all" on public.external_trucks for all to authenticated
      using (true) with check (true);
  end if;

  -- 054 org isolation.
  if not exists (select 1 from pg_policies where tablename = 'external_trucks' and policyname = 'external_trucks_org_isolation') then
    create policy external_trucks_org_isolation on public.external_trucks as restrictive for all to authenticated
      using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());
  end if;

  -- 042 gin block: gin operators never touch grain-side reference data.
  if not exists (select 1 from pg_policies where tablename = 'external_trucks' and policyname = 'external_trucks_owner_only') then
    create policy external_trucks_owner_only on public.external_trucks as restrictive for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;

  -- 052 viewer write-blocks (reads stay open — it's a name list, like trucks).
  if not exists (select 1 from pg_policies where tablename = 'external_trucks' and policyname = 'external_trucks_viewer_block_ins') then
    create policy external_trucks_viewer_block_ins on public.external_trucks as restrictive for insert to authenticated
      with check (public.app_role() <> 'viewer');
    create policy external_trucks_viewer_block_upd on public.external_trucks as restrictive for update to authenticated
      using (public.app_role() <> 'viewer');
    create policy external_trucks_viewer_block_del on public.external_trucks as restrictive for delete to authenticated
      using (public.app_role() <> 'viewer');
  end if;

  -- 061 agronomist: write-blocked AND select-blocked (not in the Yields
  -- read set — the drill-down shows loads.hauler_truck text directly).
  if not exists (select 1 from pg_policies where tablename = 'external_trucks' and policyname = 'external_trucks_agronomist_block_ins') then
    create policy external_trucks_agronomist_block_ins on public.external_trucks as restrictive for insert to authenticated
      with check (public.app_role() <> 'agronomist');
    create policy external_trucks_agronomist_block_upd on public.external_trucks as restrictive for update to authenticated
      using (public.app_role() <> 'agronomist');
    create policy external_trucks_agronomist_block_del on public.external_trucks as restrictive for delete to authenticated
      using (public.app_role() <> 'agronomist');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'external_trucks' and policyname = 'external_trucks_agronomist_block_sel') then
    create policy external_trucks_agronomist_block_sel on public.external_trucks as restrictive for select to authenticated
      using (public.app_role() <> 'agronomist');
  end if;
end $$;
