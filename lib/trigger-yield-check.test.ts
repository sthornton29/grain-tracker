import { describe, expect, it } from 'vitest'
import {
  buildAgentReply, buildClaimCheck, defaultClaimKeys, impliedCoverage, policyTriggerYield, unitReplyLine,
  type ClaimCheckInput, type TriggerYieldRow,
} from '@/lib/trigger-yield-check'
import type { Resolved } from '@/lib/production-report'
import type { CropInsurancePolicy, FieldPlanting } from '@/lib/types'

const CORN = 'corn'
const COTTON = 'cotton'
const LAW = 'lawrence'
const TS = 'two-seasons'
const VC = 'view-celeste'
const REBMAN = 'rebman'

const farms = [
  { id: 'f-moore', name: 'Moore Farm', entity_id: TS, landowner_id: REBMAN, is_share_rent: true, landlord_share_percentage: 25, county_id: LAW },
  { id: 'f-goode', name: 'Goode Farm', entity_id: TS, landowner_id: null, is_share_rent: false, landlord_share_percentage: null, county_id: LAW },
  { id: 'f-joe', name: 'Joe McCullough Farm', entity_id: VC, landowner_id: null, is_share_rent: false, landlord_share_percentage: null, county_id: LAW },
]
const fields = [
  { id: 'fld-club', farm_id: 'f-moore', name_or_number: 'Clubhouse East', county_id: LAW },
  { id: 'fld-goode', farm_id: 'f-goode', name_or_number: 'Goode', county_id: LAW },
  { id: 'fld-duck', farm_id: 'f-goode', name_or_number: 'Duck Patch', county_id: LAW },
  { id: 'fld-joe', farm_id: 'f-joe', name_or_number: 'Joe McCullough', county_id: LAW },
]

function planting(id: string, fieldId: string, cropId: string, irr: number, dry: number, extra: Partial<FieldPlanting> = {}): FieldPlanting {
  return {
    id, field_id: fieldId, crop_id: cropId, season_year: 2026, planted_acres: irr + dry,
    irrigated_acres: irr, dryland_acres: dry, irrigated_bushels: null, dryland_bushels: null,
    yield_breakout_entered: false, ...extra,
  } as unknown as FieldPlanting
}

function resolved(p: FieldPlanting, totalBu: number, status: 'complete' | 'unharvested' = 'complete', breakout?: { irr: number; dry: number }): Resolved {
  const irr = Number(p.irrigated_acres) || 0
  const dry = Number(p.dryland_acres) || 0
  const isMixed = irr > 0 && dry > 0
  return {
    planting: p, field: null, farm: null, countyId: LAW, countyLabel: 'Lawrence County', county: null,
    irrigatedAcres: irr, drylandAcres: dry, totalBu,
    irrigatedBu: breakout ? breakout.irr : isMixed ? 0 : irr > 0 ? totalBu : 0,
    drylandBu: breakout ? breakout.dry : isMixed ? totalBu : irr > 0 ? 0 : totalBu,
    measuredBu: totalBu, balanceFactor: 1, isMixed, hasBreakout: !!breakout,
    breakout: breakout ? 'entered' : isMixed ? 'rolled_dryland' : 'single',
    source: 'scale', fieldDisplayName: '', harvestStatus: status, countedAnyway: false, agg: null,
  }
}

function policy(over: Partial<CropInsurancePolicy>): CropInsurancePolicy {
  return {
    id: 'pol', entity_id: TS, crop_id: CORN, crop_year: 2026, county_id: LAW, policy_number: null,
    plan_type: 'RP', practice: 'non_irrigated', coverage_level: 0.8, unit_structure: 'enterprise',
    aph_yield: 170.6, approved_yield: null, projected_price: 4.42, harvest_price: 4.69, volatility_factor: null,
    insured_acres: 1340, premium_per_acre: null, total_premium: null, premium_subsidy_pct: null, notes: null,
    covers_all_planted_acres: true, coverage_note: null, expected_county_yield: null, expected_county_revenue: null,
    protection_factor: null, source: 'manual', created_at: '',
    ...over,
  } as CropInsurancePolicy
}

