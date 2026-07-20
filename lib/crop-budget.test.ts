import { describe, it, expect } from 'vitest'
import {
  aphWeightedYield, budgetLineMath, budgetSeeds, buildBudgetMatrix, scenarioTotals,
  compareScenarios, duplicateLinesFor, budgetContractSymbol, budgetContractLabel,
  lineDesignation,
  type BudgetLineInput,
} from '@/lib/crop-budget'
import { axisValues } from '@/lib/income-sensitivity'
import type { BudgetLine, CropInsurancePolicy } from '@/lib/types'

// Hand-verified worked examples — every expected number derived on paper.

type PolFixture = Pick<CropInsurancePolicy, 'crop_id' | 'crop_year' | 'aph_yield' | 'insured_acres' | 'plan_type'> & { practice: CropInsurancePolicy['practice'] | null }
const pol = (over: Partial<PolFixture>): PolFixture => ({
  crop_id: 'corn', crop_year: 2026, aph_yield: 180, insured_acres: 100, plan_type: 'RP', practice: 'non_irrigated', ...over,
})

describe('aphWeightedYield — acre-weighted APH seed from the most recent year', () => {
  it('two policies 100 ac @ 180 + 50 ac @ 170 → 176.7', () => {
    // (180×100 + 170×50) ÷ 150 = 26,500 ÷ 150 = 176.666… → 176.7
    const seed = aphWeightedYield([pol({}), pol({ aph_yield: 170, insured_acres: 50 })], 'corn')
    expect(seed).toEqual({ yield: 176.7, policyCount: 2, cropYear: 2026, practice: null })
  })

  it('only the MOST RECENT crop year weighs in', () => {
    const seed = aphWeightedYield([
      pol({ crop_year: 2025, aph_yield: 150 }),
      pol({ crop_year: 2026, aph_yield: 180 }),
    ], 'corn')
    expect(seed).toEqual({ yield: 180, policyCount: 1, cropYear: 2026, practice: null })
  })

  it('area plans (no APH) and other crops are skipped; none → null', () => {
    expect(aphWeightedYield([pol({ plan_type: 'ARP' })], 'corn')).toBeNull()
    expect(aphWeightedYield([pol({ crop_id: 'soy' })], 'corn')).toBeNull()
    expect(aphWeightedYield([], 'corn')).toBeNull()
  })

  it('a practice filters the weighting: irrigated policies only (missing practice = dryland)', () => {
    const mixed = [
      pol({ practice: 'irrigated', aph_yield: 210, insured_acres: 100 }),
      pol({ practice: 'irrigated', aph_yield: 200, insured_acres: 100 }),
      pol({ practice: null, aph_yield: 150, insured_acres: 300 }), // counts as dryland
    ]
    expect(aphWeightedYield(mixed, 'corn', 'irrigated')).toEqual({ yield: 205, policyCount: 2, cropYear: 2026, practice: 'irrigated' })
    expect(aphWeightedYield(mixed, 'corn', 'non_irrigated')).toEqual({ yield: 150, policyCount: 1, cropYear: 2026, practice: 'non_irrigated' })
    // Blended keeps weighting across everything: (210+200)×100 + 150×300 = 86,000 ÷ 500 = 172.
    expect(aphWeightedYield(mixed, 'corn', null)!.yield).toBe(172)
  })
})

// ---------------------------------------------------------------------------
// Practice / double-crop breakout seeds (049)
// ---------------------------------------------------------------------------

const seedAssumption = {
  expected_yield: 190, expected_yield_irr: 220, expected_yield_dry: 165,
  expected_yield_dc_irr: 55, expected_yield_dc_dry: 42,
  cost_per_acre: 750, cost_per_acre_irr: 880, cost_per_acre_dry: 640,
  cost_per_acre_dc_irr: 420, cost_per_acre_dc_dry: 360,
}

