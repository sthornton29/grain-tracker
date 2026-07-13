// Client-side helpers for the AI PDF parsing flow:
//   * fileToBase64       — read a File as a base64 string (no data: prefix)
//   * parseDocument      — POST to /api/parse-document and return the JSON
//   * uploadPdfToStorage — push the PDF to Supabase storage and return a URL
//
// The Anthropic API key never touches the browser — these helpers only know
// how to talk to /api/parse-document on the same origin.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'

export const MAX_PDF_BYTES = 20 * 1024 * 1024
export const PDF_BUCKET = 'documents'

export class PdfTooLargeError extends Error {
  constructor() {
    super('That PDF is larger than 20 MB. Please use a smaller file.')
    this.name = 'PdfTooLargeError'
  }
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export type DocumentType = 'settlement' | 'tickets' | 'brokerage_statement' | 'contract' | 'fields' | 'plantings' | 'crop_insurance_policy' | 'fsa_base_acres' | 'cotton_weight_ticket' | 'gin_receipt'

export type SettlementExtraction = {
  buyer_name: string | null
  settlement_date: string | null
  settlement_number: string | null
  line_items: Array<{
    ticket_number: string | null
    net_bushels: number | null
    gross_revenue: number | null
    discounts: number | null
  }>
}

export type TicketExtraction = {
  ticket_number: string | null
  date: string | null
  time: string | null
  truck: string | null
  crop: string | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null
  moisture: number | null
  test_weight: number | null
  from_type: 'field' | 'bin' | null
  from_name: string | null
  to_type: 'bin' | 'buyer' | null
  to_name: string | null
}

export type TicketsExtraction = {
  tickets: TicketExtraction[]
}

export type BrokerageOpenPosition = {
  trade_date: string | null
  side: 'long' | 'short' | null
  num_contracts: number | null
  commodity: string | null
  contract_month: string | null
  trade_price: number | null
  unrealized_pnl: number | null
}

// Legacy per-line closed trade (one row per trade with a per-line realized P&L).
// Superseded by BrokerageClosedGroup, but still accepted as a fallback when an
// older/odd statement comes back in this shape — see buildClosedGroups.
export type BrokerageClosedTrade = {
  open_trade_date: string | null
  close_trade_date: string | null
  side: 'long' | 'short' | null
  num_contracts: number | null
  commodity: string | null
  contract_month: string | null
  open_price: number | null
  close_price: number | null
  realized_pnl: number | null
}

// One opening lot within a closed offset group.
export type BrokerageClosedGroupLot = {
  open_date: string | null
  open_price: number | null
  contracts: number | null
}

// A Purchase & Sale offset group: one or more opening lots closed by a single
// closing transaction (shared close_date/close_price). statement_reported_total
// is the group's printed GROSS PROFIT/LOSS — kept ONLY for reconciliation, never
// written to any position's realized P&L (computed per lot in code instead).
export type BrokerageClosedGroup = {
  commodity: string | null
  contract_month: string | null
  side: 'long' | 'short' | null
  close_date: string | null
  close_price: number | null
  lots: BrokerageClosedGroupLot[]
  statement_reported_total: number | null
}

export type BrokerageOpenOption = {
  trade_date: string | null
  side: 'buy' | 'sell' | null
  option_type: 'put' | 'call' | null
  num_contracts: number | null
  commodity: string | null
  underlying_contract_month: string | null
  strike_price: number | null
  premium_cents: number | null
  unrealized_pnl: number | null
}

export type BrokerageClosedOption = {
  open_trade_date: string | null
  close_trade_date: string | null
  side: 'buy' | 'sell' | null
  option_type: 'put' | 'call' | null
  num_contracts: number | null
  commodity: string | null
  underlying_contract_month: string | null
  strike_price: number | null
  open_premium_cents: number | null
  close_premium_cents: number | null
  realized_pnl: number | null
}

export type BrokerageStatementExtraction = {
  statement_date: string | null
  open_positions: BrokerageOpenPosition[]
  // Closed trades now arrive grouped: one entry per offset group with per-lot
  // opening facts. closed_trades is the legacy shape, still accepted as a
  // fallback (see buildClosedGroups in the statement-import component).
  closed_groups?: BrokerageClosedGroup[]
  closed_trades?: BrokerageClosedTrade[]
  open_options?: BrokerageOpenOption[]
  closed_options?: BrokerageClosedOption[]
  account_summary: {
    beginning_balance: number | null
    ending_balance: number | null
    open_trade_equity: number | null
    total_equity: number | null
    margin_requirement: number | null
    excess_equity: number | null
  } | null
}

export type ContractExtraction = {
  contract_number: string | null
  buyer_name: string | null
  crop: string | null
  contract_type: 'forward' | 'hta' | 'basis' | null
  contract_month: string | null
  crop_year: number | null
  contracted_bushels: number | null
  futures_price: number | null
  basis: number | null
  cash_price: number | null
  service_fee: number | null
  delivery_type: 'pickup' | 'delivered' | null
  delivery_start_date: string | null
  delivery_end_date: string | null
  notes: string | null
}

export type FieldExtraction = {
  field_name: string | null
  farm_name: string | null
  total_acres: number | null
  irrigated_acres: number | null
}

export type FieldsExtraction = {
  fields: FieldExtraction[]
}

export type PlantingExtractionVariety = {
  variety: string | null
  acres: number | null
}

export type PlantingExtraction = {
  field_name: string | null
  crop: string | null
  season_year: number | null
  planted_acres: number | null
  irrigated_acres: number | null
  planting_date: string | null
  varieties: PlantingExtractionVariety[] | null
  notes: string | null
}

export type PlantingsExtraction = {
  plantings: PlantingExtraction[]
}

export type CropInsuranceScoExtraction = {
  present: boolean | null
  coverage_trigger: number | null
  expected_county_yield: number | null
  premium_per_acre: number | null
  total_premium: number | null
}

export type CropInsuranceEcoExtraction = {
  present: boolean | null
  trigger_level: number | null
  expected_county_yield: number | null
  premium_per_acre: number | null
  total_premium: number | null
}

export type CropInsurancePolicyExtraction = {
  crop: string | null
  county: string | null
  state: string | null
  crop_year: number | null
  plan_type: 'RP' | 'RP_HPE' | 'YP' | null
  // Practice for this line ('irrigated' / 'non_irrigated'); null when the
  // document doesn't distinguish (a single combined line for the crop/county).
  practice: 'irrigated' | 'non_irrigated' | null
  coverage_level: number | null
  unit_structure: 'enterprise' | 'basic' | 'optional' | null
  aph_yield: number | null
  projected_price: number | null
  insured_acres: number | null
  premium_per_acre: number | null
  total_premium: number | null
  premium_subsidy_pct: number | null
  policy_number: string | null
  sco: CropInsuranceScoExtraction | null
  eco: CropInsuranceEcoExtraction | null
}

export type CropInsuranceExtraction = {
  policies: CropInsurancePolicyExtraction[]
}

export type FsaCommodityExtraction = {
  commodity_name: string | null
  base_acres: number | null
  plc_yield: number | null
  arc_plc_election: 'PLC' | 'ARC-CO' | 'ARC-IC' | null
  is_unassigned: boolean | null
  new_base_acres: number | null
  total_base_acres: number | null
}

export type FsaFarmExtraction = {
  fsa_farm_number: string | null
  county: string | null
  state: string | null
  commodities: FsaCommodityExtraction[]
}

export type FsaBaseAcresExtraction = {
  farms: FsaFarmExtraction[]
}

// A compressed photo page ready for the API. lib/image-capture.ts' CapturedImage
// structurally satisfies this, so callers can pass captured images directly.
export type ParseImage = { base64: string; mediaType: string }

// parseDocument accepts either a single PDF File (the original path) or an array
// of compressed photo pages. Both send the identical extraction prompt; only the
// content blocks differ on the server.
export async function parseDocument(input: File | ParseImage[], documentType: 'settlement'): Promise<SettlementExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'tickets'): Promise<TicketsExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'brokerage_statement'): Promise<BrokerageStatementExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'contract'): Promise<ContractExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'fields'): Promise<FieldsExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'plantings'): Promise<PlantingsExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'crop_insurance_policy'): Promise<CropInsuranceExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'fsa_base_acres'): Promise<FsaBaseAcresExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'cotton_weight_ticket'): Promise<CottonLoadsExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'gin_receipt'): Promise<GinReceiptExtraction>
export async function parseDocument(
  input: File | ParseImage[],
  documentType: DocumentType,
): Promise<SettlementExtraction | TicketsExtraction | BrokerageStatementExtraction | ContractExtraction | FieldsExtraction | PlantingsExtraction | CropInsuranceExtraction | FsaBaseAcresExtraction | CottonLoadsExtraction | GinReceiptExtraction> {
  // Build the request body. Photos are compressed small enough to inline as
  // base64. A PDF, however, is uploaded to storage first and sent as a URL:
  // Vercel rejects serverless request bodies over 4.5 MB with a 413, well below
  // our 20 MB PDF limit, so base64-inlining a real-world contract scan fails.
  // The temp upload is deleted once parsing returns (Anthropic has fetched it
  // by then, since the route awaits the API call before responding).
  let payload: Record<string, unknown>
  let cleanup: (() => void) | null = null
  if (Array.isArray(input)) {
    payload = {
      document_type: documentType,
      images: input.map((img) => ({ media_type: img.mediaType, data: img.base64 })),
    }
  } else {
    if (input.size > MAX_PDF_BYTES) throw new PdfTooLargeError()
    const supabase = createClient()
    const { publicUrl, path } = await uploadFileToStorage(supabase, input, 'parse-uploads', 'application/pdf')
    payload = { document_type: documentType, pdf_url: publicUrl }
    cleanup = () => { void supabase.storage.from(PDF_BUCKET).remove([path]).then(() => {}, () => {}) }
  }
  try {
    const res = await fetch('/api/parse-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = body?.error || `Server returned ${res.status}.`
      throw new Error(msg)
    }
    if (!body || typeof body !== 'object' || !('data' in body)) {
      throw new Error('Malformed response from server.')
    }
    return body.data as SettlementExtraction | TicketsExtraction | BrokerageStatementExtraction | ContractExtraction | FieldsExtraction | PlantingsExtraction | CropInsuranceExtraction | FsaBaseAcresExtraction
  } finally {
    cleanup?.()
  }
}

