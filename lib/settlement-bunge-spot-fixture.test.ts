import { describe, expect, it } from 'vitest'
import type { SettlementExtraction, SettlementLineExtraction } from '@/lib/pdf-upload'
import { mergeSettlements } from '@/lib/parse-merge'
import { flagSummaryLines, reconcileLines } from '@/lib/settlement-lines'
import { matchAllTickets, type TicketMatchLoad } from '@/lib/ticket-matching'
import { allocationDiffers, allocationFromGroup, classifySaleText, contractNumberKey, sameContractNumber, ticketGroups } from '@/lib/settlement-sales'
import { buildPaidIndex, paidRefFor } from '@/lib/settlement-duplicates'
import { saleAllocations } from '@/lib/load-sales'

// ---------------------------------------------------------------------------
// Bunge settlement 0000205995 (10/02/2026, Turnrow Farm Services LLC,
// U.S. No. 1 yellow soybeans, check $90,760.95) — modeled as the extraction
// shape the per-LINE contract prompt emits. The real PDF prints two
// "Contract Number:" blocks; ticket 0502289 appears under BOTH (one truck
// finished the contract: 58.284 bu; the rest went spot: 912.744 bu, same
// Load Order # 3031435459). The figures below are the statement's own.
// ---------------------------------------------------------------------------

const CONTRACT = '2002960604-10'
const CONTRACT_BU = 2059.757
const CONTRACT_GROSS = 26179.51147
const SPOT_BU = 4793.9
const SPOT_GROSS = 65528.2632
const STATEMENT_BU = 6853.657
const STATEMENT_GROSS = 91707.77467
const DISCOUNTS = 946.82338 // 456.43693 + 70.00 + 397.06913 + 23.31732
const NET = 90760.95129

function line(ticket: string, contract: string, date: string, bu: number, price: number, loadOrder: string, discounts: number): SettlementLineExtraction {
  return {
    ticket_number: ticket, contract_number: contract, secondary_ref: loadOrder, delivery_date: date, vehicle_plate: '42X9084A',
    gross_weight: null, tare_weight: null, net_weight: null, net_bushels: bu, gross_revenue: Math.round(bu * price * 1e5) / 1e5, discounts,
    grade_readings: { moisture: 13.0, foreign_material: 1.1, splits: 5.9, total_damage: 1.1, heat_damage: 0, test_weight: 52.3 },
  }
}

const LINES: SettlementLineExtraction[] = [
  line('0502248', CONTRACT, '2026-09-25', 894.14, 12.71, '3031434785', 75.71929),
  line('0502254', CONTRACT, '2026-09-25', 1107.333, 12.71, '3031434936', 80.37101),
  line('0502289', CONTRACT, '2026-09-25', 58.284, 12.71, '3031435459', 15.65042),
  line('0502289', 'SPOT', '2026-09-25', 912.744, 13.74, '3031435459', 263.82214),
  line('0502302', 'SPOT', '2026-09-25', 959.926, 13.74, '3031435783', 277.57409),
  line('0502508', 'SPOT', '2026-09-26', 1026, 13.74, '3031437219', 80.4862),
  line('0502509', 'SPOT', '2026-09-26', 951, 13.74, '3031437232', 75.3337),
  line('0503084', 'SPOT', '2026-09-28', 944.23, 13.38, '3031444139', 77.86653),
]

const TOTAL_ROWS: SettlementLineExtraction[] = [
  { ticket_number: 'Contract Total 2002960604-10', contract_number: CONTRACT, net_bushels: CONTRACT_BU, gross_revenue: CONTRACT_GROSS, discounts: 171.74072 },
  { ticket_number: 'Contract Total SPOT', contract_number: 'SPOT', net_bushels: SPOT_BU, gross_revenue: SPOT_GROSS, discounts: 775.08266 },
  { ticket_number: 'Settlement Total', net_bushels: STATEMENT_BU, gross_revenue: STATEMENT_GROSS, discounts: DISCOUNTS },
]

