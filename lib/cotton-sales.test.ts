import { describe, expect, it } from 'vitest'
import {
  awpOn,
  baleLoanPrincipal,
  buildCottonPhysicalSummary,
  computeLoanPrincipal,
  contractPricedCents,
  cottonCashFlowEvents,
  dispositionBoard,
  equityOutcome,
  ldpRateCents,
  netFees,
  projectBaleHandlingFees,
  projectLoanFees,
  projectSaleCheckoff,
  redemptionOutcome,
  storageMonths,
  type CottonPhysicalInputs,
} from './cotton-sales'
import { computeMarketing } from './marketing'
import type {
  CccLoan, CottonBale, CottonBaleDisposition, CottonFee, CottonFeeSchedule,
  CottonLdpRecord, CottonPoolPayment, CottonSalesContract, Crop, CropAssumption,
} from './types'

// ---------- fixtures ----------

const schedule: CottonFeeSchedule = {
  id: 'fs', crop_year: 2026, storage_per_bale_month: 2.85, receiving_per_bale: 6,
  classing_per_bale: 2.2, checkoff_per_bale: 1, checkoff_supplemental_pct: 0.005,
  loan_interest_apr: 0.05, updated_at: '',
}

const bale = (id: string, lbs = 500): CottonBale =>
  ({ id, gin_receipt_id: 'r1', crop_year: 2026, pbi_number: id, net_weight_lbs: lbs, created_at: '' })

const disp = (bale_id: string, disposition: CottonBaleDisposition['disposition'], over: Partial<CottonBaleDisposition> = {}): CottonBaleDisposition =>
  ({ id: `d-${bale_id}`, bale_id, disposition, contract_id: null, loan_id: null, disposition_date: null, created_at: '', ...over })

const contract = (over: Partial<CottonSalesContract> = {}): CottonSalesContract => ({
  id: 'c1', entity_id: null, crop_year: 2026, buyer_id: null, contract_type: 'fixed_price',
  contract_number: 'K-1', contract_date: '2026-10-01', commitment_basis: 'bales',
  committed_bales: null, committed_acres: null, price_cents_per_lb: 74, basis_cents: null,
  futures_month: null, futures_fixed_cents: null, futures_fixed_date: null,
  pricing_status: 'fully_priced', delivery_start: null, delivery_end: null, notes: null, created_at: '',
  ...over,
})

const loan = (over: Partial<CccLoan> = {}): CccLoan => ({
  id: 'L1', entity_id: null, crop_year: 2026, loan_number: 'LN-1', entry_date: '2026-11-01',
  maturity_date: '2027-08-01', loan_rate_base_cents: 55, principal_total: 0, pending_classing: false,
  status: 'open', outcome_date: null, awp_at_outcome_cents: null, redemption_payoff_total: null,
  equity_cents_per_lb: null, equity_total: null, mlg_total: null, interest_paid: null,
  storage_charges_paid: null, buyer_id: null, notes: null, created_at: '',
  ...over,
})

const emptyInputs = (over: Partial<CottonPhysicalInputs> = {}): CottonPhysicalInputs => ({
  cropYear: 2026, bales: [], gradesByBale: new Map(), dispositions: [], contracts: [],
  poolPayments: [], loans: [], loanBales: [], ldps: [], fees: [], ...over,
})

// ---------- CCC loan math ----------

describe('per-bale loan principal', () => {
  it('classing loan value × lbs: the 509-lb bale at 55.1¢ → $280.46 (the classing fixture)', () => {
    expect(baleLoanPrincipal(509, 55.1, 55)).toEqual({ principal: 280.46, pendingClassing: false })
  })
  it('an unclassed bale uses the base rate and flags pending classing', () => {
    expect(baleLoanPrincipal(500, null, 55)).toEqual({ principal: 275, pendingClassing: true })
  })
  it('a loan group sums per-bale values; any unclassed bale flags the group', () => {
    const g = computeLoanPrincipal(
      [
        { net_weight_lbs: 509, loan_value_cents_per_lb: 55.1 },
        { net_weight_lbs: 500, loan_value_cents_per_lb: null },
      ],
      55,
    )
    expect(g.principalTotal).toBe(555.46) // 280.46 + 275.00
    expect(g.lbs).toBe(1009)
    expect(g.pendingClassing).toBe(true)
  })
})

