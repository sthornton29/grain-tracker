// Cotton yield sources (092) — the ONE read of the seed cotton loads, gin
// receipts, bales, grades and receipt↔load links that cotton harvest status
// and the lint estimate need, plus the pure model every consumer composes
// from them (Yields, Season Summary, Marketing, Revenue Projections, Income
// Sensitivity, the insurance production report, the partner API, the farm
// link, Ask Turnrow).
//
// THE MODULE FLAG IS THE GATE. fetchCottonYieldSources reads
// app_settings.cotton_module_enabled first and returns null when it is off —
// no cotton table is touched, no adapter is built, and every consumer then
// produces exactly what it produced before this feature (lib/cotton-yields
// tests pin that invariance). Session clients rely on RLS (the org's one
// app_settings row); service-role callers pass their org explicitly.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import {
  cottonPlantingYield, cottonProductionTotals, cottonYieldAdapter, turnoutResolver,
  type CottonPlantingYield, type CottonProduction, type SeedCottonLoadLike, type TurnoutReceiptLike, type TurnoutResolution,
} from '@/lib/cotton'
import { isCottonCrop } from '@/lib/marketing'
import type { CottonYieldAdapter } from '@/lib/yields'

export type CottonSourceLoad = SeedCottonLoadLike & {
  load_number: string
  entity_id: string | null
  farm_id: string | null
  truck: string | null
  gin_id: string | null
  rolls?: number | null
  updated_at?: string | null
}

export type CottonSourceReceipt = TurnoutReceiptLike & {
  entity_id: string | null
  farm_id: string | null
  receipt_number: string
  receipt_date: string | null
  gin_id: string | null
  updated_at?: string | null
}

export type CottonYieldSources = {
  loads: CottonSourceLoad[]
  receipts: CottonSourceReceipt[]
  bales: Array<{ id: string; gin_receipt_id: string; net_weight_lbs: number; crop_year: number }>
  baleGrades: Array<{ bale_id: string; loan_value_cents_per_lb: number | null }>
  /** Gin names for the drill-down (id → name). */
  gins: Array<{ id: string; name: string }>
  /** cotton_load_id → receipt id (gin_receipt_loads). */
  receiptByLoadId: Map<string, string>
  ginnedLoadIds: Set<string>
}

const LOAD_SELECT = 'id, load_number, entity_id, farm_id, field_id, crop_year, picked_date, delivered_date, truck, gin_id, net_weight, rolls'
const RECEIPT_SELECT = 'id, gin_id, receipt_number, receipt_date, entity_id, farm_id, field_id, crop_year, bales_count, total_bale_weight, total_seed_cotton_weight'

/**
 * Reads the module flag, then (only when on) every cotton source — all crop
 * years, since the Yields page offers "All crop years" and the turnout's
 * prior-year tier needs last season's receipts. Paginated throughout (the
 * per-load / per-bale tables cross the ~1,000-row cap in a season). Returns
 * null with the module off; throws on a read error (callers degrade to
 * null — the page then behaves as if the module were off).
 */
