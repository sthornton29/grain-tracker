// Buyer Discount Comparison — the report's math, pure and unit-tested.
//
// Premise: within one crop and crop year the grain is broadly similar, so a
// SYSTEMATIC difference in what two buyers deduct is the buyer, not the
// grain. Two layers:
//
//   * ACTUALS — per buyer: settlements, bushels, total discount ¢/bu (from
//     the authoritative settlement_lines totals), the itemized breakdown by
//     category group, the excess-shrink ¢/bu (pay-bushels vs our
//     FSA-standard dry bushels, monetized), and the gross → net price
//     spread. Ranked by total cost per bushel (price discounts + excess
//     shrink).
//
//   * QUALITY-ADJUSTED — the honest layer: raw averages can just mean you
//     hauled wetter grain to one buyer. Using the loads' own moisture and
//     test weight (matched through settlement lines), compute the discount
//     PER UNIT OF QUALITY: drying+moisture ¢/bu per point over the crop's
//     base, test-weight ¢/bu per pound light. Each buyer's average
//     moisture/TW is shown beside the rates so the user can judge
//     comparability.
//
// The view layer assembles ComparisonSettlement records (one per settlement,
// already scoped to the crop year / crop / entity grants) and hands them
// here.

import { coerceDiscountCategory, type DiscountCategory } from '@/lib/settlement-discounts'

// The five report columns the eleven storage categories roll up into.
export type CategoryGroup = 'moistureDrying' | 'testWeight' | 'damage' | 'fmDockage' | 'other'

export const CATEGORY_GROUP_LABELS: Record<CategoryGroup, string> = {
  moistureDrying: 'Moisture / drying',
  testWeight: 'Test weight',
  damage: 'Damage',
  fmDockage: 'FM / dockage',
  other: 'Other',
}

export function categoryGroup(category: string): CategoryGroup {
  const c: DiscountCategory = coerceDiscountCategory(category)
  switch (c) {
    case 'moisture_shrink':
    case 'drying':
      return 'moistureDrying'
    case 'test_weight':
      return 'testWeight'
    case 'damage':
    case 'heat_damage':
      return 'damage'
    case 'foreign_material':
    case 'dockage':
      return 'fmDockage'
    default:
      return 'other'
  }
}

export type ComparisonLoad = {
  /** The line's settled (pay) bushels. */
  bu: number
  moisture: number | null
  testWeight: number | null
  /** Our FSA-standard dry bushels for the matched load. */
  ourDryBu: number | null
  /** The line's net $/bu (net revenue ÷ net bushels). */
  pricePerBu: number | null
}

export type ComparisonSettlement = {
  id: string
  buyerId: string
  settlementDate: string
  settlementNumber: string | null
  /** Σ line net_bushels (every line, matched or not). */
  settledBu: number
  grossRevenue: number
  /** Σ line discounts — the authoritative total. */
  discountTotal: number
  netRevenue: number
  /** Itemized discount lines ({category, amount $}); [] when not itemized. */
  items: ReadonlyArray<{ category: string; amount: number }>
  /** The settlement's MATCHED lines with their loads' quality readings. */
  loads: ReadonlyArray<ComparisonLoad>
}

export type BuyerActualsRow = {
  buyerId: string
  settlements: number
  settledBu: number
  grossRevenue: number
  netRevenue: number
  /** Total discounts ¢/bu (authoritative line totals). */
  discountCentsPerBu: number
  /** Itemized ¢/bu per category group (from settlements that itemize). */
  groupCents: Record<CategoryGroup, number>
  /** Σ itemized $ ÷ Σ discount $ — how much of the total the breakdown
   *  explains (1 = fully itemized). */
  itemizedCoverage: number
  /** Weight deduction beyond standard shrink, ¢/bu (can be negative when a
   *  buyer pays MORE bushels than the FSA formula). */
  excessShrinkCentsPerBu: number
  grossPerBu: number
  netPerBu: number
  /** discountCentsPerBu + excessShrinkCentsPerBu — what a bushel actually
   *  cost to sell to this buyer, beyond the gross price. */
  totalCostCentsPerBu: number
  /** 1 = cheapest buyer per bushel. */
  rank: number
}

const EMPTY_GROUPS = (): Record<CategoryGroup, number> => ({
  moistureDrying: 0, testWeight: 0, damage: 0, fmDockage: 0, other: 0,
})

