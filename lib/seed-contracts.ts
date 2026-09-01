// Seed production contract math (077) — pure, no Supabase.
//
// Models the acreage-based seed grower agreement (2026 Bayer Soybean Seed
// Grower Agreement, Southern Exhibit C, is the reference shape):
//
//   - The grower commits ACRES, not bushels: committed production is whatever
//     the linked plantings produce (estimated until harvest, actual after).
//     There is no over-contract cap concept — every bushel off those fields
//     belongs to the seed company.
//   - Pricing is grower-timed: 25/50/75/100% increments elected against a
//     named local market elevator (Market price) or a standing Target order,
//     everything priced by the agreement's Selection Date.
//   - On top of the elected price sits an OUTCOME-DEPENDENT premium stack
//     (full stack if the seed is accepted, smaller if released, none if
//     rejected), with per-component applies_to ('all' | 'irrigated_only' —
//     the irrigated production premium pays on irrigated bushels only) and a
//     per-bushel cap. Premiums are ASSUMPTIONS until acceptance — the
//     expected_outcome on the details row picks which stack projections use.
//   - Payment is staged: 80% of the elected base after delivery/pricing, the
//     final 20% + premiums at final settlement (~March), storage pay monthly
//     after a start date, and a per-bushel usage/technology fee netted out.
//
// Money stays full precision here; display rounds.

import { expectedYieldForPlanting } from '@/lib/yields'
import type { ExpectedYieldAssumption } from '@/lib/yields'

export type SeedOutcome =
  | 'accepted'
  | 'released_post_harvest'
  | 'released_pre_harvest'
  | 'rejected'

export const SEED_OUTCOME_LABEL: Record<SeedOutcome, string> = {
  accepted: 'Accepted',
  released_post_harvest: 'Released after harvest',
  released_pre_harvest: 'Released before harvest',
  rejected: 'Rejected',
}

export type SeedContractDetails = {
  id: string
  contract_id: string
  production_site: string | null
  brand: string | null
  variety: string | null
  contract_acres: number
  forecast_bu_per_acre: number
  estimated_bushels: number
  local_market_elevator: string | null
  pricing_deadline: string | null
  premium_cap_per_bu: number | null
  storage_pay_per_bu_month: number | null
  storage_pay_start_date: string | null
  usage_fee_per_bu: number
  expected_outcome: SeedOutcome
  final_settlement_date: string | null
  notes: string | null
}

export type SeedContractPremium = {
  id?: string
  contract_id?: string
  outcome: SeedOutcome
  component: string
  amount_per_bu: number
  applies_to: 'all' | 'irrigated_only'
  sort_order?: number
}

export type SeedPricingElection = {
  id: string
  contract_id: string
  election_date: string
  pct_of_bushels: number
  price_per_bu: number
  method: 'market' | 'target'
  notes: string | null
}

export type SeedPaymentType =
  | 'base_80'
  | 'base_final'
  | 'premium'
  | 'storage'
  | 'usage_fee'
  | 'other'

export const SEED_PAYMENT_TYPE_LABEL: Record<SeedPaymentType, string> = {
  base_80: '80% base payment',
  base_final: 'Final base payment',
  premium: 'Premium',
  storage: 'Storage pay',
  usage_fee: 'Usage fee',
  other: 'Other',
}

export type SeedContractPayment = {
  id: string
  contract_id: string
  payment_type: SeedPaymentType
  amount: number
  payment_date: string | null
  status: 'projected' | 'received'
  notes: string | null
}

// ---------------------------------------------------------------------------
// Pricing elections

export const SEED_ELECTION_INCREMENTS = [25, 50, 75, 100] as const

/** Cumulative % of the contract bushels already priced. */
export function cumulativePricedPct(elections: Pick<SeedPricingElection, 'pct_of_bushels'>[]): number {
  return elections.reduce((s, e) => s + Number(e.pct_of_bushels || 0), 0)
}

/**
 * Validate a new election increment against what's already elected.
 * Returns a plain-English problem, or null when the election is fine.
 */
export function validateElectionPct(
  existing: Pick<SeedPricingElection, 'pct_of_bushels'>[],
  newPct: number,
): string | null {
  if (!SEED_ELECTION_INCREMENTS.includes(newPct as (typeof SEED_ELECTION_INCREMENTS)[number])) {
    return 'Elections price 25, 50, 75, or 100% of the bushels.'
  }
  const total = cumulativePricedPct(existing) + newPct
  if (total > 100) {
    const remaining = Math.max(0, 100 - cumulativePricedPct(existing))
    return remaining === 0
      ? 'This contract is already fully priced.'
      : `Only ${remaining}% of the bushels are left to price.`
  }
  return null
}

