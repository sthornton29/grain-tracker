// Cotton module — pure math: lint turnout, lbs/acre yields, yard inventory
// (seed cotton delivered but not yet on a gin receipt), bale↔grade matching,
// and receipt bale-count reconciliation. No I/O; the /cotton pages and the
// reports pass already-fetched rows in. Cotton has NO moisture/shrink math —
// weights are plain lbs (seed cotton on loads, lint on bales).

import type { CottonYieldAdapter, FieldCropAgg } from '@/lib/yields'

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

/** Lint turnout: lint lbs ÷ seed cotton lbs, %. */
export function lintTurnoutPct(lintLbs: number, seedCottonLbs: number): number | null {
  if (!(seedCottonLbs > 0)) return null
  return round2((lintLbs / seedCottonLbs) * 100)
}

/** Loan value in ¢/lb from the classing sheet's Total Value $: 280.46 / 509 lb → 55.1¢. */
export function loanCentsPerLb(totalValueDollars: number, netWeightLbs: number): number | null {
  if (!(netWeightLbs > 0)) return null
  return round1((totalValueDollars / netWeightLbs) * 100)
}

/** Stated bales_count vs the bale rows actually captured. */
export function reconcileBaleCount(stated: number | null | undefined, actual: number): {
  ok: boolean
  message: string | null
} {
  if (stated == null) return { ok: true, message: null }
  if (stated === actual) return { ok: true, message: null }
  return {
    ok: false,
    message: `Receipt states ${stated} bale${stated === 1 ? '' : 's'} but ${actual} bale row${actual === 1 ? ' was' : 's were'} captured — review before saving.`,
  }
}

// ---------- Bale ↔ grade matching ----------

export type BaleLite = { id: string; pbi_number: string; net_weight_lbs: number }

const normPbi = (s: string) => s.trim().replace(/^0+(?=\d)/, '').toUpperCase()

export type GradeMatch<T> = {
  matched: Array<{ row: T; bale: BaleLite; weightMismatch: boolean }>
  unmatched: T[]
}

/**
 * Match grade rows to bales by PBI number (leading zeros ignored). NetWt is
 * cross-checked against the bale's receipt net weight — >1% difference flags
 * the pair (the classing office weighs independently). Farm/Field columns are
 * corroboration only, never the join key.
 */
export function matchGradesToBales<T extends { pbi_number: string; net_weight_lbs: number | null }>(
  rows: readonly T[],
  bales: readonly BaleLite[],
): GradeMatch<T> {
  const byPbi = new Map(bales.map((b) => [normPbi(b.pbi_number), b]))
  const matched: GradeMatch<T>['matched'] = []
  const unmatched: T[] = []
  for (const row of rows) {
    const bale = byPbi.get(normPbi(row.pbi_number))
    if (!bale) { unmatched.push(row); continue }
    const weightMismatch =
      row.net_weight_lbs != null && bale.net_weight_lbs > 0
        ? Math.abs(row.net_weight_lbs - bale.net_weight_lbs) / bale.net_weight_lbs > 0.01
        : false
    matched.push({ row, bale, weightMismatch })
  }
  return { matched, unmatched }
}

// ---------- Yard inventory + lbs/acre yields ----------

export type CottonLoadLite = { id: string; field_id: string | null; net_weight: number | null }
export type GinReceiptLite = {
  id: string
  field_id: string | null
  total_seed_cotton_weight: number | null
  total_bale_weight: number | null
  bales_count: number | null
}
export type CottonBaleLite = { gin_receipt_id: string; net_weight_lbs: number }

/** Seed cotton lbs delivered but not on any gin receipt, per field. */
export function yardInventoryByField(
  loads: readonly CottonLoadLite[],
  ginnedLoadIds: ReadonlySet<string>,
): Map<string | null, number> {
  const out = new Map<string | null, number>()
  for (const l of loads) {
    if (ginnedLoadIds.has(l.id)) continue
    const key = l.field_id ?? null
    out.set(key, (out.get(key) ?? 0) + Number(l.net_weight ?? 0))
  }
  return out
}

