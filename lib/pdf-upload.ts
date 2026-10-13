// Client-side helpers for the AI PDF parsing flow:
//   * fileToBase64       — read a File as a base64 string (no data: prefix)
//   * parseDocument      — POST to /api/parse-document and return the JSON
//   * uploadPdfToStorage — push the PDF to Supabase storage and return a URL
//
// The Anthropic API key never touches the browser — these helpers only know
// how to talk to /api/parse-document on the same origin.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { getOrgId } from '@/lib/org'
import type { CottonMarketingCategory, CottonMarketingExtraction } from '@/lib/cotton-doc-import'

export const MAX_PDF_BYTES = 20 * 1024 * 1024
export const PDF_BUCKET = 'documents'

export class PdfTooLargeError extends Error {
  constructor() {
    super('That PDF is larger than 20 MB. Please use a smaller file.')
    this.name = 'PdfTooLargeError'
  }
}

// The model's answer hit max_tokens (or came back cut off mid-JSON): the
// chunk holds more than one call can write. lib/parse-chunked halves the
// chunk and reads each half — never a retry of the same request.
export class ParseTooLongError extends Error {
  readonly code = 'TOO_LONG' as const
  stopReason: string | null
  outputTokens: number | null
  constructor(message?: string, extra?: { stopReason?: string | null; outputTokens?: number | null }) {
    super(message || 'The document section was too long to read in one pass.')
    this.name = 'ParseTooLongError'
    this.stopReason = extra?.stopReason ?? null
    this.outputTokens = extra?.outputTokens ?? null
  }
}

// The call ran out of time (the route's 240 s client timeout, a 504 from the
// gateway, a dropped connection). Also a "split" error for the chunker: a
// smaller chunk finishes sooner.
export class ParseTimeoutError extends Error {
  readonly code = 'TIMEOUT' as const
  constructor(message?: string) {
    super(message || 'The document section took too long to read.')
    this.name = 'ParseTimeoutError'
  }
}

const TIMEOUT_RE = /timeout|timed out|504|gateway/i

/** Token usage of one call, from the route's response. */
export type ParseUsage = { input_tokens: number | null; output_tokens: number | null; stop_reason: string | null }