/** Pct-weighted average of the elected prices (over the elected portion only). */
export function blendedElectedPrice(
  elections: Pick<SeedPricingElection, 'pct_of_bushels' | 'price_per_bu'>[],
): number | null {
  const pct = cumulativePricedPct(elections)
  if (pct <= 0) return null
  const sum = elections.reduce((s, e) => s + Number(e.pct_of_bushels) * Number(e.price_per_bu), 0)
  return sum / pct
}

// ---------------------------------------------------------------------------
// Premium stack

/**
 * Expected premium $/bu for an outcome, weighted across irrigated/dryland
 * bushels. 'all' components pay on every bushel; 'irrigated_only' components
 * pay on the irrigated share only. The cap applies PER BUSHEL, so irrigated
 * bushels cap independently of dryland ones.
 *
 * irrigatedShare: the irrigated fraction of the committed bushels (0..1) —
 * from the linked plantings' bushel breakout when available, else acre share.
 */
export function premiumPerBu(args: {
  premiums: SeedContractPremium[]
  outcome: SeedOutcome
  irrigatedShare: number
  capPerBu: number | null
}): { weighted: number; irrigatedRate: number; drylandRate: number; capped: boolean } {
  const share = Math.min(1, Math.max(0, args.irrigatedShare))
  const rows = args.premiums.filter((p) => p.outcome === args.outcome)
  const allSum = rows
    .filter((p) => p.applies_to === 'all')
    .reduce((s, p) => s + Number(p.amount_per_bu || 0), 0)
  const irrSum = rows
    .filter((p) => p.applies_to === 'irrigated_only')
    .reduce((s, p) => s + Number(p.amount_per_bu || 0), 0)
  const cap = args.capPerBu
  const drylandRate = cap != null ? Math.min(allSum, cap) : allSum
  const irrigatedUncapped = allSum + irrSum
  const irrigatedRate = cap != null ? Math.min(irrigatedUncapped, cap) : irrigatedUncapped
  return {
    weighted: share * irrigatedRate + (1 - share) * drylandRate,
    irrigatedRate,
    drylandRate,
    capped: cap != null && (irrigatedUncapped > cap || allSum > cap),
  }
}

// ---------------------------------------------------------------------------
// Effective price walk

export type SeedPriceWalk = {
  /** Blended base of the elected increments (null when nothing elected). */
  electedPrice: number | null
  pricedPct: number
  unpricedPct: number
  /** What the unpriced share is valued at (reference + assumed basis), null when unknown. */
  unpricedPrice: number | null
  /** Blend of elected + unpriced base (null when neither side has a price). */
  blendedBase: number | null
  premium: ReturnType<typeof premiumPerBu>
  usageFeePerBu: number
  /** blendedBase + premium.weighted − usageFee (null when blendedBase is null). */
  expectedNetPerBu: number | null
  outcome: SeedOutcome
}

/**
 * The seed contract's expected net $/bu: elected/blended base + the expected
 * outcome's premium stack (irr/dry weighted, capped) − the usage fee.
 * `referencePlusBasis` prices the unpriced share (the app's proxy for the
 * local elevator quote); pass null when no reference price is known.
 */
export function effectivePriceWalk(args: {
  details: Pick<
    SeedContractDetails,
    'premium_cap_per_bu' | 'usage_fee_per_bu' | 'expected_outcome'
  >
  premiums: SeedContractPremium[]
  elections: Pick<SeedPricingElection, 'pct_of_bushels' | 'price_per_bu'>[]
  referencePlusBasis: number | null
  irrigatedShare: number
}): SeedPriceWalk {
  const pricedPct = Math.min(100, cumulativePricedPct(args.elections))
  const unpricedPct = Math.max(0, 100 - pricedPct)
  const electedPrice = blendedElectedPrice(args.elections)
  const unpricedPrice = unpricedPct > 0 ? args.referencePlusBasis : null
  let blendedBase: number | null = null
  if (pricedPct >= 100 && electedPrice != null) {
    blendedBase = electedPrice
  } else if (electedPrice != null && unpricedPrice != null) {
    blendedBase = (electedPrice * pricedPct + unpricedPrice * unpricedPct) / 100
  } else if (electedPrice != null && unpricedPct === 0) {
    blendedBase = electedPrice
  } else if (electedPrice == null && unpricedPrice != null && pricedPct === 0) {
    blendedBase = unpricedPrice
  }
  const premium = premiumPerBu({
    premiums: args.premiums,
    outcome: args.details.expected_outcome,
    irrigatedShare: args.irrigatedShare,
    capPerBu: args.details.premium_cap_per_bu,
  })
  const usageFeePerBu = Number(args.details.usage_fee_per_bu || 0)
  return {
    electedPrice,
    pricedPct,
    unpricedPct,
    unpricedPrice,
    blendedBase,
    premium,
    usageFeePerBu,
    expectedNetPerBu: blendedBase == null ? null : blendedBase + premium.weighted - usageFeePerBu,
    outcome: args.details.expected_outcome,
  }
}