const BUNGE: SettlementExtraction = {
  buyer_name: 'Bunge', settlement_date: '2026-10-02', settlement_number: '0000205995',
  contract_number: CONTRACT, payment_number: '27600093', check_number: '121033155', payment_date: '2026-10-02',
  statement_reported_total: NET, statement_reported_bushels: STATEMENT_BU, statement_reported_gross: STATEMENT_GROSS,
  line_items: [...LINES, ...TOTAL_ROWS],
  discount_items: [
    { category: 'checkoff', description: 'I02 National Check-Off', amount: 456.43693, rate_note: null, quantity_basis: null, deduction_kind: 'price' },
    { category: 'fee', description: 'I11 Vehicle Inspection C', amount: 70, rate_note: null, quantity_basis: null, deduction_kind: 'price' },
    { category: 'moisture_shrink', description: 'MO Moisture', amount: 397.06913, rate_note: null, quantity_basis: null, deduction_kind: 'price' },
    { category: 'test_weight', description: 'TW Test Weight', amount: 23.31732, rate_note: null, quantity_basis: null, deduction_kind: 'price' },
    { category: 'foreign_material', description: 'ZFM Frgn Matl - Quantity', amount: 0, rate_note: null, quantity_basis: '32.010 bu', deduction_kind: 'weight' },
  ],
}

describe('Bunge 0000205995 — the statement foots', () => {
  const merged = mergeSettlements([BUNGE])
  const guards = flagSummaryLines(merged.line_items, { settlementNumber: merged.settlement_number })
  const kept = merged.line_items.filter((_, i) => !guards[i].flagged)

  it('keeps all 8 ticket lines — BOTH 0502289 lines survive the merge — and drops the three total rows', () => {
    expect(kept).toHaveLength(8)
    expect(kept.filter((l) => l.ticket_number === '0502289')).toHaveLength(2)
    expect(merged.line_items.filter((_, i) => guards[i].flagged).map((l) => l.ticket_number)).toEqual(['Contract Total 2002960604-10', 'Contract Total SPOT', 'Settlement Total'])
  })

  it('contract lines: 894.140 × 12.71 + 1,107.333 × 12.71 + 58.284 × 12.71 = 2,059.757 bu, $26,179.51147', () => {
    const c = kept.filter((l) => l.contract_number === CONTRACT)
    expect(c.map((l) => l.gross_revenue)).toEqual([11364.5194, 14074.20243, 740.78964])
    expect(c.reduce((s, l) => s + l.net_bushels!, 0)).toBeCloseTo(CONTRACT_BU, 3)
    expect(c.reduce((s, l) => s + l.gross_revenue!, 0)).toBeCloseTo(CONTRACT_GROSS, 5)
  })

  it('spot lines: 3,849.670 bu @ 13.74 ($52,894.46580) + 944.230 @ 13.38 ($12,633.79740) = 4,793.900 bu, $65,528.26320, average 13.669093', () => {
    const s = kept.filter((l) => l.contract_number === 'SPOT')
    const at1374 = s.filter((l) => l.ticket_number !== '0503084')
    expect(at1374.reduce((a, l) => a + l.net_bushels!, 0)).toBeCloseTo(3849.67, 3)
    expect(at1374.reduce((a, l) => a + l.gross_revenue!, 0)).toBeCloseTo(52894.4658, 5)
    expect(s.find((l) => l.ticket_number === '0503084')!.gross_revenue).toBeCloseTo(12633.7974, 5)
    const bu = s.reduce((a, l) => a + l.net_bushels!, 0), gross = s.reduce((a, l) => a + l.gross_revenue!, 0)
    expect(bu).toBeCloseTo(SPOT_BU, 3)
    expect(gross).toBeCloseTo(SPOT_GROSS, 5)
    expect(gross / bu).toBeCloseTo(13.669093, 6)
  })

  it('statement: 6,853.657 bu, $91,707.77467 gross, $946.82338 discounts, net $90,760.95129; all priced bushels average 13.380853', () => {
    const bu = kept.reduce((a, l) => a + l.net_bushels!, 0)
    const gross = kept.reduce((a, l) => a + l.gross_revenue!, 0)
    const disc = kept.reduce((a, l) => a + l.discounts!, 0)
    expect(bu).toBeCloseTo(STATEMENT_BU, 3)
    expect(gross).toBeCloseTo(STATEMENT_GROSS, 5)
    expect(disc).toBeCloseTo(DISCOUNTS, 5)
    expect(gross - disc).toBeCloseTo(NET, 5)
    expect(gross / bu).toBeCloseTo(13.380853, 6)
    expect(456.43693 + 70 + 397.06913 + 23.31732).toBeCloseTo(DISCOUNTS, 5)
    const rec = reconcileLines(merged.line_items.map((l, i) => ({ ...l, excluded: guards[i].flagged })), merged.statement_reported_total)
    expect(rec.mismatch).toBe(false)
  })
})