describe('MLG / redemption', () => {
  it('loan 55.00, AWP 51.40 → 3.60¢ MLG per lb, payoff = principal − MLG (interest waived)', () => {
    const o = redemptionOutcome({ principalTotal: 27_500, lbs: 50_000, loanRateBaseCents: 55, awpCents: 51.4 })
    expect(o.mlgRateCents).toBe(3.6)
    expect(o.mlgTotal).toBe(1_800) // 3.6¢ × 50,000 lbs
    expect(o.payoffTotal).toBe(25_700)
  })
  it('AWP at/above the loan rate → no MLG, full principal payoff', () => {
    const o = redemptionOutcome({ principalTotal: 27_500, lbs: 50_000, loanRateBaseCents: 55, awpCents: 58 })
    expect(o.mlgTotal).toBe(0)
    expect(o.payoffTotal).toBe(27_500)
  })
})

describe('LDP rate', () => {
  it('loan rate − AWP, zero-floored', () => {
    expect(ldpRateCents(55, 51.4)).toBe(3.6)
    expect(ldpRateCents(55, 55)).toBe(0)
    expect(ldpRateCents(55, 60)).toBe(0)
  })
})

describe('equity sale', () => {
  it('effective price = banked loan value + equity ¢/lb', () => {
    // 50,000 lbs banked at $27,500 (55¢) + 8¢ equity → $4,000; effective 63¢.
    const o = equityOutcome({ principalTotal: 27_500, lbs: 50_000, equityCentsPerLb: 8 })
    expect(o.equityTotal).toBe(4_000)
    expect(o.effectiveCentsPerLb).toBe(63)
  })
})

describe('awpOn', () => {
  it('picks the most recent week effective on/before the date', () => {
    const rows = [
      { id: '1', week_effective: '2026-11-06', awp_cents: 51.4, source: 'manual' as const, created_at: '' },
      { id: '2', week_effective: '2026-11-13', awp_cents: 52.1, source: 'manual' as const, created_at: '' },
    ]
    expect(awpOn(rows, '2026-11-12')?.awp_cents).toBe(51.4)
    expect(awpOn(rows, '2026-11-13')?.awp_cents).toBe(52.1)
    expect(awpOn(rows, '2026-11-01')).toBeNull()
  })
})

// ---------- contract pricing ----------

describe('on-call pricing', () => {
  it('cash = basis + fixed futures; awaiting futures = unpriced (null)', () => {
    const fixed = contract({ contract_type: 'on_call', price_cents_per_lb: null, basis_cents: -2.5, futures_month: 'DEC 26', futures_fixed_cents: 74.5 })
    expect(contractPricedCents(fixed)).toBe(72)
    const awaiting = contract({ contract_type: 'on_call', price_cents_per_lb: null, basis_cents: -2.5, futures_month: 'DEC 26', futures_fixed_cents: null, pricing_status: 'awaiting_futures' })
    expect(contractPricedCents(awaiting)).toBeNull()
  })
  it('spot/fixed use their price; pools have no locked price', () => {
    expect(contractPricedCents(contract({ contract_type: 'spot', price_cents_per_lb: 71.25 }))).toBe(71.25)
    expect(contractPricedCents(contract({ contract_type: 'pool', price_cents_per_lb: null }))).toBeNull()
  })
})

// ---------- disposition board ----------

describe('disposition board', () => {
  it('conserves: held + loan + sold + pool + delivered = total (missing rows = held)', () => {
    const bales = [bale('b1'), bale('b2'), bale('b3'), bale('b4'), bale('b5', 480)]
    const board = dispositionBoard(bales, [
      disp('b1', 'ccc_loan'), disp('b2', 'sold_spot'), disp('b3', 'pool'), disp('b4', 'contract_delivery'),
      // b5 has no disposition row → held
    ])
    const d = board.byDisposition
    expect(d.held.bales).toBe(1)
    expect(d.held.lbs).toBe(480)
    const sumBales = d.held.bales + d.ccc_loan.bales + d.sold_spot.bales + d.pool.bales + d.contract_delivery.bales
    const sumLbs = d.held.lbs + d.ccc_loan.lbs + d.sold_spot.lbs + d.pool.lbs + d.contract_delivery.lbs
    expect(sumBales).toBe(board.totalBales)
    expect(sumLbs).toBe(board.totalLbs)
    expect(board.totalBales).toBe(5)
    expect(board.totalLbs).toBe(2480)
  })
})