// Uploads to the public "documents" bucket and returns the public URL.
// Path is randomized so two scans with the same filename don't clobber.
export async function uploadPdfToStorage(
  supabase: SupabaseClient,
  file: File,
  prefix: 'settlements' | 'tickets',
): Promise<string> {
  const { publicUrl } = await uploadFileToStorage(supabase, file, prefix, 'application/pdf')
  return publicUrl
}

// Generic uploader — accepts any file (PDF, image, etc.) and returns both the
// public URL and the storage path. Callers need the path to delete the object
// later (parsing the public URL is brittle if the bucket name ever changes).
export async function uploadFileToStorage(
  supabase: SupabaseClient,
  file: File,
  prefix: string,
  contentType?: string,
): Promise<{ publicUrl: string; path: string }> {
  const rand = Math.random().toString(36).slice(2, 10)
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const path = `${prefix}/${Date.now()}-${rand}-${safeName}`
  const { error } = await supabase.storage
    .from(PDF_BUCKET)
    .upload(path, file, {
      contentType: contentType ?? file.type ?? 'application/octet-stream',
      upsert: false,
    })
  if (error) throw new Error(`Could not upload file: ${error.message}`)
  const { data } = supabase.storage.from(PDF_BUCKET).getPublicUrl(path)
  return { publicUrl: data.publicUrl, path }
}