export type CottonFieldYield = {
  fieldId: string
  plantedAcres: number
  receipts: number
  bales: number
  lintLbs: number
  seedCottonLbs: number
  lintPerAcre: number | null // lbs lint / planted acre
  seedPerAcre: number | null
  turnoutPct: number | null
  /** Delivered but not yet ginned — the "on yard awaiting gin" figure. */
  yardSeedLbs: number
  /** complete = has receipts, nothing on the yard; in_progress = yard loads exist. */
  status: 'complete' | 'in_progress' | 'unharvested'
}

/**
 * Per-field cotton yields: lint lbs/acre = Σ bale net weights of the field's
 * receipts ÷ planted acres (falling back to a receipt's stated
 * total_bale_weight when its bale rows aren't captured), with seed cotton
 * lbs/ac and lint turnout % as companions. A field with receipts and an empty
 * yard is harvest-complete; loads on the yard mark it in-progress.
 */
export function cottonFieldYields(args: {
  fields: ReadonlyArray<{ fieldId: string; plantedAcres: number }>
  receipts: readonly GinReceiptLite[]
  bales: readonly CottonBaleLite[]
  loads: readonly CottonLoadLite[]
  ginnedLoadIds: ReadonlySet<string>
}): CottonFieldYield[] {
  const baleAgg = new Map<string, { lbs: number; count: number }>()
  for (const b of args.bales) {
    const a = baleAgg.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    a.lbs += Number(b.net_weight_lbs)
    a.count += 1
    baleAgg.set(b.gin_receipt_id, a)
  }
  const yard = yardInventoryByField(args.loads, args.ginnedLoadIds)
  return args.fields.map((f) => {
    const fieldReceipts = args.receipts.filter((r) => r.field_id === f.fieldId)
    let lintLbs = 0
    let seedCottonLbs = 0
    let bales = 0
    for (const r of fieldReceipts) {
      const agg = baleAgg.get(r.id)
      lintLbs += agg && agg.lbs > 0 ? agg.lbs : Number(r.total_bale_weight ?? 0)
      bales += agg && agg.count > 0 ? agg.count : Number(r.bales_count ?? 0)
      seedCottonLbs += Number(r.total_seed_cotton_weight ?? 0)
    }
    const yardSeedLbs = yard.get(f.fieldId) ?? 0
    const hasAnyLoads = args.loads.some((l) => l.field_id === f.fieldId)
    const status: CottonFieldYield['status'] =
      yardSeedLbs > 0 ? 'in_progress'
      : fieldReceipts.length > 0 ? 'complete'
      : hasAnyLoads ? 'complete' // all loads ginned even without a field-linked receipt shape
      : 'unharvested'
    return {
      fieldId: f.fieldId,
      plantedAcres: f.plantedAcres,
      receipts: fieldReceipts.length,
      bales,
      lintLbs: round1(lintLbs),
      seedCottonLbs: round1(seedCottonLbs),
      lintPerAcre: f.plantedAcres > 0 && lintLbs > 0 ? round1(lintLbs / f.plantedAcres) : null,
      seedPerAcre: f.plantedAcres > 0 && seedCottonLbs > 0 ? round1(seedCottonLbs / f.plantedAcres) : null,
      turnoutPct: lintTurnoutPct(lintLbs, seedCottonLbs),
      yardSeedLbs: round1(yardSeedLbs),
      status,
    }
  })
}

// ===========================================================================
// Harvest status from seed cotton loads + lint estimates for picked-but-
// unginned cotton (092).
//
// A cotton planting is classified by its SEED COTTON LOADS exactly as a grain
// planting is by its loads — through lib/yields.ts analyzeYields, never a
// parallel rule. The pieces below are the cotton INPUT ADAPTER for that
// engine (seed cotton lbs per field × crop year, dated by picked_date) plus
// the lint estimate layered on top once the field is picked: actual lint from
// gin receipts for the ginned loads + (seed cotton still on the yard × the
// resolved turnout) for the rest. Harvest status (from the loads) and ginning
// status (from gin_receipt_loads) are separate facts — a field can be picked
// out and still sitting on the yard.
// ===========================================================================

// ---------- Turnout resolution ----------

/** The documented fallback when nothing measured exists: 40% lint turnout. */
export const DEFAULT_TURNOUT_PCT = 40

export type TurnoutSource = 'manual' | 'ginned_this_year' | 'ginned_prior_year' | 'default'