// ---------- fees ----------

describe('fee accrual', () => {
  it('storage months are whole 30.44-day months, min 1', () => {
    expect(storageMonths('2026-11-01', '2026-11-01')).toBe(1)
    expect(storageMonths('2026-11-01', '2026-12-15')).toBe(2)
    expect(storageMonths('2026-11-01', '2027-02-01')).toBe(4) // 92 days → 3.02 → 4
  })
  it('loan fees: storage months × rate × bales + simple interest on principal', () => {
    // 100 bales, $27,500 principal, 2 months (Nov 1 → Dec 15): storage 2 × 2.85
    // × 100 = $570; interest 27,500 × 5% × 44/365 = $165.75.
    const f = projectLoanFees({ bales: 100, principalTotal: 27_500, entryDate: '2026-11-01', asOf: '2026-12-15', schedule })
    expect(f.months).toBe(2)
    expect(f.storage).toBe(570)
    expect(f.interest).toBeCloseTo(165.75, 2)
    expect(f.total).toBeCloseTo(735.75, 2)
  })
  it('checkoff = $1/bale + supplemental % of value', () => {
    // 100 bales on a $37,000 sale: $100 + 0.5% × 37,000 = $285.
    expect(projectSaleCheckoff({ bales: 100, valueDollars: 37_000, schedule })).toBe(285)
  })
  it('handling = (receiving + classing) per bale', () => {
    expect(projectBaleHandlingFees(100, schedule)).toBe(820) // (6.00 + 2.20) × 100
  })
  it('netFees: actuals replace projections in the same slot; unrelated projections still count', () => {
    const fees: CottonFee[] = [
      { id: 'f1', entity_id: null, crop_year: 2026, fee_type: 'storage_monthly', basis: 'per_bale_month', rate: 2.85, loan_id: 'L1', contract_id: null, amount_total: 570, status: 'projected', fee_date: null, notes: null, created_at: '' },
      { id: 'f2', entity_id: null, crop_year: 2026, fee_type: 'storage_monthly', basis: 'per_bale_month', rate: 2.85, loan_id: 'L1', contract_id: null, amount_total: 540, status: 'actual', fee_date: null, notes: null, created_at: '' },
      { id: 'f3', entity_id: null, crop_year: 2026, fee_type: 'checkoff', basis: 'per_bale', rate: 1, loan_id: null, contract_id: 'c1', amount_total: 285, status: 'projected', fee_date: null, notes: null, created_at: '' },
    ]
    expect(netFees(fees)).toBe(825) // actual 540 replaces projected 570; + 285
  })
})

// ---------- the physical summary ----------

function tenBales(prefix: string, lbs = 500): CottonBale[] {
  return Array.from({ length: 10 }, (_, i) => bale(`${prefix}${i}`, lbs))
}

