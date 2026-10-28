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
--   046 is data-only, so it is checked by the data state it guarantees (no
--   ¢-scale cotton insurance price remains) rather than a schema artifact.
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
  -- query_to_xml so the script still parses & reports if 025's table is
  -- absent. The inner query always returns exactly ONE row (an exists flag) —
  -- a zero-row query would make query_to_xml return an empty document, which
  -- xpath() refuses to parse.
  ( 27, '027_canola_sesame',                  'covered_commodities row ''Canola''',
        case when exists (select 1 from tbls where t = 'covered_commodities')
             then (xpath('/row/ok/text()', query_to_xml('select (exists (select 1 from public.covered_commodities where name ilike ''canola''))::int as ok', false, true, '')))[1]::text = '1'
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
  -- 046 is a data-only rewrite (¢/lb → $/lb on upland cotton insurance
  -- prices), so it is verified by the STATE it guarantees: no cotton policy /
  -- RMA-native estimate price > 5 remains. ✓ also means "never had bad data"
  -- — either way there is nothing to run. Probes via query_to_xml like 027.
  ( 46, '046_cotton_insurance_price_units',   'no ¢-scale cotton insurance prices remain',
        case when exists (select 1 from tbls where t = 'crop_insurance_policies') and exists (select 1 from tbls where t = 'harvest_price_estimates')
             then (xpath('/row/bad/text()', query_to_xml('select (exists (select 1 from public.crop_insurance_policies p join public.crops c on c.id = p.crop_id where c.name ilike ''%cotton%'' and c.name not ilike ''%seed%'' and (p.projected_price > 5 or p.harvest_price > 5)) or exists (select 1 from public.harvest_price_estimates e join public.crops c on c.id = e.crop_id where c.name ilike ''%cotton%'' and c.name not ilike ''%seed%'' and e.price_type in (''projected'', ''harvest_final'') and e.price > 5))::int as bad', false, true, '')))[1]::text = '0'
             else false end),
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
  ( 72, '072_share_marketing_scopes',         'partner_shares.share_projected_prices/_yields',  exists (select 1 from cols where t = 'partner_shares' and c = 'share_projected_prices') and exists (select 1 from cols where t = 'partner_shares' and c = 'share_projected_yields')),
  ( 73, '073_load_created_by',                'loads.created_by',                               exists (select 1 from cols where t = 'loads' and c = 'created_by')),
  ( 74, '074_settlement_discounts',           'settlement_discount_items + buyer_discount_schedules(+_rules)', exists (select 1 from tbls where t = 'settlement_discount_items') and exists (select 1 from tbls where t = 'buyer_discount_schedules') and exists (select 1 from tbls where t = 'buyer_discount_schedule_rules')),
  ( 75, '075_discount_deduction_kind',        'settlement_discount_items.deduction_kind',       exists (select 1 from cols where t = 'settlement_discount_items' and c = 'deduction_kind')),
  ( 76, '076_dryer_math',                     'table dryer_models + table org_dryers',          exists (select 1 from tbls where t = 'dryer_models') and exists (select 1 from tbls where t = 'org_dryers')),
  ( 77, '077_seed_production_contracts',      'contracts.contract_kind + seed_contract_details(+premiums/elections/payments/plantings)', exists (select 1 from cols where t = 'contracts' and c = 'contract_kind') and exists (select 1 from tbls where t = 'seed_contract_details') and exists (select 1 from tbls where t = 'seed_pricing_elections') and exists (select 1 from tbls where t = 'seed_contract_payments')),
  ( 78, '078_freight_math',                   'freight_settings + freight_distances + bin_sites.latitude', exists (select 1 from tbls where t = 'freight_settings') and exists (select 1 from tbls where t = 'freight_distances') and exists (select 1 from cols where t = 'bin_sites' and c = 'latitude')),
  ( 79, '079_wait_hours_dryer_settings',      'delivery_locations.wait_hours + table dryer_settings', exists (select 1 from cols where t = 'delivery_locations' and c = 'wait_hours') and exists (select 1 from tbls where t = 'dryer_settings')),
  ( 80, '080_schedule_shrink_factor',         'buyer_discount_schedule_rules.shrink_factor_pct_per_point', exists (select 1 from cols where t = 'buyer_discount_schedule_rules' and c = 'shrink_factor_pct_per_point')),
  ( 81, '081_assumed_acres',                  'crop_assumptions.assumed_acres (+ breakout)',   exists (select 1 from cols where t = 'crop_assumptions' and c = 'assumed_acres') and exists (select 1 from cols where t = 'crop_assumptions' and c = 'assumed_acres_dc_dry')),
  ( 82, '082_manual_market_quotes',           'market_prices.source + table manual_market_quotes', exists (select 1 from cols where t = 'market_prices' and c = 'source') and exists (select 1 from tbls where t = 'manual_market_quotes')),
  ( 83, '083_hedge_rolls_and_events',         'futures_positions.roll_group_id + table hedge_position_events + fn hedge_execute_roll', exists (select 1 from cols where t = 'futures_positions' and c = 'roll_group_id') and exists (select 1 from tbls where t = 'hedge_position_events') and exists (select 1 from fns where f = 'hedge_execute_roll')),
  ( 84, '084_assistant_usage_log',            'assistant_usage.tools_used + fn admin_assistant_log', exists (select 1 from cols where t = 'assistant_usage' and c = 'tools_used') and exists (select 1 from fns where f = 'admin_assistant_log')),
  ( 85, '085_bale_weight_assumption',          'crop_assumptions.bale_weight_lbs',               exists (select 1 from cols where t = 'crop_assumptions' and c = 'bale_weight_lbs')),
  ( 86, '086_settlement_checkoff_fees_matching', 'settlements.payment_number + settlement_lines.grade_readings + trucks.license_plate', exists (select 1 from cols where t = 'settlements' and c = 'payment_number') and exists (select 1 from cols where t = 'settlement_lines' and c = 'grade_readings') and exists (select 1 from cols where t = 'trucks' and c = 'license_plate')),
  ( 87, '087_farm_link',                      'tables farm_links + farm_link_ids + landowner_settlements + farms.managed_by + partner_shares.share_settlements + fn farm_link_apply', exists (select 1 from tbls where t = 'farm_links') and exists (select 1 from tbls where t = 'farm_link_ids') and exists (select 1 from tbls where t = 'landowner_settlements') and exists (select 1 from cols where t = 'farms' and c = 'managed_by') and exists (select 1 from cols where t = 'partner_shares' and c = 'share_settlements') and exists (select 1 from fns where f = 'farm_link_apply')),
  ( 88, '088_farm_link_insurance',           'table crop_insurance_deletions + crop_insurance_policies.updated_at + crop_assumptions.cost_includes_insurance', exists (select 1 from tbls where t = 'crop_insurance_deletions') and exists (select 1 from cols where t = 'crop_insurance_policies' and c = 'updated_at') and exists (select 1 from cols where t = 'crop_assumptions' and c = 'cost_includes_insurance')),
  ( 89, '089_farm_link_landowners',          'table landowner_field_changes + landowners.merged_into_id + lease_terms.farm_lease_uid + fn farm_link_landowner_apply', exists (select 1 from tbls where t = 'landowner_field_changes') and exists (select 1 from cols where t = 'landowners' and c = 'merged_into_id') and exists (select 1 from cols where t = 'lease_terms' and c = 'farm_lease_uid') and exists (select 1 from fns where f = 'farm_link_landowner_apply')),
  ( 90, '090_cotton_load_rolls',             'cotton_loads.rolls',                             exists (select 1 from cols where t = 'cotton_loads' and c = 'rolls')),
  ( 91, '091_buyer_ticket_number',           'loads.buyer_ticket_number',                      exists (select 1 from cols where t = 'loads' and c = 'buyer_ticket_number')),
  ( 92, '092_assumed_turnout',               'crop_assumptions.assumed_turnout_pct',           exists (select 1 from cols where t = 'crop_assumptions' and c = 'assumed_turnout_pct')),
  ( 93, '093_cotton_number_key',             'fn cotton_number_key + unique cotton_loads_org_year_key_unique + gins.gin_code + gin_receipts.statement_number',
        exists (select 1 from fns where f = 'cotton_number_key') and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'cotton_loads_org_year_key_unique')
        and exists (select 1 from cols where t = 'gins' and c = 'gin_code') and exists (select 1 from cols where t = 'gin_receipts' and c = 'statement_number')),
  -- 093 PARITY: the SQL key must agree with lib/number-key numberKey on the
  -- hand-verified list (lib/number-key.test.ts pins the same pairs). Probed
  -- only once the function exists (CASE short-circuits), so this script
  -- still runs on a database before 093.
  ( 94, '093 parity cotton_number_key',      'cotton_number_key(''031633'') = ''31633'', cotton_number_key(''0031633'') = ''31633'', cotton_number_key(''31632,'') = ''31632'', cotton_number_key(''000'') = ''0'', cotton_number_key(''988-1'') = ''988-1''',
        case when exists (select 1 from fns where f = 'cotton_number_key')
             then (xpath('/row/ok/text()', query_to_xml('select (public.cotton_number_key(''031633'') = ''31633'' and public.cotton_number_key(''0031633'') = ''31633'' and public.cotton_number_key(''31632,'') = ''31632'' and public.cotton_number_key(''000'') = ''0'' and public.cotton_number_key(''988-1'') = ''988-1'' and public.cotton_number_key('' 31633 -'') = ''31633'' and public.cotton_number_key(''A0012'') = ''A0012'' and public.cotton_number_key('''') is null and public.cotton_pbi_key(''0179122'') = ''179122'')::int as ok', false, true, '')))[1]::text = '1'
             else false end),
  -- 093 GUARANTEE: colliding cotton_loads number keys within an org × crop year must be 0.
  ( 95, '093 colliding load keys = 0',       'count of (org_id, crop_year, cotton_number_key(load_number)) groups with > 1 row',
        case when exists (select 1 from fns where f = 'cotton_number_key')
             then (xpath('/row/n/text()', query_to_xml('select count(*) as n from (select org_id, crop_year, public.cotton_number_key(load_number) k from public.cotton_loads where public.cotton_number_key(load_number) is not null group by 1, 2, 3 having count(*) > 1) c', false, true, '')))[1]::text = '0'
             else false end),
  ( 96, '093 colliding bale PBI keys = 0',   'count of (org_id, crop_year, cotton_pbi_key(pbi_number)) groups with > 1 row',
        case when exists (select 1 from fns where f = 'cotton_pbi_key')
             then (xpath('/row/n/text()', query_to_xml('select count(*) as n from (select org_id, crop_year, public.cotton_pbi_key(pbi_number) k from public.cotton_bales where public.cotton_pbi_key(pbi_number) is not null group by 1, 2, 3 having count(*) > 1) c', false, true, '')))[1]::text = '0'
             else false end),
  ( 97, '094_load_sales',                    'table load_sales + fn load_sales_set + settlement_lines.sale_type',
        exists (select 1 from tbls where t = 'load_sales') and exists (select 1 from fns where f = 'load_sales_set')
        and exists (select 1 from cols where t = 'settlement_lines' and c = 'sale_type')),
  -- 094 GUARANTEE: every load's sale shares sum to exactly 1 (a load with no rows is unassigned, not broken).
  ( 98, '094 sale shares sum to 1',          'count of loads whose load_sales shares sum to anything but 1',
        case when exists (select 1 from tbls where t = 'load_sales')
             then (xpath('/row/n/text()', query_to_xml('select count(*) as n from (select load_id from public.load_sales group by load_id having abs(sum(share) - 1) > 0.000001) x', false, true, '')))[1]::text = '0'
             else false end),
  -- 094 GUARANTEE: the backfill kept every contract's delivered total — each load on a contract has exactly
  -- one full-share contract row, and loads.contract_id mirrors the allocation on every load.
  ( 99, '094 backfill matches contract_id',  'loads where contract_id ≠ load_sales_mirror_contract(id) = 0',
        case when exists (select 1 from fns where f = 'load_sales_mirror_contract')
             then (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.loads l where l.contract_id is distinct from public.load_sales_mirror_contract(l.id)', false, true, '')))[1]::text = '0'
             else false end),
  -- 0095 (supabase/migrations/): the undo RPC, the multi-open roll RPC, and the ledger trigger reading
  -- the turnrow.hedge_event_note setting (probed in the trigger's source text).
  (100, '0095_hedge_import_guards',           'fn hedge_undo_import + fn hedge_execute_roll + trigger fn reads turnrow.hedge_event_note',
        exists (select 1 from fns where f = 'hedge_undo_import') and exists (select 1 from fns where f = 'hedge_execute_roll')
        and exists (select 1 from fns where f = 'hedge_position_event_trigger' and pg_get_functiondef(oid) like '%turnrow.hedge_event_note%')),
  -- 0096 (supabase/migrations/): cotton_loads.updated_at, the column the Farm link's cotton fetch asks for.
  (101, '0096_cotton_loads_updated_at',       'cotton_loads.updated_at',
        exists (select 1 from cols where t = 'cotton_loads' and c = 'updated_at')),
  -- 0097 (supabase/migrations/): a contract's quality requirements, one row per cotton sales contract.
  (102, '0097_cotton_contract_specs',         'table cotton_contract_specs + unique (contract_id) + org_isolation policy',
        exists (select 1 from tbls where t = 'cotton_contract_specs')
        and exists (select 1 from cols where t = 'cotton_contract_specs' and c = 'eligible_fsa_farms')
        and exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_org_isolation')),
  -- 0098 (supabase/migrations/): data only — the OBBBA parameters the 2026 election test found stale
  -- (probed on the values it sets: sunflowers a pound commodity at the other-oilseeds reference price,
  -- seed cotton's $0.30 effective-price floor).
  (103, '0098_arc_plc_2026_parameters',       'covered_commodities: Sunflowers unit=pound @ 0.2375, Seed Cotton loan 0.30',
        exists (select 1 from public.covered_commodities where name = 'Sunflowers' and unit = 'pound' and statutory_reference_price = 0.2375)
        and exists (select 1 from public.covered_commodities where name = 'Seed Cotton' and national_loan_rate = 0.30))
)
select status, migration, evidence
from (
  select 0 as ord,
    case
      when bool_and(applied) then '✅ ALL ' || count(*) filter (where applied is not null) || ' verifiable migrations applied — schema is at 098'
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
