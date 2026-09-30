// Sold vs open-priced vs unsold for the contracts tracker's position bar —
// pure math over the contracts on screen and the crop year's expected
// production (lib/marketing expectedProductionFromBreakout, scoped through
// lib/entity-scope by the page). Unit-testable, no I/O.

import type { PricingStatus } from '@/lib/contracts'

export type PositionContract = {
  /** Contracted bushels (a seed contract's estimated quantity). */
  bushels: number
  pricingStatus: PricingStatus
  /** Seed production contracts commit acres — counted as sold/committed. */
  isSeed: boolean
}

export type ContractPosition = {
  /** Fully priced grain contracts + seed commitments. */
  soldBu: number
  /** HTA / basis contracts with one leg still open. */
  openPricedBu: number
  /** Expected production not under contract; null when production is unknown. */
  unsoldBu: number | null
  /** Contracted beyond production (sold + open > production), else 0. */
  overContractedBu: number
  productionBu: number | null
  /** Share of production under any contract, 0–100 (capped); null without production. */
  contractedPct: number | null
}

export function contractPosition(contracts: readonly PositionContract[], productionBu: number | null): ContractPosition {
  let soldBu = 0
  let openPricedBu = 0
  for (const c of contracts) {
    const bu = Number(c.bushels) || 0
    if (bu <= 0) continue
    if (c.isSeed || c.pricingStatus === 'fully_priced') soldBu += bu
    else openPricedBu += bu
  }
  const contracted = soldBu + openPricedBu
  if (productionBu == null || !Number.isFinite(productionBu) || productionBu <= 0) {
    return { soldBu, openPricedBu, unsoldBu: null, overContractedBu: 0, productionBu: null, contractedPct: null }
  }
  const unsoldBu = Math.max(0, productionBu - contracted)
  const overContractedBu = Math.max(0, contracted - productionBu)
  const contractedPct = Math.min(100, (contracted / productionBu) * 100)
  return { soldBu, openPricedBu, unsoldBu, overContractedBu, productionBu, contractedPct }
}