describe('buildCottonPhysicalSummary', () => {
  it('buckets sold / pool / in-loan / held with the loan floor and program dollars', () => {
    // 30 bales × 500 lbs = 15,000 lbs total:
    //  - 10 on a fixed 74¢ contract (5,000 lbs → $3,700)
    //  - 10 on an open CCC loan banked at $2,750 (55¢ floor)
    //  - 10 held
    const bales = [...tenBales('s'), ...tenBales('l'), ...tenBales('h')]
    const dispositions = [
      ...tenBales('s').map((b) => disp(b.id, 'contract_delivery', { contract_id: 'c1' })),
      ...tenBales('l').map((b) => disp(b.id, 'ccc_loan', { loan_id: 'L1' })),
    ]
    const s = buildCottonPhysicalSummary(emptyInputs({
      bales,
      dispositions,
      contracts: [contract()],
      loans: [loan({ principal_total: 2_750 })],
      loanBales: tenBales('l').map((b) => ({ loan_id: 'L1', bale_id: b.id })),
      ldps: [{ id: 'ldp1', entity_id: null, crop_year: 2026, ldp_date: '2026-11-20', awp_cents: 51.4, ldp_rate_cents: 3.6, total_payment: 900, status: 'received', notes: null, created_at: '' } as CottonLdpRecord],
    }))
    expect(s.soldLbs).toBe(5_000)
    expect(s.soldDollars).toBe(3_700)
    expect(s.inLoanLbs).toBe(5_000)
    expect(s.loanBankedDollars).toBe(2_750)
    expect(s.loanFloorCents).toBe(55)
    expect(s.heldLbs).toBe(5_000)
    expect(s.programDollars).toBe(900) // the LDP, counted once
    expect(s.board.totalLbs).toBe(15_000)
  })

  it('an equity-sold loan moves its lbs to Sold at banked + equity', () => {
    const bales = tenBales('l')
    const s = buildCottonPhysicalSummary(emptyInputs({
      bales,
      dispositions: bales.map((b) => disp(b.id, 'ccc_loan', { loan_id: 'L1' })),
      loans: [loan({ status: 'equity_sold', principal_total: 2_750, equity_cents_per_lb: 8, equity_total: 400 })],
      loanBales: bales.map((b) => ({ loan_id: 'L1', bale_id: b.id })),
    }))
    expect(s.inLoanLbs).toBe(0)
    expect(s.soldLbs).toBe(5_000)
    expect(s.soldDollars).toBe(3_150) // 2,750 + 400
    expect(s.soldSources[0].cents).toBe(63) // effective ¢/lb
  })

  it('a redeemed loan books its MLG as program dollars (bales back to held)', () => {
    const bales = tenBales('l')
    const s = buildCottonPhysicalSummary(emptyInputs({
      bales,
      // dispositions returned to held by the app after redemption
      dispositions: [],
      loans: [loan({ status: 'redeemed', principal_total: 2_750, mlg_total: 180, redemption_payoff_total: 2_570 })],
      loanBales: bales.map((b) => ({ loan_id: 'L1', bale_id: b.id })),
    }))
    expect(s.inLoanLbs).toBe(0)
    expect(s.programDollars).toBe(180)
    expect(s.heldLbs).toBe(5_000)
  })

  it('on-call awaiting futures stays out of sold; fixed on-call prices at basis + futures', () => {
    const sold = tenBales('a')
    const waiting = tenBales('w')
    const s = buildCottonPhysicalSummary(emptyInputs({
      bales: [...sold, ...waiting],
      dispositions: [
        ...sold.map((b) => disp(b.id, 'contract_delivery', { contract_id: 'c-fixed' })),
        ...waiting.map((b) => disp(b.id, 'contract_delivery', { contract_id: 'c-wait' })),
      ],
      contracts: [
        contract({ id: 'c-fixed', contract_type: 'on_call', price_cents_per_lb: null, basis_cents: -2.5, futures_fixed_cents: 74.5 }),
        contract({ id: 'c-wait', contract_type: 'on_call', price_cents_per_lb: null, basis_cents: -2.5, futures_fixed_cents: null, pricing_status: 'awaiting_futures' }),
      ],
    }))
    expect(s.soldLbs).toBe(5_000)
    expect(s.soldDollars).toBe(3_600) // 72¢ × 5,000
    expect(s.awaitingCallLbs).toBe(5_000)
  })

  it('pool lbs carry received dollars + the latest per-lb estimate', () => {
    const bales = tenBales('p')
    const payments: CottonPoolPayment[] = [
      { id: 'p1', contract_id: 'cp', payment_type: 'initial_advance', amount: 1_500, cents_per_lb_equivalent: 30, payment_date: '2026-11-01', status: 'received', notes: null, created_at: '' },
      { id: 'p2', contract_id: 'cp', payment_type: 'progress', amount: 500, cents_per_lb_equivalent: 40, payment_date: '2027-01-15', status: 'received', notes: null, created_at: '' },
    ]
    const s = buildCottonPhysicalSummary(emptyInputs({
      bales,
      dispositions: bales.map((b) => disp(b.id, 'pool', { contract_id: 'cp' })),
      contracts: [contract({ id: 'cp', contract_type: 'pool', price_cents_per_lb: null, pricing_status: 'pool_open' })],
      poolPayments: payments,
    }))
    expect(s.poolLbs).toBe(5_000)
    expect(s.poolReceivedDollars).toBe(2_000)
    expect(s.poolEstCents).toBe(40) // latest payment's equivalence
  })
})

// ---------- marketing row valuation ----------

