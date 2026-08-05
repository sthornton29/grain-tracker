-- 053: Multi-tenant conversion, PHASE 1 — SCHEMA ONLY.
--
-- REQUIRES 052. Idempotent: safe to re-run. NO application queries change in
-- this phase — the app must behave exactly as today for the Turnrow org:
--   * every tenant table gains org_id (FK → organizations), backfilled to the
--     "Turnrow Farm" org and NOT NULL, with DEFAULT public.default_org_id()
--     so the app's existing INSERTs (which don't set org_id) keep working.
--     The default is the Phase-1 single-tenant shim; the cutover phase
--     replaces it with the session's org.
--   * unique constraints on NATURAL keys (names, ticket/PBI/receipt numbers)
--     are re-scoped to (org_id, …). Unique keys the app upserts against
--     (ON CONFLICT infers the exact column list — rewriting them would break
--     inserts) are left as-is; every one of them is keyed by an org-scoped FK
--     (crop_id / farm_id / policy_id / bale_id), so they are already per-org
--     in effect. The two exceptions that are NOT FK-scoped are
--     cotton_fee_schedule(crop_year) and the global-classified
--     arc_plc_price_data(commodity_id, crop_year) — deferred to the cutover
--     phase, flagged in verify_053.sql.
--   * GLOBAL (no org_id — shared reference/market/cache data): counties,
--     covered_commodities, commodity_specs, market_prices, program_year_config,
--     arc_benchmark_data, mya_monthly_prices, fsa_benchmark_cache,
--     fsa_benchmark_fetches, awp_weekly, arc_plc_price_data.
--     harvest_price_estimates is PER-ORG despite holding national RMA prices:
--     its rows are keyed by the (now per-org) crops table, so keeping it
--     global would require re-keying by commodity — an app change Phase 1
--     forbids. Cheap duplication per org instead.
--   * user_profiles gains org context; role remains authoritative there for
--     now and is MIRRORED into organization_members.role by trigger, so the
--     membership row is already correct when the cutover flips app_role() to
--     read it. gin/viewer semantics are unchanged within the org.
--
-- NOTE for future migrations: new tenant tables must add org_id (+ the
-- viewer/gin RLS blocks per 042/052) themselves — the loop below only covers
-- tables that exist today.

-- 1. Organizations -----------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Mirrors user_profiles.role for now (sync trigger below); becomes the
  -- authoritative per-org role at cutover.
  role text not null default 'owner' check (role in ('owner', 'gin', 'viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
-- A user belongs to ONE org for now — the cutover phase drops this when (if)
-- cross-org logins arrive.
create unique index if not exists organization_members_one_org_per_user
  on public.organization_members(user_id);

insert into public.organizations (name, slug)
values ('Turnrow Farm', 'turnrow-farm')
on conflict (slug) do nothing;

-- Phase-1 shim: the single org every backfill and column DEFAULT points at.
-- The cutover phase replaces this with the session's org membership.
create or replace function public.default_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.organizations where slug = 'turnrow-farm'
$$;

-- The caller's org(s) — Phase-2 policies will scope on this.
create or replace function public.user_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.organization_members where user_id = auth.uid()
$$;

-- Attach every existing login (all roles) to Turnrow Farm.
insert into public.organization_members (org_id, user_id, role)
select public.default_org_id(), u.id, coalesce(p.role, 'owner')
from auth.users u
left join public.user_profiles p on p.user_id = u.id
where not exists (select 1 from public.organization_members m where m.user_id = u.id);

-- RLS: members read their own org and membership; owners manage. Writes go
-- through future org-management RPCs — no permissive write for gin/viewer.
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'organizations' and policyname = 'organizations_member_read') then
    create policy organizations_member_read on public.organizations for select to authenticated
      using (id in (select public.user_org_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'organizations' and policyname = 'organizations_owner_write') then
    create policy organizations_owner_write on public.organizations for all to authenticated
      using (auth.uid() is not null and public.app_role() = 'owner')
      with check (auth.uid() is not null and public.app_role() = 'owner');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'organization_members' and policyname = 'organization_members_read') then
    create policy organization_members_read on public.organization_members for select to authenticated
      using (user_id = auth.uid() or (auth.uid() is not null and public.app_role() = 'owner'));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'organization_members' and policyname = 'organization_members_owner_write') then
    create policy organization_members_owner_write on public.organization_members for all to authenticated
      using (auth.uid() is not null and public.app_role() = 'owner')
      with check (auth.uid() is not null and public.app_role() = 'owner');
  end if;
