import { computeBushels } from '@/lib/shrink'

// Shared yield math for the yield-average views (Yields by field/farm/variety/
// landowner and the Season Summary). Two pieces:
//   * fieldCropAggregates — dry bushels AND the most-recent contributing load
//     date, per field+crop+year, using the same allocation rules every view uses.
//   * analyzeYields — which plantings to drop (unharvested / in-progress) and the
//     weighted average yield per crop over the survivors.

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
}

type SplitLike = {
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

export type FieldCropAgg = {
  dryBu: number
  /** Most recent contributing load date (YYYY-MM-DD), or null. Used to spot the
   *  field currently being harvested. */
  lastLoadDate: string | null
}

// (fieldId|cropId|loadYear) → { dryBu, lastLoadDate }. Single-field loads count
// via from_field_id; split loads via load_splits.dry_bushels. Optionally filters
// to a single crop_year (loads.crop_year) and/or a single load year (from date).
export function fieldCropAggregates(
  loads: readonly LoadLike[],
  splits: readonly SplitLike[],
  cropById: Map<string, CropLike>,
  opts?: { cropYear?: number | null; loadYear?: number | null },
): Map<string, FieldCropAgg> {
  const cropYear = opts?.cropYear ?? null
  const loadYear = opts?.loadYear ?? null
  const map = new Map<string, FieldCropAgg>()

  const bump = (key: string, bu: number, date: string) => {
    const cur = map.get(key)
    if (cur) {
      cur.dryBu += bu
      if (cur.lastLoadDate == null || date > cur.lastLoadDate) cur.lastLoadDate = date
    } else {
      map.set(key, { dryBu: bu, lastLoadDate: date })
    }
  }

  for (const l of loads) {
    if (l.from_type !== 'field' || !l.from_field_id || !l.crop_id) continue
    if (cropYear != null && l.crop_year !== cropYear) continue
    const yr = Number(l.date.slice(0, 4))
    if (loadYear != null && yr !== loadYear) continue
    const crop = cropById.get(l.crop_id)
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (!dryBushels) continue
    bump(`${l.from_field_id}|${l.crop_id}|${yr}`, dryBushels, l.date)
  }

  const loadById = new Map(loads.map((l) => [l.id, l]))
  for (const s of splits) {
    const parent = loadById.get(s.load_id)
    if (!parent) continue
    if (cropYear != null && parent.crop_year !== cropYear) continue
    if (s.dry_bushels == null) continue
    const yr = Number(parent.date.slice(0, 4))
    if (loadYear != null && yr !== loadYear) continue
    bump(`${s.field_id}|${s.crop_id}|${yr}`, s.dry_bushels, parent.date)
  }

  return map
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
  /** Manual override: true forces the field to be counted despite an auto flag;
   *  null/undefined leaves the automatic classification in effect. */
  override?: boolean | null
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
}

// A field whose yield is more than this far below its crop's settled average is
// treated as still-being-harvested (in progress) while its loads are recent.
export const IN_PROGRESS_THRESHOLD = 0.15

// ...but only while harvest is recent. Once the last load is older than this,
// the field has clearly finished — its low number is its real yield, so it
// moves to completed instead of sitting at "in progress" forever.
export const IN_PROGRESS_STALE_DAYS = 5

// Per crop:
//   * a row with no bushels is "unharvested" → excluded.
//   * EVERY field whose last load is within IN_PROGRESS_STALE_DAYS is a
//     potential in-progress candidate — harvest often jumps between fields (or
//     runs two combines), so "the single most recent field" is not required.
//     A candidate is "in_progress" → excluded when its yield is more than
//     `threshold` below the baseline (its partial bushels would understate the
//     true yield). The baseline is the weighted average of the crop's SETTLED
//     fields (last load older than the window — clearly finished), so one
//     partial field can't drag the bar down for another; when every harvested
//     field is recent, it falls back to the other harvested fields. A field
//     within `threshold` of the baseline, or whose last load is older than the
//     stale window, counts as completed.
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

    // Only flag in-progress when there are other harvested fields to compare
    // against — otherwise we have no baseline.
    if (harvested.length >= 2) {
      // Candidates = every field with a load inside the stale window. Harvest
      // often jumps between fields (or runs two combines at once), so any
      // recently-loaded field can still be mid-harvest — not just the newest.
      const isRecent = (r: YieldInput) => {
        if (!r.lastLoadDate) return false
        const days = (now.getTime() - new Date(r.lastLoadDate).getTime()) / 86_400_000
        return days <= IN_PROGRESS_STALE_DAYS
      }
      const recent = harvested.filter(isRecent)
      // Baseline = the SETTLED fields (last load older than the window — they
      // have clearly finished), so one partial field can't drag the bar down
      // for another partial field.
      let settledBu = 0
      let settledAc = 0
      for (const r of harvested) {
        if (isRecent(r)) continue
        settledBu += r.dryBu
        settledAc += r.acres
      }
      for (const cand of recent) {
        let bu = settledBu
        let ac = settledAc
        if (settledAc <= 0) {
          // Harvest just started and every field is recent — fall back to the
          // other harvested fields so there is still a comparison.
          for (const r of harvested) {
            if (r.id === cand.id) continue
            bu += r.dryBu
            ac += r.acres
          }
        }
        const baseline = ac > 0 ? bu / ac : null
        const candYield = cand.acres > 0 ? cand.dryBu / cand.acres : null
        if (baseline != null && candYield != null && candYield < baseline * (1 - threshold)) {
          autoExcluded.set(cand.id, 'in_progress')
        }
      }
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

  return { excluded, autoExcluded, averages, progress }
}

// Crop ids whose harvest is COMPLETE for a crop year: the crop has at least one
// planting and every planting is harvest-complete (analyzeYields not-excluded, or
// the crop-level harvest_complete flag via cropCompleteKeys). The Marketing
// dashboard and Revenue Projections use this to switch a crop from the yield
// ESTIMATE to ACTUAL harvested production once it's fully in the bin — so a poor
// harvest stops showing estimate-based revenue/profit. Pure.
export function cropsWithCompleteHarvest(args: {
  plantings: ReadonlyArray<{
    id: string; field_id: string; crop_id: string; season_year: number
    planted_acres: number | string | null; yield_include_override?: boolean | null
  }>
  aggByKey: Map<string, FieldCropAgg>
  cropYear: number
  cropCompleteKeys: ReadonlySet<string>
  now?: Date
}): Set<string> {
  const { plantings, aggByKey, cropYear, cropCompleteKeys, now } = args
  const yearPlantings = plantings.filter((p) => p.season_year === cropYear)
  const analysis = analyzeYields(
    yearPlantings.map((p) => {
      const agg = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
      return {
        id: p.id, cropId: p.crop_id, acres: Number(p.planted_acres ?? 0),
        dryBu: agg?.dryBu ?? 0, lastLoadDate: agg?.lastLoadDate ?? null,
        override: p.yield_include_override ?? null,
      }
    }),
    IN_PROGRESS_THRESHOLD, now,
  )
  const byCrop = new Map<string, typeof yearPlantings>()
  for (const p of yearPlantings) {
    const arr = byCrop.get(p.crop_id)
    if (arr) arr.push(p)
    else byCrop.set(p.crop_id, [p])
  }
  const out = new Set<string>()
  for (const [cropId, ps] of byCrop) {
    if (ps.length > 0 && ps.every((p) => isHarvestComplete(p, analysis.excluded, cropCompleteKeys))) out.add(cropId)
  }
  return out
}
