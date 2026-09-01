-- 054: Multi-tenant PHASE 2 — tenant isolation. REQUIRES 053. Idempotent.
--
-- The org is established SERVER-SIDE from the caller's membership row —
-- public.current_org_id() (security definer, auth.uid() → organization_members)
-- — never from anything the client sends:
--   * RESTRICTIVE org policies on every tenant table AND with the existing
--     role policies (042 gin / 052 viewer rules apply unchanged WITHIN the
--     org): a user touches only rows where org_id = current_org_id(), for
--     SELECT and for every write (WITH CHECK rejects a spoofed org_id in a
--     request body).
--   * INSERT org stamping: the org_id column DEFAULT becomes
--     coalesce(current_org_id(), default_org_id()) — a session insert stamps
--     the member's org; the default_org_id() fallback only fires for
--     service-role writes with no session (RLS-bypassing code paths, which
--     must scope explicitly — see partner_api_tokens below).
--   * GLOBAL reference tables (counties, covered_commodities, commodity_specs,
--     market_prices, program_year_config, arc_benchmark_data,
--     mya_monthly_prices, fsa_benchmark_cache, fsa_benchmark_fetches,
--     awp_weekly, arc_plc_price_data): readable by all authenticated;
--     writes RESTRICTED to session'd OWNERS. NOT "writable by none": the
--     manual MYA overrides, program-year config, AWP entry, and benchmark
--     edits are owner data-entry surfaces that live on these tables today —
--     making them read-only would break Settings. A future org's owner could
--     also write them: accepted single-real-org debt, resolved when these
--     tables go per-org with the deferred-unique cutover.
--   * The role RPCs become org-scoped: list/assign only within the caller's
--     org; viewer entity grants must reference the caller's org's entities.
--   * partner_api_tokens: per-org bearer tokens (sha256 at rest) for the
--     partner API. The legacy PARTNER_API_TOKEN env var keeps working and
--     maps to the Turnrow org in lib/partner-api-server.ts (the secret isn't
--     available to SQL, so the mapping lives in code). No client policies —
--     only the service role reads this table.
--
-- NOTE for future migrations: new tenant tables need the org RESTRICTIVE
-- policy + the org_id default shim here as well as the 053 column rules.

-- 1. The session's org --------------------------------------------------------

create or replace function public.current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.organization_members where user_id = auth.uid() limit 1
$$;

-- 2. Org-stamping defaults + org isolation on every tenant table --------------

do $$
declare t text;
begin
  foreach t in array array[
    'entities', 'farms', 'fields', 'field_plantings', 'field_planting_varieties', 'crops',
    'bins', 'bin_sites', 'bin_inventory_adjustments', 'bin_transfers', 'trucks', 'buyers', 'delivery_locations',
    'landowners', 'entity_counties',
    'loads', 'load_splits', 'load_attachments', 'contracts', 'contract_attachments',
    'settlements', 'settlement_lines',
    'settlement_discount_items', 'buyer_discount_schedules', 'buyer_discount_schedule_rules',
    'futures_positions', 'options_positions',
    'crop_assumptions', 'county_yield_assumptions', 'crop_year_sales_status',
    'harvest_price_estimates', 'variety_match_dismissals', 'combine_yield_entries', 'external_trucks', 'assistant_usage', 'lease_terms', 'rent_settlements', 'org_dryers',
    'seed_contract_details', 'seed_contract_premiums', 'seed_pricing_elections', 'seed_contract_payments', 'seed_contract_plantings',
    'freight_settings', 'freight_distances',
    'crop_insurance_policies', 'crop_insurance_sco', 'crop_insurance_eco',
    'crop_insurance_stax', 'crop_insurance_mco',
    'farm_base_acres', 'arc_plc_elections', 'arc_plc_payments',
    'other_government_payments', 'payment_limit_config',
    'budget_scenarios', 'budget_lines',
    'gins', 'cotton_loads', 'gin_receipts', 'gin_receipt_loads', 'cotton_bales',
    'cotton_bale_grades', 'cotton_sales_contracts', 'cotton_pool_payments',
    'ccc_loans', 'ccc_loan_bales', 'cotton_ldp_records', 'cotton_ldp_bales',
    'cotton_bale_dispositions', 'cotton_fees', 'cotton_fee_schedule',
    'user_entity_access', 'viewer_assumption_overrides', 'app_settings', 'user_profiles'
  ] loop
    -- Session inserts stamp the member's org; service-role (no session)
    -- falls back to the Phase-1 shim and must scope explicitly in code.
    execute format('alter table public.%I alter column org_id set default coalesce(public.current_org_id(), public.default_org_id())', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format(
        'create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())',
        t || '_org_isolation', t);
    end if;
  end loop;
end $$;

-- organization_members itself: a member sees only their org's memberships.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'organization_members' and policyname = 'organization_members_org_isolation') then
    create policy organization_members_org_isolation on public.organization_members as restrictive for all to authenticated
      using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());
  end if;
