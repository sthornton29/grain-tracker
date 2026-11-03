// Claim Check — the ENGINE, pure (0101).
//
// Answers the agent's trigger-yield email for every insurance UNIT
// (insured × county × crop × practice): what has each unit harvested so far,
// how does that compare with its RP / YP trigger yield, and does a claim need
// to be opened. Also lists where the agent's report and Turnrow's own records
// disagree (acres, APH, approved yield, coverage), and writes the reply.
//
// Rules — keep them here, in one place:
//
//   * Production comes from lib/production-report buildProductionReport — the
//     Crop Insurance Production Report's own engine — so shrink, combine
//     entries, cotton lint (receipts + the turnout estimate on unginned seed
//     cotton), practice breakouts and the harvest-in-progress rules are the
//     ones the agent already gets on that report. A field counts toward a
//     unit's yield only once it classifies COMPLETE; a field still harvesting
//     (or not started) adds acres to the unit but no production, so a partial
//     field never drags the yield down (see the harvest in-progress rule).
//   * A MIXED field (irrigated + dryland acres) with no irrigated / dryland
//     split yet is split by acres at the field's own average yield, and the
//     unit says so — the agent needs the practices separately.
//   * The unit's insured is the field's farm's entity. A share-rent farm's
//     LANDOWNER is a second insured when the agent's report lists them (a
//     landlord insuring their own share): same per-acre yield, the landlord's
//     share of the acres.
//   * The trigger is the agent's printed trigger yield when the report is on
//     file; else it is figured from the policy: guarantee yield (approved
//     yield, else APH — guaranteeYieldOf) × coverage, and for RP × the
//     revenue-guarantee price over the harvest price (max(projected, harvest)
//     ÷ harvest — the yield at which revenue falls to the guarantee).
//     Area plans (ARP / AYP) and SCO / ECO are county-triggered: never a claim
//     on the farm's yield, never a unit here.
//   * Status: below the trigger → 'below' (talk to the agent about a claim);
//     within WATCH_MARGIN above → 'watch'; else 'above'. Nothing harvested →
//     'not_started'; no individual policy and no agent row → 'no_coverage'.

import { guaranteeYieldOf, type PlanType } from '@/lib/crop-insurance'
import type { Resolved } from '@/lib/production-report'
import type { CropInsurancePolicy, FieldPlanting } from '@/lib/types'

export const WATCH_MARGIN = 0.1
/** Agent vs Turnrow acres differing by more than this share is worth a look. */
export const ACRE_TOLERANCE = 0.02

export type UnitPractice = 'irrigated' | 'non_irrigated'

export type TriggerYieldRow = {
  id: string
  crop_year: number
  insured_name: string
  entity_id: string | null
  landowner_id: string | null
  crop_id: string
  county_id: string | null
  practice: UnitPractice
  unit_label: string | null
  plan_type: 'RP' | 'RP_HPE' | 'YP'
  reported_acres: number | string | null
  aph_yield: number | string | null
  approved_yield: number | string | null
  trigger_yield: number | string
  expected_county_yield: number | string | null
  eco_trigger_yield: number | string | null
  sco_trigger_yield: number | string | null
  projected_price: number | string | null
  harvest_price: number | string | null
  report_date: string | null
  agency: string | null
}

type NamedRef = { id: string; name: string }
type FarmRef = { id: string; name: string; entity_id: string | null; landowner_id: string | null; is_share_rent: boolean | null; landlord_share_percentage: number | string | null; county_id?: string | null }
type FieldRef = { id: string; farm_id: string | null; name_or_number: string; county_id?: string | null }

export type UnitFieldStatus = 'complete' | 'in_progress' | 'unharvested'

export type UnitField = {
  plantingId: string
  fieldName: string
  farmName: string
  acres: number
  production: number
  status: UnitFieldStatus
  yieldPerAcre: number | null
  /** Mixed field with no irrigated / dryland split — split by acres. */
  splitByAcres: boolean
  /** Cotton lint partly or wholly estimated from unginned seed cotton. */
  lintEstimated: boolean
}