// ---------------------------------------------------------------------------
// Committed production

export type SeedCommittedProduction = {
  bushels: number
  /** true once the linked plantings' harvest is complete (actuals in play). */
  actual: boolean
  /** Irrigated fraction of the committed bushels (bushel breakout, else acre share). */
  irrigatedShare: number
  /** true when no plantings are linked and the agreement estimate is used. */
  fromEstimate: boolean
}

/**
 * Committed production = the linked plantings' production: estimated until
 * harvest (expected yield × acres via the caller's production seam), actual
 * after. With no linked plantings, falls back to the agreement's estimated
 * bushels (acres × forecast) with the acre-share irrigation split.
 */
export function seedCommittedProduction(args: {
  details: Pick<SeedContractDetails, 'contract_acres' | 'forecast_bu_per_acre' | 'estimated_bushels'>
  /** Per linked planting: production + irrigated split, from the existing seams. */
  linked: Array<{
    bushels: number
    irrigatedBushels: number | null
    plantedAcres: number
    irrigatedAcres: number
    harvestComplete: boolean
  }>
  /** Acre-share fallback for the no-plantings estimate (0..1); default 0. */
  estimateIrrigatedShare?: number
}): SeedCommittedProduction {
  if (args.linked.length === 0) {
    const bushels =
      Number(args.details.estimated_bushels) ||
      Number(args.details.contract_acres) * Number(args.details.forecast_bu_per_acre)
    return {
      bushels,
      actual: false,
      irrigatedShare: Math.min(1, Math.max(0, args.estimateIrrigatedShare ?? 0)),
      fromEstimate: true,
    }
  }
  let total = 0
  let irr = 0
  let acres = 0
  let irrAcres = 0
  let hasBushelBreakout = true
  let allComplete = true
  for (const p of args.linked) {
    total += Number(p.bushels || 0)
    acres += Number(p.plantedAcres || 0)
    irrAcres += Number(p.irrigatedAcres || 0)
    if (p.irrigatedBushels == null) hasBushelBreakout = false
    else irr += Number(p.irrigatedBushels)
    if (!p.harvestComplete) allComplete = false
  }
  const irrigatedShare =
    hasBushelBreakout && total > 0
      ? Math.min(1, irr / total)
      : acres > 0
        ? Math.min(1, irrAcres / acres)
        : 0
  return { bushels: total, actual: allComplete, irrigatedShare, fromEstimate: false }
}

// ---------------------------------------------------------------------------
// Marketing position (consumed by lib/marketing.ts)

/**
 * One seed contract's marketing-relevant facts, assembled by the pages from
 * the 077 tables + the production seams. `committed.bushels` should already
 * carry any entity-attribution scaling (051 flow-down) — elections are
 * percentages, so they scale with it by construction.
 */
export type SeedCropCommitment = {
  contractId: string
  buyerName: string | null
  contractNumber: string | null
  committed: SeedCommittedProduction
  details: Pick<SeedContractDetails, 'premium_cap_per_bu' | 'usage_fee_per_bu' | 'expected_outcome'>
  premiums: SeedContractPremium[]
  elections: Pick<SeedPricingElection, 'pct_of_bushels' | 'price_per_bu'>[]
}

export type SeedMarketingPosition = {
  committedBu: number
  electedBu: number
  /** Bu-weighted base price of the elected increments (before premiums). */
  electedAvgPrice: number | null
  unpricedBu: number
  /** $/bu the unpriced committed bushels are valued at (cash proxy + premium − fee). */
  unpricedNetPerBu: number
  /** Committed-bu-weighted expected premium $/bu (per expected_outcome, capped). */
  premiumPerBu: number
  /** Committed-bu-weighted usage fee $/bu. */
  usageFeePerBu: number
  /** Full-precision dollars: elected value + unpriced valuation, premiums and
   *  usage fee netted in. Lands in the marketing row's blendedRevenue. */
  revenue: number
  buyers: string[]
  /** true while any commitment's production is still an estimate. */
  estimated: boolean
}

