import { describe, it, expect } from 'vitest'
import {
  computeMarketing,
  segmentAcresByCrop,
  expectedProductionFromBreakout,
} from '@/lib/marketing'
import type {
  Contract,
  Crop,
  CropAssumption,
  FuturesPosition,
  OptionPosition,
} from '@/lib/types'
import { CONTRACT_SIZE_BU } from '@/lib/hedging'

// All expected values below are hand-derived from the formulas in
// lib/marketing.ts (computeMarketing), not copied from the function's output.
//
// Key formulas (rounding via round(n, d) = Math.round(n*10^d)/10^d, default d=6):
//   contractedBu = Σ contracted_bushels
//   remaining    = totalProduction − contractedBu
//   avgCashPrice = Σ(cash_price·bu) / Σbu   over fully_priced contracts w/ cash_price  [round 6]
//   rawAvgFutures= Σ(futures_price·bu) / Σbu  over contracts w/ futures_price
//                  + Σ(trade_price·(num_contracts·5000)) for SHORT futures positions
//   adjPerBu     = (closedFuturesPnl + optionsPnl) / fBu
//                  closedFuturesPnl = Σ(realized_pnl − commission) over CLOSED short futures
//                  optionsPnl       = Σ realized_pnl over options w/ status != 'open'
//   avgFutures   = round(rawAvgFutures + adjPerBu, 6)
//   avgBasis     = Σ(basis·bu) / Σbu over contracts w/ basis  [round 6]
//   totalAvgPrice= round(avgFutures + avgBasis, 6)  when both present
//   costPerBu    = round(cost_per_acre / yield, 4)
//   profitPrice  = totalAvgPrice ?? avgCashPrice
//   profitPerAcre= round(yield·profitPrice − cost_per_acre, 2)
//   totalProfit  = round(profitPerAcre · acres, 2)

const CONTRACT_BU = CONTRACT_SIZE_BU // 5000

// ---- Fixture factories (only the fields computeMarketing reads matter) ----

function crop(over: Partial<Crop> & Pick<Crop, 'id' | 'name'>): Crop {
  return {
    base_moisture_pct: null,
    base_lb_per_bushel: null,
    harvest_category: 'fall',
    double_crop: false,
    ...over,
  }
}

function contract(over: Partial<Contract> & Pick<Contract, 'id'>): Contract {
  return {
    contract_number: 'C-' + over.id,
    buyer_id: null,
    crop_id: null,
    entity_id: null,
    crop_year: 2026,
    contracted_bushels: 0,
    price_per_bushel: null,
    notes: null,
    delivery_type: 'delivered',
    delivery_location_id: null,
    delivery_start_date: null,
    delivery_end_date: null,
    completed_at: null,
    created_at: '2026-01-01',
    contract_month: null,
    contract_type: 'forward',
    futures_price: null,
    basis: null,
    cash_price: null,
    service_fee: 0,
    futures_set_date: null,
    basis_set_date: null,
    pricing_status: 'fully_priced',
    ...over,
  }
}

function assumption(
  over: Partial<CropAssumption> & Pick<CropAssumption, 'crop_id'>,
): CropAssumption {
  return {
    id: 'a-' + over.crop_id,
    crop_year: 2026,
    expected_yield: null,
    expected_yield_irr: null,
    expected_yield_dry: null,
    expected_yield_dc_irr: null,
    expected_yield_dc_dry: null,
    harvest_complete: false,
    cost_per_acre: null,
    cost_per_acre_irr: null,
    cost_per_acre_dry: null,
    cost_per_acre_dc_irr: null,
    cost_per_acre_dc_dry: null,
    notes: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...over,
  }
}

function future(
  over: Partial<FuturesPosition> & Pick<FuturesPosition, 'id' | 'commodity'>,
): FuturesPosition {
  return {
    entity_id: null,
    contract_month: 'DEC 26',
    contract_symbol: '',
    crop_year: 2026,
    side: 'short',
    num_contracts: 0,
    trade_price: 0,
    trade_date: '2026-01-01',
    status: 'open',
    close_price: null,
    close_date: null,
    realized_pnl: null,
    commission: 0,
    notes: null,
    source: 'manual',
    created_at: '2026-01-01',
    ...over,
  }
}