/** One row per buyer, ranked by total cost per bushel (cheapest first). */
export function buildBuyerActuals(settlements: ReadonlyArray<ComparisonSettlement>): BuyerActualsRow[] {
  type Acc = {
    settlements: number; settledBu: number; grossRevenue: number; netRevenue: number
    discountDollars: number; itemizedDollars: number
    groupDollars: Record<CategoryGroup, number>
    excessDollars: number
  }
  const acc = new Map<string, Acc>()
  for (const s of settlements) {
    let a = acc.get(s.buyerId)
    if (!a) {
      a = {
        settlements: 0, settledBu: 0, grossRevenue: 0, netRevenue: 0,
        discountDollars: 0, itemizedDollars: 0, groupDollars: EMPTY_GROUPS(), excessDollars: 0,
      }
      acc.set(s.buyerId, a)
    }
    a.settlements += 1
    a.settledBu += s.settledBu
    a.grossRevenue += s.grossRevenue
    a.netRevenue += s.netRevenue
    a.discountDollars += s.discountTotal
    for (const i of s.items) {
      a.itemizedDollars += i.amount
      a.groupDollars[categoryGroup(i.category)] += i.amount
    }
    for (const l of s.loads) {
      if (l.ourDryBu == null || l.pricePerBu == null) continue
      a.excessDollars += (l.ourDryBu - l.bu) * l.pricePerBu
    }
  }

  const rows: BuyerActualsRow[] = []
  for (const [buyerId, a] of acc) {
    if (!(a.settledBu > 0)) continue
    const per = (dollars: number) => (dollars / a.settledBu) * 100
    const groupCents = EMPTY_GROUPS()
    for (const g of Object.keys(groupCents) as CategoryGroup[]) groupCents[g] = per(a.groupDollars[g])
    const discountCentsPerBu = per(a.discountDollars)
    const excessShrinkCentsPerBu = per(a.excessDollars)
    rows.push({
      buyerId,
      settlements: a.settlements,
      settledBu: a.settledBu,
      grossRevenue: a.grossRevenue,
      netRevenue: a.netRevenue,
      discountCentsPerBu,
      groupCents,
      itemizedCoverage: a.discountDollars !== 0 ? a.itemizedDollars / a.discountDollars : (a.itemizedDollars > 0 ? 1 : 0),
      excessShrinkCentsPerBu,
      grossPerBu: a.grossRevenue / a.settledBu,
      netPerBu: a.netRevenue / a.settledBu,
      totalCostCentsPerBu: discountCentsPerBu + excessShrinkCentsPerBu,
      rank: 0,
    })
  }
  rows.sort((x, y) => x.totalCostCentsPerBu - y.totalCostCentsPerBu)
  rows.forEach((r, i) => { r.rank = i + 1 })
  return rows
}

/** The costliest category group(s) in a row — the cells the report colors. */
export function costliestGroups(row: BuyerActualsRow): CategoryGroup[] {
  const entries = Object.entries(row.groupCents) as Array<[CategoryGroup, number]>
  const max = Math.max(...entries.map(([, v]) => v))
  if (!(max > 0)) return []
  return entries.filter(([, v]) => v === max).map(([g]) => g)
}

// ---------- quality-adjusted rates ----------

export type QualityAdjustedRow = {
  buyerId: string
  /** Bushel-weighted averages over the buyer's MATCHED loads (all of them —
   *  shown so the user can judge whether two buyers saw similar grain). */
  avgMoisture: number | null
  avgTestWeight: number | null
  /** Drying+moisture ¢/bu per POINT of moisture over the crop's base.
   *  Numerator: itemized moisture_shrink+drying dollars (settlements with
   *  itemization only). Denominator: Σ (moisture − base)⁺ × bu over those
   *  settlements' matched loads. Null when nothing to divide. */
  moistureCentsPerPoint: number | null
  /** Test-weight ¢/bu per POUND light of the crop's standard weight. */
  testWeightCentsPerLb: number | null
  /** Bushels behind the rates (matched loads of itemized settlements). */
  ratedBu: number
}

