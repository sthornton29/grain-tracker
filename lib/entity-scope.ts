// Shared entity scoping for the financial reports — the ONE interpretation of
// "entity selected" (Season Summary, Marketing, Revenue Projections, Income
// Sensitivity, Cash Flow), so the pages can't diverge and the Revenue-
// Projections − Marketing reconciliation identity survives filtering.
//
// What narrows to the entity:
//   * acreage / plantings / production — fields on farms with farms.entity_id =
//     the selected entity (and their loads/yields, via the field-keyed
//     aggregates);
//   * crop insurance policies — rows whose OWN entity_id matches (policies are
//     genuinely carried per entity);
//   * contracts / futures / options — via attribution() below. In this
//     operation the MARKETING AGENT entity (the org's marketing entity, entities.entity_role =
//     'marketing_agent', 051) holds the contracts and the hedge account and
//     markets on behalf of the farming entities; the income then shifts down.
//     So a row held by a marketing agent — or carrying no entity at all — is
//     marketing FOR the operation: under an entity filter it attributes
//     pro-rata by the entity's share of that crop's planted acres for the
//     contract's crop year (same bushel prices — only the bushels and realized
//     hedge P&L scale). A row keyed to a FARMING entity is own-name marketing
//     and counts wholly toward that entity. Dropping agent/null rows (the old
//     strict rule) zeroed out every filtered entity's sales while production
//     stayed — huge false losses;
//   * government payments — ARC/PLC by the farm's entity; other USDA payments
//     by their farm's entity when farm-linked, else their own entity_id (the
//     Payment Tracker's attribution).
//
// What does NOT narrow: the operation-wide assumptions (per-category yields &
// costs, assumed basis/futures). Those are entered once for the whole operation
// and flow down unchanged — the scope only narrows the acres/production/
// policies/payments they are applied to. There is no per-entity assumption
// store and none should be created.
//
// With entityId === '' (All entities) every filter is the identity function, so
// the unfiltered numbers are structurally guaranteed to match today's.
//
// VIEWER GRANTS (052): pass grantedEntityIds (the viewer's user_entity_access
// set) and the scope's universe shrinks to those entities. '' then means "all
// MY entities combined" (the grants' union — still active filtering, never the
// whole operation), a granted entityId narrows to it, and a NON-granted
// entityId (URL/localStorage manipulation) falls back to the union — it can
// never widen the scope. Owners simply don't pass grants and nothing changes.

import { cropToHedgeCommodity } from '@/lib/contracts'
import { buildCottonPhysicalSummary, type CottonPhysicalInputs, type CottonPhysicalSummary, type DispositionBoard } from '@/lib/cotton-sales'

