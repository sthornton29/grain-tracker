import { describe, it, expect } from 'vitest'
import {
  axisValues, closestIndex, defaultPriceStep, defaultYieldStep, insurancePriceToAxisUnits,
  splitHarvestByCrop, computeScenarioCell, buildScenarioGrid, flatGovPerAcre,
  type CropScenarioInputs,
} from '@/lib/income-sensitivity'
import type { FieldCropAgg } from '@/lib/yields'
import type { Contract, Crop, CropAssumption, CropInsurancePolicy, CropInsuranceSco } from '@/lib/types'

// Hand-verified worked examples for the Income Sensitivity grid. Every expected
// money value is derived from the composed engines' formulas, with the
// arithmetic shown so a reviewer can re-check it without running the code.

// ---------- builders for minimal fixture rows ----------

const corn: Crop = {
  id: 'corn', name: 'Corn', base_moisture_pct: 15, base_lb_per_bushel: 56,
  harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null,
}
const soybeans: Crop = {
  id: 'soy', name: 'Soybeans', base_moisture_pct: 13, base_lb_per_bushel: 60,
  harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null,
}

function assumption(over: Partial<CropAssumption> = {}): CropAssumption {
  return {
    id: 'a1', crop_id: 'corn', crop_year: 2026,
    expected_yield: 200, expected_yield_irr: null, expected_yield_dry: null,
    expected_yield_dc_irr: null, expected_yield_dc_dry: null,
    harvest_complete: false, assumed_basis: 0, assumed_futures: null, reference_contract_month: null,
    cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null,
    cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null,
    notes: null, created_at: '', updated_at: '',
    ...over,
  }
}

function contract(over: Partial<Contract> = {}): Contract {
  return {
    id: 'c1', contract_number: 'CT-1', buyer_id: null, crop_id: 'corn', entity_id: null,
    crop_year: 2026, contracted_bushels: 0, price_per_bushel: null, notes: null,
    delivery_type: 'delivered', delivery_location_id: null,
    delivery_start_date: null, delivery_end_date: null, date_sold: null, completed_at: null, created_at: '',
    contract_month: null, contract_type: 'forward', futures_price: null, basis: null,
    cash_price: null, service_fee: 0, futures_set_date: null, basis_set_date: null,
    pricing_status: 'fully_priced',
    ...over,
  }
}

function policy(over: Partial<CropInsurancePolicy> = {}): CropInsurancePolicy {
  return {
    id: 'p1', entity_id: null, crop_id: 'corn', crop_year: 2026, county_id: null,
    policy_number: null, plan_type: 'RP', practice: 'non_irrigated',
    coverage_level: 0.8, unit_structure: 'enterprise', aph_yield: 200,
    projected_price: 4.5, harvest_price: null, volatility_factor: null,
    insured_acres: 100, premium_per_acre: null, total_premium: 2000,
    premium_subsidy_pct: null, notes: null,
    covers_all_planted_acres: false, coverage_note: null,
    expected_county_yield: null, expected_county_revenue: null, protection_factor: null,
    source: 'manual', created_at: '',
    ...over,
  }
}

// 100 dryland corn acres, nothing contracted or hedged, pre-harvest.
function baseInputs(over: Partial<CropScenarioInputs> = {}): CropScenarioInputs {
  return {
    crop: corn, cropYear: 2026,
    plantedAcres: 100, irrigatedAcres: 0, drylandAcres: 100,
    fixedHarvestedBu: 0, remainingAcres: 100,
    contracts: [], futures: [], options: [],
    assumption: assumption(),
    policies: [], scos: [], ecos: [],
    ...over,
  }
}

// ---------- axes ----------

describe('axisValues', () => {
  it('builds center ± steps × step ascending', () => {
    expect(axisValues({ center: 4.5, step: 0.2, steps: 2 })).toEqual([4.1, 4.3, 4.5, 4.7, 4.9])
  })
  it('drops non-positive levels near zero', () => {
    expect(axisValues({ center: 0.3, step: 0.2, steps: 2 })).toEqual([0.1, 0.3, 0.5, 0.7])
  })
})

