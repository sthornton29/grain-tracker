// Variety yield attribution — THE one seam deciding how a planting's dry
// bushels split across its variety rows. The Yields "By Variety" tab's rows
// AND their drill-down both read from it, so a drill-down provably sums to
// the row it explains (the same conservation guarantee as the other tabs).
//
// Attribution rules, per planting:
//   - 0 varieties: excluded — nothing to attribute to.
//   - 1 variety ('whole'): every bushel belongs to it; acres come from the
//     variety row, falling back to planted_acres when left at 0.
//   - 2+ varieties, every row's bushels allocated ('allocated'): the user's
//     manual per-variety allocation is authoritative.
//   - 2+ varieties, not fully allocated ('acre_share'): estimated by each
//     variety's share of the varieties' acres — an ESTIMATE, badged
//     "acre-share est." everywhere it shows; allocating bushels on the
//     planting replaces it. With no variety acres recorded there is no basis
//     at all, so the planting stays excluded (never a silent even split).

import { weightedAverage, type YieldDetailLoad, type YieldDetailSummary } from '@/lib/yield-detail'

export type VarietyAttributionBasis = 'whole' | 'allocated' | 'acre_share'

export const VARIETY_BASIS_LABEL: Record<VarietyAttributionBasis, string | null> = {
  whole: null, // single-variety fields need no badge
  allocated: 'allocated',
  acre_share: 'acre-share est.',
}

export type VarietyPlantingLike = {
  id: string
  field_id: string
  crop_id: string
  season_year: number
  planted_acres: number | string | null
}

export type VarietyRowLike = {
  variety: string
  acres: number | string | null
  bushels: number | string | null
}

/** One planting's contribution to one variety. */
export type VarietyPlantingPart = {
  plantingId: string
  fieldId: string
  cropId: string
  seasonYear: number
  variety: string
  /** Acres of THIS variety on the planting (not the field total). */
  varietyAcres: number
  /** Dry bushels attributed to this variety off this planting. */
  dryBu: number
  basis: VarietyAttributionBasis
}

/**
 * Split one planting's dry bushels across its variety rows per the rules
 * above. `dryBu` is the planting's production from the shared aggregates
 * (fieldCropAggregates — combine-entry aware).
 */
export function attributeVarietyBushels(args: {
  planting: VarietyPlantingLike
  varieties: readonly VarietyRowLike[]
  dryBu: number
}): VarietyPlantingPart[] {
  const { planting: p, varieties: vs, dryBu } = args
  if (vs.length === 0) return []
  const base = {
    plantingId: p.id,
    fieldId: p.field_id,
    cropId: p.crop_id,
    seasonYear: p.season_year,
  }
  if (vs.length === 1) {
    const v = vs[0]
    const acres = Number(v.acres) > 0 ? Number(v.acres) : Number(p.planted_acres) || 0
    return [{ ...base, variety: v.variety, varietyAcres: acres, dryBu, basis: 'whole' }]
  }
  const allAllocated = vs.every((v) => v.bushels != null)
  if (allAllocated) {
    return vs.map((v) => ({
      ...base,
      variety: v.variety,
      varietyAcres: Number(v.acres) || 0,
      dryBu: Number(v.bushels) || 0,
      basis: 'allocated' as const,
    }))
  }
  // Acre-share estimate: needs recorded variety acres to have a basis.
  const totalAcres = vs.reduce((s, v) => s + (Number(v.acres) || 0), 0)
  if (!(totalAcres > 0)) return []
  return vs.map((v) => {
    const acres = Number(v.acres) || 0
    return {
      ...base,
      variety: v.variety,
      varietyAcres: acres,
      dryBu: dryBu * (acres / totalAcres),
      basis: 'acre_share' as const,
    }
  })
}

// ---------------------------------------------------------------------------
// Variety-level drill-down summary — the aggregate stat strip.
//
// A variety's bushels off a multi-variety field are a SHARE of that field's
// physical loads (the grain is commingled at the scale), so the weighted
// stats weight each field's loads by net lbs × the variety's share of the
// field's production. Single-variety fields have share 1 and reduce to the
// plain field summary.
// ---------------------------------------------------------------------------

export type VarietyFieldDetailInput = {
  part: VarietyPlantingPart
  /** The field × crop × year detail from buildDetailForPlantings. */
  fieldSummary: YieldDetailSummary
  loads: readonly YieldDetailLoad[]
}

export type VarietyDetailSummary = {
  varietyAcres: number
  /** Σ attributed dry bushels — equals the variety row, by construction. */
  dryBu: number
  yieldPerAcre: number | null
  /** Physical loads involved across the constituent fields (unscaled). */
  loadCount: number
  weightedMoisture: number | null
  weightedTestWeight: number | null
  firstLoadDate: string | null
  lastLoadDate: string | null
  toBinsPct: number | null
  toBuyersPct: number | null
}

/** The variety's share of one field's production (0..1). */
export function varietyShareOfField(part: VarietyPlantingPart, fieldSummary: YieldDetailSummary): number {
  const prod = fieldSummary.fieldProductionDryBu
  if (!(prod > 0)) return 0
  return Math.min(1, part.dryBu / prod)
}

export function summarizeVarietyDetail(rows: readonly VarietyFieldDetailInput[]): VarietyDetailSummary {
  let varietyAcres = 0
  let dryBu = 0
  let loadCount = 0
  let toBins = 0
  let toBuyers = 0
  let destTotal = 0
  let first: string | null = null
  let last: string | null = null
  const moisturePairs: Array<{ value: number | null; weight: number | null }> = []
  const testWeightPairs: Array<{ value: number | null; weight: number | null }> = []
  for (const r of rows) {
    varietyAcres += r.part.varietyAcres
    dryBu += r.part.dryBu
    loadCount += r.loads.length
    const share = varietyShareOfField(r.part, r.fieldSummary)
    for (const l of r.loads) {
      const w = l.netLbs != null ? l.netLbs * share : null
      moisturePairs.push({ value: l.moisture, weight: w })
      testWeightPairs.push({ value: l.testWeight, weight: w })
      if (l.destination === 'bin') toBins += l.dryBu * share
      else if (l.destination === 'buyer') toBuyers += l.dryBu * share
      destTotal += l.dryBu * share
      if (first == null || l.date < first) first = l.date
      if (last == null || l.date > last) last = l.date
    }
  }
  return {
    varietyAcres,
    dryBu,
    yieldPerAcre: varietyAcres > 0 ? dryBu / varietyAcres : null,
    loadCount,
    weightedMoisture: weightedAverage(moisturePairs),
    weightedTestWeight: weightedAverage(testWeightPairs),
    firstLoadDate: first,
    lastLoadDate: last,
    toBinsPct: destTotal > 0 ? (toBins / destTotal) * 100 : null,
    toBuyersPct: destTotal > 0 ? (toBuyers / destTotal) * 100 : null,
  }
}
