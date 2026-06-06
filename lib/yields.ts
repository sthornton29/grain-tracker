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

export type YieldAnalysis = {
  /** Row id → why it's excluded *after* overrides. Only excluded rows appear. */
  excluded: Map<string, ExclusionReason>
  /** Row id → the automatic classification, ignoring overrides. Lets the UI
   *  show "flagged but counted" when the user has overridden a row. */
  autoExcluded: Map<string, ExclusionReason>
  /** Crop id → weighted average over the surviving (included) rows. */
  averages: Map<string, CropAverage>
}

// A field whose yield is more than this far below its crop's harvested average is
// treated as still-being-harvested (in progress) when it's the latest field.
export const IN_PROGRESS_THRESHOLD = 0.15

// Per crop:
//   * a row with no bushels is "unharvested" → excluded.
//   * the field whose most recent load is the latest for that crop is the one
//     currently being combined; if its yield is more than `threshold` below the
//     weighted average of the crop's OTHER harvested fields, it's "in_progress"
//     → excluded (its partial bushels would understate the true yield).
// Averages are weighted (Σ dry bu / Σ acres) over the survivors.
export function analyzeYields(
  rows: readonly YieldInput[],
  threshold: number = IN_PROGRESS_THRESHOLD,
): YieldAnalysis {
  const excluded = new Map<string, ExclusionReason>()
  const autoExcluded = new Map<string, ExclusionReason>()
  const averages = new Map<string, CropAverage>()

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

    if (harvested.length > 0) {
      // The field currently being harvested = the one with the most recent load.
      let candidate: YieldInput | null = null
      for (const r of harvested) {
        if (r.lastLoadDate == null) continue
        if (candidate == null || r.lastLoadDate > (candidate.lastLoadDate as string)) candidate = r
      }

      // Only flag it as in-progress when there are other harvested fields to
      // compare against — otherwise we have no baseline.
      if (candidate && harvested.length >= 2) {
        let bu = 0
        let ac = 0
        for (const r of harvested) {
          if (r.id === candidate.id) continue
          bu += r.dryBu
          ac += r.acres
        }
        const baseline = ac > 0 ? bu / ac : null
        const candYield = candidate.acres > 0 ? candidate.dryBu / candidate.acres : null
        if (baseline != null && candYield != null && candYield < baseline * (1 - threshold)) {
          autoExcluded.set(candidate.id, 'in_progress')
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
  }

  return { excluded, autoExcluded, averages }
}