describe('axis defaults + closestIndex', () => {
  it('uses the per-crop increments (corn/wheat $0.20, soybeans $0.40; corn 10 bu, others 5)', () => {
    expect(defaultPriceStep('Corn')).toBe(0.2)
    expect(defaultPriceStep('Wheat')).toBe(0.2)
    expect(defaultPriceStep('Soybeans')).toBe(0.4)
    expect(defaultYieldStep('Corn')).toBe(10)
    expect(defaultYieldStep('Soybeans')).toBe(5)
  })
  it('finds the you-are-here index', () => {
    expect(closestIndex([4.1, 4.3, 4.5, 4.7], 4.38)).toBe(1)
    expect(closestIndex([4.1, 4.3], null)).toBe(-1)
  })
  // Policy projected prices are insurance-native ($/lb for cotton) but the
  // cotton axis is ¢/lb. A $0.79/lb projected price must center the axis at
  // 79¢ — feeding 0.79 straight in centered a new cotton org's axis ~100×
  // low (the confusing near-zero price axis bug).
  it('converts insurance-native policy prices to axis units (cotton ×100, grains unchanged)', () => {
    expect(insurancePriceToAxisUnits('Cotton', 0.79)).toBeCloseTo(79, 9)
    expect(insurancePriceToAxisUnits('Corn', 4.5)).toBe(4.5)
    expect(insurancePriceToAxisUnits('Soybeans', 10.4)).toBe(10.4)
    expect(insurancePriceToAxisUnits(null, 4.5)).toBe(4.5)
  })
})

// ---------- splitHarvestByCrop ----------

describe('splitHarvestByCrop', () => {
  const plantings = [
    { id: 'plA', field_id: 'fA', crop_id: 'corn', season_year: 2026, planted_acres: 50 },
    { id: 'plB', field_id: 'fB', crop_id: 'corn', season_year: 2026, planted_acres: 50 },
  ]
  it('mid-harvest: complete fields are fixed, in-progress fields are remaining', () => {
    // Field A settled 14 days ago at 160 bu/ac (8,000 bu / 50 ac); field B loaded
    // yesterday at 40 bu/ac — >15% below the settled baseline, so in-progress.
    const aggByKey = new Map<string, FieldCropAgg>([
      ['fA|corn|2026', { dryBu: 8000, lastLoadDate: '2026-06-01' }],
      ['fB|corn|2026', { dryBu: 2000, lastLoadDate: '2026-06-14' }],
    ])
    const { byCrop } = splitHarvestByCrop({
      plantings, aggByKey, cropYear: 2026, cropCompleteKeys: new Set(), now: new Date('2026-06-15'),
    })
    const s = byCrop.get('corn')!
    expect(s.fixedBu).toBe(8000) // field B's partial 2,000 bu are NOT double-counted
    expect(s.completedAcres).toBe(50)
    expect(s.remainingAcres).toBe(50)
    expect(s.state).toBe('partial')
  })
  it('crop-level harvest_complete flag makes the whole crop complete', () => {
    const aggByKey = new Map<string, FieldCropAgg>([
      ['fA|corn|2026', { dryBu: 8000, lastLoadDate: '2026-06-01' }],
      ['fB|corn|2026', { dryBu: 2000, lastLoadDate: '2026-06-14' }],
    ])
    const { byCrop } = splitHarvestByCrop({
      plantings, aggByKey, cropYear: 2026, cropCompleteKeys: new Set(['corn|2026']), now: new Date('2026-06-15'),
    })
    const s = byCrop.get('corn')!
    expect(s.fixedBu).toBe(10000)
    expect(s.remainingAcres).toBe(0)
    expect(s.state).toBe('complete')
  })
  it('counts loads hauled in a different CALENDAR year than the season (January haul-out)', () => {
    // fieldCropAggregates keys by the load date's calendar year — 2026-crop corn
    // hauled in January 2027 lands under '…|2027'. Both fields settled long ago.
    const aggByKey = new Map<string, FieldCropAgg>([
      ['fA|corn|2026', { dryBu: 8000, lastLoadDate: '2026-11-01' }],
      ['fB|corn|2027', { dryBu: 7000, lastLoadDate: '2027-01-10' }],
    ])
    const { byCrop } = splitHarvestByCrop({
      plantings, aggByKey, cropYear: 2026, cropCompleteKeys: new Set(), now: new Date('2027-02-01'),
    })
    const s = byCrop.get('corn')!
    expect(s.fixedBu).toBe(15000)
    expect(s.remainingAcres).toBe(0)
    expect(s.state).toBe('complete')
  })

  it('no loads at all: everything is remaining, state pre', () => {
    const { byCrop } = splitHarvestByCrop({
      plantings, aggByKey: new Map(), cropYear: 2026, cropCompleteKeys: new Set(), now: new Date('2026-06-15'),
    })
    const s = byCrop.get('corn')!
    expect(s.fixedBu).toBe(0)
    expect(s.remainingAcres).toBe(100)
    expect(s.state).toBe('pre')
  })
})

