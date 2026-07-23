// Crop Insurance CLAIMS AUDIT — an INDEPENDENT re-computation of every
// indemnity leg, written fresh from the formulas (deliberately NOT calling
// anything in lib/crop-insurance.ts). The Claims Monitor's audit mode
// (?audit=1) runs every policy × practice row through BOTH implementations
// and flags any leg where they disagree by more than $1/acre — a disagreement
// means one of the two transcriptions of the formula is wrong and must be
// reconciled by hand.
//
// Everything here is plain arithmetic on the row's actual current inputs; the
// UI supplies the same numbers it feeds the production engine plus their
// provenance (harvest source, yield-basis source, county-assumption pieces).

export type AuditCountyInputs = {
  /** RMA final county yield — pins everything. */
  final: number | null
  /** Absolute county override — wins over the differential. */
  override: number | null
  /** "My yield − county" differential (crop's own unit). */
  differential: number | null
  /** The farm yield basis the differential subtracts from. */
  farmBasis: number | null
}

export type AuditCountyEstimate = { value: number; source: 'final' | 'override' | 'differential' | 'expected' }

/** Independent county-estimate resolution: final > override > basis − diff >
 *  RMA expected. (Mirrors the documented precedence, implemented fresh.) */
export function auditCountyEstimate(county: AuditCountyInputs, rmaExpected: number): AuditCountyEstimate {
  if (county.final != null) return { value: county.final, source: 'final' }
  if (county.override != null) return { value: county.override, source: 'override' }
  if (county.differential != null && county.farmBasis != null) {
    return { value: Math.max(0, county.farmBasis - county.differential), source: 'differential' }
  }
  return { value: rmaExpected, source: 'expected' }
}

export type AuditBandConfig = {
  /** Band top (the trigger ratio) — SCO 0.86, ECO 0.90/0.95. */
  trigger: number
  /** Band bottom — SCO: the policy coverage level; ECO: the SCO trigger. */
  lower: number
  /** RMA expected county yield for the endorsement. */
  expectedCountyYield: number
}

export type AuditStaxConfig = {
  coverageRangeTop: number
  coveragePct: number
  protectionFactor: number
  expectedCountyRevenue: number | null
}

export type AuditMcoConfig = {
  triggerLevel: number
  expectedMargin: number | null
  inputCostAdjustment: number
  expectedCountyYield: number | null
}

export type AuditInputs = {
  planType: 'RP' | 'RP_HPE' | 'YP' | 'ARP' | 'AYP'
  coverageLevel: number
  aphYield: number
  projectedPrice: number
  harvestPrice: number
  insuredAcres: number
  /** The farm yield the row is being evaluated at (per-practice basis). */
  actualYield: number
  expectedCountyYield: number | null
  expectedCountyRevenue: number | null
  protectionFactor: number | null
  county: AuditCountyInputs
  sco: AuditBandConfig | null
  eco: AuditBandConfig | null
  stax: AuditStaxConfig | null
  mco: AuditMcoConfig | null
}

