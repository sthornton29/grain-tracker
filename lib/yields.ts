import { computeBushels } from '@/lib/shrink'

// Shared yield math for the yield-average views (Yields by field/farm/variety/
// landowner and the Season Summary). Two pieces:
//   * fieldCropAggregates — dry bushels AND the most-recent contributing load
//     date, per field+crop+year, using the same allocation rules every view uses.
//   * analyzeYields — which plantings to drop (unharvested / in-progress) and the
//     weighted average yield per crop over the survivors.
//
// Combine entries (062): a combine_yield_entries row makes the COMBINE the
// authority for a field × crop × crop-year's production — the aggregate's
// dryBu becomes adjusted_total_bushels, and the weighed loads from that field
// are NETTED out of it (they keep their full identity everywhere load-specific:
// contracts, settlements, bin flows, the load log). The netting is recomputed
// from whatever loads exist at read time, so weighed loads entered before OR
// after the combine entry are never double-counted. Downstream consumers see
// the same FieldCropAgg shape with an extra `combine` block for the drill-down
// label, the bin-remainder posting, and the negative-net warning.

type LoadLike = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
  /** Optional load-level irrigated/dryland designation (migration 060). */
  practice?: 'irrigated' | 'dryland' | null
  /** Time of day (HH:MM:SS) when known — orders same-day loads across fields
   *  so the active-field hold can tell which field the combine moved to. */
  time?: string | null
}

type SplitLike = {
  load_id: string
  field_id: string
  crop_id: string
  dry_bushels: number | null
  practice?: 'irrigated' | 'dryland' | null
}

type CropLike = {
  id: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
}

/** The subset of a combine_yield_entries row (062) the yield math needs. */
export type CombineEntryLike = {
  id: string
  field_id: string
  crop_id: string
  crop_year: number
  stated_total_bushels: number | string
  adjusted_total_bushels: number | string
  adjustment_bu_per_acre: number | string | null
  destination_bin_id: string | null
  harvest_complete: boolean
  entry_date: string
}

/** The combine block on an aggregate: the authoritative entry + the netting. */
export type CombineAggInfo = {
  entryId: string
  statedBu: number
  /** THE field production number (stated ± adjustment × acres, stored). */
  adjustedBu: number
  adjustmentBuPerAcre: number | null
  /** Σ dry bushels of weighed loads / split portions from the field (netted). */
  weighedBu: number
  /** adjustedBu − weighedBu — the netted-to-storage remainder. NEGATIVE when
   *  weighed loads exceed the combine entry: warned everywhere, never clamped. */
  remainderBu: number
  destinationBinId: string | null
  harvestComplete: boolean
  entryDate: string
}

/** The entry-form math, in one place for the form, the live preview, and the
 *  tests: yield mode computes the stated total from the planting's acres; the
 *  signed calibration offset (± bu/ac) then scales by acres on top. No
 *  clamping — the form refuses to save a negative adjusted total. */
export function combineEntryTotals(args: {
  entryMode: 'total_bushels' | 'yield_per_acre'
  statedYieldPerAcre: number | null
  statedTotalBushels: number | null
  adjustmentBuPerAcre: number | null
  acres: number
}): { statedTotalBu: number; adjustedTotalBu: number } {
  const statedTotalBu = args.entryMode === 'yield_per_acre'
    ? (args.statedYieldPerAcre ?? 0) * args.acres
    : (args.statedTotalBushels ?? 0)
  const adjustedTotalBu = statedTotalBu + (args.adjustmentBuPerAcre ?? 0) * args.acres
  return { statedTotalBu, adjustedTotalBu }
}

/** The negative-net warning, worded once for the entry form AND the yields
 *  drill-down. Null when the netting is fine. Never clamps — the numbers stay
 *  as entered so the user can see exactly what disagrees. */
export function combineNegativeNetMessage(c: Pick<CombineAggInfo, 'weighedBu' | 'adjustedBu' | 'remainderBu'>): string | null {
  if (c.remainderBu >= 0) return null
  const fmt = (n: number) => Math.round(n).toLocaleString()
  return `Weighed loads from this field total ${fmt(c.weighedBu)} bu — more than the combine entry of ${fmt(c.adjustedBu)} bu; check the entry or the adjustment.`
}

export type FieldCropAgg = {
  dryBu: number
  /** Most recent contributing load date (YYYY-MM-DD), or null. Used to spot the
   *  field currently being harvested. */
  lastLoadDate: string | null
  /** Time of day of the newest load ON lastLoadDate (the latest known time
   *  among that day's loads), or null when none of them carries a time.
   *  Breaks same-day ties between fields for the active-field hold. */
  lastLoadTime?: string | null
  /** Dry bushels from loads/split-portions designated irrigated / dryland.
   *  A load with practice null contributes to dryBu only. Optional so callers
   *  that hand-build aggregates (income-sensitivity, tests) stay valid;
   *  fieldCropAggregates always fills them. */
  irrBu?: number
  dryLandBu?: number
  /** Counted loads + split portions (each portion counts separately) with /
   *  without a practice designation. designatedLoads === totalLoads (> 0) means
   *  the field's split is fully derivable from the loads. */
  designatedLoads?: number
  totalLoads?: number
  /** Present when a combine entry (062) is the authority for this field × crop
   *  × year — dryBu is then the entry's adjusted total, not the load sum. */
  combine?: CombineAggInfo
}