function option(
  over: Partial<OptionPosition> & Pick<OptionPosition, 'id' | 'commodity'>,
): OptionPosition {
  return {
    entity_id: null,
    option_type: 'put',
    side: 'buy',
    underlying_contract_month: 'DEC 26',
    underlying_symbol: '',
    strike_price: 0,
    num_contracts: 0,
    premium_cents: 0,
    premium_total: 0,
    trade_date: '2026-01-01',
    expiration_date: null,
    crop_year: 2026,
    status: 'open',
    close_price_cents: null,
    close_date: null,
    realized_pnl: null,
    commission: 0,
    manual_current_value_cents: null,
    exercised_position_id: null,
    notes: null,
    source: 'manual',
    created_at: '',
    ...over,
  }
}

// Convenience: planting for a crop with planted_acres.
function planting(crop_id: string, planted_acres: number, season_year = 2026) {
  return { crop_id, season_year, planted_acres }
}

// Build a single-row computeMarketing call for the common single-crop case.
function single(args: {
  crop: Crop
  acres: number
  contracts?: Contract[]
  futures?: FuturesPosition[]
  options?: OptionPosition[]
  assumptions?: CropAssumption[]
  actual?: Map<string, number>
  expectedProd?: Map<string, number>
}) {
  const rows = computeMarketing({
    cropYear: 2026,
    crops: [args.crop],
    plantings: [planting(args.crop.id, args.acres)],
    contracts: args.contracts ?? [],
    futures: args.futures ?? [],
    options: args.options ?? [],
    assumptions: args.assumptions ?? [],
    actualProductionByCrop: args.actual ?? new Map(),
    expectedProductionByCrop: args.expectedProd,
  })
  expect(rows).toHaveLength(1)
  return rows[0]
}

const CORN = crop({ id: 'corn', name: 'Corn' })
const BEANS = crop({ id: 'beans', name: 'Soybeans' })
const CANOLA = crop({ id: 'canola', name: 'Canola' }) // maps to no commodity

describe('computeMarketing — contracted vs remaining vs production', () => {
  it('production = expected_yield × acres; remaining = production − Σ contracted', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 50000 }),
        contract({ id: '2', crop_id: 'corn', contracted_bushels: 30000 }),
      ],
    })
    // totalProduction = 200 * 1000 = 200,000
    expect(r.totalProduction).toBeCloseTo(200000, 6)
    // contractedBu = 50,000 + 30,000 = 80,000
    expect(r.contractedBu).toBeCloseTo(80000, 6)
    // remaining = 200,000 − 80,000 = 120,000
    expect(r.remaining).toBeCloseTo(120000, 6)
    expect(r.yield).toBeCloseTo(200, 6)
    expect(r.yieldLabel).toBe('Est.')
  })

  it('over-contracting yields a negative remaining', () => {
    const r = single({
      crop: CORN,
      acres: 100,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [contract({ id: '1', crop_id: 'corn', contracted_bushels: 25000 })],
    })
    // production = 200 * 100 = 20,000; remaining = 20,000 − 25,000 = −5,000
    expect(r.totalProduction).toBeCloseTo(20000, 6)
    expect(r.remaining).toBeCloseTo(-5000, 6)
  })

  it('harvest_complete with actual loads uses actual production & yield, label Actual', () => {
    const r = single({
      crop: CORN,
      acres: 500,
      assumptions: [
        assumption({ crop_id: 'corn', expected_yield: 200, harvest_complete: true }),
      ],
      actual: new Map([['corn', 105000]]),
    })
    // harvestComplete && actual>0 → totalProduction = 105,000
    expect(r.totalProduction).toBeCloseTo(105000, 6)
    // yield = round(105000 / 500, 2) = 210
    expect(r.yield).toBeCloseTo(210, 6)
    expect(r.yieldLabel).toBe('Actual')
  })

  it('expectedProductionByCrop overrides expected_yield×acres; implied yield = prod/acres', () => {
    const r = single({
      crop: CORN,
      acres: 800,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      expectedProd: new Map([['corn', 176000]]),
    })
    // broken-out estimate replaces 200*800
    expect(r.totalProduction).toBeCloseTo(176000, 6)
    // implied yield = round(176000 / 800, 2) = 220
    expect(r.yield).toBeCloseTo(220, 6)
    expect(r.yieldLabel).toBe('Est.')
  })
})

