-- 089: Landowners shared BOTH WAYS over the Turnrow Farm link.
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- NOTE ON NUMBERING: the prompt for this work called it 088. 088 was already
-- taken by the crop insurance pull and is applied in production, so this is
-- 089. Nothing else about the spec changed.
--
-- Until now a landowner arrived through the land sync and was read-only here,
-- like every other land record. That is wrong for landowners specifically:
-- Grain is where the rent settlement, the partner share, and the payee name
-- live, so the farmer edits landowners HERE as often as in Turnrow Farm. From
-- 089 a landowner is a record either side may edit, merged FIELD BY FIELD,
-- with conflicts surfaced rather than overwritten. Farm stays the master for
-- everything else on the land tables, for leases, and for landowner statements.
--
--   1. landowners gains the fields both sides share (kind, contact and payee
--      names, the split address) plus archived_at and merged_into_id. The old
--      free-text `address` is KEPT and split into the parts where it parses.
--   2. landowner_field_changes - the per-field change log. A trigger writes one
--      row per changed shared field, stamped with who changed it. This is what
--      lets the Farm side merge field by field instead of clobbering a row, and
--      what lets Grain answer "I changed this after your base, to a different
--      value" for exactly the fields that conflict. Trimmed to 90 days.
--   3. lease_terms gains managed_by + farm_lease_uid: once Farm adopts a lease,
--      Grain shows it read-only with a link. rent_settlements gains
--      superseded_by_settlement_id so a Grain settlement Farm has replaced
--      points at its replacement instead of quietly disagreeing with it.
--   4. landowner_settlements gains status (final | withdrawn). A statement Farm
--      deleted is kept and marked withdrawn, and a withdrawn statement is never
--      served to a landowner share.
--   5. partner_shares gains last_viewed_at, so the landowners pull can tell the
--      Farm side whether the landowner actually opens their share.
--   6. The landowners:write scope joins FARM_LINK_SCOPES.
--   7. farm_link_landowner_apply(p_org, p_ops) - the ONE transactional writer
--      for the sync, the merge, and the archive, mirroring 087's
--      farm_link_apply.
--
-- Policy stack (082 template): landowner_field_changes is a new tenant table
-- and gets the full stack. It carries landowner contact detail, so viewers and
-- agronomists are blocked from reads as well as writes (the 069 variant).

-- 1. landowners ----------------------------------------------------------------

alter table public.landowners
  add column if not exists kind text,
  add column if not exists contact_name text,
  add column if not exists payee_name text,
  add column if not exists address_street text,
  add column if not exists address_city text,
  add column if not exists address_state text,
  add column if not exists address_zip text,
  add column if not exists archived_at timestamptz,
  add column if not exists merged_into_id uuid references public.landowners(id) on delete set null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'landowners_kind_known') then
    alter table public.landowners add constraint landowners_kind_known check (
      kind is null or kind in ('individual', 'family', 'company', 'trust', 'estate', 'government', 'other')
    );
  end if;
  -- A landowner can never be merged into itself.
  if not exists (select 1 from pg_constraint where conname = 'landowners_merge_not_self') then
    alter table public.landowners add constraint landowners_merge_not_self check (merged_into_id is null or merged_into_id <> id);
  end if;
end $$;

create index if not exists landowners_org_updated_idx on public.landowners (org_id, updated_at);
create index if not exists landowners_merged_into_idx on public.landowners (merged_into_id) where merged_into_id is not null;

-- Split the old free-text address into the parts, ONLY where it parses as
-- "street, city, ST 12345" (or "... ST 12345-6789"). Anything else stays whole
-- in address_street - a half-parsed address is worse than an unparsed one.
-- Runs only on rows that have not been split yet, so a re-run is a no-op and
-- never overwrites a part the farmer has since corrected by hand.
do $$
declare r record; m text[];
begin
  for r in
    select id, address from public.landowners
     where address is not null and btrim(address) <> ''
       and address_street is null and address_city is null and address_state is null and address_zip is null
  loop
    m := regexp_match(btrim(r.address), '^(.+),\s*([^,]+),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*$');
    if m is not null then
      update public.landowners
         set address_street = btrim(m[1]), address_city = btrim(m[2]),
             address_state = upper(m[3]), address_zip = m[4]
       where id = r.id;
    else
      update public.landowners set address_street = btrim(r.address) where id = r.id;
    end if;
  end loop;
