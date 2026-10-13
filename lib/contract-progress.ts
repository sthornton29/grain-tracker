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
import { deliveredBushelsByContract, type LoadSale, type SaleLoad } from './load-sales'

export type ContractProgressLoad = {
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
}

/** A saved load as the per-contract tracker reads it after 094: its weights
 *  plus the identity/mirror the sale seam allocates by. */
export type ContractProgressSaleLoad = ContractProgressLoad & {
  id: string
  contract_id?: string | null
  to_type?: 'bin' | 'buyer' | null
}

/** One load's dry bushels under its crop's bases (null when not computable). */
export function loadDryBushels(l: ContractProgressLoad, cropById: Map<string, CropBases>): number | null {
  const crop = l.crop_id ? cropById.get(l.crop_id) ?? null : null
  return computeBushels({
    netWeightLb: l.net_weight,
    moisturePct: l.moisture,
    baseMoisturePct: crop?.base_moisture_pct ?? null,
    baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: l.dry_bushels_override,
  }).dryBushels
}

/**
 * Delivered dry bushels PER CONTRACT from loads + their sale rows (094):
 * each load's dry bushels are computed here, then lib/load-sales allocates
 * them — a split load counts only its contract share, a load with no rows
 * but a contract_id (pre-094) counts in full. The SAME staleness rule as
 * contractDeliveredTotals applies: callers refetch after every save.
 */
export function deliveredTotalsByContract(
  rows: ReadonlyArray<ContractProgressSaleLoad>,
  sales: ReadonlyArray<LoadSale>,
  cropById: Map<string, CropBases>,
): Map<string, { dryBu: number; count: number }> {
  const saleLoads: SaleLoad[] = []
  for (const l of rows) {
    const dryBu = loadDryBushels(l, cropById)
    if (!dryBu) continue
    saleLoads.push({ id: l.id, contract_id: l.contract_id ?? null, to_type: l.to_type ?? null, dryBu })
  }
  const out = new Map<string, { dryBu: number; count: number }>()
  for (const [contractId, d] of deliveredBushelsByContract(saleLoads, sales)) out.set(contractId, { dryBu: d.dryBu, count: d.count })
  return out
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
