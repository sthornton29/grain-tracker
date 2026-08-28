export type Entity = {
  id: string
  name: string
  notes: string | null
  // Eligible persons for FSA payment limits (entity-level, set once): total
  // ARC/PLC limit = this × the program year's per-person limit.
  payment_limit_persons: number
  // 051: 'farming' (default) operates farms and keeps its own-name marketing;
  // 'marketing_agent' markets on behalf of the farming
  // entities — its contracts/hedges flow down pro-rata by acre share in the
  // entity-filtered reports. Optional so code degrades before the migration.
  entity_role?: 'farming' | 'marketing_agent' | null
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
  /** Cash rent $/acre (063) — the minimal lease term on the farm linkage. */
  cash_rent_per_acre: number | null
}

// ---------- Rent settlement (069) ----------

// A structured lease per landowner × farm set — AI-extracted from an uploaded
// lease or entered by hand. The jsonb columns carry the typed shapes in
// lib/rent-settlement.ts (parseLeaseTerms tolerates partial extractions).
export type LeaseTerm = {
  id: string
  landowner_id: string
  /** Farms covered; empty = every farm linked to the landowner. */
  farm_ids: string[]
  lease_type: 'crop_share' | 'cash' | 'flex'
  share_terms: unknown
  expense_terms: unknown
  pricing_method: unknown
  cash_terms: unknown
  flex_terms: unknown
  payment_timing: string | null
  notes: string | null
  source_file_url: string | null
  source_file_path: string | null
  source_file_name: string | null
  created_at: string
  updated_at: string
}

// A generated landowner settlement (069) — the full itemized statement
// snapshot (lib/rent-settlement.ts SettlementStatement); regenerable.
export type RentSettlement = {
  id: string
  landowner_id: string
  lease_term_id: string | null
  crop_year: number
  statement: unknown
  total_due: number | null
  generated_at: string
  created_at: string
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
  capacity_bushels: number | null
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
// A hauler's truck saved from a pickup-contract load (067) — org-scoped,
// kept strictly separate from the operation's own trucks. buyer_id is the
// pickup contract's buyer at save time (null = independent hauler).
export type ExternalTruck = {
  id: string
  name: string
  buyer_id: string | null
  created_at: string
}
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
  // Combine-entry calibration default (062): the last-used ± bu/ac adjustment
  // for this crop, pre-filling subsequent Yield from Combine entries until
  // changed. Null = no default.
  combine_adjustment_bu_per_acre: number | null
  // RMA insurance-type override (066) for dual-offer states (Idaho-style
  // Winter+Spring wheat). Null = Auto: harvest_category decides.
  rma_type_override: 'winter' | 'spring' | 'durum' | null
}

// ---------- Combine yield entries (062) ----------

// A field × crop × crop-year's production as stated by the combine monitor
// (dry basis) — the scale-less harvest entry path. adjusted_total_bushels is
// THE number the app uses; lib/yields.ts nets weighed loads out of it
// dynamically and posts the remainder to destination_bin_id when set.
export type CombineYieldEntry = {
  id: string
  field_id: string
  crop_id: string
  crop_year: number
  entry_mode: 'total_bushels' | 'yield_per_acre'
  stated_yield_per_acre: number | null
  stated_total_bushels: number
  adjustment_bu_per_acre: number | null
  adjusted_total_bushels: number
  /** Optional irr/dry sub-entry for mixed-practice fields; written through to
   *  the planting's manual breakout on save. Null = single combined figure. */
  stated_irrigated_bushels: number | null
  stated_dryland_bushels: number | null
  destination_bin_id: string | null
  harvest_complete: boolean
  entry_date: string
  notes: string | null
  source: 'manual'
  created_at: string
  updated_at: string
}