export type TurnoutResolution = {
  /** Percent, e.g. 41.5. */
  pct: number
  /** The same figure as a fraction (0.415) — what the estimate multiplies by. */
  fraction: number
  source: TurnoutSource
  /** Farmer-facing phrase: "41.5% from your ginned cotton". */
  label: string
  /** True only for the default — nothing of yours backs the figure (amber). */
  assumed: boolean
}

export type GinnedTotals = { lintLbs: number; seedLbs: number }

/**
 * Σ lint ÷ Σ seed cotton over the receipts that carry BOTH weights — lint per
 * receipt is the bale rows when captured, else the receipt's stated total
 * (the same rule every lint figure in the app uses). Receipts without a seed
 * cotton weight can't speak to turnout and drop out of both sums.
 */
export function ginnedTotals(
  receipts: ReadonlyArray<{ id: string; total_seed_cotton_weight: number | string | null; total_bale_weight: number | string | null }>,
  bales: ReadonlyArray<{ gin_receipt_id: string; net_weight_lbs: number | string | null }>,
): GinnedTotals {
  const lintByReceipt = new Map<string, number>()
  for (const b of bales) lintByReceipt.set(b.gin_receipt_id, (lintByReceipt.get(b.gin_receipt_id) ?? 0) + (Number(b.net_weight_lbs) || 0))
  let lintLbs = 0
  let seedLbs = 0
  for (const r of receipts) {
    const fromBales = lintByReceipt.get(r.id) ?? 0
    const lint = fromBales > 0 ? fromBales : Number(r.total_bale_weight) || 0
    const seed = Number(r.total_seed_cotton_weight) || 0
    if (lint > 0 && seed > 0) { lintLbs += lint; seedLbs += seed }
  }
  return { lintLbs, seedLbs }
}

const pct1 = (n: number) => Math.round(n * 10) / 10

/**
 * The ONE turnout seam. Precedence: the manual turnout for the crop × crop
 * year (crop_assumptions.assumed_turnout_pct, 092) > this crop year's ginned
 * weighted average (Σ lint ÷ Σ seed across the org's receipts) > last crop
 * year's weighted average > the documented 40% default, flagged assumed.
 */
export function resolveTurnout(args: {
  manualPct?: number | string | null
  thisYear?: GinnedTotals | null
  priorYear?: GinnedTotals | null
  /** For the prior-year label ("from your 2025 ginned cotton"). */
  cropYear?: number | null
}): TurnoutResolution {
  const manual = args.manualPct == null || args.manualPct === '' ? null : Number(args.manualPct)
  if (manual != null && Number.isFinite(manual) && manual > 0 && manual <= 100) {
    return { pct: pct1(manual), fraction: manual / 100, source: 'manual', label: `${pct1(manual)}% set by you`, assumed: false }
  }
  const ty = args.thisYear
  if (ty && ty.seedLbs > 0 && ty.lintLbs > 0) {
    const f = ty.lintLbs / ty.seedLbs
    return { pct: pct1(f * 100), fraction: f, source: 'ginned_this_year', label: `${pct1(f * 100)}% from your ginned cotton`, assumed: false }
  }
  const py = args.priorYear
  if (py && py.seedLbs > 0 && py.lintLbs > 0) {
    const f = py.lintLbs / py.seedLbs
    const yr = args.cropYear != null ? `your ${args.cropYear - 1}` : 'last year’s'
    return { pct: pct1(f * 100), fraction: f, source: 'ginned_prior_year', label: `${pct1(f * 100)}% from ${yr} ginned cotton`, assumed: false }
  }
  return { pct: DEFAULT_TURNOUT_PCT, fraction: DEFAULT_TURNOUT_PCT / 100, source: 'default', label: `${DEFAULT_TURNOUT_PCT}% assumed`, assumed: true }
}

/** The receipt slice the turnout tiers and the lint estimate read. */
export type TurnoutReceiptLike = {
  id: string
  field_id: string | null
  crop_year: number
  bales_count: number | null
  total_bale_weight: number | string | null
  total_seed_cotton_weight: number | string | null
}

/**
 * crop id × crop year → TurnoutResolution, over the org's receipts (turnout
 * is a gin fact about the year's cotton, not about one crop row — receipts
 * carry no crop id — so only the MANUAL tier is per crop). Pure; memoized per
 * key so a page can call it per planting.
 */