export type UnitFlagKind =
  | 'no_policy' | 'insured_acres' | 'planted_acres' | 'approved_yield' | 'aph' | 'coverage'
  | 'trigger_math' | 'county_trigger' | 'no_planted' | 'uninsured' | 'split_by_acres'

export type UnitFlag = {
  kind: UnitFlagKind
  /** Plain-language sentence for the farmer. */
  message: string
  /** A question worth putting to the agent (the reply's "double-check" list). */
  forAgent: string | null
  /** 'approved_yield' only: the agent's figure, for the one-tap fix. */
  agentValue?: number | null
}

export type UnitStatus = 'below' | 'watch' | 'above' | 'not_started' | 'no_coverage'

export type ClaimCheckUnit = {
  key: string
  insuredKind: 'entity' | 'landowner'
  insuredId: string
  insuredName: string
  cropId: string
  cropName: string
  countyId: string | null
  countyName: string
  practice: UnitPractice
  unit: 'bu' | 'lbs'
  isCotton: boolean
  plantedAcres: number
  harvestedAcres: number
  inProgressAcres: number
  production: number
  yieldToDate: number | null
  /** Harvested share of planted acres, 0–1. */
  harvestedShare: number
  final: boolean
  trigger: number | null
  triggerSource: 'agent' | 'policy' | null
  planType: PlanType | null
  coverageLevel: number | null
  /** yieldToDate − trigger (null until both exist). */
  margin: number | null
  status: UnitStatus
  splitByAcres: boolean
  lintEstimated: boolean
  policy: CropInsurancePolicy | null
  agentRow: TriggerYieldRow | null
  fields: UnitField[]
  flags: UnitFlag[]
}

export type ClaimCheckInput = {
  cropYear: number
  /** The production engine's resolved plantings (complete + unharvested). */
  resolved: readonly Resolved[]
  /** Plantings still harvesting (the engine leaves them out of `resolved`). */
  inProgress: readonly FieldPlanting[]
  fields: readonly FieldRef[]
  farms: readonly FarmRef[]
  entities: readonly NamedRef[]
  landowners: readonly NamedRef[]
  crops: ReadonlyArray<{ id: string; name: string }>
  counties: ReadonlyArray<{ id: string; name: string }>
  cottonCropIds: ReadonlySet<string>
  /** Cotton: true when the planting's lint is partly / wholly a turnout estimate. */
  lintEstimated?: (p: FieldPlanting) => boolean
  policies: readonly CropInsurancePolicy[]
  triggers: readonly TriggerYieldRow[]
  /** Harvest price per crop for the policy-figured RP trigger (else projected). */
  harvestPriceByCrop?: ReadonlyMap<string, number>
  /** Limit to one entity's units (landowner units on its farms stay). '' = all. */
  entityId?: string
}

const n = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

export function practiceWord(p: UnitPractice): string {
  return p === 'irrigated' ? 'irrigated' : 'dryland'
}

export function unitKey(kind: 'entity' | 'landowner', id: string, cropId: string, countyId: string | null, practice: UnitPractice): string {
  return `${kind === 'entity' ? 'e' : 'l'}:${id}|${cropId}|${countyId ?? ''}|${practice}`
}

/** The trigger yield figured from a policy (RP / RP-HPE / YP); null for area plans. */
export function policyTriggerYield(p: CropInsurancePolicy, harvestPrice: number | null | undefined): number | null {
  if (p.plan_type === 'ARP' || p.plan_type === 'AYP') return null
  const g = guaranteeYieldOf(p) * Number(p.coverage_level)
  if (!(g > 0)) return null
  if (p.plan_type !== 'RP') return g
  const proj = Number(p.projected_price) || 0
  const harvest = n(p.harvest_price) ?? (harvestPrice != null && harvestPrice > 0 ? harvestPrice : null) ?? proj
  if (!(harvest > 0)) return g
  return g * (Math.max(proj, harvest) / harvest)
}

/** Coverage implied by an agent row (trigger ÷ approved yield), snapped to the
 *  5% grid — only meaningful for RP when harvest ≥ projected, or YP / RP-HPE. */