export type AuditResult = {
  guaranteePrice: number
  revenueGuarantee: number
  expectedRevenue: number
  base: number
  sco: number | null
  eco: number | null
  stax: number | null
  mco: number | null
  total: number
  /** Resolved county estimate + source used by the county legs (null when the
   *  row has no county leg). */
  countyEstimate: AuditCountyEstimate | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** Fresh transcription of every leg. */
export function auditPolicyIndemnities(inp: AuditInputs): AuditResult {
  // Guarantee price: RP and YP look up to harvest; RP-HPE stays at projected.
  const gp = inp.planType === 'RP_HPE' ? inp.projectedPrice : Math.max(inp.projectedPrice, inp.harvestPrice)

  const needsCounty = inp.sco != null || inp.eco != null || inp.stax != null || inp.mco != null ||
    inp.planType === 'ARP' || inp.planType === 'AYP'
  const rmaExpectedForCounty = inp.sco?.expectedCountyYield
    ?? inp.eco?.expectedCountyYield
    ?? inp.mco?.expectedCountyYield
    ?? inp.expectedCountyYield
    ?? 0
  const county = needsCounty ? auditCountyEstimate(inp.county, rmaExpectedForCounty) : null

  // ---------- base ----------
  let base = 0
  let revenueGuarantee = 0
  let expectedRevenue = 0
  if (inp.planType === 'ARP') {
    const expY = inp.expectedCountyYield != null && inp.expectedCountyYield > 0
      ? inp.expectedCountyYield
      : gp > 0 && inp.expectedCountyRevenue != null ? inp.expectedCountyRevenue / gp : 0
    const est = auditCountyEstimate(inp.county, expY).value
    const pf = inp.protectionFactor ?? 1
    const expRev = inp.expectedCountyRevenue != null ? inp.expectedCountyRevenue : expY * gp
    const trigger = inp.coverageLevel * expRev
    const actual = est * inp.harvestPrice
    revenueGuarantee = r2(trigger * pf * inp.insuredAcres)
    expectedRevenue = r2(actual * inp.insuredAcres)
    base = r2(Math.max(0, trigger - actual) * pf * inp.insuredAcres)
  } else if (inp.planType === 'AYP') {
    const expY = inp.expectedCountyYield ?? 0
    const est = auditCountyEstimate(inp.county, expY).value
    const pf = inp.protectionFactor ?? 1
    const triggerYield = inp.coverageLevel * expY
    revenueGuarantee = r2(triggerYield * gp * pf * inp.insuredAcres)
    expectedRevenue = r2(est * inp.harvestPrice * inp.insuredAcres)
    base = r2(Math.max(0, triggerYield - est) * gp * pf * inp.insuredAcres)
  } else if (inp.planType === 'YP') {
    const guaranteeBu = inp.aphYield * inp.coverageLevel * inp.insuredAcres
    const actualBu = inp.actualYield * inp.insuredAcres
    revenueGuarantee = r2(guaranteeBu * gp)
    expectedRevenue = r2(inp.actualYield * inp.harvestPrice * inp.insuredAcres)
    base = r2(Math.max(0, guaranteeBu - actualBu) * gp)
  } else {
    // RP / RP-HPE
    revenueGuarantee = r2(inp.aphYield * inp.coverageLevel * gp * inp.insuredAcres)
    expectedRevenue = r2(inp.actualYield * inp.harvestPrice * inp.insuredAcres)
    base = r2(Math.max(0, revenueGuarantee - expectedRevenue))
  }

  // ---------- county bands (SCO / ECO) ----------
  const revenueBased = inp.planType !== 'YP'
  const band = (cfg: AuditBandConfig | null): number | null => {
    if (!cfg || !county) return cfg ? 0 : null
    const width = cfg.trigger - cfg.lower
    if (width <= 0) return 0
    const limit = width * inp.aphYield * gp * inp.insuredAcres
    const ratio = revenueBased
      ? (cfg.expectedCountyYield * gp > 0 ? (county.value * inp.harvestPrice) / (cfg.expectedCountyYield * gp) : 0)
      : (cfg.expectedCountyYield > 0 ? county.value / cfg.expectedCountyYield : 0)
    if (ratio >= cfg.trigger) return 0
    return r2((Math.min(cfg.trigger - ratio, width) / width) * limit)
  }
  const sco = band(inp.sco)
  const eco = band(inp.eco)

  // ---------- STAX ----------
  let stax: number | null = null
  if (inp.stax && county) {
    const expRev = inp.stax.expectedCountyRevenue != null
      ? inp.stax.expectedCountyRevenue
      : (inp.expectedCountyYield ?? 0) * gp
    const ratio = expRev > 0 ? (county.value * inp.harvestPrice) / expRev : 0
    const width = inp.stax.coveragePct
    const limit = width * expRev * inp.stax.protectionFactor * inp.insuredAcres
    stax = width > 0 && ratio < inp.stax.coverageRangeTop
      ? r2((Math.min(inp.stax.coverageRangeTop - ratio, width) / width) * limit)
      : 0
  }

  // ---------- MCO ----------
  let mco: number | null = null
  if (inp.mco && county) {
    const expMargin = inp.mco.expectedMargin ?? 0
    const expY = inp.mco.expectedCountyYield ?? inp.expectedCountyYield ?? 0
    const expCost = expY * gp - expMargin
    const actMargin = county.value * inp.harvestPrice - (expCost + inp.mco.inputCostAdjustment)
    const ratio = expMargin > 0 ? actMargin / expMargin : 0
    const width = inp.mco.triggerLevel - 0.86
    const limit = width * expMargin * inp.insuredAcres
    mco = width > 0 && expMargin > 0 && ratio < inp.mco.triggerLevel
      ? r2((Math.min(inp.mco.triggerLevel - ratio, width) / width) * limit)
      : 0
  }

  return {
    guaranteePrice: gp,
    revenueGuarantee,
    expectedRevenue,
    base,
    sco,
    eco,
    stax,
    mco,
    total: r2(base + (sco ?? 0) + (eco ?? 0) + (stax ?? 0) + (mco ?? 0)),
    countyEstimate: county,
  }
}

// ---------- independent yield-basis provenance ----------

export type YieldBasisAudit = { value: number; source: 'actual_practice' | 'expected_practice' | 'expected_blended' | 'actual_crop' | 'mean_aph' }

/** Fresh re-derivation of the per-practice yield basis order: actual practice
 *  breakout → per-practice expected (blended fallback; actuals once harvest
 *  is complete) → mean APH. Compared against the production assumedYield. */
export function auditYieldBasis(args: {
  practice: 'irrigated' | 'non_irrigated'
  practiceActualYield: number | null
  expectedYieldIrr: number | null
  expectedYieldDry: number | null
  expectedYieldBlended: number | null
  harvestComplete: boolean
  actualCropYield: number | null
  meanAph: number
}): YieldBasisAudit {
  if (args.practiceActualYield != null) return { value: args.practiceActualYield, source: 'actual_practice' }
  const expectedPractice = args.practice === 'irrigated'
    ? args.expectedYieldIrr ?? args.expectedYieldBlended
    : args.expectedYieldDry ?? args.expectedYieldBlended
  if (expectedPractice != null && (!args.harvestComplete || args.actualCropYield == null)) {
    return {
      value: expectedPractice,
      source: (args.practice === 'irrigated' ? args.expectedYieldIrr : args.expectedYieldDry) != null
        ? 'expected_practice' : 'expected_blended',
    }
  }
  if (args.actualCropYield != null) return { value: args.actualCropYield, source: 'actual_crop' }
  return { value: args.meanAph, source: 'mean_aph' }
}

// ---------- comparison ----------

export type LegDelta = { leg: 'base' | 'sco' | 'eco' | 'stax' | 'mco' | 'total'; production: number; audit: number; deltaPerAcre: number }

export type AuditComparison = {
  deltas: LegDelta[]
  maxDeltaPerAcre: number
  /** true when any leg disagrees by more than $1/acre. */
  flagged: boolean
}

export function compareAudit(args: {
  production: { base: number; sco: number | null; eco: number | null; stax: number | null; mco: number | null; total: number }
  audit: AuditResult
  insuredAcres: number
}): AuditComparison {
  const acres = args.insuredAcres > 0 ? args.insuredAcres : 1
  const pair = (leg: LegDelta['leg'], p: number | null, a: number | null): LegDelta => ({
    leg,
    production: p ?? 0,
    audit: a ?? 0,
    deltaPerAcre: Math.abs((p ?? 0) - (a ?? 0)) / acres,
  })
  const deltas = [
    pair('base', args.production.base, args.audit.base),
    pair('sco', args.production.sco, args.audit.sco),
    pair('eco', args.production.eco, args.audit.eco),
    pair('stax', args.production.stax, args.audit.stax),
    pair('mco', args.production.mco, args.audit.mco),
    pair('total', args.production.total, args.audit.total),
  ]
  const maxDeltaPerAcre = Math.max(...deltas.map((d) => d.deltaPerAcre))
  return { deltas, maxDeltaPerAcre, flagged: maxDeltaPerAcre > 1 }
}

// ---------- standing invariants ----------

export type InvariantCheck = { name: string; status: 'pass' | 'fail' | 'n/a'; note: string }

export function auditInvariants(args: {
  planType: AuditInputs['planType']
  aphYield: number
  actualYield: number
  projectedPrice: number
  harvestPrice: number
  baseIndemnity: number
  isCotton: boolean
  countyLegSources: Array<string | undefined>
}): InvariantCheck[] {
  const out: InvariantCheck[] = []
  const farmBased = args.planType === 'RP' || args.planType === 'RP_HPE' || args.planType === 'YP'
  if (farmBased && args.actualYield >= args.aphYield && args.harvestPrice >= args.projectedPrice) {
    out.push({
      name: 'yield ≥ APH & harvest ≥ projected ⇒ base $0',
      status: args.baseIndemnity === 0 ? 'pass' : 'fail',
      note: args.baseIndemnity === 0 ? 'base $0 as required' : `base pays $${args.baseIndemnity} — impossible state`,
    })
  } else {
    out.push({ name: 'yield ≥ APH & harvest ≥ projected ⇒ base $0', status: 'n/a', note: 'precondition not met' })
  }
  if (args.countyLegSources.length > 0) {
    const unlabeled = args.countyLegSources.filter((s) => !s).length
    out.push({
      name: 'county legs labeled with source',
      status: unlabeled === 0 ? 'pass' : 'fail',
      note: unlabeled === 0 ? 'every county leg carries its source' : `${unlabeled} county leg(s) missing a source`,
    })
  } else {
    out.push({ name: 'county legs labeled with source', status: 'n/a', note: 'no county legs' })
  }
  if (args.isCotton) {
    const ok = args.projectedPrice < 5 && args.harvestPrice < 5
    out.push({
      name: 'cotton prices in $/lb',
      status: ok ? 'pass' : 'fail',
      note: ok ? `proj ${args.projectedPrice} / harv ${args.harvestPrice} $-range` : `price ≥ 5 — ¢/lb leaking into $ math`,
    })
  } else {
    out.push({ name: 'cotton prices in $/lb', status: 'n/a', note: 'not cotton' })
  }
  return out
}
