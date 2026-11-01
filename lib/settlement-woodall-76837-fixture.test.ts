import { describe, expect, it } from 'vitest'
import { mergeSettlements } from '@/lib/parse-merge'
import { normalizeSettlementExtraction, type SettlementExtraction } from '@/lib/pdf-upload'
import { partialTickets, settlementCompleteness, unreadContracts } from '@/lib/settlement-lines'
import { buildApplyPlan, buildSaleReview, unresolvedContractTexts, type ReviewContract } from '@/lib/settlement-sale-review'

// ---------------------------------------------------------------------------
// Woodall Grain settlement 76837 (9/25/2026), figures as printed on the real
// statement. Ticket 500578194 (1,060.357 bu) finished contract 93118 with
// 727.144 bu; the other 333.213 bu went to 97266, a number whose only sign of
// being spot is the Type column of the Contract / Ticket Summary. Each block
// prints its own "No. Tickets" and Totals row:
//   93118  Flat  7,030.001 bu  gross 32,847.68  charges 70.30  net 32,777.38
//   97266  Spot    333.213 bu  gross  1,524.45  charges  3.33  net  1,521.12
//   sheet        7,363.214 bu  gross 34,372.13  charges 73.63  net 34,298.50
// Saved 2026-09-30 with the 97266 line lost, the net read as $32,777.38.
// ---------------------------------------------------------------------------

const line = (ticket: string, bu: number, gross: number, ck: number) => ({ ticket_number: ticket, net_bushels: bu, gross_revenue: gross, discounts: ck })

const FLAT = [
  line('500577865', 1019.643, 4764.28, 10.2),
  line('500578176', 1090, 5093.03, 10.9),
  line('500578177', 1035, 4836.04, 10.35),
  line('500578180', 1051.071, 4911.13, 10.51),
  line('500578189', 1015.714, 4745.92, 10.16),
  line('500578193', 1091.429, 5099.7, 10.91),
  line('500578194', 727.144, 3397.58, 7.27),
]
const SPOT = [line('500578194', 333.213, 1524.45, 3.33)]
const CONTRACT_TYPES = [
  { contract_number: '93118', type: 'Flat', settled_bushels: 7030.001 },
  { contract_number: '97266', type: 'Spot', settled_bushels: 333.213 },
]
const TOTALS = { statement_reported_total: 34298.5, statement_reported_gross: 34372.13, statement_reported_bushels: 7363.214, statement_reported_ticket_count: 8 }
const ANSWER = {
  buyer_name: 'Woodall Grain Company', settlement_date: '2026-09-25', settlement_number: '76837',
  contract_types: CONTRACT_TYPES,
  ...TOTALS,
  contract_blocks: [{ contract_number: '93118', line_items: FLAT }, { contract_number: '97266', line_items: SPOT }],
  discount_items: [],
}

const CONTRACTS: ReviewContract[] = [{ id: 'c93118', contract_number: '93118', buyer_id: 'woodall', crop_id: 'corn', crop_year: 2026 }]
const LOAD_BU: Record<string, number> = { '500578194': 1060.357 }
const loadIdOf = (ticket: string | null | undefined) => `load-${ticket}`

function review(data: SettlementExtraction) {
  return buildSaleReview({
    lines: data.line_items,
    loadIdForLine: (i) => loadIdOf(data.line_items[i]?.ticket_number),
    oursByLoad: new Map(),
    contracts: CONTRACTS,
    cropId: 'corn',
  })
}

function completeness(data: SettlementExtraction) {
  const lines = data.line_items
  return settlementCompleteness({
    capturedTickets: lines.length,
    capturedDistinctTickets: new Set(lines.map((l) => l.ticket_number)).size,
    reportedTickets: data.statement_reported_ticket_count,
    capturedBushels: lines.reduce((s, l) => s + (l.net_bushels ?? 0), 0),
    reportedBushels: data.statement_reported_bushels,
    capturedGross: lines.reduce((s, l) => s + (l.gross_revenue ?? 0), 0),
    reportedGross: data.statement_reported_gross,
    capturedNet: lines.reduce((s, l) => s + (l.gross_revenue ?? 0) - (l.discounts ?? 0), 0),
    reportedNet: data.statement_reported_total,
    failedRanges: [],
    partialTickets: partialTickets(lines.map((l) => ({ ...l, loadId: loadIdOf(l.ticket_number), loadBushels: LOAD_BU[l.ticket_number ?? ''] ?? l.net_bushels }))),
    unreadContracts: unreadContracts(data.contract_types, lines),
  })
}

