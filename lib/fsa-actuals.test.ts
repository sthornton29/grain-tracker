import { describe, expect, it } from 'vitest'
import {
  attributeVariance, calendarYearTotals, impliedRate, mergeProjectedWithReceived, receivedArcPlc, receivedKpis,
  type ReceivedLineLike,
} from './fsa-actuals'
import type { ProjectedPayment } from './government-payments'

// FIXTURE base data (not the real farms' numbers): the worked examples the
// spec asks for, with the arithmetic shown.
//   farm 260 seed cotton PLC actual $52,586, 300.0 base acres, 2,000 lb/ac PLC yield, 5.7% sequester
//     denominator = 0.943 × 0.85 × 300 × 2,000 = 480,930
//     implied rate = 52,586 ÷ 480,930 = $0.1093/lb
//     projected at $0.1200 = 57,711.60 → variance −5,125.60 (−8.9%) → RATE
//   farm 260 corn ARC-CO actual $5,880, 100.0 base acres
//     denominator = 0.943 × 0.85 × 100 = 80.155 → $73.36 per base acre

function projection(over: Partial<ProjectedPayment> & { farmId: string; commodityId: string }, net: number, rate: number, election: ProjectedPayment['election'] = 'PLC'): ProjectedPayment {
  return {
    election, electedProgram: election, baseAcres: 300, plcYield: 2000, arcRatePerAcre: null, higherOf: null,
    result: { election, effectiveReferencePrice: 0.42, myaPrice: 0.31, effectivePrice: 0.31, paymentRatePerUnit: rate, grossPerAcre: rate * 2000, gross: net / (0.85 * 0.943), net, computable: true, arcMethod: null, arcDetail: null },
    ...over,
  }
}

const line = (over: Partial<ReceivedLineLike> & { id: string }): ReceivedLineLike => ({
  statement_id: 's1', fsa_payment_id: `id-${over.id}`, program_code: 'PLC', program_year: 2025, farm_id: 'farm-260', payment_date: '2026-10-15', sequester_pct: 0.057, ...over,
})

describe('impliedRate', () => {
  it('PLC: 52,586 ÷ (0.943 × 0.85 × 300 × 2,000 = 480,930) = $0.1093/lb', () => {
    const r = impliedRate({ program: 'PLC', actual: 52586, baseAcres: 300, plcYield: 2000, sequesterPct: 0.057, projectedRate: 0.12 })!
    expect(r.denominator).toBeCloseTo(480930, 2)
    expect(r.implied).toBeCloseTo(0.1093, 4)
    expect(r.projected).toBe(0.12)
  })
  it('ARC-CO: 5,880 ÷ (0.943 × 0.85 × 100) = $73.36 per base acre', () => {
    const r = impliedRate({ program: 'ARC_CO', actual: 5880, baseAcres: 100, plcYield: 160, sequesterPct: 0.057 })!
    expect(r.implied).toBeCloseTo(73.36, 2)
  })
  it('null without base acres', () => {
    expect(impliedRate({ program: 'PLC', actual: 1, baseAcres: 0, plcYield: 1, sequesterPct: 0.057 })).toBeNull()
  })
})

