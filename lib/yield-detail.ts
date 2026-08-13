// Yields drill-down detail — the itemized layer under every yield row.
//
// Built from the SAME loads/splits/shrink math fieldCropAggregates uses (one
// iteration rule, shared constants), so a drill-down's total dry bushels
// exactly equals the yield row it explains — never a parallel query that
// could disagree. Weighted averages weight by NET WEIGHT (lbs), never a
// simple mean of percentages.
//
// Combine entries (062): a combine-tracked field's detail lists the entry as a
// labeled source row ABOVE the weighed-load list, with the netting shown; the
// summary's fieldProductionDryBu then uses the entry's adjusted total for that
// field (mirroring fieldCropAggregates), so the detail still provably sums to
// the yield row.

import { computeBushels } from '@/lib/shrink'
import type { CombineAggInfo, CombineEntryLike } from '@/lib/yields'

export type DetailLoadLike = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  test_weight: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
  to_type: string | null
  to_bin_id: string | null
  to_buyer_id: string | null
  truck_id: string | null
  ticket_number: string | null
}

export type DetailSplitLike = {
  load_id: string
  field_id: string
  crop_id: string
  dry_bushels: number | null
}

type CropLike = {
  id: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
}

export type YieldDetailLoad = {
  loadId: string
  fieldId: string
  cropId: string
  date: string
  ticket: string | null
  truckId: string | null
  /** Net lbs attributed to this field (split loads: the pro-rated portion). */
  netLbs: number | null
  moisture: number | null
  testWeight: number | null
  wetBu: number | null
  dryBu: number
  destination: 'bin' | 'buyer' | null
  destinationId: string | null
  /** Non-null for split loads: this field's slice of the whole load. */
  split: { portionLbs: number | null; parentLbs: number | null } | null
}

/** A combine entry rendered in the drill-down, with its netting computed
 *  against exactly the weighed loads listed alongside it. */
export type CombineDetailRow = {
  fieldId: string
  cropId: string
  info: CombineAggInfo
}

export type YieldDetailSummary = {
  loadCount: number
  totalNetLbs: number
  totalWetBu: number
  /** Σ dry bushels of the WEIGHED loads listed (netting basis, not the row). */
  totalDryBu: number
  /** The field-production number the yield row shows: weighed loads for
   *  load-tracked fields + adjusted combine totals for combine-tracked ones.
   *  Equals totalDryBu when no combine entry is present. */
  fieldProductionDryBu: number
  /** Weighted by net lbs — 30,000 @ 16.0 + 50,000 @ 18.0 → 17.25, not 17.0. */
  weightedMoisture: number | null
  /** Weighted by net lbs across loads that captured a test weight. */
  weightedTestWeight: number | null
  firstLoadDate: string | null
  lastLoadDate: string | null
  /** Destination mix by dry bushels. Pcts are shares of totalDryBu. */
  toBinsDryBu: number
  toBuyersDryBu: number
  toBinsPct: number | null
  toBuyersPct: number | null
}

/** Net-weight-weighted average; rows without a value (or weight) drop out of
 *  BOTH numerator and denominator. Null when nothing weighs in. */
export function weightedAverage(
  pairs: ReadonlyArray<{ value: number | null | undefined; weight: number | null | undefined }>,
): number | null {
  let num = 0
  let den = 0
  for (const p of pairs) {
    if (p.value == null || p.weight == null || !(p.weight > 0)) continue
    num += p.value * p.weight
    den += p.weight
  }
  return den > 0 ? num / den : null
}

/**
 * Every load contributing to the yield rows identified by `keys`
 * (`${fieldId}|${cropId}` pairs) in `seasonYear`. The season year matches the
 * LOAD DATE's year — identical to fieldCropAggregates' key year — so the
 * detail provably sums to the row. Sorted by date ascending.
 */