// (fieldId|cropId|loadYear) → { dryBu, lastLoadDate }. Single-field loads count
// via from_field_id; split loads via load_splits.dry_bushels. Optionally filters
// to a single crop_year (loads.crop_year) and/or a single load year (from date).
//
// combineEntries: for a combine-tracked field × crop × crop-year, loads that
// belong to that crop year (loads.crop_year, falling back to the date year) are
// keyed under the ENTRY's crop year rather than their haul date's year — a load
// hauled in January still nets against its season's combine entry — and the
// aggregate's dryBu becomes the entry's adjusted total (see `combine`).
export function fieldCropAggregates(
  loads: readonly LoadLike[],
  splits: readonly SplitLike[],
  cropById: Map<string, CropLike>,
  opts?: { cropYear?: number | null; loadYear?: number | null; combineEntries?: readonly CombineEntryLike[] | null },
): Map<string, FieldCropAgg> {
  const cropYear = opts?.cropYear ?? null
  const loadYear = opts?.loadYear ?? null
  const map = new Map<string, FieldCropAgg>()

  // Combine entries indexed by field|crop|cropYear. An entry's own year filter
  // uses crop_year for BOTH opts (a combine entry has no haul date).
  const entryByKey = new Map<string, CombineEntryLike>()
  for (const e of opts?.combineEntries ?? []) {
    if (cropYear != null && e.crop_year !== cropYear) continue
    if (loadYear != null && e.crop_year !== loadYear) continue
    entryByKey.set(`${e.field_id}|${e.crop_id}|${e.crop_year}`, e)
  }
  // The year a load's bushels are keyed under: normally the haul date's year,
  // but a load whose effective crop year (crop_year ?? date year) matches a
  // combine entry belongs to that entry's aggregate.
  const keyYearFor = (fieldId: string, cropId: string, dateYr: number, loadCropYear: number | null) => {
    const effYear = loadCropYear ?? dateYr
    return entryByKey.has(`${fieldId}|${cropId}|${effYear}`) ? effYear : dateYr
  }

  const bump = (key: string, bu: number, date: string, practice: 'irrigated' | 'dryland' | null, time: string | null) => {
    let cur = map.get(key)
    if (!cur) {
      cur = { dryBu: 0, lastLoadDate: null, lastLoadTime: null, irrBu: 0, dryLandBu: 0, designatedLoads: 0, totalLoads: 0 }
      map.set(key, cur)
    }
    cur.dryBu += bu
    if (cur.lastLoadDate == null || date > cur.lastLoadDate) {
      cur.lastLoadDate = date
      cur.lastLoadTime = time
    } else if (date === cur.lastLoadDate && time != null && (cur.lastLoadTime == null || time > cur.lastLoadTime)) {
      cur.lastLoadTime = time
    }
    cur.totalLoads = (cur.totalLoads ?? 0) + 1
    if (practice === 'irrigated') { cur.irrBu = (cur.irrBu ?? 0) + bu; cur.designatedLoads = (cur.designatedLoads ?? 0) + 1 }
    else if (practice === 'dryland') { cur.dryLandBu = (cur.dryLandBu ?? 0) + bu; cur.designatedLoads = (cur.designatedLoads ?? 0) + 1 }
  }

  for (const l of loads) {
    if (l.from_type !== 'field' || !l.from_field_id || !l.crop_id) continue
    if (cropYear != null && l.crop_year !== cropYear) continue
    const yr = Number(l.date.slice(0, 4))
    const keyYr = keyYearFor(l.from_field_id, l.crop_id, yr, l.crop_year)
    if (loadYear != null && keyYr !== loadYear) continue
    const crop = cropById.get(l.crop_id)
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (!dryBushels) continue
    bump(`${l.from_field_id}|${l.crop_id}|${keyYr}`, dryBushels, l.date, l.practice ?? null, l.time ?? null)
  }

  const loadById = new Map(loads.map((l) => [l.id, l]))
  for (const s of splits) {
    const parent = loadById.get(s.load_id)
    if (!parent) continue
    if (cropYear != null && parent.crop_year !== cropYear) continue
    if (s.dry_bushels == null) continue
    const yr = Number(parent.date.slice(0, 4))
    const keyYr = keyYearFor(s.field_id, s.crop_id, yr, parent.crop_year)
    if (loadYear != null && keyYr !== loadYear) continue
    bump(`${s.field_id}|${s.crop_id}|${keyYr}`, s.dry_bushels, parent.date, s.practice ?? null, parent.time ?? null)
  }

  // Combine pass: the entry is authoritative for the field's production. The
  // weighed sum accumulated above becomes the netting basis; dryBu is REPLACED
  // by the adjusted total (loads keep their identity everywhere load-specific —
  // only the field-production number is superseded).
  for (const [key, e] of entryByKey) {
    let cur = map.get(key)
    if (!cur) {
      cur = { dryBu: 0, lastLoadDate: null, lastLoadTime: null, irrBu: 0, dryLandBu: 0, designatedLoads: 0, totalLoads: 0 }
      map.set(key, cur)
    }
    const adjustedBu = Number(e.adjusted_total_bushels) || 0
    const weighedBu = cur.dryBu
    cur.combine = {
      entryId: e.id,
      statedBu: Number(e.stated_total_bushels) || 0,
      adjustedBu,
      adjustmentBuPerAcre: e.adjustment_bu_per_acre != null ? Number(e.adjustment_bu_per_acre) : null,
      weighedBu,
      remainderBu: adjustedBu - weighedBu,
      destinationBinId: e.destination_bin_id,
      harvestComplete: e.harvest_complete,
      entryDate: e.entry_date,
    }
    cur.dryBu = adjustedBu
    if (cur.lastLoadDate == null || e.entry_date > cur.lastLoadDate) {
      cur.lastLoadDate = e.entry_date
      cur.lastLoadTime = null // an entry has no time of day
    }
  }

  return map
}