describe('computeMarketing — weighted-average cash price (bushel-weighted)', () => {
  it('weights by bushels, not a plain mean', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        // 10,000 bu @ $4.00
        contract({
          id: '1', crop_id: 'corn', contracted_bushels: 10000,
          contract_type: 'forward', pricing_status: 'fully_priced', cash_price: 4.0,
        }),
        // 30,000 bu @ $5.00
        contract({
          id: '2', crop_id: 'corn', contracted_bushels: 30000,
          contract_type: 'forward', pricing_status: 'fully_priced', cash_price: 5.0,
        }),
      ],
    })
    // weighted = (4.00*10000 + 5.00*30000) / 40000 = (40000 + 150000)/40000 = 4.75
    // plain mean would be 4.50 — assert it is NOT that.
    expect(r.avgCashPrice).toBeCloseTo(4.75, 6)
    expect(r.avgCashPrice).not.toBeCloseTo(4.5, 6)
  })

  it('excludes non-fully_priced contracts from cash avg and tracks excludedAwaitingBu', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({
          id: '1', crop_id: 'corn', contracted_bushels: 20000,
          pricing_status: 'fully_priced', cash_price: 4.5,
        }),
        // awaiting_basis HTA — cash null, excluded from avg, counted as awaiting
        contract({
          id: '2', crop_id: 'corn', contracted_bushels: 15000,
          contract_type: 'hta', pricing_status: 'awaiting_basis',
          futures_price: 4.3, cash_price: null,
        }),
      ],
    })
    // avgCash = (4.5 * 20000) / 20000 = 4.5
    expect(r.avgCashPrice).toBeCloseTo(4.5, 6)
    // excludedAwaitingBu = 15,000 (the HTA not yet fully priced)
    expect(r.excludedAwaitingBu).toBeCloseTo(15000, 6)
    // contracted bushels still includes both
    expect(r.contractedBu).toBeCloseTo(35000, 6)
  })

  it('fully_priced but null cash_price is excluded from cash avg and NOT awaiting', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({
          id: '1', crop_id: 'corn', contracted_bushels: 10000,
          pricing_status: 'fully_priced', cash_price: null,
        }),
      ],
    })
    // cashBu stays 0 → avgCashPrice null; excluded only counts non-fully_priced
    expect(r.avgCashPrice).toBeNull()
    expect(r.excludedAwaitingBu).toBeCloseTo(0, 6)
  })

  it('avgCashPrice is null when there are no priced contracts', () => {
    const r = single({
      crop: CORN,
      acres: 100,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
    })
    expect(r.avgCashPrice).toBeNull()
  })
})

describe('computeMarketing — weighted-average basis', () => {
  it('basis is bushel-weighted across contracts that carry a basis', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        // 40,000 bu @ basis −0.20
        contract({
          id: '1', crop_id: 'corn', contracted_bushels: 40000,
          contract_type: 'forward', cash_price: 4.0, futures_price: 4.2, basis: -0.2,
        }),
        // 10,000 bu @ basis +0.10
        contract({
          id: '2', crop_id: 'corn', contracted_bushels: 10000,
          contract_type: 'forward', cash_price: 4.4, futures_price: 4.3, basis: 0.1,
        }),
      ],
    })
    // avgBasis = (−0.20*40000 + 0.10*10000)/50000 = (−8000 + 1000)/50000 = −7000/50000 = −0.14
    expect(r.avgBasis).toBeCloseTo(-0.14, 6)
  })

  it('avgBasis is null when no contract carries a basis', () => {
    const r = single({
      crop: CORN,
      acres: 100,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 5000, cash_price: 4, basis: null }),
      ],
    })
    expect(r.avgBasis).toBeNull()
  })
})