describe('Bunge 0000205995 — sale classification and the split ticket', () => {
  it('"SPOT" and its variants map to spot; "S12" is possibly spot; DP is price later; a number is a contract', () => {
    for (const t of ['SPOT', 'Spot', 'Spot Sale', 'Cash', 'Cash Sale', 'Spot Purchase', 'Open']) expect(classifySaleText(t).sale_type, t).toBe('spot')
    expect(classifySaleText('S12')).toMatchObject({ sale_type: 'contract', possiblySpot: true, contract_number_text: 'S12' })
    expect(classifySaleText('DP').sale_type).toBe('price_later')
    expect(classifySaleText('Price later').sale_type).toBe('price_later')
    expect(classifySaleText(CONTRACT)).toMatchObject({ sale_type: 'contract', possiblySpot: false })
    expect(classifySaleText(null)).toMatchObject({ sale_type: 'contract', contract_number_text: null })
  })

  it('"2002960604-10" is the same contract as our stored "2002960604-000010"', () => {
    expect(contractNumberKey('2002960604-000010')).toBe('2002960604-10')
    expect(sameContractNumber('2002960604-10', '2002960604-000010')).toBe(true)
    expect(sameContractNumber('93115', '93118')).toBe(false)
  })

  it('0502289 under two blocks is ONE split group, not a repeat; a true repeat (same ticket, same contract) is flagged', () => {
    const groups = ticketGroups(LINES)
    expect(groups).toHaveLength(7)
    const g = groups.find((x) => x.ticket_number === '0502289')!
    expect(g.split).toBe(true)
    expect(g.repeatedLineIndexes).toEqual([])
    expect(g.totalBuyerBushels).toBeCloseTo(971.028, 3)
    expect(g.lines.map((l) => l.sale_type)).toEqual(['contract', 'spot'])
    const repeat = ticketGroups([LINES[0], { ...LINES[0] }])
    expect(repeat[0].split).toBe(false)
    expect(repeat[0].repeatedLineIndexes).toEqual([1])
  })

  it('the buyer\'s allocation for 0502289: contract share 0.0600230; on our 975.0 dry bu → 58.522 contract / 916.478 spot, shares summing to exactly 1', () => {
    const g = ticketGroups(LINES).find((x) => x.ticket_number === '0502289')!
    const { rows, unresolved } = allocationFromGroup(g, (t) => (sameContractNumber(t, '2002960604-000010') ? 'K' : null))
    expect(unresolved).toEqual([])
    expect(rows[0]).toMatchObject({ sale_type: 'contract', contract_id: 'K', buyer_net_bushels: 58.284 })
    expect(rows[0].share).toBeCloseTo(0.060023, 6)
    expect(rows[1]).toMatchObject({ sale_type: 'spot', buyer_net_bushels: 912.744, spot_price: 13.74, spot_price_source: 'settlement' })
    expect(rows[0].share + rows[1].share).toBe(1)
    const sales = rows.map((r, i) => ({ id: `r${i}`, load_id: 'L', sale_type: r.sale_type, contract_id: r.contract_id ?? null, share: r.share, buyer_net_bushels: r.buyer_net_bushels ?? null, spot_price: r.spot_price ?? null, spot_price_source: r.spot_price_source ?? null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null }))
    const allocs = saleAllocations([{ id: 'L', to_type: 'buyer', dryBu: 975 }], sales).get('L')!
    expect(allocs.map((a) => Math.round(a.bushels * 1000) / 1000)).toEqual([58.522, 916.478])
    // We had ALL of 0502289 on the contract → the buyer's version differs → the review shows both.
    expect(allocationDiffers([{ saleType: 'contract', contractId: 'K', share: 1 }], rows)).toBe(true)
    expect(allocationDiffers(allocs, rows)).toBe(false)
  })

  it('an unknown contract number comes back unresolved for the "Link to contract" step', () => {
    const g = ticketGroups([line('9', 'ZZ-1', '2026-09-25', 100, 12, 'x', 0)])[0]
    expect(allocationFromGroup(g, () => null)).toEqual({ rows: [], unresolved: ['ZZ-1'] })
  })
})

