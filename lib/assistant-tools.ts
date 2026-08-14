// "Ask Turnrow" — the data assistant's curated tools.
//
// TENANT ISOLATION IS POSTGRES RLS, NOT PROMPT LANGUAGE. Every tool runs its
// fetches through the USER'S OWN session client (their JWT via
// lib/supabase/server) — never the service role — so the 054 org-isolation
// and 042/052/061 role policies filter every row before any engine sees it.
// A viewer's assistant sees only their granted entities; an agronomist's only
// the Yields read surface; another org's data simply does not exist here.
//
// The curated tools reuse the SAME tested lib engines the report pages run
// (computeMarketing, fieldCropAggregates, projectInsuranceIndemnities,
// projectPayments, computeRevenueProjections, the bin-inventory bag…), with
// the same derivation chains, so the assistant's numbers match the reports —
// with ONE stated exception: no live futures quotes are fetched server-side,
// so prices fall back to stored positions/assumptions (each tool's output
// says so in `price_basis`).

import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'
import { buildEntityScope } from '@/lib/entity-scope'
import {
  aggregateMarketing,
  computeMarketing,
  expectedProductionFromBreakout,
  isCottonCrop,
  segmentAcresByCrop,
  type MarketingRow,
  type Planting,
} from '@/lib/marketing'
import { buildDoubleCropSet } from '@/lib/plantings'
import {
  cropsWithCompleteHarvest,
  fieldCropAggregates,
  withLoadBreakouts,
} from '@/lib/yields'
import { computeBushels } from '@/lib/shrink'
import {
  actualYieldByCropFromLoads,
  projectInsuranceIndemnities,
} from '@/lib/crop-insurance'
import {
  applyMyaResolution,
  expectedArcPlcDate,
  otherPaymentsInRevenueYear,
  programYearFor,
  projectPayments,
} from '@/lib/government-payments'
import { computeRevenueProjections, type GovtProceeds, type InsuranceProceeds } from '@/lib/revenue-projections'
import { resolveProgramYearConfig } from '@/lib/program-config'
import { unrealizedPnl, optionUnrealizedPnl, quantityFor, pnlSizeFor, contractUnit } from '@/lib/hedging'
import { applyCombineRemainders, applyTransfers, cellFor, cellTotal, type OnHandBag } from '@/lib/bin-inventory'
import { truckExportLabel } from '@/lib/trucks'
import { validateAssistantSql } from '@/lib/assistant-sql'
import { fetchCottonPhysical } from '@/lib/cotton-physical-fetch'
import type {
  AppRole,
  Contract,
  Crop,
  CropAssumption,
  FieldPlanting,
  FuturesPosition,
  OptionPosition,
} from '@/lib/types'

export type AssistantContext = {
  role: AppRole
  /** Viewer grants (null for non-viewers) — same fail-closed semantics as
   *  buildEntityScope; RLS enforces regardless, this keeps the attribution
   *  math identical to what the viewer's reports show. */
  grantedEntityIds: string[] | null
}

const PRICE_BASIS = 'stored positions and assumptions — not live futures quotes; the report pages layer live quotes on top'

// ---------- shared fetch helpers ----------

async function all<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return ((data as unknown) as T[]) ?? []
}