// ---------- cell math ----------

describe('computeScenarioCell — RP insurance floor', () => {
  // RP policy: cov 0.80, APH 200, projected $4.50, 100 insured acres, premium $2,000.
  // At harvest $4.00 the guarantee price = MAX(4.50, 4.00) = 4.50, so the
  // revenue guarantee = 200 × 0.80 × 4.50 × 100 = $72,000.
  const inp = baseInputs({ policies: [policy()] })

  it('below the guarantee, the indemnity offsets low revenue (floor flattens the downside)', () => {
    // Yield 120 @ $4.00: production 12,000 bu; crop revenue = 12,000 × 4.00 = 48,000.
    // Insurance actual revenue = 120 × 4.00 × 100 = 48,000 → indemnity 72,000 − 48,000 = 24,000.
    // Net insurance = 24,000 − 2,000 premium = 22,000. Revenue/ac = (48,000 + 22,000)/100 = 700.
    const low = computeScenarioCell(inp, 4.0, 120)
    expect(low.production).toBe(12000)
    expect(low.cropRevenue).toBeCloseTo(48000, 6)
    expect(low.insuranceNet).toBeCloseTo(22000, 2)
    expect(low.revenuePerAcre).toBeCloseTo(700, 6)

    // Yield 160 @ $4.00: revenue 64,000; indemnity = 72,000 − 64,000 = 8,000;
    // net 6,000 → revenue/ac is the SAME 700 — RP at the harvest price is an
    // exact revenue floor below the guarantee.
    const mid = computeScenarioCell(inp, 4.0, 160)
    expect(mid.insuranceNet).toBeCloseTo(6000, 2)
    expect(mid.revenuePerAcre).toBeCloseTo(700, 6)
  })

  it('above the guarantee, indemnity is zero and only the premium drags', () => {
    // Yield 200 @ $4.60: production 20,000; crop revenue = 92,000.
    // Guarantee price = MAX(4.50, 4.60) = 4.60 → guarantee = 200 × 0.8 × 4.60 × 100 = 73,600.
    // Actual insurance revenue = 200 × 4.60 × 100 = 92,000 ≥ guarantee → indemnity 0.
    // Net insurance = −2,000 (premium). Revenue/ac = (92,000 − 2,000)/100 = 900.
    const cell = computeScenarioCell(inp, 4.6, 200)
    expect(cell.cropRevenue).toBeCloseTo(92000, 6)
    expect(cell.insuranceNet).toBeCloseTo(-2000, 2)
    expect(cell.revenuePerAcre).toBeCloseTo(900, 6)
  })
})

