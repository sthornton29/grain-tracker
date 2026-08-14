// Compact schema summary for the data assistant's query_data tool — the
// TENANT tables only (shared reference tables like counties and market
// prices included where useful for joins). Hand-curated: enough for the
// model to write sensible SELECTs; wrong guesses come back as SQL errors it
// can correct. Isolation note: every query runs as the user via RLS — this
// text is documentation, not a security boundary.

export const ASSISTANT_SCHEMA_SUMMARY = `
Your account's PostgreSQL tables (query with query_data; you only ever see this account's rows):

ORGANIZATION & LAND
- entities(id, name, entity_role 'farming'|'marketing_agent', payment_limit_persons)
- landowners(id, name, phone, email, address, notes)
- farms(id, name, entity_id→entities, fsa_number, county_id→counties, landowner_id→landowners, is_share_rent bool, landlord_share_percentage 0-100, cash_rent_per_acre)
- fields(id, farm_id→farms, name_or_number, total_acres, irrigated_acres, dryland_acres, county_id)
- counties(id, name, state_code)  -- shared US reference

CROPS & PLANTING
- crops(id, name, base_moisture_pct, base_lb_per_bushel, harvest_category 'fall'|'spring', double_crop bool)
- field_plantings(id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres, planting_date, notes)
- field_planting_varieties(id, planting_id, variety, acres, bushels)
- crop_assumptions(id, crop_id, crop_year, expected_yield, cost_per_acre, assumed_basis, assumed_futures, harvest_complete bool, ...)
- combine_yield_entries(id, field_id, crop_id, crop_year, entry_mode, stated_total_bushels, adjusted_total_bushels, destination_bin_id, harvest_complete, entry_date)

GRAIN FLOW
- loads(id, date, time, truck_id→trucks, hauler_truck text, crop_id, crop_year, gross_weight lb, tare_weight lb, net_weight lb, moisture pct, test_weight, dry_bushels_override, from_type 'field'|'bin', from_field_id, from_bin_id, to_type 'bin'|'buyer', to_bin_id, to_buyer_id, contract_id, ticket_number, practice 'irrigated'|'dryland')
  NOTE: weights are POUNDS; dry bushels are derived (shrink math) — prefer get_loads/get_yields for bushels.
- load_splits(id, load_id, field_id, crop_id, net_weight, dry_bushels, percentage, practice)
- trucks(id, name_or_number) ; external_trucks(id, name, buyer_id)  -- hauler trucks from pickup loads
- contracts(id, contract_number, buyer_id, crop_id, entity_id, crop_year, contracted_bushels, price_per_bushel, cash_price, futures_price, basis, contract_type 'forward'|'hta'|'basis', contract_month, pricing_status, delivery_type 'pickup'|'delivered', delivery_location_id, delivery_start_date, delivery_end_date, date_sold, completed_at, notes)
- buyers(id, name) ; delivery_locations(id, buyer_id, name, address)
- settlements(id, buyer_id, settlement_date, settlement_number)  -- crop year comes through the lines' loads
- settlement_lines(id, settlement_id, load_id, ticket_number, net_bushels, gross_revenue, discounts, net_revenue GENERATED, price_per_bushel GENERATED)

STORAGE
- bin_sites(id, name, entity_id) ; bins(id, name_or_number, bin_site_id, crop_id, capacity_bushels)
- bin_inventory_adjustments(id, bin_id, crop_id, adjustment_type, bushels, as_of_date)
- bin_transfers(id, from_bin_id, to_bin_id, crop_id, bushels dry, transfer_date)

MARKETING & HEDGING
- futures_positions(id, entity_id, commodity, contract_month, contract_symbol, side 'long'|'short', num_contracts, trade_price, trade_date, crop_year, close_price, close_trade_date, realized_pnl, commission, closed_at)
- options_positions(id, entity_id, commodity, option_type 'put'|'call', side, num_contracts, strike_price, premium_cents, trade_date, crop_year, realized_pnl, closed_at)
- market_prices(contract_symbol, price $/bu, price_date)  -- shared cached quotes

INSURANCE & GOVERNMENT
- crop_insurance_policies(id, entity_id, crop_id, county_id, crop_year, plan_type 'RP'|'RP_HPE'|'YP'|'ARP'|'AYP', practice, coverage_level, aph_yield, projected_price, harvest_price, insured_acres, premium_per_acre, total_premium, policy_number)
- crop_insurance_sco / crop_insurance_eco / crop_insurance_stax / crop_insurance_mco (policy_id, band parameters, premiums)
- harvest_price_estimates(crop_id, crop_year, price_type, price, price_date, source)
- farm_base_acres(farm_id, commodity_id, base_acres, plc_yield) ; arc_plc_elections(farm_id, commodity_id, election)
- arc_plc_payments(farm_id, commodity_id, crop_year program year, amount, revenue_crop_year GENERATED)
- other_government_payments(id, entity_id, farm_id, crop_id, crop_year payment year, program, amount, payment_date)
- covered_commodities(id, name, reference_price, ...)  -- shared reference

COTTON (when the module is on)
- cotton_loads(id, load_number, crop_year, farm_id, field_id, picked_date, delivered_date, truck text, gross_weight, tare_weight, net_weight)
- gin_receipts(id, gin_id, receipt_number, receipt_date, crop_year, entity_id, farm_id, field_id, bales_count, total_bale_weight, ...)
- cotton_bales(id, gin_receipt_id, pbi_number, crop_year, net_weight_lbs) ; cotton_bale_grades(bale HVI grades + loan value)
- cotton_sales_contracts / cotton_pool_payments / ccc_loans / cotton_ldp_records / cotton_bale_dispositions / cotton_fees
  NOTE: cotton prices are stored in CENTS per lb.

Conventions: crop years are harvest years; season_year on plantings is the crop year. Money is USD. Acres/bushels are numerics. Text matches are case-sensitive in SQL — use ilike for names.`