export function impliedCoverage(row: TriggerYieldRow): number | null {
  const trig = n(row.trigger_yield)
  const appr = n(row.approved_yield)
  if (trig == null || appr == null || appr <= 0) return null
  let ratio = trig / appr
  if (row.plan_type === 'RP') {
    const proj = n(row.projected_price)
    const harv = n(row.harvest_price)
    if (proj != null && harv != null && harv > 0) ratio = ratio * harv / Math.max(proj, harv)
  }
  const snapped = Math.round(ratio * 20) / 20
  return Math.abs(snapped - ratio) < 0.006 ? snapped : null
}

type Acc = {
  insuredKind: 'entity' | 'landowner'
  insuredId: string
  cropId: string
  countyId: string | null
  practice: UnitPractice
  fields: UnitField[]
}

const fmt1 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const fmtAc = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const pctLabel = (v: number) => `${Math.round(v * 100)}%`

export function buildClaimCheck(input: ClaimCheckInput): ClaimCheckUnit[] {
  const fieldById = new Map(input.fields.map((f) => [f.id, f]))
  const farmById = new Map(input.farms.map((f) => [f.id, f]))
  const entityName = new Map(input.entities.map((e) => [e.id, e.name]))
  const landownerName = new Map(input.landowners.map((l) => [l.id, l.name]))
  const cropName = new Map(input.crops.map((c) => [c.id, c.name]))
  const countyName = new Map(input.counties.map((c) => [c.id, c.name]))
  const yearTriggers = input.triggers.filter((t) => t.crop_year === input.cropYear)
  const insuredLandowners = new Set(yearTriggers.filter((t) => t.landowner_id).map((t) => t.landowner_id as string))

  const acc = new Map<string, Acc>()
  const add = (kind: 'entity' | 'landowner', id: string, cropId: string, countyId: string | null, practice: UnitPractice, f: UnitField) => {
    const key = unitKey(kind, id, cropId, countyId, practice)
    let a = acc.get(key)
    if (!a) {
      a = { insuredKind: kind, insuredId: id, cropId, countyId, practice, fields: [] }
      acc.set(key, a)
    }
    a.fields.push(f)
  }

  // One planting → its practice parts (acres, production) → the operator's
  // unit, plus the landlord's share when that landlord is insured.
  const place = (
    p: FieldPlanting,
    parts: Array<{ practice: UnitPractice; acres: number; production: number; splitByAcres: boolean }>,
    status: UnitFieldStatus,
  ) => {
    const fld = fieldById.get(p.field_id)
    const farm = fld?.farm_id ? farmById.get(fld.farm_id) : undefined
    const countyId = fld?.county_id ?? farm?.county_id ?? null
    const lintEst = input.cottonCropIds.has(p.crop_id) && status === 'complete' && !!input.lintEstimated?.(p)
    const share = farm?.is_share_rent && farm.landowner_id && insuredLandowners.has(farm.landowner_id)
      ? (n(farm.landlord_share_percentage) ?? 0) / 100
      : 0
    for (const part of parts) {
      if (part.acres <= 0 && part.production <= 0) continue
      const base: UnitField = {
        plantingId: p.id,
        fieldName: fld?.name_or_number ?? '—',
        farmName: farm?.name ?? '—',
        acres: part.acres,
        production: status === 'complete' ? part.production : 0,
        status,
        yieldPerAcre: status === 'complete' && part.acres > 0 ? part.production / part.acres : null,
        splitByAcres: part.splitByAcres,
        lintEstimated: lintEst,
      }
      if (farm?.entity_id) add('entity', farm.entity_id, p.crop_id, countyId, part.practice, base)
      if (share > 0 && farm?.landowner_id) {
        add('landowner', farm.landowner_id, p.crop_id, countyId, part.practice, {
          ...base, acres: base.acres * share, production: base.production * share,
        })
      }
    }
  }

  for (const r of input.resolved) {
    if (r.planting.season_year !== input.cropYear) continue
    const status: UnitFieldStatus = r.harvestStatus === 'complete' ? 'complete' : r.harvestStatus === 'in_progress' ? 'in_progress' : 'unharvested'
    let irrAc = r.irrigatedAcres
    let dryAc = r.drylandAcres
    if (irrAc <= 0 && dryAc <= 0) dryAc = Number(r.planting.planted_acres) || 0
    if (r.isMixed && !r.hasBreakout) {
      const tot = irrAc + dryAc
      place(r.planting, [
        { practice: 'irrigated', acres: irrAc, production: tot > 0 ? r.totalBu * irrAc / tot : 0, splitByAcres: true },
        { practice: 'non_irrigated', acres: dryAc, production: tot > 0 ? r.totalBu * dryAc / tot : 0, splitByAcres: true },
      ], status)
    } else if (r.isMixed) {
      place(r.planting, [
        { practice: 'irrigated', acres: irrAc, production: r.irrigatedBu, splitByAcres: false },
        { practice: 'non_irrigated', acres: dryAc, production: r.drylandBu, splitByAcres: false },
      ], status)
    } else if (irrAc > 0) {
      place(r.planting, [{ practice: 'irrigated', acres: irrAc, production: r.totalBu, splitByAcres: false }], status)
    } else {
      place(r.planting, [{ practice: 'non_irrigated', acres: dryAc, production: r.totalBu, splitByAcres: false }], status)
    }
  }
  for (const p of input.inProgress) {
    if (p.season_year !== input.cropYear) continue
    const irr = Number(p.irrigated_acres) || 0
    let dry = Number(p.dryland_acres) || 0
    if (irr <= 0 && dry <= 0) dry = Number(p.planted_acres) || 0
    place(p, [
      { practice: 'irrigated', acres: irr, production: 0, splitByAcres: false },
      { practice: 'non_irrigated', acres: dry, production: 0, splitByAcres: false },
    ], 'in_progress')
  }

  // Units the agent printed that Turnrow has no planted acres for still show —
  // the mismatch IS the finding.
  const triggerByKey = new Map<string, TriggerYieldRow>()
  for (const t of yearTriggers) {
    const kind = t.entity_id ? 'entity' : 'landowner'
    const id = (t.entity_id ?? t.landowner_id) as string
    const key = unitKey(kind, id, t.crop_id, t.county_id, t.practice)
    triggerByKey.set(key, t)
    if (!acc.has(key)) acc.set(key, { insuredKind: kind, insuredId: id, cropId: t.crop_id, countyId: t.county_id, practice: t.practice, fields: [] })
  }

  // Individual-plan policies per operator unit (area plans never claim on the farm yield).
  const policyByKey = new Map<string, CropInsurancePolicy>()
  for (const p of input.policies) {
    if (p.crop_year !== input.cropYear || !p.entity_id) continue
    if (p.plan_type === 'ARP' || p.plan_type === 'AYP') continue
    const key = unitKey('entity', p.entity_id, p.crop_id, p.county_id, (p.practice ?? 'non_irrigated') as UnitPractice)
    if (!policyByKey.has(key)) policyByKey.set(key, p)
  }

  const units: ClaimCheckUnit[] = []
  for (const [key, a] of acc) {
    if (input.entityId && a.insuredKind === 'entity' && a.insuredId !== input.entityId) continue
    if (input.entityId && a.insuredKind === 'landowner') {
      const onEntityFarm = a.fields.length === 0 || input.farms.some((f) => f.landowner_id === a.insuredId && f.entity_id === input.entityId)
      if (!onEntityFarm) continue
    }
    const isCotton = input.cottonCropIds.has(a.cropId)
    const plantedAcres = a.fields.reduce((s, f) => s + f.acres, 0)
    const done = a.fields.filter((f) => f.status === 'complete')
    const harvestedAcres = done.reduce((s, f) => s + f.acres, 0)
    const production = done.reduce((s, f) => s + f.production, 0)
    const inProgressAcres = a.fields.filter((f) => f.status === 'in_progress').reduce((s, f) => s + f.acres, 0)
    const yieldToDate = harvestedAcres > 0 ? production / harvestedAcres : null
    const policy = a.insuredKind === 'entity' ? policyByKey.get(key) ?? null : null
    const agentRow = triggerByKey.get(key) ?? null
    const figured = policy ? policyTriggerYield(policy, input.harvestPriceByCrop?.get(a.cropId)) : null
    const trigger = agentRow ? Number(agentRow.trigger_yield) : figured
    const triggerSource = agentRow ? 'agent' : figured != null ? 'policy' : null
    const splitByAcres = a.fields.some((f) => f.splitByAcres && f.status === 'complete')
    const lintEstimated = a.fields.some((f) => f.lintEstimated)
    const final = plantedAcres > 0 && harvestedAcres >= plantedAcres - 0.05

    let status: UnitStatus
    if (trigger == null) status = 'no_coverage'
    else if (yieldToDate == null) status = 'not_started'
    else if (yieldToDate < trigger) status = 'below'
    else if (yieldToDate < trigger * (1 + WATCH_MARGIN)) status = 'watch'
    else status = 'above'

    const insuredName = a.insuredKind === 'entity'
      ? entityName.get(a.insuredId) ?? agentRow?.insured_name ?? '—'
      : landownerName.get(a.insuredId) ?? agentRow?.insured_name ?? '—'
    const cName = cropName.get(a.cropId) ?? '—'
    const coName = a.countyId ? countyName.get(a.countyId) ?? '—' : '(no county)'
    const flags = unitFlags({ agentRow, policy, plantedAcres, figured, splitByAcres, isCotton, cropName: cName, countyName: coName, practice: a.practice, insuredKind: a.insuredKind })

    units.push({
      key, insuredKind: a.insuredKind, insuredId: a.insuredId, insuredName,
      cropId: a.cropId, cropName: cName, countyId: a.countyId, countyName: coName, practice: a.practice,
      unit: isCotton ? 'lbs' : 'bu', isCotton,
      plantedAcres, harvestedAcres, inProgressAcres, production, yieldToDate,
      harvestedShare: plantedAcres > 0 ? Math.min(1, harvestedAcres / plantedAcres) : 0,
      final, trigger, triggerSource,
      planType: (agentRow?.plan_type ?? policy?.plan_type ?? null) as PlanType | null,
      coverageLevel: policy ? Number(policy.coverage_level) : agentRow ? impliedCoverage(agentRow) : null,
      margin: yieldToDate != null && trigger != null ? yieldToDate - trigger : null,
      status, splitByAcres, lintEstimated, policy, agentRow,
      fields: a.fields.sort((x, y) => x.farmName.localeCompare(y.farmName) || x.fieldName.localeCompare(y.fieldName)),
      flags,
    })
  }

  const statusRank: Record<UnitStatus, number> = { below: 0, watch: 1, above: 2, not_started: 3, no_coverage: 4 }
  return units.sort((x, y) =>
    (x.insuredKind === y.insuredKind ? 0 : x.insuredKind === 'entity' ? -1 : 1)
    || x.insuredName.localeCompare(y.insuredName)
    || x.cropName.localeCompare(y.cropName)
    || x.countyName.localeCompare(y.countyName)
    || (x.practice === y.practice ? 0 : x.practice === 'non_irrigated' ? -1 : 1)
    || statusRank[x.status] - statusRank[y.status])
}

