// Seed production contract math (077) — hand-verified from the reference
// agreement shape (2026 Bayer Soybean Seed Grower Agreement, Southern
// Exhibit C): 300 committed acres (108.6 irrigated), 50 bu/ac forecast
// (15,000 estimated bu), premium stack $1.15/bu base + $0.25/bu irrigated-
// only, capped at $1.40/bu, $0.50/bu usage fee, grower-timed elections
// against Bunge Decatur AL, 80/20 staged payments, storage pay monthly.

import { describe, expect, it } from 'vitest'
import {
  SEED_OUTCOMES, SEED_PREMIUM_TEMPLATE, blendedElectedPrice, buildSeedCommitments,
  classifyExtractedPremiums, cumulativePricedPct,
  defaultFinalSettlementDate, effectivePriceWalk, missingPremiumRows, premiumPerBu,
  seedCashFlowEvents, seedCommittedProduction, seedMarketingPosition,
  seedTrackerProgress, validExtractedPremiums, validateElectionPct,
} from '@/lib/seed-contracts'
import type {
  SeedContractDetails, SeedContractPayment, SeedContractPremium,
  SeedCropCommitment, SeedPricingElection,
} from '@/lib/seed-contracts'
import { aggregateMarketing, computeMarketing } from '@/lib/marketing'
import { computeRevenueProjections } from '@/lib/revenue-projections'
import type { Contract, Crop, CropAssumption } from '@/lib/types'

// The Bayer-style premium schedule: accepted pays the full stack.
const PREMIUMS: SeedContractPremium[] = [
  { outcome: 'accepted', component: 'Production premium', amount_per_bu: 1.15, applies_to: 'all' },
  { outcome: 'accepted', component: 'Irrigated production', amount_per_bu: 0.25, applies_to: 'irrigated_only' },
  { outcome: 'released_post_harvest', component: 'Release premium', amount_per_bu: 0.4, applies_to: 'all' },
]

const DETAILS: SeedContractDetails = {
  id: 'd1', contract_id: 'sc1',
  production_site: 'Hurt Seed Company, Halls TN',
  brand: 'Asgrow', variety: 'AG55XF5',
  contract_acres: 300, forecast_bu_per_acre: 50, estimated_bushels: 15000,
  local_market_elevator: 'Bunge Decatur AL',
  pricing_deadline: '2027-04-29',
  premium_cap_per_bu: 1.4,
  storage_pay_per_bu_month: 0.03, storage_pay_start_date: '2026-12-01',
  usage_fee_per_bu: 0.5,
  expected_outcome: 'accepted',
  final_settlement_date: '2027-03-15',
  notes: null,
}

const IRR_SHARE = 108.6 / 300 // 0.362

function election(pct: number, price: number, date = '2026-11-03'): SeedPricingElection {
  return { id: `e${pct}`, contract_id: 'sc1', election_date: date, pct_of_bushels: pct, price_per_bu: price, method: 'market', notes: null }
}

describe('premium stack (irr/dry weighted, capped)', () => {
  it('accepted outcome: $1.15 all + $0.25 irrigated-only, cap $1.40 — 108.6 irr ac of 300', () => {
    const p = premiumPerBu({ premiums: PREMIUMS, outcome: 'accepted', irrigatedShare: IRR_SHARE, capPerBu: 1.4 })
    // Irrigated bushels: 1.15 + 0.25 = 1.40, exactly at the cap; dryland 1.15.
    expect(p.irrigatedRate).toBe(1.4)
    expect(p.drylandRate).toBe(1.15)
    // Weighted: 0.362 × 1.40 + 0.638 × 1.15 = 0.5068 + 0.7337 = 1.2405
    expect(p.weighted).toBeCloseTo(1.2405, 10)
    expect(p.capped).toBe(false) // 1.40 hits but does not exceed the cap
  })

  it('the cap binds when the stack exceeds it', () => {
    const extra: SeedContractPremium[] = [
      ...PREMIUMS,
      { outcome: 'accepted', component: 'Early delivery', amount_per_bu: 0.1, applies_to: 'irrigated_only' },
    ]
    const p = premiumPerBu({ premiums: extra, outcome: 'accepted', irrigatedShare: 1, capPerBu: 1.4 })
    expect(p.irrigatedRate).toBe(1.4) // 1.50 capped at 1.40
    expect(p.capped).toBe(true)
  })

  it('other outcomes read their own rows; rejected pays nothing', () => {
    const released = premiumPerBu({ premiums: PREMIUMS, outcome: 'released_post_harvest', irrigatedShare: IRR_SHARE, capPerBu: 1.4 })
    expect(released.weighted).toBeCloseTo(0.4, 10)
    const rejected = premiumPerBu({ premiums: PREMIUMS, outcome: 'rejected', irrigatedShare: IRR_SHARE, capPerBu: 1.4 })
    expect(rejected.weighted).toBe(0)
  })
})