/** Sum of the commitments' committed bushels (needed before valuation). */
export function seedCommittedBushels(commitments: readonly SeedCropCommitment[]): number {
  return commitments.reduce((s, c) => s + Number(c.committed.bushels || 0), 0)
}

/**
 * Value the seed commitments the way the marketing engine values everything
 * else: elected increments at their elected price (locked, price-insensitive),
 * the unpriced remainder at `unpricedCashPrice` (the crop's reference futures
 * + assumed basis — the proxy for the local elevator quote), each side plus
 * the expected premium stack and minus the usage fee. Full precision.
 */
export function seedMarketingPosition(
  commitments: readonly SeedCropCommitment[],
  unpricedCashPrice: number | null,
): SeedMarketingPosition {
  let committedBu = 0
  let electedBu = 0
  let electedBaseDollars = 0
  let unpricedBu = 0
  let premW = 0
  let feeW = 0
  let revenue = 0
  const proxy = unpricedCashPrice ?? 0
  const buyers: string[] = []
  let estimated = false
  for (const c of commitments) {
    const bu = Number(c.committed.bushels || 0)
    committedBu += bu
    if (c.buyerName && !buyers.includes(c.buyerName)) buyers.push(c.buyerName)
    if (c.committed.fromEstimate || !c.committed.actual) estimated = true
    const prem = premiumPerBu({
      premiums: c.premiums,
      outcome: c.details.expected_outcome,
      irrigatedShare: c.committed.irrigatedShare,
      capPerBu: c.details.premium_cap_per_bu,
    })
    const fee = Number(c.details.usage_fee_per_bu || 0)
    premW += prem.weighted * bu
    feeW += fee * bu
    const pct = Math.min(100, cumulativePricedPct(c.elections))
    const eBu = (pct / 100) * bu
    electedBu += eBu
    let base = 0
    for (const e of c.elections) base += (Number(e.pct_of_bushels) / 100) * bu * Number(e.price_per_bu)
    electedBaseDollars += base
    const uBu = bu - eBu
    unpricedBu += uBu
    revenue += base + eBu * (prem.weighted - fee) + uBu * (proxy + prem.weighted - fee)
  }
  const premiumAvg = committedBu > 0 ? premW / committedBu : 0
  const feeAvg = committedBu > 0 ? feeW / committedBu : 0
  return {
    committedBu,
    electedBu,
    electedAvgPrice: electedBu > 0 ? electedBaseDollars / electedBu : null,
    unpricedBu,
    unpricedNetPerBu: proxy + premiumAvg - feeAvg,
    premiumPerBu: premiumAvg,
    usageFeePerBu: feeAvg,
    revenue,
    buyers,
    estimated,
  }
}

// ---------------------------------------------------------------------------
// Assembly: 077 rows + the existing production seams → SeedCropCommitment[]

export type SeedContractBundle = {
  contract: {
    id: string
    buyer_id: string | null
    crop_id: string | null
    crop_year: number | null
    entity_id: string | null
    contract_number: string
  }
  details: SeedContractDetails
  premiums: SeedContractPremium[]
  elections: SeedPricingElection[]
  payments: SeedContractPayment[]
  /** field_plantings ids from the seed_contract_plantings junction. */
  plantingIds: string[]
}

export type SeedPlantingLite = {
  id: string
  crop_id: string
  season_year: number
  field_id: string
  planted_acres: number | string | null
  irrigated_acres: number | string | null
  dryland_acres: number | string | null
  irrigated_bushels: number | string | null
  yield_breakout_entered?: boolean | null
}

/**
 * Build the per-crop seed commitments for computeMarketing from the 077
 * tables + the existing production seams: each linked planting contributes
 * its EXPECTED production (expectedYieldForPlanting × acres) until the crop's
 * harvest is complete, then its ACTUAL dry bushels from the yields aggregates
 * (`aggByKey`, the fieldCropAggregates map keyed fieldId|cropId|year).
 * `shareForContract` is the 051 attribution factor — elections are
 * percentages, so scaling the bushels scales everything.
 */