export function buildLoadDetail(args: {
  keys: ReadonlySet<string> // `${fieldId}|${cropId}`
  seasonYear: number
  loads: readonly DetailLoadLike[]
  splits: readonly DetailSplitLike[]
  cropById: Map<string, CropLike>
  /** Combine entries (062); entries for `keys` in `seasonYear` become labeled
   *  source rows and switch the matched loads to crop-year matching, exactly
   *  like fieldCropAggregates. */
  combineEntries?: readonly CombineEntryLike[] | null
}): { loads: YieldDetailLoad[]; summary: YieldDetailSummary; combineRows: CombineDetailRow[] } {
  const { keys, seasonYear, loads, splits, cropById } = args
  const out: YieldDetailLoad[] = []

  // Combine-tracked keys for this season: their loads match on the load's
  // EFFECTIVE crop year (crop_year ?? date year) — a January haul still nets
  // against its season's entry (mirrors fieldCropAggregates' keying).
  const entryFor = new Map<string, CombineEntryLike>()
  for (const e of args.combineEntries ?? []) {
    if (e.crop_year !== seasonYear) continue
    const k = `${e.field_id}|${e.crop_id}`
    if (keys.has(k)) entryFor.set(k, e)
  }
  const inSeason = (key: string, dateYr: number, cropYear: number | null) =>
    entryFor.has(key) ? (cropYear ?? dateYr) === seasonYear : dateYr === seasonYear

  const dest = (l: DetailLoadLike): { destination: 'bin' | 'buyer' | null; destinationId: string | null } => {
    if (l.to_type === 'bin') return { destination: 'bin', destinationId: l.to_bin_id }
    if (l.to_type === 'buyer') return { destination: 'buyer', destinationId: l.to_buyer_id }
    return { destination: null, destinationId: null }
  }

  // Direct single-field loads — the same rule as fieldCropAggregates.
  for (const l of loads) {
    if (l.from_type !== 'field' || !l.from_field_id || !l.crop_id) continue
    const key = `${l.from_field_id}|${l.crop_id}`
    if (!keys.has(key)) continue
    if (!inSeason(key, Number(l.date.slice(0, 4)), l.crop_year)) continue
    const crop = cropById.get(l.crop_id)
    const { dryBushels, wetBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (!dryBushels) continue
    out.push({
      loadId: l.id, fieldId: l.from_field_id, cropId: l.crop_id,
      date: l.date, ticket: l.ticket_number, truckId: l.truck_id,
      netLbs: l.net_weight != null ? Number(l.net_weight) : null,
      moisture: l.moisture != null ? Number(l.moisture) : null,
      testWeight: l.test_weight != null ? Number(l.test_weight) : null,
      wetBu: wetBushels, dryBu: dryBushels,
      ...dest(l),
      split: null,
    })
  }

  // Split loads — the field's slice, pro-rated by its share of the parent's
  // dry bushels (net lbs scale by the same ratio; moisture/test weight are
  // the parent's — one load, one probe).
  const loadById = new Map(loads.map((l) => [l.id, l]))
  for (const s of splits) {
    const key = `${s.field_id}|${s.crop_id}`
    if (!keys.has(key)) continue
    const parent = loadById.get(s.load_id)
    if (!parent || s.dry_bushels == null) continue
    if (!inSeason(key, Number(parent.date.slice(0, 4)), parent.crop_year)) continue
    const portionDry = Number(s.dry_bushels)
    if (!portionDry) continue
    const crop = cropById.get(s.crop_id)
    const { dryBushels: parentDry, wetBushels: parentWet } = computeBushels({
      netWeightLb: parent.net_weight,
      moisturePct: parent.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: parent.dry_bushels_override,
    })
    const ratio = parentDry != null && parentDry > 0 ? portionDry / parentDry : null
    const parentLbs = parent.net_weight != null ? Number(parent.net_weight) : null
    const portionLbs = ratio != null && parentLbs != null ? Math.round(parentLbs * ratio) : null
    out.push({
      loadId: parent.id, fieldId: s.field_id, cropId: s.crop_id,
      date: parent.date, ticket: parent.ticket_number, truckId: parent.truck_id,
      netLbs: portionLbs,
      moisture: parent.moisture != null ? Number(parent.moisture) : null,
      testWeight: parent.test_weight != null ? Number(parent.test_weight) : null,
      wetBu: ratio != null && parentWet != null ? parentWet * ratio : null,
      dryBu: portionDry,
      ...dest(parent),
      split: { portionLbs, parentLbs },
    })
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.loadId.localeCompare(b.loadId)))

  // Combine rows: netting computed against exactly the loads listed above.
  const combineRows: CombineDetailRow[] = []
  for (const [k, e] of entryFor) {
    const [fieldId, cropId] = k.split('|')
    const weighedBu = out.reduce((s, l) => (l.fieldId === fieldId && l.cropId === cropId ? s + l.dryBu : s), 0)
    const adjustedBu = Number(e.adjusted_total_bushels) || 0
    combineRows.push({
      fieldId, cropId,
      info: {
        entryId: e.id,
        statedBu: Number(e.stated_total_bushels) || 0,
        adjustedBu,
        adjustmentBuPerAcre: e.adjustment_bu_per_acre != null ? Number(e.adjustment_bu_per_acre) : null,
        weighedBu,
        remainderBu: adjustedBu - weighedBu,
        destinationBinId: e.destination_bin_id,
        harvestComplete: e.harvest_complete,
        entryDate: e.entry_date,
      },
    })
  }
  combineRows.sort((a, b) => a.fieldId.localeCompare(b.fieldId) || a.cropId.localeCompare(b.cropId))

  return { loads: out, summary: summarizeDetail(out, combineRows), combineRows }
}