const cottonCrop: Crop = { id: 'cotton', name: 'Cotton', base_moisture_pct: 0, base_lb_per_bushel: 0, harvest_category: 'fall', double_crop: false, created_at: '' } as Crop
const cottonAssumption = (over: Partial<CropAssumption> = {}): CropAssumption => ({
  id: 'a', crop_id: 'cotton', crop_year: 2026, expected_yield: 1000, harvest_complete: false,
  assumed_basis: 0, assumed_futures: null, cost_per_acre: null,
  ...over,
} as CropAssumption)
const cottonPlanting = { id: 'p', field_id: 'f', crop_id: 'cotton', season_year: 2026, planted_acres: 30 } as any

function marketingRowWith(summary: ReturnType<typeof buildCottonPhysicalSummary>, over: { currentCents?: number } = {}) {
  // 30 ac × 1,000 lbs/ac = 30,000 lbs production.
  return computeMarketing({
    cropYear: 2026,
    crops: [cottonCrop],
    plantings: [cottonPlanting],
    contracts: [], futures: [], options: [],
    assumptions: [cottonAssumption()],
    actualProductionByCrop: new Map(),
    currentFuturesByCrop: new Map([['cotton', over.currentCents ?? 70]]),
    cottonPhysicalByCrop: new Map([['cotton', summary]]),
  })[0]
}

describe('cotton marketing row with physical buckets', () => {
  const bales = [...tenBales('s'), ...tenBales('l')] // 10 sold, 10 in loan; rest of production unpriced
  const summary = buildCottonPhysicalSummary(emptyInputs({
    bales,
    dispositions: [
      ...tenBales('s').map((b) => disp(b.id, 'contract_delivery', { contract_id: 'c1' })),
      ...tenBales('l').map((b) => disp(b.id, 'ccc_loan', { loan_id: 'L1' })),
    ],
    contracts: [contract()], // fixed 74¢
    loans: [loan({ principal_total: 2_750 })], // 55¢ floor on 5,000 lbs
    loanBales: tenBales('l').map((b) => ({ loan_id: 'L1', bale_id: b.id })),
  }))

  it('values each bucket at its own price: sold locked, loan at max(floor, market), rest at market', () => {
    const row = marketingRowWith(summary, { currentCents: 70 })
    expect(row.totalProduction).toBe(30_000)
    expect(row.contractedBu).toBe(5_000) // sold lbs are locked
    expect(row.avgCashPrice).toBe(74)
    // sold 3,700 + in-loan 5,000×70¢ (market above floor) 3,500 + unpriced 20,000×70¢ 14,000
    expect(row.blendedRevenue).toBeCloseTo(3_700 + 3_500 + 14_000, 2)
    expect(row.cottonPhysical?.inLoanFloored).toBe(false)
  })

  it('the loan floor binds when market drops below the banked value', () => {
    const row = marketingRowWith(summary, { currentCents: 48 })
    // in-loan floors at 55¢ banked: 2,750 — NOT 5,000×48¢ = 2,400
    expect(row.blendedRevenue).toBeCloseTo(3_700 + 2_750 + 20_000 * 0.48, 2)
    expect(row.cottonPhysical?.inLoanFloored).toBe(true)
  })

  it('scenario sensitivity: sold lbs are price-insensitive, floor flattens the downside', () => {
    const at = (cents: number) => marketingRowWith(summary, { currentCents: cents }).blendedRevenue
    // +1¢ moves revenue by exactly the unpriced+loan-above-floor lbs (25,000 × $0.01)
    expect(at(71) - at(70)).toBeCloseTo(250, 2)
    // below the 55¢ floor, only the 20,000 unpriced lbs move
    expect(at(48) - at(47)).toBeCloseTo(200, 2)
  })

  it('program dollars count once and fees subtract', () => {
    const withProgram = {
      ...summary,
      programDollars: 900,
      feeDollars: 825,
    }
    const base = marketingRowWith(summary, { currentCents: 70 }).blendedRevenue
    const adj = marketingRowWith(withProgram, { currentCents: 70 }).blendedRevenue
    expect(adj - base).toBeCloseTo(900 - 825, 2)
  })
})

// ---------- cash-flow events ----------