describe('computeScenarioCell — government payment toggle', () => {
  it('adds the identical flat $/acre to two different crops', () => {
    // $15,000 total gov payments ÷ 150 total planted acres (both crops) = $100/ac flat.
    const govPerAcre = flatGovPerAcre(15000, 150)
    expect(govPerAcre).toBeCloseTo(100, 10)

    const cornInp = baseInputs({ policies: [policy()] })
    const soyInp = baseInputs({
      crop: soybeans, plantedAcres: 50, drylandAcres: 50, remainingAcres: 50,
      assumption: assumption({ crop_id: 'soy', expected_yield: 60 }),
    })
    const cornOff = computeScenarioCell(cornInp, 4.0, 160)
    const cornOn = computeScenarioCell(cornInp, 4.0, 160, { govPerAcre })
    const soyOff = computeScenarioCell(soyInp, 10.0, 55)
    const soyOn = computeScenarioCell(soyInp, 10.0, 55, { govPerAcre })
    expect(cornOn.revenuePerAcre - cornOff.revenuePerAcre).toBeCloseTo(100, 6)
    expect(soyOn.revenuePerAcre - soyOff.revenuePerAcre).toBeCloseTo(100, 6)
  })
})

describe('computeScenarioCell — over-contracting cap', () => {
  // 15,000 bu sold flat-cash at $5.00, but the low-yield cell only grows 10,000 bu.
  const inp = baseInputs({
    contracts: [contract({ contracted_bushels: 15000, cash_price: 5.0 })],
  })
  it('revenue is capped at production (contracts scale by 10,000/15,000)', () => {
    // Blended revenue = 5.00 × 15,000 × (10,000 ÷ 15,000) = 50,000 → $500/ac.
    const cell = computeScenarioCell(inp, 4.0, 100)
    expect(cell.production).toBe(10000)
    expect(cell.cropRevenue).toBeCloseTo(50000, 6)
    expect(cell.revenuePerAcre).toBeCloseTo(500, 6)
  })
  it('a fully-contracted cell is price-insensitive — locked prices stay locked', () => {
    const a = computeScenarioCell(inp, 4.0, 100)
    const b = computeScenarioCell(inp, 6.0, 100)
    expect(b.cropRevenue).toBeCloseTo(a.cropRevenue, 6)
  })
})

describe('computeScenarioCell — mid-harvest blend', () => {
  // 8,000 bu already in the bin from 50 harvested acres; 50 acres remain.
  const inp = baseInputs({
    fixedHarvestedBu: 8000, remainingAcres: 50,
    policies: [policy({ coverage_level: 0.85, aph_yield: 180, total_premium: 3000 })],
  })
  it('production = fixed + scenario × remaining, and the indemnity uses the blended yield', () => {
    // Scenario yield 150 on the remaining 50 ac: production = 8,000 + 150 × 50 = 15,500.
    // Blended yield = 15,500 ÷ 100 = 155 bu/ac; crop revenue = 15,500 × 4.00 = 62,000.
    // RP guarantee = 180 × 0.85 × MAX(4.50, 4.00) × 100 = 68,850.
    // Insurance actual revenue = 155 × 4.00 × 100 = 62,000 → indemnity 6,850; net 3,850.
    // Revenue/ac = (62,000 + 3,850) ÷ 100 = 658.50.
    const cell = computeScenarioCell(inp, 4.0, 150)
    expect(cell.production).toBe(15500)
    expect(cell.blendedYield).toBeCloseTo(155, 10)
    expect(cell.cropRevenue).toBeCloseTo(62000, 6)
    expect(cell.insuranceNet).toBeCloseTo(3850, 2)
    expect(cell.revenuePerAcre).toBeCloseTo(658.5, 6)
  })
})