export function buildSeedCommitments(args: {
  bundles: SeedContractBundle[]
  cropYear: number
  plantings: readonly SeedPlantingLite[]
  aggByKey: Map<string, { dryBu: number; irrBu?: number }>
  assumptions: readonly ExpectedYieldAssumption[]
  harvestCompleteCropIds: ReadonlySet<string>
  buyerNameById: Map<string, string>
  shareForContract?: (c: { entity_id: string | null; crop_id: string | null; crop_year: number | null }) => number
}): Map<string, SeedCropCommitment[]> {
  const plantingById = new Map(args.plantings.map((p) => [p.id, p]))
  const out = new Map<string, SeedCropCommitment[]>()
  for (const b of args.bundles) {
    const cropId = b.contract.crop_id
    if (cropId == null || b.contract.crop_year !== args.cropYear) continue
    const share = args.shareForContract
      ? args.shareForContract({ entity_id: b.contract.entity_id, crop_id: cropId, crop_year: b.contract.crop_year })
      : 1
    if (share <= 0) continue
    const assumption = args.assumptions.find((a) => a.crop_id === cropId && a.crop_year === args.cropYear) ?? null
    const harvestComplete = args.harvestCompleteCropIds.has(cropId)
    const linked: Parameters<typeof seedCommittedProduction>[0]['linked'] = []
    for (const pid of b.plantingIds) {
      const p = plantingById.get(pid)
      if (!p || p.crop_id !== cropId || p.season_year !== args.cropYear) continue
      const agg = args.aggByKey.get(`${p.field_id}|${cropId}|${args.cropYear}`)
      const actualBu = agg?.dryBu ?? 0
      if (harvestComplete && actualBu > 0) {
        linked.push({
          bushels: actualBu,
          irrigatedBushels:
            p.yield_breakout_entered && p.irrigated_bushels != null
              ? Number(p.irrigated_bushels)
              : agg?.irrBu ?? null,
          plantedAcres: Number(p.planted_acres ?? 0),
          irrigatedAcres: Number(p.irrigated_acres ?? 0),
          harvestComplete: true,
        })
      } else {
        const y = expectedYieldForPlanting(assumption, p)
        linked.push({
          bushels: (y ?? 0) * Number(p.planted_acres ?? 0),
          irrigatedBushels: null,
          plantedAcres: Number(p.planted_acres ?? 0),
          irrigatedAcres: Number(p.irrigated_acres ?? 0),
          harvestComplete: false,
        })
      }
    }
    const committedRaw = seedCommittedProduction({ details: b.details, linked })
    const committed: SeedCommittedProduction =
      share === 1 ? committedRaw : { ...committedRaw, bushels: committedRaw.bushels * share }
    const commitment: SeedCropCommitment = {
      contractId: b.contract.id,
      buyerName: b.contract.buyer_id != null ? args.buyerNameById.get(b.contract.buyer_id) ?? null : null,
      contractNumber: b.contract.contract_number,
      committed,
      details: b.details,
      premiums: b.premiums,
      elections: b.elections,
    }
    const arr = out.get(cropId)
    if (arr) arr.push(commitment)
    else out.set(cropId, [commitment])
  }
  return out
}

// ---------------------------------------------------------------------------
// Cash-flow staging

export type SeedCashFlowEvent = {
  /** YYYY-MM month bucket. */
  month: string
  amount: number
  type: SeedPaymentType
  label: string
  status: 'projected' | 'received'
}

