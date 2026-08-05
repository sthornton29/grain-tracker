-- DIAGNOSTIC — NOT A MIGRATION. Safe to run repeatedly; the cross-org probe
-- runs inside a rolled-back transaction and changes nothing.
--
-- Verifies 054 tenant isolation:
--   1) every tenant table carries the *_org_isolation RESTRICTIVE policy
--      (and an org-stamping default);
--   2) cross-org probe: a member moved to a brand-new empty org sees ZERO
--      rows in the tenant tables and cannot insert into another org;
--   3) a session with NO membership sees zero rows (fail closed).
-- Run the whole file at once and read the result sets.

create temp table if not exists _tenant_tables54 (t text primary key);
truncate _tenant_tables54;
insert into _tenant_tables54 values
  ('entities'), ('farms'), ('fields'), ('field_plantings'), ('field_planting_varieties'), ('crops'),
  ('bins'), ('bin_sites'), ('bin_inventory_adjustments'), ('trucks'), ('buyers'), ('delivery_locations'),
  ('landowners'), ('entity_counties'),
  ('loads'), ('load_splits'), ('load_attachments'), ('contracts'), ('contract_attachments'),
  ('settlements'), ('settlement_lines'),
  ('futures_positions'), ('options_positions'),
  ('crop_assumptions'), ('county_yield_assumptions'), ('crop_year_sales_status'),
  ('harvest_price_estimates'), ('variety_match_dismissals'),
  ('crop_insurance_policies'), ('crop_insurance_sco'), ('crop_insurance_eco'),
  ('crop_insurance_stax'), ('crop_insurance_mco'),
  ('farm_base_acres'), ('arc_plc_elections'), ('arc_plc_payments'),
  ('other_government_payments'), ('payment_limit_config'),
  ('budget_scenarios'), ('budget_lines'),
  ('gins'), ('cotton_loads'), ('gin_receipts'), ('gin_receipt_loads'), ('cotton_bales'),
  ('cotton_bale_grades'), ('cotton_sales_contracts'), ('cotton_pool_payments'),
  ('ccc_loans'), ('ccc_loan_bales'), ('cotton_ldp_records'), ('cotton_ldp_bales'),
  ('cotton_bale_dispositions'), ('cotton_fees'), ('cotton_fee_schedule'),
  ('user_entity_access'), ('viewer_assumption_overrides'), ('app_settings'), ('user_profiles');

-- 1) Policy + default census. Expect ZERO rows.
select tt.t as table_missing_isolation, 'no _org_isolation restrictive policy' as problem
from _tenant_tables54 tt
where not exists (
  select 1 from pg_policies p
  where p.schemaname = 'public' and p.tablename = tt.t
    and p.policyname = tt.t || '_org_isolation' and p.permissive = 'RESTRICTIVE'
)
union all
select tt.t, 'org_id default is not session-stamping (current_org_id)' as problem
from _tenant_tables54 tt
join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = tt.t and c.column_name = 'org_id'
where c.column_default not like '%current_org_id%';

-- 2) Cross-org probe (rolled back). A real member is moved to a fresh, empty
--    org: every tenant-table count must be 0 and a cross-org insert must fail.
begin;
insert into public.organizations (id, name, slug)
values ('ffffffff-0000-0000-0000-000000000001', 'PROBE ORG (rolled back)', 'probe-org-rollback');
-- Move the FIRST member (any user) into the probe org for this transaction.
update public.organization_members
set org_id = 'ffffffff-0000-0000-0000-000000000001'
where user_id = (select user_id from public.organization_members limit 1);
update public.user_profiles
set org_id = 'ffffffff-0000-0000-0000-000000000001'
where user_id = (select user_id from public.organization_members where org_id = 'ffffffff-0000-0000-0000-000000000001');

select set_config('request.jwt.claims',
  json_build_object('sub', (select user_id from public.organization_members where org_id = 'ffffffff-0000-0000-0000-000000000001' limit 1),
                    'role', 'authenticated')::text, true);
set local role authenticated;

-- Expect: probe_org = the probe uuid; every count 0.
select public.current_org_id() as probe_org;
do $$
declare t text; n bigint; bad int := 0;
begin
  for t in select tt.t from _tenant_tables54 tt loop
    execute format('select count(*) from public.%I', t) into n;
    if n > 0 then
      bad := bad + 1;
      raise warning 'LEAK: % rows visible cross-org in %', n, t;
    end if;
  end loop;
  if bad = 0 then raise notice 'cross-org probe clean: 0 rows visible in all tenant tables'; end if;
end $$;

-- Expect: ERROR-free result 'insert correctly rejected'. The WITH CHECK must
-- refuse a row stamped with the Turnrow org from the probe-org session.
do $$
begin
  begin
    insert into public.entities (name, org_id) values ('cross-org probe', public.default_org_id());
    raise warning 'LEAK: cross-org INSERT was accepted';
  exception when others then
    raise notice 'insert correctly rejected: %', sqlerrm;
  end;
end $$;

rollback;

-- 3) No-membership session sees nothing. Expect farms_visible = 0.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', 'ffffffff-0000-0000-0000-0000000000ff', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.current_org_id() as no_membership_org, (select count(*) from public.farms) as farms_visible;
rollback;

-- 4) Storage: the org-prefixed write policies exist and the old open-write
--    policies are gone. Expect the three 'documents org …' rows present = t
--    and legacy_open_policies = 0.
select
  bool_and(p.policyname is not null) as org_policies_present
from (values ('documents org write'), ('documents org update'), ('documents org delete')) want(name)
left join pg_policies p
  on p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = want.name;
select count(*) as legacy_open_policies
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname in ('documents authed write', 'documents authed update', 'documents authed delete');