function trigger(over: Partial<TriggerYieldRow>): TriggerYieldRow {
  return {
    id: 't', crop_year: 2026, insured_name: 'Two Seasons Farm LLC', entity_id: TS, landowner_id: null,
    crop_id: CORN, county_id: LAW, practice: 'non_irrigated', unit_label: 'Enterprise Unit', plan_type: 'RP',
    reported_acres: 1340.725, aph_yield: 169.1, approved_yield: 193.8, trigger_yield: 155,
    expected_county_yield: 165.8, eco_trigger_yield: 157.5, sco_trigger_yield: 142.6,
    projected_price: 4.42, harvest_price: 4.69, report_date: '2026-11-02', agency: 'Silveus',
    ...over,
  }
}

function input(over: Partial<ClaimCheckInput>): ClaimCheckInput {
  return {
    cropYear: 2026, resolved: [], inProgress: [], fields, farms,
    entities: [{ id: TS, name: 'Two Seasons Farm, LLC' }, { id: VC, name: 'View Celeste Farm, LLC' }],
    landowners: [{ id: REBMAN, name: 'AF Rebman Residuary Trust' }],
    crops: [{ id: CORN, name: 'Corn' }, { id: COTTON, name: 'Cotton' }],
    counties: [{ id: LAW, name: 'Lawrence' }],
    cottonCropIds: new Set([COTTON]),
    policies: [], triggers: [],
    ...over,
  }
}

describe('policyTriggerYield', () => {
  it('RP with the harvest price above projected is guarantee yield × coverage, on the approved yield', () => {
    expect(policyTriggerYield(policy({ approved_yield: 193.8 }), null)).toBeCloseTo(155.04, 2)
    expect(policyTriggerYield(policy({}), null)).toBeCloseTo(136.48, 2) // APH fallback
  })
  it('RP with the harvest price below projected scales up by projected ÷ harvest', () => {
    const p = policy({ approved_yield: 200, projected_price: 5, harvest_price: 4 })
    expect(policyTriggerYield(p, null)).toBeCloseTo(200, 6) // 160 × 5/4
  })
  it('falls back to the passed harvest price, then the projected price', () => {
    const p = policy({ approved_yield: 200, projected_price: 5, harvest_price: null })
    expect(policyTriggerYield(p, 4)).toBeCloseTo(200, 6)
    expect(policyTriggerYield(p, null)).toBeCloseTo(160, 6)
  })
  it('YP is guarantee × coverage; area plans have no farm trigger', () => {
    expect(policyTriggerYield(policy({ plan_type: 'YP', approved_yield: 200, projected_price: 5, harvest_price: 4 }), null)).toBeCloseTo(160, 6)
    expect(policyTriggerYield(policy({ plan_type: 'ARP' }), null)).toBeNull()
  })
})

describe('impliedCoverage', () => {
  it('reads the coverage off the agent row (trigger ÷ approved) on the 5% grid', () => {
    expect(impliedCoverage(trigger({}))).toBe(0.8)
    expect(impliedCoverage(trigger({ approved_yield: 1252.1, trigger_yield: 939.1 }))).toBe(0.75)
    expect(impliedCoverage(trigger({ approved_yield: 200, trigger_yield: 157 }))).toBeNull()
  })
})

