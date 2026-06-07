export type Entity = { id: string; name: string; notes: string | null }
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
  harvest_complete: boolean
  cost_per_acre: number | null
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
  created_at: string
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
  source: 'manual' | 'barchart' | 'usda'
  updated_at: string
}

export type ArcPlcPayment = {
  id: string
  farm_id: string
  commodity_id: string
  crop_year: number
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
  crop_year: number
  crop_id: string | null
  farm_id: string | null
  amount: number
  payment_date: string | null
  payment_status: 'projected' | 'confirmed' | 'received'
  notes: string | null
  created_at: string
}

export type PaymentLimitConfig = {
  id: string
  entity_id: string
  crop_year: number
  eligible_persons: number
  per_person_limit: number
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
