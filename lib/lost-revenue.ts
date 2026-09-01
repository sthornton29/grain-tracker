// Lost revenue from discounting — Ask Turnrow's buyer-discount-history
// lead measure (pure, unit-tested).
//
// Buyers discount inconsistently: some cut the PRICE (drying charges,
// test-weight docks, fees — dollars off the check), some cut the VOLUME
// (pay bushels shrunk below our FSA-standard dry bushels), some both. This
// module normalizes every mechanism to DOLLARS LOST, once each:
//
//   * price-type — settlement_discount_items rows with deduction_kind
//     'price': their dollars count directly, by category;
//   * volume-type — the settlement's pay-bushels vs FSA-standard dry
//     bushels gap (the existing reconciliation seam), valued at each line's
//     own price. Where the statement ITEMIZED weight-style deductions
//     (kind 'weight' items — shrink lbs, FM weight, dockage weight), those
//     items only tell the gap which categories to land in (pro-rata by
//     their printed amounts); their dollars are never added on top. With no
//     weight itemization the whole gap lands in 'weightDeduction'.
//
// Lead metric: lost ¢ per CONTRACTED bushel — for settlements tied to a
// contract (through their matched loads), total lost dollars ÷ the linked
// contracts' bushels, aggregated per buyer (weighted across contracts).
// Companion: lost ¢ per SETTLED bushel over every settlement; also the
// fallback for buyers with only spot/unlinked settlements.

import { categoryGroup, type CategoryGroup } from '@/lib/buyer-comparison'

/** The report's category columns: the five price groups + the volume gap. */
export type LostGroup = CategoryGroup | 'weightDeduction'

export const LOST_GROUP_ORDER: LostGroup[] = [
  'moistureDrying', 'testWeight', 'damage', 'fmDockage', 'other', 'weightDeduction',
]

export const LOST_GROUP_LABELS: Record<LostGroup, string> = {
  moistureDrying: 'Moisture / drying',
  testWeight: 'Test weight',
  damage: 'Damage',
  fmDockage: 'FM / dockage',
  other: 'Other',
  weightDeduction: 'Weight deduction',
}

export type LostRevenueItem = {
  category: string
  amount: number
  /** 'price' = dollars off the check; 'weight' = an itemized volume
   *  deduction (categorizes the reconciliation gap, never adds dollars).
   *  Absent (pre-075 rows) = 'price'. */
  deduction_kind?: string | null
}

export type LostRevenueLoad = {
  /** The line's settled (pay) bushels. */
  bu: number
  /** Our FSA-standard dry bushels for the matched load (null = unmatched
   *  or missing weights — contributes no volume gap). */
  ourDryBu: number | null
  /** The line's net $/bu. */
  pricePerBu: number | null
}

export type LostRevenueSettlement = {
  id: string
  buyerId: string
  settlementDate: string
  settlementNumber: string | null
  settledBu: number
  items: ReadonlyArray<LostRevenueItem>
  loads: ReadonlyArray<LostRevenueLoad>
  /** The contract the settlement's matched loads deliver against (mode);
   *  null = spot/unlinked. */
  contractId: string | null
}

export type ContractInfo = {
  id: string
  number: string | null
  bushels: number
}

const emptyGroups = (): Record<LostGroup, number> => ({
  moistureDrying: 0, testWeight: 0, damage: 0, fmDockage: 0, other: 0, weightDeduction: 0,
})

export type SettlementLostRevenue = {
  /** Price-item dollars (kind 'price'). */
  priceDollars: number
  /** The volume gap valued at line prices — signed (a buyer paying MORE
   *  bushels than FSA-standard reduces lost revenue). */
  volumeDollars: number
  totalDollars: number
  /** Dollars per report column: price items by category + the volume gap
   *  spread over the weight items' categories (or 'weightDeduction'). */
  byGroup: Record<LostGroup, number>
}

/** Normalize ONE settlement's discounting to lost dollars, by category. */
export function settlementLostRevenue(s: Pick<LostRevenueSettlement, 'items' | 'loads'>): SettlementLostRevenue {
  const byGroup = emptyGroups()
  let priceDollars = 0
  const weightItems: Array<{ group: CategoryGroup; weight: number }> = []
  for (const i of s.items) {
    const amount = Number(i.amount) || 0
    if (i.deduction_kind === 'weight') {
      weightItems.push({ group: categoryGroup(i.category), weight: Math.max(0, amount) })
    } else {
      priceDollars += amount
      byGroup[categoryGroup(i.category)] += amount
    }
  }
  let volumeDollars = 0
  for (const l of s.loads) {
    if (l.ourDryBu == null || l.pricePerBu == null) continue
    volumeDollars += (l.ourDryBu - l.bu) * l.pricePerBu
  }
  if (weightItems.length > 0) {
    // The statement itemized its weight deductions: those lines CATEGORIZE
    // the reconciliation gap pro-rata (equal split when no amounts printed).
    const totalWeight = weightItems.reduce((t, w) => t + w.weight, 0)
    for (const w of weightItems) {
      const share = totalWeight > 0 ? w.weight / totalWeight : 1 / weightItems.length
      byGroup[w.group] += volumeDollars * share
    }
  } else {
    byGroup.weightDeduction += volumeDollars
  }
  return { priceDollars, volumeDollars, totalDollars: priceDollars + volumeDollars, byGroup }
}