describe('standard premium template (Bayer Southern)', () => {
  it('carries ALL FOUR outcomes with the full component stack', () => {
    const byOutcome = new Map<string, typeof SEED_PREMIUM_TEMPLATE[number][]>()
    for (const p of SEED_PREMIUM_TEMPLATE) {
      const arr = byOutcome.get(p.outcome) ?? []
      arr.push(p)
      byOutcome.set(p.outcome, arr)
    }
    for (const o of SEED_OUTCOMES) expect(byOutcome.has(o), `missing outcome ${o}`).toBe(true)
    const stack = (o: string) => (byOutcome.get(o) ?? []).map((p) => `${p.component}|${p.amount_per_bu}|${p.applies_to}`).sort()
    expect(stack('accepted')).toEqual([
      'Irrigation premium|0.25|irrigated_only',
      'Production premium|0.5|all',
      'Usage premium|0.65|all',
    ])
    expect(stack('released_post_harvest')).toEqual([
      'Irrigation premium|0.25|irrigated_only',
      'Post-harvest release premium|0.45|all',
      'Production premium|0.5|all',
    ])
    expect(stack('released_pre_harvest')).toEqual([
      'Irrigation premium|0.25|irrigated_only',
      'Pre-harvest release premium|0.2|all',
      'Production premium|0.5|all',
    ])
    expect(stack('rejected')).toEqual([
      'Irrigation premium|0.25|irrigated_only',
      'Production premium|0.5|all',
    ])
  })

  it('accepted at the $1.40 cap: $1.15 dryland / $1.40 irrigated', () => {
    const p = premiumPerBu({ premiums: [...SEED_PREMIUM_TEMPLATE], outcome: 'accepted', irrigatedShare: 1, capPerBu: 1.4 })
    expect(p.drylandRate).toBeCloseTo(1.15, 10) // 0.50 + 0.65
    expect(p.irrigatedRate).toBeCloseTo(1.4, 10) // 0.50 + 0.65 + 0.25, exactly at the cap
  })
})

describe('extracted-premium classification (the partial-schedule guard)', () => {
  const row = (over: Partial<{ outcome: string | null; component: string | null; amount_per_bu: number | null; applies_to: string | null }>) => ({
    outcome: 'accepted' as string | null, component: 'Production premium' as string | null,
    amount_per_bu: 0.5 as number | null, applies_to: 'all' as string | null, ...over,
  })

  it('complete: valid rows cover all four outcomes with nothing dropped', () => {
    const rows = SEED_OUTCOMES.map((o) => row({ outcome: o }))
    expect(classifyExtractedPremiums(rows)).toBe('complete')
  })

  it('partial: outcomes missing, or rows dropped for unreadable amounts — never auto-applied', () => {
    // Only the accepted rows read → partial.
    expect(classifyExtractedPremiums([row({}), row({ component: 'Usage premium', amount_per_bu: 0.65 })])).toBe('partial')
    // All four outcomes present but one row's amount unreadable → partial.
    const rows = [...SEED_OUTCOMES.map((o) => row({ outcome: o })), row({ component: 'Usage premium', amount_per_bu: null })]
    expect(classifyExtractedPremiums(rows)).toBe('partial')
    // The unreadable row is dropped from the usable set, never kept as $0.
    expect(validExtractedPremiums(rows)).toHaveLength(4)
  })

  it('none: nothing usable (Exhibit C absent / unreadable)', () => {
    expect(classifyExtractedPremiums([])).toBe('none')
    expect(classifyExtractedPremiums([row({ amount_per_bu: null }), row({ component: null })])).toBe('none')
    expect(classifyExtractedPremiums([row({ outcome: 'something else' })])).toBe('none')
  })
})

