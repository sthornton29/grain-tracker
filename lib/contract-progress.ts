// Contract fill progress on the load form — the pure math behind the
// delivered/remaining tracker and the over-delivery notice.
//
// THE STALENESS RULE: the delivered total must always be recomputed from the
// full set of saved loads on the contract — including loads saved earlier in
// the SAME Save & New session. The form refetches after every successful save
// (and on every contract switch) and runs the rows through
// contractDeliveredTotals, so the displayed remaining never trails the
// session and the "over by" notice fires on the load that actually crosses
// the line, not one load late.

import { computeBushels } from './shrink'

export type ContractProgressLoad = {
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
}

export type CropBases = {
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
}

/** Sum the dry bushels delivered across a contract's saved loads. */
export function contractDeliveredTotals(
  rows: ContractProgressLoad[],
  cropById: Map<string, CropBases>,
): { dryBu: number; count: number } {
  let dryBu = 0
  let count = 0
  for (const l of rows) {
    const crop = l.crop_id ? cropById.get(l.crop_id) ?? null : null
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (dryBushels) {
      dryBu += dryBushels
      count++
    }
  }
  return { dryBu, count }
}

/**
 * The tracker's display numbers: delivered so far + the (unsaved) load being
 * entered vs the contracted total. remainingBu < 0 is the over-delivery
 * state — with deliveredBu refetched after each save, it flips on exactly
 * the load whose bushels cross the contracted total.
 */
export function contractProgress(args: {
  contractedBu: number
  deliveredBu: number
  thisLoadBu: number
}): {
  projectedBu: number
  remainingBu: number
  pctDelivered: number
  pctThisLoad: number
} {
  const { contractedBu, deliveredBu, thisLoadBu } = args
  const projectedBu = deliveredBu + thisLoadBu
  const remainingBu = contractedBu - projectedBu
  const pctDelivered = contractedBu > 0 ? Math.min(100, (deliveredBu / contractedBu) * 100) : 0
  const pctThisLoad =
    contractedBu > 0 ? Math.max(0, Math.min(100 - pctDelivered, (thisLoadBu / contractedBu) * 100)) : 0
  return { projectedBu, remainingBu, pctDelivered, pctThisLoad }
}