describe('Bunge 0000205995 — matching: both 0502289 lines claim the one load', () => {
  // Our loads carry the buyer ticket as the last dash segment ("1-47-0502289").
  const LOADS: TicketMatchLoad[] = [
    { id: 'L248', ticket_number: '2-48-0502248', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-25' },
    { id: 'L254', ticket_number: '4-46-0502254', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-25' },
    { id: 'L289', ticket_number: '1-47-0502289', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-25' },
    { id: 'L302', ticket_number: '1-49-0502302', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-25' },
    { id: 'L508', ticket_number: '2-50-0502508', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-26' },
    { id: 'L509', ticket_number: '3-51-0502509', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-26' },
    { id: 'L084', ticket_number: '1-52-0503084', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-28' },
  ]
  const results = matchAllTickets(
    LINES.map((l) => ({ ticket_number: l.ticket_number, contract_number: l.contract_number, secondary_refs: [l.secondary_ref], net_bushels: l.net_bushels, delivery_date: l.delivery_date })),
    LOADS,
    { crop_id: 'soy', buyer_id: 'bunge' },
  )

  it('every line matches; the two 0502289 lines both land on L289 and the split is explained', () => {
    expect(results.every((r) => r.status === 'matched')).toBe(true)
    const ids = results.map((r) => (r.status === 'matched' ? r.match.loadId : ''))
    expect(ids).toEqual(['L248', 'L254', 'L289', 'L289', 'L302', 'L508', 'L509', 'L084'])
    expect(results[3].status === 'matched' && results[3].match.reason).toMatch(/second contract block/)
    // The one-claim rule still holds for a true repeat: the same ticket under the SAME contract finds its load claimed.
    const repeat = matchAllTickets([{ ticket_number: '0502248', contract_number: CONTRACT }, { ticket_number: '0502248', contract_number: CONTRACT }], LOADS, { buyer_id: 'bunge' })
    expect(repeat[0].status).toBe('matched')
    expect(repeat[1].status).toBe('unmatched')
  })

  it('the duplicate check: a split line is not "already paid" on THIS statement; a saved statement\'s line still flags a repeat', () => {
    const saved = [{ id: 'S1', buyer_id: 'bunge', settlement_date: '2026-09-25', settlement_number: '0000191523' }]
    const index = buildPaidIndex([{ settlement_id: 'S1', load_id: 'L200', ticket_number: '0502200' }], saved)
    expect(paidRefFor({ loadId: 'L289', ticketNumber: '0502289', buyerId: 'bunge' }, index)).toBeNull()
    expect(paidRefFor({ loadId: 'L200', ticketNumber: '0502200', buyerId: 'bunge' }, index)?.settlementNumber).toBe('0000191523')
  })
})