describe('computeMarketing — weighted-average futures across contract types + hedges', () => {
  it('blends contract futures with short futures positions, bushel-weighted', () => {
    const r = single({
      crop: CORN,
      acres: 2000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        // forward 30,000 bu @ futures 4.50
        contract({
          id: '1', crop_id: 'corn', contracted_bushels: 30000,
          contract_type: 'forward', futures_price: 4.5, basis: -0.1, cash_price: 4.4,
        }),
        // HTA 20,000 bu @ futures 4.70
        contract({
          id: '2', crop_id: 'corn', contracted_bushels: 20000,
          contract_type: 'hta', futures_price: 4.7, basis: -0.2, cash_price: 4.5,
          pricing_status: 'fully_priced',
        }),
      ],
      futures: [
        // 4 short contracts @ 4.00 → 4*5000 = 20,000 bu
        future({ id: 'f1', commodity: 'Corn', side: 'short', num_contracts: 4, trade_price: 4.0, status: 'open' }),
      ],
    })
    // fBu = 30000 + 20000 + 20000 = 70000
    // fW  = 4.50*30000 + 4.70*20000 + 4.00*20000
    //     = 135000 + 94000 + 80000 = 309000
    // rawAvgFutures = 309000 / 70000 = 4.414285714285...
    // no closed P&L / options → adjPerBu = 0
    expect(r.avgFutures).toBeCloseTo(309000 / 70000, 6)
    // confirm bushel-weighting, not the 3-way mean (4.50+4.70+4.00)/3 = 4.40
    expect(r.avgFutures).not.toBeCloseTo(4.4, 4)
  })

  it('ignores LONG futures positions (only short hedges fold in)', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 10000, futures_price: 4.5, basis: -0.1, cash_price: 4.4 }),
      ],
      futures: [
        future({ id: 'fL', commodity: 'Corn', side: 'long', num_contracts: 10, trade_price: 9.99, status: 'open' }),
      ],
    })
    // long position excluded → avgFutures = 4.50 from the single contract only
    expect(r.avgFutures).toBeCloseTo(4.5, 6)
  })

  it('only matching-commodity / matching-crop-year short futures are included', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 10000, futures_price: 4.5, basis: -0.1, cash_price: 4.4 }),
      ],
      futures: [
        // wrong commodity
        future({ id: 'fS', commodity: 'Soybeans', side: 'short', num_contracts: 2, trade_price: 10, status: 'open' }),
        // wrong crop year
        future({ id: 'fY', commodity: 'Corn', side: 'short', num_contracts: 2, trade_price: 10, status: 'open', crop_year: 2025 }),
      ],
    })
    expect(r.avgFutures).toBeCloseTo(4.5, 6)
  })

  it('folds CLOSED futures realized P&L (net of commission) into the avg futures price', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        // 50,000 bu @ futures 4.50
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 50000, futures_price: 4.5, basis: -0.1, cash_price: 4.4 }),
      ],
      futures: [
        // CLOSED short, realized_pnl 6,000, commission 100 → net 5,900 added to numerator P&L
        future({
          id: 'fc', commodity: 'Corn', side: 'short', num_contracts: 0,
          trade_price: 0, status: 'closed', realized_pnl: 6000, commission: 100,
        }),
      ],
    })
    // NOTE: a closed future with num_contracts 0 still contributes 0 bu to fBu but
    // its realized P&L is folded in via adjPerBu. fBu = 50,000 (contract only).
    // rawAvgFutures = 4.50
    // closedFuturesPnl = 6000 − 100 = 5900 ; optionsPnl = 0
    // adjPerBu = 5900 / 50000 = 0.118
    // avgFutures = round(4.50 + 0.118, 6) = 4.618
    expect(r.avgFutures).toBeCloseTo(4.618, 6)
  })

  it('folds settled OPTIONS realized P&L into the avg futures price; open options ignored', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 50000, futures_price: 4.5, basis: -0.1, cash_price: 4.4 }),
      ],
      options: [
        // settled (expired_worthless): realized_pnl −2,000 → folds in
        option({ id: 'o1', commodity: 'Corn', status: 'expired_worthless', realized_pnl: -2000 }),
        // open option: ignored even with a realized_pnl set
        option({ id: 'o2', commodity: 'Corn', status: 'open', realized_pnl: 9999 }),
      ],
    })
    // optionsPnl = −2000 (open one excluded). closedFuturesPnl = 0.
    // fBu = 50,000. adjPerBu = −2000 / 50000 = −0.04
    // avgFutures = round(4.50 − 0.04, 6) = 4.46
    expect(r.avgFutures).toBeCloseTo(4.46, 6)
  })

  it('avgFutures is null when there are no futures-priced contracts or short hedges', () => {
    const r = single({
      crop: CORN,
      acres: 100,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        // basis contract still awaiting futures — futures_price null
        contract({
          id: '1', crop_id: 'corn', contracted_bushels: 5000,
          contract_type: 'basis', pricing_status: 'awaiting_futures',
          futures_price: null, basis: -0.2, cash_price: null,
        }),
      ],
    })
    expect(r.avgFutures).toBeNull()
    // but basis still averages
    expect(r.avgBasis).toBeCloseTo(-0.2, 6)
  })

  it('crop with no traded commodity (Canola) ignores all futures/options', () => {
    const r = single({
      crop: CANOLA,
      acres: 500,
      assumptions: [assumption({ crop_id: 'canola', expected_yield: 50 })],
      contracts: [
        contract({ id: '1', crop_id: 'canola', contracted_bushels: 5000, futures_price: 4, basis: -0.1, cash_price: 3.9 }),
      ],
      futures: [
        // commodity Corn — but Canola maps to null commodity so the filter yields []
        future({ id: 'f1', commodity: 'Corn', side: 'short', num_contracts: 5, trade_price: 1, status: 'open' }),
      ],
    })
    // contract futures still counts; the short futures position is excluded because
    // cropToCommodity('Canola') === null → cropFutures = []
    expect(r.avgFutures).toBeCloseTo(4, 6)
    expect(r.openFuturesHedgedBu).toBeCloseTo(0, 6)
  })
})

