-- DIAGNOSTIC — NOT A MIGRATION. Safe to run repeatedly; changes nothing
-- (the temp table lives only for this session).
--
-- Verifies the 053 multi-tenant Phase-1 schema:
--   1) every tenant table has org_id (NOT NULL + default);
--   2) no tenant row has a NULL org_id;
--   3) every unique constraint/index on a tenant table is org-scoped —
--      either it includes org_id, or it is on the KNOWN allowlist of keys
--      scoped through an org-scoped FK (crop_id / farm_id / policy_id /
--      bale_id / entity_id …), which are per-org in effect. Anything else
--      is flagged UNEXPECTED and needs a look.
-- Run the whole file at once and read the three result sets.

create temp table if not exists _tenant_tables (t text primary key);
truncate _tenant_tables;
insert into _tenant_tables values
  ('entities'), ('farms'), ('fields'), ('field_plantings'), ('field_planting_varieties'), ('crops'),
  ('bins'), ('bin_sites'), ('bin_inventory_adjustments'), ('bin_transfers'), ('trucks'), ('buyers'), ('delivery_locations'),
  ('landowners'), ('entity_counties'),
  ('loads'), ('load_splits'), ('load_attachments'), ('contracts'), ('contract_attachments'),
  ('settlements'), ('settlement_lines'),
  ('settlement_discount_items'), ('buyer_discount_schedules'), ('buyer_discount_schedule_rules'),
  ('futures_positions'), ('options_positions'),
  ('crop_assumptions'), ('county_yield_assumptions'), ('crop_year_sales_status'),
  ('harvest_price_estimates'), ('variety_match_dismissals'), ('combine_yield_entries'), ('external_trucks'), ('assistant_usage'), ('lease_terms'), ('rent_settlements'), ('org_dryers'),
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

-- 1) Tenant tables missing org_id (or missing NOT NULL / the default shim).
--    Expect ZERO rows.
select tt.t as table_missing_or_misconfigured_org_id,
       c.is_nullable, c.column_default
from _tenant_tables tt
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = tt.t and c.column_name = 'org_id'
where c.column_name is null
   or c.is_nullable = 'YES'
   or c.column_default is null;

-- 2) NULL org_id row counts. Expect ZERO rows (only offenders are listed).
do $$
declare t text; n bigint;
begin
  create temp table if not exists _null_org (t text, null_rows bigint);
  truncate _null_org;
  for t in select tt.t from _tenant_tables tt
           join information_schema.columns c
             on c.table_schema = 'public' and c.table_name = tt.t and c.column_name = 'org_id'
  loop
    execute format('select count(*) from public.%I where org_id is null', t) into n;
    if n > 0 then insert into _null_org values (t, n); end if;
  end loop;
end $$;
select * from _null_org;

-- 3) Unique constraints/indexes on tenant tables that do NOT include org_id.
--    status 'ok (fk-scoped)'  = on the allowlist: keyed by an org-scoped FK,
--                               per-org in effect (incl. every ON CONFLICT
--                               target the app upserts against);
--    status 'deferred'        = known Phase-2 item (cotton_fee_schedule year);
--    status 'UNEXPECTED'      = review it.
with uniq as (
  select t.relname as tbl, i.relname as idx,
         array_agg(a.attname order by k.ord) as cols
  from pg_index x
  join pg_class t on t.oid = x.indrelid
  join pg_class i on i.oid = x.indexrelid
  join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
  cross join lateral unnest(x.indkey::smallint[]) with ordinality as k(attnum, ord)
  join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
  where x.indisunique and not x.indisprimary
    and t.relname in (select tt.t from _tenant_tables tt)
  group by t.relname, i.relname
)
select tbl, idx, array_to_string(cols, ', ') as columns,
  case
    when 'org_id' = any(cols) then 'ok (org-scoped)'
    -- FK-scoped: the leading key is itself per-org (matched on table+columns,
    -- not index name — Postgres truncates long auto-names unpredictably).
    when tbl || ':' || array_to_string(cols, ',') in (
      'crop_assumptions:crop_id,crop_year',
      'crop_year_sales_status:crop_id,crop_year',
      'harvest_price_estimates:crop_id,crop_year,price_type,price_date',
      'county_yield_assumptions:crop_id,crop_year',           -- expression idx: coalesce(county_id) is not a plain column
      'variety_match_dismissals:crop_id,key_a,key_b',
      'crop_insurance_sco:policy_id', 'crop_insurance_eco:policy_id',
      'crop_insurance_stax:policy_id', 'crop_insurance_mco:policy_id',
      'farm_base_acres:farm_id,commodity_id',
      'arc_plc_elections:farm_id,commodity_id,crop_year',
      'arc_plc_payments:farm_id,commodity_id,crop_year',
      'payment_limit_config:entity_id,crop_year',
      'entity_counties:entity_id,county_id',
      'bin_sites:entity_id,name',
      'gin_receipt_loads:receipt_id,cotton_load_id',
      'cotton_bale_grades:bale_id',
      'cotton_bale_dispositions:bale_id',
      'ccc_loan_bales:bale_id',
      'cotton_ldp_bales:bale_id',
      'user_entity_access:user_id,entity_id',
      'viewer_assumption_overrides:user_id,scope,crop_id,crop_year,field' -- expression idx: coalesce(county_id)
    ) then 'ok (fk-scoped)'
    when tbl = 'cotton_fee_schedule' and array_to_string(cols, ',') = 'crop_year'
      then 'deferred (Phase 2: app upserts ON CONFLICT crop_year)'
    else 'UNEXPECTED — review'
  end as status
from uniq
order by status desc, tbl, idx;