function monthOf(dateIso: string): string {
  return dateIso.slice(0, 7)
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Default final settlement: March 15 following the crop year's harvest. */
export function defaultFinalSettlementDate(cropYear: number): string {
  return `${cropYear + 1}-03-15`
}

/**
 * Project the staged payments as dated cash-flow events:
 *   - 80% of each elected increment's base value in the election's month
 *     (the agreement pays the 80% after delivery + pricing);
 *   - unpriced bushels assumed elected at the pricing deadline (valued at the
 *     walk's unpriced price) — 80% lands there;
 *   - the final 20% of the base + the expected premiums at the final
 *     settlement date (default ~March after harvest);
 *   - storage pay monthly from the start date through final settlement;
 *   - the usage fee as an outflow at final settlement.
 * Received rows from the payments ledger REPLACE the projection for their
 * type (actuals-replace-projections, the cotton fees convention); projected
 * ledger rows also replace, letting the user pin dates/amounts by hand.
 */
export function seedCashFlowEvents(args: {
  details: SeedContractDetails
  premiums: SeedContractPremium[]
  elections: SeedPricingElection[]
  payments: SeedContractPayment[]
  committed: SeedCommittedProduction
  referencePlusBasis: number | null
  cropYear: number
  contractLabel: string
}): SeedCashFlowEvent[] {
  const { details, committed } = args
  const bu = committed.bushels
  const label = args.contractLabel
  const settleDate = details.final_settlement_date || defaultFinalSettlementDate(args.cropYear)
  const settleMonth = monthOf(settleDate)
  const walk = effectivePriceWalk({
    details,
    premiums: args.premiums,
    elections: args.elections,
    referencePlusBasis: args.referencePlusBasis,
    irrigatedShare: committed.irrigatedShare,
  })

  // Ledger rows win their type slot outright.
  const ledgerTypes = new Set(args.payments.map((p) => p.payment_type))
  const events: SeedCashFlowEvent[] = args.payments
    .filter((p) => p.payment_date != null)
    .map((p) => ({
      month: monthOf(p.payment_date as string),
      amount: Number(p.amount),
      type: p.payment_type,
      label: `${label} — ${SEED_PAYMENT_TYPE_LABEL[p.payment_type]}`,
      status: p.status,
    }))

  if (!ledgerTypes.has('base_80')) {
    for (const e of args.elections) {
      const portion = (Number(e.pct_of_bushels) / 100) * bu
      events.push({
        month: monthOf(e.election_date),
        amount: 0.8 * portion * Number(e.price_per_bu),
        type: 'base_80',
        label: `${label} — 80% base (${e.pct_of_bushels}% at $${Number(e.price_per_bu).toFixed(2)})`,
        status: 'projected',
      })
    }
    if (walk.unpricedPct > 0 && walk.unpricedPrice != null && details.pricing_deadline) {
      const portion = (walk.unpricedPct / 100) * bu
      events.push({
        month: monthOf(details.pricing_deadline),
        amount: 0.8 * portion * walk.unpricedPrice,
        type: 'base_80',
        label: `${label} — 80% base (unpriced ${walk.unpricedPct}%, seed est.)`,
        status: 'projected',
      })
    }
  }

  if (!ledgerTypes.has('base_final') && walk.blendedBase != null) {
    events.push({
      month: settleMonth,
      amount: 0.2 * bu * walk.blendedBase,
      type: 'base_final',
      label: `${label} — final 20% base`,
      status: 'projected',
    })
  }

  if (!ledgerTypes.has('premium') && walk.premium.weighted > 0) {
    events.push({
      month: settleMonth,
      amount: bu * walk.premium.weighted,
      type: 'premium',
      label: `${label} — premiums (${SEED_OUTCOME_LABEL[walk.outcome].toLowerCase()}, assumed)`,
      status: 'projected',
    })
  }

  if (
    !ledgerTypes.has('storage') &&
    details.storage_pay_per_bu_month != null &&
    details.storage_pay_per_bu_month > 0 &&
    details.storage_pay_start_date
  ) {
    let m = monthOf(details.storage_pay_start_date)
    // Monthly through final settlement (inclusive start, stop at settlement).
    let guard = 0
    while (m <= settleMonth && guard < 24) {
      events.push({
        month: m,
        amount: bu * Number(details.storage_pay_per_bu_month),
        type: 'storage',
        label: `${label} — storage pay`,
        status: 'projected',
      })
      m = addMonths(m, 1)
      guard++
    }
  }

  if (!ledgerTypes.has('usage_fee') && Number(details.usage_fee_per_bu) > 0) {
    events.push({
      month: settleMonth,
      amount: -(bu * Number(details.usage_fee_per_bu)),
      type: 'usage_fee',
      label: `${label} — usage fee`,
      status: 'projected',
    })
  }

  return events
}

// ---------------------------------------------------------------------------
// Tracker progress

export type SeedTrackerProgress = {
  pricedPct: number
  productionLabel: string
  /** Complete when the final base payment has been received. */
  completed: boolean
}

export function seedTrackerProgress(args: {
  elections: Pick<SeedPricingElection, 'pct_of_bushels'>[]
  payments: Pick<SeedContractPayment, 'payment_type' | 'status'>[]
  committed: SeedCommittedProduction
}): SeedTrackerProgress {
  const pricedPct = Math.min(100, cumulativePricedPct(args.elections))
  const completed = args.payments.some(
    (p) => p.payment_type === 'base_final' && p.status === 'received',
  )
  const productionLabel = args.committed.fromEstimate
    ? 'contract estimate'
    : args.committed.actual
      ? 'actual (harvested)'
      : 'estimated'
  return { pricedPct, productionLabel, completed }
}