describe('budgetSeeds — practice/cropping-aware defaults', () => {
  const seedPolicies = [
    pol({ practice: 'irrigated', aph_yield: 210, insured_acres: 100 }),
    pol({ practice: 'non_irrigated', aph_yield: 150, insured_acres: 300 }),
  ]

  it('full-season irrigated: practice-filtered APH + irrigated cost', () => {
    const s = budgetSeeds({ policies: seedPolicies, assumption: seedAssumption, cropId: 'corn', practice: 'irrigated', cropping: null })
    expect(s.yield).toBe(210)
    expect(s.yieldSource).toBe('aph')
    expect(s.aph).toMatchObject({ policyCount: 1, practice: 'irrigated' })
    expect(s.cost).toBe(880)
  })

  it('no policies for the practice → the per-practice expected yield', () => {
    const s = budgetSeeds({ policies: [], assumption: seedAssumption, cropId: 'corn', practice: 'non_irrigated', cropping: null })
    expect(s.yield).toBe(165)
    expect(s.yieldSource).toBe('expected')
    expect(s.cost).toBe(640)
  })

  it('double-crop NEVER seeds from APH — the DC yield/cost breakouts drive it', () => {
    const s = budgetSeeds({ policies: seedPolicies, assumption: seedAssumption, cropId: 'corn', practice: 'non_irrigated', cropping: 'double_crop' })
    expect(s.yield).toBe(42) // dc_dry — not the 150 dryland APH
    expect(s.yieldSource).toBe('expected_dc')
    expect(s.aph).toBeNull()
    expect(s.cost).toBe(360)
    expect(s.costSource).toBe('assumption_dc')
    // Blended DC prefers dryland (the common DC practice).
    expect(budgetSeeds({ policies: seedPolicies, assumption: seedAssumption, cropId: 'corn', practice: null, cropping: 'double_crop' }).yield).toBe(42)
  })

  it('double-crop with no DC breakouts on file stays blank (no misleading APH)', () => {
    const s = budgetSeeds({
      policies: seedPolicies,
      assumption: { ...seedAssumption, expected_yield_dc_irr: null, expected_yield_dc_dry: null, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null },
      cropId: 'corn', practice: null, cropping: 'double_crop',
    })
    expect(s.yield).toBeNull()
    expect(s.cost).toBeNull()
  })
})

describe('breakout designation & comparison separation', () => {
  it('lineDesignation reads naturally', () => {
    expect(lineDesignation({ practice: 'irrigated', cropping: 'double_crop' })).toBe('Irrigated · Double-crop')
    expect(lineDesignation({ practice: 'non_irrigated', cropping: null })).toBe('Dryland')
    expect(lineDesignation({ practice: null, cropping: null })).toBe('')
  })

  it('compareScenarios keeps irrigated and dryland lines of the same crop separate', () => {
    const a = [
      { cropId: 'corn', label: null, practice: 'irrigated' as const, cropping: null, acres: 600, totalProfit: 120_000 },
      { cropId: 'corn', label: null, practice: 'non_irrigated' as const, cropping: null, acres: 400, totalProfit: 30_000 },
    ]
    const b = [
      { cropId: 'corn', label: null, practice: 'irrigated' as const, cropping: null, acres: 800, totalProfit: 160_000 },
    ]
    const rows = compareScenarios(a, b)
    expect(rows).toHaveLength(2)
    const irr = rows.find((r) => r.practice === 'irrigated')!
    const dry = rows.find((r) => r.practice === 'non_irrigated')!
    expect(irr).toMatchObject({ acresDelta: 200, profitDelta: 40_000 })
    expect(dry).toMatchObject({ bAcres: null, acresDelta: -400, profitDelta: -30_000 })
  })
})