describe('buildClaimCheck', () => {
  it('a finished unit above its trigger: yield over harvested acres, status above, final', () => {
    const a = planting('p1', 'fld-goode', CORN, 0, 159.89)
    const b = planting('p2', 'fld-duck', CORN, 0, 76.1)
    const units = buildClaimCheck(input({
      resolved: [resolved(a, 37146), resolved(b, 12266)],
      policies: [policy({ approved_yield: 193.8 })],
      triggers: [trigger({ reported_acres: 235.99 })],
    }))
    const u = units.find((x) => x.insuredId === TS && x.cropId === CORN)!
    expect(u.yieldToDate).toBeCloseTo((37146 + 12266) / (159.89 + 76.1), 6)
    expect(u.trigger).toBe(155)
    expect(u.triggerSource).toBe('agent')
    expect(u.status).toBe('above')
    expect(u.final).toBe(true)
    expect(u.flags.map((f) => f.kind)).not.toContain('approved_yield')
  })

  it('a field still harvesting adds acres but no production; a low partial never drags the yield', () => {
    const a = planting('p1', 'fld-goode', CORN, 0, 100)
    const b = planting('p2', 'fld-duck', CORN, 0, 100)
    const units = buildClaimCheck(input({ resolved: [resolved(a, 20000)], inProgress: [b], policies: [policy({})] }))
    const u = units[0]
    expect(u.yieldToDate).toBe(200)
    expect(u.plantedAcres).toBe(200)
    expect(u.harvestedAcres).toBe(100)
    expect(u.inProgressAcres).toBe(100)
    expect(u.final).toBe(false)
    expect(u.triggerSource).toBe('policy')
  })

  it('nothing harvested yet is not_started; below the trigger is below; inside 10% is watch', () => {
    const a = planting('p1', 'fld-goode', CORN, 0, 100)
    expect(buildClaimCheck(input({ resolved: [resolved(a, 0, 'unharvested')], triggers: [trigger({})] }))[0].status).toBe('not_started')
    expect(buildClaimCheck(input({ resolved: [resolved(a, 15000)], triggers: [trigger({})] }))[0].status).toBe('below')
    expect(buildClaimCheck(input({ resolved: [resolved(a, 16500)], triggers: [trigger({})] }))[0].status).toBe('watch')
  })

  it('a mixed field with no split uses the field average on both practices and says so', () => {
    const p = planting('p1', 'fld-joe', CORN, 108.56, 69.94)
    const units = buildClaimCheck(input({ resolved: [resolved(p, 40177)] }))
    const irr = units.find((u) => u.practice === 'irrigated')!
    const dry = units.find((u) => u.practice === 'non_irrigated')!
    expect(irr.yieldToDate).toBeCloseTo(40177 / 178.5, 6)
    expect(dry.yieldToDate).toBeCloseTo(40177 / 178.5, 6)
    expect(irr.splitByAcres).toBe(true)
    expect(irr.flags.map((f) => f.kind)).toContain('split_by_acres')
  })

  it('a mixed field WITH a split puts each practice its own production', () => {
    const p = planting('p1', 'fld-joe', CORN, 100, 50, { yield_breakout_entered: true })
    const units = buildClaimCheck(input({ resolved: [resolved(p, 30000, 'complete', { irr: 24000, dry: 6000 })] }))
    expect(units.find((u) => u.practice === 'irrigated')!.yieldToDate).toBe(240)
    expect(units.find((u) => u.practice === 'non_irrigated')!.yieldToDate).toBe(120)
  })

  it('a share-rent landlord who is on the agent report gets their own unit: the share of acres, the same yield', () => {
    const p = planting('p1', 'fld-club', CORN, 0, 63.22)
    const t = trigger({ id: 't2', entity_id: null, landowner_id: REBMAN, insured_name: 'AF REBMAN RESIDUARY TRUST', reported_acres: 15.805, trigger_yield: 154.2, approved_yield: 192.8, aph_yield: 173 })
    const units = buildClaimCheck(input({ resolved: [resolved(p, 13994)], triggers: [t] }))
    const land = units.find((u) => u.insuredKind === 'landowner')!
    expect(land.insuredName).toBe('AF Rebman Residuary Trust')
    expect(land.plantedAcres).toBeCloseTo(15.805, 3)
    expect(land.yieldToDate).toBeCloseTo(13994 / 63.22, 6)
    expect(land.trigger).toBe(154.2)
    expect(land.flags.map((f) => f.kind)).not.toContain('planted_acres')
    // The operator still has the whole field.
    expect(units.find((u) => u.insuredId === TS)!.plantedAcres).toBeCloseTo(63.22, 6)
  })

  it('no landlord unit when the landlord is not on any agent report', () => {
    const p = planting('p1', 'fld-club', CORN, 0, 63.22)
    expect(buildClaimCheck(input({ resolved: [resolved(p, 13994)] })).some((u) => u.insuredKind === 'landowner')).toBe(false)
  })

  it('flags the differences between the agent report and the policy on file', () => {
    const p = planting('p1', 'fld-goode', CORN, 0, 159.89)
    const units = buildClaimCheck(input({
      resolved: [resolved(p, 37146)],
      policies: [policy({ coverage_level: 0.75, insured_acres: 1284.4 })],
      triggers: [trigger({ sco_trigger_yield: 1997.7, expected_county_yield: 1068 })],
    }))
    const flags = units[0].flags
    const kinds = flags.map((f) => f.kind)
    expect(kinds).toEqual(expect.arrayContaining(['insured_acres', 'planted_acres', 'approved_yield', 'aph', 'coverage', 'county_trigger']))
    expect(flags.find((f) => f.kind === 'approved_yield')!.agentValue).toBe(193.8)
    expect(flags.find((f) => f.kind === 'county_trigger')!.forAgent).toMatch(/SCO trigger 1,997\.7/)
  })

  it('an agent unit with no policy and no fields still shows, flagged', () => {
    const units = buildClaimCheck(input({ triggers: [trigger({ entity_id: VC, practice: 'irrigated' })] }))
    expect(units).toHaveLength(1)
    expect(units[0].flags.map((f) => f.kind)).toEqual(expect.arrayContaining(['no_policy', 'no_planted']))
    expect(units[0].status).toBe('not_started')
  })

  it('planted with no policy and no agent row is no_coverage, flagged uninsured', () => {
    const p = planting('p1', 'fld-goode', COTTON, 0, 100)
    const u = buildClaimCheck(input({ resolved: [resolved(p, 120000)] }))[0]
    expect(u.status).toBe('no_coverage')
    expect(u.unit).toBe('lbs')
    expect(u.flags.map((f) => f.kind)).toContain('uninsured')
  })

  it('the entity filter keeps that entity and the landlords on its farms', () => {
    const p = planting('p1', 'fld-club', CORN, 0, 63.22)
    const q = planting('p2', 'fld-joe', CORN, 0, 100)
    const t = trigger({ id: 't2', entity_id: null, landowner_id: REBMAN, trigger_yield: 154.2 })
    const units = buildClaimCheck(input({ resolved: [resolved(p, 13994), resolved(q, 20000)], triggers: [t], entityId: TS }))
    expect(units.map((u) => u.insuredId).sort()).toEqual([REBMAN, TS])
  })
})