// ---------------------------------------------------------------------------
// Irrigated / dryland practice classification and breakout resolution.
// ---------------------------------------------------------------------------

export type FieldPractice = 'pure-dry' | 'pure-irr' | 'mixed'

// Practice classification per planting (or field):
//   pure-dry: irrigated_acres == 0 (also the 0/0 case)
//   pure-irr: dryland_acres == 0
//   mixed:    both > 0 (the only case where a bushel breakout makes sense)
export function practiceOf(p: {
  irrigated_acres: number | string | null
  dryland_acres: number | string | null
}): FieldPractice {
  const irr = Number(p.irrigated_acres) || 0
  const dry = Number(p.dryland_acres) || 0
  if (irr > 0 && dry > 0) return 'mixed'
  if (irr > 0) return 'pure-irr'
  return 'pure-dry'
}

export type PracticeBreakout = {
  /** Where the irr/dry bushel split comes from:
   *  'manual' — the yields-page post-harvest allocation. Always wins over
   *             load-level designations, even ones edited later.
   *  'loads'  — every counted load (and split portion) carries a practice
   *             designation, so the split derives directly from the loads.
   *  null     — no complete split (pure-practice planting, or a mixed planting
   *             with missing designations and no manual allocation). */
  source: 'manual' | 'loads' | null
  irrigatedBushels: number | null
  drylandBushels: number | null
  /** Designated sums / counts off the loads, for pre-filling a partial manual
   *  allocation ("from X of Y loads — complete the remainder"). */
  designatedIrrBu: number
  designatedDryBu: number
  designatedLoads: number
  totalLoads: number
}

// One resolver for the mixed-planting bushel breakout, whichever path produced
// it. Every consumer (per-practice yields, insurance, Claims Monitor, Coverage
// Check, practice filters) goes through this — do not fork the rule. Pure.
export function resolvePracticeBreakout(
  planting: {
    irrigated_acres: number | string | null
    dryland_acres: number | string | null
    irrigated_bushels: number | string | null
    dryland_bushels: number | string | null
    yield_breakout_entered: boolean | null
  },
  agg: FieldCropAgg | null | undefined,
): PracticeBreakout {
  const designatedIrrBu = agg?.irrBu ?? 0
  const designatedDryBu = agg?.dryLandBu ?? 0
  const designatedLoads = agg?.designatedLoads ?? 0
  const totalLoads = agg?.totalLoads ?? 0
  const base = { designatedIrrBu, designatedDryBu, designatedLoads, totalLoads }
  if (practiceOf(planting) !== 'mixed') {
    return { source: null, irrigatedBushels: null, drylandBushels: null, ...base }
  }
  // A saved manual allocation wins over any later load-level edits.
  if (planting.yield_breakout_entered) {
    return {
      source: 'manual',
      irrigatedBushels: planting.irrigated_bushels != null ? Number(planting.irrigated_bushels) : null,
      drylandBushels: planting.dryland_bushels != null ? Number(planting.dryland_bushels) : null,
      ...base,
    }
  }
  // A combine-tracked field's weighed loads are only PART of its production
  // (the entry is the authority), so fully-designated loads can no longer
  // derive the whole split — only the manual allocation (or the combine
  // entry's irr/dry sub-entry, which writes through to it) can.
  if (totalLoads > 0 && designatedLoads === totalLoads && !agg?.combine) {
    return { source: 'loads', irrigatedBushels: designatedIrrBu, drylandBushels: designatedDryBu, ...base }
  }
  return { source: null, irrigatedBushels: null, drylandBushels: null, ...base }
}

// Materializes the effective breakout onto planting rows so downstream
// consumers that read irrigated_bushels / dryland_bushels /
// yield_breakout_entered straight off the planting (practiceActualYieldByCrop,
// the insurance production report, projectInsuranceIndemnities) see ONE shared
// representation regardless of whether the split came from the manual
// allocation or from fully-designated loads. Rows are copied, never mutated.
export function withLoadBreakouts<
  T extends {
    field_id: string
    crop_id: string
    season_year: number
    irrigated_acres: number | string | null
    dryland_acres: number | string | null
    irrigated_bushels: number | string | null
    dryland_bushels: number | string | null
    yield_breakout_entered: boolean | null
  },