export function turnoutResolver(args: {
  assumptions: ReadonlyArray<{ crop_id: string; crop_year: number; assumed_turnout_pct?: number | string | null }>
  receipts: readonly TurnoutReceiptLike[]
  bales: ReadonlyArray<{ gin_receipt_id: string; net_weight_lbs: number | string | null }>
}): (cropId: string, cropYear: number) => TurnoutResolution {
  const manual = new Map<string, number | string | null>()
  for (const a of args.assumptions) manual.set(`${a.crop_id}|${a.crop_year}`, a.assumed_turnout_pct ?? null)
  const totalsByYear = new Map<number, GinnedTotals>()
  const totalsFor = (year: number) => {
    let t = totalsByYear.get(year)
    if (!t) {
      t = ginnedTotals(args.receipts.filter((r) => r.crop_year === year), args.bales)
      totalsByYear.set(year, t)
    }
    return t
  }
  const cache = new Map<string, TurnoutResolution>()
  return (cropId, cropYear) => {
    const key = `${cropId}|${cropYear}`
    let r = cache.get(key)
    if (!r) {
      r = resolveTurnout({ manualPct: manual.get(key) ?? null, thisYear: totalsFor(cropYear), priorYear: totalsFor(cropYear - 1), cropYear })
      cache.set(key, r)
    }
    return r
  }
}

// ---------- Seed cotton aggregates (the classifier's cotton input) ----------

export type SeedCottonLoadLike = {
  id: string
  field_id: string | null
  crop_year: number
  net_weight: number | string | null
  picked_date: string | null
  delivered_date: string | null
}

/** A seed cotton load's harvest date: picked, falling back to delivered. */
export function cottonLoadDate(l: Pick<SeedCottonLoadLike, 'picked_date' | 'delivered_date'>): string | null {
  return l.picked_date ?? l.delivered_date ?? null
}

/**
 * `${fieldId}|${cropYear}` → seed cotton lbs (a weighed fact, no shrink) and
 * the latest picked date — the FieldCropAgg shape analyzeYields consumes via
 * the adapter below, with dryBu holding seed cotton lbs. Loads without a
 * field never classify a planting; loads without any date add their pounds
 * but can't place the field in time (like a grain load with no date would).
 */
export function seedCottonAggregates(
  loads: readonly SeedCottonLoadLike[],
  opts?: { cropYear?: number | null },
): Map<string, FieldCropAgg> {
  const out = new Map<string, FieldCropAgg>()
  for (const l of loads) {
    if (!l.field_id) continue
    if (opts?.cropYear != null && l.crop_year !== opts.cropYear) continue
    const lbs = Number(l.net_weight) || 0
    if (!(lbs > 0)) continue
    const key = `${l.field_id}|${l.crop_year}`
    let cur = out.get(key)
    if (!cur) {
      cur = { dryBu: 0, lastLoadDate: null, lastLoadTime: null, totalLoads: 0 }
      out.set(key, cur)
    }
    cur.dryBu += lbs
    cur.totalLoads = (cur.totalLoads ?? 0) + 1
    const date = cottonLoadDate(l)
    if (date != null && (cur.lastLoadDate == null || date > cur.lastLoadDate)) cur.lastLoadDate = date
  }
  return out
}

/**
 * The cotton input adapter for lib/yields (buildYieldInputs / analyzeSeason):
 * a planting of a cotton crop reads its seed cotton aggregate instead of a
 * grain aggregate, and its expected-yield bar is the crop's expected LINT
 * lbs/ac ÷ the resolved turnout — seed cotton lbs/ac, the unit its loads are
 * weighed in. Pure. Pass it ONLY when the Cotton module is on: without it the
 * engine behaves exactly as before (cotton plantings classify off grain
 * loads, i.e. unharvested).
 */
export function cottonYieldAdapter(args: {
  cottonCropIds: ReadonlySet<string>
  loads: readonly SeedCottonLoadLike[]
  turnoutFor: (cropId: string, cropYear: number) => TurnoutResolution
}): CottonYieldAdapter {
  const agg = seedCottonAggregates(args.loads)
  return {
    isCottonCrop: (cropId) => args.cottonCropIds.has(cropId),
    aggFor: (p) => agg.get(`${p.field_id}|${p.season_year}`),
    turnoutFor: (cropId, cropYear) => args.turnoutFor(cropId, cropYear).fraction,
  }
}