end $$;

-- 2. user_profiles org context ------------------------------------------------

alter table public.user_profiles
  add column if not exists org_id uuid references public.organizations(id);
update public.user_profiles set org_id = public.default_org_id() where org_id is null;
alter table public.user_profiles alter column org_id set default public.default_org_id();
alter table public.user_profiles alter column org_id set not null;

-- Keep the membership row's role in lockstep with user_profiles (the current
-- authority) — assign_user_role keeps working untouched, and the cutover can
-- flip app_role() to read organization_members with no drift. Also attaches
-- any future login's membership automatically.
create or replace function public.sync_profile_membership() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.organization_members (org_id, user_id, role)
  values (coalesce(new.org_id, public.default_org_id()), new.user_id, new.role)
  on conflict (org_id, user_id) do update set role = excluded.role;
  return new;
end $$;

drop trigger if exists user_profiles_sync_membership on public.user_profiles;
create trigger user_profiles_sync_membership
  after insert or update of role on public.user_profiles
  for each row execute function public.sync_profile_membership();

-- 3. org_id on every tenant table ----------------------------------------------

-- Everything reachable from the operation's own data. GLOBAL tables
-- (reference/market/cache — see header) are deliberately absent.
do $$
declare t text;
begin
  foreach t in array array[
    -- core operation
    'entities', 'farms', 'fields', 'field_plantings', 'field_planting_varieties', 'crops',
    'bins', 'bin_sites', 'bin_inventory_adjustments', 'trucks', 'buyers', 'delivery_locations',
    'landowners', 'entity_counties',
    -- grain flow
    'loads', 'load_splits', 'load_attachments', 'contracts', 'contract_attachments',
    'settlements', 'settlement_lines',
    -- hedging
    'futures_positions', 'options_positions',
    -- assumptions / marketing
    'crop_assumptions', 'county_yield_assumptions', 'crop_year_sales_status',
    'harvest_price_estimates', -- per-org despite national prices: keyed by per-org crops (see header)
    'variety_match_dismissals',
    -- crop insurance
    'crop_insurance_policies', 'crop_insurance_sco', 'crop_insurance_eco',
    'crop_insurance_stax', 'crop_insurance_mco',
    -- government payments
    'farm_base_acres', 'arc_plc_elections', 'arc_plc_payments',
    'other_government_payments', 'payment_limit_config',
    -- budget
    'budget_scenarios', 'budget_lines',
    -- cotton
    'gins', 'cotton_loads', 'gin_receipts', 'gin_receipt_loads', 'cotton_bales',
    'cotton_bale_grades', 'cotton_sales_contracts', 'cotton_pool_payments',
    'ccc_loans', 'ccc_loan_bales', 'cotton_ldp_records', 'cotton_ldp_bales',
    'cotton_bale_dispositions', 'cotton_fees', 'cotton_fee_schedule',
    -- roles / settings
    'user_entity_access', 'viewer_assumption_overrides', 'app_settings'
  ] loop
    execute format('alter table public.%I add column if not exists org_id uuid references public.organizations(id)', t);
    execute format('update public.%I set org_id = public.default_org_id() where org_id is null', t);
    execute format('alter table public.%I alter column org_id set default public.default_org_id()', t);
    execute format('alter table public.%I alter column org_id set not null', t);
    execute format('create index if not exists %I on public.%I (org_id)', t || '_org_idx', t);
  end loop;
end $$;