describe('budgetLineMath — price+basis × yield − cost', () => {
  const grainLine: BudgetLineInput = {
    acres: 500, yield_per_acre: 200, price_mode: 'live', manual_price: null, basis: -0.25, cost_per_acre: 750,
  }

  it('grain: (4.75 live − 0.25 basis) × 200 − 750 = $150/ac; ×500 ac = $75,000', () => {
    const m = budgetLineMath(grainLine, 4.75, false)
    expect(m.effectivePrice).toBeCloseTo(4.5, 6)
    expect(m.revenuePerAcre).toBeCloseTo(900, 2)
    expect(m.profitPerAcre).toBeCloseTo(150, 2)
    expect(m.totalProfit).toBeCloseTo(75_000, 2)
    // Coffee-shop numbers: breakeven price 750/200 = $3.75; breakeven yield 750/4.50 = 166.67 bu.
    expect(m.breakevenPrice).toBeCloseTo(3.75, 4)
    expect(m.breakevenYield).toBeCloseTo(166.67, 2)
    expect(m.missingPrice).toBe(false)
  })

  it('cotton in $/lb: 0.70 (70¢ stored) × 1,250 lbs − $650 = $225/ac', () => {
    const m = budgetLineMath({
      acres: 100, yield_per_acre: 1250, price_mode: 'manual', manual_price: 70, basis: 0, cost_per_acre: 650,
    }, null, true)
    expect(m.effectivePrice).toBeCloseTo(70, 6) // ¢ stored = $0.70 displayed
    expect(m.revenuePerAcre).toBeCloseTo(875, 2)
    expect(m.profitPerAcre).toBeCloseTo(225, 2)
    // Breakevens unit-aware: price 650×100/1250 = 52¢ ($0.52); yield 650×100/70 = 928.57 lbs.
    expect(m.breakevenPrice).toBeCloseTo(52, 4)
    expect(m.breakevenYield).toBeCloseTo(928.57, 2)
  })

  it('manual mode ignores the live quote; live mode with no quote flags missingPrice', () => {
    const manual = budgetLineMath({ ...grainLine, price_mode: 'manual', manual_price: 5 }, 4.75, false)
    expect(manual.effectivePrice).toBeCloseTo(4.75, 6) // 5 − 0.25 basis
    const noQuote = budgetLineMath(grainLine, null, false)
    expect(noQuote.effectivePrice).toBeNull()
    expect(noQuote.profitPerAcre).toBeNull()
    expect(noQuote.missingPrice).toBe(true)
  })
})

describe('buildBudgetMatrix — pure budget math, no insurance, no caps', () => {
  it('every cell is exactly price × yield − cost', () => {
    const grid = buildBudgetMatrix({
      priceValues: axisValues({ center: 4.5, step: 0.5, steps: 1 }), // 4.0, 4.5, 5.0
      yieldValues: axisValues({ center: 200, step: 20, steps: 1 }), // 180, 200, 220
      costPerAcre: 750,
      isCotton: false,
    })
    // Bottom-left (4.0 × 180): 720 − 750 = −30 — pure math, NO floor kicks in.
    expect(grid[0][0].profitPerAcre).toBeCloseTo(-30, 2)
    // Center (4.5 × 200): 900 − 750 = 150.
    expect(grid[1][1].profitPerAcre).toBeCloseTo(150, 2)
    // Top-right (5.0 × 220): 1,100 − 750 = 350 — no cap.
    expect(grid[2][2].profitPerAcre).toBeCloseTo(350, 2)
    // Monotonic in both directions — nothing bends the plane.
    for (let r = 0; r < 3; r++) for (let c = 1; c < 3; c++) {
      expect(grid[r][c].profitPerAcre!).toBeGreaterThan(grid[r][c - 1].profitPerAcre!)
    }
  })

  it('cotton cells divide the ¢ axis once: 70¢ × 1,250 − 650 = 225', () => {
    const grid = buildBudgetMatrix({ priceValues: [70], yieldValues: [1250], costPerAcre: 650, isCotton: true })
    expect(grid[0][0].revenuePerAcre).toBeCloseTo(875, 2)
    expect(grid[0][0].profitPerAcre).toBeCloseTo(225, 2)
  })

  it('no cost → revenue only, profit null', () => {
    const grid = buildBudgetMatrix({ priceValues: [4.5], yieldValues: [200], costPerAcre: null, isCotton: false })
    expect(grid[0][0].revenuePerAcre).toBeCloseTo(900, 2)
    expect(grid[0][0].profitPerAcre).toBeNull()
  })
})

