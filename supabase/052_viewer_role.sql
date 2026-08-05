-- 052: Viewer role — read-only stakeholder logins scoped to granted entities.
--
-- REQUIRES 051 (entities.entity_role) — apply 051 first if it is still pending.
-- Idempotent: safe to re-run.
--
-- A viewer is a stakeholder (landowner, lender, family member) who may open
-- ONLY the Yields page and the Reports, and only for the entities granted in
-- user_entity_access. Three layers, like the gin role:
--   * nav (navLinksFor) shows only Yields + Reports;
--   * middleware (lib/route-guard.ts) redirects every other path;
--   * RLS here is the real enforcement: viewers are write-blocked everywhere
--     except their own rows in viewer_assumption_overrides, and the strictly
--     entity-keyed tables are row-filtered to their grants. Marketing rows
--     (contracts / futures / options / cotton marketing) stay readable when
--     null-entity or held by the marketing agent — the app-layer attribution
--     (lib/entity-scope.ts) needs those rows to compute the granted entities'
--     pro-rata shares; rows keyed to a NON-granted farming entity are hidden.
--   * field_plantings and entities stay fully readable: attribution needs the
--     whole operation's planted acres as the denominator, and the agent
--     entity must be recognizable (entity_role) for flow-down to work.
--
-- Private assumption overrides: a viewer may re-assume report inputs (yields,
-- costs, assumed futures/basis, county differentials) privately. Each override
-- snapshots the base row's updated_at; the moment an owner changes the base,
-- the snapshot no longer matches and the override is stale → ignored (and
-- lazily deleted on the viewer's next read). Admin changes win by construction;
-- no sync job. harvest_complete is an operational fact and is NOT overridable
-- (enforced by the field check constraint).
--
-- NOTE for future migrations: new tables must add their own
-- viewer write-block (and, if entity-keyed, a viewer scope policy) —
-- the loops below only cover tables that exist today.

-- 1. Role --------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'user_profiles_role_check'
      and pg_get_constraintdef(oid) not like '%viewer%'
  ) then
    alter table public.user_profiles drop constraint user_profiles_role_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_role_check') then
    alter table public.user_profiles
      add constraint user_profiles_role_check check (role in ('owner', 'gin', 'viewer'));
  end if;
end $$;

-- 2. Entity grants -----------------------------------------------------------

create table if not exists public.user_entity_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, entity_id)
);
create index if not exists user_entity_access_user_idx on public.user_entity_access(user_id);

alter table public.user_entity_access enable row level security;