describe('receivedArcPlc + mergeProjectedWithReceived', () => {
  const lines = [
    line({ id: 'l1' }),
    line({ id: 'l2', program_code: 'ARC_CO' }),
    line({ id: 'l3', program_code: 'OTHER', program_year: 2026 }),
    line({ id: 'l4', farm_id: null }),
  ]
  const crops = [
    { line_id: 'l1', commodity_id: 'seed-cotton', amount: 52586 },
    { line_id: 'l2', commodity_id: 'corn', amount: 5880 },
    { line_id: 'l2', commodity_id: 'soybeans', amount: 2352 },
    { line_id: 'l3', commodity_id: null, amount: 1000 },
    { line_id: 'l4', commodity_id: 'corn', amount: 999 },
  ]
  const received = receivedArcPlc({ lines, cropAmounts: crops })

  it('sums crop amounts per farm × commodity × program year, ignoring OTHER lines and farm-less lines', () => {
    expect([...received.keys()].sort()).toEqual(['farm-260|corn|2025', 'farm-260|seed-cotton|2025', 'farm-260|soybeans|2025'])
    expect(received.get('farm-260|seed-cotton|2025')).toMatchObject({ amount: 52586, programs: ['PLC'], paymentDates: ['2026-10-15'], sequesterPct: 0.057 })
  })

  it('the spec example: projected 57,711.60 at $0.12, actual 52,586 → variance −5,125.60 (−8.9%), RATE', () => {
    const projected = [projection({ farmId: 'farm-260', commodityId: 'seed-cotton' }, 57711.6, 0.12)]
    const rows = mergeProjectedWithReceived({ programYear: 2025, projected, received, sequesterPct: 0.057 })
    const sc = rows.find((r) => r.commodityId === 'seed-cotton')!
    expect(sc.status).toBe('paid')
    expect(sc.variance).toBeCloseTo(-5125.6, 2)
    expect(sc.variancePct).toBeCloseTo(-0.0888, 3)
    expect(sc.implied?.implied).toBeCloseTo(0.1093, 4)
    expect(sc.implied?.projected).toBe(0.12)
    expect(sc.cause).toBe('RATE')
    expect(sc.effective).toBe(52586)
  })

  it('a projection that chose PLC for a crop the statement paid under ARC-CO is labeled PROGRAM', () => {
    const projected = [projection({ farmId: 'farm-260', commodityId: 'corn', baseAcres: 100, plcYield: 160 }, 4000, 0.3, 'PLC')]
    const rows = mergeProjectedWithReceived({ programYear: 2025, projected, received, sequesterPct: 0.057 })
    const corn = rows.find((r) => r.commodityId === 'corn')!
    expect(corn.paidProgram).toBe('ARC_CO')
    expect(corn.projectedProgram).toBe('PLC')
    expect(corn.cause).toBe('PROGRAM')
    expect(corn.implied?.program).toBe('ARC_CO')
    expect(corn.implied?.implied).toBeCloseTo(73.36, 2)
    expect(corn.implied?.projected).toBeNull()
  })

  it('a paid commodity with no projection and a projection on no statement get their own statuses', () => {
    const projected = [projection({ farmId: 'farm-260', commodityId: 'wheat' }, 500, 0.5)]
    const rows = mergeProjectedWithReceived({ programYear: 2025, projected, received, sequesterPct: 0.057 })
    expect(rows.find((r) => r.commodityId === 'wheat')?.status).toBe('projected_not_on_statement')
    expect(rows.find((r) => r.commodityId === 'soybeans')?.status).toBe('paid_no_projection')
    const none = mergeProjectedWithReceived({ programYear: 2025, projected, received: new Map(), sequesterPct: 0.057 })
    expect(none[0].status).toBe('not_yet_paid')
    expect(none[0].effective).toBe(500)
  })

  it('a sequester difference that closes the gap is SEQUESTER; an impossible PLC rate is ACRES / YIELD', () => {
    // Projected at 5.4%, paid at 5.7%: 1000 × 0.943 / 0.946 = 996.83.
    expect(attributeVariance({ variance: -3.17, projectedNet: 1000, projectedProgram: 'PLC', paidProgram: 'PLC', projectedSequester: 0.054, statementSequester: 0.057, implied: null, maxPlcRate: null, arcCap: null })).toBe('SEQUESTER')
    expect(attributeVariance({ variance: 500, projectedNet: 1000, projectedProgram: 'PLC', paidProgram: 'PLC', projectedSequester: 0.057, statementSequester: 0.057, implied: { program: 'PLC', implied: 0.2, projected: 0.12, denominator: 1, sequesterPct: 0.057 }, maxPlcRate: 0.12, arcCap: null })).toBe('ACRES_YIELD')
    expect(attributeVariance({ variance: 0.2, projectedNet: 1000, projectedProgram: 'PLC', paidProgram: 'PLC', projectedSequester: 0.057, statementSequester: 0.057, implied: null, maxPlcRate: null, arcCap: null })).toBeNull()
  })

  it('KPIs total projected, received, variance and % received', () => {
    const projected = [
      projection({ farmId: 'farm-260', commodityId: 'seed-cotton' }, 57711.6, 0.12),
      projection({ farmId: 'farm-260', commodityId: 'wheat' }, 500, 0.5),
    ]
    const k = receivedKpis(mergeProjectedWithReceived({ programYear: 2025, projected, received, sequesterPct: 0.057 }))
    // received = 52,586 + 5,880 + 2,352 (corn / soybeans paid with no projection)
    expect(k.received).toBe(60818)
    expect(k.projected).toBeCloseTo(58211.6, 2)
    expect(k.variance).toBeCloseTo(2606.4, 2)
    expect(k.paidRows).toBe(3)
    expect(k.unpaidRows).toBe(1)
    expect(k.byCause.RATE).toBeCloseTo(-5125.6, 2)
  })
})

describe('calendarYearTotals', () => {
  it('FSA payments received in 2026 by Martin Farm: the lines’ nets by payment-date year', () => {
    const statements = [
      { id: 's1', statement_date: '2026-10-13', payee_entity_id: 'martin', payee_name: 'MARTIN FARM' },
      { id: 's2', statement_date: '2026-10-14', payee_entity_id: 'martin', payee_name: 'MARTIN FARM' },
      { id: 's3', statement_date: '2025-12-30', payee_entity_id: null, payee_name: 'OTHER PAYEE' },
    ]
    const lines = [
      { statement_id: 's1', net_payment: 199464, payment_date: '2026-10-15' },
      { statement_id: 's2', net_payment: 441578, payment_date: '2026-10-16' },
      { statement_id: 's3', net_payment: 100, payment_date: null },
    ]
    const t = calendarYearTotals({ statements, lines })
    expect(t).toEqual([
      { year: 2026, payeeEntityId: 'martin', payeeName: 'MARTIN FARM', net: 641042, lines: 2 },
      { year: 2025, payeeEntityId: null, payeeName: 'OTHER PAYEE', net: 100, lines: 1 },
    ])
  })
})
