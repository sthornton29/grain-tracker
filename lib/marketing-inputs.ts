// Server-side assembly of the marketing engine's inputs for SERVICE-ROLE
// callers (the partner API's lease-projection endpoints and the farmer-facing
// /settings/shares preview). The service role BYPASSES RLS, so — unlike the
// session-client assembly the Ask-Turnrow tools use (lib/assistant-tools.ts)
// — every query here scopes .eq('org_id', org) explicitly and pages through
// fetchAll. The derivation chain is the same pure-lib pipeline the Marketing
// dashboard runs (segmentAcresByCrop → expectedProductionFromBreakout,
// fieldCropAggregates, cropsWithCompleteHarvest, computeMarketing), and the
// current-futures quotes resolve through the same reference-contract seam +
// the market_prices day-cache the dashboard's /api/market-prices route feeds,
// so the numbers match the dashboard headline.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeMarketing,
  expectedProductionFromBreakout,
  isCottonCrop,
  segmentAcresByCrop,
  type MarketingRow,
} from '@/lib/marketing'
import { buildDoubleCropSet } from '@/lib/plantings'
import {
  analyzeYields,
  cropsWithCompleteHarvest,
  expectedYieldForPlanting,
  fieldCropAggregates,
  type ExclusionReason,
  type FieldCropAgg,
} from '@/lib/yields'
import {
  fallForwardOnMissingQuote,
  marketingReferenceContract,
  referenceMonthOptions,
} from '@/lib/reference-contract'
import { normalizeBarchartPrice } from '@/lib/hedging'
import { fetchCottonPhysical } from '@/lib/cotton-physical-fetch'
import { fetchSeedContracts } from '@/lib/seed-contracts-fetch'
import { buildSeedCommitments, type SeedContractBundle, type SeedCropCommitment } from '@/lib/seed-contracts'
import type { CottonPhysicalInputs } from '@/lib/cotton-sales'
import type { EntityMarketingInputs } from '@/lib/entity-marketing'
import { fetchAll } from '@/lib/partner-api-server'
import type {
  Contract,
  Crop,
  CropAssumption,
  FieldPlanting,
  FuturesPosition,
  OptionPosition,
} from '@/lib/types'

// ---------------------------------------------------------------------------
// Production inputs (the yields side — everything /projected-yields needs)
// ---------------------------------------------------------------------------

export type ProductionInputs = {
  crops: Crop[]
  fields: Array<{ id: string; name_or_number: string; farm_id: string | null }>
  /** Farm → entity, and the entities with their 051 role — the inputs
   *  buildEntityScope needs for the per-entity partner rows. */
  farms: Array<{ id: string; entity_id: string | null }>
  entities: Array<{ id: string; name: string; entity_role: string | null }>
  /** The year's gin receipts (raw — entity attribution scopes them). */
  ginReceipts: GinReceiptRow[]
  cottonBales: CottonBaleRow[]
  /** The crop year's plantings only. */
  plantings: FieldPlanting[]
  /** The crop year's assumptions only. */
  assumptions: CropAssumption[]
  doubleCropIds: Set<string>
  aggByKey: Map<string, FieldCropAgg>
  /** analyzeYields exclusions (planting id → reason) for harvestStatusOf. */
  excluded: Map<string, ExclusionReason>
  /** `${crop_id}|${crop_year}` keys with the crop-level harvest_complete flag. */
  cropCompleteKeys: Set<string>
  /** Lint lbs per field for the year (gin receipts). */
  cottonLbsByField: Map<string, number>
  // Crop-level rollups the marketing stage reuses:
  productionByCrop: Map<string, number>
  harvestCompleteCropIds: Set<string>
  cottonProductionByCrop: Map<string, { lintLbs: number; bales: number }>
}