describe('the reply', () => {
  const a = planting('p1', 'fld-goode', CORN, 0, 100)
  const b = planting('p2', 'fld-duck', CORN, 0, 100)

  it('says no claims needed, and lists each unit with its yield and trigger', () => {
    const units = buildClaimCheck(input({ resolved: [resolved(a, 20830), resolved(b, 20830)], triggers: [trigger({ reported_acres: 200 })] }))
    const text = buildAgentReply(units, { claimKeys: defaultClaimKeys(units), includeQuestions: true, greetingName: 'Jacob', signature: 'Stuart' })
    expect(text).toMatch(/^Jacob,/)
    expect(text).toContain('Two Seasons Farm, LLC')
    expect(text).toContain('Lawrence corn (dryland): harvest complete, 208.3 bu vs. trigger 155.0 — no claim needed.')
    expect(text).toContain("We don't need any claims opened.")
    expect(text.trim().endsWith('Stuart')).toBe(true)
  })

  it('asks for a claim on a unit below its trigger by default', () => {
    const units = buildClaimCheck(input({ resolved: [resolved(a, 12000)], triggers: [trigger({ reported_acres: 100 })] }))
    const keys = defaultClaimKeys(units)
    expect(keys.size).toBe(1)
    const text = buildAgentReply(units, { claimKeys: keys, includeQuestions: false })
    expect(text).toContain('please open a claim')
    expect(text).toContain('Please open a claim on: Two Seasons Farm, LLC Lawrence corn (dryland).')
  })

  it('a partial unit says so and promises a follow-up', () => {
    const units = buildClaimCheck(input({ resolved: [resolved(a, 20000)], inProgress: [b], triggers: [trigger({ reported_acres: 200 })] }))
    expect(unitReplyLine(units[0], false)).toBe("Lawrence corn (dryland): 50% of acres harvested, 200.0 bu so far vs. trigger 155.0 — no claim at this time; we'll confirm when harvest is complete.")
    expect(buildAgentReply(units, { claimKeys: new Set(), includeQuestions: false })).toContain('still being harvested')
  })

  it('includes the agent questions only when asked', () => {
    const units = buildClaimCheck(input({ resolved: [resolved(a, 20000)], triggers: [trigger({ reported_acres: 100, sco_trigger_yield: 1997.7, expected_county_yield: 1068 })] }))
    expect(buildAgentReply(units, { claimKeys: new Set(), includeQuestions: true })).toContain('One thing to double-check on your side:')
    expect(buildAgentReply(units, { claimKeys: new Set(), includeQuestions: false })).not.toContain('double-check')
  })
})