end $$;

-- 2. landowner_field_changes ----------------------------------------------------
-- LANDOWNER_SHARED_FIELDS

create table if not exists public.landowner_field_changes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  landowner_id uuid not null references public.landowners(id) on delete cascade,
  field text not null,
  old_value text,
  new_value text,
  changed_at timestamptz not null default now(),
  -- The user's uuid as text, or the literal 'turnrow_farm' when the link wrote
  -- it. A 'turnrow_farm' row never counts as a Grain change, so a Farm write
  -- can never echo back to Farm as a conflict.
  changed_by text not null default 'grain',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists landowner_field_changes_org_idx on public.landowner_field_changes (org_id);
create index if not exists landowner_field_changes_lookup_idx
  on public.landowner_field_changes (org_id, landowner_id, field, changed_at desc);
create index if not exists landowner_field_changes_since_idx
  on public.landowner_field_changes (org_id, changed_at desc);

drop trigger if exists landowner_field_changes_set_updated_at on public.landowner_field_changes;
create trigger landowner_field_changes_set_updated_at
  before update on public.landowner_field_changes
  for each row execute function public.set_updated_at();

-- The writer. One row per CHANGED shared field. `app.change_actor` is set by
-- the link's apply function to 'turnrow_farm'; a signed-in edit leaves it unset
-- and the actor is the user's uuid (or 'grain' with no session).
create or replace function public.log_landowner_field_changes()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  f text;
  old_j jsonb := to_jsonb(old);
  new_j jsonb := to_jsonb(new);
  old_v text;
  new_v text;
  actor text;
  shared constant text[] := array[
    'name', 'kind', 'contact_name', 'phone', 'email',
    'address_street', 'address_city', 'address_state', 'address_zip',
    'payee_name', 'notes'
  ];
begin
  actor := coalesce(nullif(current_setting('app.change_actor', true), ''), coalesce(auth.uid()::text, 'grain'));
  foreach f in array shared loop
    old_v := old_j->>f;
    new_v := new_j->>f;
    if old_v is distinct from new_v then
      insert into public.landowner_field_changes (org_id, landowner_id, field, old_value, new_value, changed_by)
      values (new.org_id, new.id, f, old_v, new_v, actor);
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists landowners_log_field_changes on public.landowners;
create trigger landowners_log_field_changes
  after update on public.landowners
  for each row execute function public.log_landowner_field_changes();

-- 90-day retention. The API calls this at most once a day (the farm_link_calls
-- pattern); it is here so a database with no traffic still stays trimmed.
create or replace function public.trim_landowner_field_changes(p_days integer default 90)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.landowner_field_changes where changed_at < now() - make_interval(days => p_days);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.trim_landowner_field_changes(integer) from public, anon;
grant execute on function public.trim_landowner_field_changes(integer) to service_role;

-- 3. lease_terms + rent_settlements ---------------------------------------------

alter table public.lease_terms
  add column if not exists managed_by text,
  add column if not exists farm_lease_uid text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lease_terms_managed_by_known') then
    alter table public.lease_terms add constraint lease_terms_managed_by_known
      check (managed_by is null or managed_by = 'turnrow_farm');
  end if;
end $$;

create index if not exists lease_terms_org_updated_idx on public.lease_terms (org_id, updated_at);
create unique index if not exists lease_terms_farm_lease_uid_unique
  on public.lease_terms (org_id, farm_lease_uid) where farm_lease_uid is not null;

alter table public.rent_settlements
  add column if not exists superseded_by_settlement_id uuid
    references public.landowner_settlements(id) on delete set null;

create index if not exists rent_settlements_superseded_idx
  on public.rent_settlements (superseded_by_settlement_id) where superseded_by_settlement_id is not null;

-- 4. landowner_settlements.status -----------------------------------------------

alter table public.landowner_settlements
  add column if not exists status text not null default 'final';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'landowner_settlements_status_known') then
    alter table public.landowner_settlements add constraint landowner_settlements_status_known
      check (status in ('final', 'withdrawn'));
  end if;
end $$;

-- 5. partner_shares.last_viewed_at ----------------------------------------------

