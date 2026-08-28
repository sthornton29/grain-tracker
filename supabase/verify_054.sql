-- DIAGNOSTIC — NOT A MIGRATION. Safe to run repeatedly; the probes are
-- single atomic DO blocks that restore/clean up everything they touch (and a
-- mid-block error rolls the whole block back automatically).
--
-- POOLER-PROOF: no temp tables, no BEGIN/ROLLBACK spanning statements — the
-- Supabase SQL editor may run each statement on a different pooled
-- connection, so every statement here is self-contained.
--
-- Verifies 054 tenant isolation:
--   1) every tenant table carries the *_org_isolation RESTRICTIVE policy and
--      the session-stamping org_id default   → result set (expect ZERO rows);
--   2) cross-org probe: a member moved to a fresh empty org sees ZERO tenant
--      rows and cannot insert into another org → look at the MESSAGES panel
--      (expect "cross-org probe clean" and "insert correctly rejected");
--   3) a session with NO membership sees nothing → messages panel;
--   4) storage policy census                  → result sets.

-- 1) Policy + default census. Expect ZERO rows.
with tenant(t) as (
  values
    ('entities'), ('farms'), ('fields'), ('field_plantings'), ('field_planting_varieties'), ('crops'),
    ('bins'), ('bin_sites'), ('bin_inventory_adjustments'), ('bin_transfers'), ('trucks'), ('buyers'), ('delivery_locations'),
    ('landowners'), ('entity_counties'),
    ('loads'), ('load_splits'), ('load_attachments'), ('contracts'), ('contract_attachments'),
    ('settlements'), ('settlement_lines'),
    ('settlement_discount_items'), ('buyer_discount_schedules'), ('buyer_discount_schedule_rules'),
    ('futures_positions'), ('options_positions'),
    ('crop_assumptions'), ('county_yield_assumptions'), ('crop_year_sales_status'),
    ('harvest_price_estimates'), ('variety_match_dismissals'), ('combine_yield_entries'), ('external_trucks'), ('assistant_usage'), ('lease_terms'), ('rent_settlements'),
    ('crop_insurance_policies'), ('crop_insurance_sco'), ('crop_insurance_eco'),
    ('crop_insurance_stax'), ('crop_insurance_mco'),
    ('farm_base_acres'), ('arc_plc_elections'), ('arc_plc_payments'),
    ('other_government_payments'), ('payment_limit_config'),
    ('budget_scenarios'), ('budget_lines'),
    ('gins'), ('cotton_loads'), ('gin_receipts'), ('gin_receipt_loads'), ('cotton_bales'),
    ('cotton_bale_grades'), ('cotton_sales_contracts'), ('cotton_pool_payments'),
    ('ccc_loans'), ('ccc_loan_bales'), ('cotton_ldp_records'), ('cotton_ldp_bales'),
    ('cotton_bale_dispositions'), ('cotton_fees'), ('cotton_fee_schedule'),
    ('user_entity_access'), ('viewer_assumption_overrides'), ('app_settings'), ('user_profiles')
)
select tenant.t as table_missing_or_misconfigured, 'no _org_isolation restrictive policy' as problem
from tenant
where not exists (
  select 1 from pg_policies p
  where p.schemaname = 'public' and p.tablename = tenant.t
    and p.policyname = tenant.t || '_org_isolation' and p.permissive = 'RESTRICTIVE'
)
union all
select tenant.t, 'org_id default is not session-stamping (current_org_id)'
from tenant
join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = tenant.t and c.column_name = 'org_id'
where c.column_default not like '%current_org_id%';

-- 2) Cross-org probe — ONE atomic DO block. Creates a probe org, moves one
--    member into it, probes as that member, then restores everything. Read
--    the MESSAGES panel: expect "cross-org probe clean: 0 rows visible" and
--    "insert correctly rejected". Any "LEAK:" warning is a failure.
do $$
declare
  probe_org constant uuid := 'ffffffff-0000-0000-0000-000000000001';
  victim uuid; victim_old_member_org uuid; victim_old_profile_org uuid;
  t text; n bigint; bad int := 0;