describe('computeScenarioCell — zero-contract crop is fully price-sensitive', () => {
  it('cell revenue = scenario price × scenario production, 1:1', () => {
    const inp = baseInputs()
    // 180 bu/ac × 100 ac = 18,000 bu: $4.20 → 75,600; $4.40 → 79,200 (Δ = 0.20 × 18,000).
    expect(computeScenarioCell(inp, 4.2, 180).cropRevenue).toBeCloseTo(75600, 6)
    expect(computeScenarioCell(inp, 4.4, 180).cropRevenue).toBeCloseTo(79200, 6)
  })
  it('the assumed basis still applies to the unpriced bushels', () => {
    const inp = baseInputs({ assumption: assumption({ assumed_basis: -0.3 }) })
    // (4.20 − 0.30) × 18,000 = 70,200.
    expect(computeScenarioCell(inp, 4.2, 180).cropRevenue).toBeCloseTo(70200, 6)
  })
})

describe('computeScenarioCell — fully harvested crop', () => {
  // 18,000 bu actual on 100 ac, nothing left in the field.
  const inp = baseInputs({ fixedHarvestedBu: 18000, remainingAcres: 0 })
  it('the yield input is inert; only the price axis moves the cell', () => {
    // Production is the 18,000 actual bushels regardless of the scenario yield.
    const a = computeScenarioCell(inp, 4.2, 999)
    expect(a.production).toBe(18000)
    expect(a.cropRevenue).toBeCloseTo(18000 * 4.2, 6) // 75,600
    const b = computeScenarioCell(inp, 4.4, 1)
    expect(b.production).toBe(18000)
    expect(b.cropRevenue - a.cropRevenue).toBeCloseTo(18000 * 0.2, 6) // 3,600
  })
})

describe('computeScenarioCell — RMA final harvest price on file', () => {
  it('insurance uses the final in every cell; the price axis moves crop sales only', () => {
    // Final harvest $4.00: guarantee = 200 × 0.8 × MAX(4.50, 4.00) × 100 = 72,000;
    // insurance actual revenue = 120 × 4.00 × 100 = 48,000 → net = 24,000 − 2,000 = 22,000
    // at BOTH scenario prices, while crop revenue still re-prices 1:1.
    const inp = baseInputs({ policies: [policy()], finalHarvestPrice: 4.0 })
    const a = computeScenarioCell(inp, 4.0, 120)
    const b = computeScenarioCell(inp, 5.0, 120)
    expect(a.insuranceNet).toBeCloseTo(22000, 2)
    expect(b.insuranceNet).toBeCloseTo(22000, 2)
    expect(b.cropRevenue - a.cropRevenue).toBeCloseTo(12000, 6) // 12,000 bu × $1.00
  })
})

describe('buildScenarioGrid', () => {
  it('is priceValues × yieldValues with matching cell coordinates', () => {
    const grid = buildScenarioGrid(baseInputs(), [4.0, 4.2], [160, 180, 200])
    expect(grid.length).toBe(2)
    expect(grid[0].length).toBe(3)
    expect(grid[1][2].price).toBe(4.2)
    expect(grid[1][2].scenarioYield).toBe(200)
    expect(grid[1][2].cropRevenue).toBeCloseTo(4.2 * 20000, 6)
  })
})