// Best-effort delete: pulls the path out of a Supabase public URL of the form
// .../storage/v1/object/public/<bucket>/<path>. Silently no-ops if the URL
// isn't in that shape (e.g., legacy data, manually entered link).
export async function deleteStorageObjectByUrl(
  supabase: SupabaseClient,
  url: string,
): Promise<void> {
  const marker = `/object/public/${PDF_BUCKET}/`
  const i = url.indexOf(marker)
  if (i < 0) return
  const path = decodeURIComponent(url.slice(i + marker.length))
  if (!path) return
  await supabase.storage.from(PDF_BUCKET).remove([path])
}

// ---------- Cotton module extractions ----------

export type CottonLoadExtraction = {
  load_number: string | null
  producer: string | null
  farm_number: string | null
  field: string | null
  picked_date: string | null
  delivered_date: string | null
  truck: string | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null
  crop_year: number | null
}
export type CottonLoadsExtraction = { loads: CottonLoadExtraction[] }

export type GinReceiptLoadLine = {
  load_number: string | null
  rolls: number | null
  gross: number | null
  tare: number | null
  net: number | null
}
export type GinReceiptExtraction = {
  gin_name: string | null
  gin_address: string | null
  gin_phone: string | null
  receipt_number: string | null
  receipt_date: string | null
  producer: string | null
  farm_number: string | null
  farm_name: string | null
  field: string | null
  crop_year: number | null
  modules_count: number | null
  total_seed_cotton_weight: number | null
  bales_count: number | null
  total_bale_weight: number | null
  avg_bale_weight: number | null
  seed_lbs: number | null
  lint_turnout_pct: number | null
  lint_lbs_per_bale: number | null
  loads: GinReceiptLoadLine[]
  bales: Array<{ pbi_number: string | null; net_weight_lbs: number | null }>
}