// ---------- Ginning status ----------

/** none = no loads; on_yard = nothing ginned; partly_ginned; ginned = every load on a receipt. */
export type GinningStatus = 'none' | 'on_yard' | 'partly_ginned' | 'ginned'

export function ginningStatusOf(loads: ReadonlyArray<{ id: string }>, ginnedLoadIds: ReadonlySet<string>): GinningStatus {
  if (loads.length === 0) return 'none'
  const ginned = loads.filter((l) => ginnedLoadIds.has(l.id)).length
  if (ginned === 0) return 'on_yard'
  return ginned === loads.length ? 'ginned' : 'partly_ginned'
}

export const GINNING_STATUS_LABEL: Record<GinningStatus, string> = {
  none: '—',
  on_yard: 'on yard',
  partly_ginned: 'partly ginned',
  ginned: 'ginned',
}

// ---------- Lint per field: actual + estimated ----------

/** Where a lint figure comes from: receipts only, turnout estimate only, or both. */
export type LintBasis = 'actual' | 'estimated_turnout' | 'mixed'

export type CottonPlantingYield = {
  /** Σ seed cotton lbs on the field's loads (ginned or not). */
  seedLbs: number
  seedPerAcre: number | null
  /** Seed cotton on loads NOT on any gin receipt — the estimate's basis. */
  yardSeedLbs: number
  loadCount: number
  receiptCount: number
  /** Actual ginned bales (bale rows, else the receipts' stated counts). */
  bales: number
  actualLintLbs: number
  /** yardSeedLbs × the resolved turnout. */
  estimatedLintLbs: number
  /** actual + estimated. */
  lintLbs: number
  /** null until anything is picked. */
  lintBasis: LintBasis | null
  lintPerAcre: number | null
  /** The field's own lint ÷ seed when fully ginned; else the resolved turnout. */
  turnoutPct: number | null
  turnoutBasis: 'actual' | 'estimated' | null
  turnout: TurnoutResolution
  ginning: GinningStatus
}

/**
 * One field × crop year's cotton numbers. Actual lint = the field's receipts
 * (bale rows else stated totals); the estimate covers only the seed cotton
 * still on the yard, so a fully ginned field is pure actual (today's math,
 * unchanged), a wholly unginned one a pure estimate, and a partly ginned one a
 * labeled hybrid. Yield = lint ÷ planted acres. Pure.
 */
export function cottonPlantingYield(args: {
  plantedAcres: number
  /** The field's seed cotton loads for the crop year. */
  loads: readonly SeedCottonLoadLike[]
  /** The field's gin receipts for the crop year. */
  receipts: readonly TurnoutReceiptLike[]
  /** All bale rows (filtered here by receipt id). */
  bales: ReadonlyArray<{ gin_receipt_id: string; net_weight_lbs: number | string | null }>
  ginnedLoadIds: ReadonlySet<string>
  turnout: TurnoutResolution
}): CottonPlantingYield {
  const receiptIds = new Set(args.receipts.map((r) => r.id))
  const baleAgg = new Map<string, { lbs: number; count: number }>()
  for (const b of args.bales) {
    if (!receiptIds.has(b.gin_receipt_id)) continue
    const a = baleAgg.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    a.lbs += Number(b.net_weight_lbs) || 0
    a.count += 1
    baleAgg.set(b.gin_receipt_id, a)
  }
  let actualLintLbs = 0
  let bales = 0
  let ginnedSeedWithLint = 0
  let lintWithSeed = 0
  for (const r of args.receipts) {
    const fromBales = baleAgg.get(r.id)
    const lint = fromBales && fromBales.lbs > 0 ? fromBales.lbs : Number(r.total_bale_weight) || 0
    actualLintLbs += lint
    bales += fromBales && fromBales.count > 0 ? fromBales.count : Number(r.bales_count) || 0
    const seed = Number(r.total_seed_cotton_weight) || 0
    if (seed > 0 && lint > 0) { ginnedSeedWithLint += seed; lintWithSeed += lint }
  }
  let seedLbs = 0
  let yardSeedLbs = 0
  for (const l of args.loads) {
    const lbs = Number(l.net_weight) || 0
    seedLbs += lbs
    if (!args.ginnedLoadIds.has(l.id)) yardSeedLbs += lbs
  }
  const estimatedLintLbs = yardSeedLbs * args.turnout.fraction
  const lintLbs = actualLintLbs + estimatedLintLbs
  const lintBasis: LintBasis | null =
    yardSeedLbs > 0 && actualLintLbs > 0 ? 'mixed'
    : yardSeedLbs > 0 ? 'estimated_turnout'
    : actualLintLbs > 0 ? 'actual'
    : null
  const acres = args.plantedAcres
  const fullyGinned = yardSeedLbs <= 0 && lintWithSeed > 0 && ginnedSeedWithLint > 0
  return {
    seedLbs,
    seedPerAcre: acres > 0 && seedLbs > 0 ? seedLbs / acres : null,
    yardSeedLbs,
    loadCount: args.loads.length,
    receiptCount: args.receipts.length,
    bales,
    actualLintLbs,
    estimatedLintLbs,
    lintLbs,
    lintBasis,
    lintPerAcre: acres > 0 && lintLbs > 0 ? lintLbs / acres : null,
    turnoutPct: fullyGinned ? Math.round((lintWithSeed / ginnedSeedWithLint) * 1000) / 10 : lintBasis == null ? null : args.turnout.pct,
    turnoutBasis: fullyGinned ? 'actual' : lintBasis == null ? null : 'estimated',
    turnout: args.turnout,
    ginning: ginningStatusOf(args.loads, args.ginnedLoadIds),
  }
}

