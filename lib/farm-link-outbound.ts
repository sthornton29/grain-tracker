// Outbound payloads for the Turnrow Farm link: production, marketing, income,
// bins. Every number is the SAME number Grain's own pages show — the shapers
// here re-key the existing engines' outputs (buildProductionRecords,
// buildProjectedYieldRecords, computeMarketing / computeEntityMarketingRows,
// computeRevenueProjections, the bin-inventory assembly) and add the Farm
// uuids from the id map; nothing is recomputed. The pure shapers are exported
// for tests; the load* functions are the service-role, org-scoped loaders.

import type { SupabaseClient } from '@supabase/supabase-js'
import { IdMap } from '@/lib/farm-link'
import { fetchAll } from '@/lib/partner-api-server'
import {
  buildProductionRecords,
  buildSettlementRecords,
  fieldEntityMap,
  type CombineEntryRow,
  type CropAssumptionStatusRow,
  type PartnerProduction,
  type PartnerSettlement,
} from '@/lib/partner-api'
import { buildProjectedYieldRecords, type ProjectedYieldRecord } from '@/lib/partner-marketing'
import { loadMarketingInputs, loadProductionInputs, type MarketingInputs, type ProductionInputs } from '@/lib/marketing-inputs'
import { computeEntityMarketingRows } from '@/lib/entity-marketing'
import { headlineAvgPrice, type MarketingRow } from '@/lib/marketing'
import { buildEntityScope } from '@/lib/entity-scope'
import { buildLoadDetail, weightedAverage, type DetailLoadLike } from '@/lib/yield-detail'
import { fieldCropAggregates, withLoadBreakouts, type CombineEntryLike } from '@/lib/yields'
import { computeBushels } from '@/lib/shrink'
import { actualYieldByCropFromLoads, projectInsuranceIndemnities, type ProjectedPolicy } from '@/lib/crop-insurance'
import { applyMyaResolution, otherPaymentsInRevenueYear, programYearFor, projectPayments, type ProjectedPayment } from '@/lib/government-payments'
import { computeRevenueProjections, cropsWithInsuranceInCost, type GovtProceeds, type InsuranceProceeds } from '@/lib/revenue-projections'
import { resolveProgramYearConfig } from '@/lib/program-config'
import { applyCombineRemainders, applyTransfers, cellFor, cellTotal, type OnHandBag } from '@/lib/bin-inventory'
import { settlementCheckoffDollars, settlementFeeDollars } from '@/lib/checkoff'
import type {
  ArcPlcElection, ArcPlcPayment, ArcPlcPriceData, CountyYieldAssumption, CoveredCommodity, Crop,
  CropInsuranceEco, CropInsuranceMco, CropInsurancePolicy, CropInsuranceSco, CropInsuranceStax,
  FarmBaseAcres, FieldPlanting, HarvestPriceEstimate, OtherGovernmentPayment, ProgramYearConfig,
} from '@/lib/types'

const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 10000) / 10000
const num = (v: unknown) => Number(v) || 0
const maxIso = (...vals: Array<string | null | undefined>): string | null =>
  vals.reduce<string | null>((max, v) => (v && (!max || v > max) ? v : max), null)

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

export type ProductionSource = 'combine_yield_entries' | 'loads' | 'gin_receipts' | null

export type FarmLinkProductionRecord = {
  /** The planting id when one exists, else `${field_id}|${crop}|${year}`. */
  id: string
  planting_id: string | null
  planting_farm_uid: string | null
  field_id: string
  field_farm_uid: string | null
  field_name: string | null
  farm_id: string | null
  entity_id: string | null
  entity: string | null
  crop: string | null
  crop_year: number
  planted_acres: number | null
  harvest_status: PartnerProduction['harvest_status']
  /** = planted acres once complete, else 0 (Grain has no per-field harvested-acre figure). */
  harvested_acres: number | null
  production: number
  unit: 'bu' | 'lbs'
  /** Actual yield once the field classifies complete; null while in progress. */
  yield_per_acre: number | null
  yield_unit: 'bu_per_ac' | 'lbs_per_ac'
  /** Net-lb-weighted moisture over the field's weighed loads; null for cotton / combine-only. */
  moisture: number | null
  /** Grain's production precedence: combine entry > weighed loads; cotton from gin receipts. */
  source: ProductionSource
  updated_at: string | null
}

export function shapeProductionRecords(args: {
  partner: readonly PartnerProduction[]
  projected: readonly ProjectedYieldRecord[]
  plantings: ReadonlyArray<{ id: string; field_id: string; crop_id: string; season_year: number; updated_at?: string | null }>
  crops: ReadonlyArray<{ id: string; name: string }>
  fields: ReadonlyArray<{ id: string; farm_id: string | null }>
  combineKeys: ReadonlySet<string>
  loadKeys: ReadonlySet<string>
  moistureByKey: ReadonlyMap<string, number | null>
  idMap: IdMap
  year: number
}): FarmLinkProductionRecord[] {
  const cropIdByName = new Map(args.crops.map((c) => [c.name, c.id]))
  const plantingByKey = new Map(args.plantings.map((p) => [`${p.field_id}|${p.crop_id}|${p.season_year}`, p]))
  const farmByField = new Map(args.fields.map((f) => [f.id, f.farm_id]))
  const actualYield = new Map<string, ProjectedYieldRecord>()
  for (const r of args.projected) if (r.basis === 'actual') actualYield.set(`${r.field_id}|${r.crop}`, r)

  return args.partner.map((p) => {
    const cropId = p.crop ? cropIdByName.get(p.crop) ?? null : null
    const key = cropId ? `${p.field_id}|${cropId}|${p.crop_year}` : null
    const planting = key ? plantingByKey.get(key) ?? null : null
    const y = actualYield.get(`${p.field_id}|${p.crop ?? ''}`)
    const source: ProductionSource = p.unit === 'lbs'
      ? (p.production_units > 0 ? 'gin_receipts' : null)
      : key && args.combineKeys.has(key) ? 'combine_yield_entries'
        : key && args.loadKeys.has(key) ? 'loads' : null
    return {
      id: planting?.id ?? `${p.field_id}|${p.crop ?? ''}|${p.crop_year}`,
      planting_id: planting?.id ?? null,
      planting_farm_uid: args.idMap.farmUid('field_plantings', planting?.id),
      field_id: p.field_id,
      field_farm_uid: args.idMap.farmUid('fields', p.field_id),
      field_name: p.field_name,
      farm_id: farmByField.get(p.field_id) ?? null,
      entity_id: p.entity_id,
      entity: p.entity,
      crop: p.crop,
      crop_year: p.crop_year,
      planted_acres: p.planted_acres,
      harvest_status: p.harvest_status,
      harvested_acres: p.harvested_acres,
      production: r2(p.production_units),
      unit: p.unit,
      yield_per_acre: p.harvest_status === 'complete' && y ? y.yield_per_acre : null,
      yield_unit: p.unit === 'lbs' ? 'lbs_per_ac' : 'bu_per_ac',
      moisture: p.unit === 'lbs' ? null : (key ? args.moistureByKey.get(key) ?? null : null),
      source,
      updated_at: maxIso(p.updated_at, planting?.updated_at),
    }
  })
}

type DetailLoadDb = DetailLoadLike & { crop_year: number | null; updated_at: string | null; practice?: 'irrigated' | 'dryland' | null }

