// Grain shrink formulas per FSA1078 (U. of Arkansas Extension).
// Given a net weight (lb) and the crop's base moisture + test weight, return
// the load's bushels wet (at measured moisture) and shrunk to base moisture.
// If actual_MC <= base_MC, dry = wet (buyers don't pay for expansion).
//
// If `dryBushelsOverride` is provided (non-null), it replaces the computed
// dry value — the user has manually entered a dry bushel figure on the load.

export type ShrinkInput = {
  netWeightLb: number | null | undefined
  moisturePct: number | null | undefined
  baseMoisturePct: number | null | undefined
  baseLbPerBushel: number | null | undefined
  dryBushelsOverride?: number | null | undefined
}

export type ShrinkResult = {
  wetBushels: number | null
  dryBushels: number | null
  computedDryBushels: number | null
  overridden: boolean
}

export function computeBushels(input: ShrinkInput): ShrinkResult {
  const net = toNum(input.netWeightLb)
  const baseLb = toNum(input.baseLbPerBushel)
  const override = toNum(input.dryBushelsOverride)
  if (net == null || baseLb == null || baseLb <= 0) {
    return {
      wetBushels: null,
      dryBushels: override,
      computedDryBushels: null,
      overridden: override != null,
    }
  }
  const wet = net / baseLb
  const mc = toNum(input.moisturePct)
  const baseMc = toNum(input.baseMoisturePct)
  let computedDry: number | null
  if (mc == null || baseMc == null) computedDry = null
  else if (mc <= baseMc) computedDry = wet
  else computedDry = (wet * (100 - mc)) / (100 - baseMc)
  return {
    wetBushels: wet,
    dryBushels: override != null ? override : computedDry,
    computedDryBushels: computedDry,
    overridden: override != null,
  }
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