// ---------- Crop-level production (the Marketing row and its heirs) ----------

export type CottonProduction = {
  /** actual + estimated lint — what the Marketing row prices once harvest is complete. */
  lintLbs: number
  /** Actual ginned bales only (never estimated). */
  bales: number
  actualLintLbs: number
  estimatedLintLbs: number
  lintBasis: LintBasis | null
  /** The turnout behind estimatedLintLbs; null when no estimate was needed. */
  turnout: TurnoutResolution | null
}

/**
 * The year's cotton production for a set of receipts (+ bale rows) and,
 * with the Cotton module on, its unginned seed cotton loads valued at the
 * resolved turnout. Without `loads` (module off, or a caller that never read
 * them) this is exactly the receipts-only total every consumer used before.
 */
export function cottonProductionTotals(args: {
  receipts: ReadonlyArray<{ id: string; total_bale_weight: number | string | null; bales_count: number | null }>
  bales: ReadonlyArray<{ gin_receipt_id: string; net_weight_lbs: number | string | null }>
  loads?: readonly SeedCottonLoadLike[] | null
  ginnedLoadIds?: ReadonlySet<string> | null
  turnout?: TurnoutResolution | null
}): CottonProduction {
  const balesByReceipt = new Map<string, { lbs: number; count: number }>()
  for (const b of args.bales) {
    const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    g.lbs += Number(b.net_weight_lbs) || 0
    g.count += 1
    balesByReceipt.set(b.gin_receipt_id, g)
  }
  let actualLintLbs = 0
  let bales = 0
  for (const r of args.receipts) {
    const fromBales = balesByReceipt.get(r.id)
    actualLintLbs += fromBales && fromBales.lbs > 0 ? fromBales.lbs : Number(r.total_bale_weight) || 0
    bales += fromBales && fromBales.count > 0 ? fromBales.count : Number(r.bales_count) || 0
  }
  let yardSeedLbs = 0
  if (args.loads && args.turnout) {
    for (const l of args.loads) if (!args.ginnedLoadIds?.has(l.id)) yardSeedLbs += Number(l.net_weight) || 0
  }
  const estimatedLintLbs = args.turnout ? yardSeedLbs * args.turnout.fraction : 0
  const lintBasis: LintBasis | null =
    estimatedLintLbs > 0 && actualLintLbs > 0 ? 'mixed'
    : estimatedLintLbs > 0 ? 'estimated_turnout'
    : actualLintLbs > 0 ? 'actual'
    : null
  return {
    lintLbs: actualLintLbs + estimatedLintLbs,
    bales,
    actualLintLbs,
    estimatedLintLbs,
    lintBasis,
    turnout: estimatedLintLbs > 0 ? args.turnout ?? null : null,
  }
}
