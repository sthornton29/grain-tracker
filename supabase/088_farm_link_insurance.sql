-- 088: Crop insurance over the Turnrow Farm link (Phase 7, Part A follow-on).
-- Idempotent: safe to re-run in the Supabase SQL editor, and safe to run
-- whether or not 087 has already been applied (every step is a no-op when the
-- artifact is already there).
--
-- Turnrow Farm needs the crop insurance premiums this app already allocates by
-- entity and crop, so the farmer never types them twice. GET
-- /api/farm-link/v1/insurance serves them under a new scope insurance:read.
-- Four pieces of schema make that pull correct:
--
--   1. insurance:read joins FARM_LINK_SCOPES — the farm_links scopes default
--      and the farm_links_scopes_known check both widen. A pairing made
--      before this migration keeps its old scope list (so the route answers
--      403 naming insurance:read until the owner turns the switch on or the
--      pairing is redone) — the constraint only stops UNKNOWN scopes.
--   2. updated_at (+ the set_updated_at trigger) on the five crop insurance
--      tables. The insurance pull's ?since= is the production route's
--      contract, so every contributing row has to carry its own last-change
--      stamp; the tables were created with created_at only (024, 045).
--   3. crop_insurance_deletions — the tombstone log. The pull returns one row
--      per entity x crop x practice, so a DELETED policy is not itself a
--      deleted row: it is only deleted once nothing else covers that key. The
--      log records the key of every policy (and endorsement) removed, so the
--      route can answer "this row is gone" on a ?since= pull instead of the
--      Farm side keeping a stale premium forever. Endorsement deletions land
--      here too: they change a row's premium without touching the parent
--      policy's updated_at, so the route folds the log into the row's
--      updated_at as well.
--   4. crop_assumptions.cost_includes_insurance — the includes_insurance flag
--      on the cost-per-acre push. When Turnrow Farm's cost per acre already
--      carries the premium, Grain must not subtract its own premium again in
--      any margin or breakeven built on crop_assumptions.
--
-- Policy stack (082 template): crop_insurance_deletions is a new tenant table
-- and gets the full stack. It is crop insurance money, so viewers and
-- agronomists are blocked from reads as well as writes (the 069 variant 087
-- used for landowner_settlements) -- the log is read only by the service role
-- inside the API.

-- 1. insurance:read ------------------------------------------------------------
-- FARM_LINK_SCOPES

do $$
begin
  if to_regclass('public.farm_links') is null then
    raise notice '088: farm_links is missing - apply 087 first, then re-run 088.';
    return;
  end if;
  alter table public.farm_links alter column scopes set default array[
    'land:write', 'production:read', 'marketing:read', 'income:read',
    'bins:read', 'insurance:read', 'assumptions:write', 'settlements:write'
  ];
  alter table public.farm_links drop constraint if exists farm_links_scopes_known;
  alter table public.farm_links add constraint farm_links_scopes_known check (
    scopes <@ array['land:write', 'production:read', 'marketing:read', 'income:read',
                    'bins:read', 'insurance:read', 'assumptions:write', 'settlements:write']
  );
end $$;

-- 2. updated_at on the crop insurance tables -----------------------------------
-- CROP_INSURANCE_TABLES

