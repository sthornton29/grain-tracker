import { describe, it, expect } from 'vitest'
import { aggregateMarketing, computeMarketing, isCottonCrop, type Planting } from '@/lib/marketing'
import { buildMarketingExport } from '@/lib/marketing-export'
import { computeRevenueProjections, type InsuranceProceeds, type GovtProceeds } from '@/lib/revenue-projections'
import { formatNumber, excelNumFmt } from '@/lib/exports'
import { optionPremiumTotal, parsePrice, COMMODITY_SPECS } from '@/lib/hedging'
import type { Crop, CropAssumption, FuturesPosition } from '@/lib/types'

// Cotton on the marketing surfaces: lbs of lint + ¢/lb, production and CT
// hedges only. All worked numbers hand-derived:
//   10 short CTZ26 @ 72.65¢ = 500,000 lbs hedged
//   revenue = lbs × ¢/lb ÷ 100; realized hedge P&L counted exactly once.

const CY = 2026

function crop(id: string, name: string): Crop {
  return { id, name, base_moisture_pct: 0, base_lb_per_bushel: 0, harvest_category: 'fall', double_crop: false }
}
function assumption(over: Partial<CropAssumption> & Pick<CropAssumption, 'crop_id'>): CropAssumption {
  return {
    id: `a-${over.crop_id}`, crop_year: CY,
    expected_yield: null, expected_yield_irr: null, expected_yield_dry: null,
    expected_yield_dc_irr: null, expected_yield_dc_dry: null, harvest_complete: false,
    assumed_basis: 0, assumed_futures: null, reference_contract_month: null, cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null,
    cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null, notes: null,
    created_at: '', updated_at: '', ...over,
  }
}
function futuresPosition(over: Partial<FuturesPosition>): FuturesPosition {
  return {
    id: `f-${over.trade_price}-${over.status}`, entity_id: null, commodity: 'Cotton',
    contract_month: 'DEC 26', contract_symbol: 'CTZ26', crop_year: CY, side: 'short',
    num_contracts: 10, trade_price: 72.65, trade_date: '2026-03-01', status: 'open',
    close_price: null, close_date: null, realized_pnl: null, commission: 0,
    notes: null, source: 'statement_import', created_at: '', ...over,
  }
}

const cottonCrop = crop('cotton', 'Cotton')
const plantings: Planting[] = [{ crop_id: 'cotton', season_year: CY, planted_acres: 600 }]

function computeCotton(args?: {
  futures?: FuturesPosition[]
  assumptions?: CropAssumption[]
  currentFuturesByCrop?: Map<string, number>
  cottonProductionByCrop?: Map<string, { lintLbs: number; bales: number }>
}) {
  return computeMarketing({
    cropYear: CY, crops: [cottonCrop], plantings, contracts: [], options: [],
    futures: args?.futures ?? [],
    assumptions: args?.assumptions ?? [assumption({ crop_id: 'cotton', expected_yield: 1000 })],
    actualProductionByCrop: new Map(),
    currentFuturesByCrop: args?.currentFuturesByCrop,
    cottonProductionByCrop: args?.cottonProductionByCrop,
  })[0]
}

describe('isCottonCrop', () => {
  it('matches cotton crop names only', () => {
    expect(isCottonCrop('Cotton')).toBe(true)
    expect(isCottonCrop('Upland Cotton')).toBe(true)
    expect(isCottonCrop('Corn')).toBe(false)
    expect(isCottonCrop(null)).toBe(false)
  })
})

describe('cotton statement extraction shapes', () => {
  it('parses a decimal ¢/lb price exactly (no fractional conversion)', () => {
    expect(parsePrice('72.65')).toBe(72.65)
    expect(parsePrice('78.30')).toBe(78.3)
  })
  it('prices a cotton option premium over 50,000 lbs, not the 5,000-bu default', () => {
    // 5.00¢/lb × 2 contracts × 50,000 lbs ÷ 100 = $5,000
    expect(optionPremiumTotal(5, 2, COMMODITY_SPECS.Cotton.contractSizeBu)).toBe(5000)
  })
})

