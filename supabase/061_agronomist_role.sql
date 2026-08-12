-- 061: Agronomist role — org-wide, read-only, Yields page ONLY.
--
-- REQUIRES 054 (org isolation — this file recreates 054's assign_user_role).
-- Idempotent: safe to re-run.
--
-- An agronomist advises on the WHOLE operation's production, so unlike the
-- viewer (052) there are NO entity grants: they see every entity's yields.
-- What they must never see is money — contracts, settlements, hedging,
-- insurance, government payments, budgets, fees, cotton marketing.
-- Three layers, like the gin/viewer roles:
--   * nav (navLinksFor) shows only Yields;
--   * middleware (lib/route-guard.ts) redirects every other path to /yields;
--   * RLS here is the real enforcement: agronomists are write-blocked on
--     EVERY public table (RESTRICTIVE per-command policies, the 042/052
--     pattern), and SELECT-blocked on every table EXCEPT the exact set the
--     Yields page and its drill-down read. The org-isolation policies (054)
--     AND on top as always, so an agronomist also never crosses orgs.
--
-- The readable set = the Yields surface's reads (app/yields/page.tsx,
-- components/yields-detail.tsx, components/reports/yields-by-landowner.tsx,
-- components/reports/cotton-yields-section.tsx) plus the two shell tables
-- every signed-in role needs (own user_profiles row for the role itself,
-- app_settings for the cotton-module flag). crop_assumptions is readable for
-- its harvest_complete flags — the page's in-progress/complete logic needs
-- them; trucks/bins/buyers are name lookups for the load drill-down.
--
-- NOTE for future migrations: new tables are select-blocked for agronomists
-- only if THIS file has run after they exist — a new table that the Yields
-- page starts reading must be added to the readable array below, and any new
-- table gets agronomist write-blocks only by re-running this loop (add your
-- own, like the 052 viewer note says).

-- 1. Role --------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'user_profiles_role_check'
      and pg_get_constraintdef(oid) not like '%agronomist%'
  ) then
    alter table public.user_profiles drop constraint user_profiles_role_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_role_check') then
    alter table public.user_profiles
      add constraint user_profiles_role_check check (role in ('owner', 'gin', 'viewer', 'agronomist'));
  end if;

  -- organization_members.role mirrors user_profiles.role via 053's
  -- sync_profile_membership trigger, so ITS check must widen too — otherwise
  -- the very first agronomist assignment fails inside the trigger.
  if exists (
    select 1 from pg_constraint
    where conname = 'organization_members_role_check'
      and pg_get_constraintdef(oid) not like '%agronomist%'
  ) then
    alter table public.organization_members drop constraint organization_members_role_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organization_members_role_check') then
    alter table public.organization_members
      add constraint organization_members_role_check check (role in ('owner', 'gin', 'viewer', 'agronomist'));
  end if;
end $$;

-- 2. Role RPC: allow 'agronomist' --------------------------------------------

-- Identical to 054's org-scoped version except the valid-role list. An
-- agronomist takes no entity grants — like owner/gin, any previous grants
-- are cleared.
create or replace function public.assign_user_role(user_email text, new_role text, entity_ids uuid[] default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid; caller_org uuid;
begin
  if auth.uid() is null or public.app_role() <> 'owner' then raise exception 'not allowed'; end if;
  caller_org := public.current_org_id();
  if caller_org is null then raise exception 'no organization membership'; end if;
  if new_role not in ('owner', 'gin', 'viewer', 'agronomist') then raise exception 'invalid role'; end if;
  if new_role = 'viewer' and (entity_ids is null or coalesce(array_length(entity_ids, 1), 0) = 0) then
    raise exception 'a viewer needs at least one entity';
  end if;
  select id into uid from auth.users where lower(email) = lower(user_email);
  if uid is null then raise exception 'no auth user with email %', user_email; end if;
  if uid = auth.uid() then raise exception 'you cannot change your own role'; end if;
  -- Only manage users inside YOUR org (a login not yet in any org joins it).
  if exists (select 1 from public.organization_members m where m.user_id = uid and m.org_id <> caller_org) then
    raise exception 'user belongs to another organization';
  end if;
  -- Grants must reference the caller's org's entities.
  if new_role = 'viewer' and exists (
    select 1 from unnest(entity_ids) g(eid)
    where not exists (select 1 from public.entities e where e.id = g.eid and e.org_id = caller_org)
  ) then
    raise exception 'unknown entity in grant list';
  end if;
  insert into public.user_profiles (user_id, role, org_id) values (uid, new_role, caller_org)
  on conflict (user_id) do update set role = excluded.role, org_id = excluded.org_id;
  delete from public.user_entity_access where user_id = uid;
  if new_role = 'viewer' then
    insert into public.user_entity_access (user_id, entity_id, org_id)
    select uid, eid, caller_org from (select distinct unnest(entity_ids) as eid) g;
  end if;
end $$;

revoke execute on function public.assign_user_role(text, text, uuid[]) from public, anon;
grant execute on function public.assign_user_role(text, text, uuid[]) to authenticated;

-- 3. Agronomist write-block + SELECT allowlist -------------------------------

-- RESTRICTIVE per-command policies on EVERY public table (the 042 gin /
-- 052 viewer pattern): no INSERT/UPDATE/DELETE anywhere, and no SELECT
-- outside the Yields read set. Restrictive SELECT policies FILTER rather
-- than error, so even a stray query from shared code returns empty instead
-- of crashing the page.
do $$
declare
  -- AGRONOMIST_READABLE_TABLES — the exact SELECT surface of the Yields page
  -- and its drill-down. Parsed by lib/agronomist-rls.test.ts (keep this
  -- marker comment and the array literal's shape).
  readable text[] := array[
    -- production core
    'loads', 'load_splits', 'fields', 'farms', 'field_plantings',
    'field_planting_varieties', 'entities', 'crops', 'landowners', 'counties',
    -- drill-down name lookups
    'trucks', 'bins', 'buyers',
    -- harvest_complete flags for the in-progress/complete exclusion logic
    'crop_assumptions',
    -- cotton yield sources
    'gin_receipts', 'gin_receipt_loads', 'cotton_bales', 'cotton_bale_grades',
    'cotton_loads',
    -- app shell: own role row + the cotton-module flag
    'user_profiles', 'app_settings'
  ];
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_del', t);
    end if;
    if not (t = any(readable)) then
      if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_sel') then
        execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_sel', t);
      end if;
    end if;
  end loop;
end $$;

-- 4. Storage: no agronomist writes -------------------------------------------

-- The 054 storage policies only exclude viewers; these restrictive blocks
-- AND on top so agronomists cannot touch the documents bucket either.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents agronomist block insert') then
    create policy "documents agronomist block insert" on storage.objects as restrictive for insert to authenticated
      with check (public.app_role() <> 'agronomist');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents agronomist block update') then
    create policy "documents agronomist block update" on storage.objects as restrictive for update to authenticated
      using (public.app_role() <> 'agronomist');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents agronomist block delete') then
    create policy "documents agronomist block delete" on storage.objects as restrictive for delete to authenticated
      using (public.app_role() <> 'agronomist');
  end if;
end $$;
