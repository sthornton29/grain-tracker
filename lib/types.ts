export type Entity = {
  id: string
  name: string
  notes: string | null
  // Eligible persons for FSA payment limits (entity-level, set once): total
  // ARC/PLC limit = this × the program year's per-person limit.
  payment_limit_persons: number
}
export type Landowner = {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  notes: string | null
  created_at: string
}
export type Farm = {
  id: string
  name: string
  entity_id: string | null
  fsa_number: string | null
  county_id: string | null
  landowner_id: string | null
  is_share_rent: boolean
  landlord_share_percentage: number | null
}
export type Field = {
  id: string
  farm_id: string | null
  name_or_number: string
  total_acres: number | null
  irrigated_acres: number
  dryland_acres: number
  county_id: string | null
}
export type County = {
  id: string
  name: string
  state: string
  state_code: string
}
export type EntityCounty = {
  id: string
  entity_id: string
  county_id: string
}
export type Bin = {
  id: string
  name_or_number: string
  crop_id: string | null
  bin_site_id: string | null
}
export type BinSite = {
  id: string
  name: string
  entity_id: string
  county_id: string | null
  address: string | null
  notes: string | null
}
export type Truck = { id: string; name_or_number: string }
export type Buyer = { id: string; name: string }
export type DeliveryLocation = {
  id: string
  buyer_id: string
  name: string
  address: string | null
}
export type Crop = {
  id: string
  name: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
  // Harvest timing. A field that has a spring-harvest crop that season is
  // double-cropped; the second crop counts as double-crop only when double_crop
  // is set (e.g. soybeans). See buildDoubleCropSet.
  harvest_category: 'fall' | 'spring'
  // Whether this crop is grown as a double-crop (a second crop after a
  // spring-harvest crop). Set per crop under Settings → Crops.
  double_crop: boolean
}

export type BinInventoryAdjustment = {
  id: string
  bin_id: string
  crop_id: string
  adjustment_type: 'beginning_inventory' | 'empty_bin'
  bushels: number
  moisture: number | null
  as_of_date: string
  notes: string | null
  created_at: string
}

export type FieldPlanting = {
  id: string
  field_id: string
  crop_id: string
  season_year: number
  planted_acres: number
  irrigated_acres: number
  dryland_acres: number
  irrigated_bushels: number | null
  dryland_bushels: number | null
  yield_breakout_entered: boolean
  planting_date: string | null
  paired_planting_id: string | null
  notes: string | null
  // Manual override of the yield harvest classification: null = automatic,
  // true = always count this field despite an unharvested/in-progress flag.
  yield_include_override: boolean | null
}

export type FieldPlantingVariety = {
  id: string
  planting_id: string
  variety: string
  acres: number
  bushels: number | null
  created_at: string
}

export type Contract = {
  id: string
  contract_number: string
  buyer_id: string | null
  crop_id: string | null
  entity_id: string | null
  crop_year: number | null
  contracted_bushels: number
  price_per_bushel: number | null
  notes: string | null
  delivery_type: 'pickup' | 'delivered'
  delivery_location_id: string | null
  delivery_start_date: string | null
  delivery_end_date: string | null
  completed_at: string | null
  created_at: string
  // Pricing breakdown (forward / HTA / basis). cash_price is the canonical flat
  // price; price_per_bushel is kept in sync for backward compatibility.
  contract_month: string | null
  contract_type: 'forward' | 'hta' | 'basis'
  futures_price: number | null
  basis: number | null
  cash_price: number | null
  service_fee: number
  futures_set_date: string | null
  basis_set_date: string | null
  pricing_status: 'fully_priced' | 'awaiting_basis' | 'awaiting_futures'
}