function unitFlags(a: {
  agentRow: TriggerYieldRow | null
  policy: CropInsurancePolicy | null
  plantedAcres: number
  figured: number | null
  splitByAcres: boolean
  isCotton: boolean
  cropName: string
  countyName: string
  practice: UnitPractice
  insuredKind: 'entity' | 'landowner'
}): UnitFlag[] {
  const flags: UnitFlag[] = []
  const { agentRow: t, policy: p } = a
  const what = `${a.countyName} ${a.cropName.toLowerCase()} (${practiceWord(a.practice)})`
  const differs = (x: number, y: number, tol: number) => Math.abs(x - y) > Math.max(tol * Math.abs(x), 0.05)

  if (t) {
    const repAc = n(t.reported_acres)
    if (a.insuredKind === 'entity' && !p) {
      flags.push({ kind: 'no_policy', message: 'Your agent’s report lists this unit, but there is no policy for it in Turnrow.', forAgent: null })
    }
    if (repAc != null && p && differs(repAc, Number(p.insured_acres), ACRE_TOLERANCE)) {
      flags.push({ kind: 'insured_acres', message: `Insured acres: your agent reports ${fmtAc(repAc)}, your policy in Turnrow has ${fmtAc(Number(p.insured_acres))}.`, forAgent: null })
    }
    if (repAc != null && a.plantedAcres > 0 && differs(repAc, a.plantedAcres, ACRE_TOLERANCE)) {
      flags.push({
        kind: 'planted_acres',
        message: `Your agent reports ${fmtAc(repAc)} acres; your fields in Turnrow add up to ${fmtAc(a.plantedAcres)}.`,
        forAgent: `${what}: your report shows ${fmtAc(repAc)} acres and our records show ${fmtAc(a.plantedAcres)}. Can you confirm which fields are reported on this unit?`,
      })
    }
    if (repAc != null && repAc > 0 && a.plantedAcres <= 0) {
      flags.push({ kind: 'no_planted', message: 'Your agent reports acres here, but no field in Turnrow is planted to this crop and practice for this insured.', forAgent: null })
    }
    const apprAgent = n(t.approved_yield)
    if (apprAgent != null && p) {
      const mine = n(p.approved_yield ?? null)
      if (mine == null || differs(apprAgent, mine, 0.002)) {
        flags.push({
          kind: 'approved_yield',
          message: mine == null
            ? `Approved yield: your agent uses ${fmt1(apprAgent)}; your policy in Turnrow has none, so its guarantee uses the APH instead.`
            : `Approved yield: your agent uses ${fmt1(apprAgent)}, your policy in Turnrow has ${fmt1(mine)}.`,
          forAgent: null,
          agentValue: apprAgent,
        })
      }
    }
    const aphAgent = n(t.aph_yield)
    if (aphAgent != null && p && differs(aphAgent, Number(p.aph_yield), 0.002)) {
      flags.push({ kind: 'aph', message: `APH: your agent uses ${fmt1(aphAgent)}, your policy in Turnrow has ${fmt1(Number(p.aph_yield))}.`, forAgent: null })
    }
    const cov = impliedCoverage(t)
    if (cov != null && p && Math.abs(cov - Number(p.coverage_level)) > 0.001) {
      flags.push({ kind: 'coverage', message: `Coverage: your agent’s trigger works out to ${pctLabel(cov)}, your policy in Turnrow is ${pctLabel(Number(p.coverage_level))}.`, forAgent: null })
    } else if (a.figured != null && differs(Number(t.trigger_yield), a.figured, 0.01) && !flags.some((f) => f.kind === 'approved_yield' || f.kind === 'aph')) {
      flags.push({ kind: 'trigger_math', message: `Your agent’s trigger is ${fmt1(Number(t.trigger_yield))}; your policy in Turnrow works out to ${fmt1(a.figured)}.`, forAgent: null })
    }
    const exp = n(t.expected_county_yield)
    const sco = n(t.sco_trigger_yield)
    const eco = n(t.eco_trigger_yield)
    const odd = [sco != null && exp != null && sco > exp ? `SCO trigger ${fmt1(sco)}` : null, eco != null && exp != null && eco > exp ? `ECO trigger ${fmt1(eco)}` : null].filter(Boolean)
    if (odd.length > 0 && exp != null) {
      flags.push({
        kind: 'county_trigger',
        message: `The ${odd.join(' and ')} is higher than the expected county yield (${fmt1(exp)}). County triggers normally sit below it — worth asking your agent.`,
        forAgent: `${what}: the ${odd.join(' and ')} on the report is above the expected county yield of ${fmt1(exp)}. Can you double-check that figure?`,
      })
    }
  }
  if (!t && !p && a.plantedAcres > 0) {
    flags.push({ kind: 'uninsured', message: 'Planted, but there is no policy for this insured, crop, county and practice in Turnrow — check the field’s entity, or add the policy.', forAgent: null })
  }
  if (a.splitByAcres) {
    flags.push({ kind: 'split_by_acres', message: 'At least one field here has irrigated and dryland acres but no split of its production yet, so both use the field’s average yield. Enter the split on the Yields page for an exact figure.', forAgent: null })
  }
  return flags
}