do $$
begin
  -- A user reads their own grants (the viewer's entity universe); owners all.
  if not exists (select 1 from pg_policies where tablename = 'user_entity_access' and policyname = 'user_entity_access_read') then
    create policy user_entity_access_read on public.user_entity_access for select to authenticated
      using (user_id = auth.uid() or public.app_role() = 'owner');
  end if;
  -- Only owners manage grants (normally via the assign_user_role RPC).
  if not exists (select 1 from pg_policies where tablename = 'user_entity_access' and policyname = 'user_entity_access_write') then
    create policy user_entity_access_write on public.user_entity_access for all to authenticated
      using (public.app_role() = 'owner') with check (public.app_role() = 'owner');
  end if;
end $$;

-- 3. Security-definer helpers (policies call these without RLS recursion) ----

create or replace function public.viewer_entity_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select entity_id from public.user_entity_access where user_id = auth.uid()
$$;

create or replace function public.viewer_farm_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.farms
  where entity_id in (select entity_id from public.user_entity_access where user_id = auth.uid())
$$;

create or replace function public.viewer_field_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select f.id from public.fields f
  join public.farms fa on fa.id = f.farm_id
  where fa.entity_id in (select entity_id from public.user_entity_access where user_id = auth.uid())
$$;

-- Marketing-agent entities (051): their contracts/hedges flow down pro-rata,
-- so viewers must be able to read (and recognize) them.
create or replace function public.agent_entity_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.entities where entity_role = 'marketing_agent'
$$;

-- 4. Role RPCs ---------------------------------------------------------------

-- Signature changes (entity_ids arg, entity_ids output) — drop the old ones so
-- PostgREST doesn't see ambiguous overloads.
drop function if exists public.assign_user_role(text, text);
drop function if exists public.list_user_roles();

-- Owner-run role assignment. For 'viewer', entity_ids is REQUIRED (at least
-- one) and replaces the user's grants; for owner/gin any grants are cleared.
-- The auth.uid() null-check matters: app_role() defaults to 'owner' when
-- there is NO session, so without it an ANONYMOUS caller holding the public
-- anon key would pass the role guard.
create or replace function public.assign_user_role(user_email text, new_role text, entity_ids uuid[] default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if auth.uid() is null or public.app_role() <> 'owner' then raise exception 'not allowed'; end if;
  if new_role not in ('owner', 'gin', 'viewer') then raise exception 'invalid role'; end if;
  if new_role = 'viewer' and (entity_ids is null or coalesce(array_length(entity_ids, 1), 0) = 0) then
    raise exception 'a viewer needs at least one entity';
  end if;
  select id into uid from auth.users where lower(email) = lower(user_email);
  if uid is null then raise exception 'no auth user with email %', user_email; end if;
  -- The last owner demoting themselves would lock everyone out of role
  -- management — self-changes are refused outright (the UI hides them too).
  if uid = auth.uid() then raise exception 'you cannot change your own role'; end if;
  if new_role = 'viewer' and exists (
    select 1 from unnest(entity_ids) g(eid) where not exists (select 1 from public.entities e where e.id = g.eid)
  ) then
    raise exception 'unknown entity in grant list';
  end if;
  insert into public.user_profiles (user_id, role) values (uid, new_role)
  on conflict (user_id) do update set role = excluded.role;
  delete from public.user_entity_access where user_id = uid;
  if new_role = 'viewer' then
    insert into public.user_entity_access (user_id, entity_id)
    select uid, eid from (select distinct unnest(entity_ids) as eid) g;
  end if;
end $$;

create or replace function public.list_user_roles()
returns table (user_id uuid, email text, role text, entity_ids uuid[])
language sql stable security definer set search_path = public as $$
  select u.id, u.email::text, coalesce(p.role, 'owner'),
         coalesce((select array_agg(a.entity_id) from public.user_entity_access a where a.user_id = u.id), '{}')
  from auth.users u left join public.user_profiles p on p.user_id = u.id
  where auth.uid() is not null and public.app_role() = 'owner'
  order by u.email
$$;

-- Belt and suspenders: the role RPCs are not callable without a session at
-- all (functions default to EXECUTE for PUBLIC, which includes the anon
-- key every browser holds). The internal guards above still apply.
revoke execute on function public.assign_user_role(text, text, uuid[]) from public, anon;
revoke execute on function public.list_user_roles() from public, anon;
grant execute on function public.assign_user_role(text, text, uuid[]) to authenticated;
grant execute on function public.list_user_roles() to authenticated;

-- 5. updated_at on the assumption tables (staleness anchor) ------------------

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

alter table public.county_yield_assumptions
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists crop_assumptions_set_updated_at on public.crop_assumptions;
create trigger crop_assumptions_set_updated_at
  before update on public.crop_assumptions
  for each row execute function public.set_updated_at();

drop trigger if exists county_yield_assumptions_set_updated_at on public.county_yield_assumptions;
create trigger county_yield_assumptions_set_updated_at
  before update on public.county_yield_assumptions
  for each row execute function public.set_updated_at();

-- 6. Private per-viewer assumption overrides ---------------------------------

create table if not exists public.viewer_assumption_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Typed key: which base table + row + column this override shadows.
  scope text not null check (scope in ('crop', 'county')),
  crop_id uuid not null references public.crops(id) on delete cascade,
  crop_year integer not null,
  county_id uuid references public.counties(id) on delete cascade, -- county scope only; null = the crop's default row
  field text not null,
  -- The override value (JSON so numeric fields can be overridden to null,
  -- e.g. clearing assumed_futures back to "use the live estimate").
  value jsonb not null,
  -- Snapshot of the base row's updated_at when the override was saved; the
  -- epoch sentinel means "no base row existed yet". The override applies only
  -- while the base still matches — any admin edit advances the base's
  -- updated_at and the override silently goes stale (admin wins).
  base_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint viewer_assumption_overrides_field_check check (
    (scope = 'crop' and field in (
      'expected_yield', 'expected_yield_irr', 'expected_yield_dry', 'expected_yield_dc_irr', 'expected_yield_dc_dry',
      'cost_per_acre', 'cost_per_acre_irr', 'cost_per_acre_dry', 'cost_per_acre_dc_irr', 'cost_per_acre_dc_dry',
      'assumed_basis', 'assumed_futures'
    ))
    or
    (scope = 'county' and field in ('yield_differential', 'county_yield_override', 'rma_final_county_yield'))
  ),
  constraint viewer_assumption_overrides_county_scope check (scope = 'county' or county_id is null)
);

create unique index if not exists viewer_assumption_overrides_key
  on public.viewer_assumption_overrides
  (user_id, scope, crop_id, crop_year, coalesce(county_id, '00000000-0000-0000-0000-000000000000'::uuid), field);
create index if not exists viewer_assumption_overrides_user_idx on public.viewer_assumption_overrides(user_id);

drop trigger if exists viewer_assumption_overrides_set_updated_at on public.viewer_assumption_overrides;
create trigger viewer_assumption_overrides_set_updated_at
  before update on public.viewer_assumption_overrides
  for each row execute function public.set_updated_at();

alter table public.viewer_assumption_overrides enable row level security;

do $$
begin
  -- Strictly private: a viewer sees and manages ONLY their own rows. No other
  -- role has any policy here, so owners/gin read nothing (and the partner
  -- API's service role bypasses RLS as usual).
  if not exists (select 1 from pg_policies where tablename = 'viewer_assumption_overrides' and policyname = 'viewer_assumption_overrides_own') then
    create policy viewer_assumption_overrides_own on public.viewer_assumption_overrides for all to authenticated
      using (user_id = auth.uid() and public.app_role() = 'viewer')
      with check (user_id = auth.uid() and public.app_role() = 'viewer');
  end if;
end $$;

-- 7. Viewer write-block everywhere else --------------------------------------

-- RESTRICTIVE per-command policies (AND-ed with the permissive ones), the gin
-- read-only pattern from 042 — on EVERY public table except the override
-- table. Viewers cannot INSERT/UPDATE/DELETE anything else, ever.
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> 'viewer_assumption_overrides'
  loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''viewer'')', t || '_viewer_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_del', t);
    end if;
  end loop;
end $$;

-- 8. Viewer row scope on the entity-keyed tables -----------------------------

-- RESTRICTIVE SELECT policies: owners/gin unaffected (left disjunct), viewers
-- see only rows reachable from their granted entities.
do $$
begin
  -- Directly entity-keyed.
  if not exists (select 1 from pg_policies where tablename = 'farms' and policyname = 'farms_viewer_scope') then
    create policy farms_viewer_scope on public.farms as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or entity_id in (select public.viewer_entity_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'fields' and policyname = 'fields_viewer_scope') then
    create policy fields_viewer_scope on public.fields as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or farm_id in (select public.viewer_farm_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'entity_counties' and policyname = 'entity_counties_viewer_scope') then
    create policy entity_counties_viewer_scope on public.entity_counties as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or entity_id in (select public.viewer_entity_ids()));
  end if;

  -- Field-keyed production data.
  if not exists (select 1 from pg_policies where tablename = 'loads' and policyname = 'loads_viewer_scope') then
    create policy loads_viewer_scope on public.loads as restrictive for select to authenticated
      using (public.app_role() <> 'viewer'
             or from_field_id in (select public.viewer_field_ids())
             or id in (select load_id from public.load_splits where field_id in (select public.viewer_field_ids())));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'load_splits' and policyname = 'load_splits_viewer_scope') then
    create policy load_splits_viewer_scope on public.load_splits as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or field_id in (select public.viewer_field_ids()));
  end if;

  -- Crop insurance: policies are genuinely per entity; riders follow their policy.
  if not exists (select 1 from pg_policies where tablename = 'crop_insurance_policies' and policyname = 'crop_insurance_policies_viewer_scope') then
    create policy crop_insurance_policies_viewer_scope on public.crop_insurance_policies as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or entity_id in (select public.viewer_entity_ids()));
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['crop_insurance_sco', 'crop_insurance_eco', 'crop_insurance_stax', 'crop_insurance_mco'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_scope') then
      -- The inner select runs under the viewer's own RLS on crop_insurance_policies.
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.app_role() <> ''viewer'' or policy_id in (select id from public.crop_insurance_policies))', t || '_viewer_scope', t);
    end if;
  end loop;
