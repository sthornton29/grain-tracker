-- verify_migrations.sql — READ-ONLY migration checklist for the Supabase SQL editor.
--
-- Migrations are applied by hand here (there is no tracking table), so this
-- script probes for one distinctive artifact each migration creates — a
-- column, table, function, policy, or seeded row — and prints a ✓/✗ line per
-- migration with a verdict on top. It changes nothing.
--
-- How to read the result:
--   Row 1 is the verdict. Any '✗ MISSING' row names the migration file to run
--   (supabase/NNN_*.sql) — run them in ascending order.
--   '– data-only' rows (046) rewrite existing rows and leave no schema
--   fingerprint, so they cannot be verified structurally.
--
-- Companion deep-dives (also read-only): verify_052.sql (viewer RLS census),
-- verify_053.sql / verify_054.sql (multi-tenant org isolation).

with
tbls as (
  select table_name as t from information_schema.tables where table_schema = 'public'
),
cols as (
  select table_name as t, column_name as c from information_schema.columns where table_schema = 'public'
),
fns as (
  select p.proname as f, p.oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
checks(seq, migration, evidence, applied) as (values
  (  2, '002_seasons',                        'table field_plantings',                          exists (select 1 from tbls where t = 'field_plantings')),
  (  3, '003_delivery',                       'table delivery_locations',                       exists (select 1 from tbls where t = 'delivery_locations')),
  (  4, '004_dry_override',                   'loads.dry_bushels_override',                     exists (select 1 from cols where t = 'loads' and c = 'dry_bushels_override')),
  (  5, '005_bin_crop',                       'bins.crop_id',                                   exists (select 1 from cols where t = 'bins' and c = 'crop_id')),
  (  6, '006_farm_fsa',                       'farms.fsa_number',                               exists (select 1 from cols where t = 'farms' and c = 'fsa_number')),
  (  7, '007_payments',                       'table settlements',                              exists (select 1 from tbls where t = 'settlements')),
  (  8, '008_bin_inventory_adjustments',      'table bin_inventory_adjustments',                exists (select 1 from tbls where t = 'bin_inventory_adjustments')),
  (  9, '009_contracts_entity',               'contracts.entity_id',                            exists (select 1 from cols where t = 'contracts' and c = 'entity_id')),
  ( 10, '010_counties',                       'table counties',                                 exists (select 1 from tbls where t = 'counties')),
  ( 11, '011_bin_sites',                      'table bin_sites',                                exists (select 1 from tbls where t = 'bin_sites')),
  ( 12, '012_contracts_completed_at',         'contracts.completed_at',                         exists (select 1 from cols where t = 'contracts' and c = 'completed_at')),
  ( 13, '013_pdf_parsing',                    'loads.source_pdf_url',                           exists (select 1 from cols where t = 'loads' and c = 'source_pdf_url')),
  ( 14, '014_load_splits',                    'table load_splits',                              exists (select 1 from tbls where t = 'load_splits')),
  ( 15, '015_landowners_share_rent',          'table landowners',                               exists (select 1 from tbls where t = 'landowners')),
  ( 16, '016_irrigated_dryland',              'field_plantings.irrigated_acres',                exists (select 1 from cols where t = 'field_plantings' and c = 'irrigated_acres')),
  ( 17, '017_load_attachments',               'table load_attachments',                         exists (select 1 from tbls where t = 'load_attachments')),
  ( 18, '018_hedging',                        'table futures_positions',                        exists (select 1 from tbls where t = 'futures_positions')),
  ( 19, '019_options',                        'table options_positions',                        exists (select 1 from tbls where t = 'options_positions')),
  ( 20, '020_contracts_marketing',            'table crop_assumptions',                         exists (select 1 from tbls where t = 'crop_assumptions')),
  ( 21, '021_contract_attachments',           'table contract_attachments',                     exists (select 1 from tbls where t = 'contract_attachments')),
  ( 22, '022_planting_variety',               'table field_planting_varieties',                 exists (select 1 from tbls where t = 'field_planting_varieties')),
  ( 23, '023_yield_include_override',         'field_plantings.yield_include_override',         exists (select 1 from cols where t = 'field_plantings' and c = 'yield_include_override')),
  ( 24, '024_crop_insurance',                 'table crop_insurance_policies',                  exists (select 1 from tbls where t = 'crop_insurance_policies')),
  ( 25, '025_government_payments',            'table arc_plc_payments',                         exists (select 1 from tbls where t = 'arc_plc_payments')),
  ( 26, '026_unassigned_base',                'farm_base_acres.is_unassigned',                  exists (select 1 from cols where t = 'farm_base_acres' and c = 'is_unassigned')),
  -- 027 is a data seed (no schema artifact). The row probe runs through
  -- query_to_xml so the script still parses & reports if 025's table is absent.
  ( 27, '027_canola_sesame',                  'covered_commodities row ''Canola''',
        case when exists (select 1 from tbls where t = 'covered_commodities')
             then (xpath('/row', query_to_xml('select 1 from public.covered_commodities where name ilike ''canola'' limit 1', false, true, '')))[1] is not null
             else false end),
  ( 28, '028_harvest_category',               'crops.harvest_category',                         exists (select 1 from cols where t = 'crops' and c = 'harvest_category')),
  ( 29, '029_marketing_yield_breakout',       'crop_assumptions.expected_yield_irr',            exists (select 1 from cols where t = 'crop_assumptions' and c = 'expected_yield_irr')),
  ( 30, '030_crop_double_crop',               'crops.double_crop',                              exists (select 1 from cols where t = 'crops' and c = 'double_crop')),
  ( 31, '031_marketing_cost_breakout',        'crop_assumptions.cost_per_acre_irr',             exists (select 1 from cols where t = 'crop_assumptions' and c = 'cost_per_acre_irr')),
  ( 32, '032_program_year_config',            'table program_year_config',                      exists (select 1 from tbls where t = 'program_year_config')),
  ( 33, '033_assumed_basis',                  'crop_assumptions.assumed_basis',                 exists (select 1 from cols where t = 'crop_assumptions' and c = 'assumed_basis')),
  ( 34, '034_assumed_futures',                'crop_assumptions.assumed_futures',               exists (select 1 from cols where t = 'crop_assumptions' and c = 'assumed_futures')),
  ( 35, '035_crop_insurance_practice',        'crop_insurance_policies.practice',               exists (select 1 from cols where t = 'crop_insurance_policies' and c = 'practice')),
  ( 36, '036_coverage_attestation',           'crop_insurance_policies.covers_all_planted_acres', exists (select 1 from cols where t = 'crop_insurance_policies' and c = 'covers_all_planted_acres')),
  ( 37, '037_obbba_arc_plc',                  'table mya_monthly_prices',                       exists (select 1 from tbls where t = 'mya_monthly_prices')),
  ( 38, '038_county_state_keys_and_ai_mya',   'arc_benchmark_data.county_id',                   exists (select 1 from cols where t = 'arc_benchmark_data' and c = 'county_id')),
  ( 39, '039_payment_year_attribution',       'arc_plc_payments.revenue_crop_year',             exists (select 1 from cols where t = 'arc_plc_payments' and c = 'revenue_crop_year')),
  ( 40, '040_fsa_benchmark_file',             'table fsa_benchmark_cache',                      exists (select 1 from tbls where t = 'fsa_benchmark_cache')),
  ( 41, '041_entity_payment_limit',           'entities.payment_limit_persons',                 exists (select 1 from cols where t = 'entities' and c = 'payment_limit_persons')),
  ( 42, '042_cotton_module',                  'table gin_receipts',                             exists (select 1 from tbls where t = 'gin_receipts')),
  ( 43, '043_variety_match_dismissals',       'table variety_match_dismissals',                 exists (select 1 from tbls where t = 'variety_match_dismissals')),
  ( 44, '044_cotton_physical_marketing',      'table cotton_sales_contracts',                   exists (select 1 from tbls where t = 'cotton_sales_contracts')),
  ( 45, '045_area_plans_county_assumption',   'table county_yield_assumptions',                 exists (select 1 from tbls where t = 'county_yield_assumptions')),
  ( 46, '046_cotton_insurance_price_units',   'data-only unit rewrite — no fingerprint',        null::boolean),
  ( 47, '047_county_yield_differential',      'county_yield_assumptions.yield_differential',    exists (select 1 from cols where t = 'county_yield_assumptions' and c = 'yield_differential')),
  ( 48, '048_crop_budget_planner',            'table budget_scenarios',                         exists (select 1 from tbls where t = 'budget_scenarios')),
  ( 49, '049_budget_practice_breakout',       'budget_lines.cropping',                          exists (select 1 from cols where t = 'budget_lines' and c = 'cropping')),
  ( 50, '050_partner_api',                    'table crop_year_sales_status',                   exists (select 1 from tbls where t = 'crop_year_sales_status')),
  ( 51, '051_entity_role',                    'entities.entity_role',                           exists (select 1 from cols where t = 'entities' and c = 'entity_role')),
  ( 52, '052_viewer_role',                    'function viewer_entity_ids()',                   exists (select 1 from fns where f = 'viewer_entity_ids')),
  ( 53, '053_multitenant_phase1',             'table organizations + user_org_ids()',           exists (select 1 from tbls where t = 'organizations') and exists (select 1 from fns where f = 'user_org_ids')),
  ( 54, '054_org_isolation',                  'current_org_id() + table partner_api_tokens',    exists (select 1 from fns where f = 'current_org_id') and exists (select 1 from tbls where t = 'partner_api_tokens')),
  ( 55, '055_beta_onboarding',                'table super_admins',                             exists (select 1 from tbls where t = 'super_admins')),
  ( 56, '056_seed_wheat_spring',              'seed_org_defaults() seeds spring Wheat',         exists (select 1 from fns where f = 'seed_org_defaults' and pg_get_functiondef(oid) ilike '%''spring''%')),
  ( 57, '057_contract_date_sold',             'contracts.date_sold',                            exists (select 1 from cols where t = 'contracts' and c = 'date_sold')),
  ( 58, '058_bin_capacity_transfers',         'table bin_transfers',                            exists (select 1 from tbls where t = 'bin_transfers')),
  ( 59, '059_reference_contract_month',       'crop_assumptions.reference_contract_month',      exists (select 1 from cols where t = 'crop_assumptions' and c = 'reference_contract_month')),
  ( 60, '060_load_practice',                  'loads.practice',                                 exists (select 1 from cols where t = 'loads' and c = 'practice')),
  ( 61, '061_agronomist_role',                'agronomist RLS policies present',                exists (select 1 from pg_policies where schemaname = 'public' and policyname like '%agronomist_block_ins')),
  ( 62, '062_combine_yield_entries',          'table combine_yield_entries',                    exists (select 1 from tbls where t = 'combine_yield_entries')),
  ( 63, '063_farm_cash_rent',                 'farms.cash_rent_per_acre',                       exists (select 1 from cols where t = 'farms' and c = 'cash_rent_per_acre')),
  ( 64, '064_rma_price_cache',                'table rma_price_cache',                          exists (select 1 from tbls where t = 'rma_price_cache')),
  ( 65, '065_rma_offer_contracts',            'rma_price_cache.harvest_market_symbol',          exists (select 1 from cols where t = 'rma_price_cache' and c = 'harvest_market_symbol')),
  ( 66, '066_crop_rma_type_override',         'crops.rma_type_override',                        exists (select 1 from cols where t = 'crops' and c = 'rma_type_override')),
  ( 67, '067_external_trucks',                'table external_trucks + loads.hauler_truck',     exists (select 1 from tbls where t = 'external_trucks') and exists (select 1 from cols where t = 'loads' and c = 'hauler_truck')),
  ( 68, '068_data_assistant',                 'assistant_query() + table assistant_usage',      exists (select 1 from fns where f = 'assistant_query') and exists (select 1 from tbls where t = 'assistant_usage')),
  ( 69, '069_rent_settlement',                'lease_terms + rent_settlements + org branding',  exists (select 1 from tbls where t = 'lease_terms') and exists (select 1 from tbls where t = 'rent_settlements') and exists (select 1 from cols where t = 'organizations' and c = 'branding_display_name')),
  ( 70, '070_partner_shares',                 'table partner_shares',                           exists (select 1 from tbls where t = 'partner_shares')),
  ( 71, '071_truck_label_snapshot',           'loads.truck_label',                              exists (select 1 from cols where t = 'loads' and c = 'truck_label')),
  ( 72, '072_share_marketing_scopes',         'partner_shares.share_projected_prices/_yields',  exists (select 1 from cols where t = 'partner_shares' and c = 'share_projected_prices') and exists (select 1 from cols where t = 'partner_shares' and c = 'share_projected_yields'))
)
select status, migration, evidence
from (
  select 0 as ord,
    case
      when bool_and(applied) then '✅ ALL ' || count(*) filter (where applied is not null) || ' verifiable migrations applied — schema is at 072'
      else '❌ ' || count(*) filter (where applied = false) || ' migration(s) MISSING — run the ✗ files below in ascending order'
    end as status,
    '' as migration, '' as evidence
  from checks where applied is not null
  union all
  select seq,
    case when applied is null then '– data-only'
         when applied then '✓'
         else '✗ MISSING' end,
    migration, evidence
  from checks
) x
order by ord;