// ---------------------------------------------------------------------------
// The reply to the agent.
// ---------------------------------------------------------------------------

export type ReplyOptions = {
  /** Unit keys the farmer wants a claim opened on. */
  claimKeys: ReadonlySet<string>
  /** Include the "please double-check" questions. */
  includeQuestions: boolean
  greetingName?: string | null
  signature?: string | null
}

const yieldText = (u: ClaimCheckUnit, v: number) => `${fmt1(v)} ${u.unit === 'lbs' ? 'lb' : 'bu'}`

/** One unit's line in the reply. */
export function unitReplyLine(u: ClaimCheckUnit, claim: boolean): string {
  const name = `${u.countyName} ${u.cropName.toLowerCase()} (${practiceWord(u.practice)})`
  if (u.trigger == null) return `${name}: no individual policy on our side.`
  const trig = fmt1(u.trigger)
  if (u.yieldToDate == null) {
    return claim
      ? `${name}: not harvested yet (trigger ${trig}) — please open a claim.`
      : `${name}: not harvested yet (trigger ${trig}). We'll follow up once it's in.`
  }
  const y = yieldText(u, u.yieldToDate)
  const progress = u.final ? 'harvest complete' : `${pctLabel(u.harvestedShare)} of acres harvested`
  const basis = u.lintEstimated ? ', including an estimate for cotton not ginned yet' : ''
  if (claim) return `${name}: ${progress}, ${y} so far${basis} vs. trigger ${trig} — please open a claim.`
  if (u.final) return `${name}: ${progress}, ${y}${basis} vs. trigger ${trig} — no claim needed.`
  return `${name}: ${progress}, ${y} so far${basis} vs. trigger ${trig} — no claim at this time; we'll confirm when harvest is complete.`
}

