// Read-only partner API (/api/partner/v1/*) — pure response builders + the
// bearer-token auth check. The intercompany engine pulls farm data from these
// endpoints and delta-syncs on the updated_at carried by every record, so each
// builder computes a record-level updated_at from the newest contributing row.
//
// Everything here is pure (no I/O) so the response shapes are unit-testable;
// the route handlers under app/api/partner/v1/ do the Supabase reads and pass
// rows in. Units: grains report dry bushels ('bu', same shrink math as the
// Yields pages); cotton crops report lint lbs ('lbs', from gin receipts).

import { computeBushels } from '@/lib/shrink'
import { isCottonCrop } from '@/lib/marketing'
import { contractUnit, quantityFor } from '@/lib/hedging'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type PartnerAuthResult = 'ok' | 'unconfigured' | 'unauthorized'

// Constant-time string compare (no early exit on first mismatch) so the token
// check doesn't leak prefix length via timing.
function timingSafeEqualStr(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length === b.length ? 0 : 1
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

/** The raw bearer token from an Authorization header, or null. Pure — the
 *  054 per-org token lookup (partner_api_tokens, sha256 at rest) hashes this
 *  server-side in lib/partner-api-server.ts. */
export function bearerTokenFrom(authorizationHeader: string | null | undefined): string | null {
  const header = (authorizationHeader ?? '').trim()
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

// Header must be exactly `Bearer <PARTNER_API_TOKEN>`. A missing/blank env var
// fails closed: every request is unauthorized until the token is configured.
export function checkPartnerAuth(
  authorizationHeader: string | null | undefined,
  configuredToken: string | null | undefined,
): PartnerAuthResult {
  const token = (configuredToken ?? '').trim()
  if (token === '') return 'unconfigured'
  const header = (authorizationHeader ?? '').trim()
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return 'unauthorized'
  return timingSafeEqualStr(m[1].trim(), token) ? 'ok' : 'unauthorized'
}

// ---------------------------------------------------------------------------
// Shared row shapes (narrow views of the DB rows the routes select)
// ---------------------------------------------------------------------------

export type EntityRow = { id: string; name: string; updated_at?: string | null }
export type FarmRow = {
  id: string
  name: string
  fsa_number: string | null
  entity_id: string | null
  updated_at?: string | null
}
export type FieldRow = {
  id: string
  farm_id: string | null
  name_or_number: string
  total_acres: number | string | null
  irrigated_acres: number | string | null
  dryland_acres: number | string | null
  updated_at?: string | null
}
export type CropRow = {
  id: string
  name: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
}
export type PlantingRow = {
  id: string
  field_id: string
  crop_id: string
  season_year: number
  planted_acres: number | string | null
  irrigated_acres: number | string | null
  dryland_acres: number | string | null
  updated_at?: string | null
}
export type LoadRow = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  crop_year: number | null
  dry_bushels_override: number | null
  from_type: string | null
  from_field_id: string | null
  updated_at?: string | null
}
export type SplitRow = {
  load_id: string
  field_id: string
  crop_id: string
  dry_bushels: number | null
}
export type GinReceiptRow = {
  id: string
  field_id: string | null
  crop_year: number
  total_bale_weight: number | string | null // lbs LINT
  updated_at?: string | null
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const maxIso = (...vals: Array<string | null | undefined>): string | null =>
  vals.reduce<string | null>((max, v) => (v && (!max || v > max) ? v : max), null)

// ---------------------------------------------------------------------------
// GET /fields
// ---------------------------------------------------------------------------

export type PartnerField = {
  id: string
  name: string
  /** Grain Tracker keeps a single canonical spelling per field — no alias
   *  table exists — so this is always empty today. The key is included so the
   *  consumer's schema doesn't change if aliases are added later. */
  aliases: string[]
  farm_id: string | null
  farm_name: string | null
  /** The farm's FSA number — the closest thing to a farm code. */
  farm_code: string | null
  entity: string | null
  acres: { total: number | null; irrigated: number | null; dryland: number | null }
  updated_at: string | null
}

export function buildFieldRecords(args: {
  fields: readonly FieldRow[]
  farms: readonly FarmRow[]
  entities: readonly EntityRow[]
}): PartnerField[] {
  const farmById = new Map(args.farms.map((f) => [f.id, f]))
  const entityById = new Map(args.entities.map((e) => [e.id, e]))
  return args.fields
    .map((f) => {
      const farm = f.farm_id ? farmById.get(f.farm_id) : undefined
      const entity = farm?.entity_id ? entityById.get(farm.entity_id) : undefined
      return {
        id: f.id,
        name: f.name_or_number,
        aliases: [] as string[],
        farm_id: farm?.id ?? null,
        farm_name: farm?.name ?? null,
        farm_code: farm?.fsa_number ?? null,
        entity: entity?.name ?? null,
        acres: {
          total: f.total_acres == null ? null : num(f.total_acres),
          irrigated: f.irrigated_acres == null ? null : num(f.irrigated_acres),
          dryland: f.dryland_acres == null ? null : num(f.dryland_acres),
        },
        updated_at: maxIso(f.updated_at, farm?.updated_at, entity?.updated_at),
      }
    })
    .sort((a, b) => (a.farm_name ?? '').localeCompare(b.farm_name ?? '') || a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// GET /plantings?year=
// ---------------------------------------------------------------------------

export type PartnerPlanting = {
  id: string
  field_id: string
  field_name: string | null
  crop: string | null
  crop_year: number
  planted_acres: number
  irrigated_acres: number
  dryland_acres: number
  entity: string | null
  updated_at: string | null
}

export function buildPlantingRecords(args: {
  plantings: readonly PlantingRow[]
  fields: readonly FieldRow[]
  farms: readonly FarmRow[]
  entities: readonly EntityRow[]
  crops: readonly CropRow[]
  year: number
}): PartnerPlanting[] {
  const fieldById = new Map(args.fields.map((f) => [f.id, f]))
  const farmById = new Map(args.farms.map((f) => [f.id, f]))
  const entityById = new Map(args.entities.map((e) => [e.id, e]))
  const cropById = new Map(args.crops.map((c) => [c.id, c]))
  return args.plantings
    .filter((p) => p.season_year === args.year)
    .map((p) => {
      const field = fieldById.get(p.field_id)
      const farm = field?.farm_id ? farmById.get(field.farm_id) : undefined
      const entity = farm?.entity_id ? entityById.get(farm.entity_id) : undefined
      return {
        id: p.id,
        field_id: p.field_id,
        field_name: field?.name_or_number ?? null,
        crop: cropById.get(p.crop_id)?.name ?? null,
        crop_year: p.season_year,
        planted_acres: num(p.planted_acres),
        irrigated_acres: num(p.irrigated_acres),
        dryland_acres: num(p.dryland_acres),
        entity: entity?.name ?? null,
        updated_at: p.updated_at ?? null,
      }
    })
    .sort((a, b) => (a.entity ?? '').localeCompare(b.entity ?? '') || (a.field_name ?? '').localeCompare(b.field_name ?? ''))
}

// ---------------------------------------------------------------------------
// GET /production?year=&crop=
// ---------------------------------------------------------------------------

export type PartnerProduction = {
  field_id: string
  field_name: string | null
  entity: string | null
  crop: string | null
  crop_year: number
  planted_acres: number | null
  /** Planted acres once the field has produced anything, else 0 — Grain
   *  Tracker records production per load, not a per-field harvested-acre
   *  figure, so "harvested" is inferred from production > 0. */
  harvested_acres: number | null
  production_units: number
  unit: 'bu' | 'lbs'
  updated_at: string | null
}

// Grain production = the Yields pages' math: dry bushels per field × crop from
// field-sourced loads (shrink applied via computeBushels) plus split
// allocations, filtered on loads.crop_year. Cotton production = lint lbs from
// gin receipts (receipts carry no crop_id; they attach to the field's cotton
// planting for the year).
export function buildProductionRecords(args: {
  plantings: readonly PlantingRow[]
  loads: readonly LoadRow[]
  splits: readonly SplitRow[]
  ginReceipts: readonly GinReceiptRow[]
  fields: readonly FieldRow[]
  farms: readonly FarmRow[]
  entities: readonly EntityRow[]
  crops: readonly CropRow[]
  year: number
  crop?: string | null
}): PartnerProduction[] {
  const fieldById = new Map(args.fields.map((f) => [f.id, f]))
  const farmById = new Map(args.farms.map((f) => [f.id, f]))
  const entityById = new Map(args.entities.map((e) => [e.id, e]))
  const cropById = new Map(args.crops.map((c) => [c.id, c]))
  const loadById = new Map(args.loads.map((l) => [l.id, l]))

  // field|crop → { units, updated_at }
  const agg = new Map<string, { units: number; updatedAt: string | null }>()
  const bump = (fieldId: string, cropId: string, units: number, updatedAt: string | null | undefined) => {
    const key = `${fieldId}|${cropId}`
    const cur = agg.get(key)
    if (cur) {
      cur.units += units
      cur.updatedAt = maxIso(cur.updatedAt, updatedAt)
    } else {
      agg.set(key, { units, updatedAt: updatedAt ?? null })
    }
  }

  for (const l of args.loads) {
    if (l.from_type !== 'field' || !l.from_field_id || !l.crop_id) continue
    if (l.crop_year !== args.year) continue
    const crop = cropById.get(l.crop_id)
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (!dryBushels) continue
    bump(l.from_field_id, l.crop_id, dryBushels, l.updated_at)
  }
  for (const s of args.splits) {
    const parent = loadById.get(s.load_id)
    if (!parent || parent.crop_year !== args.year || s.dry_bushels == null) continue
    bump(s.field_id, s.crop_id, num(s.dry_bushels), parent.updated_at)
  }

  // Cotton lint lbs per field from gin receipts → the field's cotton planting.
  const cottonByField = new Map<string, { units: number; updatedAt: string | null }>()
  for (const r of args.ginReceipts) {
    if (!r.field_id || r.crop_year !== args.year || r.total_bale_weight == null) continue
    const cur = cottonByField.get(r.field_id)
    if (cur) {
      cur.units += num(r.total_bale_weight)
      cur.updatedAt = maxIso(cur.updatedAt, r.updated_at)
    } else {
      cottonByField.set(r.field_id, { units: num(r.total_bale_weight), updatedAt: r.updated_at ?? null })
    }
  }

  const cropFilter = (name: string | null): boolean =>
    !args.crop || (name ?? '').toLowerCase() === args.crop.toLowerCase()

  const out: PartnerProduction[] = []
  const covered = new Set<string>()

  const rowFor = (
    fieldId: string,
    cropId: string,
    plantedAcres: number | null,
    plantingUpdatedAt: string | null | undefined,
  ): PartnerProduction | null => {
    const field = fieldById.get(fieldId)
    const farm = field?.farm_id ? farmById.get(field.farm_id) : undefined
    const entity = farm?.entity_id ? entityById.get(farm.entity_id) : undefined
    const cropName = cropById.get(cropId)?.name ?? null
    if (!cropFilter(cropName)) return null
    const cotton = isCottonCrop(cropName)
    const a = cotton ? cottonByField.get(fieldId) : agg.get(`${fieldId}|${cropId}`)
    const units = a?.units ?? 0
    return {
      field_id: fieldId,
      field_name: field?.name_or_number ?? null,
      entity: entity?.name ?? null,
      crop: cropName,
      crop_year: args.year,
      planted_acres: plantedAcres,
      harvested_acres: plantedAcres == null ? null : units > 0 ? plantedAcres : 0,
      production_units: Math.round(units * 100) / 100,
      unit: cotton ? 'lbs' : 'bu',
      updated_at: maxIso(a?.updatedAt, plantingUpdatedAt),
    }
  }

  for (const p of args.plantings) {
    if (p.season_year !== args.year) continue
    covered.add(`${p.field_id}|${p.crop_id}`)
    const row = rowFor(p.field_id, p.crop_id, num(p.planted_acres), p.updated_at)
    if (row) out.push(row)
  }
  // Production with no planting row (data-entry gap) still reports — acres null.
  for (const key of agg.keys()) {
    if (covered.has(key)) continue
    const [fieldId, cropId] = key.split('|')
    const row = rowFor(fieldId, cropId, null, null)
    if (row) out.push(row)
  }

  return out.sort(
    (a, b) =>
      (a.entity ?? '').localeCompare(b.entity ?? '') ||
      (a.crop ?? '').localeCompare(b.crop ?? '') ||
      (a.field_name ?? '').localeCompare(b.field_name ?? ''),
  )
}

// ---------------------------------------------------------------------------
// GET /settlements?since=
// ---------------------------------------------------------------------------

export type SettlementRow = {
  id: string
  buyer_id: string
  settlement_date: string
  settlement_number: string | null
  updated_at?: string | null
}
export type SettlementLineRow = {
  id: string
  settlement_id: string
  load_id: string | null
  net_bushels: number | string | null
  net_revenue: number | string | null
  updated_at?: string | null
}
export type BuyerRow = { id: string; name: string }

export type PartnerSettlement = {
  /** `${settlement_id}:${crop key}` — a mixed-crop settlement returns one
   *  record per crop so units/revenue attribute correctly. */
  id: string
  settlement_id: string
  settlement_date: string
  settlement_number: string | null
  buyer: string | null
  /** Crop of the lines' matched loads; null when the lines matched no load. */
  crop: string | null
  net_units: number
  unit: 'bu'
  net_revenue: number
  updated_at: string | null
}

export function buildSettlementRecords(args: {
  settlements: readonly SettlementRow[]
  lines: readonly SettlementLineRow[]
  loads: ReadonlyArray<{ id: string; crop_id: string | null }>
  crops: readonly CropRow[]
  buyers: readonly BuyerRow[]
  /** ISO date/timestamp; keep records whose updated_at >= since (delta-sync). */
  since?: string | null
}): PartnerSettlement[] {
  const buyerById = new Map(args.buyers.map((b) => [b.id, b.name]))
  const cropById = new Map(args.crops.map((c) => [c.id, c]))
  const loadCrop = new Map(args.loads.map((l) => [l.id, l.crop_id]))
  const linesBySettlement = new Map<string, SettlementLineRow[]>()
  for (const line of args.lines) {
    const list = linesBySettlement.get(line.settlement_id)
    if (list) list.push(line)
    else linesBySettlement.set(line.settlement_id, [line])
  }

  const out: PartnerSettlement[] = []
  for (const s of args.settlements) {
    const lines = linesBySettlement.get(s.id) ?? []
    // Group the settlement's lines by the matched load's crop.
    const byCrop = new Map<string, { units: number; revenue: number; updatedAt: string | null }>()
    for (const line of lines) {
      const cropId = line.load_id ? loadCrop.get(line.load_id) ?? null : null
      const key = cropId ?? ''
      const cur = byCrop.get(key) ?? { units: 0, revenue: 0, updatedAt: null }
      cur.units += num(line.net_bushels)
      cur.revenue += num(line.net_revenue)
      cur.updatedAt = maxIso(cur.updatedAt, line.updated_at)
      byCrop.set(key, cur)
    }
    if (byCrop.size === 0) byCrop.set('', { units: 0, revenue: 0, updatedAt: null })
    for (const [cropId, sums] of byCrop) {
      const updated = maxIso(s.updated_at, sums.updatedAt)
      out.push({
        id: `${s.id}:${cropId || 'unmatched'}`,
        settlement_id: s.id,
        settlement_date: s.settlement_date,
        settlement_number: s.settlement_number,
        buyer: buyerById.get(s.buyer_id) ?? null,
        crop: cropId ? cropById.get(cropId)?.name ?? null : null,
        net_units: Math.round(sums.units * 100) / 100,
        unit: 'bu',
        net_revenue: Math.round(sums.revenue * 100) / 100,
        updated_at: updated,
      })
    }
  }

  const since = args.since ?? null
  const filtered = since ? out.filter((r) => r.updated_at != null && r.updated_at >= since) : out
  return filtered.sort((a, b) => a.settlement_date.localeCompare(b.settlement_date) || a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// GET /hedging?year=&crop=  — REALIZED results only, never open positions
// ---------------------------------------------------------------------------

export type FuturesPositionRow = {
  id: string
  commodity: string
  contract_symbol: string
  crop_year: number
  side: string
  num_contracts: number
  status: string
  close_date: string | null
  realized_pnl: number | string | null
  updated_at?: string | null
}
export type OptionsPositionRow = {
  id: string
  commodity: string
  underlying_symbol: string
  option_type: string
  strike_price: number | string
  crop_year: number
  num_contracts: number
  status: string
  close_date: string | null
  realized_pnl: number | string | null
  updated_at?: string | null
}

export type PartnerHedgeTransaction = {
  id: string
  type: 'futures' | 'option'
  close_date: string | null
  /** Instrument reference, e.g. 'ZCZ26' or 'ZCZ26 4.80 put'. */
  contract: string
  crop: string
  crop_year: number
  units: number
  unit: 'bu' | 'lbs'
  /** Net of commissions and fees (stored that way when the position closes). */
  realized_gain_loss: number
  updated_at: string | null
}

export type PartnerHedgeTotal = {
  crop: string
  crop_year: number
  net_realized: number
  transaction_count: number
}

export type PartnerHedging = {
  transactions: PartnerHedgeTransaction[]
  totals: PartnerHedgeTotal[]
}

const CLOSED_OPTION_STATUSES = new Set(['closed_offset', 'expired_worthless', 'exercised'])

export function buildHedgingRecords(args: {
  futures: readonly FuturesPositionRow[]
  options: readonly OptionsPositionRow[]
  year?: number | null
  crop?: string | null
}): PartnerHedging {
  const wantCrop = (commodity: string): boolean => {
    if (!args.crop) return true
    const want = args.crop.toLowerCase()
    const have = commodity.toLowerCase()
    return have === want || have.includes(want) || want.includes(have)
  }
  const wantYear = (y: number): boolean => args.year == null || y === args.year

  const txns: PartnerHedgeTransaction[] = []

  for (const p of args.futures) {
    // Realized only: closed positions with a booked result. Open positions are
    // never exposed here.
    if (p.status !== 'closed' || p.realized_pnl == null) continue
    if (!wantYear(p.crop_year) || !wantCrop(p.commodity)) continue
    txns.push({
      id: p.id,
      type: 'futures',
      close_date: p.close_date,
      contract: p.contract_symbol,
      crop: p.commodity,
      crop_year: p.crop_year,
      units: quantityFor(p.commodity, p.num_contracts),
      unit: contractUnit(p.commodity),
      realized_gain_loss: num(p.realized_pnl),
      updated_at: p.updated_at ?? null,
    })
  }
  for (const o of args.options) {
    // Exercised options that converted into a futures position may carry no
    // realized_pnl of their own (the result books on the futures leg) — those
    // are skipped rather than reported as $0.
    if (!CLOSED_OPTION_STATUSES.has(o.status) || o.realized_pnl == null) continue
    if (!wantYear(o.crop_year) || !wantCrop(o.commodity)) continue
    txns.push({
      id: o.id,
      type: 'option',
      close_date: o.close_date,
      contract: `${o.underlying_symbol} ${num(o.strike_price)} ${o.option_type}`,
      crop: o.commodity,
      crop_year: o.crop_year,
      units: quantityFor(o.commodity, o.num_contracts),
      unit: contractUnit(o.commodity),
      realized_gain_loss: num(o.realized_pnl),
      updated_at: o.updated_at ?? null,
    })
  }

  txns.sort((a, b) => (a.close_date ?? '').localeCompare(b.close_date ?? '') || a.id.localeCompare(b.id))

  const totalsMap = new Map<string, PartnerHedgeTotal>()
  for (const t of txns) {
    const key = `${t.crop}|${t.crop_year}`
    const cur = totalsMap.get(key)
    if (cur) {
      cur.net_realized += t.realized_gain_loss
      cur.transaction_count += 1
    } else {
      totalsMap.set(key, { crop: t.crop, crop_year: t.crop_year, net_realized: t.realized_gain_loss, transaction_count: 1 })
    }
  }
  const totals = [...totalsMap.values()]
    .map((t) => ({ ...t, net_realized: Math.round(t.net_realized * 100) / 100 }))
    .sort((a, b) => a.crop_year - b.crop_year || a.crop.localeCompare(b.crop))

  return { transactions: txns, totals }
}

// ---------------------------------------------------------------------------
// GET /crop-year-status?year=
// ---------------------------------------------------------------------------

export type SalesStatusRow = {
  crop_id: string
  crop_year: number
  physical_sales_complete: boolean
  updated_at?: string | null
}
export type BaleRow = {
  id: string
  gin_receipt_id: string
  crop_year: number
  net_weight_lbs: number | string
  updated_at?: string | null
}
export type BaleDispositionRow = {
  bale_id: string
  disposition: string // 'sold_spot' | 'contract_delivery' | 'pool' | 'ccc_loan' | 'held'
  loan_id: string | null
}
export type CccLoanRow = { id: string; status: string } // 'open' | 'redeemed' | 'equity_sold' | 'forfeited'

export type PartnerCropYearStatus = {
  crop: string
  crop_year: number
  unit: 'bu' | 'lbs'
  production_units: number
  settled_units: number
  unsold_units: number
  /** production > 0 and settled covers it (shrink/residuals often keep this
   *  from ever flipping true — that's what the manual flag is for). */
  computed_all_sold: boolean
  /** The Settings → Crops manual "physical sales complete" flag. */
  manually_marked_complete: boolean
  /** computed_all_sold OR manually_marked_complete. */
  all_physical_sold: boolean
  updated_at: string | null
}

// Grain: production = dry bu from field loads (+ splits); settled = settlement
// line net bushels attributed via the matched load's crop. Cotton: production =
// lint lbs from gin receipts; "settled" = lbs of bales in a terminal sold state
// (sold spot / delivered on contract / pool, or in a loan that equity-sold or
// forfeited — the merchant/CCC owns those bales).
export function buildCropYearStatus(args: {
  plantings: readonly PlantingRow[]
  loads: readonly LoadRow[]
  splits: readonly SplitRow[]
  crops: readonly CropRow[]
  lines: readonly SettlementLineRow[]
  /** load id → crop id/year for settlement-line attribution (all years). */
  settlementLoads: ReadonlyArray<{ id: string; crop_id: string | null; crop_year: number | null }>
  ginReceipts: readonly GinReceiptRow[]
  bales: readonly BaleRow[]
  baleDispositions: readonly BaleDispositionRow[]
  cccLoans: readonly CccLoanRow[]
  salesStatus: readonly SalesStatusRow[]
  year: number
}): PartnerCropYearStatus[] {
  const cropById = new Map(args.crops.map((c) => [c.id, c]))

  // crop_id → aggregate
  const acc = new Map<string, { produced: number; settled: number; updatedAt: string | null }>()
  const entry = (cropId: string) => {
    let e = acc.get(cropId)
    if (!e) {
      e = { produced: 0, settled: 0, updatedAt: null }
      acc.set(cropId, e)
    }
    return e
  }

  // --- Grain production (same math as buildProductionRecords) ---
  const loadById = new Map(args.loads.map((l) => [l.id, l]))
  for (const l of args.loads) {
    if (l.from_type !== 'field' || !l.from_field_id || !l.crop_id) continue
    if (l.crop_year !== args.year) continue
    const crop = cropById.get(l.crop_id)
    if (isCottonCrop(crop?.name)) continue
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (!dryBushels) continue
    const e = entry(l.crop_id)
    e.produced += dryBushels
    e.updatedAt = maxIso(e.updatedAt, l.updated_at)
  }
  for (const s of args.splits) {
    const parent = loadById.get(s.load_id)
    if (!parent || parent.crop_year !== args.year || s.dry_bushels == null) continue
    if (isCottonCrop(cropById.get(s.crop_id)?.name)) continue
    const e = entry(s.crop_id)
    e.produced += num(s.dry_bushels)
    e.updatedAt = maxIso(e.updatedAt, parent.updated_at)
  }

  // --- Grain settled units (settlement lines via matched load's crop) ---
  const settlementLoadById = new Map(args.settlementLoads.map((l) => [l.id, l]))
  for (const line of args.lines) {
    if (!line.load_id) continue
    const load = settlementLoadById.get(line.load_id)
    if (!load?.crop_id || load.crop_year !== args.year) continue
    if (isCottonCrop(cropById.get(load.crop_id)?.name)) continue
    const e = entry(load.crop_id)
    e.settled += num(line.net_bushels)
    e.updatedAt = maxIso(e.updatedAt, line.updated_at)
  }

  // --- Cotton (lint lbs) ---
  const cottonCropIds = args.crops.filter((c) => isCottonCrop(c.name)).map((c) => c.id)
  // Cotton plantings tell us WHICH cotton crop id the year's lint belongs to
  // (receipts carry no crop_id). Fall back to the first cotton crop.
  const yearCottonCropId =
    args.plantings.find((p) => p.season_year === args.year && cottonCropIds.includes(p.crop_id))?.crop_id ??
    cottonCropIds[0] ??
    null
  if (yearCottonCropId) {
    const receiptIds = new Set<string>()
    for (const r of args.ginReceipts) {
      if (r.crop_year !== args.year) continue
      receiptIds.add(r.id)
      if (r.total_bale_weight == null) continue
      const e = entry(yearCottonCropId)
      e.produced += num(r.total_bale_weight)
      e.updatedAt = maxIso(e.updatedAt, r.updated_at)
    }
    if (receiptIds.size > 0) {
      const loanStatus = new Map(args.cccLoans.map((l) => [l.id, l.status]))
      const dispositionByBale = new Map(args.baleDispositions.map((d) => [d.bale_id, d]))
      const SOLD = new Set(['sold_spot', 'contract_delivery', 'pool'])
      for (const b of args.bales) {
        if (b.crop_year !== args.year || !receiptIds.has(b.gin_receipt_id)) continue
        const d = dispositionByBale.get(b.id)
        if (!d) continue
        const soldViaLoan =
          d.disposition === 'ccc_loan' &&
          d.loan_id != null &&
          ['equity_sold', 'forfeited'].includes(loanStatus.get(d.loan_id) ?? '')
        if (SOLD.has(d.disposition) || soldViaLoan) {
          const e = entry(yearCottonCropId)
          e.settled += num(b.net_weight_lbs)
          e.updatedAt = maxIso(e.updatedAt, b.updated_at)
        }
      }
    }
  }

  // --- Assemble, joining the manual flag ---
  const manualByCrop = new Map(
    args.salesStatus.filter((s) => s.crop_year === args.year).map((s) => [s.crop_id, s]),
  )
  const out: PartnerCropYearStatus[] = []
  for (const [cropId, e] of acc) {
    const crop = cropById.get(cropId)
    if (!crop) continue
    const manual = manualByCrop.get(cropId)
    const produced = Math.round(e.produced * 100) / 100
    const settled = Math.round(e.settled * 100) / 100
    const computed = produced > 0 && settled >= produced
    out.push({
      crop: crop.name,
      crop_year: args.year,
      unit: isCottonCrop(crop.name) ? 'lbs' : 'bu',
      production_units: produced,
      settled_units: settled,
      unsold_units: Math.round((produced - settled) * 100) / 100,
      computed_all_sold: computed,
      manually_marked_complete: manual?.physical_sales_complete ?? false,
      all_physical_sold: computed || (manual?.physical_sales_complete ?? false),
      updated_at: maxIso(e.updatedAt, manual?.updated_at),
    })
  }
  return out.sort((a, b) => a.crop.localeCompare(b.crop))
}