// Attribution of marketing positions (contracts / futures / options) to an
// entity. Built from the plantings + crops the caller already has:
//   * a row keyed to a FARMING entity that matches the scope counts WHOLE
//     (own-name marketing); keyed to a different farming entity, it drops;
//   * a row held by a MARKETING-AGENT entity (entity_role='marketing_agent',
//     one that markets for the farming entities and shifts the income
//     down) — or carrying no entity at all — scales by the entity's share of
//     the crop's (or hedge commodity's) planted acres for that crop year:
//     prices per bushel are untouched, so the entity view shows the same avg
//     price / buildup as the all-entities report, and the per-entity bushels
//     and realized hedge P&L sum back to the operation total. (Filtering to
//     the agent itself shows only its own farmed acres' share — normally none:
//     the income has been shifted down.)
// With no active filter every method is an exact pass-through.
export type EntityAttribution = {
  /** Entity share (0..1) of a crop's planted acres for a crop year. */
  shareForCrop(cropId: string | null, cropYear: number | null): number
  /** Same, aggregated across the crops that hedge in this commodity. */
  shareForCommodity(commodity: string | null, cropYear: number | null): number
  /** The factor a contract's bushels/dollars carry under this filter:
   *  1 (own entity or unfiltered), 0 (other entity / no acreage), or the
   *  pro-rata acre share (operation-level row). */
  shareForContract(c: { entity_id: string | null; crop_id: string | null; crop_year: number | null }): number
  contracts<T extends { entity_id: string | null; crop_id: string | null; crop_year: number | null; contracted_bushels: number | string }>(rows: readonly T[]): T[]
  futures<T extends { entity_id: string | null; commodity: string; crop_year: number; num_contracts: number; realized_pnl: number | null; commission: number }>(rows: readonly T[]): T[]
  options<T extends { entity_id: string | null; commodity: string; crop_year: number; num_contracts: number; realized_pnl: number | null; premium_total: number }>(rows: readonly T[]): T[]
  /** Physical-cotton marketing rows (044) partitioned for this entity:
   *  `own` = rows keyed to the entity (own-name marketing, count whole);
   *  `flow` = marketing-agent-held and null-entity rows, which flow down at
   *  `flowShare` (the entity's share of the cotton acres). Pool payments and
   *  loan-bale links follow their contract/loan; bales/dispositions ride along
   *  in both groups (contract lbs resolve through them). Unfiltered: own is
   *  empty, flow is everything at share 1. */
  cottonPartition(inputs: CottonPhysicalInputs): {
    own: CottonPhysicalInputs; flow: CottonPhysicalInputs; flowShare: number; hasData: boolean
  }
  /** The entity's physical-cotton summary: own-name rows whole + the
   *  agent/null rows' summary scaled by the acre share, merged (¢/lb prices
   *  untouched; lbs and dollars scale). Held bales are unallocated production
   *  and always attribute by the acre share. Null when no marketing data
   *  survives the filter. */
  cottonSummary(inputs: CottonPhysicalInputs): CottonPhysicalSummary | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

function scaleBoard(b: DispositionBoard, f: number): DispositionBoard {
  if (f === 1) return b
  const byDisposition = {} as DispositionBoard['byDisposition']
  for (const key of Object.keys(b.byDisposition) as Array<keyof DispositionBoard['byDisposition']>) {
    const v = b.byDisposition[key]
    byDisposition[key] = { bales: v.bales * f, lbs: v.lbs * f }
  }
  return { byDisposition, totalBales: b.totalBales * f, totalLbs: b.totalLbs * f }
}

// Scale a summary's lbs/dollar magnitudes by the entity's share; ¢/lb price
// fields are per-unit and stay put (loanFloorCents is banked ÷ lbs — invariant).
function scaleCottonSummary(s: CottonPhysicalSummary, f: number): CottonPhysicalSummary {
  if (f === 1) return s
  return {
    ...s,
    soldLbs: r2(s.soldLbs * f),
    soldDollars: r2(s.soldDollars * f),
    soldSources: s.soldSources.map((x) => ({ ...x, lbs: r2(x.lbs * f) })),
    awaitingCallLbs: r2(s.awaitingCallLbs * f),
    poolLbs: r2(s.poolLbs * f),
    poolReceivedDollars: r2(s.poolReceivedDollars * f),
    inLoanLbs: r2(s.inLoanLbs * f),
    loanBankedDollars: r2(s.loanBankedDollars * f),
    heldLbs: r2(s.heldLbs * f),
    programDollars: r2(s.programDollars * f),
    feeDollars: r2(s.feeDollars * f),
    board: scaleBoard(s.board, f),
  }
}

// Merge an own-name summary with the (already-scaled) flow-down summary.
// Additive fields add; loanFloorCents re-derives from the combined loan
// position; poolEstCents blends lbs-weighted when both sides carry one.
function mergeCottonSummaries(a: CottonPhysicalSummary, b: CottonPhysicalSummary): CottonPhysicalSummary {
  const inLoanLbs = r2(a.inLoanLbs + b.inLoanLbs)
  const loanBankedDollars = r2(a.loanBankedDollars + b.loanBankedDollars)
  const poolEstCents = a.poolEstCents != null && b.poolEstCents != null
    ? (a.poolLbs + b.poolLbs > 0
      ? r2((a.poolEstCents * a.poolLbs + b.poolEstCents * b.poolLbs) / (a.poolLbs + b.poolLbs))
      : a.poolEstCents)
    : a.poolEstCents ?? b.poolEstCents
  return {
    soldLbs: r2(a.soldLbs + b.soldLbs),
    soldDollars: r2(a.soldDollars + b.soldDollars),
    soldSources: [...a.soldSources, ...b.soldSources],
    awaitingCallLbs: r2(a.awaitingCallLbs + b.awaitingCallLbs),
    poolLbs: r2(a.poolLbs + b.poolLbs),
    poolReceivedDollars: r2(a.poolReceivedDollars + b.poolReceivedDollars),
    poolEstCents,
    inLoanLbs,
    loanBankedDollars,
    loanFloorCents: inLoanLbs > 0 ? r2((loanBankedDollars * 100) / inLoanLbs) : null,
    heldLbs: b.heldLbs, // held bales attribute by acre share — the flow side's
    board: b.board,     // (both sides see the same bales; adding would double-count)
    programDollars: r2(a.programDollars + b.programDollars),
    programLabel: [a.programLabel, b.programLabel].filter((l, i, arr) => l && arr.indexOf(l) === i).join(' + ') || 'LDP/MLG',
    feeDollars: r2(a.feeDollars + b.feeDollars),
  }
}

export type EntityScope = {
  entityId: string
  /** False for '' (All entities) — every method is then a pass-through.
   *  With viewer grants the scope is ALWAYS active ('' = union of grants). */
  active: boolean
  /** The entity ids this scope actually selects; null when inactive.
   *  A single id for a normal filter, the whole grant set for a viewer's
   *  "all my entities". */
  selectedEntityIds: ReadonlySet<string> | null
  /** Fields on the entity's farms; null when inactive (= no field filter). */
  fieldIds: ReadonlySet<string> | null
  /** The entity's farms; null when inactive. */
  farmIds: ReadonlySet<string> | null
  /** Field-keyed rows (plantings, load splits): keep the entity's fields. */
  plantings<T extends { field_id: string }>(rows: readonly T[]): T[]
  /** Strictly entity-keyed rows (insurance policies): own entity_id match.
   *  NOT for contracts/futures/options or cotton marketing rows — those are
   *  often agent-held or operation-level and go through attribution(). */
  byEntity<T extends { entity_id: string | null }>(rows: readonly T[]): T[]
  /** Marketing-position attribution (contracts / futures / options) — see
   *  EntityAttribution. Pass the SAME plantings/crops the report computes
   *  acreage from, so shares line up with the acres on screen. */
  attribution(args: {
    plantings: ReadonlyArray<{ field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null }>
    crops: ReadonlyArray<{ id: string; name: string }>
  }): EntityAttribution
  /** Farm-keyed rows (base acres, elections, stored ARC/PLC payments). */
  byFarm<T extends { farm_id: string }>(rows: readonly T[]): T[]
  /** True when the farm belongs to the entity (projected-payment filtering). */
  farmInEntity(farmId: string | null | undefined): boolean
  /** Other USDA payments: farm's entity when farm-linked, else entity_id. */
  otherPayments<T extends { entity_id: string | null; farm_id: string | null }>(rows: readonly T[]): T[]
  /** Filter a `${fieldId}|…`-keyed aggregate map (fieldCropAggregates output)
   *  down to the entity's fields. */
  fieldAgg<V>(agg: ReadonlyMap<string, V>): Map<string, V>
  /** Gin receipts: own entity_id, else farm's entity, else field→farm entity. */
  ginReceipts<T extends { entity_id: string | null; farm_id: string | null; field_id: string | null }>(rows: readonly T[]): T[]
}

export function buildEntityScope(args: {
  entityId: string
  farms: ReadonlyArray<{ id: string; entity_id: string | null }>
  fields?: ReadonlyArray<{ id: string; farm_id: string | null }>
  /** Pass the entities list so marketing-agent rows (entity_role, 051) flow
   *  down through attribution(). Optional — without it only null-entity rows
   *  are treated as operation-level. */
  entities?: ReadonlyArray<{ id: string; entity_role?: string | null }>
  /** The viewer's granted entities (user_entity_access, 052). When present
   *  and non-empty, the scope can never reach outside them — see the header. */
  grantedEntityIds?: ReadonlyArray<string> | ReadonlySet<string> | null
}): EntityScope {
  const { entityId, farms, fields = [], entities = [] } = args
  // FAIL CLOSED: any non-null grant list — even an empty one — means "this
  // user is grant-restricted". An empty set then selects NOTHING (a viewer
  // with zero grants sees zero rows), never everything. Only null/undefined
  // (owners) leaves the scope unrestricted.
  const grants = args.grantedEntityIds != null ? new Set(args.grantedEntityIds) : null
  // The entity ids this scope selects: a granted (or plain, for owners)
  // single entity, or — for a viewer with no/foreign selection — the union
  // of the grants. Null = no filtering at all (owners' "All entities").
  const selected: ReadonlySet<string> | null = grants
    ? (entityId !== '' && grants.has(entityId) ? new Set([entityId]) : grants)
    : (entityId !== '' ? new Set([entityId]) : null)
  const active = selected != null
  const agentIds = new Set(entities.filter((e) => e.entity_role === 'marketing_agent').map((e) => e.id))

  const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
  const farmIds = active
    ? new Set(farms.filter((f) => f.entity_id != null && selected!.has(f.entity_id)).map((f) => f.id))
    : null
  const fieldIds = active
    ? new Set(fields.filter((f) => f.farm_id != null && farmIds!.has(f.farm_id)).map((f) => f.id))
    : null

  const farmInEntity = (farmId: string | null | undefined): boolean =>
    !active || (farmId != null && farmIds!.has(farmId))

  function attribution(args: {
    plantings: ReadonlyArray<{ field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null }>
    crops: ReadonlyArray<{ id: string; name: string }>
  }): EntityAttribution {
    // Acres per crop|year and commodity|year — total vs on the entity's fields.
    const totalByCrop = new Map<string, number>()
    const mineByCrop = new Map<string, number>()
    const totalByCommodity = new Map<string, number>()
    const mineByCommodity = new Map<string, number>()
    if (active) {
      const commodityByCrop = new Map(args.crops.map((c) => [c.id, cropToHedgeCommodity(c.name)]))
      for (const p of args.plantings) {
        const acres = Number(p.planted_acres ?? 0) || 0
        if (acres <= 0) continue
        const cropKey = `${p.crop_id}|${p.season_year}`
        totalByCrop.set(cropKey, (totalByCrop.get(cropKey) ?? 0) + acres)
        const commodity = commodityByCrop.get(p.crop_id)
        const commodityKey = commodity ? `${commodity}|${p.season_year}` : null
        if (commodityKey) totalByCommodity.set(commodityKey, (totalByCommodity.get(commodityKey) ?? 0) + acres)
        if (fieldIds!.has(p.field_id)) {
          mineByCrop.set(cropKey, (mineByCrop.get(cropKey) ?? 0) + acres)
          if (commodityKey) mineByCommodity.set(commodityKey, (mineByCommodity.get(commodityKey) ?? 0) + acres)
        }
      }
    }
    const shareOf = (mine: Map<string, number>, total: Map<string, number>, key: string | null): number => {
      if (!active) return 1
      if (key == null) return 0
      const t = total.get(key) ?? 0
      return t > 0 ? (mine.get(key) ?? 0) / t : 0
    }
    const shareForCrop = (cropId: string | null, cropYear: number | null) =>
      shareOf(mineByCrop, totalByCrop, cropId != null && cropYear != null ? `${cropId}|${cropYear}` : null)
    const shareForCommodity = (commodity: string | null, cropYear: number | null) =>
      shareOf(mineByCommodity, totalByCommodity, commodity != null && cropYear != null ? `${commodity}|${cropYear}` : null)
    // Farming-entity-keyed rows (own-name marketing): whole for a selected
    // entity, gone for another's. Marketing-agent-held and null-entity rows
    // market FOR the operation: the pro-rata acre share.
    const factor = (rowEntity: string | null, share: () => number): number => {
      if (!active) return 1
      if (rowEntity == null || agentIds.has(rowEntity)) return share()
      return selected!.has(rowEntity) ? 1 : 0
    }
    // ---- Physical cotton (044): own-name rows whole, agent/null rows at the
    //      cotton acre share. See cottonPartition/cottonSummary on the type. ----
    const cottonPartition = (inputs: CottonPhysicalInputs) => {
      const sub = (
        contracts: CottonPhysicalInputs['contracts'],
        loans: CottonPhysicalInputs['loans'],
        ldps: CottonPhysicalInputs['ldps'],
        fees: CottonPhysicalInputs['fees'],
      ): CottonPhysicalInputs => {
        const contractIds = new Set(contracts.map((x) => x.id))
        const loanIds = new Set(loans.map((x) => x.id))
        return {
          ...inputs, contracts, loans, ldps, fees,
          poolPayments: inputs.poolPayments.filter((p) => contractIds.has(p.contract_id)),
          loanBales: inputs.loanBales.filter((lb) => loanIds.has(lb.loan_id)),
        }
      }
      const countRows = (i: CottonPhysicalInputs) => i.contracts.length + i.loans.length + i.ldps.length + i.fees.length
      if (!active) {
        const flow = sub(inputs.contracts, inputs.loans, inputs.ldps, inputs.fees)
        return { own: sub([], [], [], []), flow, flowShare: 1, hasData: countRows(flow) > 0 }
      }
      const split = <T extends { entity_id: string | null }>(rows: readonly T[]) => {
        const own: T[] = [], flow: T[] = []
        for (const r of rows) {
          if (r.entity_id == null || agentIds.has(r.entity_id)) flow.push(r)
          else if (selected!.has(r.entity_id)) own.push(r)
        }
        return { own, flow }
      }
      const c = split(inputs.contracts), l = split(inputs.loans), d = split(inputs.ldps), f = split(inputs.fees)
      const flowShare = shareForCommodity('Cotton', inputs.cropYear)
      const own = sub(c.own, l.own, d.own, f.own)
      const flow = sub(c.flow, l.flow, d.flow, f.flow)
      return { own, flow, flowShare, hasData: countRows(own) > 0 || (flowShare > 0 && countRows(flow) > 0) }
    }
    const cottonSummary = (inputs: CottonPhysicalInputs): CottonPhysicalSummary | null => {
      const { own, flow, flowShare, hasData } = cottonPartition(inputs)
      if (!hasData) return null
      const countRows = (i: CottonPhysicalInputs) => i.contracts.length + i.loans.length + i.ldps.length + i.fees.length
      const flowSummary = flowShare > 0 && countRows(flow) > 0
        ? scaleCottonSummary(buildCottonPhysicalSummary(flow), flowShare)
        : null
      const ownSummary = countRows(own) > 0 ? buildCottonPhysicalSummary(own) : null
      if (ownSummary && flowSummary) return mergeCottonSummaries(ownSummary, flowSummary)
      if (flowSummary) return flowSummary
      // Own-name only: marketing rows count whole, but held bales are
      // unallocated PRODUCTION — they still attribute by the acre share.
      const share = active ? shareForCommodity('Cotton', inputs.cropYear) : 1
      return { ...ownSummary!, heldLbs: r2(ownSummary!.heldLbs * share), board: scaleBoard(ownSummary!.board, share) }
    }

    return {
      shareForCrop,
      shareForCommodity,
      shareForContract: (c) => factor(c.entity_id, () => shareForCrop(c.crop_id, c.crop_year)),
      cottonPartition,
      cottonSummary,
      contracts: (rows) => {
        if (!active) return [...rows]
        const out: typeof rows[number][] = []
        for (const c of rows) {
          const f = factor(c.entity_id, () => shareForCrop(c.crop_id, c.crop_year))
          if (f <= 0) continue
          out.push(f === 1 ? c : { ...c, contracted_bushels: Number(c.contracted_bushels ?? 0) * f })
        }
        return out
      },
      futures: (rows) => {
        if (!active) return [...rows]
        const out: typeof rows[number][] = []
        for (const p of rows) {
          const f = factor(p.entity_id, () => shareForCommodity(p.commodity, p.crop_year))
          if (f <= 0) continue
          out.push(f === 1 ? p : {
            ...p,
            num_contracts: Number(p.num_contracts) * f,
            realized_pnl: p.realized_pnl != null ? Number(p.realized_pnl) * f : null,
            commission: Number(p.commission ?? 0) * f,
          })
        }
        return out
      },
      options: (rows) => {
        if (!active) return [...rows]
        const out: typeof rows[number][] = []
        for (const o of rows) {
          const f = factor(o.entity_id, () => shareForCommodity(o.commodity, o.crop_year))
          if (f <= 0) continue
          out.push(f === 1 ? o : {
            ...o,
            num_contracts: Number(o.num_contracts) * f,
            realized_pnl: o.realized_pnl != null ? Number(o.realized_pnl) * f : null,
            premium_total: Number(o.premium_total ?? 0) * f,
          })
        }
        return out
      },
    }
  }

  const inSelected = (id: string | null | undefined): boolean => id != null && selected!.has(id)

  return {
    entityId,
    active,
    selectedEntityIds: selected,
    fieldIds,
    farmIds,
    plantings: (rows) => (active ? rows.filter((r) => fieldIds!.has(r.field_id)) : [...rows]),
    byEntity: (rows) => (active ? rows.filter((r) => inSelected(r.entity_id)) : [...rows]),
    attribution,
    byFarm: (rows) => (active ? rows.filter((r) => farmIds!.has(r.farm_id)) : [...rows]),
    farmInEntity,
    otherPayments: (rows) =>
      active
        ? rows.filter((r) => (r.farm_id != null ? inSelected(farmEntity.get(r.farm_id)) : inSelected(r.entity_id)))
        : [...rows],
    fieldAgg: <V,>(agg: ReadonlyMap<string, V>) => {
      if (!active) return new Map(agg)
      const out = new Map<string, V>()
      for (const [key, v] of agg) if (fieldIds!.has(key.split('|')[0])) out.set(key, v)
      return out
    },
    ginReceipts: (rows) =>
      active
        ? rows.filter((r) => {
            if (r.entity_id != null) return selected!.has(r.entity_id)
            if (r.farm_id != null) return inSelected(farmEntity.get(r.farm_id))
            if (r.field_id != null) return fieldIds!.has(r.field_id)
            return false
          })
        : [...rows],
  }
}