>(plantings: readonly T[], aggByKey: Map<string, FieldCropAgg>): T[] {
  return plantings.map((p) => {
    const b = resolvePracticeBreakout(p, aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`))
    if (b.source !== 'loads') return p
    return {
      ...p,
      irrigated_bushels: b.irrigatedBushels,
      dryland_bushels: b.drylandBushels,
      yield_breakout_entered: true,
    }
  })
}

export type ExclusionReason = 'unharvested' | 'in_progress'

export type HarvestStatus = 'complete' | 'in_progress' | 'unharvested'

// Field-level harvest status, used to gate the bushel-allocation UI (the
// irrigated/dryland breakout and per-variety allocation) so it only appears once
// a field's harvest is done. A planting whose crop is flagged harvest_complete at
// the crop level (cropCompleteKeys, keyed `${crop_id}|${season_year}`) is always
// 'complete'; otherwise it's the analyzeYields classification — no exclusion
// means complete. Pure: callers pass the analysis `excluded` map in.
export function harvestStatusOf(
  planting: { id: string; crop_id: string; season_year: number },
  excluded: Map<string, ExclusionReason>,
  cropCompleteKeys: ReadonlySet<string>,
): HarvestStatus {
  if (cropCompleteKeys.has(`${planting.crop_id}|${planting.season_year}`)) return 'complete'
  const reason = excluded.get(planting.id)
  if (reason === 'in_progress') return 'in_progress'
  if (reason === 'unharvested') return 'unharvested'
  return 'complete'
}

export function isHarvestComplete(
  planting: { id: string; crop_id: string; season_year: number },
  excluded: Map<string, ExclusionReason>,
  cropCompleteKeys: ReadonlySet<string>,
): boolean {
  return harvestStatusOf(planting, excluded, cropCompleteKeys) === 'complete'
}

export type YieldInput = {
  /** Unique row id — a planting id in every current caller. */
  id: string
  cropId: string
  acres: number
  dryBu: number
  lastLoadDate: string | null
  /** Time of day of the newest load on lastLoadDate, when known. Lets the
   *  active-field hold order same-day loads across fields; without it a
   *  same-day switch is a tie and both fields stay held. */
  lastLoadTime?: string | null
  /** Manual override: true forces the field to be counted despite an auto flag;
   *  null/undefined leaves the automatic classification in effect. */
  override?: boolean | null
  /** The field's combine entry harvest_complete flag (062): true forces the
   *  field to classify complete (the user said it's finished), false forces
   *  in_progress (still harvesting — the partial figure would mislead).
   *  Undefined = no combine entry; the automatic classification applies.
   *  Callers set this from agg.combine?.harvestComplete. */
  combineComplete?: boolean
  /** The crop's expected yield for THIS planting (per-practice where the
   *  assumptions carry a breakout — see expectedYieldForPlanting). The
   *  comparison bar when the crop has too few harvested peer fields, so the
   *  FIRST field cut can still classify in-progress. Null/undefined = no
   *  estimate entered. */
  expectedYield?: number | null
}

export type CropAverage = {
  cropId: string
  acres: number
  dryBu: number
  /** Weighted yield: dryBu / acres over the included rows. */
  yield: number
}

export type HarvestProgress = {
  cropId: string
  /** Acres of completed fields (harvested, not in-progress; includes any
   *  in-progress field the user overrode to "count anyway"). */
  completedAcres: number
  inProgressAcres: number
  /** Acres of fields with no bushels yet. */
  remainingAcres: number
  totalAcres: number
  /** completedAcres / totalAcres, 0–100. */
  pctComplete: number
}

export type YieldAnalysis = {
  /** Row id → why it's excluded *after* overrides. Only excluded rows appear. */
  excluded: Map<string, ExclusionReason>
  /** Row id → the automatic classification, ignoring overrides. Lets the UI
   *  show "flagged but counted" when the user has overridden a row. */
  autoExcluded: Map<string, ExclusionReason>
  /** Crop id → weighted average over the surviving (included) rows. */
  averages: Map<string, CropAverage>
  /** Crop id → harvest completion (acres completed / in-progress / remaining). */
  progress: Map<string, HarvestProgress>
  /** Row ids that stayed complete ONLY because nothing existed to judge them
   *  against — no harvested peer fields and no expected yield entered. The
   *  drill-down surfaces this state so a defaulted classification is visible. */
  noBaseline: Set<string>
}

// A field whose yield is more than this far below its crop's settled average is
// treated as still-being-harvested (in progress) while its loads are recent.
export const IN_PROGRESS_THRESHOLD = 0.15

// ...until the CROP has sat quiet this long. The inactivity clock is
// crop-wide: a low field completes by silence only when no loads for its crop
// have arrived ANYWHERE for more than this window (harvest genuinely paused or
// over) — never merely because ITS OWN loads stopped. Operators routinely
// start a field, work others for days, and come back to finish, so while crop
// loads are still arriving a below-normal field stays in progress regardless
// of how long since its own last load.
export const IN_PROGRESS_STALE_DAYS = 10

// With fewer than this many OTHER harvested fields, the peer comparison is too
// thin to call a yield "low" — the crop's expected yield (crop_assumptions,
// per-practice where broken out) stands in as the bar, so the first field cut
// can still classify in-progress instead of defaulting complete.
export const IN_PROGRESS_MIN_PEERS = 2

// Per crop:
//   * a row with no bushels is "unharvested" → excluded.
//   * THE ACTIVE FIELD IS NEVER COMPLETE. While the crop is active (loads
//     within the window), a field with loads but NO later-dated load from
//     any other field of the crop is the one the combine is sitting in —
//     "in_progress" regardless of yield, even a perfectly normal one. The
//     hold clears when EITHER a later-dated load lands on another field
//     (moved on — the yield rules below then decide: normal → complete, low
//     → stays in progress) OR the crop goes quiet past the window (harvest
//     wrapped or paused; for the trailing field of the season its own last
//     load IS the crop's last load, so both formulations coincide). Two
//     fields loaded the same day are ordered by their loads' TIME of day
//     (loads.time) when both are known — the field with the later load is
//     the one the combine moved to; with a time missing the day is a tie
//     and both are held. "Count anyway" and the explicit harvest-complete
//     markers still complete a field from any state.
//   * LOW YIELD is the primary in-progress signal, and it PERSISTS. A field
//     whose yield is more than `threshold` below the crop's baseline is
//     "in_progress" → excluded (its partial bushels would understate the true
//     yield). A load from ANOTHER field dated later is NOT completion
//     evidence — operators routinely start a field, move off to others for
//     days, and come back to finish it. A low field leaves in-progress only
//     via positive evidence harvest truly ended at that number:
//       - the user's explicit "count anyway" override (always offered), OR
//       - the field's combine-entry harvest_complete / the crop-level
//         harvest-complete flag (applied by harvestStatusOf's callers), OR
//       - more than IN_PROGRESS_STALE_DAYS (10) of silence since the field's
//         last load — a long, conservative "clearly not coming back" fallback.
//     A field at/above the baseline (within `threshold`) is complete as usual
//     once the combine has moved on — the low-yield gate is what separates
//     "partially harvested" from "done" for a field that is no longer the
//     active one; a normal-yielding field is never held by the LOW-YIELD
//     logic (only by the active-field hold above, until the next field's
//     later-dated load arrives).
//     NOTE: a field that genuinely finished at a terrible number (a real crop
//     failure) is indistinguishable from one abandoned mid-harvest — "count
//     anyway" is the intended path to include it before the quiet window runs.
//     Days are counted calendar-date to calendar-date: load dates are date-only
//     strings, so subtracting them from the raw clock would silently shorten
//     the window by the local time of day and flip a field to completed partway
//     through the last day. The silence window is CROP-WIDE (see
//     IN_PROGRESS_STALE_DAYS): the crop quiet 10+ days completes everything;
//     while its loads still arrive anywhere, every harvested field is judged.
//     The baseline hierarchy per candidate:
//       1. with >= IN_PROGRESS_MIN_PEERS other harvested fields: their
//          weighted average — preferring the RESTING ones (own loads quiet
//          past the window; harvest has probably finished with them), so one
//          partial field can't drag the bar down for another;
//       2. with thinner peers: the planting's expected yield
//          (crop_assumptions via expectedYieldForPlanting) — so the FIRST
//          field cut classifies correctly; failing that, whatever peers exist;
//       3. with neither: the field cannot be judged — it stays complete and
//          is reported in `noBaseline` so the UI can say why.
// Averages are weighted (Σ dry bu / Σ acres) over the survivors.
export function analyzeYields(
  rows: readonly YieldInput[],
  threshold: number = IN_PROGRESS_THRESHOLD,
  now: Date = new Date(),
): YieldAnalysis {
  const excluded = new Map<string, ExclusionReason>()
  const autoExcluded = new Map<string, ExclusionReason>()
  const averages = new Map<string, CropAverage>()
  const progress = new Map<string, HarvestProgress>()
  const noBaseline = new Set<string>()

  const byCrop = new Map<string, YieldInput[]>()
  for (const r of rows) {
    const list = byCrop.get(r.cropId)
    if (list) list.push(r)
    else byCrop.set(r.cropId, [r])
  }

  for (const [cropId, list] of byCrop) {
    // --- Automatic classification (ignores overrides) ---
    const harvested: YieldInput[] = []
    for (const r of list) {
      if (r.dryBu > 0) harvested.push(r)
      else autoExcluded.set(r.id, 'unharvested')
    }

    if (harvested.length >= 1) {
      // Calendar-day distance from `now`'s local date to a load's date. Load
      // dates are date-only strings (UTC midnight when parsed), so measuring
      // against the raw clock would shorten the stale window by the local time
      // of day — a field would flip to completed partway through the last day.
      const pad2 = (n: number) => String(n).padStart(2, '0')
      const today = Date.parse(`${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`)
      const daysSince = (date: string) => Math.round((today - Date.parse(date.slice(0, 10))) / 86_400_000)
      // The inactivity clock is CROP-WIDE: fields complete by silence only
      // when no loads for the crop have arrived ANYWHERE (in the analyzed
      // scope) for more than the window — harvest genuinely paused or over.
      // While crop loads are still arriving, a below-normal field stays in
      // progress no matter how long since ITS OWN last load: the combine
      // routinely leaves a field for days and comes back to finish it.
      const cropLast = harvested.reduce<string | null>((max, r) => {
        const d = r.lastLoadDate ? r.lastLoadDate.slice(0, 10) : null
        return d != null && (max == null || d > max) ? d : max
      }, null)
      const cropActive = cropLast != null && daysSince(cropLast) <= IN_PROGRESS_STALE_DAYS
      if (cropActive) {
        // "Resting" fields — own loads quiet past the window — are the
        // preferred peer baseline (harvest has probably finished with them),
        // though while the crop is active they remain candidates themselves.
        const isResting = (r: YieldInput) =>
          r.lastLoadDate == null || daysSince(r.lastLoadDate) > IN_PROGRESS_STALE_DAYS
        // The field the combine is in right now: loads, and no OTHER field
        // of the crop has a later load. Held in progress whatever its yield
        // — you can't be done with a field you're still cutting. (A field
        // with bushels but no load date can't be placed in time and is not
        // held.) "Later" is by calendar date first; on the same day the
        // loads' times decide when BOTH are known (the operation switched
        // fields mid-day — the field hauled later is the current one);
        // with a time missing the day is a tie and both fields stay held.
        const loadedAfter = (other: YieldInput, own: YieldInput) => {
          const a = other.lastLoadDate!.slice(0, 10)
          const b = own.lastLoadDate!.slice(0, 10)
          if (a !== b) return a > b
          return other.lastLoadTime != null && own.lastLoadTime != null && other.lastLoadTime > own.lastLoadTime
        }
        const isActiveField = (cand: YieldInput) => {
          if (cand.lastLoadDate == null) return false
          return !harvested.some((r) => r.id !== cand.id && r.lastLoadDate != null && loadedAfter(r, cand))
        }
        for (const cand of harvested) {
          if (isActiveField(cand)) {
            autoExcluded.set(cand.id, 'in_progress')
            continue
          }
          const others = harvested.filter((r) => r.id !== cand.id)
          let bu = 0
          let ac = 0
          for (const r of others) {
            if (isResting(r)) {
              bu += r.dryBu
              ac += r.acres
            }
          }
          if (ac <= 0) {
            for (const r of others) {
              bu += r.dryBu
              ac += r.acres
            }
          }
          const peerBaseline = ac > 0 ? bu / ac : null
          // Thin peers → the planting's expected yield stands in, so the
          // first field cut classifies correctly; failing that, whatever
          // peers exist; with neither the field cannot be judged.
          const baseline =
            others.length >= IN_PROGRESS_MIN_PEERS
              ? peerBaseline
              : cand.expectedYield != null && cand.expectedYield > 0
              ? cand.expectedYield
              : peerBaseline
          if (baseline == null) {
            noBaseline.add(cand.id)
            continue
          }
          const candYield = cand.acres > 0 ? cand.dryBu / cand.acres : null
          if (candYield != null && candYield < baseline * (1 - threshold)) {
            autoExcluded.set(cand.id, 'in_progress')
          }
        }
      }
    }

    // --- Combine entries override the automatic classification (062) ---
    // The entry's harvest_complete flag is the user's explicit statement:
    // true → the field is done (counted, whatever the load-recency heuristics
    // say — even at 0 bu, a recorded crop failure); false → still harvesting
    // (in_progress; the "count anyway" override can still rescue it).
    for (const r of list) {
      if (r.combineComplete === true) autoExcluded.delete(r.id)
      else if (r.combineComplete === false) autoExcluded.set(r.id, 'in_progress')
    }

    // --- Apply overrides → effective exclusion + averages ---
    // The override only un-excludes an in-progress field — an unharvested field
    // has no bushels, so "count anyway" never applies to it.
    let bu = 0
    let ac = 0
    for (const r of list) {
      const auto = autoExcluded.get(r.id)
      const overrideCounts = auto === 'in_progress' && r.override === true
      if (auto != null && !overrideCounts) {
        excluded.set(r.id, auto)
        continue
      }
      bu += r.dryBu
      ac += r.acres
    }
    if (ac > 0) averages.set(cropId, { cropId, acres: ac, dryBu: bu, yield: bu / ac })

    // Harvest progress (by acres), using the effective classification so a
    // "count anyway" override moves a field from in-progress into completed.
    let completedAcres = 0
    let inProgressAcres = 0
    let remainingAcres = 0
    for (const r of list) {
      const eff = excluded.get(r.id)
      if (eff === 'unharvested') remainingAcres += r.acres
      else if (eff === 'in_progress') inProgressAcres += r.acres
      else completedAcres += r.acres
    }
    const totalAcres = completedAcres + inProgressAcres + remainingAcres
    progress.set(cropId, {
      cropId,
      completedAcres,
      inProgressAcres,
      remainingAcres,
      totalAcres,
      pctComplete: totalAcres > 0 ? (completedAcres / totalAcres) * 100 : 0,
    })
  }

  return { excluded, autoExcluded, averages, progress, noBaseline }
}

/** The crop_assumptions slice the expected-yield fallback reads. */
export type ExpectedYieldAssumption = {
  crop_id: string
  crop_year: number
  expected_yield: number | string | null
  expected_yield_irr?: number | string | null
  expected_yield_dry?: number | string | null
}

// The expected yield to judge ONE planting against (the thin-peers fallback
// bar): per-practice where the assumptions carry a breakout — pure-irrigated
// and pure-dryland plantings read their side (blank side falls back to the
// overall, the app-wide breakout convention), mixed plantings acre-weight the
// two sides. Null when no usable number is entered. Pure.
export function expectedYieldForPlanting(
  a: ExpectedYieldAssumption | null | undefined,
  p: { irrigated_acres: number | string | null; dryland_acres: number | string | null },
): number | null {
  if (!a) return null
  const numOrNull = (v: number | string | null | undefined): number | null => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const overall = numOrNull(a.expected_yield)
  const irr = numOrNull(a.expected_yield_irr) ?? overall
  const dry = numOrNull(a.expected_yield_dry) ?? overall
  const practice = practiceOf(p)
  if (practice === 'pure-irr') return irr
  if (practice === 'pure-dry') return dry
  const irrAc = Number(p.irrigated_acres) || 0
  const dryAc = Number(p.dryland_acres) || 0
  if (irr == null || dry == null) return overall
  const totalAc = irrAc + dryAc
  return totalAc > 0 ? (irr * irrAc + dry * dryAc) / totalAc : overall
}

/** The planting shape the season-level helpers below classify. */
type SeasonPlanting = {
  id: string; field_id: string; crop_id: string; season_year: number
  planted_acres: number | string | null; yield_include_override?: boolean | null
  /** Optional practice acres — enable the per-practice expected-yield bar. */
  irrigated_acres?: number | string | null
  dryland_acres?: number | string | null
}

// One shared mapping from planting rows + aggregates to the analyzeYields
// input, so every season-level consumer classifies fields identically.
// `assumptions` (crop_assumptions rows) power the thin-peers expected-yield
// fallback; omitting them just disables that comparison tier.
function analyzeSeason<T extends SeasonPlanting>(args: {
  plantings: ReadonlyArray<T>
  aggByKey: Map<string, FieldCropAgg>
  cropYear: number
  assumptions?: readonly ExpectedYieldAssumption[] | null
  now?: Date
}): { yearPlantings: T[]; analysis: YieldAnalysis } {
  const yearPlantings = args.plantings.filter((p) => p.season_year === args.cropYear)
  const assumptionByCrop = new Map<string, ExpectedYieldAssumption>()
  for (const a of args.assumptions ?? []) {
    if (a.crop_year === args.cropYear) assumptionByCrop.set(a.crop_id, a)
  }
  const analysis = analyzeYields(
    yearPlantings.map((p) => {
      const agg = args.aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
      return {
        id: p.id, cropId: p.crop_id, acres: Number(p.planted_acres ?? 0),
        dryBu: agg?.dryBu ?? 0, lastLoadDate: agg?.lastLoadDate ?? null,
        lastLoadTime: agg?.lastLoadTime ?? null,
        override: p.yield_include_override ?? null,
        combineComplete: agg?.combine?.harvestComplete,
        expectedYield: expectedYieldForPlanting(assumptionByCrop.get(p.crop_id), {
          irrigated_acres: p.irrigated_acres ?? null,
          dryland_acres: p.dryland_acres ?? null,
        }),
      }
    }),
    IN_PROGRESS_THRESHOLD, args.now,
  )
  return { yearPlantings, analysis }
}

// Crop ids whose harvest is COMPLETE for a crop year: the crop has at least one
// planting and every planting is harvest-complete (analyzeYields not-excluded, or
// the crop-level harvest_complete flag via cropCompleteKeys). The Marketing
// dashboard and Revenue Projections use this to switch a crop from the yield
// ESTIMATE to ACTUAL harvested production once it's fully in the bin — so a poor
// harvest stops showing estimate-based revenue/profit. Pure.
export function cropsWithCompleteHarvest(args: {
  plantings: ReadonlyArray<SeasonPlanting>
  aggByKey: Map<string, FieldCropAgg>
  cropYear: number
  cropCompleteKeys: ReadonlySet<string>
  assumptions?: readonly ExpectedYieldAssumption[] | null
  now?: Date
}): Set<string> {
  const { yearPlantings, analysis } = analyzeSeason(args)
  const byCrop = new Map<string, typeof yearPlantings>()
  for (const p of yearPlantings) {
    const arr = byCrop.get(p.crop_id)
    if (arr) arr.push(p)
    else byCrop.set(p.crop_id, [p])
  }
  const out = new Set<string>()
  for (const [cropId, ps] of byCrop) {
    if (ps.length > 0 && ps.every((p) => isHarvestComplete(p, analysis.excluded, args.cropCompleteKeys))) out.add(cropId)
  }
  return out
}

// Plantings still effectively in progress (after any "count anyway" override),
// grouped by crop id — the fields holding a crop back from the estimate→actual
// switch. Same inputs and classification as cropsWithCompleteHarvest, so a
// surface that uses one can name the other's holdouts and offer the "count
// anyway" override on them. Pure.
export function inProgressPlantingsByCrop<T extends SeasonPlanting>(args: {
  plantings: ReadonlyArray<T>
  aggByKey: Map<string, FieldCropAgg>
  cropYear: number
  cropCompleteKeys: ReadonlySet<string>
  assumptions?: readonly ExpectedYieldAssumption[] | null
  now?: Date
}): Map<string, T[]> {
  const { yearPlantings, analysis } = analyzeSeason(args)
  const out = new Map<string, T[]>()
  for (const p of yearPlantings) {
    if (harvestStatusOf(p, analysis.excluded, args.cropCompleteKeys) !== 'in_progress') continue
    const arr = out.get(p.crop_id)
    if (arr) arr.push(p)
    else out.set(p.crop_id, [p])
  }
  return out
}

// ---------------------------------------------------------------------------
// Group-level yield rollup — powers Yields by Entity (and is generic enough for
// any grouping). Rolls plantings up by group × crop × season, mirroring the
// by-farm rollup in the Yields page: each planting contributes its total dry
// bushels and planted acres, plus a determinable irrigated/dryland split —
// pure-irrigated and pure-dryland plantings, and mixed plantings that have an
// entered breakout. A mixed planting with NO breakout adds to the totals but to
// neither side (it shows "—" in the breakdown columns, exactly like by-field).
// Callers pass plantings already filtered to the harvest-included set (so
// unharvested / in-progress fields are dropped upstream by analyzeYields). Pure.
// ---------------------------------------------------------------------------
export type GroupYieldPlanting = {
  groupId: string
  groupName: string
  cropId: string
  cropName: string
  seasonYear: number
  acres: number
  dryBu: number
  irrigatedAcres: number
  drylandAcres: number
  yieldBreakoutEntered: boolean
  irrigatedBushels: number | null
  drylandBushels: number | null
}

export type GroupYieldAgg = {
  groupId: string
  groupName: string
  cropId: string
  cropName: string
  seasonYear: number
  acres: number
  dryBu: number
  irrAc: number
  dryAc: number
  irrBu: number
  dryBuLand: number
  /** Weighted yields (Σ dryBu / Σ acres) over the group's plantings; null when
   *  a side has no determinable acres. */
  yield: number | null
  irrigatedYield: number | null
  drylandYield: number | null
}

export function groupYieldAggregates(plantings: readonly GroupYieldPlanting[]): GroupYieldAgg[] {
  const m = new Map<string, GroupYieldAgg>()
  for (const p of plantings) {
    const irrAcP = Number(p.irrigatedAcres) || 0
    const dryAcP = Number(p.drylandAcres) || 0
    // Per-side determinable contribution, identical to the by-farm rollup:
    //   pure-irrigated → all dry bu to the irrigated side
    //   pure-dryland   → all dry bu to the dryland side (also the 0/0 case)
    //   mixed          → only the entered breakout splits the bushels
    const practice = practiceOf({ irrigated_acres: irrAcP, dryland_acres: dryAcP })
    let irrBu = 0, irrAc = 0, dryBuLand = 0, dryAc = 0
    if (practice === 'pure-irr') { irrBu = p.dryBu; irrAc = irrAcP }
    else if (practice === 'pure-dry') { dryBuLand = p.dryBu; dryAc = dryAcP }
    else if (p.yieldBreakoutEntered) {
      if (p.irrigatedBushels != null) { irrBu = Number(p.irrigatedBushels); irrAc = irrAcP }
      if (p.drylandBushels != null) { dryBuLand = Number(p.drylandBushels); dryAc = dryAcP }
    }
    const key = `${p.groupId}|${p.cropId}|${p.seasonYear}`
    const ex = m.get(key)
    if (ex) {
      ex.acres += p.acres; ex.dryBu += p.dryBu
      ex.irrAc += irrAc; ex.dryAc += dryAc; ex.irrBu += irrBu; ex.dryBuLand += dryBuLand
    } else {
      m.set(key, {
        groupId: p.groupId, groupName: p.groupName,
        cropId: p.cropId, cropName: p.cropName, seasonYear: p.seasonYear,
        acres: p.acres, dryBu: p.dryBu, irrAc, dryAc, irrBu, dryBuLand,
        yield: null, irrigatedYield: null, drylandYield: null,
      })
    }
  }
  for (const r of m.values()) {
    r.yield = r.acres > 0 ? r.dryBu / r.acres : null
    r.irrigatedYield = r.irrAc > 0 ? r.irrBu / r.irrAc : null
    r.drylandYield = r.dryAc > 0 ? r.dryBuLand / r.dryAc : null
  }
  return [...m.values()].sort((a, b) => {
    if (b.seasonYear !== a.seasonYear) return b.seasonYear - a.seasonYear
    const gn = a.groupName.localeCompare(b.groupName)
    if (gn !== 0) return gn
    return a.cropName.localeCompare(b.cropName)
  })
}