end $$;

-- 3. Global reference tables: owner-only writes -------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'counties', 'covered_commodities', 'commodity_specs', 'market_prices',
    'program_year_config', 'arc_benchmark_data', 'mya_monthly_prices',
    'fsa_benchmark_cache', 'fsa_benchmark_fetches', 'awp_weekly', 'arc_plc_price_data',
    'dryer_models' -- 076 (creates its own policies too; listed for the re-run path)
  ] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_global_owner_write') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (auth.uid() is not null and public.app_role() = ''owner'')', t || '_global_owner_write', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (auth.uid() is not null and public.app_role() = ''owner'')', t || '_global_owner_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (auth.uid() is not null and public.app_role() = ''owner'')', t || '_global_owner_del', t);
    end if;
  end loop;
end $$;

-- 4. Org-scoped role RPCs -----------------------------------------------------

create or replace function public.assign_user_role(user_email text, new_role text, entity_ids uuid[] default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid; caller_org uuid;
begin
  if auth.uid() is null or public.app_role() <> 'owner' then raise exception 'not allowed'; end if;
  caller_org := public.current_org_id();
  if caller_org is null then raise exception 'no organization membership'; end if;
  if new_role not in ('owner', 'gin', 'viewer') then raise exception 'invalid role'; end if;
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

create or replace function public.list_user_roles()
returns table (user_id uuid, email text, role text, entity_ids uuid[])
language sql stable security definer set search_path = public as $$
  select u.id, u.email::text, coalesce(p.role, 'owner'),
         coalesce((select array_agg(a.entity_id) from public.user_entity_access a where a.user_id = u.id), '{}')
  from auth.users u
  join public.organization_members m on m.user_id = u.id and m.org_id = public.current_org_id()
  left join public.user_profiles p on p.user_id = u.id
  where auth.uid() is not null and public.app_role() = 'owner'
  order by u.email
$$;

revoke execute on function public.assign_user_role(text, text, uuid[]) from public, anon;
revoke execute on function public.list_user_roles() from public, anon;
grant execute on function public.assign_user_role(text, text, uuid[]) to authenticated;
grant execute on function public.list_user_roles() to authenticated;

-- 5. Per-org partner API tokens ----------------------------------------------

create table if not exists public.partner_api_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- sha256 hex of the bearer token; the plaintext is never stored.
  token_sha256 text not null unique,
  label text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists partner_api_tokens_org_idx on public.partner_api_tokens (org_id);

-- RLS on, NO policies: invisible to every client role; only the service role
-- (which bypasses RLS) reads it in lib/partner-api-server.ts. The legacy
-- PARTNER_API_TOKEN env var maps to the Turnrow org in that code.
alter table public.partner_api_tokens enable row level security;

-- 6. Storage: org-prefixed writes ---------------------------------------------

-- New uploads land under <org-id>/<prefix>/… (lib/pdf-upload.ts stamps the
-- prefix; these policies ENFORCE it — the client cannot lie about the org).
-- Legacy objects at the un-prefixed root stay manageable (update/delete)
-- exactly as today. Viewers get no storage writes at all.
--
-- DEBT, decided consciously: the bucket stays PUBLIC-READ (the PDF viewer
-- <object>/<img>/<a> tags load plain URLs; paths are unguessable). True
-- cross-org read isolation needs a private bucket + signed URLs across every
-- viewer surface — a separate change, see the Phase-2 notes.
drop policy if exists "documents authed write" on storage.objects;
drop policy if exists "documents authed update" on storage.objects;
drop policy if exists "documents authed delete" on storage.objects;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents org write') then
    create policy "documents org write" on storage.objects for insert to authenticated
      with check (
        bucket_id = 'documents'
        and public.app_role() <> 'viewer'
        and (storage.foldername(name))[1] = public.current_org_id()::text
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents org update') then
    create policy "documents org update" on storage.objects for update to authenticated
      using (
        bucket_id = 'documents'
        and public.app_role() <> 'viewer'
        and ((storage.foldername(name))[1] = public.current_org_id()::text
             or not exists (select 1 from public.organizations o where o.id::text = (storage.foldername(name))[1]))
      )
      with check (bucket_id = 'documents' and public.app_role() <> 'viewer');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents org delete') then
    create policy "documents org delete" on storage.objects for delete to authenticated
      using (
        bucket_id = 'documents'
        and public.app_role() <> 'viewer'
        and ((storage.foldername(name))[1] = public.current_org_id()::text
             or not exists (select 1 from public.organizations o where o.id::text = (storage.foldername(name))[1]))
      );
  end if;
end $$;