export async function loadProductionPayload(supabase: SupabaseClient, org: string, year: number, idMap: IdMap): Promise<FarmLinkProductionRecord[]> {
  const [plantings, loads, splits, ginReceipts, fields, farms, entities, crops] = await Promise.all([
    fetchAll<FieldPlanting & { updated_at: string | null }>((f, t) =>
      supabase.from('field_plantings').select('*').eq('org_id', org).eq('season_year', year).is('archived_at', null).order('id').range(f, t)),
    fetchAll<DetailLoadDb>((f, t) =>
      supabase.from('loads')
        .select('id, date, time, net_weight, moisture, test_weight, crop_id, crop_year, dry_bushels_override, from_type, from_field_id, to_type, to_bin_id, to_buyer_id, truck_id, ticket_number, practice, updated_at')
        .eq('org_id', org).eq('crop_year', year).order('id').range(f, t)),
    fetchAll<{ load_id: string; field_id: string; crop_id: string; dry_bushels: number | null }>((f, t) =>
      supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; field_id: string | null; crop_year: number; total_bale_weight: number | string | null; updated_at: string | null }>((f, t) =>
      supabase.from('gin_receipts').select('id, field_id, crop_year, total_bale_weight, updated_at').eq('org_id', org).eq('crop_year', year).order('id').range(f, t)),
    fetchAll<{ id: string; farm_id: string | null; name_or_number: string; total_acres: number | string | null; irrigated_acres: number | string | null; dryland_acres: number | string | null; updated_at: string | null }>((f, t) =>
      supabase.from('fields').select('id, farm_id, name_or_number, total_acres, irrigated_acres, dryland_acres, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; name: string; fsa_number: string | null; entity_id: string | null; updated_at: string | null }>((f, t) =>
      supabase.from('farms').select('id, name, fsa_number, entity_id, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; name: string; entity_role: string | null; updated_at: string | null }>((f, t) =>
      supabase.from('entities').select('id, name, entity_role, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<Crop>((f, t) => supabase.from('crops').select('*').eq('org_id', org).order('id').range(f, t)),
  ])
  let combineEntries: Array<CombineEntryRow & CombineEntryLike> = []
  try {
    combineEntries = await fetchAll<CombineEntryRow & CombineEntryLike>((f, t) =>
      supabase.from('combine_yield_entries')
        .select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date, updated_at')
        .eq('org_id', org).eq('crop_year', year).order('id').range(f, t))
  } catch { /* 062 not applied */ }
  const assumptionsRes = await supabase.from('crop_assumptions').select('*').eq('org_id', org).eq('crop_year', year)
  const assumptions = (assumptionsRes.error ? [] : (assumptionsRes.data ?? [])) as Array<CropAssumptionStatusRow & import('@/lib/types').CropAssumption>

  const partner = buildProductionRecords({
    plantings, loads, splits, ginReceipts, combineEntries, cropAssumptions: assumptions, fields, farms, entities, crops, year, crop: null,
  })

  // Yield per acre + harvest classification through the projected-yields
  // seam (basis 'actual' once complete), moisture through the yield detail
  // seam (net-lb weighted, splits pro-rated).
  const cropById = new Map(crops.map((c) => [c.id, c]))
  const aggByKey = fieldCropAggregates(loads, splits, cropById, { cropYear: year, combineEntries })
  const doubleCropIds = new Set<string>()
  {
    const { buildDoubleCropSet } = await import('@/lib/plantings')
    for (const id of buildDoubleCropSet(plantings, cropById)) doubleCropIds.add(id)
  }
  const { analyzeYields, expectedYieldForPlanting } = await import('@/lib/yields')
  const assumptionByCrop = new Map(assumptions.map((a) => [a.crop_id, a]))
  const analysis = analyzeYields(plantings.map((p) => {
    const agg = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
    return {
      id: p.id, cropId: p.crop_id, acres: Number(p.planted_acres ?? 0), dryBu: agg?.dryBu ?? 0,
      lastLoadDate: agg?.lastLoadDate ?? null, lastLoadTime: agg?.lastLoadTime ?? null,
      override: p.yield_include_override ?? null, combineComplete: agg?.combine?.harvestComplete,
      expectedYield: expectedYieldForPlanting(assumptionByCrop.get(p.crop_id), p),
    }
  }))
  const cropCompleteKeys = new Set<string>()
  for (const a of assumptions) if (a.harvest_complete) cropCompleteKeys.add(`${a.crop_id}|${a.crop_year}`)
  const cottonLbsByField = new Map<string, number>()
  for (const g of ginReceipts) if (g.field_id) cottonLbsByField.set(g.field_id, (cottonLbsByField.get(g.field_id) ?? 0) + num(g.total_bale_weight))
  const projected = buildProjectedYieldRecords({
    cropYear: year, plantings, fields, crops, assumptions, doubleCropIds, aggByKey, cottonLbsByField,
    excluded: analysis.excluded, cropCompleteKeys, allowedFieldIds: null, fieldEntity: fieldEntityMap({ fields, farms }),
  })

  const keys = new Set(plantings.map((p) => `${p.field_id}|${p.crop_id}`))
  const detail = buildLoadDetail({ keys, seasonYear: year, loads, splits, cropById, combineEntries })
  const byKey = new Map<string, Array<{ value: number | null; weight: number | null }>>()
  for (const l of detail.loads) {
    const k = `${l.fieldId}|${l.cropId}|${year}`
    const list = byKey.get(k) ?? []
    list.push({ value: l.moisture, weight: l.netLbs })
    byKey.set(k, list)
  }
  const moistureByKey = new Map<string, number | null>()
  for (const [k, pairs] of byKey) {
    const m = weightedAverage(pairs)
    moistureByKey.set(k, m == null ? null : Math.round(m * 10) / 10)
  }
  const combineKeys = new Set(combineEntries.map((e) => `${e.field_id}|${e.crop_id}|${e.crop_year}`))
  const loadKeys = new Set<string>()
  for (const [k, agg] of aggByKey) if ((agg.totalLoads ?? 0) > 0 || agg.dryBu > 0) loadKeys.add(k)

  return shapeProductionRecords({ partner, projected, plantings, crops, fields, combineKeys, loadKeys, moistureByKey, idMap, year })
}

// ---------------------------------------------------------------------------
// Marketing
// ---------------------------------------------------------------------------

export type FarmLinkMarketingRecord = {
  id: string
  crop_id: string
  crop: string
  crop_year: number
  /** Null = the whole operation; else the farming entity's own view. */
  entity_id: string | null
  entity_name: string | null
  entity_farm_uid: string | null
  unit: 'usd_per_bu' | 'cents_per_lb'
  quantity_unit: 'bu' | 'lbs'
  /** Settled sales (settlement lines' net revenue ÷ net units; cotton: sold lbs). */
  settled_average_price: number | null
  settled_quantity: number
  settled_revenue: number
  settled_attribution: 'operation' | 'by_acres'
  /** The Marketing dashboard's headline: futures + basis, blended once assumptions apply. */
  projected_average_price: number | null
  price_is_final: boolean
  basis: {
    average: number
    state: MarketingRow['basisState']
    assumed: number
    locked_quantity: number
    assumed_quantity: number
  }
  percent_sold: number | null
  sold_quantity: number
  total_production: number
  production_basis: 'estimated' | 'actual'
  hedging_realized: { net: number; per_unit: number }
  basis_notes: string[]
  as_of: string
  updated_at: string
}

export function shapeMarketingRecord(args: {
  row: MarketingRow
  cropYear: number
  entity: { id: string; name: string; farm_uid: string | null } | null
  settled: { quantity: number; revenue: number; share: number } | null
  isFinal: boolean
  asOf: string
}): FarmLinkMarketingRecord {
  const { row } = args
  const cotton = row.unit === 'lbs'
  let settledQty = 0
  let settledRev = 0
  let settledAvg: number | null = null
  if (cotton) {
    const s = row.cottonPhysical?.summary
    const soldLbs = num(s?.soldLbs) * (args.settled?.share ?? 1)
    const soldDollars = num(s?.soldDollars) * (args.settled?.share ?? 1)
    settledQty = soldLbs
    settledRev = soldDollars
    settledAvg = soldLbs > 0 ? r4((soldDollars * 100) / soldLbs) : null
  } else if (args.settled) {
    settledQty = args.settled.quantity * args.settled.share
    settledRev = args.settled.revenue * args.settled.share
    settledAvg = settledQty > 0 ? r4(settledRev / settledQty) : null
  }
  const sold = cotton ? num(row.cottonPhysical?.summary.soldLbs) : row.contractedBu + (row.seed ? num((row.seed as { committedBu?: number }).committedBu) : 0)
  const pct = row.totalProduction > 0 ? Math.min(100, (sold / row.totalProduction) * 100) : null
  const notes: string[] = []
  if (row.avgBasisAssumed) notes.push('basis is the assumed basis (no contract has basis locked)')
  else if (row.basisState === 'blended') notes.push('basis blends locked contracts with the assumed basis on unpriced bushels')
  if (row.assumedFutures != null) notes.push(`unpriced ${row.unit === 'lbs' ? 'pounds' : 'bushels'} valued at the standing assumed futures price`)
  if (row.acresSource === 'assumed') notes.push('acres are the crop year\'s assumed acres (no plantings yet)')
  const headline = headlineAvgPrice(row)
  return {
    id: `${row.cropId}|${args.entity?.id ?? 'all'}`,
    crop_id: row.cropId,
    crop: row.cropName,
    crop_year: args.cropYear,
    entity_id: args.entity?.id ?? null,
    entity_name: args.entity?.name ?? null,
    entity_farm_uid: args.entity?.farm_uid ?? null,
    unit: cotton ? 'cents_per_lb' : 'usd_per_bu',
    quantity_unit: cotton ? 'lbs' : 'bu',
    settled_average_price: settledAvg,
    settled_quantity: r2(settledQty),
    settled_revenue: r2(settledRev),
    settled_attribution: args.entity ? 'by_acres' : 'operation',
    projected_average_price: headline == null || !Number.isFinite(headline) ? null : r4(headline),
    price_is_final: args.isFinal,
    basis: {
      average: r4(row.avgBasis), state: row.basisState, assumed: r4(row.assumedBasis),
      locked_quantity: r2(row.basisLockedBu), assumed_quantity: r2(row.basisAssumedBu),
    },
    percent_sold: pct == null ? null : Math.round(pct * 10) / 10,
    sold_quantity: r2(sold),
    total_production: r2(row.totalProduction),
    production_basis: row.yieldLabel === 'Actual' ? 'actual' : 'estimated',
    hedging_realized: { net: r2(row.hedgeRealizedPnl), per_unit: r4(row.hedgeAdjPerBu) },
    basis_notes: notes,
    as_of: args.asOf,
    updated_at: args.asOf,
  }
}

async function loadSalesStatus(supabase: SupabaseClient, org: string, year: number): Promise<Set<string>> {
  const res = await supabase.from('crop_year_sales_status').select('crop_id, physical_sales_complete').eq('org_id', org).eq('crop_year', year)
  const rows = res.error ? [] : ((res.data ?? []) as Array<{ crop_id: string; physical_sales_complete: boolean }>)
  return new Set(rows.filter((r) => r.physical_sales_complete).map((r) => r.crop_id))
}

type SettledByCrop = Map<string, { quantity: number; revenue: number; updatedAt: string | null }>

async function loadSettledByCrop(supabase: SupabaseClient, org: string, year: number, crops: readonly Crop[]): Promise<{ byCrop: SettledByCrop; records: PartnerSettlement[]; checkoff: Map<string, number>; fees: Map<string, number> }> {
  const [settlements, lines, loads, buyers] = await Promise.all([
    fetchAll<{ id: string; buyer_id: string; settlement_date: string; settlement_number: string | null; updated_at: string | null }>((f, t) =>
      supabase.from('settlements').select('id, buyer_id, settlement_date, settlement_number, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; settlement_id: string; load_id: string | null; net_bushels: number | null; net_revenue: number | null; updated_at: string | null }>((f, t) =>
      supabase.from('settlement_lines').select('id, settlement_id, load_id, net_bushels, net_revenue, updated_at').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; crop_id: string | null; crop_year: number | null }>((f, t) =>
      supabase.from('loads').select('id, crop_id, crop_year').eq('org_id', org).eq('crop_year', year).order('id').range(f, t)),
    fetchAll<{ id: string; name: string }>((f, t) => supabase.from('buyers').select('id, name').eq('org_id', org).order('id').range(f, t)),
  ])
  // Only lines whose matched load belongs to the crop year.
  const yearLoadIds = new Set(loads.map((l) => l.id))
  const yearLines = lines.filter((l) => l.load_id && yearLoadIds.has(l.load_id))
  const yearSettlementIds = new Set(yearLines.map((l) => l.settlement_id))
  const records = buildSettlementRecords({
    settlements: settlements.filter((s) => yearSettlementIds.has(s.id)), lines: yearLines, loads, crops, buyers,
  })
  const byName = new Map(crops.map((c) => [c.name, c.id]))
  const byCrop: SettledByCrop = new Map()
  for (const r of records) {
    if (!r.crop) continue
    const cropId = byName.get(r.crop)
    if (!cropId) continue
    const cur = byCrop.get(cropId) ?? { quantity: 0, revenue: 0, updatedAt: null }
    cur.quantity += r.net_units
    cur.revenue += r.net_revenue
    cur.updatedAt = maxIso(cur.updatedAt, r.updated_at)
    byCrop.set(cropId, cur)
  }
  // Checkoff + fees (086) by the settlement's crop (its lines' matched loads).
  const checkoff = new Map<string, number>()
  const fees = new Map<string, number>()
  try {
    const items = await fetchAll<{ settlement_id: string; category: string; amount: number | string | null; deduction_kind?: string | null }>((f, t) =>
      supabase.from('settlement_discount_items').select('settlement_id, category, amount, deduction_kind').eq('org_id', org).order('id').range(f, t))
    const settlementCrop = new Map<string, string>()
    for (const r of records) if (r.crop && byName.get(r.crop)) settlementCrop.set(r.settlement_id, byName.get(r.crop)!)
    const bySettlement = new Map<string, typeof items>()
    for (const it of items) {
      if (!yearSettlementIds.has(it.settlement_id)) continue
      const list = bySettlement.get(it.settlement_id) ?? []
      list.push(it)
      bySettlement.set(it.settlement_id, list)
    }
    for (const [sid, list] of bySettlement) {
      const cropId = settlementCrop.get(sid)
      if (!cropId) continue
      const rows = list.map((it) => ({ category: it.category, amount: num(it.amount), deduction_kind: it.deduction_kind ?? null }))
      checkoff.set(cropId, (checkoff.get(cropId) ?? 0) + settlementCheckoffDollars(rows as never))
      fees.set(cropId, (fees.get(cropId) ?? 0) + settlementFeeDollars(rows as never))
    }
  } catch { /* 074/086 not applied */ }
  return { byCrop, records, checkoff, fees }
}

function farmingEntities(production: ProductionInputs): Array<{ id: string; name: string }> {
  const fieldEntity = fieldEntityMap({ fields: production.fields, farms: production.farms })
  const withFields = new Set<string>()
  for (const p of production.plantings) {
    const e = fieldEntity.get(p.field_id)
    if (e) withFields.add(e)
  }
  return production.entities
    .filter((e) => e.entity_role !== 'marketing_agent' && withFields.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadMarketingPayload(supabase: SupabaseClient, org: string, year: number, idMap: IdMap): Promise<{ records: FarmLinkMarketingRecord[]; inputs: MarketingInputs }> {
  const inputs = await loadMarketingInputs(supabase, org, year)
  const { production, rows, entityInputs } = inputs
  const [finalCrops, settled] = await Promise.all([loadSalesStatus(supabase, org, year), loadSettledByCrop(supabase, org, year, production.crops)])
  const asOf = new Date().toISOString()
  const out: FarmLinkMarketingRecord[] = []
  for (const row of rows) {
    const s = settled.byCrop.get(row.cropId)
    out.push(shapeMarketingRecord({ row, cropYear: year, entity: null, settled: s ? { ...s, share: 1 } : null, isFinal: finalCrops.has(row.cropId), asOf }))
  }
  for (const e of farmingEntities(production)) {
    const scope = buildEntityScope({ entityId: e.id, farms: production.farms, fields: production.fields, entities: production.entities })
    const attribution = scope.attribution({ plantings: production.plantings, crops: production.crops })
    for (const row of computeEntityMarketingRows(entityInputs, e.id)) {
      if (row.acres <= 0 && row.totalProduction <= 0) continue
      const s = settled.byCrop.get(row.cropId)
      const share = attribution.shareForCrop(row.cropId, year)
      out.push(shapeMarketingRecord({
        row, cropYear: year, entity: { id: e.id, name: e.name, farm_uid: idMap.farmUid('entities', e.id) },
        settled: s ? { ...s, share } : null, isFinal: finalCrops.has(row.cropId), asOf,
      }))
    }
  }
  return { records: out, inputs }
}

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

export type FarmLinkIncomeRecord = {
  id: string
  crop_id: string
  crop: string
  crop_year: number
  entity_id: string | null
  entity_name: string | null
  entity_farm_uid: string | null
  unit: 'bu' | 'lbs'
  acres: number
  total_production: number
  crop_revenue: {
    /** The Revenue Projections figure: settlements, contracts, and realized hedging folded in exactly once. */
    total: number
    components: { settled_revenue: number; hedging_realized: number; checkoff: number; fees: number }
    attribution: 'operation' | 'by_acres'
  }
  government_payments: {
    total: number
    arc_plc: number
    other_crop_specific: number
    other_allocated: number
    by_program_farm: Array<{ program: string; farm_id: string | null; farm_code: string | null; farm_farm_uid: string | null; commodity: string | null; net: number }>
    attribution: 'by_acres'
  }
  crop_insurance: { indemnities: number; premium: number; net: number; attribution: 'by_entity' }
  other_income: { total: number }
  total_revenue: number
  as_of: string
  updated_at: string
}

type IncomeBundle = {
  policies: CropInsurancePolicy[]; scos: CropInsuranceSco[]; ecos: CropInsuranceEco[]; staxes: CropInsuranceStax[]; mcos: CropInsuranceMco[]
  estimates: HarvestPriceEstimate[]; programConfigs: ProgramYearConfig[]; countyAssumptions: CountyYieldAssumption[]
  commodities: CoveredCommodity[]; baseAcres: FarmBaseAcres[]; elections: ArcPlcElection[]; priceData: ArcPlcPriceData[]
  arcPayments: ArcPlcPayment[]; otherPayments: OtherGovernmentPayment[]
  loads: Array<{ id: string; date: string; time?: string | null; crop_id: string | null; crop_year: number | null; from_type: string | null; from_field_id: string | null; net_weight: number | null; moisture: number | null; dry_bushels_override: number | null }>
  splits: Array<{ load_id: string; field_id: string; crop_id: string; dry_bushels: number | null }>
  combineEntries: CombineEntryLike[]
  farms: Array<{ id: string; fsa_number: string | null; entity_id: string | null }>
}

async function loadIncomeBundle(supabase: SupabaseClient, org: string, year: number): Promise<IncomeBundle> {
  const q = <T,>(table: string, select: string, extra?: (b: ReturnType<SupabaseClient['from']>['select'] extends never ? never : any) => any) =>
    fetchAll<T>((f, t) => {
      let b: any = supabase.from(table).select(select).eq('org_id', org)
      if (extra) b = extra(b)
      return b.order('id').range(f, t)
    })
  const tolerant = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[])
  const [policies, scos, ecos, staxes, mcos, estimates, countyAssumptions, baseAcres, elections, arcPayments, otherPayments, loads, splits, combineEntries, farms] = await Promise.all([
    q<CropInsurancePolicy>('crop_insurance_policies', '*', (b) => b.eq('crop_year', year)),
    tolerant(q<CropInsuranceSco>('crop_insurance_sco', '*')),
    tolerant(q<CropInsuranceEco>('crop_insurance_eco', '*')),
    tolerant(q<CropInsuranceStax>('crop_insurance_stax', '*')),
    tolerant(q<CropInsuranceMco>('crop_insurance_mco', '*')),
    q<HarvestPriceEstimate>('harvest_price_estimates', '*'),
    tolerant(q<CountyYieldAssumption>('county_yield_assumptions', '*')),
    q<FarmBaseAcres>('farm_base_acres', '*'),
    q<ArcPlcElection>('arc_plc_elections', '*'),
    q<ArcPlcPayment>('arc_plc_payments', '*'),
    q<OtherGovernmentPayment>('other_government_payments', '*'),
    q<IncomeBundle['loads'][number]>('loads', 'id, date, time, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override', (b) => b.eq('crop_year', year)),
    q<IncomeBundle['splits'][number]>('load_splits', 'load_id, field_id, crop_id, dry_bushels'),
    tolerant(q<CombineEntryLike>('combine_yield_entries', 'id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date', (b) => b.eq('crop_year', year))),
    q<IncomeBundle['farms'][number]>('farms', 'id, fsa_number, entity_id'),
  ])
  // Global reference tables (no org_id).
  const [commodities, priceData, programConfigs] = await Promise.all([
    fetchAll<CoveredCommodity>((f, t) => supabase.from('covered_commodities').select('*').order('id').range(f, t)),
    fetchAll<ArcPlcPriceData>((f, t) => supabase.from('arc_plc_price_data').select('*').order('id').range(f, t)),
    fetchAll<ProgramYearConfig>((f, t) => supabase.from('program_year_config').select('*').order('crop_year').range(f, t)),
  ])
  return { policies, scos, ecos, staxes, mcos, estimates, programConfigs, countyAssumptions, commodities, baseAcres, elections, priceData, arcPayments, otherPayments, loads, splits, combineEntries, farms }
}

export function shapeIncomeRecords(args: {
  cropYear: number
  rows: readonly MarketingRow[]
  scopedContracts: readonly import('@/lib/types').Contract[]
  entity: { id: string; name: string; farm_uid: string | null } | null
  settled: SettledByCrop
  settledShareForCrop: (cropId: string) => number
  checkoff: ReadonlyMap<string, number>
  fees: ReadonlyMap<string, number>
  insuranceByCrop: ReadonlyMap<string, InsuranceProceeds>
  projectedPayments: readonly ProjectedPayment[]
  otherPayments: readonly OtherGovernmentPayment[]
  farms: ReadonlyArray<{ id: string; fsa_number: string | null }>
  commodities: ReadonlyArray<{ id: string; name: string }>
  idMap: IdMap
  asOf: string
  /** 088: crops whose cost/acre already carries the premium (see cropsWithInsuranceInCost). */
  costIncludesInsuranceCropIds?: ReadonlySet<string>
}): FarmLinkIncomeRecord[] {
  const totalArcPlc = args.projectedPayments.reduce((s, p) => s + p.result.net, 0)
  const nonSpecificOther = args.otherPayments.filter((o) => !o.crop_id).reduce((s, o) => s + num(o.amount), 0)
  const cropSpecific = new Map<string, number>()
  for (const o of args.otherPayments) if (o.crop_id) cropSpecific.set(o.crop_id, (cropSpecific.get(o.crop_id) ?? 0) + num(o.amount))
  const totalAcres = args.rows.reduce((s, r) => s + r.acres, 0)
  const govtByCrop = new Map<string, GovtProceeds>()
  for (const r of args.rows) {
    const share = totalAcres > 0 ? r.acres / totalAcres : 0
    govtByCrop.set(r.cropId, { arcPlc: totalArcPlc * share, allocatedOther: nonSpecificOther * share, cropSpecificOther: cropSpecific.get(r.cropId) ?? 0 })
  }
  const marketPriceByCrop = new Map<string, number>()
  for (const r of args.rows) if (r.avgCashPrice != null) marketPriceByCrop.set(r.cropId, r.avgCashPrice)
  const { rows } = computeRevenueProjections({
    marketingRows: [...args.rows], contracts: [...args.scopedContracts], cropYear: args.cropYear,
    marketPriceByCrop, insuranceByCrop: new Map(args.insuranceByCrop), govtByCrop,
    costIncludesInsuranceCropIds: args.costIncludesInsuranceCropIds,
  })
  const farmById = new Map(args.farms.map((f) => [f.id, f]))
  const commodityById = new Map(args.commodities.map((c) => [c.id, c.name]))
  return rows.map((r) => {
    const share = totalAcres > 0 ? r.acres / totalAcres : 0
    const mrow = args.rows.find((x) => x.cropId === r.cropId)
    const s = args.settled.get(r.cropId)
    const settledShare = args.settledShareForCrop(r.cropId)
    const byProgramFarm: FarmLinkIncomeRecord['government_payments']['by_program_farm'] = args.projectedPayments
      .filter((p) => p.result.net !== 0)
      .map((p) => ({
        program: String(p.election), farm_id: p.farmId as string | null, farm_code: farmById.get(p.farmId)?.fsa_number ?? null,
        farm_farm_uid: args.idMap.farmUid('farms', p.farmId), commodity: commodityById.get(p.commodityId) ?? null,
        net: r2(p.result.net * share),
      }))
    for (const o of args.otherPayments) {
      if (o.crop_id && o.crop_id !== r.cropId) continue
      const amount = o.crop_id ? num(o.amount) : num(o.amount) * share
      if (amount === 0) continue
      byProgramFarm.push({
        program: o.program_name, farm_id: o.farm_id, farm_code: o.farm_id ? farmById.get(o.farm_id)?.fsa_number ?? null : null,
        farm_farm_uid: args.idMap.farmUid('farms', o.farm_id), commodity: null, net: r2(amount),
      })
    }
    return {
      id: `${r.cropId}|${args.entity?.id ?? 'all'}`,
      crop_id: r.cropId, crop: r.cropName, crop_year: args.cropYear,
      entity_id: args.entity?.id ?? null, entity_name: args.entity?.name ?? null, entity_farm_uid: args.entity?.farm_uid ?? null,
      unit: r.unit, acres: r2(r.acres), total_production: r2(r.totalProduction),
      crop_revenue: {
        total: r2(r.cropSalesRevenue),
        components: {
          settled_revenue: r2((s?.revenue ?? 0) * settledShare),
          hedging_realized: r2(mrow?.hedgeRealizedPnl ?? 0),
          checkoff: r2((args.checkoff.get(r.cropId) ?? 0) * settledShare),
          fees: r2((args.fees.get(r.cropId) ?? 0) * settledShare),
        },
        attribution: args.entity ? 'by_acres' : 'operation',
      },
      government_payments: {
        total: r2(r.govtPayments), arc_plc: r2(r.govtArcPlc), other_crop_specific: r2(r.govtCropSpecificOther), other_allocated: r2(r.govtAllocatedOther),
        by_program_farm: byProgramFarm, attribution: 'by_acres',
      },
      crop_insurance: { indemnities: r2(r.insuranceIndemnity), premium: r2(r.insurancePremium), net: r2(r.insuranceProceeds), attribution: 'by_entity' },
      other_income: { total: 0 },
      total_revenue: r2(r.totalRevenue),
      as_of: args.asOf, updated_at: args.asOf,
    }
  })
}

export async function loadIncomePayload(supabase: SupabaseClient, org: string, year: number, idMap: IdMap): Promise<FarmLinkIncomeRecord[]> {
  const [{ inputs }, bundle] = await Promise.all([loadMarketingPayload(supabase, org, year, idMap), loadIncomeBundle(supabase, org, year)])
  const { production, rows, entityInputs } = inputs
  const settled = await loadSettledByCrop(supabase, org, year, production.crops)
  const asOf = new Date().toISOString()
  const cropById = new Map(production.crops.map((c) => [c.id, c]))
  const yearPlantings = production.plantings.filter((p) => p.season_year === year)
  const effPlantings = withLoadBreakouts(yearPlantings, fieldCropAggregates(bundle.loads, bundle.splits, cropById, { cropYear: year, combineEntries: bundle.combineEntries }))
  const actualYieldByCrop = actualYieldByCropFromLoads({ loads: bundle.loads, plantings: production.plantings, crops: production.crops, cropYear: year, combineEntries: bundle.combineEntries })
  const scoTrigger = resolveProgramYearConfig(year, bundle.programConfigs).scoTrigger
  const programYear = programYearFor(year)
  const effPrice = applyMyaResolution({ cropYear: programYear, commodities: bundle.commodities, priceData: bundle.priceData, liveEstimates: new Map() })
  const allProjectedPayments = projectPayments({ cropYear: programYear, baseAcres: bundle.baseAcres, commodities: bundle.commodities, elections: bundle.elections, priceData: effPrice, payments: bundle.arcPayments })

  const build = (entity: { id: string; name: string } | null, mrows: readonly MarketingRow[]) => {
    const scope = buildEntityScope({ entityId: entity?.id ?? '', farms: production.farms, fields: production.fields, entities: production.entities })
    const attribution = scope.attribution({ plantings: production.plantings, crops: production.crops })
    const scopedPolicies = scope.byEntity(bundle.policies)
    const projected = projectInsuranceIndemnities({
      cropYear: year, policies: scopedPolicies, scos: bundle.scos, ecos: bundle.ecos, staxes: bundle.staxes, mcos: bundle.mcos,
      assumptions: production.assumptions, plantings: effPlantings, actualYieldByCrop, harvestEstimates: bundle.estimates,
      crops: production.crops, scoTrigger, countyAssumptions: bundle.countyAssumptions,
    })
    const insuranceByCrop = new Map<string, InsuranceProceeds>()
    for (const p of projected) {
      const cur = insuranceByCrop.get(p.policy.crop_id) ?? { netPnl: 0, totalIndemnity: 0, premium: 0 }
      cur.netPnl += p.comp.netPnl
      cur.totalIndemnity += p.comp.totalIndemnity
      cur.premium += p.comp.premiumPaid
      insuranceByCrop.set(p.policy.crop_id, cur)
    }
    const projectedPayments = allProjectedPayments.filter((p) => scope.farmInEntity(p.farmId))
    const otherPayments = otherPaymentsInRevenueYear(scope.otherPayments(bundle.otherPayments), year)
    return shapeIncomeRecords({
      cropYear: year, rows: mrows, scopedContracts: attribution.contracts(entityInputs.contracts),
      entity: entity ? { ...entity, farm_uid: idMap.farmUid('entities', entity.id) } : null,
      settled: settled.byCrop, settledShareForCrop: (cropId) => (entity ? attribution.shareForCrop(cropId, year) : 1),
      checkoff: settled.checkoff, fees: settled.fees, insuranceByCrop, projectedPayments, otherPayments,
      farms: bundle.farms, commodities: bundle.commodities, idMap, asOf,
      costIncludesInsuranceCropIds: cropsWithInsuranceInCost(production.assumptions, year),
    })
  }
  const out = build(null, rows)
  for (const e of farmingEntities(production)) {
    const mrows = computeEntityMarketingRows(entityInputs, e.id).filter((r) => r.acres > 0 || r.totalProduction > 0)
    if (mrows.length > 0) out.push(...build(e, mrows))
  }
  return out
}

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

export type FarmLinkBinRecord = {
  id: string
  bin_id: string
  bin_name: string
  site_id: string | null
  site_name: string | null
  entity_id: string | null
  entity_farm_uid: string | null
  capacity_bushels: number | null
  crop_id: string
  crop: string
  crop_year: number
  as_of: string
  bushels_on_hand: number
  bushels_in_for_year: number
  updated_at: string
}

export type BinInventoryInputs = {
  bins: ReadonlyArray<{ id: string; name_or_number: string; crop_id: string | null; bin_site_id: string | null; capacity_bushels: number | string | null }>
  sites: ReadonlyArray<{ id: string; name: string; entity_id: string | null }>
  crops: ReadonlyArray<{ id: string; name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null }>
  loads: ReadonlyArray<{ id: string; date: string; net_weight: number | null; moisture: number | null; crop_id: string | null; crop_year: number | null; dry_bushels_override: number | null; from_type: string | null; from_field_id: string | null; from_bin_id: string | null; to_type: string | null; to_bin_id: string | null; updated_at?: string | null }>
  splits: ReadonlyArray<{ load_id: string; field_id: string; crop_id: string; dry_bushels: number | null }>
  combineEntries: readonly CombineEntryLike[]
  adjustments: ReadonlyArray<{ bin_id: string; crop_id: string; adjustment_type: string; bushels: number | string; as_of_date: string }>
  transfers: ReadonlyArray<{ from_bin_id: string; to_bin_id: string; crop_id: string; bushels: number | string; transfer_date: string }>
  cropYear: number
  /** ISO date; loads dated after it are ignored (a point-in-time view). */
  asOf: string
  idMap: IdMap
}

/** The /inventory page's assembly (loads ± adjustments ± transfers + combine
 *  remainders) as a pure function, plus the per-year inflow Grain's page
 *  does not show: dry bushels delivered INTO the bin on loads of the crop year
 *  (+ the crop year's positive combine remainders). */
export function assembleBinInventory(args: BinInventoryInputs): FarmLinkBinRecord[] {
  const asOfDate = args.asOf.slice(0, 10)
  const cropById = new Map(args.crops.map((c) => [c.id, c]))
  const siteById = new Map(args.sites.map((s) => [s.id, s]))
  const onHand: OnHandBag = new Map()
  for (const b of args.bins) onHand.set(b.id, new Map())
  const inflow = new Map<string, number>() // `${bin}|${crop}`
  const loads = args.loads.filter((l) => l.date.slice(0, 10) <= asOfDate)
  for (const l of loads) {
    if (!l.crop_id) continue
    const crop = cropById.get(l.crop_id)
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight, moisturePct: l.moisture, baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null, dryBushelsOverride: l.dry_bushels_override,
    })
    if (!dryBushels) continue
    if (l.to_type === 'bin' && l.to_bin_id && onHand.has(l.to_bin_id)) {
      cellFor(onHand, l.to_bin_id, l.crop_id).loadBacked += dryBushels
      if (l.crop_year === args.cropYear) inflow.set(`${l.to_bin_id}|${l.crop_id}`, (inflow.get(`${l.to_bin_id}|${l.crop_id}`) ?? 0) + dryBushels)
    }
    if (l.from_type === 'bin' && l.from_bin_id && onHand.has(l.from_bin_id)) {
      cellFor(onHand, l.from_bin_id, l.crop_id).loadBacked -= dryBushels
    }
  }
  for (const a of args.adjustments) {
    if (!onHand.has(a.bin_id) || a.as_of_date.slice(0, 10) > asOfDate) continue
    const cell = cellFor(onHand, a.bin_id, a.crop_id)
    if (a.adjustment_type === 'beginning_inventory') cell.beginning += num(a.bushels)
    else cell.emptyAdj += num(a.bushels)
  }
  applyTransfers(onHand, args.transfers.filter((t) => t.transfer_date.slice(0, 10) <= asOfDate).map((t) => ({ ...t, bushels: num(t.bushels) })))
  if (args.combineEntries.length > 0) {
    const aggByKey = fieldCropAggregates(loads, args.splits, cropById, { combineEntries: args.combineEntries })
    const remainders = args.combineEntries.map((e) => ({
      crop_id: e.crop_id, destinationBinId: e.destination_bin_id,
      remainderBu: aggByKey.get(`${e.field_id}|${e.crop_id}|${e.crop_year}`)?.combine?.remainderBu ?? 0,
      crop_year: e.crop_year,
    }))
    applyCombineRemainders(onHand, remainders)
    for (const r of remainders) {
      if (r.crop_year !== args.cropYear || !r.destinationBinId || r.remainderBu <= 0 || !onHand.has(r.destinationBinId)) continue
      inflow.set(`${r.destinationBinId}|${r.crop_id}`, (inflow.get(`${r.destinationBinId}|${r.crop_id}`) ?? 0) + r.remainderBu)
    }
  }
  const out: FarmLinkBinRecord[] = []
  for (const b of args.bins) {
    const site = b.bin_site_id ? siteById.get(b.bin_site_id) ?? null : null
    const cells = onHand.get(b.id) ?? new Map()
    const cropIds = new Set<string>([...cells.keys()])
    for (const k of inflow.keys()) if (k.startsWith(`${b.id}|`)) cropIds.add(k.slice(b.id.length + 1))
    if (cropIds.size === 0 && b.crop_id) cropIds.add(b.crop_id)
    for (const cropId of cropIds) {
      const crop = cropById.get(cropId)
      if (!crop) continue
      const cell = cells.get(cropId)
      const on = cell ? cellTotal(cell) : 0
      const inYear = inflow.get(`${b.id}|${cropId}`) ?? 0
      if (Math.abs(on) < 0.005 && inYear < 0.005 && b.crop_id !== cropId) continue
      out.push({
        id: `${b.id}|${cropId}`, bin_id: b.id, bin_name: b.name_or_number, site_id: site?.id ?? null, site_name: site?.name ?? null,
        entity_id: site?.entity_id ?? null, entity_farm_uid: args.idMap.farmUid('entities', site?.entity_id),
        capacity_bushels: b.capacity_bushels == null ? null : num(b.capacity_bushels),
        crop_id: cropId, crop: crop.name, crop_year: args.cropYear, as_of: args.asOf,
        bushels_on_hand: r2(on), bushels_in_for_year: r2(inYear), updated_at: args.asOf,
      })
    }
  }
  return out.sort((a, b) => (a.site_name ?? '').localeCompare(b.site_name ?? '') || a.bin_name.localeCompare(b.bin_name) || a.crop.localeCompare(b.crop))
}

export async function loadBinsPayload(supabase: SupabaseClient, org: string, year: number, asOf: string, idMap: IdMap): Promise<FarmLinkBinRecord[]> {
  const asOfDate = asOf.slice(0, 10)
  const [bins, sites, crops, loads, splits, adjustments, transfers] = await Promise.all([
    fetchAll<BinInventoryInputs['bins'][number]>((f, t) => supabase.from('bins').select('id, name_or_number, crop_id, bin_site_id, capacity_bushels').eq('org_id', org).order('id').range(f, t)),
    fetchAll<BinInventoryInputs['sites'][number]>((f, t) => supabase.from('bin_sites').select('id, name, entity_id').eq('org_id', org).order('id').range(f, t)),
    fetchAll<BinInventoryInputs['crops'][number]>((f, t) => supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').eq('org_id', org).order('id').range(f, t)),
    fetchAll<BinInventoryInputs['loads'][number]>((f, t) =>
      supabase.from('loads').select('id, date, net_weight, moisture, crop_id, crop_year, dry_bushels_override, from_type, from_field_id, from_bin_id, to_type, to_bin_id, updated_at').eq('org_id', org).lte('date', asOfDate).order('id').range(f, t)),
    fetchAll<BinInventoryInputs['splits'][number]>((f, t) => supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels').eq('org_id', org).order('id').range(f, t)),
    fetchAll<BinInventoryInputs['adjustments'][number]>((f, t) =>
      supabase.from('bin_inventory_adjustments').select('bin_id, crop_id, adjustment_type, bushels, as_of_date').eq('org_id', org).lte('as_of_date', asOfDate).order('id').range(f, t)),
    fetchAll<BinInventoryInputs['transfers'][number]>((f, t) =>
      supabase.from('bin_transfers').select('from_bin_id, to_bin_id, crop_id, bushels, transfer_date').eq('org_id', org).lte('transfer_date', asOfDate).order('id').range(f, t)).catch(() => []),
  ])
  let combineEntries: CombineEntryLike[] = []
  try {
    combineEntries = await fetchAll<CombineEntryLike>((f, t) =>
      supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date').eq('org_id', org).order('id').range(f, t))
  } catch { /* 062 not applied */ }
  return assembleBinInventory({ bins, sites, crops, loads, splits, combineEntries, adjustments, transfers, cropYear: year, asOf, idMap })
}

// ---------------------------------------------------------------------------
// Crop insurance (088)
// ---------------------------------------------------------------------------
//
// The premiums Grain already allocates by entity and crop, so Turnrow Farm
// does not ask the farmer for them a second time. ONE row per entity x crop x
// practice x crop year: crop insurance in Grain is carried per POLICY (entity
// x crop x county x crop_year x practice, plus its SCO/ECO/STAX/MCO riders),
// so two policies for the same entity, crop, and practice in different
// counties sum into one row. Nothing is per field, so allocation_basis is
// always 'entity_crop' and the Farm side spreads by planted acres.
//
// producer_premium is the farmer-paid number (policy + every rider), the same
// premium the Claims Monitor and the income pull subtract. subsidy and
// total_premium are informational and derived from premium_subsidy_pct: the
// stored premium is AFTER subsidy, so subsidy = producer x pct / (100 - pct)
// and total = producer + subsidy. The percentage lives on the base policy
// only, so rider premiums raise producer_premium and total_premium without
// adding subsidy; a row whose policies carry no percentage returns null for
// both rather than a made-up zero.
//
// Indemnities are informational here (they already flow through the income
// pull): indemnity_expected is Grain's projection at the current harvest-price
// tier, and indemnity_received repeats it only once every contributing policy
// resolves to a FINAL harvest price - Grain never records a cheque, so a
// number that could still move is never called received.

export type FarmLinkInsuranceRecord = {
  /** `${entity|'operation'}|${crop_id}|${practice|'all'}|${crop_year}` - stable across pulls. */
  id: string
  /** Turnrow Farm's key for the entity (the id map's farm_uid); null until the land sync has linked it - match on entity_name then. */
  entity_code: string | null
  entity_id: string | null
  entity_name: string | null
  /** Alias of entity_code, for symmetry with the production / marketing / income / bins records. */
  entity_farm_uid: string | null
  crop_id: string
  crop: string
  crop_year: number
  /** 'irrigated' | 'dryland'; null when the policy does not split by practice. */
  practice: 'irrigated' | 'dryland' | null
  plan: 'RP' | 'YP' | 'RPHPE' | 'ARP' | 'other'
  coverage_level: number | null
  unit_structure: 'basic' | 'optional' | 'enterprise' | 'mixed' | null
  acres_insured: number
  producer_premium: number
  subsidy: number | null
  total_premium: number | null
  indemnity_received: number | null
  indemnity_expected: number
  allocation_basis: 'entity_crop'
  /** Grain records no sales closing or policy date today, so this is always null. */
  effective_date: string | null
  /** How many policies (not riders) rolled into the row. */
  policy_count: number
  updated_at: string
  /** Only on a ?since= pull: the row is gone here and should be removed there. */
  deleted?: true
}

const PLAN_OUT: Record<string, FarmLinkInsuranceRecord['plan']> = {
  RP: 'RP', YP: 'YP', RP_HPE: 'RPHPE', ARP: 'ARP', AYP: 'other',
}

/** Grain stores 'non_irrigated'; the contract says 'dryland'. */
function practiceOut(p: string | null | undefined): 'irrigated' | 'dryland' | null {
  if (p === 'irrigated') return 'irrigated'
  if (p === 'non_irrigated') return 'dryland'
  return null
}

export type InsuranceDeletionRow = {
  crop_year: number
  entity_id: string | null
  crop_id: string | null
  practice: string | null
  deleted_at: string
}

export type InsuranceShaperInputs = {
  cropYear: number
  /** Every projected policy for the year, unscoped: policies carry their own entity. */
  projected: readonly ProjectedPolicy[]
  entities: ReadonlyArray<{ id: string; name: string }>
  crops: ReadonlyArray<{ id: string; name: string }>
  /** policy id -> the newest updated_at across the policy and its riders. */
  touchedAt: ReadonlyMap<string, string>
  /** The 088 tombstones for the crop year. */
  deletions: readonly InsuranceDeletionRow[]
  idMap: IdMap
  asOf: string
}

/** One row per entity x crop x practice; the tombstones both bump a surviving
 *  row's updated_at (a rider removed off a policy that is still there) and
 *  raise a `deleted: true` row for a key nothing covers any more. */
export function shapeInsuranceRecords(args: InsuranceShaperInputs): FarmLinkInsuranceRecord[] {
  const entityById = new Map(args.entities.map((e) => [e.id, e]))
  const cropById = new Map(args.crops.map((c) => [c.id, c]))
  const keyOf = (entityId: string | null, cropId: string | null, practice: string | null) =>
    `${entityId ?? 'operation'}|${cropId ?? 'none'}|${practiceOut(practice) ?? 'all'}|${args.cropYear}`

  type Bucket = {
    entityId: string | null; cropId: string; practice: string | null
    acres: number; producer: number; subsidy: number; anySubsidyPct: boolean
    indemnity: number; allFinal: boolean; policies: number
    plans: Set<string>; units: Set<string>; coverageAcreWeighted: number; coverageAcres: number
    updatedAt: string
  }
  const buckets = new Map<string, Bucket>()

  for (const p of args.projected) {
    if (p.policy.crop_year !== args.cropYear) continue
    const k = keyOf(p.policy.entity_id, p.policy.crop_id, p.policy.practice)
    let b = buckets.get(k)
    if (!b) {
      b = {
        entityId: p.policy.entity_id ?? null, cropId: p.policy.crop_id, practice: p.policy.practice ?? null,
        acres: 0, producer: 0, subsidy: 0, anySubsidyPct: false, indemnity: 0, allFinal: true, policies: 0,
        plans: new Set(), units: new Set(), coverageAcreWeighted: 0, coverageAcres: 0, updatedAt: '',
      }
      buckets.set(k, b)
    }
    const acres = num(p.policy.insured_acres)
    // premiumPaid is the producer-paid policy + every rider - the same figure
    // the Claims Monitor and the income pull net against indemnities.
    b.acres += acres
    b.producer += num(p.comp.premiumPaid)
    b.indemnity += num(p.comp.totalIndemnity)
    b.policies += 1
    b.plans.add(p.policy.plan_type)
    b.units.add(p.policy.unit_structure)
    if (acres > 0) { b.coverageAcreWeighted += num(p.policy.coverage_level) * acres; b.coverageAcres += acres }
    // The percentage is the BASE policy's, so it applies to the base premium
    // only; riders carry their own (unrecorded) subsidy rates.
    const pct = p.policy.premium_subsidy_pct == null ? null : num(p.policy.premium_subsidy_pct)
    if (pct != null && pct > 0 && pct < 100) { b.anySubsidyPct = true; b.subsidy += (num(p.basePremium) * pct) / (100 - pct) }
    if (p.harvest.source !== 'final') b.allFinal = false
    const touched = args.touchedAt.get(p.policy.id) ?? p.policy.created_at ?? args.asOf
    if (touched > b.updatedAt) b.updatedAt = touched
  }

  // Tombstones: the newest deletion per key, whether or not the key survived.
  const deletedAtByKey = new Map<string, string>()
  for (const d of args.deletions) {
    if (d.crop_year !== args.cropYear) continue
    const k = keyOf(d.entity_id, d.crop_id, d.practice)
    const cur = deletedAtByKey.get(k)
    if (!cur || d.deleted_at > cur) deletedAtByKey.set(k, d.deleted_at)
  }

  const out: FarmLinkInsuranceRecord[] = []
  for (const [k, b] of buckets) {
    const entity = b.entityId ? entityById.get(b.entityId) ?? null : null
    const farmUid = b.entityId ? args.idMap.farmUid('entities', b.entityId) : null
    const plans = Array.from(b.plans)
    const units = Array.from(b.units)
    // A rider removed off a surviving policy leaves the policy's own
    // updated_at untouched, so the tombstone is what moves the row.
    const tomb = deletedAtByKey.get(k)
    const updatedAt = tomb && tomb > b.updatedAt ? tomb : (b.updatedAt || args.asOf)
    const subsidy = b.anySubsidyPct ? r2(b.subsidy) : null
    out.push({
      id: k,
      entity_code: farmUid, entity_id: b.entityId, entity_name: entity?.name ?? null, entity_farm_uid: farmUid,
      crop_id: b.cropId, crop: cropById.get(b.cropId)?.name ?? '', crop_year: args.cropYear,
      practice: practiceOut(b.practice),
      plan: plans.length === 1 ? PLAN_OUT[plans[0]] ?? 'other' : 'other',
      coverage_level: b.coverageAcres > 0 ? r4(b.coverageAcreWeighted / b.coverageAcres) : null,
      unit_structure: units.length === 1 ? (units[0] as 'basic' | 'optional' | 'enterprise') : units.length > 1 ? 'mixed' : null,
      acres_insured: r2(b.acres),
      producer_premium: r2(b.producer),
      subsidy,
      total_premium: subsidy == null ? null : r2(b.producer + subsidy),
      indemnity_received: b.allFinal && b.policies > 0 ? r2(b.indemnity) : null,
      indemnity_expected: r2(b.indemnity),
      allocation_basis: 'entity_crop',
      effective_date: null,
      policy_count: b.policies,
      updated_at: updatedAt,
    })
  }

  // Keys with a tombstone and nothing left covering them are gone.
  for (const [k, deletedAt] of deletedAtByKey) {
    if (buckets.has(k)) continue
    const [entityPart, cropId, practicePart] = k.split('|')
    const entityId = entityPart === 'operation' ? null : entityPart
    const farmUid = entityId ? args.idMap.farmUid('entities', entityId) : null
    out.push({
      id: k,
      entity_code: farmUid, entity_id: entityId, entity_name: entityId ? entityById.get(entityId)?.name ?? null : null, entity_farm_uid: farmUid,
      crop_id: cropId === 'none' ? '' : cropId, crop: cropById.get(cropId)?.name ?? '', crop_year: args.cropYear,
      practice: practicePart === 'all' ? null : (practicePart as 'irrigated' | 'dryland'),
      plan: 'other', coverage_level: null, unit_structure: null,
      acres_insured: 0, producer_premium: 0, subsidy: null, total_premium: null,
      indemnity_received: null, indemnity_expected: 0,
      allocation_basis: 'entity_crop', effective_date: null, policy_count: 0,
      updated_at: deletedAt, deleted: true,
    })
  }

  return out.sort((a, b) =>
    (a.entity_name ?? '').localeCompare(b.entity_name ?? '') || a.crop.localeCompare(b.crop) || (a.practice ?? '').localeCompare(b.practice ?? ''))
}

/** The riders' own last-change stamps, keyed by policy. Tolerates 088 not
 *  being applied (no updated_at column yet) and 045 not being applied. */
async function loadInsuranceRiderStamps(supabase: SupabaseClient, org: string): Promise<Array<{ policy_id: string; updated_at: string }>> {
  const tables = ['crop_insurance_sco', 'crop_insurance_eco', 'crop_insurance_stax', 'crop_insurance_mco']
  const out: Array<{ policy_id: string; updated_at: string }> = []
  for (const table of tables) {
    try {
      const rows = await fetchAll<{ policy_id: string; updated_at: string | null }>((f, t) =>
        supabase.from(table).select('policy_id, updated_at').eq('org_id', org).order('id').range(f, t))
      for (const r of rows) if (r.updated_at) out.push({ policy_id: r.policy_id, updated_at: r.updated_at })
    } catch { /* the table or the 088 column is not there yet */ }
  }
  return out
}

/** The 088 tombstone log for the crop year. Empty until 088 is applied. */
async function loadInsuranceDeletions(supabase: SupabaseClient, org: string, year: number): Promise<InsuranceDeletionRow[]> {
  try {
    return await fetchAll<InsuranceDeletionRow>((f, t) =>
      supabase.from('crop_insurance_deletions').select('crop_year, entity_id, crop_id, practice, deleted_at').eq('org_id', org).eq('crop_year', year).order('id').range(f, t))
  } catch {
    return []
  }
}

export async function loadInsurancePayload(supabase: SupabaseClient, org: string, year: number, idMap: IdMap): Promise<FarmLinkInsuranceRecord[]> {
  const [production, bundle, riders, deletions] = await Promise.all([
    loadProductionInputs(supabase, org, year),
    loadIncomeBundle(supabase, org, year),
    loadInsuranceRiderStamps(supabase, org),
    loadInsuranceDeletions(supabase, org, year),
  ])
  const asOf = new Date().toISOString()
  const cropById = new Map(production.crops.map((c) => [c.id, c]))
  const yearPlantings = production.plantings.filter((p) => p.season_year === year)
  const effPlantings = withLoadBreakouts(yearPlantings, fieldCropAggregates(bundle.loads, bundle.splits, cropById, { cropYear: year, combineEntries: bundle.combineEntries }))
  const actualYieldByCrop = actualYieldByCropFromLoads({ loads: bundle.loads, plantings: production.plantings, crops: production.crops, cropYear: year, combineEntries: bundle.combineEntries })
  const scoTrigger = resolveProgramYearConfig(year, bundle.programConfigs).scoTrigger
  // Unscoped: a policy attributes to its OWN entity, so one pass covers every
  // row (the attribution the income pull documents as `by_entity`).
  const projected = projectInsuranceIndemnities({
    cropYear: year, policies: bundle.policies, scos: bundle.scos, ecos: bundle.ecos, staxes: bundle.staxes, mcos: bundle.mcos,
    assumptions: production.assumptions, plantings: effPlantings, actualYieldByCrop, harvestEstimates: bundle.estimates,
    crops: production.crops, scoTrigger, countyAssumptions: bundle.countyAssumptions,
  })
  // A row's updated_at is the newest change across the policy and its riders.
  const touchedAt = new Map<string, string>()
  for (const p of bundle.policies) {
    const own = (p as { updated_at?: string | null }).updated_at ?? p.created_at ?? null
    if (own) touchedAt.set(p.id, own)
  }
  for (const r of riders) {
    const cur = touchedAt.get(r.policy_id)
    if (!cur || r.updated_at > cur) touchedAt.set(r.policy_id, r.updated_at)
  }
  return shapeInsuranceRecords({
    cropYear: year, projected, entities: production.entities, crops: production.crops,
    touchedAt, deletions, idMap, asOf,
  })
}