// ---------------------------------------------------------------------------
// County yield scenario modes (045): independent vs "county moves with me".
// Fixture: RP cov 0.50 (so the base never pays above 100 bu/ac), APH 200,
// projected = scenario price = 4.50, 100 ac, zero premiums; SCO trigger 0.86,
// expected county yield 200; expected farm yield 200.
// SCO band: lower 0.50, width 0.36; paymentLimit = 0.36 x 200 x 4.5 x 100 = 32,400.
// ---------------------------------------------------------------------------
describe('county yield scenario modes (differential semantics)', () => {
  const sco = (over: Partial<CropInsuranceSco> = {}): CropInsuranceSco => ({
    id: 's1', policy_id: 'p1', coverage_trigger: 0.86, expected_county_yield: 200,
    county_yield_assumption_pct: null, premium_per_acre: null, total_premium: 0,
    notes: null, created_at: '', ...over,
  })
  const countyPolicy = () => policy({ coverage_level: 0.5, total_premium: 0 })
  const countyAssumption = (differential: number | null, final: number | null = null) =>
    ({ yield_differential: differential, county_yield_override: null, rma_final_county_yield: final })

  it('independent mode holds county indemnities CONSTANT across the yield axis', () => {
    // county = EXPECTED farm 200 - differential 40 = 160 -> ratio 0.80;
    // paymentFactor = min(0.86-0.80, 0.36) = 0.06
    // SCO = (0.06/0.36) x 32,400 = 5,400 at EVERY farm yield (base never pays >=100 bu).
    const inp = baseInputs({
      policies: [countyPolicy()], scos: [sco()],
      countyAssumption: countyAssumption(40), countyMode: 'independent',
    })
    const low = computeScenarioCell(inp, 4.5, 150)
    const high = computeScenarioCell(inp, 4.5, 220)
    expect(low.insuranceNet).toBeCloseTo(5400, 2)
    expect(high.insuranceNet).toBeCloseTo(5400, 2)
  })

  it('moves-with-me preserves the differential: a 165 farm cell implies county 150 (diff 15)', () => {
    // independent: county = expected 200 - 15 = 185 -> ratio 0.925 -> ZERO.
    const independent = computeScenarioCell(baseInputs({
      policies: [countyPolicy()], scos: [sco()],
      countyAssumption: countyAssumption(15), countyMode: 'independent',
    }), 4.5, 165)
    // with_farm: county = scenario farm 165 - 15 = 150 -> ratio 0.75
    // paymentFactor = min(0.86-0.75, 0.36) = 0.11 -> SCO = (0.11/0.36) x 32,400 = 9,900
    const withMe = computeScenarioCell(baseInputs({
      policies: [countyPolicy()], scos: [sco()],
      countyAssumption: countyAssumption(15), countyMode: 'with_farm',
    }), 4.5, 165)
    expect(independent.insuranceNet).toBeCloseTo(0, 2)
    expect(withMe.insuranceNet).toBeCloseTo(9900, 2)
    // At the axis center (farm = expected 200) both modes agree: same basis.
    const centerInd = computeScenarioCell(baseInputs({
      policies: [countyPolicy()], scos: [sco()], countyAssumption: countyAssumption(15), countyMode: 'independent',
    }), 4.5, 200)
    const centerMove = computeScenarioCell(baseInputs({
      policies: [countyPolicy()], scos: [sco()], countyAssumption: countyAssumption(15), countyMode: 'with_farm',
    }), 4.5, 200)
    expect(centerMove.insuranceNet).toBeCloseTo(centerInd.insuranceNet, 2)
  })

  it('mid-harvest: the county follows the cell BLENDED farm yield (fixed + scenario)', () => {
    // 8,000 bu fixed + scenario 120 x 50 remaining ac = 14,000 -> blended 140
    // diff 0 ("I match the county") -> county est 140 -> ratio 0.70
    // paymentFactor = min(0.86-0.70, 0.36) = 0.16 -> SCO = (0.16/0.36) x 32,400 = 14,400
    const cell = computeScenarioCell(baseInputs({
      fixedHarvestedBu: 8000, remainingAcres: 50,
      policies: [countyPolicy()], scos: [sco()],
      countyAssumption: countyAssumption(0), countyMode: 'with_farm',
    }), 4.5, 120)
    expect(cell.insuranceNet).toBeCloseTo(14400, 2)
  })

  it('an RMA final county yield pins BOTH modes (differential and farm yield ignored)', () => {
    // final 190 -> ratio 0.95 -> SCO 0 regardless of mode / differential / farm yield.
    const ind = computeScenarioCell(baseInputs({
      policies: [countyPolicy()], scos: [sco()],
      countyAssumption: countyAssumption(40, 190), countyMode: 'independent',
    }), 4.5, 120)
    const move = computeScenarioCell(baseInputs({
      policies: [countyPolicy()], scos: [sco()],
      countyAssumption: countyAssumption(40, 190), countyMode: 'with_farm',
    }), 4.5, 120)
    expect(ind.insuranceNet).toBeCloseTo(0, 2)
    expect(move.insuranceNet).toBeCloseTo(ind.insuranceNet, 2)
  })
})