export function summarizeDetail(
  loads: readonly YieldDetailLoad[],
  combineRows: readonly CombineDetailRow[] = [],
): YieldDetailSummary {
  let totalNetLbs = 0
  let totalWetBu = 0
  let totalDryBu = 0
  let toBinsDryBu = 0
  let toBuyersDryBu = 0
  let first: string | null = null
  let last: string | null = null
  for (const l of loads) {
    totalNetLbs += l.netLbs ?? 0
    totalWetBu += l.wetBu ?? 0
    totalDryBu += l.dryBu
    if (l.destination === 'bin') toBinsDryBu += l.dryBu
    else if (l.destination === 'buyer') toBuyersDryBu += l.dryBu
    if (first == null || l.date < first) first = l.date
    if (last == null || l.date > last) last = l.date
  }
  // Field production = weighed loads, except combine-tracked fields where the
  // entry's adjusted total replaces that field's weighed sum (the weighed
  // bushels are the netting basis, already inside each row's weighedBu).
  let fieldProductionDryBu = totalDryBu
  for (const r of combineRows) fieldProductionDryBu += r.info.adjustedBu - r.info.weighedBu

  return {
    loadCount: loads.length,
    totalNetLbs, totalWetBu, totalDryBu,
    fieldProductionDryBu,
    weightedMoisture: weightedAverage(loads.map((l) => ({ value: l.moisture, weight: l.netLbs }))),
    weightedTestWeight: weightedAverage(loads.map((l) => ({ value: l.testWeight, weight: l.netLbs }))),
    firstLoadDate: first, lastLoadDate: last,
    toBinsDryBu, toBuyersDryBu,
    toBinsPct: totalDryBu > 0 ? (toBinsDryBu / totalDryBu) * 100 : null,
    toBuyersPct: totalDryBu > 0 ? (toBuyersDryBu / totalDryBu) * 100 : null,
  }
}

// ---------------------------------------------------------------------------
// Cotton drill-down — a cotton planting's detail speaks in gin receipts and
// bales (lbs of lint), not grain loads: lint from the field's receipts (the
// SAME per-bale-weights-else-receipt-total rule the Marketing page uses),
// turnout, a bale summary with the weighted average loan value where classing
// exists, and seed-cotton loads still on the yard (delivered, not yet on any
// receipt).
// ---------------------------------------------------------------------------