describe('cottonCashFlowEvents', () => {
  it('loan proceeds land at entry; equity at outcome; redemption payoff is an outflow', () => {
    const bales = tenBales('l')
    const events = cottonCashFlowEvents(emptyInputs({
      bales,
      loans: [
        loan({ id: 'L1', loan_number: 'LN-1', entry_date: '2026-11-01', principal_total: 2_750, status: 'equity_sold', outcome_date: '2027-02-10', equity_total: 400 }),
        loan({ id: 'L2', loan_number: 'LN-2', entry_date: '2026-11-15', principal_total: 2_750, status: 'redeemed', outcome_date: '2027-03-01', redemption_payoff_total: 2_570 }),
      ],
      loanBales: bales.map((b) => ({ loan_id: 'L1', bale_id: b.id })),
    }))
    const byLabel = new Map(events.map((e) => [e.label, e]))
    expect(byLabel.get('CCC loan proceeds LN-1')).toMatchObject({ date: '2026-11-01', amount: 2_750, status: 'received' })
    expect(byLabel.get('Loan equity sale LN-1')).toMatchObject({ date: '2027-02-10', amount: 400 })
    expect(byLabel.get('Loan redemption payoff LN-2')).toMatchObject({ date: '2027-03-01', amount: -2_570 })
  })

  it('LDP lands on ldp_date, pool payments on their dates, fees as dated outflows', () => {
    const events = cottonCashFlowEvents(emptyInputs({
      ldps: [{ id: 'ldp1', entity_id: null, crop_year: 2026, ldp_date: '2026-11-20', awp_cents: 51.4, ldp_rate_cents: 3.6, total_payment: 900, status: 'received', notes: null, created_at: '' } as CottonLdpRecord],
      poolPayments: [{ id: 'p1', contract_id: 'cp', payment_type: 'initial_advance', amount: 1_500, cents_per_lb_equivalent: null, payment_date: '2026-11-05', status: 'received', notes: null, created_at: '' }],
      fees: [{ id: 'f1', entity_id: null, crop_year: 2026, fee_type: 'storage_monthly', basis: 'per_bale_month', rate: 2.85, loan_id: null, contract_id: null, amount_total: 570, status: 'projected', fee_date: '2027-01-01', notes: null, created_at: '' }],
    }))
    expect(events.map((e) => e.label)).toEqual(['Pool initial advance', 'LDP payment', 'Cotton fee — storage monthly'])
    expect(events[2].amount).toBe(-570)
    expect(events[2].status).toBe('projected')
  })

  it('priced contract proceeds land at the delivery window end as projected', () => {
    const bales = tenBales('s')
    const events = cottonCashFlowEvents(emptyInputs({
      bales,
      dispositions: bales.map((b) => disp(b.id, 'contract_delivery', { contract_id: 'c1' })),
      contracts: [contract({ delivery_start: '2026-12-01', delivery_end: '2027-01-31' })],
    }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ date: '2027-01-31', amount: 3_700, status: 'projected' })
  })
})

// ---------- reconciliation with LDP present ----------

describe('reconciliation identity with LDP on the marketing side', () => {
  it('LDP/MLG live in blendedRevenue (counted once) — RevProj cropSales === Marketing blendedRevenue', async () => {
    const { computeRevenueProjections } = await import('./revenue-projections')
    const bales = tenBales('s')
    const summary = buildCottonPhysicalSummary(emptyInputs({
      bales,
      dispositions: bales.map((b) => disp(b.id, 'contract_delivery', { contract_id: 'c1' })),
      contracts: [contract()],
      ldps: [{ id: 'ldp1', entity_id: null, crop_year: 2026, ldp_date: '2026-11-20', awp_cents: 51.4, ldp_rate_cents: 3.6, total_payment: 900, status: 'received', notes: null, created_at: '' } as CottonLdpRecord],
    }))
    const row = marketingRowWith(summary, { currentCents: 70 })
    const { rows } = computeRevenueProjections({
      marketingRows: [row],
      contracts: [],
      cropYear: 2026,
      marketPriceByCrop: new Map(),
      insuranceByCrop: new Map(),
      govtByCrop: new Map(),
    })
    // The LDP is inside blendedRevenue — RevProj must see the identical number
    // (never re-added via the government pool).
    expect(rows[0].cropSalesRevenue).toBe(row.blendedRevenue)
    expect(row.blendedRevenue).toBeCloseTo(3_700 + 25_000 * 0.7 + 900, 2)
  })
})