// ---------------------------------------------------------------------------
// Cotton — the ¢/lb scenario axis must convert to $/lb at the insurance
// boundary. Regression for the inverted-table incident (huge indemnities at
// low yields when the ¢ axis leaked into $-unit policy math).
// ---------------------------------------------------------------------------

describe('computeScenarioCell — cotton ¢/lb axis vs $/lb policy math', () => {
  const cotton: Crop = {
    id: 'cotton', name: 'Cotton', base_moisture_pct: 0, base_lb_per_bushel: 0,
    harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null,
  } as Crop

  // 100 acres, APH 1,200 lbs, RP 75%, projected 0.68 $/lb, no premium so
  // insuranceNet is the raw indemnity. The scenario axis is ¢/lb (45…95).
  const cottonInputs = baseInputs({
    crop: cotton,
    assumption: assumption({ crop_id: 'cotton', expected_yield: 1200, cost_per_acre: 500, assumed_basis: 0 }),
    policies: [policy({
      id: 'pc', crop_id: 'cotton', aph_yield: 1200, coverage_level: 0.75,
      projected_price: 0.68, insured_acres: 100, total_premium: 0,
    })],
  })

  it('the RP floor at 45¢ pays the hand-verified $125.10/ac at 1,082 lbs', () => {
    const cell = computeScenarioCell(cottonInputs, 45, 1082)
    // guarantee 1,200 × 0.75 × 0.68 = 612; actual 1,082 × 0.45 = 486.90;
    // indemnity 125.10/ac × 100 ac = 12,510 (premium 0).
    expect(cell.insuranceNet).toBeCloseTo(12510, 0)
    expect(cell.insuranceWarning).toBeNull()
  })

  it('profit increases with yield at a fixed 45¢ — the floor flattens, never inverts', () => {
    const yields = [932, 1082, 1232, 1332, 1482]
    const cells = yields.map((y) => computeScenarioCell(cottonInputs, 45, y))
    for (let i = 1; i < cells.length; i++) {
      expect(cells[i].profitPerAcre!).toBeGreaterThanOrEqual(cells[i - 1].profitPerAcre! - 1e-6)
    }
    // And the indemnity magnitude stays in policy range — never thousands/acre.
    for (const c of cells) expect(c.insuranceNet / 100).toBeLessThan(2500)
  })

  it('the center cell (68¢ × APH yield) pays no indemnity', () => {
    const cell = computeScenarioCell(cottonInputs, 68, 1200)
    // guarantee 612 vs actual 1,200 × 0.68 = 816 → 0.
    expect(cell.insuranceNet).toBeCloseTo(0, 6)
  })

  it('a ¢-stored projected price is flagged by the sanity guard, not silently rendered', () => {
    const bad = {
      ...cottonInputs,
      policies: [policy({
        id: 'pc', crop_id: 'cotton', aph_yield: 1200, coverage_level: 0.75,
        projected_price: 68, insured_acres: 100, total_premium: 0, // ¢ mis-stored
      })],
    }
    const cell = computeScenarioCell(bad, 45, 1082)
    expect(cell.insuranceWarning).toMatch(/price units/)
  })

  it('an RMA final harvest price ($/lb) pins insurance in every cell without conversion', () => {
    const withFinal = { ...cottonInputs, finalHarvestPrice: 0.45 }
    const low = computeScenarioCell(withFinal, 45, 1082)
    const high = computeScenarioCell(withFinal, 95, 1082)
    expect(low.insuranceNet).toBeCloseTo(high.insuranceNet, 2)
    expect(low.insuranceNet).toBeCloseTo(12510, 0)
  })
})