/** Paginated full-table read (the project caps rows per request). */
async function allPaged<T>(supabase: SupabaseClient, table: string, select: string, page = 1000): Promise<T[]> {
  const out: T[] = []
  for (let fromIdx = 0; ; fromIdx += page) {
    const { data, error } = await supabase.from(table).select(select).range(fromIdx, fromIdx + page - 1)
    if (error) throw new Error(error.message)
    const rows = ((data as unknown) as T[]) ?? []
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
}

// The combine-entry columns every report page fetches (CombineEntryLike).
const COMBINE_SELECT = 'id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date'
type CombineRow = {
  id: string; field_id: string; crop_id: string; crop_year: number
  stated_total_bushels: number; adjusted_total_bushels: number
  adjustment_bu_per_acre: number | null; destination_bin_id: string | null
  harvest_complete: boolean; entry_date: string
}

const num = (v: unknown) => Number(v) || 0
const r0 = (v: number) => Math.round(v)
const r2 = (v: number) => Math.round(v * 100) / 100

type ScopeBits = {
  entities: Array<{ id: string; name: string; entity_role: string | null }>
  farms: Array<{ id: string; name: string; entity_id: string | null; landowner_id: string | null }>
  fields: Array<{ id: string; farm_id: string | null; name_or_number: string }>
}

async function fetchScopeBits(supabase: SupabaseClient): Promise<ScopeBits> {
  const [entities, farms, fields] = await Promise.all([
    all<ScopeBits['entities'][number]>(supabase.from('entities').select('id, name, entity_role').order('name')),
    all<ScopeBits['farms'][number]>(supabase.from('farms').select('id, name, entity_id, landowner_id')),
    all<ScopeBits['fields'][number]>(supabase.from('fields').select('id, farm_id, name_or_number')),
  ])
  return { entities, farms, fields }
}

function resolveEntityId(bits: ScopeBits, entityName: string | undefined): { entityId: string; note: string | null } {
  if (!entityName?.trim()) return { entityId: '', note: null }
  const norm = entityName.trim().toLowerCase()
  const hit = bits.entities.find((e) => e.name.trim().toLowerCase() === norm)
    ?? bits.entities.find((e) => e.name.trim().toLowerCase().includes(norm))
  if (!hit) return { entityId: '', note: `No entity named "${entityName}" — showing the whole operation. Entities: ${bits.entities.map((e) => e.name).join(', ') || 'none'}.` }
  return { entityId: hit.id, note: null }
}

// ---------- the marketing bundle (shared by marketing + revenue tools) ----------

type MarketingBundle = {
  rows: MarketingRow[]
  totals: ReturnType<typeof aggregateMarketing>
  scope: ReturnType<typeof buildEntityScope>
  scopedContracts: Contract[]
  crops: Crop[]
  entityNote: string | null
}

async function loadMarketingBundle(
  supabase: SupabaseClient,
  ctx: AssistantContext,
  cropYear: number,
  entityName?: string,
): Promise<MarketingBundle> {
  const bits = await fetchScopeBits(supabase)
  const { entityId, note } = resolveEntityId(bits, entityName)
  const [crops, plantings, contracts, futures, options, assumptions, loads, splits, ginReceipts, cottonBales, combineEntries] = await Promise.all([
    all<Crop>(supabase.from('crops').select('*').order('name')),
    all<FieldPlanting>(supabase.from('field_plantings').select('*')),
    all<Contract>(supabase.from('contracts').select('*').eq('crop_year', cropYear)),
    all<FuturesPosition>(supabase.from('futures_positions').select('*').eq('crop_year', cropYear)),
    all<OptionPosition>(supabase.from('options_positions').select('*').eq('crop_year', cropYear)),
    all<CropAssumption>(supabase.from('crop_assumptions').select('*')),
    allPaged<{ id: string; date: string; crop_id: string | null; crop_year: number | null; from_type: string | null; from_field_id: string | null; net_weight: number | null; moisture: number | null; dry_bushels_override: number | null }>(
      supabase, 'loads', 'id, date, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override'),
    all<{ load_id: string; field_id: string; crop_id: string; dry_bushels: number }>(supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels')),
    all<{ id: string; crop_year: number; bales_count: number | null; total_bale_weight: number | null; entity_id: string | null; farm_id: string | null; field_id: string | null }>(
      supabase.from('gin_receipts').select('id, crop_year, bales_count, total_bale_weight, entity_id, farm_id, field_id').eq('crop_year', cropYear)),
    all<{ gin_receipt_id: string; net_weight_lbs: number | null }>(supabase.from('cotton_bales').select('gin_receipt_id, net_weight_lbs').eq('crop_year', cropYear)),
    all<CombineRow>(
      supabase.from('combine_yield_entries').select(COMBINE_SELECT).eq('crop_year', cropYear)),
  ])
  const scope = buildEntityScope({ entityId, farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const scopedPlantings = scope.plantings(plantings)
  const attribution = scope.attribution({ plantings, crops })
  const cropById = new Map(crops.map((c) => [c.id, c]))
  const doubleCropIds = buildDoubleCropSet(plantings, cropById)
  const segByCrop = segmentAcresByCrop(scopedPlantings, cropYear, doubleCropIds)
  const expProdByCrop = expectedProductionFromBreakout(segByCrop, assumptions, cropYear)
  const aggByKey = scope.fieldAgg(fieldCropAggregates(loads, splits, cropById, { cropYear, combineEntries }))
  const production = new Map<string, number>()
  for (const [key, agg] of aggByKey) {
    const cropId = key.split('|')[1]
    if (cropId) production.set(cropId, (production.get(cropId) ?? 0) + agg.dryBu)
  }
  const cropCompleteKeys = new Set<string>()
  for (const a of assumptions) if (a.harvest_complete) cropCompleteKeys.add(`${a.crop_id}|${a.crop_year}`)
  const harvestCompleteIds = cropsWithCompleteHarvest({ plantings: scopedPlantings, aggByKey, cropYear, cropCompleteKeys })
  // Cotton actuals + physical marketing, exactly as the dashboard derives them.
  const balesByReceipt = new Map<string, { lbs: number; count: number }>()
  for (const b of cottonBales) {
    const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    g.lbs += num(b.net_weight_lbs); g.count += 1
    balesByReceipt.set(b.gin_receipt_id, g)
  }
  let lintLbs = 0, baleCount = 0
  for (const rct of scope.ginReceipts(ginReceipts)) {
    const fromBales = balesByReceipt.get(rct.id)
    lintLbs += fromBales && fromBales.lbs > 0 ? fromBales.lbs : num(rct.total_bale_weight)
    baleCount += fromBales && fromBales.count > 0 ? fromBales.count : num(rct.bales_count)
  }
  const cottonProd = new Map<string, { lintLbs: number; bales: number }>()
  for (const c of crops) if (isCottonCrop(c.name)) cottonProd.set(c.id, { lintLbs, bales: baleCount })
  let cottonPhysical = new Map<string, import('@/lib/cotton-sales').CottonPhysicalSummary>()
  try {
    const raw = await fetchCottonPhysical(supabase, cropYear)
    const summary = attribution.cottonSummary(raw.inputs)
    if (summary) for (const c of crops) if (isCottonCrop(c.name)) cottonPhysical.set(c.id, summary)
  } catch { cottonPhysical = new Map() }

  const scopedContracts = attribution.contracts(contracts)
  const rows = computeMarketing({
    cropYear,
    crops,
    plantings: scopedPlantings
      .filter((p) => p.season_year === cropYear)
      .map((p): Planting => ({ crop_id: p.crop_id, season_year: p.season_year, planted_acres: p.planted_acres })),
    contracts: scopedContracts,
    futures: attribution.futures(futures),
    options: attribution.options(options),
    assumptions: assumptions.filter((a) => a.crop_year === cropYear),
    actualProductionByCrop: production,
    expectedProductionByCrop: expProdByCrop,
    harvestCompleteCropIds: harvestCompleteIds,
    cottonProductionByCrop: cottonProd,
    cottonPhysicalByCrop: cottonPhysical,
  })
  return { rows, totals: aggregateMarketing(rows), scope, scopedContracts, crops, entityNote: note }
}

function compactMarketingRow(r: MarketingRow) {
  return {
    crop: r.cropName,
    unit: r.unit, // 'bu' | 'lbs' (cotton = lbs of lint; cotton prices are ¢/lb)
    acres: r0(r.acres),
    yield_per_acre: r.yield != null ? r2(r.yield) : null,
    yield_basis: r.yieldLabel, // 'Est.' | 'Actual'
    total_production: r0(r.totalProduction),
    contracted: r0(r.contractedBu),
    unpriced: r0(r.unpricedBu),
    avg_cash_price: r.avgCashPrice != null ? r2(r.avgCashPrice) : null,
    avg_futures: r.avgFutures != null ? r2(r.avgFutures) : null,
    avg_basis: r.avgBasis != null ? r2(r.avgBasis) : null,
    blended_avg_price: r.totalAvgPrice != null ? r2(r.totalAvgPrice) : null,
    blended_revenue_usd: r0(r.blendedRevenue),
    cost_per_acre_usd: r.costPerAcre != null ? r2(r.costPerAcre) : null,
    profit_per_acre_usd: r.profitPerAcre != null ? r2(r.profitPerAcre) : null,
    total_profit_usd: r.totalProfit != null ? r0(r.totalProfit) : null,
  }
}

// ---------- tool implementations ----------

async function getMarketingSummary(supabase: SupabaseClient, ctx: AssistantContext, input: { crop_year: number; entity?: string }) {
  const b = await loadMarketingBundle(supabase, ctx, input.crop_year, input.entity)
  return {
    crop_year: input.crop_year,
    entity_note: b.entityNote,
    price_basis: PRICE_BASIS,
    crops: b.rows.map(compactMarketingRow),
    totals: {
      acres: r0(b.totals.acres),
      total_production_bu: r0(b.totals.totalProduction),
      total_production_lbs_cotton: r0(b.totals.totalProductionLbs),
      blended_revenue_usd: r0(b.totals.blendedRevenue),
      total_cost_usd: r0(b.totals.totalCost),
      total_profit_usd: b.totals.totalProfit != null ? r0(b.totals.totalProfit) : null,
    },
  }
}

async function getYields(supabase: SupabaseClient, ctx: AssistantContext, input: { crop_year: number; grouping?: 'field' | 'farm' | 'entity' | 'crop' | 'landowner'; crop?: string }) {
  const grouping = input.grouping ?? 'field'
  const bits = await fetchScopeBits(supabase)
  const [crops, plantings, loads, splits, combineEntries, landowners] = await Promise.all([
    all<Crop>(supabase.from('crops').select('*')),
    all<FieldPlanting>(supabase.from('field_plantings').select('*')),
    allPaged<{ id: string; date: string; crop_id: string | null; crop_year: number | null; from_type: string | null; from_field_id: string | null; net_weight: number | null; moisture: number | null; dry_bushels_override: number | null }>(
      supabase, 'loads', 'id, date, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override'),
    all<{ load_id: string; field_id: string; crop_id: string; dry_bushels: number }>(supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels')),
    all<CombineRow>(
      supabase.from('combine_yield_entries').select(COMBINE_SELECT)),
    all<{ id: string; name: string }>(supabase.from('landowners').select('id, name')),
  ])
  const scope = buildEntityScope({ entityId: '', farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const cropById = new Map(crops.map((c) => [c.id, c]))
  const aggByKey = scope.fieldAgg(fieldCropAggregates(loads, splits, cropById, { cropYear: input.crop_year, combineEntries }))
  const fieldById = new Map(bits.fields.map((f) => [f.id, f]))
  const farmById = new Map(bits.farms.map((f) => [f.id, f]))
  const entityById = new Map(bits.entities.map((e) => [e.id, e]))
  const landownerById = new Map(landowners.map((l) => [l.id, l]))
  const cropFilter = input.crop?.trim().toLowerCase() || null

  type Row = { group: string; crop: string; acres: number; dry_bu: number }
  const grouped = new Map<string, Row>()
  for (const p of scope.plantings(plantings)) {
    if (p.season_year !== input.crop_year) continue
    const crop = cropById.get(p.crop_id)
    if (!crop) continue
    if (cropFilter && !crop.name.toLowerCase().includes(cropFilter)) continue
    const field = fieldById.get(p.field_id)
    const farm = field?.farm_id ? farmById.get(field.farm_id) : undefined
    const groupName =
      grouping === 'field' ? `${field?.name_or_number ?? '?'}${farm ? ` (${farm.name})` : ''}`
      : grouping === 'farm' ? farm?.name ?? 'No farm'
      : grouping === 'entity' ? (farm?.entity_id ? entityById.get(farm.entity_id)?.name ?? 'No entity' : 'No entity')
      : grouping === 'landowner' ? (farm?.landowner_id ? landownerById.get(farm.landowner_id)?.name ?? 'No landowner' : 'Owned / no landowner')
      : crop.name
    const key = `${groupName}|${crop.name}`
    const row = grouped.get(key) ?? { group: groupName, crop: crop.name, acres: 0, dry_bu: 0 }
    row.acres += num(p.planted_acres)
    row.dry_bu += aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)?.dryBu ?? 0
    grouped.set(key, row)
  }
  const rows = [...grouped.values()]
    .map((r) => ({ ...r, acres: r0(r.acres), dry_bu: r0(r.dry_bu), yield_per_acre: r.acres > 0 && r.dry_bu > 0 ? r2(r.dry_bu / r.acres) : null }))
    .sort((a, b) => (b.dry_bu - a.dry_bu))
  return {
    crop_year: input.crop_year,
    grouping,
    unit: 'dry bushels (grain); cotton is NOT in these rows — ask about gin receipts for cotton lbs',
    note: 'Combine-monitor entries replace weighed loads for their field, so bushels can exceed hauled loads. In-progress fields are included.',
    rows: rows.slice(0, 120),
    truncated: rows.length > 120 ? rows.length - 120 : 0,
  }
}

async function getRevenueProjection(supabase: SupabaseClient, ctx: AssistantContext, input: { crop_year: number; entity?: string }) {
  const cropYear = input.crop_year
  const b = await loadMarketingBundle(supabase, ctx, cropYear, input.entity)
  const [policies, scos, ecos, staxes, mcos, assumptions, plantings, loads, splits, combineEntries, estimates, programConfigs, countyAssumptions, commodities, baseAcres, elections, priceData, arcPayments, otherPayments, crops] = await Promise.all([
    all<import('@/lib/types').CropInsurancePolicy>(supabase.from('crop_insurance_policies').select('*').eq('crop_year', cropYear)),
    all<import('@/lib/types').CropInsuranceSco>(supabase.from('crop_insurance_sco').select('*')),
    all<import('@/lib/types').CropInsuranceEco>(supabase.from('crop_insurance_eco').select('*')),
    all<import('@/lib/types').CropInsuranceStax>(supabase.from('crop_insurance_stax').select('*')),
    all<import('@/lib/types').CropInsuranceMco>(supabase.from('crop_insurance_mco').select('*')),
    all<CropAssumption>(supabase.from('crop_assumptions').select('*')),
    all<FieldPlanting>(supabase.from('field_plantings').select('*')),
    allPaged<{ id: string; date: string; crop_id: string | null; crop_year: number | null; from_type: string | null; from_field_id: string | null; net_weight: number | null; moisture: number | null; dry_bushels_override: number | null }>(
      supabase, 'loads', 'id, date, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override'),
    all<{ load_id: string; field_id: string; crop_id: string; dry_bushels: number }>(supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels')),
    all<CombineRow>(
      supabase.from('combine_yield_entries').select(COMBINE_SELECT)),
    all<import('@/lib/types').HarvestPriceEstimate>(supabase.from('harvest_price_estimates').select('*').order('price_date', { ascending: false })),
    all<import('@/lib/types').ProgramYearConfig>(supabase.from('program_year_config').select('*')),
    all<import('@/lib/types').CountyYieldAssumption>(supabase.from('county_yield_assumptions').select('*')),
    all<import('@/lib/types').CoveredCommodity>(supabase.from('covered_commodities').select('*')),
    all<import('@/lib/types').FarmBaseAcres>(supabase.from('farm_base_acres').select('*')),
    all<import('@/lib/types').ArcPlcElection>(supabase.from('arc_plc_elections').select('*')),
    all<import('@/lib/types').ArcPlcPriceData>(supabase.from('arc_plc_price_data').select('*')),
    all<import('@/lib/types').ArcPlcPayment>(supabase.from('arc_plc_payments').select('*')),
    all<import('@/lib/types').OtherGovernmentPayment>(supabase.from('other_government_payments').select('*')),
    all<Crop>(supabase.from('crops').select('*')),
  ])
  const cropById = new Map(crops.map((c) => [c.id, c]))
  // Insurance per crop via the shared projector (assumed yields resolve inside).
  const scopedPolicies = b.scope.byEntity(policies)
  const effPlantings = withLoadBreakouts(
    plantings.filter((p) => p.season_year === cropYear),
    fieldCropAggregates(loads, splits, cropById, { cropYear, combineEntries }),
  )
  const actualYieldByCrop = actualYieldByCropFromLoads({ loads, plantings, crops, cropYear, combineEntries })
  const projected = projectInsuranceIndemnities({
    cropYear,
    policies: scopedPolicies,
    scos, ecos, staxes, mcos,
    assumptions,
    plantings: effPlantings,
    actualYieldByCrop,
    harvestEstimates: estimates,
    crops,
    scoTrigger: resolveProgramYearConfig(cropYear, programConfigs).scoTrigger,
    countyAssumptions,
  })
  const insuranceByCrop = new Map<string, InsuranceProceeds>()
  for (const p of projected) {
    const cur = insuranceByCrop.get(p.policy.crop_id) ?? { netPnl: 0, totalIndemnity: 0, premium: 0 }
    cur.netPnl += p.comp.netPnl
    cur.totalIndemnity += p.comp.totalIndemnity
    cur.premium += p.comp.premiumPaid
    insuranceByCrop.set(p.policy.crop_id, cur)
  }
  // Government per crop, allocated by acres — the report's recipe.
  const programYear = programYearFor(cropYear)
  const effPrice = applyMyaResolution({ cropYear: programYear, commodities, priceData, liveEstimates: new Map() })
  const projectedPayments = projectPayments({ cropYear: programYear, baseAcres, commodities, elections, priceData: effPrice, payments: arcPayments })
    .filter((p) => b.scope.farmInEntity(p.farmId))
  const totalArcPlc = projectedPayments.reduce((s, p) => s + p.result.net, 0)
  const yearOther = otherPaymentsInRevenueYear(b.scope.otherPayments(otherPayments), cropYear)
  const nonSpecificOther = yearOther.filter((o) => !o.crop_id).reduce((s, o) => s + num(o.amount), 0)
  const cropSpecific = new Map<string, number>()
  for (const o of yearOther) if (o.crop_id) cropSpecific.set(o.crop_id, (cropSpecific.get(o.crop_id) ?? 0) + num(o.amount))
  const totalAcres = b.rows.reduce((s, r) => s + r.acres, 0)
  const govtByCrop = new Map<string, GovtProceeds>()
  for (const r of b.rows) {
    const share = totalAcres > 0 ? r.acres / totalAcres : 0
    govtByCrop.set(r.cropId, { arcPlc: totalArcPlc * share, allocatedOther: nonSpecificOther * share, cropSpecificOther: cropSpecific.get(r.cropId) ?? 0 })
  }
  // Market price per crop from stored data (avg cash as the fallback tier).
  const marketPriceByCrop = new Map<string, number>()
  for (const r of b.rows) if (r.avgCashPrice != null) marketPriceByCrop.set(r.cropId, r.avgCashPrice)
  const { rows, totals } = computeRevenueProjections({ marketingRows: b.rows, contracts: b.scopedContracts, cropYear, marketPriceByCrop, insuranceByCrop, govtByCrop })
  return {
    crop_year: cropYear,
    entity_note: b.entityNote,
    price_basis: PRICE_BASIS,
    crops: rows.map((r) => ({
      crop: r.cropName, unit: r.unit, acres: r0(r.acres),
      total_production: r0(r.totalProduction),
      crop_sales_revenue_usd: r0(r.cropSalesRevenue),
      insurance_proceeds_usd: r0(r.insuranceProceeds),
      govt_payments_usd: r0(r.govtPayments),
      total_revenue_usd: r0(r.totalRevenue),
      revenue_per_acre_usd: r.revenuePerAcre != null ? r0(r.revenuePerAcre) : null,
    })),
    totals: {
      acres: r0(totals.acres),
      crop_sales_revenue_usd: r0(totals.cropSalesRevenue),
      insurance_proceeds_usd: r0(totals.insuranceProceeds),
      govt_payments_usd: r0(totals.govtPayments),
      total_revenue_usd: r0(totals.totalRevenue),
    },
  }
}

async function getContracts(supabase: SupabaseClient, _ctx: AssistantContext, input: { crop_year?: number; buyer?: string; status?: 'open' | 'complete' | 'future' }) {
  type ContractRow = Contract & { buyer: { name: string } | null; crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null }
  let q = supabase.from('contracts').select('*, buyer:buyers(name), crop:crops(name, base_moisture_pct, base_lb_per_bushel)').order('contract_number')
  if (input.crop_year != null) q = q.eq('crop_year', input.crop_year)
  const contracts = await all<ContractRow>(q)
  const loads = await allPaged<{ id: string; contract_id: string | null; ticket_number: string | null; net_weight: number | null; moisture: number | null; crop_id: string | null; dry_bushels_override: number | null }>(
    supabase, 'loads', 'id, contract_id, ticket_number, net_weight, moisture, crop_id, dry_bushels_override')
  const lines = await all<{ load_id: string | null; ticket_number: string | null; net_bushels: number | null; net_revenue: number | null }>(
    supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue'))
  const linesByLoad = new Map(lines.filter((l) => l.load_id).map((l) => [l.load_id as string, l]))
  const linesByTicket = new Map(lines.filter((l) => l.ticket_number).map((l) => [String(l.ticket_number).trim().toLowerCase(), l]))
  const today = new Date().toISOString().slice(0, 10)
  const buyerFilter = input.buyer?.trim().toLowerCase() || null
  const out = contracts
    .filter((c) => !buyerFilter || (c as ContractRow).buyer?.name?.toLowerCase().includes(buyerFilter))
    .map((c) => {
      let delivered = 0, paidBushels = 0, revenue = 0
      for (const l of loads) {
        if (l.contract_id !== c.id) continue
        const { dryBushels } = computeBushels({
          netWeightLb: l.net_weight, moisturePct: l.moisture,
          baseMoisturePct: c.crop?.base_moisture_pct ?? null, baseLbPerBushel: c.crop?.base_lb_per_bushel ?? null,
          dryBushelsOverride: l.dry_bushels_override,
        })
        if (!dryBushels) continue
        delivered += dryBushels
        const line = linesByLoad.get(l.id) ?? (l.ticket_number ? linesByTicket.get(l.ticket_number.trim().toLowerCase()) : undefined)
        if (line) { paidBushels += num(line.net_bushels); revenue += num(line.net_revenue) }
      }
      const contracted = num(c.contracted_bushels)
      const status = c.completed_at != null || (contracted > 0 && delivered >= contracted)
        ? 'complete'
        : c.delivery_start_date && c.delivery_start_date > today ? 'future' : 'open'
      return {
        contract_number: c.contract_number,
        buyer: (c as ContractRow).buyer?.name ?? null,
        crop: c.crop?.name ?? null,
        crop_year: c.crop_year,
        contract_type: c.contract_type,
        pricing_status: c.pricing_status,
        delivery_type: c.delivery_type,
        contracted_bu: r0(contracted),
        delivered_bu: r0(delivered),
        remaining_bu: r0(Math.max(0, contracted - delivered)),
        cash_price_per_bu: c.cash_price != null ? r2(num(c.cash_price)) : c.price_per_bushel != null ? r2(num(c.price_per_bushel)) : null,
        futures_price: c.futures_price != null ? r2(num(c.futures_price)) : null,
        basis: c.basis != null ? r2(num(c.basis)) : null,
        settled_bu: r0(paidBushels),
        settled_revenue_usd: r0(revenue),
        delivery_window: [c.delivery_start_date, c.delivery_end_date].filter(Boolean).join(' to ') || null,
        status,
      }
    })
    .filter((c) => !input.status || c.status === input.status)
  return { count: out.length, note: 'Grain contracts only (cotton has its own contracts under Cotton → Marketing). Prices $/bu.', contracts: out.slice(0, 80), truncated: out.length > 80 ? out.length - 80 : 0 }
}

async function getHedgingPositions(supabase: SupabaseClient, _ctx: AssistantContext, input: { crop_year?: number }) {
  let fq = supabase.from('futures_positions').select('*').order('trade_date', { ascending: false })
  let oq = supabase.from('options_positions').select('*').order('trade_date', { ascending: false })
  if (input.crop_year != null) { fq = fq.eq('crop_year', input.crop_year); oq = oq.eq('crop_year', input.crop_year) }
  const [futures, options, prices] = await Promise.all([
    all<FuturesPosition>(fq),
    all<OptionPosition>(oq),
    all<{ contract_symbol: string; price: number; price_date: string }>(
      supabase.from('market_prices').select('contract_symbol, price, price_date').order('price_date', { ascending: false })),
  ])
  const priceBySymbol = new Map<string, number>()
  for (const p of prices) if (!priceBySymbol.has(p.contract_symbol)) priceBySymbol.set(p.contract_symbol, num(p.price))
  type Sum = { crop_year: number | null; commodity: string; open_contracts: number; open_quantity: number; unit: string; unrealized_usd: number; realized_usd: number }
  const byKey = new Map<string, Sum>()
  const bump = (cropYear: number | null, commodity: string, fn: (s: Sum) => void) => {
    const key = `${cropYear}|${commodity}`
    const s = byKey.get(key) ?? { crop_year: cropYear, commodity, open_contracts: 0, open_quantity: 0, unit: contractUnit(commodity), unrealized_usd: 0, realized_usd: 0 }
    fn(s); byKey.set(key, s)
  }
  for (const p of futures) {
    if (p.status === 'open') {
      const u = unrealizedPnl({ side: p.side, tradePrice: num(p.trade_price), currentPrice: p.contract_symbol ? priceBySymbol.get(p.contract_symbol) ?? null : null, numContracts: num(p.num_contracts), contractSizeBu: pnlSizeFor(p.commodity) })
      bump(p.crop_year, p.commodity, (s) => { s.open_contracts += num(p.num_contracts); s.open_quantity += quantityFor(p.commodity, num(p.num_contracts)); s.unrealized_usd += u ?? 0 })
    } else {
      bump(p.crop_year, p.commodity, (s) => { s.realized_usd += num(p.realized_pnl) - num(p.commission) })
    }
  }
  for (const o of options) {
    if (o.status === 'open') {
      const u = optionUnrealizedPnl({ side: o.side, premiumCents: num(o.premium_cents), currentCents: null, numContracts: num(o.num_contracts) })
      bump(o.crop_year, o.commodity, (s) => { s.open_contracts += num(o.num_contracts); s.unrealized_usd += u ?? 0 })
    } else {
      bump(o.crop_year, o.commodity, (s) => { s.realized_usd += num(o.realized_pnl) })
    }
  }
  return {
    price_basis: 'last STORED market price per contract symbol (see Hedging for live quotes); open options valued at 0 change',
    positions: [...byKey.values()].map((s) => ({ ...s, open_quantity: r0(s.open_quantity), unrealized_usd: r0(s.unrealized_usd), realized_usd: r0(s.realized_usd) })),
    note: 'Cotton P&L uses $500/point; quantities are lbs for cotton, bushels for grains.',
  }
}

async function getInsuranceEstimates(supabase: SupabaseClient, ctx: AssistantContext, input: { crop_year: number }) {
  const cropYear = input.crop_year
  const bits = await fetchScopeBits(supabase)
  const scope = buildEntityScope({ entityId: '', farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const [crops, policies, scos, ecos, staxes, mcos, assumptions, plantings, loads, splits, combineEntries, estimates, programConfigs, countyAssumptions] = await Promise.all([
    all<Crop>(supabase.from('crops').select('*')),
    all<import('@/lib/types').CropInsurancePolicy>(supabase.from('crop_insurance_policies').select('*').eq('crop_year', cropYear)),
    all<import('@/lib/types').CropInsuranceSco>(supabase.from('crop_insurance_sco').select('*')),
    all<import('@/lib/types').CropInsuranceEco>(supabase.from('crop_insurance_eco').select('*')),
    all<import('@/lib/types').CropInsuranceStax>(supabase.from('crop_insurance_stax').select('*')),
    all<import('@/lib/types').CropInsuranceMco>(supabase.from('crop_insurance_mco').select('*')),
    all<CropAssumption>(supabase.from('crop_assumptions').select('*')),
    all<FieldPlanting>(supabase.from('field_plantings').select('*')),
    allPaged<{ id: string; date: string; crop_id: string | null; crop_year: number | null; from_type: string | null; from_field_id: string | null; net_weight: number | null; moisture: number | null; dry_bushels_override: number | null }>(
      supabase, 'loads', 'id, date, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override'),
    all<{ load_id: string; field_id: string; crop_id: string; dry_bushels: number }>(supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels')),
    all<CombineRow>(
      supabase.from('combine_yield_entries').select(COMBINE_SELECT)),
    all<import('@/lib/types').HarvestPriceEstimate>(supabase.from('harvest_price_estimates').select('*').order('price_date', { ascending: false })),
    all<import('@/lib/types').ProgramYearConfig>(supabase.from('program_year_config').select('*')),
    all<import('@/lib/types').CountyYieldAssumption>(supabase.from('county_yield_assumptions').select('*')),
  ])
  const cropById = new Map(crops.map((c) => [c.id, c]))
  const effPlantings = withLoadBreakouts(
    plantings.filter((p) => p.season_year === cropYear),
    fieldCropAggregates(loads, splits, cropById, { cropYear, combineEntries }),
  )
  const projected = projectInsuranceIndemnities({
    cropYear,
    policies: scope.byEntity(policies),
    scos, ecos, staxes, mcos,
    assumptions,
    plantings: effPlantings,
    actualYieldByCrop: actualYieldByCropFromLoads({ loads, plantings, crops, cropYear, combineEntries }),
    harvestEstimates: estimates,
    crops,
    scoTrigger: resolveProgramYearConfig(cropYear, programConfigs).scoTrigger,
    countyAssumptions,
  })
  return {
    crop_year: cropYear,
    price_basis: 'stored harvest-price estimates / RMA prices (the Claims Monitor layers live quotes)',
    policies: projected.map((p) => ({
      crop: cropById.get(p.policy.crop_id)?.name ?? p.policy.crop_id,
      plan: p.policy.plan_type,
      practice: p.policy.practice,
      coverage_level: num(p.policy.coverage_level),
      insured_acres: r0(num(p.policy.insured_acres)),
      assumed_yield: p.assumedYield != null ? r2(p.assumedYield) : null,
      harvest_price_used: r2(p.harvest.price),
      projected_indemnity_usd: r0(p.comp.totalIndemnity),
      premium_usd: r0(p.comp.premiumPaid),
      net_usd: r0(p.comp.netPnl),
      warnings: p.comp.warnings,
    })),
    total_net_usd: r0(projected.reduce((s, p) => s + p.comp.netPnl, 0)),
  }
}

async function getGovernmentPayments(supabase: SupabaseClient, ctx: AssistantContext, input: { year: number; year_basis?: 'revenue' | 'program' }) {
  const programYear = (input.year_basis ?? 'revenue') === 'revenue' ? programYearFor(input.year) : input.year
  const revenueYear = programYear + 1
  const bits = await fetchScopeBits(supabase)
  const scope = buildEntityScope({ entityId: '', farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const [commodities, baseAcres, elections, priceData, arcPayments, otherPayments, benchmarks, farms] = await Promise.all([
    all<import('@/lib/types').CoveredCommodity>(supabase.from('covered_commodities').select('*')),
    all<import('@/lib/types').FarmBaseAcres>(supabase.from('farm_base_acres').select('*')),
    all<import('@/lib/types').ArcPlcElection>(supabase.from('arc_plc_elections').select('*')),
    all<import('@/lib/types').ArcPlcPriceData>(supabase.from('arc_plc_price_data').select('*')),
    all<import('@/lib/types').ArcPlcPayment>(supabase.from('arc_plc_payments').select('*')),
    all<import('@/lib/types').OtherGovernmentPayment>(supabase.from('other_government_payments').select('*')),
    all<import('@/lib/types').ArcBenchmarkData>(supabase.from('arc_benchmark_data').select('*')),
    all<{ id: string; name: string; county_id: string | null }>(supabase.from('farms').select('id, name, county_id')),
  ])
  const effPrice = applyMyaResolution({ cropYear: programYear, commodities, priceData, liveEstimates: new Map() })
  const projected = projectPayments({ cropYear: programYear, baseAcres, commodities, elections, priceData: effPrice, payments: arcPayments, benchmarks, farms })
    .filter((p) => scope.farmInEntity(p.farmId))
  const farmName = new Map(farms.map((f) => [f.id, f.name]))
  const commodityName = new Map(commodities.map((c) => [c.id, c.name]))
  const yearOther = otherPaymentsInRevenueYear(scope.otherPayments(otherPayments), revenueYear)
  return {
    program_year: programYear,
    paid_in_crop_year: revenueYear,
    expected_payment_date: expectedArcPlcDate(programYear),
    arc_plc: projected.map((p) => ({
      farm: farmName.get(p.farmId) ?? p.farmId,
      commodity: commodityName.get(p.commodityId) ?? p.commodityId,
      election: p.election,
      base_acres: r0(num(p.baseAcres)),
      gross_usd: r0(p.result.gross),
      net_usd: r0(p.result.net),
      computable: p.result.computable,
    })),
    arc_plc_total_net_usd: r0(projected.reduce((s, p) => s + p.result.net, 0)),
    other_usda_payments_in_year_usd: r0(yearOther.reduce((s, o) => s + num(o.amount), 0)),
    note: 'ARC/PLC for a program year is paid the following October. Projections use stored MYA prices.',
  }
}

async function getCashFlow(supabase: SupabaseClient, ctx: AssistantContext, input: { months?: number }) {
  const bits = await fetchScopeBits(supabase)
  const scope = buildEntityScope({ entityId: '', farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const [contracts, loads, lines, settlements, crops, otherPayments] = await Promise.all([
    all<Contract>(supabase.from('contracts').select('*')),
    allPaged<{ id: string; contract_id: string | null; ticket_number: string | null; net_weight: number | null; moisture: number | null; crop_id: string | null; dry_bushels_override: number | null }>(
      supabase, 'loads', 'id, contract_id, ticket_number, net_weight, moisture, crop_id, dry_bushels_override'),
    all<{ load_id: string | null; ticket_number: string | null; net_bushels: number | null; net_revenue: number | null; settlement_id: string }>(
      supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue, settlement_id')),
    all<{ id: string; settlement_date: string | null }>(supabase.from('settlements').select('id, settlement_date')),
    all<Crop>(supabase.from('crops').select('*')),
    all<import('@/lib/types').OtherGovernmentPayment>(supabase.from('other_government_payments').select('*')),
  ])
  const cropById = new Map(crops.map((c) => [c.id, c]))
  const settlementDate = new Map(settlements.map((s) => [s.id, s.settlement_date]))
  const linesByLoad = new Map(lines.filter((l) => l.load_id).map((l) => [l.load_id as string, l]))
  const linesByTicket = new Map(lines.filter((l) => l.ticket_number).map((l) => [String(l.ticket_number).trim().toLowerCase(), l]))
  const nowKey = new Date().toISOString().slice(0, 7)
  const monthly = new Map<string, { received: number; outstanding: number; projected: number; other_govt: number }>()
  const bucket = (key: string) => {
    const b = monthly.get(key) ?? { received: 0, outstanding: 0, projected: 0, other_govt: 0 }
    monthly.set(key, b)
    return b
  }
  for (const c of contracts) {
    let delivered = 0, deliveredUnpaid = 0
    for (const l of loads) {
      if (l.contract_id !== c.id) continue
      const crop = l.crop_id ? cropById.get(l.crop_id) : undefined
      const { dryBushels } = computeBushels({ netWeightLb: l.net_weight, moisturePct: l.moisture, baseMoisturePct: crop?.base_moisture_pct ?? null, baseLbPerBushel: crop?.base_lb_per_bushel ?? null, dryBushelsOverride: l.dry_bushels_override })
      if (!dryBushels) continue
      delivered += dryBushels
      const line = linesByLoad.get(l.id) ?? (l.ticket_number ? linesByTicket.get(l.ticket_number.trim().toLowerCase()) : undefined)
      if (line) {
        const sd = settlementDate.get(line.settlement_id)
        bucket((sd ?? '').slice(0, 7) || nowKey).received += num(line.net_revenue)
      } else {
        deliveredUnpaid += dryBushels
      }
    }
    const price = num(c.cash_price) || num(c.price_per_bushel)
    bucket(nowKey).outstanding += deliveredUnpaid * price
    const contracted = num(c.contracted_bushels)
    const remaining = Math.max(0, contracted - delivered)
    const complete = c.completed_at != null || (contracted > 0 && delivered >= contracted)
    if (!complete && remaining > 0 && price > 0) {
      const start = c.delivery_start_date?.slice(0, 7) ?? nowKey
      const end = c.delivery_end_date?.slice(0, 7) ?? start
      const months: string[] = []
      let [y, m] = start.split('-').map(Number)
      for (let guard = 0; guard < 36; guard++) {
        const key = `${y}-${String(m).padStart(2, '0')}`
        months.push(key)
        if (key >= end) break
        m++; if (m > 12) { m = 1; y++ }
      }
      const per = (remaining * price) / months.length
      for (const key of months) bucket(key).projected += per
    }
  }
  for (const o of scope.otherPayments(otherPayments)) {
    const key = (o.payment_date ?? `${o.crop_year}-12-01`).slice(0, 7)
    bucket(key).other_govt += num(o.amount)
  }
  const keys = [...monthly.keys()].sort()
  const horizon = input.months && input.months > 0 ? input.months : 18
  const kept = keys.filter((k) => k >= nowKey).slice(0, horizon)
  const past = keys.filter((k) => k < nowKey)
  const pastReceived = past.reduce((s, k) => s + (monthly.get(k)?.received ?? 0), 0)
  return {
    components_included: 'contract grain revenue (received / delivered-unpaid / projected remaining) + other USDA payments by date. Insurance, ARC/PLC timing, and cotton events are on the Cash Flow report.',
    price_basis: PRICE_BASIS,
    settled_revenue_before_this_month_usd: r0(pastReceived),
    months: kept.map((k) => {
      const b = monthly.get(k)!
      return { month: k, received_usd: r0(b.received), delivered_unpaid_usd: r0(b.outstanding), projected_usd: r0(b.projected), other_govt_usd: r0(b.other_govt), total_usd: r0(b.received + b.outstanding + b.projected + b.other_govt) }
    }),
  }
}

async function getLoads(supabase: SupabaseClient, _ctx: AssistantContext, input: { crop_year?: number; crop?: string; from_date?: string; to_date?: string; destination?: 'bin' | 'buyer'; limit?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  let q = supabase.from('loads').select(`
    id, date, time, ticket_number, crop_year, net_weight, moisture, test_weight, dry_bushels_override,
    from_type, to_type, hauler_truck,
    truck:trucks(name_or_number),
    crop:crops(name, base_moisture_pct, base_lb_per_bushel),
    from_field:fields!loads_from_field_id_fkey(name_or_number),
    from_bin:bins!loads_from_bin_id_fkey(name_or_number),
    to_bin:bins!loads_to_bin_id_fkey(name_or_number),
    to_buyer:buyers(name),
    contract:contracts(contract_number)
  `).order('date', { ascending: false }).order('time', { ascending: false }).limit(limit)
  if (input.crop_year != null) q = q.eq('crop_year', input.crop_year)
  if (input.from_date) q = q.gte('date', input.from_date)
  if (input.to_date) q = q.lte('date', input.to_date)
  if (input.destination) q = q.eq('to_type', input.destination)
  type Row = {
    id: string; date: string; time: string | null; ticket_number: string | null; crop_year: number | null
    net_weight: number | null; moisture: number | null; test_weight: number | null; dry_bushels_override: number | null
    from_type: string | null; to_type: string | null; hauler_truck: string | null
    truck: { name_or_number: string } | null
    crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
    from_field: { name_or_number: string } | null; from_bin: { name_or_number: string } | null
    to_bin: { name_or_number: string } | null; to_buyer: { name: string } | null
    contract: { contract_number: string } | null
  }
  let rows = await all<Row>(q)
  const cropFilter = input.crop?.trim().toLowerCase() || null
  if (cropFilter) rows = rows.filter((rw) => rw.crop?.name?.toLowerCase().includes(cropFilter))
  return {
    count: rows.length,
    limit,
    loads: rows.map((rw) => {
      const { dryBushels, wetBushels } = computeBushels({ netWeightLb: rw.net_weight, moisturePct: rw.moisture, baseMoisturePct: rw.crop?.base_moisture_pct ?? null, baseLbPerBushel: rw.crop?.base_lb_per_bushel ?? null, dryBushelsOverride: rw.dry_bushels_override })
      return {
        date: rw.date, ticket: rw.ticket_number, crop: rw.crop?.name ?? null, crop_year: rw.crop_year,
        truck: truckExportLabel(rw) || null,
        from: rw.from_type === 'bin' ? `bin ${rw.from_bin?.name_or_number ?? '?'}` : rw.from_field?.name_or_number ?? null,
        to: rw.to_type === 'bin' ? `bin ${rw.to_bin?.name_or_number ?? '?'}` : rw.to_buyer?.name ?? null,
        contract: rw.contract?.contract_number ?? null,
        net_lb: rw.net_weight, moisture_pct: rw.moisture, test_weight: rw.test_weight,
        wet_bu: wetBushels != null ? r2(wetBushels) : null, dry_bu: dryBushels != null ? r2(dryBushels) : null,
      }
    }),
  }
}

async function getBinInventory(supabase: SupabaseClient, _ctx: AssistantContext) {
  const today = new Date().toISOString().slice(0, 10)
  const [bins, sites, crops, loads, splits, combineEntries, adjustments, transfers] = await Promise.all([
    all<{ id: string; name_or_number: string; crop_id: string | null; bin_site_id: string | null; capacity_bushels: number | null }>(
      supabase.from('bins').select('id, name_or_number, crop_id, bin_site_id, capacity_bushels').order('name_or_number')),
    all<{ id: string; name: string }>(supabase.from('bin_sites').select('id, name').order('name')),
    all<Crop>(supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel')),
    allPaged<{ id: string; date: string; net_weight: number | null; moisture: number | null; crop_id: string | null; crop_year: number | null; dry_bushels_override: number | null; from_type: string | null; from_field_id: string | null; from_bin_id: string | null; to_type: string | null; to_bin_id: string | null }>(
      supabase, 'loads', 'id, date, net_weight, moisture, crop_id, crop_year, dry_bushels_override, from_type, from_field_id, from_bin_id, to_type, to_bin_id'),
    all<{ load_id: string; field_id: string; crop_id: string; dry_bushels: number }>(supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels')),
    all<CombineRow>(
      supabase.from('combine_yield_entries').select(COMBINE_SELECT)),
    all<{ bin_id: string; crop_id: string; adjustment_type: string; bushels: number }>(
      supabase.from('bin_inventory_adjustments').select('bin_id, crop_id, adjustment_type, bushels').lte('as_of_date', today)),
    all<{ from_bin_id: string; to_bin_id: string; crop_id: string; bushels: number }>(
      supabase.from('bin_transfers').select('from_bin_id, to_bin_id, crop_id, bushels').lte('transfer_date', today)),
  ])
  const cropById = new Map(crops.map((c) => [c.id, c]))
  const bag: OnHandBag = new Map()
  for (const b of bins) bag.set(b.id, new Map())
  for (const l of loads) {
    if (!l.crop_id) continue
    const crop = cropById.get(l.crop_id)
    const { dryBushels } = computeBushels({ netWeightLb: l.net_weight, moisturePct: l.moisture, baseMoisturePct: crop?.base_moisture_pct ?? null, baseLbPerBushel: crop?.base_lb_per_bushel ?? null, dryBushelsOverride: l.dry_bushels_override })
    if (!dryBushels) continue
    if (l.to_type === 'bin' && l.to_bin_id) cellFor(bag, l.to_bin_id, l.crop_id).loadBacked += dryBushels
    if (l.from_type === 'bin' && l.from_bin_id) cellFor(bag, l.from_bin_id, l.crop_id).loadBacked -= dryBushels
  }
  for (const a of adjustments) {
    const cell = cellFor(bag, a.bin_id, a.crop_id)
    if (a.adjustment_type === 'beginning_inventory') cell.beginning += num(a.bushels)
    else cell.emptyAdj += num(a.bushels)
  }
  applyTransfers(bag, transfers)
  if (combineEntries.length > 0) {
    const agg = fieldCropAggregates(loads, splits, cropById, { combineEntries })
    applyCombineRemainders(bag, combineEntries.map((e) => ({
      crop_id: e.crop_id,
      destinationBinId: e.destination_bin_id,
      remainderBu: agg.get(`${e.field_id}|${e.crop_id}|${e.crop_year}`)?.combine?.remainderBu ?? 0,
    })))
  }
  const siteName = new Map(sites.map((s) => [s.id, s.name]))
  const rows: Array<{ bin: string; site: string | null; crop: string; dry_bu: number; capacity_bu: number | null; pct_full: number | null }> = []
  for (const b of bins) {
    const inner = bag.get(b.id)
    if (!inner) continue
    for (const [cropId, cell] of inner) {
      const total = cellTotal(cell)
      if (Math.abs(total) < 0.01) continue
      rows.push({
        bin: b.name_or_number,
        site: b.bin_site_id ? siteName.get(b.bin_site_id) ?? null : null,
        crop: cropById.get(cropId)?.name ?? cropId,
        dry_bu: r0(total),
        capacity_bu: b.capacity_bushels != null ? r0(num(b.capacity_bushels)) : null,
        pct_full: b.capacity_bushels ? r0((total / num(b.capacity_bushels)) * 100) : null,
      })
    }
  }
  return {
    unit: 'dry bushels',
    total_on_hand_bu: r0(rows.reduce((s, x) => s + x.dry_bu, 0)),
    bins: rows.sort((a, b2) => b2.dry_bu - a.dry_bu),
    note: 'Includes beginning inventory, adjustments, bin-to-bin transfers, and combine-entry remainders — same math as the Bin Inventory page.',
  }
}

async function queryData(supabase: SupabaseClient, _ctx: AssistantContext, input: { sql: string; purpose?: string }) {
  const v = validateAssistantSql(input.sql)
  if (!v.ok) return { error: v.reason }
  // SECURITY INVOKER RPC: the SQL runs AS THE USER, read-only, ~5s timeout,
  // 500-row cap — RLS org/role isolation applies to whatever the model wrote.
  const { data, error } = await supabase.rpc('assistant_query', { q: v.sql })
  if (error) return { error: `Query failed: ${error.message}` }
  const rows = (data as unknown[]) ?? []
  return { row_count: Array.isArray(rows) ? rows.length : 0, rows, note: 'Raw table values — weights are lb; dry bushels need the shrink math (prefer the curated tools for derived numbers).' }
}

// ---------- tool registry + role gating ----------

type ToolImpl = (supabase: SupabaseClient, ctx: AssistantContext, input: never) => Promise<unknown>

const IMPLS: Record<string, ToolImpl> = {
  get_marketing_summary: getMarketingSummary as ToolImpl,
  get_yields: getYields as ToolImpl,
  get_revenue_projection: getRevenueProjection as ToolImpl,
  get_contracts: getContracts as ToolImpl,
  get_hedging_positions: getHedgingPositions as ToolImpl,
  get_insurance_estimates: getInsuranceEstimates as ToolImpl,
  get_government_payments: getGovernmentPayments as ToolImpl,
  get_cash_flow: getCashFlow as ToolImpl,
  get_loads: getLoads as ToolImpl,
  get_bin_inventory: getBinInventory as ToolImpl,
  query_data: queryData as ToolImpl,
}

const cropYearProp = { type: 'number' as const, description: 'Crop (harvest) year, e.g. 2026' }

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_marketing_summary',
    description: 'Per-crop marketing dashboard for a crop year: acres, yield, production, contracted/unpriced bushels, average prices, blended revenue, cost and profit. The same engine as the Marketing report. Cotton rows are lbs of lint with ¢/lb prices.',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp, entity: { type: 'string', description: 'Optional entity name to filter to' } }, required: ['crop_year'] },
  },
  {
    name: 'get_yields',
    description: 'Harvest yields for a crop year grouped by field, farm, entity, landowner, or crop: acres, dry bushels, yield/acre. Splits-aware and combine-entry-aware — the same math as the Yields page.',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp, grouping: { type: 'string', enum: ['field', 'farm', 'entity', 'crop', 'landowner'] }, crop: { type: 'string', description: 'Optional crop name filter' } }, required: ['crop_year'] },
  },
  {
    name: 'get_revenue_projection',
    description: 'Projected revenue per crop for a crop year: crop sales revenue, insurance proceeds, government payments, total revenue and revenue/acre — the Revenue Projections report.',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp, entity: { type: 'string' } }, required: ['crop_year'] },
  },
  {
    name: 'get_contracts',
    description: 'Grain contracts with delivery progress: contracted vs delivered vs remaining bushels, prices, settled revenue, and open/complete/future status.',
    input_schema: { type: 'object', properties: { crop_year: { type: 'number' }, buyer: { type: 'string' }, status: { type: 'string', enum: ['open', 'complete', 'future'] } } },
  },
  {
    name: 'get_hedging_positions',
    description: 'Futures and options positions summarized per crop year × commodity: open contracts/quantity, unrealized P&L (stored prices), realized P&L net of commission.',
    input_schema: { type: 'object', properties: { crop_year: { type: 'number' } } },
  },
  {
    name: 'get_insurance_estimates',
    description: 'Crop insurance projections per policy for a crop year: projected indemnity, premium, net — the Claims Monitor engine (RP/YP/area plans + SCO/ECO/STAX/MCO).',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp }, required: ['crop_year'] },
  },
  {
    name: 'get_government_payments',
    description: 'ARC/PLC projections per farm × commodity plus other USDA payments. Pass the crop year money arrives in (year_basis "revenue", default) or the program year itself.',
    input_schema: { type: 'object', properties: { year: { type: 'number' }, year_basis: { type: 'string', enum: ['revenue', 'program'] } }, required: ['year'] },
  },
  {
    name: 'get_cash_flow',
    description: 'Monthly grain cash flow: settled revenue by settlement month, delivered-but-unpaid, projected remaining contract revenue across delivery windows, other USDA payments. (Insurance/ARC-PLC timing and cotton are on the Cash Flow report.)',
    input_schema: { type: 'object', properties: { months: { type: 'number', description: 'Months ahead to include (default 18)' } } },
  },
  {
    name: 'get_loads',
    description: 'Recent load records (newest first): date, ticket, truck, crop, from/to, weights, moisture, wet/dry bushels. Max 100 per call.',
    input_schema: { type: 'object', properties: { crop_year: { type: 'number' }, crop: { type: 'string' }, from_date: { type: 'string', description: 'YYYY-MM-DD' }, to_date: { type: 'string' }, destination: { type: 'string', enum: ['bin', 'buyer'] }, limit: { type: 'number' } } },
  },
  {
    name: 'get_bin_inventory',
    description: 'Current grain on hand per bin × crop (dry bushels), with capacity and percent full — the Bin Inventory math including transfers and combine remainders.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'query_data',
    description: 'Long-tail questions the other tools do not cover: run ONE read-only SQL SELECT against the account\'s own tables (schema provided in the system prompt). Returns up to 500 rows. Only the user\'s own data is visible. Prefer the curated tools for derived numbers (dry bushels, prices, projections).',
    input_schema: { type: 'object', properties: { sql: { type: 'string', description: 'A single SELECT (or WITH…SELECT) statement' }, purpose: { type: 'string', description: 'One line on what this answers' } }, required: ['sql'] },
  },
]

/** Which curated tools a role's RLS can actually satisfy — the rest are
 *  hidden so the model doesn't chase empty results. query_data is always
 *  available; RLS filters it to whatever the role may read. */
export function toolNamesForRole(role: AppRole): string[] {
  if (role === 'agronomist') return ['get_yields', 'get_loads', 'query_data']
  if (role === 'gin') return ['query_data']
  if (role === 'viewer') {
    return ['get_marketing_summary', 'get_yields', 'get_revenue_projection', 'get_contracts', 'get_hedging_positions', 'get_insurance_estimates', 'get_government_payments', 'get_loads', 'query_data']
  }
  return ASSISTANT_TOOLS.map((t) => t.name)
}

export function toolsForRole(role: AppRole): Anthropic.Tool[] {
  const names = new Set(toolNamesForRole(role))
  return ASSISTANT_TOOLS.filter((t) => names.has(t.name))
}

export async function runAssistantTool(
  supabase: SupabaseClient,
  ctx: AssistantContext,
  name: string,
  input: unknown,
): Promise<unknown> {
  const impl = IMPLS[name]
  if (!impl) return { error: `Unknown tool: ${name}` }
  if (!toolNamesForRole(ctx.role).includes(name)) return { error: 'That tool is not available for your role.' }
  try {
    return await impl(supabase, ctx, (input ?? {}) as never)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Tool failed.' }
  }
}

/** Friendly status line while a tool runs (streamed to the user). */
export function toolStatusLabel(name: string): string {
  const map: Record<string, string> = {
    get_marketing_summary: 'Checking your marketing numbers…',
    get_yields: 'Checking your yields…',
    get_revenue_projection: 'Running your revenue projection…',
    get_contracts: 'Checking your contracts…',
    get_hedging_positions: 'Checking your hedge positions…',
    get_insurance_estimates: 'Checking your crop insurance…',
    get_government_payments: 'Checking your government payments…',
    get_cash_flow: 'Building your cash flow…',
    get_loads: 'Looking through your loads…',
    get_bin_inventory: 'Checking your bins…',
    query_data: 'Looking that up in your data…',
  }
  return map[name] ?? 'Checking your data…'
}