export type ContractDrill = {
  contractId: string
  contractNumber: string | null
  contractBushels: number
  lostDollars: number
  /** Lost ¢ per contracted bushel for THIS contract. */
  centsPerContractedBu: number | null
  settlements: Array<{ settlement: LostRevenueSettlement; lost: SettlementLostRevenue }>
}

export type BuyerLostRow = {
  buyerId: string
  settlements: number
  settledBu: number
  /** Σ linked contracts' contracted bushels (each contract counted once). */
  contractedBu: number
  /** Lost dollars on contract-linked settlements only. */
  linkedLostDollars: number
  totalLostDollars: number
  /** THE LEAD METRIC: linked lost ¢ ÷ contracted bushels, weighted across
   *  the buyer's contracts. Null when every settlement is spot/unlinked. */
  leadCentsPerContractedBu: number | null
  /** Companion: total lost ¢ ÷ settled bushels (every settlement). */
  centsPerSettledBu: number | null
  /** ¢ per settled bushel per report column. */
  groupCents: Record<LostGroup, number>
  /** True when the buyer has ONLY spot/unlinked settlements — the lead
   *  column falls back to the settled-bu figure, labeled. */
  spotOnly: boolean
  /** What the ranking uses: the lead metric, or the companion for
   *  spot-only buyers. */
  rankCents: number
  rank: number
  contracts: ContractDrill[]
  unlinked: Array<{ settlement: LostRevenueSettlement; lost: SettlementLostRevenue }>
}

/** One row per buyer, ranked on lost ¢ per contracted bushel (cheapest
 *  first; spot-only buyers rank on their settled-bu figure). */
export function buildLostRevenueRows(
  settlements: ReadonlyArray<LostRevenueSettlement>,
  contractsById: ReadonlyMap<string, ContractInfo>,
): BuyerLostRow[] {
  type Acc = {
    settlements: number
    settledBu: number
    totalLostDollars: number
    groupDollars: Record<LostGroup, number>
    byContract: Map<string, ContractDrill>
    unlinked: BuyerLostRow['unlinked']
  }
  const acc = new Map<string, Acc>()
  for (const s of settlements) {
    let a = acc.get(s.buyerId)
    if (!a) {
      a = { settlements: 0, settledBu: 0, totalLostDollars: 0, groupDollars: emptyGroups(), byContract: new Map(), unlinked: [] }
      acc.set(s.buyerId, a)
    }
    const lost = settlementLostRevenue(s)
    a.settlements += 1
    a.settledBu += s.settledBu
    a.totalLostDollars += lost.totalDollars
    for (const g of LOST_GROUP_ORDER) a.groupDollars[g] += lost.byGroup[g]
    const contract = s.contractId ? contractsById.get(s.contractId) : undefined
    if (contract) {
      let drill = a.byContract.get(contract.id)
      if (!drill) {
        drill = { contractId: contract.id, contractNumber: contract.number, contractBushels: contract.bushels, lostDollars: 0, centsPerContractedBu: null, settlements: [] }
        a.byContract.set(contract.id, drill)
      }
      drill.lostDollars += lost.totalDollars
      drill.settlements.push({ settlement: s, lost })
    } else {
      a.unlinked.push({ settlement: s, lost })
    }
  }

  const rows: BuyerLostRow[] = []
  for (const [buyerId, a] of acc) {
    const contracts = [...a.byContract.values()]
    for (const c of contracts) {
      c.centsPerContractedBu = c.contractBushels > 0 ? (c.lostDollars / c.contractBushels) * 100 : null
      c.settlements.sort((x, y) => x.settlement.settlementDate.localeCompare(y.settlement.settlementDate))
    }
    contracts.sort((x, y) => (y.centsPerContractedBu ?? -Infinity) - (x.centsPerContractedBu ?? -Infinity))
    const contractedBu = contracts.reduce((t, c) => t + c.contractBushels, 0)
    const linkedLostDollars = contracts.reduce((t, c) => t + c.lostDollars, 0)
    // Weighted across the buyer's contracts: Σ lost $ ÷ Σ contracted bu.
    const lead = contractedBu > 0 ? (linkedLostDollars / contractedBu) * 100 : null
    const companion = a.settledBu > 0 ? (a.totalLostDollars / a.settledBu) * 100 : null
    if (companion == null) continue // nothing settled — nothing to rank
    const groupCents = emptyGroups()
    for (const g of LOST_GROUP_ORDER) groupCents[g] = (a.groupDollars[g] / a.settledBu) * 100
    rows.push({
      buyerId,
      settlements: a.settlements,
      settledBu: a.settledBu,
      contractedBu,
      linkedLostDollars,
      totalLostDollars: a.totalLostDollars,
      leadCentsPerContractedBu: lead,
      centsPerSettledBu: companion,
      groupCents,
      spotOnly: contracts.length === 0,
      rankCents: lead ?? companion,
      rank: 0,
      contracts,
      unlinked: a.unlinked.sort((x, y) => x.settlement.settlementDate.localeCompare(y.settlement.settlementDate)),
    })
  }
  rows.sort((x, y) => x.rankCents - y.rankCents)
  rows.forEach((r, i) => { r.rank = i + 1 })
  return rows
}

/** The costliest group cell(s) in a row — what the report highlights. */
export function costliestLostGroups(row: Pick<BuyerLostRow, 'groupCents'>): LostGroup[] {
  const entries = Object.entries(row.groupCents) as Array<[LostGroup, number]>
  const max = Math.max(...entries.map(([, v]) => v))
  if (!(max > 0)) return []
  return entries.filter(([, v]) => v === max).map(([g]) => g)
}
