import { describe, it, expect } from 'vitest'
import { computeMarketing, type Planting } from '@/lib/marketing'
import type { Crop, Contract, CropAssumption, FuturesPosition, OptionPosition } from '@/lib/types'

// Worked examples for the standard marketing methodology. Every expected number
// is hand-derived from the rules in lib/marketing.ts (comments show the arithmetic):
//   raw avg futures = Σ(price×bu)/Σ(bu) over physical-with-futures + OPEN short hedges
//   avg futures price = raw + (realized closed futures+options P&L ÷ TOTAL production)
//   avg basis = bushel-weighted blend over ALL basis-component bushels:
//     locked contracts at their weighted basis + the rest (open HTAs, open
//     hedges, unpriced) at the assumed basis; flat-cash bushels excluded
//   total avg price = avg futures price + avg basis (always computes)
//   blended revenue = Σ buckets at their own price + realized P&L once

const CONTRACT_BU = 5000

function crop(id: string, name: string): Crop {
  return { id, name, base_moisture_pct: 15, base_lb_per_bushel: 56, harvest_category: 'fall', double_crop: false }
}
function planting(crop_id: string, acres: number, season_year = 2026): Planting {
  return { crop_id, season_year, planted_acres: acres }
}
function assumption(over: Partial<CropAssumption> & Pick<CropAssumption, 'crop_id'>): CropAssumption {
  return {
    id: `a-${over.crop_id}`, crop_year: 2026,
    expected_yield: null, expected_yield_irr: null, expected_yield_dry: null,
    expected_yield_dc_irr: null, expected_yield_dc_dry: null, harvest_complete: false,
    assumed_basis: 0, cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null,
    cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null, notes: null,
    created_at: '', updated_at: '', ...over,
  }
}
function contract(over: Partial<Contract> & Pick<Contract, 'crop_id'>): Contract {
  return {
    id: `c-${Math.round((over.contracted_bushels ?? 0))}-${over.contract_type ?? 'forward'}-${over.futures_price ?? 'x'}`,
    contract_number: 'CN', buyer_id: null, entity_id: null, crop_year: 2026,
    contracted_bushels: 0, price_per_bushel: null, notes: null,
    delivery_type: 'pickup', delivery_location_id: null, delivery_start_date: null, delivery_end_date: null,
    completed_at: null, created_at: '', contract_month: null, contract_type: 'forward',
    futures_price: null, basis: null, cash_price: null, service_fee: 0,
    futures_set_date: null, basis_set_date: null, pricing_status: 'fully_priced', ...over,
  }
}
function future(over: Partial<FuturesPosition> & Pick<FuturesPosition, 'commodity' | 'num_contracts' | 'trade_price' | 'status'>): FuturesPosition {
  return {
    id: `f-${over.trade_price}-${over.status}`, entity_id: null, contract_month: 'DEC 26', contract_symbol: 'ZCZ26',
    crop_year: 2026, side: 'short', trade_date: '2026-01-01', close_price: null, close_date: null, realized_pnl: null, commission: 0,
    notes: null, source: 'manual', created_at: '', ...over,
  }
}
function option(over: Partial<OptionPosition> & Pick<OptionPosition, 'commodity' | 'status'>): OptionPosition {
  return {
    id: `o-${over.status}-${over.realized_pnl ?? 'x'}`, entity_id: null, option_type: 'put', side: 'buy',
    underlying_contract_month: 'DEC 26', underlying_symbol: 'ZCZ26', strike_price: 4.5, num_contracts: 1,
    premium_cents: 20, premium_total: 1000, trade_date: '2026-01-01', expiration_date: null, crop_year: 2026,
    close_price_cents: null, close_date: null, realized_pnl: null, commission: 0,
    manual_current_value_cents: null, exercised_position_id: null, notes: null, source: 'manual', created_at: '', ...over,
  }
}

// Run computeMarketing for one corn (or soy) crop with an Est. yield so
// totalProduction = expected_yield × acres.
function run(args: {
  cropId?: string; cropName?: string; acres: number; expectedYield: number
  contracts?: Contract[]; futures?: FuturesPosition[]; options?: OptionPosition[]
  assumedBasis?: number; costPerAcre?: number; currentFutures?: number
}) {
  const cropId = args.cropId ?? 'corn'
  const cropName = args.cropName ?? 'Corn'
  const rows = computeMarketing({
    cropYear: 2026,
    crops: [crop(cropId, cropName)],
    plantings: [planting(cropId, args.acres)],
    contracts: args.contracts ?? [],
    futures: args.futures ?? [],
    options: args.options ?? [],
    assumptions: [assumption({ crop_id: cropId, expected_yield: args.expectedYield, assumed_basis: args.assumedBasis ?? 0, cost_per_acre: args.costPerAcre ?? null })],
    actualProductionByCrop: new Map(),
    currentFuturesByCrop: args.currentFutures != null ? new Map([[cropId, args.currentFutures]]) : undefined,
  })
  return rows[0]
}

