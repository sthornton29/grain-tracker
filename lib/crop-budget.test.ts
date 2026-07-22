import { describe, it, expect } from 'vitest'
import {
  aphWeightedYield, budgetLineMath, budgetSeeds, buildBudgetMatrix, scenarioTotals,
  budgetContractSymbol, budgetContractLabel,
  lineDesignation, blendBudgetLines,
  breakoutFields, breakoutKeyOf, breakoutKeysFor, effectiveBudgetRows, gridCellPlan,
  gridFromLines, priceEditPatch, livePricePatch,
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

describe('breakout designation', () => {
  it('lineDesignation reads naturally', () => {
    expect(lineDesignation({ practice: 'irrigated', cropping: 'double_crop' })).toBe('Irrigated · Double-crop')
    expect(lineDesignation({ practice: 'non_irrigated', cropping: null })).toBe('Dryland')
    expect(lineDesignation({ practice: null, cropping: null })).toBe('')
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

describe('scenarioTotals', () => {
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

})

const line = (over: Partial<BudgetLine>): BudgetLine => ({
  id: 'l1', scenario_id: 's1', crop_id: 'corn', label: null, practice: null, cropping: null,
  acres: 500, yield_per_acre: 200, price_mode: 'live', manual_price: null, basis: -0.25,
  cost_per_acre: 750, sort_order: 0, created_at: '',
  ...over,
})

describe('sandbox isolation', () => {
  it('budget math never touches a crop_assumptions-shaped object', async () => {
    // The engine's entire input surface is the line + a live quote — there is
    // no code path that accepts or returns crop_assumptions. This test pins
    // the module's exports so a future "helpful" write-through gets noticed.
    const mod = await import('@/lib/crop-budget')
    expect(Object.keys(mod).some((k) => /assumption|save|write|upsert/i.test(k))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Breakout grid ↔ budget_lines mapping (scenario-less redesign)
// ---------------------------------------------------------------------------

describe('grid ↔ lines mapping', () => {
  it('breakoutKeyOf classifies every practice × cropping combination (and the legacy folds)', () => {
    expect(breakoutKeyOf({ practice: null, cropping: null })).toBe('overall')
    expect(breakoutKeyOf({ practice: 'irrigated', cropping: null })).toBe('fs_irr')
    expect(breakoutKeyOf({ practice: 'non_irrigated', cropping: 'full_season' })).toBe('fs_dry')
    expect(breakoutKeyOf({ practice: 'irrigated', cropping: 'double_crop' })).toBe('dc_irr')
    expect(breakoutKeyOf({ practice: 'non_irrigated', cropping: 'double_crop' })).toBe('dc_dry')
    // Legacy blended double-crop folds to dc_dry (the common DC practice).
    expect(breakoutKeyOf({ practice: null, cropping: 'double_crop' })).toBe('dc_dry')
  })

  it('breakoutFields round-trips through breakoutKeyOf', () => {
    for (const k of ['fs_irr', 'fs_dry', 'dc_irr', 'dc_dry'] as const) {
      expect(breakoutKeyOf(breakoutFields(k))).toBe(k)
    }
  })

  it('non-DC crops offer the two full-season rows; DC crops all four', () => {
    expect(breakoutKeysFor(false)).toEqual(['fs_irr', 'fs_dry'])
    expect(breakoutKeysFor(true)).toEqual(['fs_irr', 'fs_dry', 'dc_irr', 'dc_dry'])
  })

  it('gridFromLines slots each line into its cell', () => {
    const g = gridFromLines([
      line({ id: 'o' }),
      line({ id: 'i', practice: 'irrigated' }),
      line({ id: 'dd', practice: 'non_irrigated', cropping: 'double_crop' }),
    ])
    expect(g.overall?.id).toBe('o')
    expect(g.byKey.fs_irr?.id).toBe('i')
    expect(g.byKey.dc_dry?.id).toBe('dd')
    expect(g.byKey.fs_dry).toBeUndefined()
  })

  it('breakout rows with acres drive the output; blank cells inherit the Overall row', () => {
    const g = gridFromLines([
      line({ id: 'o', acres: null, yield_per_acre: 190, cost_per_acre: 750 }),
      line({ id: 'i', practice: 'irrigated', acres: 800, yield_per_acre: 220, cost_per_acre: null }),
      line({ id: 'd', practice: 'non_irrigated', acres: 450, yield_per_acre: null, cost_per_acre: 640 }),
    ])
    const rows = effectiveBudgetRows(g, breakoutKeysFor(false))
    expect(rows).toHaveLength(2)
    const irr = rows.find((r) => r.key === 'fs_irr')!
    const dry = rows.find((r) => r.key === 'fs_dry')!
    // Own values win; blanks fall back to Overall.
    expect(irr).toMatchObject({ acres: 800, yieldPerAcre: 220, costPerAcre: 750, inheritedYield: false, inheritedCost: true })
    expect(dry).toMatchObject({ acres: 450, yieldPerAcre: 190, costPerAcre: 640, inheritedYield: true, inheritedCost: false })
  })

  it('with no breakout acres the Overall line alone is the budget line', () => {
    const g = gridFromLines([
      line({ id: 'o', acres: 1200, yield_per_acre: 190, cost_per_acre: 750 }),
      line({ id: 'i', practice: 'irrigated', acres: null, yield_per_acre: 220 }),
    ])
    const rows = effectiveBudgetRows(g, breakoutKeysFor(false))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'overall', acres: 1200, yieldPerAcre: 190, costPerAcre: 750 })
  })

  it('a legacy breakout key outside the DC designation still surfaces when passed in keys', () => {
    const g = gridFromLines([line({ id: 'dc', practice: 'non_irrigated', cropping: 'double_crop', acres: 300 })])
    expect(effectiveBudgetRows(g, ['fs_irr', 'fs_dry'])).toHaveLength(0) // dropped without the key…
    expect(effectiveBudgetRows(g, ['fs_irr', 'fs_dry', 'dc_dry'])).toHaveLength(1) // …kept with it
  })

  it('gridCellPlan: updates in place, inserts a seeded line on first entry, noops on no change', () => {
    const existing = line({ id: 'i', practice: 'irrigated', acres: 800 })
    expect(gridCellPlan({ existing, key: 'fs_irr', field: 'acres', value: 800, seeds: { yield: 210, cost: 880 } }))
      .toEqual({ op: 'noop' })
    expect(gridCellPlan({ existing, key: 'fs_irr', field: 'yield', value: 215, seeds: { yield: 210, cost: 880 } }))
      .toEqual({ op: 'update', id: 'i', patch: { yield_per_acre: 215 } })
    // First entry into an empty row: the typed field takes the value, the
    // other assumption fields start on their seeds (derivation chips).
    expect(gridCellPlan({ existing: null, key: 'dc_dry', field: 'acres', value: 300, seeds: { yield: 42, cost: 360 } }))
      .toEqual({
        op: 'insert',
        values: { practice: 'non_irrigated', cropping: 'double_crop', acres: 300, yield_per_acre: 42, cost_per_acre: 360 },
      })
    // Clearing a cell that never existed writes nothing.
    expect(gridCellPlan({ existing: null, key: 'fs_dry', field: 'yield', value: null, seeds: { yield: null, cost: null } }))
      .toEqual({ op: 'noop' })
  })
})

// ---------------------------------------------------------------------------
// Futures price edit-in-place (live ↔ manual on the same fields)
// ---------------------------------------------------------------------------

describe('priceEditPatch — typing over the live quote flips to manual', () => {
  it('typing a different number switches the crop to manual at that price', () => {
    expect(priceEditPatch({ value: 4.9, currentMode: 'live', livePrice: 4.75 }))
      .toEqual({ price_mode: 'manual', manual_price: 4.9 })
  })
  it('re-typing the live quote verbatim stays live (no accidental flip)', () => {
    expect(priceEditPatch({ value: 4.75, currentMode: 'live', livePrice: 4.75 })).toBeNull()
  })
  it('blanking the price restores the live quote; blank while live is a noop', () => {
    expect(priceEditPatch({ value: null, currentMode: 'manual', livePrice: 4.75 })).toEqual({ price_mode: 'live' })
    expect(priceEditPatch({ value: null, currentMode: 'live', livePrice: 4.75 })).toBeNull()
  })
  it('editing a manual price keeps manual mode; ↻ restores live', () => {
    expect(priceEditPatch({ value: 5.1, currentMode: 'manual', livePrice: 4.75 }))
      .toEqual({ price_mode: 'manual', manual_price: 5.1 })
    expect(livePricePatch()).toEqual({ price_mode: 'live' })
  })
})

// ---------------------------------------------------------------------------
// INVARIANT: dropping scenario management changed no math. The effective rows
// run through the SAME budgetLineMath/blendBudgetLines as the old per-line
// path — a plain line and its effective row produce identical numbers, and
// the blend still foots exactly to the broken-out sum.
// ---------------------------------------------------------------------------

describe('invariant: scenario-less restructure preserves line math and blends', () => {
  it('an Overall-only crop computes exactly like the old single blended line', () => {
    const l = line({ acres: 500, yield_per_acre: 200, cost_per_acre: 750, basis: -0.25 })
    const [row] = effectiveBudgetRows(gridFromLines([l]), breakoutKeysFor(false))
    const direct = budgetLineMath(l, 4.75, false)
    const viaGrid = budgetLineMath({
      acres: row.acres, yield_per_acre: row.yieldPerAcre, price_mode: l.price_mode,
      manual_price: l.manual_price, basis: l.basis, cost_per_acre: row.costPerAcre,
    }, 4.75, false)
    expect(viaGrid).toEqual(direct)
  })

  it('broken-out rows still foot to the blended section exactly', () => {
    const g = gridFromLines([
      line({ id: 'i', practice: 'irrigated', acres: 800, yield_per_acre: 195, cost_per_acre: 780, price_mode: 'manual', manual_price: 4.5, basis: 0 }),
      line({ id: 'd', practice: 'non_irrigated', acres: 450, yield_per_acre: 168, cost_per_acre: 600, price_mode: 'manual', manual_price: 4.5, basis: 0 }),
    ])
    const rows = effectiveBudgetRows(g, breakoutKeysFor(false))
    const maths = rows.map((r) => budgetLineMath({
      acres: r.acres, yield_per_acre: r.yieldPerAcre, price_mode: 'manual',
      manual_price: 4.5, basis: 0, cost_per_acre: r.costPerAcre,
    }, null, false))
    const b = blendBudgetLines(rows.map((r, i) => ({
      practice: r.line.practice, cropping: r.line.cropping, label: null,
      acres: r.acres, yield_per_acre: r.yieldPerAcre, cost_per_acre: r.costPerAcre,
      effectivePrice: maths[i].effectivePrice,
    })))
    const blended = budgetLineMath({
      acres: b.acres, yield_per_acre: b.yieldPerAcre, price_mode: 'manual',
      manual_price: b.effectivePrice, basis: 0, cost_per_acre: b.costPerAcre,
    }, null, false)
    expect(maths[0].totalProfit! + maths[1].totalProfit!).toBe(148200)
    expect(blended.totalProfit).toBe(148200)
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

describe('blendBudgetLines — display-time by-crop blend', () => {
  const irr = {
    practice: 'irrigated' as const, cropping: null, label: null,
    acres: 800, yield_per_acre: 195, cost_per_acre: 780, effectivePrice: 4.5,
  }
  const dry = {
    practice: 'non_irrigated' as const, cropping: null, label: null,
    acres: 450, yield_per_acre: 168, cost_per_acre: 600, effectivePrice: 4.5,
  }

  it('800 ac @ 195 + 450 ac @ 168 → 1,250 ac @ 185.28 (displays 185.3), cost acre-weighted likewise', () => {
    // yield: (195×800 + 168×450) ÷ 1,250 = 231,600 ÷ 1,250 = 185.28
    // cost:  (780×800 + 600×450) ÷ 1,250 = 894,000 ÷ 1,250 = 715.20
    const b = blendBudgetLines([irr, dry])
    expect(b.acres).toBe(1250)
    expect(b.yieldPerAcre).toBe(185.28)
    expect(Math.round(b.yieldPerAcre! * 10) / 10).toBe(185.3) // the displayed 1-dec figure
    expect(b.costPerAcre).toBe(715.2)
    expect(b.effectivePrice).toBe(4.5) // identical on both lines — the shared contract
  })

  it('blended totals are identical to the sum of the broken-out lines', () => {
    // Broken out: (4.50×195−780)×800 = 97.50×800 = 78,000; (4.50×168−600)×450 = 156×450 = 70,200 → 148,200.
    // Blended: (4.50×185.28−715.20)×1,250 = 118.56×1,250 = 148,200. Exactly equal — weighting preserves totals.
    const mkLine = (l: { acres: number; yield_per_acre: number; cost_per_acre: number; effectivePrice: number }): BudgetLineInput => ({
      acres: l.acres, yield_per_acre: l.yield_per_acre, price_mode: 'manual',
      manual_price: l.effectivePrice, basis: 0, cost_per_acre: l.cost_per_acre,
    })
    const brokenOut = [irr, dry].map((l) => budgetLineMath(mkLine(l), null, false).totalProfit!)
    const b = blendBudgetLines([irr, dry])
    const blended = budgetLineMath({
      acres: b.acres, yield_per_acre: b.yieldPerAcre, price_mode: 'manual',
      manual_price: b.effectivePrice, basis: 0, cost_per_acre: b.costPerAcre,
    }, null, false).totalProfit!
    expect(brokenOut[0] + brokenOut[1]).toBe(148200)
    expect(blended).toBe(148200)
  })

  it('a single-line crop passes through unchanged (the toggle is a no-op)', () => {
    const b = blendBudgetLines([irr])
    expect(b).toEqual({ acres: 800, yieldPerAcre: 195, costPerAcre: 780, effectivePrice: 4.5, composition: '' })
  })

  it('composition string names the underlying lines', () => {
    expect(blendBudgetLines([irr, dry]).composition).toBe('800 irr + 450 dry')
    expect(blendBudgetLines([
      irr,
      { ...dry, cropping: 'double_crop' as const, label: 'behind wheat' },
    ]).composition).toBe('800 irr + 450 dry dc (behind wheat)')
    expect(blendBudgetLines([
      { ...irr, practice: null },
      { ...dry, practice: null, acres: 450 },
    ]).composition).toBe('800 blended + 450 blended')
  })

  it('lines without acres are excluded from the weighting but named in the composition', () => {
    const b = blendBudgetLines([irr, { ...dry, acres: null }])
    expect(b.acres).toBe(800)
    expect(b.yieldPerAcre).toBe(195) // only the irr line weighs in
    expect(b.composition).toBe('800 irr + — dry')
  })
})