describe('Woodall 76837: the truck that finished a contract and went spot', () => {
  const data = normalizeSettlementExtraction(ANSWER)

  it('keeps both lines of the split ticket and foots to the printed $34,298.50', () => {
    expect(data.line_items).toHaveLength(8)
    expect(data.line_items.filter((l) => l.ticket_number === '500578194').map((l) => l.net_bushels)).toEqual([727.144, 333.213])
    const net = data.line_items.reduce((s, l) => s + (l.gross_revenue ?? 0) - (l.discounts ?? 0), 0)
    expect(net).toBeCloseTo(34298.5, 2)
    expect(completeness(data)).toMatchObject({ ok: true, text: null })
  })

  it('the printed Type makes 97266 spot, keeps the number, and asks nobody to link it', () => {
    const spot = data.line_items.find((l) => l.contract_number === '97266')!
    expect(spot.sale_type).toBe('spot')
    expect(data.line_items.filter((l) => l.contract_number === '93118').every((l) => l.sale_type == null)).toBe(true)
    const groups = review(data)
    expect(unresolvedContractTexts(groups)).toEqual([])
    expect(groups.flatMap((g) => g.unresolved)).toEqual([])
  })

  it('the load splits by bushels: the contract share, and the spot share at the settled $4.575', () => {
    const plan = buildApplyPlan(review(data))
    expect(plan.blockedLoadIds).toEqual([])
    expect(plan.loadWrites).toHaveLength(7)
    const rows = plan.loadWrites.find((w) => w.loadId === 'load-500578194')!.rows
    expect(rows.map((r) => r.sale_type)).toEqual(['contract', 'spot'])
    expect(rows[0].contract_id).toBe('c93118')
    expect(rows[0].share).toBeCloseTo(727.144 / 1060.357, 8)
    expect(rows[1].contract_id).toBeNull()
    expect(rows[1].share).toBeCloseTo(333.213 / 1060.357, 8)
    expect(rows[0].share + rows[1].share).toBe(1)
    expect(rows[1].spot_price).toBeCloseTo(4.575, 4)
    expect(rows[1].spot_price_source).toBe('settlement')
    const updates = plan.lineUpdates.filter((u) => u.contract_number_text === '97266')
    expect(updates).toEqual([{ index: 7, sale_type: 'spot', contract_number_text: '97266', contract_id: null }])
  })

  it('the table on page 1 still marks a block read in a later chunk', () => {
    const merged = mergeSettlements([
      normalizeSettlementExtraction({ ...ANSWER, contract_blocks: [{ contract_number: '93118', line_items: FLAT }] }),
      normalizeSettlementExtraction({ contract_blocks: [{ contract_number: '97266', line_items: SPOT }] }),
    ])
    expect(merged.line_items).toHaveLength(8)
    expect(merged.line_items[7]).toMatchObject({ ticket_number: '500578194', contract_number: '97266', sale_type: 'spot' })
    expect(merged.contract_types).toEqual(CONTRACT_TYPES)
    expect(completeness(merged).ok).toBe(true)
  })

  it('a true repeat across chunks still collapses; a repeat with different amounts is a split', () => {
    const repeat = mergeSettlements([
      normalizeSettlementExtraction({ contract_blocks: [{ contract_number: '93118', line_items: FLAT }] }),
      normalizeSettlementExtraction({ contract_blocks: [{ contract_number: '93118', line_items: [FLAT[6]] }] }),
    ])
    expect(repeat.line_items).toHaveLength(7)
    // The failure as saved: same ticket, the contract text lost on both reads.
    const noText = normalizeSettlementExtraction({ line_items: [...FLAT, ...SPOT] })
    expect(noText.line_items).toHaveLength(8)
    expect(mergeSettlements([noText, noText]).line_items).toHaveLength(8)
  })
})

describe('Woodall 76837: when the read goes wrong it says so before saving', () => {
  const firstBlockOnly = (extra: Record<string, unknown>) => normalizeSettlementExtraction({
    settlement_number: '76837',
    contract_blocks: [{ contract_number: '93118', line_items: FLAT }],
    ...extra,
  })

  it('the spot block is lost and the totals were read from the first block: the short ticket still flags', () => {
    const c = completeness(firstBlockOnly({ statement_reported_total: 32777.38, statement_reported_gross: 32847.68, statement_reported_bushels: 7030.001, statement_reported_ticket_count: 7 }))
    expect(c.ok).toBe(false)
    expect(c.text).toBe('Ticket 500578194 pays 727 bu of the 1,060 bu on our load. The rest may be under another contract on this statement.')
  })

  it('the spot block is lost and the statement table was read: it names the contract', () => {
    const c = completeness(firstBlockOnly({ contract_types: CONTRACT_TYPES }))
    expect(c.ok).toBe(false)
    expect(c.text).toContain('The statement lists contract 97266, but no tickets were read under it.')
  })

  it('the spot block is lost and the sheet total was read: the money disagrees', () => {
    const c = completeness(firstBlockOnly(TOTALS))
    expect(c.text).toContain('Net on the lines is $32,777.38; the statement prints $34,298.50.')
  })

  it('a printed count of 7 tickets with the split truck on two lines is not a disagreement', () => {
    const data = normalizeSettlementExtraction({ ...ANSWER, statement_reported_ticket_count: 7 })
    expect(completeness(data)).toMatchObject({ ok: true, missingTickets: 0 })
  })

  it('a contract row that settled nothing on this sheet asks for nothing', () => {
    expect(unreadContracts([{ contract_number: '97266', settled_bushels: 0 }], [{ contract_number: '93118' }])).toEqual([])
  })

  it('a whole ticket paid after normal shrink is not short', () => {
    expect(partialTickets([{ ticket_number: 'A', net_bushels: 1006.43, loadId: 'a', loadBushels: 1048.6 }])).toEqual([])
    expect(partialTickets([{ ticket_number: 'A', net_bushels: 58.3, loadId: 'a', loadBushels: 971 }, { ticket_number: 'A', net_bushels: 912.7, loadId: 'a', loadBushels: 971 }])).toEqual([])
  })

  it('without a printed type the number stays unknown and the review can mark it spot', () => {
    const data = normalizeSettlementExtraction({ ...ANSWER, contract_types: undefined })
    const texts = unresolvedContractTexts(review(data))
    expect(texts).toEqual([{ key: '97266', text: '97266', lineCount: 1, lineIndexes: [7] }])
  })
})