describe('missing-outcome guard', () => {
  it('flags an outcome with NO rows (distinct from a genuine $0 stack)', () => {
    expect(missingPremiumRows(PREMIUMS, 'accepted')).toBe(false)
    // The fixture has no rejected rows at all → missing, even though the
    // arithmetic premium would also be $0 for a real all-$0 schedule.
    expect(missingPremiumRows(PREMIUMS, 'rejected')).toBe(true)
    expect(missingPremiumRows([...SEED_PREMIUM_TEMPLATE], 'rejected')).toBe(false)
  })

  it('seedMarketingPosition raises missingPremiums and projects base-only', () => {
    const committed = { bushels: 15000, actual: false, irrigatedShare: IRR_SHARE, fromEstimate: false }
    const pos = seedMarketingPosition([{
      contractId: 'sc1', buyerName: 'Bayer', contractNumber: 'BAY-2026-001',
      committed,
      details: { ...DETAILS, expected_outcome: 'rejected' }, // no rejected rows in PREMIUMS
      premiums: PREMIUMS, elections: [election(100, 10.4)],
    }], null)
    expect(pos.missingPremiums).toBe(true)
    expect(pos.premiumPerBu).toBe(0)
    // Base-only: 15,000 × (10.40 − 0.50 usage fee).
    expect(pos.revenue).toBeCloseTo(15000 * (10.4 - 0.5), 6)
    // A complete schedule never flags.
    const ok = seedMarketingPosition([{
      contractId: 'sc1', buyerName: 'Bayer', contractNumber: 'BAY-2026-001',
      committed, details: DETAILS, premiums: [...SEED_PREMIUM_TEMPLATE], elections: [election(100, 10.4)],
    }], null)
    expect(ok.missingPremiums).toBe(false)
  })
})

describe('repaired walk (#4600039602 shape): base $13.43 + the accepted stack', () => {
  it('elect $13.43 on 100%: dryland +$1.15 / irrigated +$1.40, weighted on 108.6 irr of 300 ac', () => {
    const w = effectivePriceWalk({
      details: DETAILS, // cap $1.40, usage fee $0.50, expected outcome accepted
      premiums: [...SEED_PREMIUM_TEMPLATE],
      elections: [election(100, 13.43)],
      referencePlusBasis: null,
      irrigatedShare: IRR_SHARE,
    })
    expect(w.blendedBase).toBeCloseTo(13.43, 10)
    expect(w.premium.drylandRate).toBeCloseTo(1.15, 10)
    expect(w.premium.irrigatedRate).toBeCloseTo(1.4, 10)
    // Weighted: 0.362 × 1.40 + 0.638 × 1.15 = 1.2405
    expect(w.premium.weighted).toBeCloseTo(1.2405, 10)
    // Net = 13.43 + 1.2405 − 0.50 usage fee = 14.1705
    expect(w.expectedNetPerBu).toBeCloseTo(14.1705, 10)
  })
})

describe('pricing elections', () => {
  it('validates increments and the cumulative 100% ceiling', () => {
    expect(validateElectionPct([], 25)).toBeNull()
    expect(validateElectionPct([], 30)).toMatch(/25, 50, 75, or 100/)
    expect(validateElectionPct([election(25, 10), election(50, 10.2)], 50)).toMatch(/Only 25% /)
    expect(validateElectionPct([election(100, 10.4)], 25)).toMatch(/already fully priced/)
    expect(validateElectionPct([election(25, 10), election(50, 10.2)], 25)).toBeNull()
  })

  it('blends elected prices pct-weighted', () => {
    // 25% at $10.00 + 50% at $10.60 → (25×10 + 50×10.6) / 75 = 10.40
    expect(blendedElectedPrice([election(25, 10), election(50, 10.6)])).toBeCloseTo(10.4, 10)
    expect(cumulativePricedPct([election(25, 10), election(50, 10.6)])).toBe(75)
    expect(blendedElectedPrice([])).toBeNull()
  })
})

