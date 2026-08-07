// Split-load allocation: turn user-entered per-field weights into the rows we
// persist in load_splits, including wet/dry bushels computed against the
// parent load's moisture and crop base values.
//
// The parent load still carries the totals (gross, tare, net, moisture, etc.).
// load_splits is purely an allocation table — the sum of split net weights
// must equal the parent's net weight (within rounding tolerance).

import { computeBushels } from '@/lib/shrink'
import type { Crop, LoadSplit } from '@/lib/types'

// Equality tolerances. Weights are in pounds (scale precision ~10 lb), so 1 lb
// is plenty tight. Percentages are 0–100 with up to 3 decimals.
export const WEIGHT_TOLERANCE_LB = 1
export const PCT_TOLERANCE = 0.05

export type SplitDraft = {
  field_id: string
  net_weight: number
  /** Irrigated/dryland designation for this portion — only set when the
   *  portion's field is mixed-practice; null/omitted otherwise. */
  practice?: 'irrigated' | 'dryland' | null
}

export type AllocatedSplit = {
  field_id: string
  crop_id: string
  net_weight: number
  percentage: number
  wet_bushels: number | null
  dry_bushels: number | null
  practice: 'irrigated' | 'dryland' | null
}

export type ParentLoadForAllocation = {
  crop_id: string
  net_weight: number
  moisture: number | null
  dry_bushels_override?: number | null
}

// Allocate per-split bushels using the parent's moisture + the crop's base
// values. Same shrink formula as the single-field path — applied to each
// split's net weight individually. The sum of dry_bushels matches the
// parent's dry_bushels within ~rounding (we don't redistribute manually
// overridden parent dry_bushels back into splits; that's a deliberate
// trade-off, documented for the user via a note when relevant).
export function allocateSplits(
  parent: ParentLoadForAllocation,
  splits: SplitDraft[],
  crop: Crop | null,
): AllocatedSplit[] {
  const totalNet = parent.net_weight
  return splits.map((s) => {
    const pct = totalNet > 0 ? (s.net_weight / totalNet) * 100 : 0
    const { wetBushels, dryBushels } = computeBushels({
      netWeightLb: s.net_weight,
      moisturePct: parent.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
    })
    return {
      field_id: s.field_id,
      crop_id: parent.crop_id,
      net_weight: round2(s.net_weight),
      percentage: round3(pct),
      wet_bushels: wetBushels == null ? null : round2(wetBushels),
      dry_bushels: dryBushels == null ? null : round2(dryBushels),
      practice: s.practice ?? null,
    }
  })
}

// Validates a list of drafts against the parent net weight. Returns null on
// success or a human-readable error message.
export function validateSplitDrafts(
  drafts: SplitDraft[],
  totalNetLb: number,
): string | null {
  if (drafts.length < 2) return 'A split load needs at least two fields.'
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]
    if (!d.field_id) return `Split row ${i + 1}: pick a field.`
    if (!(d.net_weight > 0)) return `Split row ${i + 1}: weight must be greater than zero.`
  }
  const seen = new Set<string>()
  for (const d of drafts) {
    if (seen.has(d.field_id)) return 'Each split must use a different field.'
    seen.add(d.field_id)
  }
  if (!(totalNetLb > 0)) return 'Enter the load’s net weight before allocating splits.'
  const sum = drafts.reduce((a, d) => a + d.net_weight, 0)
  if (Math.abs(sum - totalNetLb) > WEIGHT_TOLERANCE_LB) {
    return `Split weights total ${fmtLb(sum)} lb but the load net weight is ${fmtLb(totalNetLb)} lb.`
  }
  return null
}

function fmtLb(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000
}

// Build a stable "Field A / Field B / Field C" label for a list of splits.
// Sorted by largest allocation first so the dominant field reads first.
export function splitFieldLabel(
  splits: Pick<LoadSplit, 'field_id' | 'net_weight'>[],
  fieldNameById: Map<string, string>,
): string {
  const sorted = [...splits].sort((a, b) => b.net_weight - a.net_weight)
  return sorted
    .map((s) => fieldNameById.get(s.field_id) ?? '—')
    .join(' / ')
}
