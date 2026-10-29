import { describe, expect, it } from 'vitest'
import {
  attributeVariance, calendarYearTotals, impliedRate, mergeProjectedWithReceived, receivedArcPlc, receivedKpis, weightedMedian,
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
    election, electedProgram: election, baseAcres: 300, plcYield: 2000, producerShare: 1, arcRatePerAcre: null, higherOf: null,
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
    expect(attributeVariance({ variance: 500, projectedNet: 1000, projectedProgram: 'PLC', paidProgram: 'PLC', projectedSequester: 0.057, statementSequester: 0.057, implied: { program: 'PLC', implied: 0.2, projected: 0.12, statementRate: null, denominator: 1, sequesterPct: 0.057 }, maxPlcRate: 0.12, arcCap: null })).toBe('ACRES_YIELD')
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

// The statement rate. FIXTURE farms (not the real numbers): four seed cotton
// PLC farms projected at $0.0802/lb (ERP 0.42 − MYA 0.3398) and paid at
// FSA's $0.0792. Three were paid on their full base; the fourth is a 75/25
// share-rent farm paid 75% of its payment.
//   full payment at 0.0792 on 100 ac × 2,000 lb = 0.943 × 0.85 × 200,000 × 0.0792 = 12,696.72
describe('statement rate and the share / acres call', () => {
  const den = (acres: number, yld: number) => 0.943 * 0.85 * acres * yld
  const farms = [
    { id: 'f1', acres: 100, yld: 2000, share: 1 },
    { id: 'f2', acres: 300, yld: 2500, share: 1 },
    { id: 'f3', acres: 50, yld: 1800, share: 1 },
    { id: 'f4', acres: 120, yld: 2200, share: 0.75 },
  ]
  const projected = farms.map((f) => projection(
    { farmId: f.id, commodityId: 'seed-cotton', baseAcres: f.acres, plcYield: f.yld, producerShare: f.share },
    Math.round(den(f.acres * f.share, f.yld) * 0.0802 * 100) / 100, 0.0802,
  ))
  const lines = farms.map((f) => line({ id: `l-${f.id}`, farm_id: f.id }))
  const crops = farms.map((f) => ({ line_id: `l-${f.id}`, commodity_id: 'seed-cotton', amount: Math.round(den(f.acres, f.yld) * 0.0792 * (f.id === 'f4' ? 0.75 : 1)) }))
  const received = receivedArcPlc({ lines, cropAmounts: crops })

  it('the share-rent farm projects on its producer share and is paid the statement rate: RATE, not share', () => {
    const rows = mergeProjectedWithReceived({ programYear: 2025, projected, received, sequesterPct: 0.057 })
    const f4 = rows.find((r) => r.farmId === 'f4')!
    expect(f4.producerShare).toBe(0.75)
    expect(f4.implied?.implied).toBeCloseTo(0.0792, 4)
    expect(f4.implied?.statementRate).toBeCloseTo(0.0792, 4)
    expect(f4.shareOfFarmPaid).toBeCloseTo(1, 2)
    expect(f4.cause).toBe('RATE')
    for (const r of rows) expect(r.cause).toBe('RATE')
    const k = receivedKpis(rows)
    expect(k.byCause.ACRES_YIELD).toBe(0)
    expect(k.byCause.RATE).toBeCloseTo(k.variance, 2)
  })

  it('a farm paid a fraction of what its base data would pay at the statement rate is ACRES / YIELD / SHARE, and the full-share farms stay RATE', () => {
    // The same farm projected on 100% (no share on file): it was still paid 75%.
    const noShare = projected.map((p) => p.farmId === 'f4'
      ? projection({ farmId: 'f4', commodityId: 'seed-cotton', baseAcres: 120, plcYield: 2200, producerShare: 1 }, Math.round(den(120, 2200) * 0.0802 * 100) / 100, 0.0802)
      : p)
    const rows = mergeProjectedWithReceived({ programYear: 2025, projected: noShare, received, sequesterPct: 0.057 })
    const f4 = rows.find((r) => r.farmId === 'f4')!
    expect(f4.implied?.implied).toBeCloseTo(0.0594, 4)
    expect(f4.implied?.statementRate).toBeCloseTo(0.0792, 4)
    expect(f4.shareOfFarmPaid).toBeCloseTo(0.75, 2)
    expect(f4.cause).toBe('ACRES_YIELD')
    expect(rows.filter((r) => r.farmId !== 'f4').every((r) => r.cause === 'RATE')).toBe(true)
    // The by-cause totals: the full-share farms' small price miss is RATE; the whole f4 gap is ACRES_YIELD.
    const k = receivedKpis(rows)
    expect(k.byCause.ACRES_YIELD).toBeCloseTo(f4.variance!, 2)
    expect(k.byCause.RATE).toBeLessThan(0)
    expect(Math.abs(k.byCause.RATE)).toBeLessThan(Math.abs(k.byCause.ACRES_YIELD))
  })

  it('a lone line has no statement rate and falls back to the ERP − loan test', () => {
    const one = [projected[0]]
    const rows = mergeProjectedWithReceived({ programYear: 2025, projected: one, received, sequesterPct: 0.057, maxPlcRateByCommodity: new Map([['seed-cotton', 0.12]]) })
    expect(rows[0].implied?.statementRate).toBeNull()
    expect(rows[0].shareOfFarmPaid).toBeNull()
    expect(rows[0].cause).toBe('RATE')
  })

  it('ARC-CO rates are only compared within a county', () => {
    const arcProj = (farmId: string, acres: number) => projection({ farmId, commodityId: 'corn', baseAcres: acres, plcYield: 150, producerShare: 1 }, 0, 0, 'ARC_CO')
    const arcLines = [line({ id: 'a1', farm_id: 'c1', program_code: 'ARC_CO' }), line({ id: 'a2', farm_id: 'c2', program_code: 'ARC_CO' }), line({ id: 'a3', farm_id: 'c3', program_code: 'ARC_CO' })]
    // c1 and c2 share a county and a $60/ac rate; c3 sits in another county at $30/ac.
    const arcCrops = [
      { line_id: 'a1', commodity_id: 'corn', amount: Math.round(0.943 * 0.85 * 100 * 60) },
      { line_id: 'a2', commodity_id: 'corn', amount: Math.round(0.943 * 0.85 * 200 * 60) },
      { line_id: 'a3', commodity_id: 'corn', amount: Math.round(0.943 * 0.85 * 100 * 30) },
    ]
    const rec = receivedArcPlc({ lines: arcLines, cropAmounts: arcCrops })
    const county = new Map([['c1', 'A'], ['c2', 'A'], ['c3', 'B']])
    const rows = mergeProjectedWithReceived({ programYear: 2025, projected: [arcProj('c1', 100), arcProj('c2', 200), arcProj('c3', 100)], received: rec, sequesterPct: 0.057, countyByFarm: county })
    expect(rows.find((r) => r.farmId === 'c1')!.implied?.statementRate).toBeCloseTo(60, 0)
    expect(rows.find((r) => r.farmId === 'c3')!.implied?.statementRate).toBeNull()
    // Without counties, every farm is its own group — no statement rate.
    const alone = mergeProjectedWithReceived({ programYear: 2025, projected: [arcProj('c1', 100), arcProj('c2', 200), arcProj('c3', 100)], received: rec, sequesterPct: 0.057 })
    expect(alone.every((r) => r.implied?.statementRate == null)).toBe(true)
  })

  it('weightedMedian: the value where half the dollars sit below', () => {
    expect(weightedMedian([])).toBeNull()
    expect(weightedMedian([{ value: 5, weight: 1 }])).toBe(5)
    // $900 at 0.0792 and $100 at 0.0594 → 0.0792; equal dollars → the lower of the two.
    expect(weightedMedian([{ value: 0.0594, weight: 100 }, { value: 0.0792, weight: 900 }])).toBe(0.0792)
    expect(weightedMedian([{ value: 1, weight: 50 }, { value: 2, weight: 50 }])).toBe(1)
    expect(weightedMedian([{ value: 3, weight: 0 }, { value: 7, weight: 1 }])).toBe(7)
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