type LoadRow = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  crop_year: number | null
  dry_bushels_override: number | null
  from_type: string | null
  from_field_id: string | null
  practice: 'irrigated' | 'dryland' | null
}
type SplitRow = { load_id: string; field_id: string; crop_id: string; dry_bushels: number | null; practice: 'irrigated' | 'dryland' | null }
type GinReceiptRow = {
  id: string
  field_id: string | null
  farm_id: string | null
  entity_id: string | null
  crop_year: number
  total_bale_weight: number | string | null
  bales_count: number | null
}
type CottonBaleRow = { gin_receipt_id: string; net_weight_lbs: number | null }
type CombineRow = {
  id: string; field_id: string; crop_id: string; crop_year: number
  stated_total_bushels: number; adjusted_total_bushels: number
  adjustment_bu_per_acre: number | null; destination_bin_id: string | null
  harvest_complete: boolean; entry_date: string
}

const num = (v: unknown) => Number(v) || 0

export async function loadProductionInputs(
  supabase: SupabaseClient,
  org: string,
  cropYear: number,
): Promise<ProductionInputs> {
  const [crops, fields, farms, entities, plantings, assumptions, loads, splits, ginReceipts, cottonBales] = await Promise.all([
    fetchAll<Crop>((f, t) =>
      supabase.from('crops').select('*').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; name_or_number: string; farm_id: string | null }>((f, t) =>
      supabase.from('fields').select('id, name_or_number, farm_id').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; entity_id: string | null }>((f, t) =>
      supabase.from('farms').select('id, entity_id').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; name: string; entity_role: string | null }>((f, t) =>
      supabase.from('entities').select('id, name, entity_role').eq('org_id', org).order('id').range(f, t)),
    fetchAll<FieldPlanting>((f, t) =>
      supabase.from('field_plantings').select('*').eq('org_id', org).eq('season_year', cropYear).order('id').range(f, t)),
    fetchAll<CropAssumption>((f, t) =>
      supabase.from('crop_assumptions').select('*').eq('org_id', org).eq('crop_year', cropYear).order('id').range(f, t)),
    fetchAll<LoadRow>((f, t) =>
      supabase
        .from('loads')
        .select('id, date, net_weight, moisture, crop_id, crop_year, dry_bushels_override, from_type, from_field_id, practice')
        .eq('org_id', org)
        .eq('crop_year', cropYear)
        .order('id')
        .range(f, t)),
    fetchAll<SplitRow>((f, t) =>
      supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels, practice').eq('org_id', org).order('id').range(f, t)),
    fetchAll<GinReceiptRow>((f, t) =>
      supabase
        .from('gin_receipts')
        .select('id, field_id, farm_id, entity_id, crop_year, total_bale_weight, bales_count')
        .eq('org_id', org)
        .eq('crop_year', cropYear)
        .order('id')
        .range(f, t)),
    fetchAll<CottonBaleRow>((f, t) =>
      supabase.from('cotton_bales').select('gin_receipt_id, net_weight_lbs').eq('org_id', org).eq('crop_year', cropYear).order('id').range(f, t)),
  ])
  // Combine entries (062) — a missing table degrades to none, like /production.
  let combineEntries: CombineRow[] = []
  const combineResult = await supabase
    .from('combine_yield_entries')
    .select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date')
    .eq('org_id', org)
    .eq('crop_year', cropYear)
  if (!combineResult.error) combineEntries = (combineResult.data ?? []) as CombineRow[]

  const cropById = new Map(crops.map((c) => [c.id, c]))
  const doubleCropIds = buildDoubleCropSet(plantings, cropById)
  const aggByKey = fieldCropAggregates(loads, splits, cropById, { cropYear, combineEntries })

  const productionByCrop = new Map<string, number>()
  for (const [key, agg] of aggByKey) {
    const cropId = key.split('|')[1]
    if (cropId) productionByCrop.set(cropId, (productionByCrop.get(cropId) ?? 0) + agg.dryBu)
  }

  const cropCompleteKeys = new Set<string>()
  for (const a of assumptions) if (a.harvest_complete) cropCompleteKeys.add(`${a.crop_id}|${a.crop_year}`)

  const assumptionByCrop = new Map(assumptions.map((a) => [a.crop_id, a]))
  const analysis = analyzeYields(
    plantings.map((p) => {
      const agg = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
      return {
        id: p.id,
        cropId: p.crop_id,
        acres: Number(p.planted_acres ?? 0),
        dryBu: agg?.dryBu ?? 0,
        lastLoadDate: agg?.lastLoadDate ?? null,
        override: p.yield_include_override ?? null,
        combineComplete: agg?.combine?.harvestComplete,
        expectedYield: expectedYieldForPlanting(assumptionByCrop.get(p.crop_id), p),
      }
    }),
  )
  const harvestCompleteCropIds = cropsWithCompleteHarvest({ plantings, aggByKey, cropYear, cropCompleteKeys, assumptions })

  // Cotton: lint lbs per field (receipt totals, the /production convention) and
  // the crop-level total with the per-bale-weights-first fallback the
  // dashboard uses.
  const cottonLbsByField = new Map<string, number>()
  for (const rct of ginReceipts) {
    if (rct.field_id) cottonLbsByField.set(rct.field_id, (cottonLbsByField.get(rct.field_id) ?? 0) + num(rct.total_bale_weight))
  }
  const cottonTotal = cottonTotals(ginReceipts, cottonBales)
  const cottonProductionByCrop = new Map<string, { lintLbs: number; bales: number }>()
  for (const c of crops) if (isCottonCrop(c.name)) cottonProductionByCrop.set(c.id, cottonTotal)

  return {
    crops, fields, farms, entities, ginReceipts, cottonBales, plantings, assumptions, doubleCropIds, aggByKey,
    excluded: analysis.excluded, cropCompleteKeys, cottonLbsByField,
    productionByCrop, harvestCompleteCropIds, cottonProductionByCrop,
  }
}

/** Cotton lint lbs + bale count from a set of gin receipts — per-bale net
 *  weights first, the receipt total as the fallback (the dashboard rule). */
function cottonTotals(
  receipts: readonly GinReceiptRow[],
  bales: readonly CottonBaleRow[],
): { lintLbs: number; bales: number } {
  const balesByReceipt = new Map<string, { lbs: number; count: number }>()
  for (const b of bales) {
    const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    g.lbs += num(b.net_weight_lbs)
    g.count += 1
    balesByReceipt.set(b.gin_receipt_id, g)
  }
  let lintLbs = 0
  let baleCount = 0
  for (const rct of receipts) {
    const fromBales = balesByReceipt.get(rct.id)
    lintLbs += fromBales && fromBales.lbs > 0 ? fromBales.lbs : num(rct.total_bale_weight)
    baleCount += fromBales && fromBales.count > 0 ? fromBales.count : num(rct.bales_count)
  }
  return { lintLbs, bales: baleCount }
}

// ---------------------------------------------------------------------------
// Current-futures quotes — the market_prices day-cache first, Barchart for
// anything missing today (upserted back into the cache), most recent cached
// row as the last resort. Mirrors /api/market-prices so this path and the
// dashboard land on the same numbers; market_prices is a GLOBAL table (053),
// deliberately unscoped.
// ---------------------------------------------------------------------------

const BARCHART_URL = 'https://ondemand.websol.barchart.com/getQuote.json'

function todayISO(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

async function fetchQuotes(supabase: SupabaseClient, symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (symbols.length === 0) return out
  const today = todayISO()

  const { data: todaysRows } = await supabase
    .from('market_prices')
    .select('contract_symbol, price')
    .in('contract_symbol', symbols)
    .eq('price_date', today)
  for (const r of todaysRows ?? []) out.set(r.contract_symbol as string, Number(r.price))

  const needFetch = symbols.filter((s) => !out.has(s))
  const apiKey = process.env.BARCHART_API_KEY
  if (needFetch.length > 0 && apiKey) {
    try {
      const url = `${BARCHART_URL}?apikey=${encodeURIComponent(apiKey)}&symbols=${encodeURIComponent(needFetch.join(','))}`
      const resp = await fetch(url, { cache: 'no-store' })
      const json: unknown = await resp.json().catch(() => null)
      const results = Array.isArray((json as { results?: unknown[] } | null)?.results)
        ? ((json as { results: unknown[] }).results as Array<Record<string, unknown>>)
        : []
      const upserts: Array<{ contract_symbol: string; price: number; price_date: string }> = []
      for (const r of results) {
        const sym = typeof r?.symbol === 'string' ? r.symbol.toUpperCase() : null
        const raw = r?.lastPrice ?? r?.close ?? r?.settlement
        const cents = typeof raw === 'number' ? raw : Number(raw)
        if (!sym || !Number.isFinite(cents)) continue
        const price = normalizeBarchartPrice(sym, cents)
        out.set(sym, price)
        upserts.push({ contract_symbol: sym, price, price_date: today })
      }
      if (upserts.length > 0) {
        await supabase.from('market_prices').upsert(upserts, { onConflict: 'contract_symbol,price_date' })
      }
    } catch {
      /* fall through to the most recent cached rows */
    }
  }

  const stillMissing = symbols.filter((s) => !out.has(s))
  if (stillMissing.length > 0) {
    const { data: recent } = await supabase
      .from('market_prices')
      .select('contract_symbol, price, price_date')
      .in('contract_symbol', stillMissing)
      .order('price_date', { ascending: false })
    for (const r of recent ?? []) {
      const sym = r.contract_symbol as string
      if (!out.has(sym)) out.set(sym, Number(r.price))
    }
  }
  return out
}

/** currentFuturesByCrop exactly as the dashboard resolves it: the reference
 *  contract per crop (user's pinned month honored, benchmark rolled past
 *  expiry), fallen forward once more when its quote is missing while others
 *  quoted, then the quote. Crops with no traded future are simply absent. */
async function resolveCurrentFutures(
  supabase: SupabaseClient,
  crops: readonly Crop[],
  plantedCropIds: ReadonlySet<string>,
  assumptions: readonly CropAssumption[],
  cropYear: number,
): Promise<Map<string, number>> {
  const asOf = new Date()
  const monthOptsByCrop = new Map<string, ReturnType<typeof referenceMonthOptions>>()
  for (const c of crops) {
    if (!plantedCropIds.has(c.id)) continue
    const opts = referenceMonthOptions(c.name, cropYear, asOf)
    if (opts.length > 0) monthOptsByCrop.set(c.id, opts)
  }
  const symbols = Array.from(new Set([...monthOptsByCrop.values()].flat().map((o) => o.symbol)))
  const quotes = await fetchQuotes(supabase, symbols)

  const out = new Map<string, number>()
  for (const c of crops) {
    if (!plantedCropIds.has(c.id)) continue
    const overrideMonth = assumptions.find((a) => a.crop_id === c.id && a.crop_year === cropYear)?.reference_contract_month ?? null
    let ref = marketingReferenceContract(c.name, cropYear, asOf, overrideMonth)
    if (!ref) continue
    ref = fallForwardOnMissingQuote(ref, monthOptsByCrop.get(c.id) ?? [], (s) => quotes.has(s), quotes.size > 0)
    const price = quotes.get(ref.symbol)
    if (price != null) out.set(c.id, price)
  }
  return out
}

// ---------------------------------------------------------------------------
// The full marketing bundle (what /marketing-prices needs)
// ---------------------------------------------------------------------------

export type MarketingInputs = {
  production: ProductionInputs
  /** Whole-operation rows (the dashboard with "All entities"). */
  rows: MarketingRow[]
  /** The raw marketing position + the operation-wide quote/assumption inputs,
   *  kept so computeEntityMarketingRows (lib/entity-marketing.ts) can
   *  re-attribute them per farming entity exactly as the dashboard's entity
   *  filter does. */
  entityInputs: EntityMarketingInputs
}

export async function loadMarketingInputs(
  supabase: SupabaseClient,
  org: string,
  cropYear: number,
): Promise<MarketingInputs> {
  const production = await loadProductionInputs(supabase, org, cropYear)
  const { crops, plantings, assumptions } = production

  const [contracts, futures, options] = await Promise.all([
    fetchAll<Contract>((f, t) =>
      supabase.from('contracts').select('*').eq('org_id', org).eq('crop_year', cropYear).order('id').range(f, t)),
    fetchAll<FuturesPosition>((f, t) =>
      supabase.from('futures_positions').select('*').eq('org_id', org).eq('crop_year', cropYear).order('id').range(f, t)),
    fetchAll<OptionPosition>((f, t) =>
      supabase.from('options_positions').select('*').eq('org_id', org).eq('crop_year', cropYear).order('id').range(f, t)),
  ])

  // Physical cotton marketing (044) — whole-operation summary; missing tables
  // degrade to none, like every other consumer.
  let cottonPhysicalByCrop = new Map<string, import('@/lib/cotton-sales').CottonPhysicalSummary>()
  let cottonPhysicalInputs: CottonPhysicalInputs | null = null
  try {
    const raw = await fetchCottonPhysical(supabase, cropYear, { orgId: org })
    for (const c of crops) if (isCottonCrop(c.name)) cottonPhysicalByCrop.set(c.id, raw.summary)
    cottonPhysicalInputs = raw.hasData ? raw.inputs : null
  } catch {
    cottonPhysicalByCrop = new Map()
  }

  const segByCrop = segmentAcresByCrop(plantings, cropYear, production.doubleCropIds)
  const expectedProductionByCrop = expectedProductionFromBreakout(segByCrop, assumptions, cropYear)
  const plantedCropIds = new Set(plantings.map((p) => p.crop_id))
  const currentFuturesByCrop = await resolveCurrentFutures(supabase, crops, plantedCropIds, assumptions, cropYear)

  // Seed production contracts (077) — whole-operation commitments; missing
  // tables degrade to none, like the cotton fetch above.
  let seedBundles: SeedContractBundle[] = []
  let buyerNameById = new Map<string, string>()
  let seedCommitmentsByCrop: Map<string, SeedCropCommitment[]> | undefined
  try {
    const seed = await fetchSeedContracts(supabase, cropYear, { orgId: org, contracts })
    if (seed.bundles.length > 0) {
      seedBundles = seed.bundles
      const buyersQ = await supabase.from('buyers').select('id, name').eq('org_id', org)
      buyerNameById = new Map((((buyersQ.data ?? []) as Array<{ id: string; name: string }>)).map((b) => [b.id, b.name]))
      seedCommitmentsByCrop = buildSeedCommitments({
        bundles: seedBundles,
        cropYear,
        plantings,
        aggByKey: production.aggByKey,
        assumptions,
        harvestCompleteCropIds: production.harvestCompleteCropIds,
        buyerNameById,
      })
    }
  } catch { /* 077 not applied yet — no seed book */ }

  const rows = computeMarketing({
    cropYear,
    crops,
    plantings: plantings.map((p) => ({ crop_id: p.crop_id, season_year: p.season_year, planted_acres: p.planted_acres })),
    contracts,
    futures,
    options,
    assumptions,
    actualProductionByCrop: production.productionByCrop,
    expectedProductionByCrop,
    currentFuturesByCrop,
    harvestCompleteCropIds: production.harvestCompleteCropIds,
    cottonProductionByCrop: production.cottonProductionByCrop,
    cottonPhysicalByCrop,
    seedCommitmentsByCrop,
  })
  return {
    production,
    rows,
    entityInputs: {
      cropYear,
      crops,
      plantings,
      fields: production.fields,
      farms: production.farms,
      entities: production.entities,
      contracts,
      futures,
      options,
      assumptions,
      doubleCropIds: production.doubleCropIds,
      aggByKey: production.aggByKey,
      ginReceipts: production.ginReceipts,
      cottonBales: production.cottonBales,
      cottonPhysicalInputs,
      currentFuturesByCrop,
      seedBundles,
      buyerNameById,
    },
  }
}