describe('computeMarketing — total avg price, open hedged bushels', () => {
  it('totalAvgPrice = avgFutures + avgBasis (after P&L adjustment)', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 50000, futures_price: 4.5, basis: -0.25, cash_price: 4.25 }),
      ],
    })
    // avgFutures = 4.50 (no adj), avgBasis = −0.25 → totalAvgPrice = 4.25
    expect(r.avgFutures).toBeCloseTo(4.5, 6)
    expect(r.avgBasis).toBeCloseTo(-0.25, 6)
    expect(r.totalAvgPrice).toBeCloseTo(4.25, 6)
  })

  it('totalAvgPrice null when futures present but basis missing', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      contracts: [
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 5000, futures_price: 4.5, basis: null, cash_price: null }),
      ],
    })
    expect(r.avgFutures).toBeCloseTo(4.5, 6)
    expect(r.avgBasis).toBeNull()
    expect(r.totalAvgPrice).toBeNull()
  })

  it('openFuturesHedgedBu sums only OPEN short positions (bu = contracts × 5000)', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      futures: [
        future({ id: 'o1', commodity: 'Corn', side: 'short', num_contracts: 3, trade_price: 4, status: 'open' }),
        future({ id: 'o2', commodity: 'Corn', side: 'short', num_contracts: 2, trade_price: 4, status: 'open' }),
        // closed — excluded from openFuturesHedgedBu
        future({ id: 'c1', commodity: 'Corn', side: 'short', num_contracts: 5, trade_price: 4, status: 'closed', realized_pnl: 0 }),
      ],
    })
    // openFuturesHedgedBu = (3 + 2) * 5000 = 25,000
    expect(r.openFuturesHedgedBu).toBeCloseTo(5 * CONTRACT_BU, 6)
  })
})

describe('computeMarketing — cost per bushel and profit', () => {
  it('costPerBu = cost_per_acre / yield (round 4); profit uses totalAvgPrice', () => {
    const r = single({
      crop: CORN,
      acres: 1000,
      assumptions: [
        assumption({ crop_id: 'corn', expected_yield: 200, cost_per_acre: 700 }),
      ],
      contracts: [
        // priced so totalAvgPrice resolves: futures 4.60, basis −0.10 → 4.50
        contract({ id: '1', crop_id: 'corn', contracted_bushels: 50000, futures_price: 4.6, basis: -0.1, cash_price: 4.5 }),
      ],
    })
    // yield = 200, costPerAcre = 700
    // costPerBu = round(700 / 200, 4) = 3.5
    expect(r.costPerBu).toBeCloseTo(3.5, 6)
    expect(r.costPerAcre).toBeCloseTo(700, 6)
    // totalAvgPrice = 4.60 − 0.10 = 4.50  (profitPrice)
    expect(r.totalAvgPrice).toBeCloseTo(4.5, 6)
    // profitPerAcre = round(200 * 4.50 − 700, 2) = round(900 − 700, 2) = 200
    expect(r.profitPerAcre).toBeCloseTo(200, 6)
    // totalProfit = round(200 * 1000, 2) = 200,000
    expect(r.totalProfit).toBeCloseTo(200000, 6)
  })

  it('falls back to avgCashPrice for profit when no futures/basis price', () => {
    const r = single({
      crop: CORN,
      acres: 500,
      assumptions: [
        assumption({ crop_id: 'corn', expected_yield: 180, cost_per_acre: 600 }),
      ],
      contracts: [
        // forward priced as cash only (no futures/basis legs) → totalAvgPrice null
        contract({
          id: '1', crop_id: 'corn', contracted_bushels: 20000,
          contract_type: 'forward', pricing_status: 'fully_priced',
          cash_price: 4.8, futures_price: null, basis: null,
        }),
      ],
    })
    expect(r.totalAvgPrice).toBeNull()
    expect(r.avgCashPrice).toBeCloseTo(4.8, 6)
    // profitPrice falls back to avgCashPrice 4.80
    // profitPerAcre = round(180 * 4.80 − 600, 2) = round(864 − 600, 2) = 264
    expect(r.profitPerAcre).toBeCloseTo(264, 6)
    // totalProfit = round(264 * 500, 2) = 132,000
    expect(r.totalProfit).toBeCloseTo(132000, 6)
  })

  it('costPerBu null when cost_per_acre missing; profit null when no price', () => {
    const r = single({
      crop: CORN,
      acres: 100,
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
    })
    expect(r.costPerAcre).toBeNull()
    expect(r.costPerBu).toBeNull()
    // no priced contracts → no profitPrice → profitPerAcre null
    expect(r.profitPerAcre).toBeNull()
    expect(r.totalProfit).toBeNull()
  })
})

