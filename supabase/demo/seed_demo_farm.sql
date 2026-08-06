-- DEMO DATA SEED — NOT A MIGRATION. Populates one org with a season of
-- realistic-looking (entirely fictional) farm data so demos don't start from
-- a blank slate: 2 entities, 3 farms, 7 fields, 2026 plantings (irrigated
-- corn, soybeans, spring-harvest wheat), ~140 harvest loads, grain contracts,
-- a couple of corn hedges, bins with some stored grain, and marketing
-- assumptions — enough for Loads, Yields, Inventory, Contracts, Marketing,
-- and Revenue Projections to look alive.
--
-- TARGET: the org slug in `target_slug` below (default: beta-test-farm —
-- edit it to aim at another DEMO org). Re-runnable: it WIPES that org's
-- operational data first, so it always seeds fresh. It REFUSES to run
-- against 'turnrow-farm', and every insert stamps org_id explicitly (an
-- admin session's default would otherwise stamp the Turnrow shim).

do $$
declare
  target_slug constant text := 'beta-test-farm';   -- <— EDIT to retarget (never turnrow-farm)
  org uuid;
  e_prairie uuid; e_riverbend uuid;
  farm_home uuid; farm_north uuid; farm_river uuid;
  c_corn uuid; c_soy uuid; c_wheat uuid;
  by_plains uuid; by_valley uuid;
  tr1 uuid; tr2 uuid;
  bin1 uuid; bin2 uuid;
  ct_corn uuid; ct_soy uuid;
  f_homeq uuid; f_east uuid; f_shop uuid; f_circle uuid; f_ndry uuid; f_bottom uuid; f_bluff uuid;
begin
  if target_slug = 'turnrow-farm' then raise exception 'refusing to seed demo data into the Turnrow org'; end if;
  select id into org from public.organizations where slug = target_slug;
  if org is null then raise exception 'no organization with slug %', target_slug; end if;

  -- ---- Wipe the org's operational rows (FK-safe order); keep crops/settings/users.
  delete from public.load_splits where org_id = org;
  delete from public.loads where org_id = org;
  delete from public.contracts where org_id = org;
  delete from public.futures_positions where org_id = org;
  delete from public.options_positions where org_id = org;
  delete from public.crop_assumptions where org_id = org;
  delete from public.county_yield_assumptions where org_id = org;
  delete from public.crop_year_sales_status where org_id = org;
  delete from public.field_planting_varieties where org_id = org;
  delete from public.field_plantings where org_id = org;
  delete from public.bin_inventory_adjustments where org_id = org;
  delete from public.bin_transfers where org_id = org;
  delete from public.settlement_lines where org_id = org;
  delete from public.settlements where org_id = org;
  delete from public.user_entity_access where org_id = org;
  delete from public.fields where org_id = org;
  delete from public.farms where org_id = org;
  delete from public.bins where org_id = org;
  delete from public.bin_sites where org_id = org;
  delete from public.trucks where org_id = org;
  delete from public.buyers where org_id = org;
  delete from public.entity_counties where org_id = org;
  delete from public.entities where org_id = org;

  -- ---- The org's seeded crops (056 seeding).
  select id into c_corn  from public.crops where org_id = org and name = 'Corn';
  select id into c_soy   from public.crops where org_id = org and name = 'Soybean';
  select id into c_wheat from public.crops where org_id = org and name = 'Wheat';
  if c_corn is null or c_soy is null or c_wheat is null then
    raise exception 'org % is missing the seeded crops — run seed_org_defaults/admin_create_org first', target_slug;
  end if;

  -- ---- Structure: entities, farms, fields.
  insert into public.entities (name, notes, org_id) values ('Prairie Creek Farms LLC', 'Demo entity', org) returning id into e_prairie;
  insert into public.entities (name, notes, org_id) values ('Riverbend Ag LLC', 'Demo entity', org) returning id into e_riverbend;

  insert into public.farms (name, entity_id, org_id) values ('Home Place', e_prairie, org) returning id into farm_home;
  insert into public.farms (name, entity_id, org_id) values ('North 480', e_prairie, org) returning id into farm_north;
  insert into public.farms (name, entity_id, org_id) values ('River Farm', e_riverbend, org) returning id into farm_river;

  insert into public.fields (farm_id, name_or_number, total_acres, org_id) values (farm_home, 'Home Quarter', 160, org) returning id into f_homeq;
  insert into public.fields (farm_id, name_or_number, total_acres, org_id) values (farm_home, 'East 160', 160, org) returning id into f_east;
  insert into public.fields (farm_id, name_or_number, total_acres, org_id) values (farm_home, 'Shop 80', 80, org) returning id into f_shop;
  insert into public.fields (farm_id, name_or_number, total_acres, org_id) values (farm_north, 'North Circle', 120, org) returning id into f_circle;
  insert into public.fields (farm_id, name_or_number, total_acres, org_id) values (farm_north, 'North Dry 240', 240, org) returning id into f_ndry;
  insert into public.fields (farm_id, name_or_number, total_acres, org_id) values (farm_river, 'River Bottom', 200, org) returning id into f_bottom;
  insert into public.fields (farm_id, name_or_number, total_acres, org_id) values (farm_river, 'Bluff 120', 120, org) returning id into f_bluff;

  -- ---- 2026 plantings (dryland_acres maintained by trigger).
  insert into public.field_plantings (field_id, crop_id, season_year, planted_acres, irrigated_acres, org_id) values
    (f_homeq,  c_corn,  2026, 160, 160, org),
    (f_east,   c_corn,  2026, 160, 160, org),
    (f_circle, c_corn,  2026, 120, 120, org),
    (f_shop,   c_soy,   2026,  80,   0, org),
    (f_bottom, c_soy,   2026, 200, 200, org),
    (f_ndry,   c_wheat, 2026, 240,   0, org),
    (f_bluff,  c_wheat, 2026, 120,   0, org);

  -- ---- Trade partners & equipment.
  insert into public.buyers (name, org_id) values ('Plains Grain Co-op', org) returning id into by_plains;
  insert into public.buyers (name, org_id) values ('Valley Elevator', org) returning id into by_valley;
  insert into public.trucks (name_or_number, org_id) values ('Kenworth 1', org) returning id into tr1;
  insert into public.trucks (name_or_number, org_id) values ('Pete 389', org) returning id into tr2;
  insert into public.bins (name_or_number, org_id) values ('Bin 1 — Home Place', org) returning id into bin1;
  insert into public.bins (name_or_number, org_id) values ('Bin 2 — Home Place', org) returning id into bin2;

  -- ---- Contracts (forward cash sales).
  insert into public.contracts (contract_number, buyer_id, crop_id, crop_year, contracted_bushels, price_per_bushel, cash_price, entity_id, org_id)
  values ('PG-2026-114', by_plains, c_corn, 2026, 30000, 4.6500, 4.6500, null, org) returning id into ct_corn;
  insert into public.contracts (contract_number, buyer_id, crop_id, crop_year, contracted_bushels, price_per_bushel, cash_price, entity_id, org_id)
  values ('VE-2026-2088', by_valley, c_soy, 2026, 10000, 10.1500, 10.1500, null, org) returning id into ct_soy;

  -- ---- Harvest loads. Weights/moisture vary per load; the app derives dry
  --      bushels. Wheat cuts in June (spring-harvest), corn Sep, beans Oct.
  -- Corn: 95 field→buyer/bin loads across the three irrigated fields (~200 bu/ac).
  insert into public.loads (date, truck_id, crop_id, crop_year, net_weight, moisture, from_type, from_field_id, to_type, to_buyer_id, to_bin_id, contract_id, ticket_number, org_id)
  select date '2026-09-08' + (i / 5),
         case when i % 2 = 0 then tr1 else tr2 end,
         c_corn, 2026,
         52200 + (i * 137) % 3600,
         15.0 + ((i * 7) % 28) / 10.0,
         'field',
         case when i < 35 then f_homeq when i < 69 then f_east else f_circle end,
         case when i % 12 = 11 then 'bin' else 'buyer' end,
         case when i % 12 = 11 then null when i < 60 then by_plains else by_valley end,
         case when i % 12 = 11 then bin1 else null end,
         case when i < 32 then ct_corn else null end,
         'CT-' || (2600 + i), org
  from generate_series(0, 94) as g(i);
  -- Soybeans: 17 loads (~55 bu/ac).
  insert into public.loads (date, truck_id, crop_id, crop_year, net_weight, moisture, from_type, from_field_id, to_type, to_buyer_id, contract_id, ticket_number, org_id)
  select date '2026-10-06' + (i / 3),
         case when i % 2 = 0 then tr2 else tr1 end,
         c_soy, 2026,
         50800 + (i * 211) % 3400,
         11.2 + ((i * 5) % 18) / 10.0,
         'field',
         case when i < 5 then f_shop else f_bottom end,
         'buyer', by_valley,
         case when i % 3 <> 2 then ct_soy else null end,
         'SB-' || (3100 + i), org
  from generate_series(0, 16) as g(i);
  -- Wheat: 25 loads in June (~58 bu/ac).
  insert into public.loads (date, truck_id, crop_id, crop_year, net_weight, moisture, from_type, from_field_id, to_type, to_buyer_id, ticket_number, org_id)
  select date '2026-06-09' + (i / 4),
         case when i % 2 = 0 then tr1 else tr2 end,
         c_wheat, 2026,
         49600 + (i * 173) % 3000,
         11.8 + ((i * 3) % 16) / 10.0,
         'field',
         case when i < 17 then f_ndry else f_bluff end,
         'buyer', by_plains,
         'WH-' || (1800 + i), org
  from generate_series(0, 24) as g(i);

  -- ---- Marketing assumptions (yields, costs, standing basis).
  insert into public.crop_assumptions (crop_id, crop_year, expected_yield, expected_yield_irr, cost_per_acre, assumed_basis, org_id) values
    (c_corn,  2026, 205, 210, 785, -0.35, org),
    (c_soy,   2026,  55,  58, 415, -0.60, org),
    (c_wheat, 2026,  58, null, 305, -0.40, org);

  -- ---- Corn hedges: one closed with realized gain, one still open.
  insert into public.futures_positions (entity_id, commodity, contract_month, contract_symbol, crop_year, side, num_contracts, trade_price, trade_date, status, close_price, close_date, realized_pnl, commission, org_id) values
    (null, 'Corn', 'DEC 26', 'ZCZ26', 2026, 'short', 2, 4.9125, '2026-04-14', 'closed', 4.6050, '2026-09-22', 3035.00, 40.00, org),
    (null, 'Corn', 'DEC 26', 'ZCZ26', 2026, 'short', 3, 4.7250, '2026-06-02', 'open', null, null, null, 60.00, org);

  raise notice 'Demo farm seeded into "%": 2 entities, 3 farms, 7 fields, 137 loads, 2 contracts, 2 hedges.', target_slug;
end $$;