describe('cotton marketing computation', () => {
  it('hedged lbs come from open short CT contracts × 50,000', () => {
    const row = computeCotton({ futures: [futuresPosition({})] })
    expect(row.unit).toBe('lbs')
    expect(row.openHedgeBu).toBe(500_000)
    expect(row.openHedgeAvg).toBe(72.65)
    expect(row.contractedBu).toBe(0) // no physical cotton marketing yet
    expect(row.basisAssumedBu).toBe(0) // no basis concept for cotton
  })

  it('revenue = lbs × ¢/lb ÷ 100 across hedged and unhedged lbs', () => {
    // 600 ac × 1,000 lbs/ac = 600,000 lbs: 500,000 hedged @ 72.65¢ + 100,000
    // unhedged @ CTZ 68.00¢ → 363,250 + 68,000 = 431,250.
    const row = computeCotton({
      futures: [futuresPosition({})],
      currentFuturesByCrop: new Map([['cotton', 68]]),
    })
    expect(row.totalProduction).toBe(600_000)
    expect(row.unpricedBu).toBe(100_000)
    expect(row.blendedRevenue).toBeCloseTo(431_250, 2)
    // Effective headline price in ¢/lb: 431,250 × 100 ÷ 600,000 = 71.875¢.
    expect(row.totalAvgPrice).toBeCloseTo(71.875, 4)
  })

  it('counts realized hedge P&L exactly once, as dollars on top of lbs revenue', () => {
    // Same as above + a lifted 10-lot short: opened 72.65¢, bought back 68.00¢
    // → (72.65 − 68.00) × 10 × 500 = +$23,250 (the hand-verified case).
    const closed = futuresPosition({
      id: 'closed', status: 'closed', close_price: 68, close_date: '2026-06-01', realized_pnl: 23_250,
    })
    const row = computeCotton({
      futures: [futuresPosition({}), closed],
      currentFuturesByCrop: new Map([['cotton', 68]]),
    })
    expect(row.hedgeRealizedPnl).toBe(23_250)
    expect(row.blendedRevenue).toBeCloseTo(431_250 + 23_250, 2)
    // ¢/lb adjustment over total lbs: 23,250 × 100 ÷ 600,000 = 3.875¢.
    expect(row.hedgeAdjPerBu).toBeCloseTo(3.875, 4)
  })

  it('uses actual gin-receipt lbs (with bales) once harvest is complete', () => {
    const row = computeCotton({
      futures: [],
      assumptions: [assumption({ crop_id: 'cotton', expected_yield: 1000, harvest_complete: true, cost_per_acre: 550 })],
      cottonProductionByCrop: new Map([['cotton', { lintLbs: 412_000, bales: 858 }]]),
      currentFuturesByCrop: new Map([['cotton', 70]]),
    })
    expect(row.totalProduction).toBe(412_000)
    expect(row.cottonBales).toBe(858)
    expect(row.yieldLabel).toBe('Actual')
    expect(row.yield).toBeCloseTo(412_000 / 600, 1)
    // Profitability in dollars: 412,000 lbs × 70¢ ÷ 100 − 600 ac × $550.
    expect(row.blendedRevenue).toBeCloseTo(288_400, 2)
    expect(row.totalProfit).toBeCloseTo(288_400 - 330_000, 2)
  })

  it('keeps lbs out of the bushel production total in the shared aggregate', () => {
    const corn = crop('corn', 'Corn')
    const rows = computeMarketing({
      cropYear: CY, crops: [cottonCrop, corn],
      plantings: [...plantings, { crop_id: 'corn', season_year: CY, planted_acres: 100 }],
      contracts: [], futures: [futuresPosition({})], options: [],
      assumptions: [
        assumption({ crop_id: 'cotton', expected_yield: 1000, cost_per_acre: 550 }),
        assumption({ crop_id: 'corn', expected_yield: 180, cost_per_acre: 600 }),
      ],
      actualProductionByCrop: new Map(),
      currentFuturesByCrop: new Map([['cotton', 68], ['corn', 4.5]]),
    })
    const agg = aggregateMarketing(rows)
    expect(agg.totalProduction).toBe(18_000) // corn bushels only
    expect(agg.totalProductionLbs).toBe(600_000) // cotton lbs, kept apart
    // Dollars still combine: corn 18,000×4.50 + cotton 431,250.
    expect(agg.blendedRevenue).toBeCloseTo(81_000 + 431_250, 2)
  })
})