export type CropAssumption = {
  id: string
  crop_id: string
  crop_year: number
  expected_yield: number | null
  // Optional production-expectation breakout (bu/ac). Each falls back to
  // expected_yield when null. *_dc_* are the double-crop variants.
  expected_yield_irr: number | null
  expected_yield_dry: number | null
  expected_yield_dc_irr: number | null
  expected_yield_dc_dry: number | null
  harvest_complete: boolean
  // Assumed basis ($/bu) used to value bushels with no locked basis (open HTAs,
  // open hedges, unpriced production) and as the average-basis fallback when no
  // physical contract has set basis. Defaults to 0.
  assumed_basis: number
  // Assumed futures price ($/bu) for the crop's completely-unpriced bushels — the
  // futures half of the What-If, persisted like assumed_basis. null = none set
  // (fall back to the auto-fetched harvest-price estimate).
  assumed_futures: number | null
  // Overall cost/acre (acre-weighted average when the breakout below is used).
  cost_per_acre: number | null
  // Optional cost/acre breakout, mirroring the yield breakout.
  cost_per_acre_irr: number | null
  cost_per_acre_dry: number | null
  cost_per_acre_dc_irr: number | null
  cost_per_acre_dc_dry: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export type Settlement = {
  id: string
  buyer_id: string
  settlement_date: string
  settlement_number: string | null
  notes: string | null
  source_pdf_url: string | null
  created_at: string
}

export type SettlementLine = {
  id: string
  settlement_id: string
  ticket_number: string | null
  load_id: string | null
  net_bushels: number
  gross_revenue: number
  discounts: number
  net_revenue: number
  price_per_bushel: number | null
  notes: string | null
}

export type LoadAttachment = {
  id: string
  load_id: string
  file_url: string
  file_path: string
  file_name: string
  mime_type: string | null
  file_size: number | null
  created_at: string
}

export type ContractAttachment = {
  id: string
  contract_id: string
  file_url: string
  file_path: string
  file_name: string
  mime_type: string | null
  file_size: number | null
  created_at: string
}

export type LoadSplit = {
  id: string
  load_id: string
  field_id: string
  crop_id: string
  net_weight: number
  percentage: number
  wet_bushels: number | null
  dry_bushels: number | null
  notes: string | null
  created_at: string
}

export type CommoditySpec = {
  id: string
  commodity: string
  symbol: string
  exchange: string
  contract_size_bu: number
  tick_size_cents: number
  tick_value_usd: number
  contract_months: string
  created_at: string
}

export type FuturesPosition = {
  id: string
  entity_id: string | null
  commodity: string
  contract_month: string
  contract_symbol: string
  crop_year: number
  side: 'long' | 'short'
  num_contracts: number
  trade_price: number
  trade_date: string
  status: 'open' | 'closed'
  close_price: number | null
  close_date: string | null
  realized_pnl: number | null
  commission: number
  notes: string | null
  source: 'manual' | 'statement_import'
  created_at: string
}

export type MarketPrice = {
  id: string
  contract_symbol: string
  price: number
  price_date: string
  fetched_at: string
}

export type OptionPosition = {
  id: string
  entity_id: string | null
  commodity: string
  option_type: 'call' | 'put'
  side: 'buy' | 'sell'
  underlying_contract_month: string
  underlying_symbol: string
  strike_price: number
  num_contracts: number
  premium_cents: number
  premium_total: number
  trade_date: string
  expiration_date: string | null
  crop_year: number
  status: 'open' | 'closed_offset' | 'expired_worthless' | 'exercised'
  close_price_cents: number | null
  close_date: string | null
  realized_pnl: number | null
  commission: number
  manual_current_value_cents: number | null
  exercised_position_id: string | null
  notes: string | null
  source: 'manual' | 'statement_import'
  created_at: string
}

export type CropInsurancePolicy = {
  id: string
  entity_id: string | null
  crop_id: string
  crop_year: number
  county_id: string | null
  policy_number: string | null
  plan_type: 'RP' | 'RP_HPE' | 'YP'
  // Irrigated vs dryland. The same crop in a county/year can carry one policy of
  // each practice, with its own APH, coverage, insured acres, and premium.
  practice: 'irrigated' | 'non_irrigated'
  coverage_level: number
  unit_structure: 'enterprise' | 'basic' | 'optional'
  aph_yield: number
  projected_price: number
  harvest_price: number | null
  volatility_factor: number | null
  insured_acres: number
  premium_per_acre: number | null
  total_premium: number | null
  premium_subsidy_pct: number | null
  notes: string | null
  // Operator attestation that this policy covers all planted acres for its
  // entity × crop × county × crop_year × practice, even when insured acres
  // differ from planted acres. Suppresses the Coverage Check's acre-mismatch
  // flag for that combination (never the "no policy" flag). coverage_note holds
  // the justification (e.g. "confirmed with agent 6/2026").
  covers_all_planted_acres: boolean
  coverage_note: string | null
  source: 'manual' | 'document_import'
  created_at: string
}

export type CropInsuranceSco = {
  id: string
  policy_id: string
  coverage_trigger: number
  expected_county_yield: number
  county_yield_assumption_pct: number | null
  premium_per_acre: number | null
  total_premium: number | null
  notes: string | null
  created_at: string
}

export type CropInsuranceEco = {
  id: string
  policy_id: string
  eco_trigger_level: number
  expected_county_yield: number
  county_yield_assumption_pct: number | null
  premium_per_acre: number | null
  total_premium: number | null
  notes: string | null
  created_at: string
}

export type HarvestPriceEstimate = {
  id: string
  crop_id: string
  crop_year: number
  price_type: 'projected' | 'harvest_final' | 'harvest_estimate'
  price: number
  source: string | null
  price_date: string
  created_at: string
}

export type CoveredCommodity = {
  id: string
  name: string
  crop_id: string | null
  statutory_reference_price: number
  unit: 'bushel' | 'pound'
  national_loan_rate: number
  marketing_year_start_month: number
  marketing_year_end_month: number
  // MYA blend-estimate defaults: the futures→farm-price adjustment (negative =
  // farm price under futures) and the 12 monthly marketing weights aligned to
  // the marketing year. null = built-in defaults in lib/mya-estimate.ts.
  mya_basis_adj: number | null
  mya_month_weights: number[] | null
  // Seed cotton only: lint/cottonseed weight shares for blending the NASS
  // lint (¢/lb) + cottonseed ($/ton) series into one seed cotton price.
  // null = the standard 43/57 defaults in lib/government-payments.ts.
  lint_share: number | null
  cottonseed_share: number | null
  created_at: string
}

// FSA-published ARC-CO benchmark data per commodity × crop year, optionally per
// county (county null = the default row used when no county-specific one
// exists). county_yield_vs_benchmark_pct persists the operator's mid-season
// expectation of actual county yield vs benchmark (−30..+30; 0 = at benchmark).
export type ArcBenchmarkData = {
  id: string
  commodity_id: string
  crop_year: number
  // Display name; county_id (→ counties, which carries the state) is the key.
  // Both null = the all-counties default row. county set with county_id null =
  // a legacy row whose name was ambiguous across states at backfill time.
  county: string | null
  county_id: string | null
  benchmark_price: number | null
  benchmark_yield: number | null
  price_source: 'usda' | 'manual' | 'ai'
  yield_source: 'usda' | 'manual' | 'ai'
  county_yield_vs_benchmark_pct: number
  source_description: string | null
  created_at: string
  updated_at: string
}

// USDA/NASS monthly national average farm price, entered as published through
// the marketing year. month is the CALENDAR month; crop_year labels the
// marketing year (2026 corn = Sep 2026 – Aug 2027).
export type MyaMonthlyPrice = {
  id: string
  commodity_id: string
  crop_year: number
  month: number
  price: number
  // 'usda' = confirmed from the NASS Quick Stats lookup (real published
  // data); 'ai' = confirmed from the AI web-search fallback; 'manual' =
  // operator-typed (or a fetched value the operator edited before confirming).
  source: 'usda' | 'manual' | 'ai'
  // Component provenance for derived prices (seed cotton:
  // "lint 68.2¢ + seed $205/ton → 35.17¢ SC"). Display-only.
  note: string | null
  created_at: string
  updated_at: string
}

export type FarmBaseAcres = {
  id: string
  farm_id: string
  // Null for generic/unassigned base that isn't tied to a commodity yet.
  commodity_id: string | null
  base_acres: number
  plc_yield: number
  // Unassigned (generic) base is retained on the farm but not ARC/PLC-eligible.
  is_unassigned: boolean
  source: 'manual' | 'document_import'
  notes: string | null
  created_at: string
  updated_at: string
}

export type ArcPlcElectionType = 'PLC' | 'ARC_CO' | 'ARC_IC'

export type ArcPlcElection = {
  id: string
  farm_id: string
  commodity_id: string
  crop_year: number
  election: ArcPlcElectionType
  created_at: string
}

export type ArcPlcPriceData = {
  id: string
  commodity_id: string
  crop_year: number
  effective_reference_price: number | null
  mya_price_estimate: number | null
  mya_price_final: number | null
  // WASDE season-average price forecast midpoint. When set it overrides the
  // blended estimate inside the estimate tier (final/manual still outrank it).
  wasde_midpoint: number | null
  // How the current MYA input was derived (e.g. the seed-cotton lint+seed
  // composition) — display-only.
  mya_note: string | null
  source: 'manual' | 'barchart' | 'usda' | 'wasde'
  updated_at: string
}

export type ArcPlcPayment = {
  id: string
  farm_id: string
  commodity_id: string
  // PROGRAM year — drives the math (MYA, benchmarks, elections, limits).
  crop_year: number
  // Generated in the DB as crop_year + 1: the crop year the payment actually
  // arrives in (October of program year + 1) — drives revenue attribution.
  revenue_crop_year: number
  election: ArcPlcElectionType
  base_acres: number
  plc_yield: number
  payment_rate_per_unit: number
  gross_payment: number
  payment_factor: number
  sequestration_pct: number
  net_payment: number
  payment_status: 'projected' | 'confirmed' | 'received'
  expected_payment_date: string | null
  actual_payment_date: string | null
  actual_payment_amount: number | null
  notes: string | null
  created_at: string
}

export type OtherGovernmentPayment = {
  id: string
  entity_id: string | null
  program_name: string
  // The crop year the payment is received in / attributed to (payment year,
  // NOT a program year). Attribution prefers payment_date's year when set —
  // see paymentAttributionYear in lib/government-payments.ts.
  crop_year: number
  crop_id: string | null
  farm_id: string | null
  amount: number
  payment_date: string | null
  payment_status: 'projected' | 'confirmed' | 'received'
  notes: string | null
  created_at: string
}

// payment_limit_config is deprecated (041): eligible persons live on
// entities.payment_limit_persons; the per-person limit is per program year
// in program_year_config.

// Per-crop-year program parameters that used to be hard-coded constants. Edited
// under Settings → Government Payments; resolved (with most-recent-year
// fallback) by lib/program-config.ts.
export type ProgramYearConfig = {
  id: string
  crop_year: number
  sco_trigger: number
  per_person_payment_limit: number
  sequestration_pct: number
  // OBBBA parameters (migration 037): ARC guarantee % (0.90 for 2025+), ARC
  // payment cap % (0.12), ERP Olympic factor (0.88) and cap (1.15), and the
  // base-acre payment factors (0.85 ARC-CO/PLC, 0.65 ARC-IC).
  arc_guarantee_pct: number
  arc_payment_cap_pct: number
  erp_olympic_factor: number
  erp_cap_pct: number
  payment_factor: number
  arc_ic_payment_factor: number
  notes: string | null
  created_at: string
  updated_at: string
}

export type Load = {
  id: string
  date: string
  time: string | null
  truck_id: string | null
  crop_id: string | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null
  moisture: number | null
  test_weight: number | null
  bushels: number | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: 'field' | 'bin' | null
  from_field_id: string | null
  from_bin_id: string | null
  to_type: 'bin' | 'buyer' | null
  to_bin_id: string | null
  to_buyer_id: string | null
  contract_id: string | null
  ticket_number: string | null
  source_pdf_url: string | null
  created_at: string
  updated_at: string
}