export type ParseOptions = {
  category?: CottonMarketingCategory
  primaryTarget?: string
  /** Answer cap for this call (the route clamps 1024..24000; default 8192). */
  maxTokens?: number
  /** Pages in this call, for the route's log line (PDFs arrive as a URL). */
  pageCount?: number
  /** Usage of a successful call, for metrics / the attempt log. */
  onUsage?: (usage: ParseUsage) => void
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

export type DocumentType = 'settlement' | 'tickets' | 'brokerage_statement' | 'contract' | 'settings_document' | 'crop_insurance_policy' | 'fsa_base_acres' | 'cotton_weight_ticket' | 'gin_receipt' | 'cotton_marketing_document' | 'lease_agreement' | 'discount_schedule' | 'seed_contract'

// Seed grower agreement extraction (077): the signature page (brand, contract
// #, acres, bu/ac, estimated quantity, elevator, grower entity) AND the
// Exhibit C terms (premium components/amounts/cap, pricing methods and
// windows, payment dates, storage terms).
export type SeedContractExtraction = {
  contract_number: string | null
  seed_company: string | null
  grower_name: string | null
  crop: string | null
  crop_year: number | null
  brand: string | null
  variety: string | null
  production_site: string | null
  contract_acres: number | null
  forecast_bu_per_acre: number | null
  estimated_bushels: number | null
  local_market_elevator: string | null
  pricing_deadline: string | null
  premium_cap_per_bu: number | null
  storage_pay_per_bu_month: number | null
  storage_pay_start_date: string | null
  usage_fee_per_bu: number | null
  final_settlement_date: string | null
  premiums: Array<{
    outcome: 'accepted' | 'released_post_harvest' | 'released_pre_harvest' | 'rejected' | null
    component: string | null
    amount_per_bu: number | null
    applies_to: 'all' | 'irrigated_only' | null
  }>
  notes: string | null
}

// Full lease-terms extraction for the Rent Settlement report (069). Shapes
// mirror lib/rent-settlement.ts LeaseTermsShape (snake_case on the wire).
export type LeaseAgreementExtraction = {
  landowner_name: string | null
  landowner_address: string | null
  farm_names: string[]
  lease_type: 'crop_share' | 'cash' | 'flex' | null
  share_terms: { default_pct: number | null; by_crop: Record<string, number> } | null
  expense_terms: Array<{ category: string; landowner_pct: number; note: string | null }> | null
  pricing_method: { method: 'landowner_sells_own' | 'operator_actual' | 'reference'; reference: { description: string } | null } | null
  cash_terms: { per_acre: number | null; total_annual: number | null } | null
  flex_terms: Array<{ description: string }> | null
  payment_timing: string | null
  crop_year: number | null
  notes: string | null
  source: string | null
}

// A document-level itemized discount line (074). Category is free text on the
// wire — coerceDiscountCategory (lib/settlement-discounts.ts) pins it to the
// enum at save time.
export type SettlementDiscountItemExtraction = {
  category: string | null
  description: string | null
  amount: number | null
  rate_note: string | null
  quantity_basis: string | null
  // 075: 'price' (dollars off the check) vs 'weight' (a volume deduction).
  // Absent on older parses; coerceDeductionKind reads absent as 'price'.
  deduction_kind?: string | null
}

// The per-ticket grade block as structured readings (086). Percentages
// except test_weight (lb/bu). Every field nullable — never invented.
export type SettlementGradeReadings = {
  /** The printed grade itself ("1 US #1", "2 YC"), as text. */
  grade?: string | null
  moisture?: number | null
  foreign_material?: number | null
  splits?: number | null
  total_damage?: number | null
  heat_damage?: number | null
  test_weight?: number | null
  other_color?: number | null
  oil?: number | null
  protein?: number | null
}

export type SettlementLineExtraction = {
  ticket_number: string | null
  net_bushels: number | null
  gross_revenue: number | null
  discounts: number | null
  // 086 — matching keys and the grade block. Absent on older parses.
  secondary_ref?: string | null
  delivery_date?: string | null
  vehicle_plate?: string | null
  gross_weight?: number | null
  tare_weight?: number | null
  /** Net POUNDS paid on the line when printed (Woodall's LB column). */
  net_weight?: number | null
  /** Special-discount legend codes printed on the line ("2", "2,4"). */
  special_discount_codes?: string | null
  grade_readings?: SettlementGradeReadings | null
  // 094 — the "Contract Number: X" block this line printed under, per LINE
  // ("2002960604-10", "SPOT", "S12"); lib/settlement-sales classifySaleText
  // turns it into sale_type. Absent on older parses (header contract only).
  contract_number?: string | null
  /** Set by the review (or an explicit parse): 'contract' | 'spot' | 'price_later'. */
  sale_type?: string | null
}

// The statement's Contract / Ticket Summary (Woodall and others): the
// buyer's own view of the contract this settlement draws on. Cross-checked
// against the app's contract progress on the review screen.
export type SettlementContractSummary = {
  contract_number?: string | null
  priced_bushels?: number | null
  settled_bushels?: number | null
  remaining_bushels?: number | null
}

export type SettlementExtraction = {
  buyer_name: string | null
  settlement_date: string | null
  settlement_number: string | null
  // 086 — the header contract number and the check / remittance page's
  // payment facts (never tickets). Absent on older parses.
  contract_number?: string | null
  payment_number?: string | null
  check_number?: string | null
  payment_date?: string | null
  line_items: SettlementLineExtraction[]
  // Absent on pre-074 parses; the review screen treats missing as [].
  discount_items?: SettlementDiscountItemExtraction[]
  // The statement's OWN grand total (net dollars paid) and total bushels, read
  // from its TOTAL row / check stub — for reconciliation only, never a line.
  // Absent on older parses.
  statement_reported_total?: number | null
  statement_reported_bushels?: number | null
  /** The buyer's contract summary block when printed. Absent on older parses. */
  contract_summary?: SettlementContractSummary | null
  /** The statement's gross before deductions, when printed separately. */
  statement_reported_gross?: number | null
  /** "No. Tickets: 94" — the count the statement prints; null when it doesn't. */
  statement_reported_ticket_count?: number | null
  /** The contract blocks as the model reports them (2026-10-13 trimmed
   *  shape): constants stated once per block; the lines are flattened into
   *  line_items by normalizeSettlementExtraction, so after parseDocument the
   *  blocks carry only their constants. */
  contract_blocks?: SettlementContractBlockExtraction[] | null
}

// One "Contract Number: X" block of the statement — the facts constant
// across its lines, stated once. The model nests the block's line_items
// here; the app flattens them (contract_number carried down to each line).
export type SettlementContractBlockExtraction = {
  contract_number?: string | null
  /** The block's flat / contract price when printed ("Flat $4.70250"). */
  price_per_bushel?: number | null
  crop?: string | null
  line_items?: Array<Partial<SettlementLineExtraction>> | null
}

const SETTLEMENT_LINE_KEYS = [
  'ticket_number', 'net_bushels', 'gross_revenue', 'discounts', 'secondary_ref', 'delivery_date', 'vehicle_plate',
  'gross_weight', 'tare_weight', 'net_weight', 'special_discount_codes', 'grade_readings', 'contract_number',
] as const
const SETTLEMENT_GRADE_KEYS = ['grade', 'moisture', 'foreign_material', 'splits', 'total_damage', 'heat_damage', 'test_weight', 'other_color', 'oil', 'protein'] as const
const SETTLEMENT_DOC_KEYS = [
  'buyer_name', 'settlement_date', 'settlement_number', 'contract_number', 'payment_number', 'check_number', 'payment_date',
  'statement_reported_total', 'statement_reported_bushels', 'statement_reported_gross', 'statement_reported_ticket_count', 'contract_summary',
] as const

/**
 * The settlement answer in the shape the rest of the app reads: the model
 * now nests line_items under contract_blocks and OMITS null keys (half the
 * output tokens of the old flat shape). This flattens the blocks back into
 * line_items with each block's contract_number carried down, tolerates a
 * flat line_items array (an older parse, or a model that still emits one —
 * both are kept, deduped on ticket + contract), and fills every missing
 * key with null so nothing downstream changes. parseDocument applies it to
 * every 'settlement' answer; mergeSettlements applies it again to be safe.
 */
export function normalizeSettlementExtraction(raw: unknown): SettlementExtraction {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const norm = (v: unknown) => (v == null ? '' : String(v).trim().toLowerCase())
  const blocks = Array.isArray(r.contract_blocks) ? (r.contract_blocks as Array<SettlementContractBlockExtraction | null>) : []
  const lines: SettlementLineExtraction[] = []
  const seen = new Set<string>()
  const push = (line: unknown, blockContract: string | null) => {
    if (!line || typeof line !== 'object') return
    const l = line as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of SETTLEMENT_LINE_KEYS) out[k] = l[k] ?? null
    if (out.contract_number == null && blockContract != null) out.contract_number = blockContract
    const g = l.grade_readings
    if (g && typeof g === 'object') {
      const gr: Record<string, unknown> = {}
      for (const k of SETTLEMENT_GRADE_KEYS) gr[k] = (g as Record<string, unknown>)[k] ?? null
      out.grade_readings = gr
    } else {
      out.grade_readings = null
    }
    if (l.sale_type != null) out.sale_type = l.sale_type
    // A ticket printed under TWO blocks (094) is two lines; the same ticket
    // under the same block twice in one answer is a double read.
    const key = out.ticket_number != null && String(out.ticket_number).trim() !== '' ? `${norm(out.ticket_number)}|${norm(out.contract_number)}` : null
    if (key) {
      if (seen.has(key)) return
      seen.add(key)
    }
    lines.push(out as SettlementLineExtraction)
  }
  for (const line of Array.isArray(r.line_items) ? r.line_items : []) push(line, null)
  for (const b of blocks) {
    const c = b?.contract_number != null && String(b.contract_number).trim() !== '' ? String(b.contract_number) : null
    for (const line of Array.isArray(b?.line_items) ? b!.line_items! : []) push(line, c)
  }
  const out: Record<string, unknown> = {}
  for (const k of SETTLEMENT_DOC_KEYS) out[k] = r[k] ?? null
  // The header contract is the first block's when the header printed none.
  const firstBlock = blocks.find((b) => b?.contract_number != null && String(b.contract_number).trim() !== '')
  if (out.contract_number == null && firstBlock) out.contract_number = String(firstBlock.contract_number)
  out.line_items = lines
  out.discount_items = Array.isArray(r.discount_items) ? r.discount_items : []
  if (blocks.length > 0) {
    out.contract_blocks = blocks
      .filter((b): b is SettlementContractBlockExtraction => !!b && typeof b === 'object')
      .map((b) => ({ contract_number: b.contract_number ?? null, price_per_bushel: b.price_per_bushel ?? null, crop: b.crop ?? null }))
  }
  return out as SettlementExtraction
}