describe('computeMarketing — average futures price', () => {
  it('open short hedge only: raw avg = trade price; total = futures + assumed basis', () => {
    // 1000 ac × 180 = 180,000 bu. One open short: 10×5000 = 50,000 bu @ 4.50.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.20, costPerAcre: 600,
      futures: [future({ commodity: 'Corn', num_contracts: 10, trade_price: 4.5, status: 'open' })],
    })
    expect(r.totalProduction).toBe(180000)
    expect(r.openHedgeBu).toBe(50000)
    expect(r.futuresPricedBu).toBe(50000)
    expect(r.rawAvgFutures).toBeCloseTo(4.5, 6)
    expect(r.hedgeAdjPerBu).toBe(0)               // no closed positions
    expect(r.avgFutures).toBeCloseTo(4.5, 6)
    expect(r.avgBasisAssumed).toBe(true)
    expect(r.avgBasis).toBeCloseTo(-0.30, 6)
    expect(r.totalAvgPrice).toBeCloseTo(4.20, 6)  // 4.50 + (-0.30)
    // Blended: hedge-covered 50,000 @ (4.50-0.30)=4.20 → 210,000;
    //          unpriced 130,000 @ (current 4.20-0.30)=3.90 → 507,000. Total 717,000.
    expect(r.blendedRevenue).toBeCloseTo(717000, 2)
    // Revenue/Ac = Total Avg $ × yield = 4.20 × 180 = 756; Profit/Ac = 756 − 600.
    expect(r.revenuePerAcre).toBeCloseTo(756, 2)
    expect(r.profitPerAcre).toBeCloseTo(156, 2)
    expect(r.totalProfit).toBeCloseTo(156000, 2)  // 156 × 1000 ac
  })

  it('physical HTA + open short: weighted raw avg over both', () => {
    // 180,000 bu. HTA 60,000 @ futures 4.60 (basis not set). Open short 50,000 @ 4.50.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.20,
      contracts: [contract({ crop_id: 'corn', contract_type: 'hta', contracted_bushels: 60000, futures_price: 4.6, pricing_status: 'awaiting_basis' })],
      futures: [future({ commodity: 'Corn', num_contracts: 10, trade_price: 4.5, status: 'open' })],
    })
    expect(r.physicalFuturesBu).toBe(60000)
    expect(r.openHedgeBu).toBe(50000)
    // (4.60×60,000 + 4.50×50,000) / 110,000 = 501,000/110,000 = 4.5545454…
    expect(r.rawAvgFutures).toBeCloseTo(4.554545, 5)
    expect(r.avgFutures).toBeCloseTo(4.554545, 5) // no closed P&L
    expect(r.avgBasisAssumed).toBe(true)          // HTA basis unset → assumed
    expect(r.totalAvgPrice).toBeCloseTo(4.254545, 5)
    // Blended: HTA 60,000 @ (4.60 + assumed -0.30)=4.30 → 258,000;
    //          hedge 50,000 @ (4.50-0.30)=4.20 → 210,000;
    //          unpriced 70,000 @ (4.20-0.30)=3.90 → 273,000. Total 741,000.
    expect(r.blendedRevenue).toBeCloseTo(741000, 2)
  })

  it('closed hedge with a gain: trade price NOT in average; P&L spread over total production', () => {
    // 1000 ac × 200 = 200,000 bu. Physical futures 50,000 @ 4.40 (basis -0.25).
    // Closed short 50,000: 4.50→4.00 = +25,000 gross, 100 commission → 24,900 net.
    const r = run({
      acres: 1000, expectedYield: 200, assumedBasis: 0, currentFutures: 4.10,
      contracts: [contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 50000, futures_price: 4.4, basis: -0.25, cash_price: 4.15 })],
      futures: [future({ commodity: 'Corn', num_contracts: 10, trade_price: 4.5, status: 'closed', close_price: 4.0, realized_pnl: 25000, commission: 100 })],
    })
    expect(r.openHedgeBu).toBe(0)
    expect(r.futuresPricedBu).toBe(50000)
    expect(r.rawAvgFutures).toBeCloseTo(4.40, 6)   // 4.50 trade price is EXCLUDED
    expect(r.hedgeRealizedPnl).toBeCloseTo(24900, 2)
    // 24,900 ÷ 200,000 total production = 0.1245 (NOT ÷ 50,000 = 0.498)
    expect(r.hedgeAdjPerBu).toBeCloseTo(0.1245, 6)
    expect(r.avgFutures).toBeCloseTo(4.5245, 6)    // 4.40 + 0.1245
    // Basis blends: locked 50,000 @ -0.25 + unpriced 150,000 @ assumed 0
    // → (-12,500 + 0)/200,000 = -0.0625
    expect(r.avgBasis).toBeCloseTo(-0.0625, 6)
    expect(r.totalAvgPrice).toBeCloseTo(4.462, 6)  // 4.5245 - 0.0625
    // Blended: forward 50,000 @ (4.40-0.25)=4.15 → 207,500;
    //          unpriced 150,000 @ (current 4.10 + 0)=4.10 → 615,000; + 24,900 P&L.
    expect(r.blendedRevenue).toBeCloseTo(847400, 2) // 207,500 + 615,000 + 24,900
  })

  it('mixed flat-cash + futures-component: flat-cash excluded from futures & basis averages', () => {
    // 180,000 bu. A: flat-cash 40,000 @ 4.80. B: futures 4.50 / basis -0.20 (40,000).
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.10,
      contracts: [
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 40000, cash_price: 4.8 }),
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 40000, futures_price: 4.5, basis: -0.2, cash_price: 4.3 }),
      ],
    })
    expect(r.physicalFuturesBu).toBe(40000)        // only B has a futures price
    expect(r.rawAvgFutures).toBeCloseTo(4.50, 6)
    // Basis blends over basis-component bushels only (flat-cash A excluded):
    // locked 40,000 @ -0.20 + unpriced 100,000 @ assumed -0.30
    // → (-8,000 - 30,000)/140,000 = -0.2714285714…
    expect(r.avgBasis).toBeCloseTo(-0.271429, 5)
    expect(r.avgBasisAssumed).toBe(false)
    expect(r.totalAvgPrice).toBeCloseTo(4.228571, 5) // 4.50 - 0.271429
    // Blended: A 40,000 @ 4.80 = 192,000; B 40,000 @ (4.50-0.20)=4.30 = 172,000;
    //          unpriced 100,000 @ (4.10-0.30)=3.80 = 380,000. Total 744,000.
    expect(r.blendedRevenue).toBeCloseTo(744000, 2)
  })

  it('no-basis soybean uses assumed basis — Total Average Price and profit compute', () => {
    // The soybean gap: HTA priced on futures but basis not set. 500 ac × 60 = 30,000 bu.
    const r = run({
      cropId: 'soy', cropName: 'Soybean', acres: 500, expectedYield: 60,
      assumedBasis: -0.50, currentFutures: 10.80, costPerAcre: 500,
      contracts: [contract({ crop_id: 'soy', contract_type: 'hta', contracted_bushels: 20000, futures_price: 11.0, pricing_status: 'awaiting_basis' })],
    })
    expect(r.avgFutures).toBeCloseTo(11.0, 6)
    expect(r.avgBasisAssumed).toBe(true)
    expect(r.totalAvgPrice).toBeCloseTo(10.50, 6)   // 11.00 + (-0.50) — was null before
    // Blended: HTA 20,000 @ (11.00-0.50)=10.50 → 210,000;
    //          unpriced 10,000 @ (10.80-0.50)=10.30 → 103,000. Total 313,000.
    expect(r.blendedRevenue).toBeCloseTo(313000, 2)
    // Revenue/Ac = Total Avg $ × yield = 10.50 × 60 = 630; Profit/Ac = 630 − 500.
    expect(r.revenuePerAcre).toBeCloseTo(630, 2)
    expect(r.profitPerAcre).not.toBeNull()          // computes — the soybean fix
    expect(r.profitPerAcre).toBeCloseTo(130, 2)
    expect(r.totalProfit).toBeCloseTo(65000, 2)     // 130 × 500 ac
  })

  it('options realized P&L blends in; open options are excluded', () => {
    // 200,000 bu. Physical futures 50,000 @ 4.50 / basis -0.25. Closed option +10,000.
    // An OPEN option must NOT affect any average.
    const r = run({
      acres: 1000, expectedYield: 200, assumedBasis: 0, currentFutures: 4.20,
      contracts: [contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 50000, futures_price: 4.5, basis: -0.25, cash_price: 4.25 })],
      options: [
        option({ commodity: 'Corn', status: 'closed_offset', realized_pnl: 10000 }),
        option({ commodity: 'Corn', status: 'open', realized_pnl: null }),
      ],
    })
    expect(r.hedgeRealizedPnl).toBeCloseTo(10000, 2) // closed option only
    expect(r.hedgeAdjPerBu).toBeCloseTo(0.05, 6)     // 10,000 ÷ 200,000
    expect(r.avgFutures).toBeCloseTo(4.55, 6)        // 4.50 + 0.05
    // Basis blends: locked 50,000 @ -0.25 + unpriced 150,000 @ assumed 0 = -0.0625
    expect(r.totalAvgPrice).toBeCloseTo(4.4875, 6)   // 4.55 − 0.0625
    // Blended: forward 50,000 @ 4.25 = 212,500; unpriced 150,000 @ 4.20 = 630,000;
    //          + 10,000 option P&L. Total 852,500.
    expect(r.blendedRevenue).toBeCloseTo(852500, 2)
  })

  it('switches from the yield estimate to ACTUAL production once harvest is complete', () => {
    // Estimate 180 × 1000 = 180,000; actual came in lower at 150,000.
    const base = {
      cropYear: 2026, crops: [crop('corn', 'Corn')], plantings: [planting('corn', 1000)],
      contracts: [], futures: [], options: [],
      assumptions: [assumption({ crop_id: 'corn', expected_yield: 180, cost_per_acre: 600 })],
      actualProductionByCrop: new Map([['corn', 150000]]),
      currentFuturesByCrop: new Map([['corn', 4.0]]),
    }
    const est = computeMarketing(base)[0]
    expect(est.totalProduction).toBe(180000)        // estimate while not complete
    expect(est.yieldLabel).toBe('Est.')

    const done = computeMarketing({ ...base, harvestCompleteCropIds: new Set(['corn']) })[0]
    expect(done.totalProduction).toBe(150000)        // actual once harvest complete
    expect(done.yield).toBeCloseTo(150, 6)
    expect(done.yieldLabel).toBe('Actual')
  })

  it('basis composition: ACTUAL when every basis-component bushel is contract-locked', () => {
    // 180,000 bu fully contracted with basis locked on all of it. No hedges, no
    // unpriced bushels → nothing is valued at the assumed basis.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.99, currentFutures: 4.0,
      contracts: [contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 180000, futures_price: 4.5, basis: -0.25, cash_price: 4.25 })],
    })
    expect(r.basisState).toBe('actual')
    expect(r.basisLockedBu).toBe(180000)
    expect(r.basisLockedAvg).toBeCloseTo(-0.25, 6)
    expect(r.basisAssumedBu).toBe(0)
    expect(r.avgBasis).toBeCloseTo(-0.25, 6)       // unchanged by the new fields
  })

  it('basis composition: ASSUMED when no contract has basis locked', () => {
    // HTA 60,000 (no basis) + open hedge 50,000 + unpriced 70,000 = all 180,000
    // bushels valued at the assumed basis; none locked.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.20,
      contracts: [contract({ crop_id: 'corn', contract_type: 'hta', contracted_bushels: 60000, futures_price: 4.6, pricing_status: 'awaiting_basis' })],
      futures: [future({ commodity: 'Corn', num_contracts: 10, trade_price: 4.5, status: 'open' })],
    })
    expect(r.basisState).toBe('assumed')
    expect(r.basisLockedBu).toBe(0)
    expect(r.basisLockedAvg).toBeNull()
    expect(r.basisAssumedBu).toBe(180000)          // 60,000 + 50,000 + 70,000
    expect(r.avgBasisAssumed).toBe(true)           // legacy flag agrees
  })

  it('basis composition: BLENDED splits locked vs assumed-valued bushels; totals unchanged', () => {
    // Locked: forward 45,000 @ basis -0.25. Assumed-valued: HTA 30,000 (no basis)
    // + open hedge 50,000 (capped at unsold 105,000 → all covered) + unpriced
    // 55,000 = 135,000. Flat-cash bushels would count toward neither side.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.20,
      contracts: [
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 45000, futures_price: 4.5, basis: -0.25, cash_price: 4.25 }),
        contract({ crop_id: 'corn', contract_type: 'hta', contracted_bushels: 30000, futures_price: 4.6, pricing_status: 'awaiting_basis' }),
      ],
      futures: [future({ commodity: 'Corn', num_contracts: 10, trade_price: 4.5, status: 'open' })],
    })
    expect(r.basisState).toBe('blended')
    expect(r.basisLockedBu).toBe(45000)
    expect(r.basisLockedAvg).toBeCloseTo(-0.25, 6)
    expect(r.basisAssumedBu).toBe(135000)          // 30,000 + 50,000 + 55,000
    // Blended basis = bushel-weighted: (45,000×-0.25 + 135,000×-0.30)/180,000
    // = (-11,250 - 40,500)/180,000 = -0.2875
    expect(r.avgBasis).toBeCloseTo(-0.2875, 6)
    expect(r.avgBasisAssumed).toBe(false)
    // Blended revenue unchanged: 45,000@(4.50-0.25) + 30,000@(4.60-0.30)
    // + 50,000@(4.50-0.30) + 55,000@(4.20-0.30) = 191,250+129,000+210,000+214,500.
    expect(r.blendedRevenue).toBeCloseTo(744750, 2)
  })

  it('basis composition: flat-cash bushels carry no basis component', () => {
    // Flat-cash 40,000 + locked-basis 40,000; unpriced 100,000. The flat-cash
    // bushels appear on neither side of the basis split.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.10,
      contracts: [
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 40000, cash_price: 4.8 }),
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 40000, futures_price: 4.5, basis: -0.2, cash_price: 4.3 }),
      ],
    })
    expect(r.basisState).toBe('blended')
    expect(r.basisLockedBu).toBe(40000)
    expect(r.basisAssumedBu).toBe(100000)          // unpriced only — not the flat-cash 40,000
    // Blend over 140,000 basis-component bu: (40,000×-0.20 + 100,000×-0.30)/140,000
    expect(r.avgBasis).toBeCloseTo(-0.271429, 5)
  })

  it('blended basis sits between locked and assumed (the corn 0.30/0.50 case)', () => {
    // Locked 60,000 bu @ +0.30; assumed +0.50 on the remaining 120,000 unpriced
    // bu. The blend must NOT collapse to the locked 0.30:
    // (60,000×0.30 + 120,000×0.50)/180,000 = (18,000 + 60,000)/180,000 = 0.4333…
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: 0.50, currentFutures: 4.20,
      contracts: [contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 60000, futures_price: 4.5, basis: 0.30, cash_price: 4.8 })],
    })
    expect(r.basisState).toBe('blended')
    expect(r.basisLockedAvg).toBeCloseTo(0.30, 6)
    expect(r.avgBasis).toBeCloseTo(0.433333, 5)
    expect(r.totalAvgPrice).toBeCloseTo(4.933333, 5) // 4.50 + 0.4333…
  })

  it('fully-locked basis ignores the assumed basis entirely', () => {
    // Two priced-basis contracts: 30,000 @ -0.20 and 10,000 @ -0.40 → weighted -0.25.
    // Production = the contracted 40,000 bu (1000 ac × 40), so nothing rides the
    // assumed basis and the wild -0.99 assumption must not leak in.
    const r = run({
      acres: 1000, expectedYield: 40, assumedBasis: -0.99, currentFutures: 4.0,
      contracts: [
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 30000, futures_price: 4.5, basis: -0.2, cash_price: 4.3 }),
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 10000, futures_price: 4.5, basis: -0.4, cash_price: 4.1 }),
      ],
    })
    // (−0.20×30,000 + −0.40×10,000)/40,000 = (−6,000 − 4,000)/40,000 = −0.25
    expect(r.basisState).toBe('actual')
    expect(r.avgBasis).toBeCloseTo(-0.25, 6)
    expect(r.avgBasisAssumed).toBe(false)
  })
})