end $$;

do $$
begin
  -- Government payments: by farm; other payments fall back to their own entity.
  if not exists (select 1 from pg_policies where tablename = 'farm_base_acres' and policyname = 'farm_base_acres_viewer_scope') then
    create policy farm_base_acres_viewer_scope on public.farm_base_acres as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or farm_id in (select public.viewer_farm_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'arc_plc_elections' and policyname = 'arc_plc_elections_viewer_scope') then
    create policy arc_plc_elections_viewer_scope on public.arc_plc_elections as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or farm_id in (select public.viewer_farm_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'arc_plc_payments' and policyname = 'arc_plc_payments_viewer_scope') then
    create policy arc_plc_payments_viewer_scope on public.arc_plc_payments as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or farm_id in (select public.viewer_farm_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'other_government_payments' and policyname = 'other_government_payments_viewer_scope') then
    create policy other_government_payments_viewer_scope on public.other_government_payments as restrictive for select to authenticated
      using (public.app_role() <> 'viewer'
             or farm_id in (select public.viewer_farm_ids())
             or (farm_id is null and entity_id in (select public.viewer_entity_ids())));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'payment_limit_config' and policyname = 'payment_limit_config_viewer_scope') then
    create policy payment_limit_config_viewer_scope on public.payment_limit_config as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or entity_id in (select public.viewer_entity_ids()));
  end if;