begin
  insert into public.organizations (id, name, slug)
  values (probe_org, 'PROBE ORG (auto-removed)', 'probe-org-auto-removed')
  on conflict (id) do nothing;

  select m.user_id, m.org_id into victim, victim_old_member_org
  from public.organization_members m limit 1;
  if victim is null then raise exception 'no organization members exist — run 053 first'; end if;
  select p.org_id into victim_old_profile_org from public.user_profiles p where p.user_id = victim;

  update public.organization_members set org_id = probe_org where user_id = victim;
  update public.user_profiles set org_id = probe_org where user_id = victim;

  -- Become that member for the probes (SET LOCAL + local config revert
  -- automatically when this block's statement ends).
  perform set_config('request.jwt.claims',
    json_build_object('sub', victim, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if public.current_org_id() is distinct from probe_org then
    raise warning 'PROBE BROKEN: current_org_id() = %, expected the probe org', public.current_org_id();
  end if;

  for t in
    select x from unnest(array[
      'entities','farms','fields','field_plantings','field_planting_varieties','crops',
      'bins','bin_sites','bin_inventory_adjustments','bin_transfers','trucks','buyers','delivery_locations',
      'landowners','entity_counties',
      'loads','load_splits','load_attachments','contracts','contract_attachments',
      'settlements','settlement_lines',
      'settlement_discount_items','buyer_discount_schedules','buyer_discount_schedule_rules',
      'futures_positions','options_positions',
      'crop_assumptions','county_yield_assumptions','crop_year_sales_status',
      'harvest_price_estimates','variety_match_dismissals','combine_yield_entries','external_trucks','assistant_usage','lease_terms','rent_settlements',
      'crop_insurance_policies','crop_insurance_sco','crop_insurance_eco',
      'crop_insurance_stax','crop_insurance_mco',
      'farm_base_acres','arc_plc_elections','arc_plc_payments',
      'other_government_payments','payment_limit_config',
      'budget_scenarios','budget_lines',
      'gins','cotton_loads','gin_receipts','gin_receipt_loads','cotton_bales',
      'cotton_bale_grades','cotton_sales_contracts','cotton_pool_payments',
      'ccc_loans','ccc_loan_bales','cotton_ldp_records','cotton_ldp_bales',
      'cotton_bale_dispositions','cotton_fees','cotton_fee_schedule',
      'user_entity_access','viewer_assumption_overrides','app_settings','user_profiles'
    ]) as u(x)
  loop
    execute format('select count(*) from public.%I', t) into n;
    if n > 0 then
      bad := bad + 1;
      raise warning 'LEAK: % rows visible cross-org in %', n, t;
    end if;
  end loop;
  if bad = 0 then raise notice 'cross-org probe clean: 0 rows visible in all tenant tables'; end if;

  -- WITH CHECK must refuse a row stamped with another org from this session.
  begin
    insert into public.entities (name, org_id) values ('cross-org probe', public.default_org_id());
    raise warning 'LEAK: cross-org INSERT was accepted';
  exception when others then
    raise notice 'insert correctly rejected: %', sqlerrm;
  end;

  -- Restore everything (an error above rolls the whole block back anyway).
  reset role;
  update public.organization_members set org_id = victim_old_member_org where user_id = victim;
  if victim_old_profile_org is not null then
    update public.user_profiles set org_id = victim_old_profile_org where user_id = victim;
  end if;
  delete from public.organizations where id = probe_org;
  raise notice 'probe cleanup complete (membership restored, probe org removed)';
end $$;

-- 3) No-membership session sees nothing. Messages: expect org = <NULL> and
--    farms_visible = 0.
do $$
declare n bigint;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'ffffffff-0000-0000-0000-0000000000ff', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.farms;
  raise notice 'no-membership probe: current_org_id() = %, farms_visible = %', public.current_org_id(), n;
  reset role;
end $$;

-- 4) Storage: the org-prefixed write policies exist and the old open-write
--    policies are gone. Expect org_policies_present = true, legacy_open_policies = 0.
select
  bool_and(p.policyname is not null) as org_policies_present
from (values ('documents org write'), ('documents org update'), ('documents org delete')) want(name)
left join pg_policies p
  on p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = want.name;
select count(*) as legacy_open_policies
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname in ('documents authed write', 'documents authed update', 'documents authed delete');