export function buildQualityAdjusted(
  settlements: ReadonlyArray<ComparisonSettlement>,
  cropBase: { baseMoisturePct: number | null; baseLbPerBushel: number | null },
): QualityAdjustedRow[] {
  type Acc = {
    allBu: number; moistureBuSum: number; moistureBu: number; twBuSum: number; twBu: number
    moistureDollars: number; moisturePointBu: number
    twDollars: number; twLbBu: number
    ratedBu: number
  }
  const acc = new Map<string, Acc>()
  const baseM = cropBase.baseMoisturePct
  const baseTw = cropBase.baseLbPerBushel
  for (const s of settlements) {
    let a = acc.get(s.buyerId)
    if (!a) {
      a = { allBu: 0, moistureBuSum: 0, moistureBu: 0, twBuSum: 0, twBu: 0, moistureDollars: 0, moisturePointBu: 0, twDollars: 0, twLbBu: 0, ratedBu: 0 }
      acc.set(s.buyerId, a)
    }
    for (const l of s.loads) {
      a.allBu += l.bu
      if (l.moisture != null) { a.moistureBuSum += l.moisture * l.bu; a.moistureBu += l.bu }
      if (l.testWeight != null) { a.twBuSum += l.testWeight * l.bu; a.twBu += l.bu }
    }
    // Rates only from settlements that itemize — otherwise there are no
    // per-factor dollars to spread over the quality deficit.
    if (s.items.length === 0) continue
    let moistureDollars = 0
    let twDollars = 0
    for (const i of s.items) {
      const g = categoryGroup(i.category)
      if (g === 'moistureDrying') moistureDollars += i.amount
      if (g === 'testWeight') twDollars += i.amount
    }
    a.moistureDollars += moistureDollars
    a.twDollars += twDollars
    for (const l of s.loads) {
      a.ratedBu += l.bu
      if (baseM != null && l.moisture != null && l.moisture > baseM) {
        a.moisturePointBu += (l.moisture - baseM) * l.bu
      }
      if (baseTw != null && l.testWeight != null && l.testWeight < baseTw) {
        a.twLbBu += (baseTw - l.testWeight) * l.bu
      }
    }
  }

  const rows: QualityAdjustedRow[] = []
  for (const [buyerId, a] of acc) {
    rows.push({
      buyerId,
      avgMoisture: a.moistureBu > 0 ? a.moistureBuSum / a.moistureBu : null,
      avgTestWeight: a.twBu > 0 ? a.twBuSum / a.twBu : null,
      moistureCentsPerPoint: a.moisturePointBu > 0 ? (a.moistureDollars * 100) / a.moisturePointBu : null,
      testWeightCentsPerLb: a.twLbBu > 0 ? (a.twDollars * 100) / a.twLbBu : null,
      ratedBu: a.ratedBu,
    })
  }
  rows.sort((x, y) => y.ratedBu - x.ratedBu)
  return rows
}

/** The like-for-like verdict sentence, when it can be said honestly: the two
 *  buyers with the most rated bushels, both carrying a per-point rate, with
 *  average moisture within a point (or TW within a pound) of each other.
 *  Returns null rather than a stretch. */
export function qualityVerdict(
  rows: ReadonlyArray<QualityAdjustedRow>,
  buyerName: (id: string) => string,
  which: 'moisture' | 'testWeight',
): string | null {
  const rated = rows.filter((r) =>
    which === 'moisture' ? r.moistureCentsPerPoint != null : r.testWeightCentsPerLb != null,
  )
  if (rated.length < 2) return null
  const [a, b] = rated
  if (which === 'moisture') {
    if (a.avgMoisture == null || b.avgMoisture == null) return null
    const similar = Math.abs(a.avgMoisture - b.avgMoisture) <= 1
    const fmt = (n: number) => n.toFixed(1)
    const tail = similar ? ' on similar grain.' : ` — but note the moisture difference (${fmt(a.avgMoisture)}% vs ${fmt(b.avgMoisture)}%).`
    return `${buyerName(a.buyerId)} charged ${a.moistureCentsPerPoint!.toFixed(1)}¢ per point of moisture; ${buyerName(b.buyerId)} charged ${b.moistureCentsPerPoint!.toFixed(1)}¢${tail}`
  }
  if (a.avgTestWeight == null || b.avgTestWeight == null) return null
  const similar = Math.abs(a.avgTestWeight - b.avgTestWeight) <= 1
  const fmt = (n: number) => n.toFixed(1)
  const tail = similar ? ' on similar grain.' : ` — but note the test-weight difference (${fmt(a.avgTestWeight)} vs ${fmt(b.avgTestWeight)} lb).`
  return `${buyerName(a.buyerId)} charged ${a.testWeightCentsPerLb!.toFixed(1)}¢ per pound light; ${buyerName(b.buyerId)} charged ${b.testWeightCentsPerLb!.toFixed(1)}¢${tail}`
}