// A buyer's posted discount sheet (document_type 'discount_schedule', 074).
// Rule shapes mirror lib/discount-schedules.ts ScheduleRuleShape (snake_case
// on the wire; factor/basis coerced at save time).
export type DiscountScheduleRuleExtraction = {
  factor: string | null
  basis: string | null
  base_value: number | null
  direction: 'above' | 'below' | null
  rate_per_unit: number | null
  tiers: Array<{ from: number | null; to: number | null; rate: number | null }> | null
  cumulative: boolean | null
  rejection_at: number | null
  note: string | null
  /** Moisture rules: the % of weight shrunk per point over base when the
   *  sheet states one (080); null when not printed. */
  shrink_factor_pct_per_point?: number | null
}

export type DiscountScheduleExtraction = {
  buyer_name: string | null
  crop: string | null
  effective_date: string | null
  crop_year: number | null
  schedule_text: string | null
  rules: DiscountScheduleRuleExtraction[]
}

export type TicketExtraction = {
  ticket_number: string | null
  /** The date EXACTLY as printed ("10/03", "OCT 3 26") — lib/ticket-date
   *  resolveTicketDate turns it into a load date; the code decides the year. */
  date_text: string | null
  /** Whether a year was printed as part of that date (null = no date). */
  year_printed: boolean | null
  /** Legacy field (pre-093 extractions returned an ISO date). */
  date?: string | null
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
  // The trade code printed on the CONFIRMATION line for a same-day fill:
  // 'E' electronic, 'S' spread, 'SE' spread-electronic. Roll detection reads
  // it (S/SE = the two legs were one spread order); parsing never does.
  execution_code?: string | null
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
  // The closing-side fills, listed separately from the lots (2026-10-13):
  // the 10/12 BUYs that bought back the DEC 26 shorts are the CLOSING
  // transaction, never lots. close_price is their contract-weighted average
  // (the statement's AVG LONG / AVG SHORT line).
  closing_fills?: BrokerageClosingFill[] | null
  statement_reported_total: number | null
  // The group's "*" subtotal — the contracts the statement says this offset
  // closed. lib/statement-lots checks the lots against it.
  statement_reported_contracts?: number | null
  // The per-side "TOTAL COMMISSION & FEES" printed under the group, when any.
  fees?: number | null
  // Trade code on the CLOSING transaction when it appears in CONFIRMATION
  // (same vocabulary as BrokerageOpenPosition.execution_code).
  close_execution_code?: string | null
}
export type BrokerageClosingFill = {
  date: string | null
  price: number | null
  contracts: number | null
}
// Every fill in the CONFIRMATION section as printed (no subtotals) — the
// execution codes live here, and lib/statement-lots uses the fills to tell a
// genuinely repeated open row from a double read.
export type BrokerageConfirmationTrade = {
  trade_date: string | null
  side: 'buy' | 'sell' | null
  num_contracts: number | null
  commodity: string | null
  contract_month: string | null
  trade_price: number | null
  execution_code?: string | null
}
// One "*" subtotal line of OPEN POSITIONS: the contracts held per commodity,
// month and side at the statement's CLOSE, with the open trade equity the
// statement computed at that close. The reconciliation gate
// (lib/import-reconciliation) compares the import's result to these.
export type BrokerageOpenSubtotal = {
  commodity: string | null
  contract_month: string | null
  side: 'long' | 'short' | null
  contracts: number | null
  close_price: number | null
  open_trade_equity: number | null
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
  // The issuing firm as printed ('StoneX', 'R.J. O'Brien'…) — the history
  // trail cites "from StoneX statement 9/03".
  broker?: string | null
  open_positions: BrokerageOpenPosition[]
  // Closed trades now arrive grouped: one entry per offset group with per-lot
  // opening facts. closed_trades is the legacy shape, still accepted as a
  // fallback (see buildClosedGroups in the statement-import component).
  closed_groups?: BrokerageClosedGroup[]
  closed_trades?: BrokerageClosedTrade[]
  // 2026-10-13: the CONFIRMATION fills and the OPEN POSITIONS "*" subtotals,
  // kept apart from the positions themselves (see lib/statement-lots).
  confirmation_trades?: BrokerageConfirmationTrade[] | null
  open_position_subtotals?: BrokerageOpenSubtotal[] | null
  open_options?: BrokerageOpenOption[]
  closed_options?: BrokerageClosedOption[]
  account_summary: {
    beginning_balance: number | null
    ending_balance: number | null
    open_trade_equity: number | null
    total_equity: number | null
    margin_requirement: number | null
    excess_equity: number | null
    // The day's realized total and the fee total, for the reconciliation gate.
    gross_profit_loss_from_trades?: number | null
    total_commissions_and_fees?: number | null
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

export type CropInsuranceStaxExtraction = {
  present: boolean | null
  coverage_range_top: number | null
  coverage_pct: number | null
  protection_factor: number | null
  expected_county_revenue: number | null
  premium_per_acre: number | null
  total_premium: number | null
}

export type CropInsuranceMcoExtraction = {
  present: boolean | null
  trigger_level: number | null
  expected_margin: number | null
  input_cost_adjustment: number | null
  expected_county_yield: number | null
  premium_per_acre: number | null
  total_premium: number | null
}

export type CropInsurancePolicyExtraction = {
  crop: string | null
  county: string | null
  state: string | null
  crop_year: number | null
  plan_type: 'RP' | 'RP_HPE' | 'YP' | 'ARP' | 'AYP' | null
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
  // Area/county figures where shown (ARP/AYP lines; also useful for STAX/MCO).
  expected_county_yield: number | null
  expected_county_revenue: number | null
  protection_factor: number | null
  sco: CropInsuranceScoExtraction | null
  eco: CropInsuranceEcoExtraction | null
  stax: CropInsuranceStaxExtraction | null
  mco: CropInsuranceMcoExtraction | null
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

// The unified settings extraction's raw response (settings_document). The
// typed sections + normalization live in lib/settings-extraction.ts.
export type { RawSettingsExtraction } from '@/lib/settings-extraction'
import type { RawSettingsExtraction } from '@/lib/settings-extraction'

// parseDocument accepts either a single PDF File (the original path) or an array
// of compressed photo pages. Both send the identical extraction prompt; only the
// content blocks differ on the server.
export async function parseDocument(input: File | ParseImage[], documentType: 'settlement', opts?: ParseOptions): Promise<SettlementExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'tickets', opts?: ParseOptions): Promise<TicketsExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'brokerage_statement', opts?: ParseOptions): Promise<BrokerageStatementExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'contract', opts?: ParseOptions): Promise<ContractExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'settings_document', opts?: ParseOptions): Promise<RawSettingsExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'crop_insurance_policy', opts?: ParseOptions): Promise<CropInsuranceExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'fsa_base_acres', opts?: ParseOptions): Promise<FsaBaseAcresExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'cotton_weight_ticket', opts?: ParseOptions): Promise<CottonLoadsExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'gin_receipt', opts?: ParseOptions): Promise<GinReceiptExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'cotton_marketing_document', opts?: ParseOptions): Promise<CottonMarketingExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'lease_agreement', opts?: ParseOptions): Promise<LeaseAgreementExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'discount_schedule', opts?: ParseOptions): Promise<DiscountScheduleExtraction>
export async function parseDocument(input: File | ParseImage[], documentType: 'seed_contract', opts?: ParseOptions): Promise<SeedContractExtraction>
export async function parseDocument(
  input: File | ParseImage[],
  documentType: DocumentType,
  opts?: ParseOptions,
): Promise<SettlementExtraction | TicketsExtraction | BrokerageStatementExtraction | ContractExtraction | RawSettingsExtraction | CropInsuranceExtraction | FsaBaseAcresExtraction | CottonLoadsExtraction | GinReceiptExtraction | CottonMarketingExtraction | LeaseAgreementExtraction | DiscountScheduleExtraction | SeedContractExtraction> {
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
  if (opts?.category) payload.category = opts.category
  if (opts?.primaryTarget) payload.primary_target = opts.primaryTarget
  if (opts?.maxTokens != null && Number.isFinite(opts.maxTokens)) payload.max_tokens = Math.round(opts.maxTokens)
  if (opts?.pageCount != null && Number.isFinite(opts.pageCount)) payload.page_count = Math.round(opts.pageCount)
  try {
    let res: Response
    try {
      res = await fetch('/api/parse-document', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (e) {
      // The browser gave up on the request (a gateway timeout surfaces here
      // as a failed fetch on some networks): the chunker splits on it.
      if (TIMEOUT_RE.test(String((e as { message?: unknown } | null)?.message ?? e))) throw new ParseTimeoutError()
      throw e
    }
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const code = typeof body?.code === 'string' ? body.code : null
      const msg: string | null = typeof body?.error === 'string' ? body.error : null
      if (res.status === 422 && code === 'TOO_LONG') {
        throw new ParseTooLongError(msg ?? undefined, { stopReason: body?.stop_reason ?? null, outputTokens: body?.output_tokens ?? null })
      }
      if (res.status === 504 || res.status === 502 || code === 'TIMEOUT' || (msg != null && TIMEOUT_RE.test(msg))) {
        throw new ParseTimeoutError(msg ?? undefined)
      }
      throw new Error(msg || `Server returned ${res.status}.`)
    }
    if (!body || typeof body !== 'object' || !('data' in body)) {
      throw new Error('Malformed response from server.')
    }
    if (opts?.onUsage) {
      const u = body.usage ?? {}
      opts.onUsage({
        input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
        output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
        stop_reason: typeof body.stop_reason === 'string' ? body.stop_reason : null,
      })
    }
    // Settlements come back nested (contract_blocks, nulls omitted) and are
    // flattened HERE — the one place — so every caller sees the flat shape.
    const data = documentType === 'settlement' ? normalizeSettlementExtraction(body.data) : body.data
    return data as SettlementExtraction | TicketsExtraction | BrokerageStatementExtraction | ContractExtraction | RawSettingsExtraction | CropInsuranceExtraction | FsaBaseAcresExtraction | CottonMarketingExtraction | LeaseAgreementExtraction | DiscountScheduleExtraction | SeedContractExtraction
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
// Every path is prefixed with the caller's ORG id (054): the storage policies
// enforce the prefix server-side, so an upload cannot land in (or masquerade
// as) another org's space. Legacy pre-054 objects live at the un-prefixed
// root and keep working.
export async function uploadFileToStorage(
  supabase: SupabaseClient,
  file: File,
  prefix: string,
  contentType?: string,
): Promise<{ publicUrl: string; path: string }> {
  const orgId = await getOrgId(supabase)
  if (!orgId) throw new Error('Could not upload file: no organization membership.')
  const rand = Math.random().toString(36).slice(2, 10)
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const path = `${orgId}/${prefix}/${Date.now()}-${rand}-${safeName}`
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

// The ONE remove seam (components must not call storage.remove directly —
// the bucket literal and any future path handling live here).
export async function deleteStorageObject(supabase: SupabaseClient, path: string): Promise<void> {
  if (!path) return
  await supabase.storage.from(PDF_BUCKET).remove([path])
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
  /** As printed on the ticket ("10/03") until the page resolves them through
   *  lib/ticket-date — then YYYY-MM-DD. */
  picked_date: string | null
  delivered_date: string | null
  truck: string | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null
  /** The PRINTED roll / round-module count ("Number of Rounds: 6"). */
  rolls: number | null
  /** A hand-written roll count ("3 Rolls") — kept apart; never picked silently. */
  handwritten_rolls?: number | null
  /** The handwriting itself ("Busted Roll, 3 Rolls on TRK #21"). */
  handwritten_note?: string | null
  /** A circled / hash-numbered corner figure (28, #41): the farm's module
   *  sequence, NOT rolls. */
  sequence_mark?: string | null
  /** 1-based page of the document the load was read from (rebased to the
   *  whole document by lib/parse-chunked). */
  page?: number | null
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
export type GinReceiptTotals = {
  modules_count: number | null
  total_seed_cotton_weight: number | null
  bales_count: number | null
  total_bale_weight: number | null
  avg_bale_weight: number | null
  seed_lbs: number | null
  lint_turnout_pct: number | null
  lint_lbs_per_bale: number | null
}
/** The gin's Farm (Producer) Year-To-Date block. */
export type GinFarmYtd = { modules: number | null; seed_cotton_lbs: number | null; bales: number | null; bale_weight: number | null }
export type GinReceiptBaleRow = { pbi_number: string | null; net_weight_lbs: number | null }
/** One PAGE of a Statement of Ginning as the prompt reports it (2026-10-11):
 *  one PDF can hold several statements, so the model reports pages and
 *  lib/gin-statements groups them (totals block / date change / bale rows
 *  restarting at 1 start a new statement). */
export type GinReceiptPage = {
  /** 1-based page (rebased to the whole document by lib/parse-chunked). */
  page: number | null
  statement_date: string | null
  has_totals_block: boolean | null
  gin_name: string | null
  gin_address: string | null
  gin_phone: string | null
  /** The gin's USDA gin code ("40614") — the GIN, not the statement. */
  gin_code: string | null
  /** A distinct per-statement number ONLY when the document prints one. */
  statement_number: string | null
  producer: string | null
  farm_number: string | null
  farm_name: string | null
  field: string | null
  crop_year: number | null
  totals: GinReceiptTotals | null
  farm_ytd: GinFarmYtd | null
  loads: GinReceiptLoadLine[]
  bales: GinReceiptBaleRow[]
  bale_row_first: number | null
  bale_row_last: number | null
}
export type GinReceiptExtraction = { pages: GinReceiptPage[] }