describe('computeMarketing — buildup line items', () => {
  it('futuresSources lists each priced source and foots to the futures subtotal', () => {
    // HTA 60,000 @ 4.60 + open short 50,000 @ 4.50 (DEC 26). 180,000 bu.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.20,
      contracts: [contract({ crop_id: 'corn', contract_type: 'hta', contracted_bushels: 60000, futures_price: 4.6, pricing_status: 'awaiting_basis' })],
      futures: [future({ commodity: 'Corn', num_contracts: 10, trade_price: 4.5, status: 'open' })],
    })
    expect(r.futuresSources).toEqual([
      { label: 'HTA contracts', bushels: 60000, avgPrice: 4.6 },
      { label: 'Open hedges (DEC 26)', bushels: 50000, avgPrice: 4.5 },
    ])
    // Foots: Σ bushels = futuresPricedBu, bushel-weighted avg = rawAvgFutures.
    const sumBu = r.futuresSources.reduce((s, x) => s + x.bushels, 0)
    const wAvg = r.futuresSources.reduce((s, x) => s + x.avgPrice * x.bushels, 0) / sumBu
    expect(sumBu).toBe(r.futuresPricedBu)
    expect(wAvg).toBeCloseTo(r.rawAvgFutures!, 6)
  })

  it('futuresSources groups physical contracts by type with a weighted price', () => {
    // Two forward-with-futures (4.40, 4.60) → one weighted 4.50 line; an HTA its own.
    const r = run({
      acres: 1000, expectedYield: 200, assumedBasis: 0, currentFutures: 4.10,
      contracts: [
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 30000, futures_price: 4.4, basis: -0.2, cash_price: 4.2 }),
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 30000, futures_price: 4.6, basis: -0.2, cash_price: 4.4 }),
        contract({ crop_id: 'corn', contract_type: 'hta', contracted_bushels: 40000, futures_price: 4.7, pricing_status: 'awaiting_basis' }),
      ],
    })
    expect(r.futuresSources).toEqual([
      { label: 'Forward contracts', bushels: 60000, avgPrice: 4.5 },
      { label: 'HTA contracts', bushels: 40000, avgPrice: 4.7 },
    ])
    expect(r.futuresPricedBu).toBe(100000)
  })

  it('futuresSources is empty for a flat-cash-only operation', () => {
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: 0, currentFutures: 4.10,
      contracts: [contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 40000, cash_price: 4.8 })],
    })
    expect(r.futuresSources).toEqual([])
    expect(r.futuresPricedBu).toBe(0)
  })

  it('lockedPriceBu counts fully-priced cash + futures-and-basis-locked bushels only', () => {
    // 180,000 bu. Flat-cash 40,000 + forward-with-both 50,000 are locked; an HTA
    // 30,000 (basis unset) is NOT; 60,000 unpriced.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.10,
      contracts: [
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 40000, cash_price: 4.8, pricing_status: 'fully_priced' }),
        contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 50000, futures_price: 4.5, basis: -0.2, cash_price: 4.3, pricing_status: 'fully_priced' }),
        contract({ crop_id: 'corn', contract_type: 'hta', contracted_bushels: 30000, futures_price: 4.6, pricing_status: 'awaiting_basis' }),
      ],
    })
    expect(r.lockedPriceBu).toBe(90000)                     // 40,000 + 50,000 (HTA excluded)
    expect(r.lockedPriceBu).toBeLessThan(r.totalProduction) // → "includes assumptions"
  })

  it('lockedPriceBu equals production when every bushel is fully priced (no marker)', () => {
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.99, currentFutures: 4.0,
      contracts: [contract({ crop_id: 'corn', contract_type: 'forward', contracted_bushels: 180000, futures_price: 4.5, basis: -0.25, cash_price: 4.25, pricing_status: 'fully_priced' })],
    })
    expect(r.lockedPriceBu).toBe(180000)
    expect(r.lockedPriceBu).toBe(r.totalProduction)
    expect(r.basisState).toBe('actual')
  })

  it('futuresAssumedBu is the production without a locked/hedged futures price', () => {
    // 180,000 bu; futures-priced 110,000 (HTA 60k + hedge 50k) → 70,000 assumed.
    const r = run({
      acres: 1000, expectedYield: 180, assumedBasis: -0.30, currentFutures: 4.20,
      contracts: [contract({ crop_id: 'corn', contract_type: 'hta', contracted_bushels: 60000, futures_price: 4.6, pricing_status: 'awaiting_basis' })],
      futures: [future({ commodity: 'Corn', num_contracts: 10, trade_price: 4.5, status: 'open' })],
    })
    expect(r.futuresPricedBu).toBe(110000)
    expect(r.futuresAssumedBu).toBe(70000)                  // 180,000 − 110,000
  })
})
