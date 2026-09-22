-- 087: The Turnrow Farm link (Phase 7, Part A - the Grain side).
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- Turnrow Farm (turnrowfm.com) is the same owner's farm-management product and
-- the MASTER for entities, farms, fields, boundaries, and plantings; Grain stays
-- the master for loads, bins, contracts, hedging, settlements, yields, crop
-- insurance, government payments, and marketing prices. This migration adds
-- the pairing + id map + landowner-settlement hand-off that the private API
-- under /api/farm-link/v1/* rides (docs/FARM_LINK_API.md):
--
--   1. farm_links            - one pairing per organization: the one-time
--                              pairing code (sha256 at rest, "fl_" prefix,
--                              7-day expiry), the long-lived bearer token issued
--                              at the handshake (sha256 at rest, "flt_" prefix,
--                              rotatable), Farm's organization id/name, the
--                              granted scopes, status, last sync per direction.
--   2. farm_link_ids         - the id map (grain_table x grain_id <-> farm_uid).
--                              No farm_uid columns on the core tables.
--   3. landowner_settlements - Farm's finalized landowner statements, one per
--                              Farm lease year (farm_uid = lease_years.id),
--                              served to landowner partners under the new
--                              partner share scope "settlements" (default OFF).
--   4. farm_link_calls       - the rolling API call log (trimmed to 30 days by
--                              the API itself, once a day).
--   5. managed_by + archived_at on entities / farms / fields / field_plantings:
--                              managed_by = 'turnrow_farm' marks a row the link
--                              wrote or matched (read-only in Grain's UI);
--                              archived_at is the link's "delete" (Grain
--                              archives, never deletes - and refuses to archive
--                              a field or planting that has loads, yields, or
--                              settlements).
--   6. partner_shares.share_settlements - the landowner share scope.
--   7. cost provenance on crop_assumptions / budget_lines (+ a per-scenario
--                              "follow Turnrow Farm" switch): the Grain UI shows
--                              "from Turnrow Farm, updated <date>" with a manual
--                              override switch.
--   8. farm_link_apply(p_org, p_ops) - the ONE transactional write path the
--                              land sync uses: an ordered list of insert /
--                              update / archive / link / replace_varieties ops
--                              runs in a single transaction (a batch either
--                              fully lands or fully rolls back). Service role
--                              only.
--
-- Policy stack (082 template): every new tenant table is org-isolated and gin-
-- blocked. farm_links / farm_link_ids / farm_link_calls are owner surfaces
-- (viewers and agronomists blocked from reads and writes); landowner_settlements
-- carries landowner finances (069 variant: viewers and agronomists blocked from
-- reads too). The service role bypasses RLS and scopes .eq('org_id', ...) in
-- code (lib/farm-link-server.ts).

-- 1. farm_links -----------------------------------------------------------------

create table if not exists public.farm_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  -- sha256 hex of the one-time pairing code ("fl_..."); plaintext shown once.
  code_hash text not null unique,
  code_expires_at timestamptz not null default now() + interval '7 days',
  -- sha256 hex of the bearer token ("flt_...") issued at the handshake; the
  -- plaintext goes to Turnrow Farm once. Rotating replaces it.
  token_hash text unique,
  token_rotated_at timestamptz,
  -- Learned at the handshake.
  farm_org_id uuid,
  farm_org_name text,
  -- FARM_LINK_SCOPES
  scopes text[] not null default array[
    'land:write', 'production:read', 'marketing:read', 'income:read',
    'bins:read', 'insurance:read', 'landowners:write', 'assumptions:write', 'settlements:write'
  ],
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_by uuid,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  -- { inbound: { at, counts, conflicts }, outbound: { at, endpoint, count } }
  last_sync jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint farm_links_scopes_known check (
    scopes <@ array['land:write', 'production:read', 'marketing:read', 'income:read',
                    'bins:read', 'insurance:read', 'landowners:write', 'assumptions:write', 'settlements:write']
  )
);

create index if not exists farm_links_org_idx on public.farm_links (org_id);
-- One live (pending or active) link per organization.
create unique index if not exists farm_links_one_live_per_org
  on public.farm_links (org_id) where status <> 'revoked';

drop trigger if exists farm_links_set_updated_at on public.farm_links;
create trigger farm_links_set_updated_at
  before update on public.farm_links
  for each row execute function public.set_updated_at();

-- 2. farm_link_ids --------------------------------------------------------------

create table if not exists public.farm_link_ids (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  grain_table text not null check (grain_table in (
    'entities', 'farms', 'fields', 'field_plantings', 'field_planting_varieties', 'crops', 'landowners'
  )),
  grain_id uuid not null,
  -- Turnrow Farm's key: a uuid for entities/farms/fields/plantings, the crop
  -- SLUG for crops (Farm's crops table is slug-keyed) - hence text.
  farm_uid text not null,
  linked_at timestamptz not null default now(),
  linked_by text not null default 'sync' check (linked_by in ('handshake', 'match', 'sync')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists farm_link_ids_org_table_idx on public.farm_link_ids (org_id, grain_table);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'farm_link_ids_grain_unique') then
    alter table public.farm_link_ids add constraint farm_link_ids_grain_unique unique (org_id, grain_table, grain_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'farm_link_ids_farm_unique') then
    alter table public.farm_link_ids add constraint farm_link_ids_farm_unique unique (org_id, grain_table, farm_uid);
  end if;
end $$;

drop trigger if exists farm_link_ids_set_updated_at on public.farm_link_ids;
create trigger farm_link_ids_set_updated_at
  before update on public.farm_link_ids
  for each row execute function public.set_updated_at();

-- 3. landowner_settlements ------------------------------------------------------

create table if not exists public.landowner_settlements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  -- Turnrow Farm's lease year id (lease_years.id) - the settlement's identity.
  farm_uid uuid not null,
  landowner_name text not null,
  -- Turnrow Farm's landowner id, and Grain's landowner when the id map knows it.
  landowner_farm_uid uuid,
  landowner_id uuid references public.landowners(id) on delete set null,
  crop_year integer not null,
  lease_type text,
  -- The statement rows exactly as Farm's lib/leases/statement.ts produces them.
  statement jsonb not null default '{}'::jsonb,
  finalized_at timestamptz,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists landowner_settlements_org_year_idx on public.landowner_settlements (org_id, crop_year);
create index if not exists landowner_settlements_org_landowner_idx on public.landowner_settlements (org_id, landowner_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'landowner_settlements_org_farm_uid_unique') then
    alter table public.landowner_settlements add constraint landowner_settlements_org_farm_uid_unique unique (org_id, farm_uid);
  end if;
end $$;

drop trigger if exists landowner_settlements_set_updated_at on public.landowner_settlements;
create trigger landowner_settlements_set_updated_at
  before update on public.landowner_settlements
  for each row execute function public.set_updated_at();

-- 4. farm_link_calls (rolling log) ---------------------------------------------

create table if not exists public.farm_link_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  link_id uuid references public.farm_links(id) on delete cascade,
  endpoint text not null,
  method text not null,
  status integer not null,
  -- e.g. { records: 120, created: 3, updated: 7, conflicts: 1 }
  counts jsonb not null default '{}'::jsonb,
  duration_ms integer,
  called_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists farm_link_calls_org_called_idx on public.farm_link_calls (org_id, called_at desc);

-- 5. managed_by + archived_at on the land tables -------------------------------
-- FARM_LINK_MANAGED_TABLES

do $$
declare t text;
begin
  foreach t in array array['entities', 'farms', 'fields', 'field_plantings'] loop
    execute format('alter table public.%I add column if not exists managed_by text', t);
    execute format('alter table public.%I add column if not exists archived_at timestamptz', t);
    if not exists (select 1 from pg_constraint where conname = t || '_managed_by_known') then
      execute format('alter table public.%I add constraint %I check (managed_by is null or managed_by = ''turnrow_farm'')', t, t || '_managed_by_known');
    end if;
  end loop;
end $$;

-- 5b. updated_at on crops + landowners (the snapshot and delta sync carry it;
--     050 gave it to farms/fields/entities/field_plantings already).

do $$
declare t text;
begin
  foreach t in array array['crops', 'landowners'] loop
    execute format('alter table public.%I add column if not exists updated_at timestamptz not null default now()', t);
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

-- 6. Landowner share scope ------------------------------------------------------

alter table public.partner_shares
  add column if not exists share_settlements boolean not null default false;

-- 7. Cost provenance ------------------------------------------------------------

alter table public.crop_assumptions
  add column if not exists cost_source text check (cost_source is null or cost_source = 'turnrow_farm'),
  add column if not exists cost_source_updated_at timestamptz,
  -- true = the owner typed over the Farm figure; the next assumptions push
  -- leaves this row's costs alone until the switch is turned back off.
  add column if not exists cost_manual_override boolean not null default false;

alter table public.budget_scenarios
  add column if not exists follow_farm_costs boolean not null default false;

alter table public.budget_lines
  add column if not exists cost_source text check (cost_source is null or cost_source = 'turnrow_farm'),
  add column if not exists cost_source_updated_at timestamptz;

-- 8. Policy stack ---------------------------------------------------------------
-- FARM_LINK_TENANT_TABLES

do $$
declare t text;
begin
  foreach t in array array['farm_links', 'farm_link_ids', 'farm_link_calls', 'landowner_settlements'] loop
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
    -- 052 viewer: no writes AND no reads (pairing secrets / landowner finances).
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''viewer'') with check (public.app_role() <> ''viewer'')', t || '_viewer_block_all', t);
    end if;
    -- 061 agronomist: no writes AND no reads.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''agronomist'') with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_all', t);
    end if;
  end loop;
end $$;

-- 9. farm_link_apply - the transactional land-sync writer ----------------------
--
-- p_ops is an ordered jsonb array. Each op:
--   { "op": "insert", "table": "farms", "ref": "farms:<farm_uid>", "values": {...} }
--   { "op": "update", "table": "fields", "id": "<uuid>" | {"$ref": "..."}, "values": {...} }
--   { "op": "archive", "table": "field_plantings", "id": "<uuid>" }
--   { "op": "replace_varieties", "planting": "<uuid>" | {"$ref": "..."},
--     "varieties": [{"variety": "...", "acres": 12.5, "bushels": null}] }
--   { "op": "link", "grain_table": "farms", "grain_id": "<uuid>" | {"$ref": "..."},
--     "farm_uid": "<uuid>", "linked_by": "sync" }
-- Any value equal to {"$ref": "<ref>"} resolves to the id an earlier insert in
-- the same call produced (a field's farm created three ops earlier). Returns
-- { "<ref>": "<uuid>", ... }. Every row is forced onto p_org; updates and
-- archives touch only rows of p_org. Any error aborts the whole call
-- (PostgreSQL runs a function in one transaction), so the batch is atomic.
-- Column names go through %I and values through jsonb_populate_record, so the
-- payload can never inject SQL; the table allowlist keeps it on the land tables.

create or replace function public.farm_link_apply(p_org uuid, p_ops jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  op jsonb;
  refs jsonb := '{}'::jsonb;
  tbl text;
  vals jsonb;
  cols text;
  sets text;
  new_id uuid;
  target uuid;
  k text;
  v jsonb;
  resolved jsonb;
  var jsonb;
  allowed constant text[] := array['entities', 'landowners', 'farms', 'fields', 'crops', 'field_plantings', 'field_planting_varieties'];
begin
  if p_org is null then raise exception 'farm_link_apply: p_org is required'; end if;
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then raise exception 'farm_link_apply: p_ops must be an array'; end if;

  for op in select * from jsonb_array_elements(p_ops) loop
    tbl := op->>'table';
    cols := null;
    resolved := '{}'::jsonb;

    if op->>'op' in ('insert', 'update') then
      if not (tbl = any(allowed)) then raise exception 'farm_link_apply: table % not allowed', tbl; end if;
      -- Resolve {"$ref": ...} values; never let the payload set id / org_id.
      for k, v in select * from jsonb_each(coalesce(op->'values', '{}'::jsonb)) loop
        if k in ('org_id', 'id', 'created_at') then continue; end if;
        if jsonb_typeof(v) = 'object' and v ? '$ref' then
          if not (refs ? (v->>'$ref')) then raise exception 'farm_link_apply: unresolved ref %', v->>'$ref'; end if;
          resolved := resolved || jsonb_build_object(k, refs->(v->>'$ref'));
        else
          resolved := resolved || jsonb_build_object(k, v);
        end if;
      end loop;
      -- Only columns that exist on the table.
      select string_agg(format('%I', key), ', ') into cols
        from jsonb_object_keys(resolved) as key
        where exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = tbl and c.column_name = key);
    end if;

    if op->>'op' = 'insert' then
      new_id := gen_random_uuid();
      vals := resolved || jsonb_build_object('id', new_id, 'org_id', p_org);
      execute format('insert into public.%I (id, org_id%s) select id, org_id%s from jsonb_populate_record(null::public.%I, $1)',
        tbl, case when cols is null then '' else ', ' || cols end, case when cols is null then '' else ', ' || cols end, tbl)
        using vals;
      if op ? 'ref' then refs := refs || jsonb_build_object(op->>'ref', new_id); end if;

    elsif op->>'op' = 'update' then
      if jsonb_typeof(op->'id') = 'object' then
        target := (refs->>(op->'id'->>'$ref'))::uuid;
      else
        target := (op->>'id')::uuid;
      end if;
      if target is null then raise exception 'farm_link_apply: update needs an id'; end if;
      if cols is null then continue; end if;
      select string_agg(format('%1$I = r.%1$I', key), ', ') into sets
        from jsonb_object_keys(resolved) as key
        where exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = tbl and c.column_name = key);
      execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.id = $2 and t.org_id = $3', tbl, sets, tbl)
        using resolved, target, p_org;

    elsif op->>'op' = 'archive' then
      if not (tbl = any(array['entities', 'farms', 'fields', 'field_plantings'])) then
        raise exception 'farm_link_apply: % cannot be archived', tbl;
      end if;
      execute format('update public.%I set archived_at = coalesce(archived_at, now()), managed_by = ''turnrow_farm'' where id = $1 and org_id = $2', tbl)
        using (op->>'id')::uuid, p_org;

    elsif op->>'op' = 'replace_varieties' then
      if jsonb_typeof(op->'planting') = 'object' then
        target := (refs->>(op->'planting'->>'$ref'))::uuid;
      else
        target := (op->>'planting')::uuid;
      end if;
      if target is null then raise exception 'farm_link_apply: replace_varieties needs a planting'; end if;
      delete from public.field_planting_varieties where planting_id = target and org_id = p_org;
      for var in select * from jsonb_array_elements(coalesce(op->'varieties', '[]'::jsonb)) loop
        insert into public.field_planting_varieties (org_id, planting_id, variety, acres, bushels)
        values (p_org, target, var->>'variety', coalesce((var->>'acres')::numeric, 0), (var->>'bushels')::numeric);
      end loop;

    elsif op->>'op' = 'link' then
      if jsonb_typeof(op->'grain_id') = 'object' then
        target := (refs->>(op->'grain_id'->>'$ref'))::uuid;
      else
        target := (op->>'grain_id')::uuid;
      end if;
      if target is null then raise exception 'farm_link_apply: link needs a grain_id'; end if;
      insert into public.farm_link_ids (org_id, grain_table, grain_id, farm_uid, linked_by)
      values (p_org, op->>'grain_table', target, op->>'farm_uid', coalesce(op->>'linked_by', 'sync'))
      on conflict (org_id, grain_table, grain_id) do update
        set farm_uid = excluded.farm_uid, linked_by = excluded.linked_by, linked_at = now();

    else
      raise exception 'farm_link_apply: unknown op %', op->>'op';
    end if;
  end loop;

  return refs;
end $$;

-- Service role only: the API is the sole caller. Signed-in users never reach it.
revoke execute on function public.farm_link_apply(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.farm_link_apply(uuid, jsonb) to service_role;

-- 10. Super-admin view of links across organizations (metadata only) ----------
-- Org name, Farm org name, status, scopes, dates, last-sync summary. No records.

create or replace function public.admin_list_farm_links()
returns table (
  link_id uuid, org_id uuid, org_name text, farm_org_name text, status text, scopes text[],
  created_at timestamptz, redeemed_at timestamptz, revoked_at timestamptz, last_seen_at timestamptz,
  last_inbound_at timestamptz, last_outbound_at timestamptz
)
language sql security definer set search_path = public as $$
  select l.id, l.org_id, o.name, l.farm_org_name, l.status, l.scopes,
         l.created_at, l.redeemed_at, l.revoked_at, l.last_seen_at,
         (l.last_sync->'inbound'->>'at')::timestamptz, (l.last_sync->'outbound'->>'at')::timestamptz
  from public.farm_links l
  join public.organizations o on o.id = l.org_id
  where public.is_super_admin()
  order by o.name, l.created_at desc
$$;
revoke execute on function public.admin_list_farm_links() from public, anon;
grant execute on function public.admin_list_farm_links() to authenticated;