describe('reconciliation identity holds with a cotton crop present', () => {
  it('RevProj profit − Marketing total profit === insurance + govt, incl. cotton', () => {
    const corn = crop('corn', 'Corn')
    const marketingRows = computeMarketing({
      cropYear: CY, crops: [cottonCrop, corn],
      plantings: [...plantings, { crop_id: 'corn', season_year: CY, planted_acres: 1000 }],
      contracts: [], futures: [futuresPosition({})], options: [],
      assumptions: [
        assumption({ crop_id: 'cotton', expected_yield: 1000, cost_per_acre: 550 }),
        assumption({ crop_id: 'corn', expected_yield: 180, cost_per_acre: 600 }),
      ],
      actualProductionByCrop: new Map(),
      currentFuturesByCrop: new Map([['cotton', 68], ['corn', 4.5]]),
    })
    const insuranceByCrop = new Map<string, InsuranceProceeds>([
      ['cotton', { netPnl: 12_000, totalIndemnity: 20_000, premium: 8_000 }],
      ['corn', { netPnl: -3_000, totalIndemnity: 0, premium: 3_000 }],
    ])
    const govtByCrop = new Map<string, GovtProceeds>([
      ['cotton', { arcPlc: 5_000, cropSpecificOther: 0, allocatedOther: 1_000 }],
      ['corn', { arcPlc: 9_000, cropSpecificOther: 0, allocatedOther: 0 }],
    ])
    const { rows, totals } = computeRevenueProjections({
      marketingRows, contracts: [], cropYear: CY,
      marketPriceByCrop: new Map(), insuranceByCrop, govtByCrop,
    })
    for (const r of rows) {
      const mr = marketingRows.find((m) => m.cropId === r.cropId)!
      const insNet = insuranceByCrop.get(r.cropId)!.netPnl
      const g = govtByCrop.get(r.cropId)!
      expect(r.cropSalesRevenue).toBeCloseTo(mr.blendedRevenue, 6)
      expect(r.profit! - mr.totalProfit!).toBeCloseTo(insNet + g.arcPlc + g.cropSpecificOther + g.allocatedOther, 6)
    }
    const agg = aggregateMarketing(marketingRows)
    expect(totals.cropSalesRevenue).toBeCloseTo(agg.blendedRevenue, 6)
    expect(totals.totalProductionLbs).toBe(600_000)
    // Cotton row carries its unit and ¢/lb figures downstream.
    const cottonRow = rows.find((r) => r.cropId === 'cotton')!
    expect(cottonRow.unit).toBe('lbs')
    expect(cottonRow.avgSalesPrice).toBeCloseTo((cottonRow.cropSalesRevenue / 600_000) * 100, 6) // ¢/lb
    expect(cottonRow.breakevenPrice).toBeCloseTo((550 * 100) / 1000, 6) // 55¢/lb
  })
})

describe('unit-aware export formats', () => {
  it("formatNumber renders 'cents' (¢-stored) as $/lb with 4 decimals; 'lbs' with commas", () => {
    expect(formatNumber(72.65, 'cents')).toBe('$0.7265')
    expect(formatNumber(70, 'cents')).toBe('$0.7000')
    expect(formatNumber(412_000, 'lbs')).toBe('412,000')
    expect(excelNumFmt('cents')).toBe('$#,##0.0000;($#,##0.0000)')
    expect(excelNumFmt('lbs')).toBe('#,##0;(#,##0)')
  })

  it('a mixed grain + cotton marketing export renders $/lb + lbs beside $/bu + bu', () => {
    const corn = crop('corn', 'Corn')
    const rows = computeMarketing({
      cropYear: CY, crops: [cottonCrop, corn],
      plantings: [...plantings, { crop_id: 'corn', season_year: CY, planted_acres: 1000 }],
      contracts: [], futures: [futuresPosition({})], options: [],
      assumptions: [
        assumption({ crop_id: 'cotton', expected_yield: 1000, cost_per_acre: 550 }),
        assumption({ crop_id: 'corn', expected_yield: 180, cost_per_acre: 600 }),
      ],
      actualProductionByCrop: new Map(),
      currentFuturesByCrop: new Map([['cotton', 68], ['corn', 4.5]]),
    })
    const payload = buildMarketingExport({
      year: CY, rows, contracts: [],
      cropMeta: new Map([['cotton', true], ['corn', false]]),
      segByCrop: new Map(),
      combined: { acres: 1600, profit: null },
    })
    const flat = (title: string) =>
      payload.sections.find((s) => s.title === title)!.rows.map((r) => r.join(' | ')).join('\n')

    const cotton = flat('Cotton')
    expect(cotton).toContain('600,000 lbs')
    expect(cotton).toContain('500,000 lbs @ $0.7265')
    expect(cotton).toContain('lbs lint/ac')
    expect(cotton).toContain('Physical cotton marketing not yet tracked')
    expect(cotton).not.toMatch(/\$\d+\.\d{2}\/bu/)

    const cornSec = flat('Corn')
    expect(cornSec).toContain('180,000 bu')
    expect(cornSec).toContain('bu/ac')
    expect(cornSec).toContain('$4.50')
    expect(cornSec).not.toContain('¢')
  })
})