export function buildAgentReply(units: readonly ClaimCheckUnit[], opts: ReplyOptions): string {
  const covered = units.filter((u) => u.trigger != null)
  const lines: string[] = []
  lines.push(opts.greetingName ? `${opts.greetingName},` : 'Hi,')
  lines.push('')
  lines.push('Thanks for sending the trigger yield reports. We checked our harvested yields against the trigger yield on each unit:')
  const byInsured = new Map<string, ClaimCheckUnit[]>()
  for (const u of covered) {
    const k = u.insuredName
    const arr = byInsured.get(k)
    if (arr) arr.push(u)
    else byInsured.set(k, [u])
  }
  for (const [insured, list] of byInsured) {
    lines.push('')
    lines.push(insured)
    for (const u of list) lines.push(`- ${unitReplyLine(u, opts.claimKeys.has(u.key))}`)
  }
  lines.push('')
  const claims = covered.filter((u) => opts.claimKeys.has(u.key))
  if (claims.length === 0) {
    const pending = covered.some((u) => !u.final)
    lines.push(pending
      ? "We don't need any claims opened at this time. We'll let you know right away if a unit still being harvested comes in below its trigger."
      : "We don't need any claims opened.")
  } else {
    lines.push(`Please open ${claims.length === 1 ? 'a claim' : 'claims'} on: ${claims.map((u) => `${u.insuredName} ${u.countyName} ${u.cropName.toLowerCase()} (${practiceWord(u.practice)})`).join('; ')}.`)
  }
  if (opts.includeQuestions) {
    const qs = Array.from(new Set(covered.flatMap((u) => u.flags.map((f) => f.forAgent).filter((q): q is string => !!q))))
    if (qs.length > 0) {
      lines.push('')
      lines.push(qs.length === 1 ? 'One thing to double-check on your side:' : 'A few things to double-check on your side:')
      qs.forEach((q, i) => lines.push(`${i + 1}. ${q}`))
    }
  }
  lines.push('')
  lines.push('Thanks,')
  if (opts.signature) lines.push(opts.signature)
  return lines.join('\n')
}

/** Units the reply should default to asking a claim on: below the trigger. */
export function defaultClaimKeys(units: readonly ClaimCheckUnit[]): Set<string> {
  return new Set(units.filter((u) => u.status === 'below').map((u) => u.key))
}