describe('effective price walk', () => {
  it('elect $10.40 on 100%, accepted: 10.40 + 1.2405 − 0.50 = $11.1405 net', () => {
    const w = effectivePriceWalk({
      details: DETAILS, premiums: PREMIUMS,
      elections: [election(100, 10.4)],
      referencePlusBasis: null, irrigatedShare: IRR_SHARE,
    })
    expect(w.pricedPct).toBe(100)
    expect(w.electedPrice).toBeCloseTo(10.4, 10)
    expect(w.blendedBase).toBeCloseTo(10.4, 10)
    expect(w.premium.weighted).toBeCloseTo(1.2405, 10)
    expect(w.expectedNetPerBu).toBeCloseTo(11.1405, 10)
  })

  it('50% elected + 50% unpriced blends with the reference proxy', () => {
    const w = effectivePriceWalk({
      details: DETAILS, premiums: PREMIUMS,
      elections: [election(50, 10.4)],
      referencePlusBasis: 10.0, irrigatedShare: IRR_SHARE,
    })
    // (10.40 × 50 + 10.00 × 50) / 100 = 10.20
    expect(w.blendedBase).toBeCloseTo(10.2, 10)
    expect(w.expectedNetPerBu).toBeCloseTo(10.2 + 1.2405 - 0.5, 10)
  })
})

describe('committed production: estimate → actual', () => {
  it('no linked plantings → the agreement estimate (acres × forecast)', () => {
    const c = seedCommittedProduction({ details: DETAILS, linked: [], estimateIrrigatedShare: IRR_SHARE })
    expect(c.bushels).toBe(15000)
    expect(c.fromEstimate).toBe(true)
    expect(c.actual).toBe(false)
  })

  it('linked plantings: estimated until every one is harvest-complete, then actual', () => {
    const est = seedCommittedProduction({
      details: DETAILS,
      linked: [
        { bushels: 8000, irrigatedBushels: null, plantedAcres: 160, irrigatedAcres: 108.6, harvestComplete: false },
        { bushels: 7000, irrigatedBushels: null, plantedAcres: 140, irrigatedAcres: 0, harvestComplete: false },
      ],
    })
    expect(est.bushels).toBe(15000)
    expect(est.actual).toBe(false)
    // acre-share irrigation split: 108.6 / 300
    expect(est.irrigatedShare).toBeCloseTo(IRR_SHARE, 10)

    const act = seedCommittedProduction({
      details: DETAILS,
      linked: [
        { bushels: 8400, irrigatedBushels: 6000, plantedAcres: 160, irrigatedAcres: 108.6, harvestComplete: true },
        { bushels: 6800, irrigatedBushels: 0, plantedAcres: 140, irrigatedAcres: 0, harvestComplete: true },
      ],
    })
    expect(act.bushels).toBe(15200)
    expect(act.actual).toBe(true)
    // bushel breakout wins: 6,000 / 15,200
    expect(act.irrigatedShare).toBeCloseTo(6000 / 15200, 10)
  })
})