export type CottonFieldDetail = {
  receiptCount: number
  lintLbs: number
  baleCount: number
  avgBaleLbs: number | null
  /** Lint ÷ seed cotton across receipts that carry both. */
  turnoutPct: number | null
  /** Lint-lbs-weighted average loan value (¢/lb) across CLASSED bales. */
  weightedLoanCentsPerLb: number | null
  classedBaleCount: number
  /** Seed-cotton lbs delivered but not on any gin receipt yet. */
  yardSeedCottonLbs: number
  yardLoadCount: number
}

export function buildCottonFieldDetail(args: {
  fieldIds: ReadonlySet<string>
  cropYear: number
  ginReceipts: ReadonlyArray<{
    id: string; field_id: string | null; crop_year: number
    bales_count: number | null; total_bale_weight: number | null
    total_seed_cotton_weight: number | null
  }>
  bales: ReadonlyArray<{ id: string; gin_receipt_id: string; net_weight_lbs: number }>
  baleGrades: ReadonlyArray<{ bale_id: string; loan_value_cents_per_lb: number | null }>
  /** cotton_loads with delivery info; `onReceipt` = appears in gin_receipt_loads. */
  yardLoads: ReadonlyArray<{ field_id: string | null; crop_year: number; net_weight: number | null; onReceipt: boolean }>
}): CottonFieldDetail {
  const { fieldIds, cropYear, ginReceipts, bales, baleGrades, yardLoads } = args
  const mine = ginReceipts.filter((r) => r.crop_year === cropYear && r.field_id != null && fieldIds.has(r.field_id))
  const mineIds = new Set(mine.map((r) => r.id))

  const myBales = bales.filter((b) => mineIds.has(b.gin_receipt_id))
  const balesByReceipt = new Map<string, { lbs: number; count: number }>()
  for (const b of myBales) {
    const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    g.lbs += Number(b.net_weight_lbs) || 0
    g.count += 1
    balesByReceipt.set(b.gin_receipt_id, g)
  }

  // Lint per receipt: per-bale net weights when the bales are on file, else
  // the receipt total — the SAME rule the Marketing page's production uses.
  let lintLbs = 0
  let baleCount = 0
  let seedWithLint = 0
  let lintWithSeed = 0
  for (const r of mine) {
    const fromBales = balesByReceipt.get(r.id)
    const lbs = fromBales && fromBales.lbs > 0 ? fromBales.lbs : Number(r.total_bale_weight) || 0
    const count = fromBales && fromBales.count > 0 ? fromBales.count : Number(r.bales_count) || 0
    lintLbs += lbs
    baleCount += count
    const seed = Number(r.total_seed_cotton_weight) || 0
    if (seed > 0 && lbs > 0) { seedWithLint += seed; lintWithSeed += lbs }
  }

  // Loan values weight by each CLASSED bale's own lint lbs.
  const gradeByBale = new Map<string, number>()
  for (const g of baleGrades) if (g.loan_value_cents_per_lb != null) gradeByBale.set(g.bale_id, Number(g.loan_value_cents_per_lb))
  let loanNum = 0
  let loanDen = 0
  let classed = 0
  for (const b of myBales) {
    const cents = gradeByBale.get(b.id)
    if (cents == null) continue
    const w = Number(b.net_weight_lbs) || 0
    if (w <= 0) continue
    loanNum += cents * w
    loanDen += w
    classed += 1
  }

  let yardSeedCottonLbs = 0
  let yardLoadCount = 0
  for (const l of yardLoads) {
    if (l.onReceipt || l.crop_year !== cropYear) continue
    if (l.field_id == null || !fieldIds.has(l.field_id)) continue
    yardSeedCottonLbs += Number(l.net_weight) || 0
    yardLoadCount += 1
  }

  return {
    receiptCount: mine.length,
    lintLbs,
    baleCount,
    avgBaleLbs: baleCount > 0 ? lintLbs / baleCount : null,
    turnoutPct: seedWithLint > 0 ? (lintWithSeed / seedWithLint) * 100 : null,
    weightedLoanCentsPerLb: loanDen > 0 ? loanNum / loanDen : null,
    classedBaleCount: classed,
    yardSeedCottonLbs,
    yardLoadCount,
  }
}