-- Hot-path composites (org_id + the table's main lookup key). The plain
-- (org_id) index above covers the rest.
create index if not exists farms_org_entity_idx            on public.farms (org_id, entity_id);
create index if not exists fields_org_farm_idx             on public.fields (org_id, farm_id);
create index if not exists field_plantings_org_year_idx    on public.field_plantings (org_id, season_year);
create index if not exists loads_org_year_idx              on public.loads (org_id, crop_year);
create index if not exists contracts_org_year_idx          on public.contracts (org_id, crop_year);
create index if not exists futures_positions_org_year_idx  on public.futures_positions (org_id, crop_year);
create index if not exists options_positions_org_year_idx  on public.options_positions (org_id, crop_year);
create index if not exists settlements_org_date_idx        on public.settlements (org_id, settlement_date);
create index if not exists gin_receipts_org_year_idx       on public.gin_receipts (org_id, crop_year);
create index if not exists cotton_bales_org_year_idx       on public.cotton_bales (org_id, crop_year);
create index if not exists crop_insurance_policies_org_year_idx on public.crop_insurance_policies (org_id, crop_year);

-- app_settings becomes one row PER ORG: drop the single-row pin, key by org.
-- Turnrow keeps id = 1 (the app still reads .eq('id', 1) until cutover).
alter table public.app_settings drop constraint if exists app_settings_id_check;
create unique index if not exists app_settings_org_unique on public.app_settings (org_id);

-- 4. Per-org unique constraints -------------------------------------------------

-- Natural-key uniques re-scoped to the org. ONLY constraints the app never
-- upserts against (see header). Behavior for a single org is identical —
-- the per-org key is strictly weaker.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'crops_name_unique') then
    alter table public.crops drop constraint crops_name_unique;
  end if;
  if exists (select 1 from pg_constraint where conname = 'entities_name_unique') then
    alter table public.entities drop constraint entities_name_unique;
  end if;
  if exists (select 1 from pg_constraint where conname = 'gins_name_key') then
    alter table public.gins drop constraint gins_name_key;
  end if;
  if exists (select 1 from pg_constraint where conname = 'cotton_loads_crop_year_load_number_key') then
    alter table public.cotton_loads drop constraint cotton_loads_crop_year_load_number_key;
  end if;
  if exists (select 1 from pg_constraint where conname = 'gin_receipts_crop_year_receipt_number_key') then
    alter table public.gin_receipts drop constraint gin_receipts_crop_year_receipt_number_key;
  end if;
  if exists (select 1 from pg_constraint where conname = 'cotton_bales_crop_year_pbi_number_key') then
    alter table public.cotton_bales drop constraint cotton_bales_crop_year_pbi_number_key;
  end if;
end $$;

create unique index if not exists crops_org_name_unique        on public.crops (org_id, name);
create unique index if not exists entities_org_name_unique     on public.entities (org_id, name);
create unique index if not exists gins_org_name_unique         on public.gins (org_id, name);
create unique index if not exists cotton_loads_org_number_unique on public.cotton_loads (org_id, crop_year, load_number);
create unique index if not exists gin_receipts_org_number_unique on public.gin_receipts (org_id, crop_year, receipt_number);
create unique index if not exists cotton_bales_org_pbi_unique  on public.cotton_bales (org_id, crop_year, pbi_number);

-- 5. New-org seeding -------------------------------------------------------------

-- The future org-creation flow calls this once per new org: the standard four
-- crops (FSA1078 bases) and the org's own app_settings row. Owner-only.
create or replace function public.seed_org_defaults(target_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.app_role() <> 'owner' then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.organizations where id = target_org) then raise exception 'no such organization'; end if;
  insert into public.crops (name, base_moisture_pct, base_lb_per_bushel, org_id) values
    ('Corn',          15.5, 56.0, target_org),
    ('Soybean',       13.0, 60.0, target_org),
    ('Wheat',         13.5, 60.0, target_org),
    ('Grain Sorghum', 14.0, 56.0, target_org)
  on conflict do nothing;
  insert into public.app_settings (id, org_id)
  select coalesce(max(id), 0) + 1, target_org from public.app_settings
  on conflict do nothing;
end $$;

revoke execute on function public.seed_org_defaults(uuid) from public, anon;
grant execute on function public.seed_org_defaults(uuid) to authenticated;

-- 6. Role blocks on the new tables (the 042/052 maintenance rule) ---------------

do $$
declare t text;
begin
  foreach t in array array['organizations', 'organization_members'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''viewer'')', t || '_viewer_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_del', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_gin_block') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_gin_block', t);
    end if;
  end loop;
end $$;