export async function fetchCottonYieldSources(
  supabase: SupabaseClient,
  opts?: { orgId?: string; updatedAt?: boolean },
): Promise<CottonYieldSources | null> {
  const orgId = opts?.orgId
  let flagQ = supabase.from('app_settings').select('cotton_module_enabled')
  if (orgId) flagQ = flagQ.eq('org_id', orgId)
  const flag = await flagQ.limit(1).maybeSingle()
  if (!(flag.data as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (table: string, select: string): Promise<{ data: any; error: { message: string } | null }> =>
    fetchAllRows((f, t) => {
      let q = supabase.from(table).select(select)
      if (orgId) q = q.eq('org_id', orgId)
      return q.order('id').range(f, t)
    })
  const extra = opts?.updatedAt ? ', updated_at' : ''
  const [l, r, b, g, j, gn] = await Promise.all([
    from('cotton_loads', LOAD_SELECT + extra),
    from('gin_receipts', RECEIPT_SELECT + extra),
    from('cotton_bales', 'id, gin_receipt_id, net_weight_lbs, crop_year'),
    from('cotton_bale_grades', 'bale_id, loan_value_cents_per_lb'),
    from('gin_receipt_loads', 'receipt_id, cotton_load_id'),
    from('gins', 'id, name'),
  ])
  const err = l.error ?? r.error ?? b.error ?? g.error ?? j.error ?? gn.error
  if (err) throw new Error(err.message)
  const links = (j.data as Array<{ receipt_id: string; cotton_load_id: string }>) || []
  const receiptByLoadId = new Map(links.map((x) => [x.cotton_load_id, x.receipt_id]))
  return {
    loads: (l.data as CottonSourceLoad[]) || [],
    receipts: (r.data as CottonSourceReceipt[]) || [],
    bales: (b.data as CottonYieldSources['bales']) || [],
    baleGrades: (g.data as CottonYieldSources['baleGrades']) || [],
    gins: (gn.data as Array<{ id: string; name: string }>) || [],
    receiptByLoadId,
    ginnedLoadIds: new Set(receiptByLoadId.keys()),
  }
}

// ---------------------------------------------------------------------------
// The pure model: sources + crops + assumptions → the classifier adapter, the
// turnout resolver, per-planting lint figures and crop-level production.
// ---------------------------------------------------------------------------

export type CottonPlantingRef = { field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null }

export type CottonYieldModel = {
  /** False when the module is off (sources null) — every method is then inert. */
  on: boolean
  cottonCropIds: Set<string>
  /** Pass to buildYieldInputs / cropsWithCompleteHarvest / … ; null when off. */
  adapter: CottonYieldAdapter | null
  turnoutFor: (cropId: string, cropYear: number) => TurnoutResolution
  loadsFor: (fieldId: string, cropYear: number) => CottonSourceLoad[]
  receiptsFor: (fieldId: string, cropYear: number) => CottonSourceReceipt[]
  /** The planting's seed cotton, actual + estimated lint, turnout, ginning status; null when off. */
  yieldFor: (p: CottonPlantingRef) => CottonPlantingYield | null
  /**
   * Crop-level production for a crop year over a SCOPE of receipts and loads
   * (the caller's entity scope — lib/entity-scope ginReceipts() applies to
   * cotton loads too, they carry the same entity/farm/field keys). With the
   * module off this is the receipts-only total every consumer used before.
   */
  productionFor: (args: {
    cropId: string
    cropYear: number
    receipts: ReadonlyArray<{ id: string; total_bale_weight: number | string | null; bales_count: number | null }>
    bales: ReadonlyArray<{ gin_receipt_id: string; net_weight_lbs: number | string | null }>
    loads?: readonly SeedCottonLoadLike[] | null
  }) => CottonProduction
  sources: CottonYieldSources | null
}

export function buildCottonYieldModel(args: {
  sources: CottonYieldSources | null
  crops: ReadonlyArray<{ id: string; name: string }>
  assumptions: ReadonlyArray<{ crop_id: string; crop_year: number; assumed_turnout_pct?: number | string | null }>
}): CottonYieldModel {
  const cottonCropIds = new Set(args.crops.filter((c) => isCottonCrop(c.name)).map((c) => c.id))
  const src = args.sources
  const turnoutFor = turnoutResolver({ assumptions: args.assumptions, receipts: src?.receipts ?? [], bales: src?.bales ?? [] })
  if (!src) {
    return {
      on: false, cottonCropIds, adapter: null, turnoutFor,
      loadsFor: () => [], receiptsFor: () => [], yieldFor: () => null,
      productionFor: (a) => cottonProductionTotals({ receipts: a.receipts, bales: a.bales }),
      sources: null,
    }
  }
  const loadsByKey = new Map<string, CottonSourceLoad[]>()
  for (const l of src.loads) {
    if (!l.field_id) continue
    const k = `${l.field_id}|${l.crop_year}`
    const arr = loadsByKey.get(k)
    if (arr) arr.push(l)
    else loadsByKey.set(k, [l])
  }
  const receiptsByKey = new Map<string, CottonSourceReceipt[]>()
  for (const r of src.receipts) {
    if (!r.field_id) continue
    const k = `${r.field_id}|${r.crop_year}`
    const arr = receiptsByKey.get(k)
    if (arr) arr.push(r)
    else receiptsByKey.set(k, [r])
  }
  const adapter = cottonYieldAdapter({ cottonCropIds, loads: src.loads, turnoutFor })
  const loadsFor = (fieldId: string, cropYear: number) => loadsByKey.get(`${fieldId}|${cropYear}`) ?? []
  const receiptsFor = (fieldId: string, cropYear: number) => receiptsByKey.get(`${fieldId}|${cropYear}`) ?? []
  return {
    on: true, cottonCropIds, adapter, turnoutFor, loadsFor, receiptsFor,
    yieldFor: (p) => {
      if (!cottonCropIds.has(p.crop_id)) return null
      return cottonPlantingYield({
        plantedAcres: Number(p.planted_acres ?? 0),
        loads: loadsFor(p.field_id, p.season_year),
        receipts: receiptsFor(p.field_id, p.season_year),
        bales: src.bales,
        ginnedLoadIds: src.ginnedLoadIds,
        turnout: turnoutFor(p.crop_id, p.season_year),
      })
    },
    productionFor: (a) => cottonProductionTotals({
      receipts: a.receipts,
      bales: a.bales,
      loads: (a.loads ?? src.loads).filter((l) => l.crop_year === a.cropYear),
      ginnedLoadIds: src.ginnedLoadIds,
      turnout: turnoutFor(a.cropId, a.cropYear),
    }),
    sources: src,
  }
}