do $$
declare t text;
begin
  foreach t in array array['crop_insurance_policies', 'crop_insurance_sco', 'crop_insurance_eco',
                           'crop_insurance_stax', 'crop_insurance_mco'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    -- The backfill runs ONLY on the add, never on a re-run: a row genuinely
    -- edited after this migration has updated_at > created_at honestly, and
    -- re-running must not reset it. On the add, the record's creation is the
    -- best last-change stamp there is, so a first ?since= pull sees each row
    -- at its real age rather than all of them at the migration timestamp.
    if not exists (select 1 from information_schema.columns c
                   where c.table_schema = 'public' and c.table_name = t and c.column_name = 'updated_at') then
      execute format('alter table public.%I add column updated_at timestamptz not null default now()', t);
      execute format('update public.%I set updated_at = created_at', t);
    end if;
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_set_updated_at', t);
    execute format('create index if not exists %I on public.%I (org_id, updated_at)', t || '_org_updated_idx', t);
  end loop;
end $$;

-- 3. crop_insurance_deletions --------------------------------------------------

create table if not exists public.crop_insurance_deletions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  -- The aggregation key the insurance pull serves. entity_id is nullable
  -- exactly as it is on the policy (a policy with no entity rolls up to the
  -- operation row).
  crop_year integer not null,
  entity_id uuid,
  crop_id uuid,
  practice text,
  -- The row that went away. Kept for tracing only: the policy is gone, so
  -- this is deliberately NOT a foreign key.
  policy_id uuid,
  source text not null default 'policy'
    check (source in ('policy', 'sco', 'eco', 'stax', 'mco')),
  deleted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crop_insurance_deletions_org_idx on public.crop_insurance_deletions (org_id);
create index if not exists crop_insurance_deletions_org_year_idx on public.crop_insurance_deletions (org_id, crop_year, deleted_at desc);

drop trigger if exists crop_insurance_deletions_set_updated_at on public.crop_insurance_deletions;
create trigger crop_insurance_deletions_set_updated_at
  before update on public.crop_insurance_deletions
  for each row execute function public.set_updated_at();

-- The trigger writer. A policy logs its own key; an endorsement looks its key
-- up from the parent policy, and logs nothing when the parent is already gone
-- (an ON DELETE CASCADE from the policy -- the policy's own row covers it).
create or replace function public.log_crop_insurance_deletion()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p public.crop_insurance_policies%rowtype;
  kind text := tg_argv[0];
begin
  if kind = 'policy' then
    insert into public.crop_insurance_deletions (org_id, crop_year, entity_id, crop_id, practice, policy_id, source)
    values (old.org_id, old.crop_year, old.entity_id, old.crop_id, old.practice, old.id, 'policy');
    return old;
  end if;
  select * into p from public.crop_insurance_policies where id = old.policy_id;
  if not found then return old; end if;
  insert into public.crop_insurance_deletions (org_id, crop_year, entity_id, crop_id, practice, policy_id, source)
  values (p.org_id, p.crop_year, p.entity_id, p.crop_id, p.practice, p.id, kind);
  return old;
end $$;

do $$
declare t text; kind text;
begin
  foreach t in array array['crop_insurance_policies', 'crop_insurance_sco', 'crop_insurance_eco',
                           'crop_insurance_stax', 'crop_insurance_mco'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    kind := case t when 'crop_insurance_policies' then 'policy' else replace(t, 'crop_insurance_', '') end;
    execute format('drop trigger if exists %I on public.%I', t || '_log_deletion', t);
    execute format('create trigger %I after delete on public.%I for each row execute function public.log_crop_insurance_deletion(%L)', t || '_log_deletion', t, kind);
  end loop;
end $$;

-- 4. includes_insurance on the cost-per-acre push ------------------------------

alter table public.crop_assumptions
  add column if not exists cost_includes_insurance boolean not null default false;

comment on column public.crop_assumptions.cost_includes_insurance is
  'Turnrow Farm''s cost per acre already carries the crop insurance premium (the includes_insurance flag on POST /api/farm-link/v1/assumptions). Grain then reports the indemnity alone in margins built on this row, never indemnity - premium, so the premium is not counted twice.';

-- 5. Policy stack ---------------------------------------------------------------
-- FARM_LINK_TENANT_TABLES

do $$
declare t text;
begin
  foreach t in array array['crop_insurance_deletions'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed all') then
      execute format('create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
    -- 054 org isolation.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042: grain-operation table, gin users blocked.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    -- 052 viewer: no writes AND no reads (crop insurance money).
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''viewer'') with check (public.app_role() <> ''viewer'')', t || '_viewer_block_all', t);
    end if;
    -- 061 agronomist: no writes AND no reads.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''agronomist'') with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_all', t);
    end if;
  end loop;
end $$;