alter table public.partner_shares
  add column if not exists last_viewed_at timestamptz;

-- 6. landowners:write -----------------------------------------------------------
-- FARM_LINK_SCOPES

do $$
begin
  if to_regclass('public.farm_links') is null then
    raise notice '089: farm_links is missing - apply 087 first, then re-run 089.';
    return;
  end if;
  alter table public.farm_links alter column scopes set default array[
    'land:write', 'production:read', 'marketing:read', 'income:read',
    'bins:read', 'insurance:read', 'landowners:write', 'assumptions:write', 'settlements:write'
  ];
  alter table public.farm_links drop constraint if exists farm_links_scopes_known;
  alter table public.farm_links add constraint farm_links_scopes_known check (
    scopes <@ array['land:write', 'production:read', 'marketing:read', 'income:read',
                    'bins:read', 'insurance:read', 'landowners:write', 'assumptions:write', 'settlements:write']
  );
end $$;

-- 7. farm_link_landowner_apply --------------------------------------------------
--
-- The ONE transactional writer for the landowner endpoints, mirroring 087's
-- farm_link_apply. p_ops is an ordered jsonb array:
--
--   { "op": "insert", "ref": "lo:<farm_uid>", "values": {...} }
--   { "op": "update", "id": "<uuid>", "values": {...} }
--   { "op": "link",   "grain_id": "<uuid>"|{"$ref":...}, "farm_uid": "<uid>" }
--   { "op": "merge",  "survivor": "<uuid>", "merged": "<uuid>", "move_share": true }
--   { "op": "archive","id": "<uuid>" }
--
-- Every row is forced onto p_org and only rows of p_org are touched. The whole
-- call runs in one transaction, so a batch either fully lands or fully rolls
-- back. Column names go through %I and values through jsonb_populate_record, so
-- the payload can never inject SQL, and the column allowlist keeps the writes
-- on the shared landowner fields. The session flag app.change_actor is set to
-- 'turnrow_farm' for the whole call, so the change log records these as Farm's
-- writes and they never echo back as Grain edits.