end $$;

-- Marketing positions: readable when operation-level (null entity), held by
-- the marketing agent (flow-down source), or keyed to a granted entity.
-- A NON-granted farming entity's own-name book is hidden. The app layer
-- (lib/entity-scope.ts attribution) scales agent/null rows to the granted
-- entities' pro-rata acre share — a viewer never *renders* the whole book.
do $$
declare t text;
begin
  foreach t in array array['contracts', 'futures_positions', 'options_positions',
                           'cotton_sales_contracts', 'ccc_loans', 'cotton_ldp_records', 'cotton_fees'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_scope') then
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.app_role() <> ''viewer'' or entity_id is null or entity_id in (select public.viewer_entity_ids()) or entity_id in (select public.agent_entity_ids()))', t || '_viewer_scope', t);
    end if;
  end loop;
end $$;

do $$
begin
  -- Cotton marketing children follow their parent row (viewer-RLS-filtered).
  if not exists (select 1 from pg_policies where tablename = 'cotton_pool_payments' and policyname = 'cotton_pool_payments_viewer_scope') then
    create policy cotton_pool_payments_viewer_scope on public.cotton_pool_payments as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or contract_id in (select id from public.cotton_sales_contracts));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'ccc_loan_bales' and policyname = 'ccc_loan_bales_viewer_scope') then
    create policy ccc_loan_bales_viewer_scope on public.ccc_loan_bales as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or loan_id in (select id from public.ccc_loans));
  end if;

  -- Cotton intake: entity/farm/field linkage, like ginReceipts() in the app.
  if not exists (select 1 from pg_policies where tablename = 'gin_receipts' and policyname = 'gin_receipts_viewer_scope') then
    create policy gin_receipts_viewer_scope on public.gin_receipts as restrictive for select to authenticated
      using (public.app_role() <> 'viewer'
             or entity_id in (select public.viewer_entity_ids())
             or farm_id in (select public.viewer_farm_ids())
             or field_id in (select public.viewer_field_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'cotton_loads' and policyname = 'cotton_loads_viewer_scope') then
    create policy cotton_loads_viewer_scope on public.cotton_loads as restrictive for select to authenticated
      using (public.app_role() <> 'viewer'
             or entity_id in (select public.viewer_entity_ids())
             or farm_id in (select public.viewer_farm_ids())
             or field_id in (select public.viewer_field_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'cotton_bales' and policyname = 'cotton_bales_viewer_scope') then
    create policy cotton_bales_viewer_scope on public.cotton_bales as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or gin_receipt_id in (select id from public.gin_receipts));
  end if;
end $$;

do $$
declare t text;
begin
  -- Bale children (grades / dispositions / LDP links) follow their bale.
  foreach t in array array['cotton_bale_grades', 'cotton_bale_dispositions', 'cotton_ldp_bales'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_scope') then
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.app_role() <> ''viewer'' or bale_id in (select id from public.cotton_bales))', t || '_viewer_scope', t);
    end if;
  end loop;
end $$;
