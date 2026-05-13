export type Entity = { id: string; name: string; notes: string | null }
export type Farm = {
  id: string
  name: string
  entity_id: string | null
  fsa_number: string | null
  county_id: string | null
}
export type Field = {
  id: string
  farm_id: string | null
  name_or_number: string
  total_acres: number | null
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
  planting_date: string | null
  paired_planting_id: string | null
  notes: string | null
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