describe('computeMarketing — row inclusion / ordering', () => {
  it('only includes crops that have a planting in the crop year; sorts by name', () => {
    const rows = computeMarketing({
      cropYear: 2026,
      crops: [BEANS, CORN, crop({ id: 'rice', name: 'Rice' })],
      // Rice has no planting → excluded. Corn & Beans planted.
      plantings: [planting('corn', 1000), planting('beans', 500)],
      contracts: [],
      futures: [],
      options: [],
      assumptions: [
        assumption({ crop_id: 'corn', expected_yield: 200 }),
        assumption({ crop_id: 'beans', expected_yield: 60 }),
      ],
      actualProductionByCrop: new Map(),
    })
    expect(rows.map((r) => r.cropName)).toEqual(['Corn', 'Soybeans'])
  })

  it('aggregates acres across multiple plantings of the same crop', () => {
    const rows = computeMarketing({
      cropYear: 2026,
      crops: [CORN],
      plantings: [planting('corn', 600), planting('corn', 400)],
      contracts: [],
      futures: [],
      options: [],
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 200 })],
      actualProductionByCrop: new Map(),
    })
    expect(rows[0].acres).toBeCloseTo(1000, 6)
    // production = 200 * 1000 = 200,000
    expect(rows[0].totalProduction).toBeCloseTo(200000, 6)
  })
})

describe('segmentAcresByCrop', () => {
  it('splits acres into full vs double-crop using the doubleCropIds set', () => {
    const segs = segmentAcresByCrop(
      [
        { id: 'p1', crop_id: 'corn', season_year: 2026, irrigated_acres: 300, dryland_acres: 100 },
        { id: 'p2', crop_id: 'corn', season_year: 2026, irrigated_acres: 50, dryland_acres: 200 },
        // wrong year — excluded
        { id: 'p3', crop_id: 'corn', season_year: 2025, irrigated_acres: 999, dryland_acres: 999 },
      ],
      2026,
      new Set(['p2']), // p2 is double-crop
    )
    const seg = segs.get('corn')!
    expect(seg.fullIrr).toBeCloseTo(300, 6)
    expect(seg.fullDry).toBeCloseTo(100, 6)
    expect(seg.dcIrr).toBeCloseTo(50, 6)
    expect(seg.dcDry).toBeCloseTo(200, 6)
  })
})

describe('expectedProductionFromBreakout', () => {
  it('applies per-segment yields, falling back to blended expected_yield where blank', () => {
    const segByCrop = new Map([
      ['corn', { fullIrr: 100, fullDry: 200, dcIrr: 10, dcDry: 20 }],
    ])
    const out = expectedProductionFromBreakout(
      segByCrop,
      [
        assumption({
          crop_id: 'corn',
          expected_yield: 150, // blended fallback
          expected_yield_irr: 230, // overrides full-irrigated
          expected_yield_dry: 180, // overrides full-dryland
          // dc_irr / dc_dry blank → fall back to blended 150
        }),
      ],
      2026,
    )
    // prod = 230*100 + 180*200 + 150*10 + 150*20
    //      = 23000 + 36000 + 1500 + 3000 = 63,500
    expect(out.get('corn')).toBeCloseTo(63500, 2)
  })

  it('omits a crop with no yields set at all', () => {
    const segByCrop = new Map([
      ['corn', { fullIrr: 100, fullDry: 0, dcIrr: 0, dcDry: 0 }],
    ])
    const out = expectedProductionFromBreakout(
      segByCrop,
      [assumption({ crop_id: 'corn' })], // all yields null
      2026,
    )
    expect(out.has('corn')).toBe(false)
  })
})