describe('marketing position', () => {
  const committed = { bushels: 15000, actual: false, irrigatedShare: IRR_SHARE, fromEstimate: false }
  const commitment = (elections: SeedPricingElection[]): SeedCropCommitment => ({
    contractId: 'sc1', buyerName: 'Bayer', contractNumber: 'BAY-2026-001',
    committed, details: DETAILS, premiums: PREMIUMS, elections,
  })

  it('50% elected at $10.40 + 50% unpriced at a $10.00 proxy', () => {
    const pos = seedMarketingPosition([commitment([election(50, 10.4)])], 10.0)
    expect(pos.committedBu).toBe(15000)
    expect(pos.electedBu).toBe(7500)
    expect(pos.unpricedBu).toBe(7500)
    expect(pos.electedAvgPrice).toBeCloseTo(10.4, 10)
    expect(pos.premiumPerBu).toBeCloseTo(1.2405, 10)
    // elected: 7,500 × 10.40 = 78,000 base + 7,500 × (1.2405 − 0.50) = 5,553.75
    // unpriced: 7,500 × (10.00 + 1.2405 − 0.50) = 80,553.75
    expect(pos.revenue).toBeCloseTo(78000 + 5553.75 + 80553.75, 6)
    expect(pos.unpricedNetPerBu).toBeCloseTo(10.7405, 10)
    expect(pos.buyers).toEqual(['Bayer'])
    expect(pos.estimated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Engine integration: the seed commitment inside computeMarketing

const CROP: Crop = { id: 'soy', name: 'Soybeans', base_moisture_pct: 13, base_lb_per_bushel: 60 } as unknown as Crop

function assumption(over: Partial<CropAssumption> = {}): CropAssumption {
  return {
    id: 'a1', crop_id: 'soy', crop_year: 2026,
    expected_yield: 50, harvest_complete: false, cost_per_acre: 500,
    assumed_basis: -0.4, assumed_futures: 10.4,
    ...over,
  } as CropAssumption
}

function grainContract(over: Partial<Contract> = {}): Contract {
  return {
    id: 'c1', contract_number: 'G-1', buyer_id: null, crop_id: 'soy', entity_id: null,
    crop_year: 2026, contracted_bushels: 5000, price_per_bushel: 10.5, notes: null,
    delivery_type: 'delivered', delivery_location_id: null, delivery_start_date: null,
    delivery_end_date: null, completed_at: null, date_sold: null, created_at: '',
    contract_month: null, contract_type: 'forward', futures_price: null, basis: null,
    cash_price: 10.5, service_fee: 0, futures_set_date: null, basis_set_date: null,
    pricing_status: 'fully_priced',
    ...over,
  }
}

function seedMarketingRow(elections: SeedPricingElection[], extraContracts: Contract[] = []) {
  // 1,000 planted acres, 50 bu/ac expected → 50,000 bu production; the seed
  // contract commits 300 of those acres (15,000 bu).
  const committed = { bushels: 15000, actual: false, irrigatedShare: IRR_SHARE, fromEstimate: false }
  const commitments: SeedCropCommitment[] = [{
    contractId: 'sc1', buyerName: 'Bayer', contractNumber: 'BAY-2026-001',
    committed, details: DETAILS, premiums: PREMIUMS, elections,
  }]
  const rows = computeMarketing({
    cropYear: 2026,
    crops: [CROP],
    plantings: [{ crop_id: 'soy', season_year: 2026, planted_acres: 1000 }],
    contracts: [
      ...extraContracts,
      // The seed contract's own contracts row must be EXCLUDED from grain math.
      grainContract({ id: 'sc1', contract_number: 'BAY-2026-001', contracted_bushels: 15000, cash_price: null, price_per_bushel: null, contract_kind: 'seed_production' }),
    ],
    futures: [], options: [],
    assumptions: [assumption()],
    actualProductionByCrop: new Map(),
    seedCommitmentsByCrop: new Map([['soy', commitments]]),
  })
  return rows[0]
}

describe('computeMarketing with a seed commitment', () => {
  it('values 50% elected at $10.40 + 50% unpriced at reference+basis+premium, no double-count', () => {
    const row = seedMarketingRow([election(50, 10.4)], [grainContract()])
    expect(row.seed).not.toBeNull()
    expect(row.seed!.committedBu).toBe(15000)
    expect(row.seed!.electedBu).toBe(7500)
    expect(row.seed!.buyers).toEqual(['Bayer'])
    // Grain buckets exclude the seed contract's own contracts row entirely.
    expect(row.contractedBu).toBe(5000)
    // unsold = 50,000 − 5,000 grain − 15,000 seed = 30,000 unpriced
    expect(row.unpricedBu).toBe(30000)
    // remaining nets both books out.
    expect(row.remaining).toBe(30000)
    // Blended revenue foots by hand: unpriced proxy = assumed futures 10.40 −
    // 0.40 basis = 10.00.
    //   grain contract: 5,000 × 10.50 = 52,500
    //   unpriced:      30,000 × 10.00 = 300,000
    //   seed elected:   7,500 × 10.40 + 7,500 × 0.7405 = 83,553.75
    //   seed unpriced:  7,500 × 10.7405 = 80,553.75
    expect(row.blendedRevenue).toBeCloseTo(52500 + 300000 + 83553.75 + 80553.75, 6)
    // The unpriced seed bushels ride the assumed basis → basis blend counts them.
    expect(row.basisAssumedBu).toBe(30000 + 7500)
  })

  it('fully elected seed book is price-locked; only the premium stays an assumption', () => {
    const row = seedMarketingRow([election(100, 10.4)])
    expect(row.seed!.unpricedBu).toBe(0)
    // seed revenue: 15,000 × (10.40 + 1.2405 − 0.50) = 167,107.50
    const seedRevenue = 15000 * (10.4 + 1.2405 - 0.5)
    // unpriced grain: 35,000 × 10.00
    expect(row.blendedRevenue).toBeCloseTo(35000 * 10 + seedRevenue, 6)
  })

  it('all production from the seed fields is committed — grain contracts cap against the rest', () => {
    // Production 50,000; seed 15,000; grain book 40,000 > 35,000 capacity →
    // grain contracts scale by 35/40, seed never scales.
    const row = seedMarketingRow([], [grainContract({ contracted_bushels: 40000 })])
    // grain: 40,000 × (35,000/40,000) × 10.50 = 367,500
    // seed (all unpriced): 15,000 × 10.7405 = 161,107.50
    expect(row.blendedRevenue).toBeCloseTo(367500 + 161107.5, 6)
    expect(row.unpricedBu).toBe(0)
  })

  it('the reconciliation identity holds with a seed crop (aggregate = single rollup)', () => {
    const row = seedMarketingRow([election(50, 10.4)], [grainContract()])
    const agg = aggregateMarketing([row])
    const { totals } = computeRevenueProjections({
      marketingRows: [row],
      contracts: [grainContract()],
      cropYear: 2026,
      marketPriceByCrop: new Map(),
      insuranceByCrop: new Map([['soy', { netPnl: 12345, totalIndemnity: 15000, premium: 2655 }]]),
      govtByCrop: new Map([['soy', { arcPlc: 7000, cropSpecificOther: 0, allocatedOther: 0 }]]),
    })
    // RevProj profit − Marketing profit = insurance + government, to the cent.
    expect(totals.profit - (agg.totalProfit ?? 0)).toBeCloseTo(12345 + 7000, 6)
  })
})

// ---------------------------------------------------------------------------
// buildSeedCommitments: estimate → actual through the production seams

describe('buildSeedCommitments', () => {
  const bundle = {
    contract: { id: 'sc1', buyer_id: 'b1', crop_id: 'soy', crop_year: 2026, entity_id: null, contract_number: 'BAY-2026-001' },
    details: DETAILS, premiums: PREMIUMS, elections: [], payments: [],
    plantingIds: ['p1', 'p2'],
  }
  const plantings = [
    { id: 'p1', crop_id: 'soy', season_year: 2026, field_id: 'f1', planted_acres: 160, irrigated_acres: 108.6, dryland_acres: 51.4, irrigated_bushels: null, yield_breakout_entered: false },
    { id: 'p2', crop_id: 'soy', season_year: 2026, field_id: 'f2', planted_acres: 140, irrigated_acres: 0, dryland_acres: 140, irrigated_bushels: null, yield_breakout_entered: false },
  ]
  const assumptions = [{ crop_id: 'soy', crop_year: 2026, expected_yield: 50 }]

  it('estimates from expected yield × acres until harvest completes', () => {
    const m = buildSeedCommitments({
      bundles: [bundle], cropYear: 2026, plantings,
      aggByKey: new Map(), assumptions,
      harvestCompleteCropIds: new Set(),
      buyerNameById: new Map([['b1', 'Bayer']]),
    })
    const c = m.get('soy')![0]
    expect(c.committed.bushels).toBe(300 * 50)
    expect(c.committed.actual).toBe(false)
    expect(c.buyerName).toBe('Bayer')
  })

  it('switches to actual dry bushels from the yields aggregates once complete', () => {
    const m = buildSeedCommitments({
      bundles: [bundle], cropYear: 2026, plantings,
      aggByKey: new Map([
        ['f1|soy|2026', { dryBu: 8400 }],
        ['f2|soy|2026', { dryBu: 6800 }],
      ]),
      assumptions,
      harvestCompleteCropIds: new Set(['soy']),
      buyerNameById: new Map([['b1', 'Bayer']]),
    })
    const c = m.get('soy')![0]
    expect(c.committed.bushels).toBe(15200)
    expect(c.committed.actual).toBe(true)
  })

  it('applies the 051 attribution factor to the committed bushels', () => {
    const m = buildSeedCommitments({
      bundles: [bundle], cropYear: 2026, plantings,
      aggByKey: new Map(), assumptions,
      harvestCompleteCropIds: new Set(),
      buyerNameById: new Map(),
      shareForContract: () => 0.25,
    })
    expect(m.get('soy')![0].committed.bushels).toBe(3750)
  })
})

// ---------------------------------------------------------------------------
// Cash-flow staging

describe('seedCashFlowEvents', () => {
  const committed = { bushels: 15000, actual: false, irrigatedShare: IRR_SHARE, fromEstimate: false }

  it('stages 80% at the election, 20% + premiums at settlement, storage monthly, usage fee out', () => {
    const events = seedCashFlowEvents({
      details: DETAILS, premiums: PREMIUMS,
      elections: [election(100, 10.4, '2026-11-03')],
      payments: [], committed, referencePlusBasis: null,
      cropYear: 2026, contractLabel: 'Seed BAY-2026-001',
    })
    const byType = (t: string) => events.filter((e) => e.type === t)
    // 80% base: 0.8 × 15,000 × 10.40 = 124,800 in the election month.
    expect(byType('base_80')).toHaveLength(1)
    expect(byType('base_80')[0].month).toBe('2026-11')
    expect(byType('base_80')[0].amount).toBeCloseTo(124800, 6)
    // Final 20%: 0.2 × 15,000 × 10.40 = 31,200 at settlement (2027-03).
    expect(byType('base_final')[0].month).toBe('2027-03')
    expect(byType('base_final')[0].amount).toBeCloseTo(31200, 6)
    // Premiums: 15,000 × 1.2405 = 18,607.50 at settlement.
    expect(byType('premium')[0].amount).toBeCloseTo(18607.5, 6)
    // Storage: $0.03/bu/mo from Dec 2026 through Mar 2027 = 4 months × $450.
    const storage = byType('storage')
    expect(storage).toHaveLength(4)
    expect(storage.map((e) => e.month)).toEqual(['2026-12', '2027-01', '2027-02', '2027-03'])
    for (const s of storage) expect(s.amount).toBeCloseTo(450, 6)
    // Usage fee: −15,000 × 0.50 = −7,500.
    expect(byType('usage_fee')[0].amount).toBeCloseTo(-7500, 6)
  })

  it('unpriced bushels assume an election at the pricing deadline', () => {
    const events = seedCashFlowEvents({
      details: DETAILS, premiums: PREMIUMS,
      elections: [election(50, 10.4, '2026-11-03')],
      payments: [], committed, referencePlusBasis: 10.0,
      cropYear: 2026, contractLabel: 'Seed',
    })
    const base80 = events.filter((e) => e.type === 'base_80')
    expect(base80).toHaveLength(2)
    // Unpriced half: 0.8 × 7,500 × 10.00 = 60,000 at the 2027-04-29 deadline.
    const deadline = base80.find((e) => e.month === '2027-04')!
    expect(deadline.amount).toBeCloseTo(60000, 6)
  })

  it('ledger rows replace the projection for their type', () => {
    const payments: SeedContractPayment[] = [
      { id: 'p1', contract_id: 'sc1', payment_type: 'base_80', amount: 120000, payment_date: '2026-11-20', status: 'received', notes: null },
    ]
    const events = seedCashFlowEvents({
      details: DETAILS, premiums: PREMIUMS,
      elections: [election(100, 10.4)],
      payments, committed, referencePlusBasis: null,
      cropYear: 2026, contractLabel: 'Seed',
    })
    const base80 = events.filter((e) => e.type === 'base_80')
    expect(base80).toHaveLength(1)
    expect(base80[0].amount).toBe(120000)
    expect(base80[0].status).toBe('received')
  })

  it('defaults final settlement to March after the crop year', () => {
    expect(defaultFinalSettlementDate(2026)).toBe('2027-03-15')
  })
})

// ---------------------------------------------------------------------------
// Tracker progress

describe('seedTrackerProgress', () => {
  const committed = { bushels: 15000, actual: false, irrigatedShare: 0, fromEstimate: false }

  it('reports % priced and keys completion on the received final payment', () => {
    const open = seedTrackerProgress({
      elections: [election(25, 10), election(50, 10.2)],
      payments: [{ payment_type: 'base_80', status: 'received' }],
      committed,
    })
    expect(open.pricedPct).toBe(75)
    expect(open.completed).toBe(false)
    expect(open.productionLabel).toBe('estimated')

    const done = seedTrackerProgress({
      elections: [election(100, 10.4)],
      payments: [{ payment_type: 'base_final', status: 'received' }],
      committed: { ...committed, actual: true },
    })
    expect(done.pricedPct).toBe(100)
    expect(done.completed).toBe(true)
    expect(done.productionLabel).toBe('actual (harvested)')
  })
})