describe('scenarioTotals & compareScenarios', () => {
  const mkMath = (acres: number | null, profitPerAcre: number | null, revenuePerAcre = 0) => ({
    acres,
    math: budgetLineMath(
      { acres, yield_per_acre: 1, price_mode: 'manual' as const, manual_price: revenuePerAcre, basis: 0, cost_per_acre: revenuePerAcre - (profitPerAcre ?? 0) },
      null, false,
    ),
  })

  it('totals: acres sum, profit sums, weighted profit/acre', () => {
    // 500 ac at 150/ac + 300 ac at −20/ac → 800 ac, 75,000 − 6,000 = 69,000; 86.25/ac.
    const t = scenarioTotals([mkMath(500, 150, 900), mkMath(300, -20, 400)])
    expect(t.totalAcres).toBe(800)
    expect(t.totalProfit).toBeCloseTo(69_000, 2)
    expect(t.weightedProfitPerAcre).toBeCloseTo(86.25, 2)
    expect(t.incompleteLines).toBe(0)
  })

  it('a line missing inputs is excluded from profit and counted incomplete', () => {
    const t = scenarioTotals([mkMath(500, 150, 900), { acres: 200, math: budgetLineMath({ acres: 200, yield_per_acre: null, price_mode: 'manual', manual_price: 5, basis: 0, cost_per_acre: 700 }, null, false) }])
    expect(t.totalAcres).toBe(700) // acres still tracked
    expect(t.totalProfit).toBeCloseTo(75_000, 2)
    expect(t.incompleteLines).toBe(1)
  })

  it('comparison deltas per crop, including lines present on one side only', () => {
    const a = [
      { cropId: 'corn', label: null, acres: 1000, totalProfit: 150_000 },
      { cropId: 'soy', label: null, acres: 800, totalProfit: 96_000 },
    ]
    const b = [
      { cropId: 'corn', label: null, acres: 1400, totalProfit: 210_000 },
      { cropId: 'wheat', label: null, acres: 400, totalProfit: 20_000 },
    ]
    const rows = compareScenarios(a, b)
    const byId = new Map(rows.map((r) => [r.cropId, r]))
    expect(byId.get('corn')).toMatchObject({ acresDelta: 400, profitDelta: 60_000 })
    expect(byId.get('soy')).toMatchObject({ aAcres: 800, bAcres: null, acresDelta: -800, profitDelta: -96_000 })
    expect(byId.get('wheat')).toMatchObject({ aAcres: null, bAcres: 400, acresDelta: 400, profitDelta: 20_000 })
  })
})

describe('scenario duplication & isolation', () => {
  const line = (over: Partial<BudgetLine>): BudgetLine => ({
    id: 'l1', scenario_id: 's1', crop_id: 'corn', label: null, practice: null, cropping: null,
    acres: 500, yield_per_acre: 200, price_mode: 'live', manual_price: null, basis: -0.25,
    cost_per_acre: 750, sort_order: 0, created_at: '',
    ...over,
  })

  it('duplicateLinesFor copies every value intact onto the new scenario, order preserved', () => {
    const copies = duplicateLinesFor([
      line({ id: 'l2', sort_order: 1, crop_id: 'soy', label: 'DC behind wheat', manual_price: 11.1, price_mode: 'manual', practice: 'irrigated', cropping: 'double_crop' }),
      line({ id: 'l1', sort_order: 0 }),
    ], 's2')
    expect(copies).toHaveLength(2)
    expect(copies[0]).toEqual({
      scenario_id: 's2', crop_id: 'corn', label: null, practice: null, cropping: null,
      acres: 500, yield_per_acre: 200,
      price_mode: 'live', manual_price: null, basis: -0.25, cost_per_acre: 750, sort_order: 0,
    })
    expect(copies[1]).toMatchObject({ scenario_id: 's2', crop_id: 'soy', label: 'DC behind wheat', manual_price: 11.1, practice: 'irrigated', cropping: 'double_crop' })
    // Fresh identity: no id/created_at carried over.
    expect('id' in copies[0]).toBe(false)
  })

  it('isolation: budget math never touches a crop_assumptions-shaped object', async () => {
    // The engine's entire input surface is the line + a live quote — there is
    // no code path that accepts or returns crop_assumptions. This test pins
    // the module's exports so a future "helpful" write-through gets noticed.
    const mod = await import('@/lib/crop-budget')
    expect(Object.keys(mod).some((k) => /assumption|save|write|upsert/i.test(k))).toBe(false)
  })
})

describe('budgetContractSymbol — the budget-year NEW-CROP benchmark', () => {
  it('ZCZ27 / ZSX27 / ZWN27 / CTZ27 for 2027', () => {
    expect(budgetContractSymbol('Corn', 2027)).toBe('ZCZ27')
    expect(budgetContractSymbol('Soybeans', 2027)).toBe('ZSX27')
    expect(budgetContractSymbol('Wheat', 2027)).toBe('ZWN27')
    expect(budgetContractSymbol('Cotton', 2027)).toBe('CTZ27')
    expect(budgetContractSymbol('Canola', 2027)).toBeNull()
  })
  it('labels read naturally', () => {
    expect(budgetContractLabel('Corn', 2027)).toBe('DEC 27 Corn')
    expect(budgetContractLabel('Wheat', 2027)).toBe('JUL 27 Wheat')
  })
})