create or replace function public.farm_link_landowner_apply(p_org uuid, p_ops jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  op jsonb;
  refs jsonb := '{}'::jsonb;
  counts jsonb := '{}'::jsonb;
  vals jsonb;
  resolved jsonb;
  cols text;
  sets text;
  new_id uuid;
  target uuid;
  survivor uuid;
  merged uuid;
  k text;
  v jsonb;
  n integer;
  allowed constant text[] := array[
    'name', 'kind', 'contact_name', 'phone', 'email',
    'address_street', 'address_city', 'address_state', 'address_zip',
    'payee_name', 'notes', 'address'
  ];
begin
  if p_org is null then raise exception 'farm_link_landowner_apply: p_org is required'; end if;
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then raise exception 'farm_link_landowner_apply: p_ops must be an array'; end if;

  -- Every write in this call is Turnrow Farm's, for the change log.
  perform set_config('app.change_actor', 'turnrow_farm', true);

  for op in select * from jsonb_array_elements(p_ops) loop
    resolved := '{}'::jsonb;
    cols := null;

    if op->>'op' in ('insert', 'update') then
      for k, v in select * from jsonb_each(coalesce(op->'values', '{}'::jsonb)) loop
        if not (k = any(allowed)) then continue; end if;
        resolved := resolved || jsonb_build_object(k, v);
      end loop;
      select string_agg(format('%I', key), ', ') into cols from jsonb_object_keys(resolved) as key;
    end if;

    if op->>'op' = 'insert' then
      new_id := gen_random_uuid();
      vals := resolved || jsonb_build_object('id', new_id, 'org_id', p_org);
      execute format('insert into public.landowners (id, org_id%s) select id, org_id%s from jsonb_populate_record(null::public.landowners, $1)',
        case when cols is null then '' else ', ' || cols end,
        case when cols is null then '' else ', ' || cols end)
        using vals;
      if op ? 'ref' then refs := refs || jsonb_build_object(op->>'ref', new_id); end if;
      counts := jsonb_set(counts, '{created}', to_jsonb(coalesce((counts->>'created')::int, 0) + 1));

    elsif op->>'op' = 'update' then
      target := (op->>'id')::uuid;
      if target is null then raise exception 'farm_link_landowner_apply: update needs an id'; end if;
      if cols is null then continue; end if;
      select string_agg(format('%1$I = r.%1$I', key), ', ') into sets from jsonb_object_keys(resolved) as key;
      execute format('update public.landowners t set %s from jsonb_populate_record(null::public.landowners, $1) r where t.id = $2 and t.org_id = $3', sets)
        using resolved, target, p_org;
      counts := jsonb_set(counts, '{updated}', to_jsonb(coalesce((counts->>'updated')::int, 0) + 1));

    elsif op->>'op' = 'link' then
      if jsonb_typeof(op->'grain_id') = 'object' then
        target := (refs->>(op->'grain_id'->>'$ref'))::uuid;
      else
        target := (op->>'grain_id')::uuid;
      end if;
      if target is null then raise exception 'farm_link_landowner_apply: link needs a grain_id'; end if;
      insert into public.farm_link_ids (org_id, grain_table, grain_id, farm_uid, linked_by)
      values (p_org, 'landowners', target, op->>'farm_uid', coalesce(op->>'linked_by', 'sync'))
      on conflict (org_id, grain_table, grain_id) do update
        set farm_uid = excluded.farm_uid, linked_by = excluded.linked_by, linked_at = now();

    elsif op->>'op' = 'merge' then
      survivor := (op->>'survivor')::uuid;
      merged := (op->>'merged')::uuid;
      if survivor is null or merged is null then raise exception 'farm_link_landowner_apply: merge needs survivor and merged'; end if;
      if survivor = merged then raise exception 'farm_link_landowner_apply: cannot merge a landowner into itself'; end if;
      -- Both must belong to p_org; a cross-org merge is impossible.
      if not exists (select 1 from public.landowners where id = survivor and org_id = p_org)
         or not exists (select 1 from public.landowners where id = merged and org_id = p_org) then
        raise exception 'farm_link_landowner_apply: both landowners must belong to the organization';
      end if;

      update public.farms set landowner_id = survivor where landowner_id = merged and org_id = p_org;
      get diagnostics n = row_count; counts := jsonb_set(counts, '{farms}', to_jsonb(n));
      update public.lease_terms set landowner_id = survivor where landowner_id = merged and org_id = p_org;
      get diagnostics n = row_count; counts := jsonb_set(counts, '{lease_terms}', to_jsonb(n));
      update public.rent_settlements set landowner_id = survivor where landowner_id = merged and org_id = p_org;
      get diagnostics n = row_count; counts := jsonb_set(counts, '{rent_settlements}', to_jsonb(n));
      update public.landowner_settlements set landowner_id = survivor where landowner_id = merged and org_id = p_org;
      get diagnostics n = row_count; counts := jsonb_set(counts, '{landowner_settlements}', to_jsonb(n));
      if coalesce((op->>'move_share')::boolean, false) then
        update public.partner_shares set landowner_id = survivor where landowner_id = merged and org_id = p_org;
        get diagnostics n = row_count; counts := jsonb_set(counts, '{partner_shares}', to_jsonb(n));
      end if;
      update public.landowners
         set merged_into_id = survivor, archived_at = coalesce(archived_at, now())
       where id = merged and org_id = p_org;

    elsif op->>'op' = 'archive' then
      target := (op->>'id')::uuid;
      if target is null then raise exception 'farm_link_landowner_apply: archive needs an id'; end if;
      update public.landowners set archived_at = coalesce(archived_at, now())
       where id = target and org_id = p_org;

    else
      raise exception 'farm_link_landowner_apply: unknown op %', op->>'op';
    end if;
  end loop;

  return jsonb_build_object('refs', refs, 'counts', counts);
end $$;

revoke execute on function public.farm_link_landowner_apply(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.farm_link_landowner_apply(uuid, jsonb) to service_role;

-- 8. Policy stack ---------------------------------------------------------------
-- FARM_LINK_TENANT_TABLES

do $$
declare t text;
begin
  foreach t in array array['landowner_field_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed all') then
      execute format('create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''viewer'') with check (public.app_role() <> ''viewer'')', t || '_viewer_block_all', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''agronomist'') with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_all', t);
    end if;
  end loop;
end $$;