export type BinTransfer = {
  id: string
  from_bin_id: string
  to_bin_id: string
  crop_id: string
  bushels: number
  transfer_date: string
  method: 'entered' | 'estimated'
  throughput_bu_per_hr: number | null
  hours_run: number | null
  notes: string | null
  created_at: string
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

// A "different varieties — keep both" decision on a suspected-duplicate pair of
// variety spellings (043). key_a/key_b are varietyKey-normalized, sorted
// (key_a <= key_b) — see lib/variety-resolution.ts dismissalKey.
export type VarietyMatchDismissal = {
  id: string
  crop_id: string
  key_a: string
  key_b: string
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
  /** Optional: the date the contract was sold/signed (057) — informational,
   *  distinct from the delivery window and completed_at. */
  date_sold: string | null
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
  // Contract-month label ('SEP 26') pinning the marketing reference contract
  // for this crop × year. null = automatic (the new-crop benchmark, rolled
  // forward past expiry — lib/reference-contract.ts). 059.
  reference_contract_month: string | null
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

// An itemized discount/deduction line on a settlement (074). Amounts are
// positive dollars deducted; the settlement_lines.discounts totals stay
// authoritative (items are the breakdown, sum-checked in the UI).
export type SettlementDiscountItem = {
  id: string
  settlement_id: string
  category: string
  description: string | null
  amount: number
  rate_note: string | null
  quantity_basis: string | null
  /** 075: 'price' (dollars off the check) vs 'weight' (an itemized volume
   *  deduction — categorizes the shrink-gap, never summed as dollars). */
  deduction_kind: 'price' | 'weight'
  created_at: string
}

// A buyer's posted discount sheet for one crop, from an effective date (074).
export type BuyerDiscountSchedule = {
  id: string
  buyer_id: string
  crop_id: string
  effective_date: string
  schedule_text: string | null
  source_pdf_url: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

// One quality-factor rule of a schedule; tiers is the jsonb bracket table
// (lib/discount-schedules.ts parses/applies it).
export type BuyerDiscountScheduleRule = {
  id: string
  schedule_id: string
  factor: string
  basis: string
  base_value: number | null
  direction: 'above' | 'below'
  rate_per_unit: number | null
  tiers: unknown
  cumulative: boolean
  rejection_at: number | null
  note: string | null
  created_at: string
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
  /** Irrigated/dryland designation for this portion (060). Null = undesignated;
   *  only meaningful for mixed-practice fields. */
  practice: 'irrigated' | 'dryland' | null
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
  // RP/RP_HPE/YP are individual (farm-yield) plans; ARP/AYP (045) are AREA
  // plans — county-triggered, the farm's own yield plays no role.
  plan_type: 'RP' | 'RP_HPE' | 'YP' | 'ARP' | 'AYP'
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
  // Area-plan fields (045): RMA expected county yield/revenue as printed on
  // the policy, and the ARP/AYP protection factor (0.8–1.2).
  expected_county_yield: number | null
  expected_county_revenue: number | null
  protection_factor: number | null
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
  /** Snapshot of the own truck's name at save time (071) — display prefers it
   *  over the live FK name, so renaming a truck never rewrites past loads.
   *  Null on pre-071 rows written since the backfill (display falls back). */
  truck_label: string | null
  /** Hauler's truck written on a pickup-contract load (067), free text — kept
   *  as entered even if the saved external truck is later renamed/deleted.
   *  Own trucks use truck_id; a load normally carries one or the other. */
  hauler_truck: string | null
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
  /** Irrigated/dryland designation (060). Null = undesignated; only meaningful
   *  for mixed-practice fields — pure fields imply it from the planting. */
  practice: 'irrigated' | 'dryland' | null
  created_at: string
  updated_at: string
}

// ---------- Cotton module (042) ----------

export type AppSettings = { id: number; cotton_module_enabled: boolean; updated_at: string }
export type AppRole = 'owner' | 'gin' | 'viewer' | 'agronomist'

// ---------- Viewer role (052) ----------

// A viewer's entity grant — the entities a read-only stakeholder may see.
export type UserEntityAccess = { id: string; user_id: string; entity_id: string; created_at: string }

// A viewer's private assumption override: shadows ONE column of ONE row of
// crop_assumptions (scope 'crop') or county_yield_assumptions (scope
// 'county'). base_updated_at snapshots the base row's updated_at at save
// time — the override applies only while they still match, so any admin edit
// supersedes it automatically (lib/viewer-assumptions.ts).
export type ViewerAssumptionOverride = {
  id: string
  user_id: string
  scope: 'crop' | 'county'
  crop_id: string
  crop_year: number
  county_id: string | null // county scope only; null = the crop's default row
  field: string
  value: unknown // jsonb: number, or null to override a field to "unset"
  base_updated_at: string
  created_at: string
  updated_at: string
}

export type Gin = { id: string; name: string; address: string | null; phone: string | null; notes: string | null }

// Seed cotton module/weight ticket — yard inventory until it appears on a
// gin receipt. Weights in lbs (no moisture/shrink math).
export type CottonLoad = {
  id: string
  load_number: string
  entity_id: string | null
  farm_id: string | null
  field_id: string | null
  crop_year: number
  picked_date: string | null
  delivered_date: string | null
  truck: string | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null // lbs seed cotton
  gin_id: string | null
  location: string | null
  notes: string | null
  source: 'manual' | 'document_import'
  source_pdf_url: string | null
  created_at: string
}

export type GinReceipt = {
  id: string
  gin_id: string | null
  receipt_number: string
  receipt_date: string | null
  entity_id: string | null
  farm_id: string | null
  field_id: string | null
  crop_year: number
  modules_count: number | null
  total_seed_cotton_weight: number | null // lbs
  bales_count: number | null
  total_bale_weight: number | null // lbs lint
  avg_bale_weight: number | null
  seed_lbs: number | null // cottonseed produced
  lint_turnout_pct: number | null
  lint_lbs_per_bale: number | null
  notes: string | null
  source: 'manual' | 'document_import'
  source_pdf_url: string | null
  created_at: string
}

export type GinReceiptLoad = { id: string; receipt_id: string; cotton_load_id: string }

export type CottonBale = {
  id: string
  gin_receipt_id: string
  crop_year: number
  pbi_number: string
  net_weight_lbs: number
  created_at: string
}

export type CottonBaleGrade = {
  id: string
  bale_id: string
  class_date: string | null
  color_grade: string | null
  leaf_grade: string | null
  staple_32nds: number | null
  micronaire: number | null
  strength_g_tex: number | null
  composite_grade: string | null
  rd: number | null
  plus_b: number | null
  trash_pct: number | null
  uniformity_pct: number | null
  length_100ths: number | null
  extraneous: string | null
  remarks: string | null
  loan_value_total: number | null
  loan_value_cents_per_lb: number | null
  source: 'csv_import' | 'manual'
  created_at: string
}

// ---------- Physical cotton marketing (044) ----------
// All *_cents fields are ¢/lb (55.00 = 55¢); all totals/amounts are dollars.

export type CottonContractType = 'spot' | 'fixed_price' | 'on_call' | 'pool'
export type CottonPricingStatus = 'fully_priced' | 'awaiting_futures' | 'pool_open'

export type CottonSalesContract = {
  id: string
  entity_id: string | null
  crop_year: number
  buyer_id: string | null
  contract_type: CottonContractType
  contract_number: string | null
  contract_date: string | null
  commitment_basis: 'bales' | 'acres'
  committed_bales: number | null
  committed_acres: number | null
  price_cents_per_lb: number | null
  basis_cents: number | null
  futures_month: string | null
  futures_fixed_cents: number | null
  futures_fixed_date: string | null
  pricing_status: CottonPricingStatus
  delivery_start: string | null
  delivery_end: string | null
  notes: string | null
  created_at: string
}

export type CottonPoolPayment = {
  id: string
  contract_id: string
  payment_type: 'initial_advance' | 'progress' | 'final_settlement'
  amount: number
  cents_per_lb_equivalent: number | null
  payment_date: string | null
  status: 'projected' | 'received'
  notes: string | null
  created_at: string
}

export type CccLoanStatus = 'open' | 'redeemed' | 'equity_sold' | 'forfeited'

export type CccLoan = {
  id: string
  entity_id: string | null
  crop_year: number
  loan_number: string | null
  entry_date: string
  maturity_date: string | null
  loan_rate_base_cents: number
  principal_total: number
  pending_classing: boolean
  status: CccLoanStatus
  outcome_date: string | null
  awp_at_outcome_cents: number | null
  redemption_payoff_total: number | null
  equity_cents_per_lb: number | null
  equity_total: number | null
  mlg_total: number | null
  interest_paid: number | null
  storage_charges_paid: number | null
  buyer_id: string | null
  notes: string | null
  created_at: string
}

export type CccLoanBale = {
  id: string
  loan_id: string
  bale_id: string
  created_at: string
}

export type CottonLdpRecord = {
  id: string
  entity_id: string | null
  crop_year: number
  ldp_date: string
  awp_cents: number
  ldp_rate_cents: number
  total_payment: number
  status: 'projected' | 'received'
  notes: string | null
  created_at: string
}

export type CottonLdpBale = {
  id: string
  ldp_id: string
  bale_id: string
  created_at: string
}

export type CottonDisposition = 'sold_spot' | 'contract_delivery' | 'pool' | 'ccc_loan' | 'held'

export type CottonBaleDisposition = {
  id: string
  bale_id: string
  disposition: CottonDisposition
  contract_id: string | null
  loan_id: string | null
  disposition_date: string | null
  created_at: string
}

export type CottonFeeType =
  | 'warehouse_receiving' | 'storage_monthly' | 'classing' | 'checkoff'
  | 'loan_interest' | 'loan_servicing' | 'pool_deduction' | 'merchant_fee' | 'other'

export type CottonFee = {
  id: string
  entity_id: string | null
  crop_year: number
  fee_type: CottonFeeType
  basis: 'per_bale' | 'per_bale_month' | 'pct_of_value' | 'flat'
  rate: number | null
  loan_id: string | null
  contract_id: string | null
  amount_total: number
  status: 'projected' | 'actual'
  fee_date: string | null
  notes: string | null
  created_at: string
}

export type CottonFeeSchedule = {
  id: string
  crop_year: number
  storage_per_bale_month: number
  receiving_per_bale: number
  classing_per_bale: number
  checkoff_per_bale: number
  checkoff_supplemental_pct: number
  loan_interest_apr: number
  updated_at: string
}

export type AwpWeekly = {
  id: string
  week_effective: string
  awp_cents: number
  source: 'manual' | 'ai'
  created_at: string
}

// ---------- Unified county-yield assumption + area-based plans (045/047) ----------

// The ONE source for county-triggered insurance math. Differential semantics
// (047): yield_differential = "my yields run this much ABOVE the county", in
// the crop's own yield unit; estimated county = farm yield − differential.
// Deliberately separate from the ARC-CO expectation (FSA benchmarks).
export type CountyYieldAssumption = {
  id: string
  crop_id: string
  county_id: string | null
  crop_year: number
  /** DEPRECATED (pre-047): county vs RMA expected, %. Kept in the DB for
   *  history; no longer drives any estimate. */
  variance_pct: number
  /** "My yields run this much ABOVE the county", in the crop's yield unit
   *  (bu/ac grains, lbs/ac cotton). Estimated county = farm yield − this. */
  yield_differential: number | null
  county_yield_override: number | null
  rma_final_county_yield: number | null // published final: pins everything
  notes: string | null
  created_at: string
  updated_at: string // 052 — staleness anchor for viewer overrides
}

// STAX endorsement (cotton): band from coverage_range_top down coverage_pct.
export type CropInsuranceStax = {
  id: string
  policy_id: string
  coverage_range_top: number
  coverage_pct: number
  protection_factor: number
  expected_county_revenue: number | null
  premium_per_acre: number | null
  total_premium: number | null
  notes: string | null
  created_at: string
}

// MCO endorsement: margin-triggered band 86% → trigger_level (0.90/0.95).
export type CropInsuranceMco = {
  id: string
  policy_id: string
  trigger_level: number
  expected_margin: number | null
  input_cost_adjustment: number
  expected_county_yield: number | null
  premium_per_acre: number | null
  total_premium: number | null
  notes: string | null
  created_at: string
}

// ---------- Crop Budget Planner (048) ----------

// A pre-season budgeting scenario — a SANDBOX allocation for a budget crop
// year. Never writes to crop_assumptions or any actuals.
export type BudgetScenario = {
  id: string
  name: string
  budget_crop_year: number
  entity_id: string | null // null = whole operation
  notes: string | null
  created_at: string
  updated_at: string
}

// One crop line in a scenario. Prices: $/bu grains; cotton STORED ¢/lb
// (displayed $/lb). basis adds to the futures (or manual) price.
// practice/cropping (049): optional irrigated/dryland and full-season/
// double-crop breakout — null = blended / full season.
export type BudgetLine = {
  id: string
  scenario_id: string
  crop_id: string
  label: string | null
  practice: 'irrigated' | 'non_irrigated' | null
  cropping: 'full_season' | 'double_crop' | null
  acres: number | null
  yield_per_acre: number | null
  price_mode: 'live' | 'manual'
  manual_price: number | null
  basis: number | null
  cost_per_acre: number | null
  sort_order: number
  created_at: string
}
