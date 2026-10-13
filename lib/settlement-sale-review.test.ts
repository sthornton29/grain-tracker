import { describe, expect, it } from 'vitest'
import type { SettlementLineExtraction } from '@/lib/pdf-upload'
import { saleAllocations, type LoadSale, type SaleAllocation } from '@/lib/load-sales'
import {
  buildApplyPlan,
  buildSaleReview,
  compareText,
  describeOurs,
  describeTheirs,
  groupsNeedingReview,
  possiblySpotLines,
  resolveContractText,
  saleChipLabel,
  spotPriceChangeText,
  unresolvedContractTexts,
  withSaleType,
  type ReviewContract,
} from '@/lib/settlement-sale-review'
import { pairRereadLines } from '@/lib/settlement-reread'

// Bunge 0000205995 — the split ticket 0502289 (58.284 bu on contract
// 2002960604-10, 912.744 bu spot @ 13.74) plus a plain spot load.
const CONTRACT = '2002960604-10'
const K: ReviewContract = { id: 'K', contract_number: '2002960604-000010', buyer_id: 'bunge', crop_id: 'soy', crop_year: 2026 }
const K_CORN: ReviewContract = { id: 'KC', contract_number: '2002960604-10', buyer_id: 'bunge', crop_id: 'corn', crop_year: 2026 }
const OTHER: ReviewContract = { id: 'O', contract_number: '93115', buyer_id: 'bunge', crop_id: 'soy', crop_year: 2025 }

function line(ticket: string, contract: string | null, bu: number, price: number): SettlementLineExtraction {
  return { ticket_number: ticket, contract_number: contract, net_bushels: bu, gross_revenue: Math.round(bu * price * 1e5) / 1e5, discounts: 0 }
}

const LINES = [
  line('0502289', CONTRACT, 58.284, 12.71),
  line('0502289', 'SPOT', 912.744, 13.74),
  line('0503084', 'SPOT', 944.23, 13.38),
]

function sale(load_id: string, partial: Partial<LoadSale> & Pick<LoadSale, 'sale_type' | 'share'>): LoadSale {
  return { id: `${load_id}-${partial.sale_type}`, load_id, contract_id: null, buyer_net_bushels: null, spot_price: null, spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null, ...partial }
}

const num = (id: string) => (id === 'K' ? '2002960604-10' : id === 'O' ? '93115' : null)

describe('resolveContractText', () => {
  it('matches the buyer\'s contract by number (leading zeros ignored), the settlement\'s crop first', () => {
    expect(resolveContractText(CONTRACT, [OTHER, K], undefined, 'soy')).toBe('K')
    expect(resolveContractText(CONTRACT, [K_CORN, K], undefined, 'soy')).toBe('K')
    expect(resolveContractText(CONTRACT, [K_CORN, K], undefined, 'corn')).toBe('KC')
    expect(resolveContractText(CONTRACT, [K_CORN], undefined, 'soy')).toBe('KC')
  })
  it('an explicit link wins; unknown text and blank text resolve to nothing', () => {
    expect(resolveContractText('ZZ-1', [K], new Map([['ZZ-1', 'O']]))).toBe('O')
    expect(resolveContractText('ZZ-1', [K])).toBeNull()
    expect(resolveContractText('SPOT', [K])).toBeNull()
    expect(resolveContractText(null, [K])).toBeNull()
  })
})

describe('buildSaleReview — ours vs the buyer\'s', () => {
  // We had ALL of 0502289 on the contract (975.0 dry bu); 0503084 was an estimated spot load.
  const loads = [{ id: 'L289', contract_id: null, to_type: 'buyer' as const, dryBu: 975 }, { id: 'L084', contract_id: null, to_type: 'buyer' as const, dryBu: 940 }]
  const ours = saleAllocations(loads, [
    sale('L289', { sale_type: 'contract', contract_id: 'K', share: 1 }),
    sale('L084', { sale_type: 'spot', share: 1, spot_price: 13.39, spot_price_source: 'estimate', est_futures_symbol: 'ZSX26' }),
  ])
  const loadFor = (i: number) => (i < 2 ? 'L289' : 'L084')
  const groups = buildSaleReview({ lines: LINES, loadIdForLine: loadFor, oursByLoad: ours, contracts: [K, OTHER], cropId: 'soy' })

  it('0502289: the buyer splits it 58.284 / 912.744 (971.028 total) → on our 975.0 bu that is 58.522 / 916.478; ours was all contract → differs', () => {
    const g = groups.find((x) => x.ticket === '0502289')!
    expect(g.loadId).toBe('L289')
    expect(g.group.split).toBe(true)
    expect(g.unresolved).toEqual([])
    expect(g.theirs.map((r) => r.sale_type)).toEqual(['contract', 'spot'])
    expect(g.theirs[0].contract_id).toBe('K')
    expect(g.theirs[0].share + g.theirs[1].share).toBe(1)
    expect(g.theirs[0].share).toBeCloseTo(58.284 / 971.028, 9)
    const applied = saleAllocations([loads[0]], g.theirs.map((r, i) => sale('L289', { id: `r${i}`, sale_type: r.sale_type, contract_id: r.contract_id ?? null, share: r.share })))
    expect(applied.get('L289')!.map((a) => Math.round(a.bushels * 1000) / 1000)).toEqual([58.522, 916.478])
    expect(g.differs).toBe(true)
    expect(g.lines.map((l) => [l.sale_type, l.contract_number_text, l.contract_id])).toEqual([['contract', CONTRACT, 'K'], ['spot', 'SPOT', null]])
    expect(g.spotPriceChange).toBeNull() // we had no spot row on it
  })

  it('the comparison reads in farmer words', () => {
    const g = groups.find((x) => x.ticket === '0502289')!
    expect(describeOurs(g.ours!, num)).toBe('all on contract 2002960604-10')
    expect(describeTheirs(g.theirs, num)).toBe('58.3 bu contract 2002960604-10, 913 bu spot')
    expect(compareText(g, num, 'Bunge')).toBe('Ours: all on contract 2002960604-10 · Bunge: 58.3 bu contract 2002960604-10, 913 bu spot')
    expect(describeOurs([], num)).toBe('no sale picked yet')
    expect(describeTheirs([{ sale_type: 'spot', share: 1 }], num)).toBe('all spot')
    const split: SaleAllocation[] = [
      { loadId: 'L', saleType: 'contract', contractId: 'K', share: 0.06, bushels: 58.5, sale: null },
      { loadId: 'L', saleType: 'spot', contractId: null, share: 0.94, bushels: 916.5, sale: null },
    ]
    expect(describeOurs(split, num)).toBe('split: 59 bu contract 2002960604-10 · 917 bu spot')
  })

  it('0503084: both say spot → not different, but our estimate gives way to the settled price, shown once', () => {
    const g = groups.find((x) => x.ticket === '0503084')!
    expect(g.differs).toBe(false)
    expect(g.spotPriceChange).toEqual({ before: 13.39, beforeSource: 'estimate', after: 13.38 })
    expect(spotPriceChangeText(g.spotPriceChange!)).toBe('est. $13.39, settled $13.38')
    expect(spotPriceChangeText({ before: 13.5, beforeSource: 'entered', after: 13.38 })).toBe('your bid $13.50, settled $13.38')
    expect(groupsNeedingReview(groups).map((x) => x.ticket)).toEqual(['0502289', '0503084'])
  })

  it('the apply plan: the buyer\'s rows per load (default) with settlement_line_id from the inserted ids; line columns for every line', () => {
    const plan = buildApplyPlan(groups, new Map(), new Map([[0, 'sl-a'], [1, 'sl-b'], [2, 'sl-c']]))
    expect(plan.blockedLoadIds).toEqual([])
    expect(plan.loadWrites.map((w) => w.loadId)).toEqual(['L289', 'L084'])
    const w289 = plan.loadWrites[0].rows
    expect(w289[0]).toMatchObject({ sale_type: 'contract', contract_id: 'K', buyer_net_bushels: 58.284, settlement_line_id: 'sl-a' })
    expect(w289[1]).toMatchObject({ sale_type: 'spot', buyer_net_bushels: 912.744, spot_price: 13.74, spot_price_source: 'settlement', settlement_line_id: 'sl-b' })
    expect(plan.loadWrites[1].rows[0]).toMatchObject({ sale_type: 'spot', share: 1, spot_price: 13.38, spot_price_source: 'settlement', settlement_line_id: 'sl-c' })
    expect(plan.lineUpdates).toEqual([
      { index: 0, sale_type: 'contract', contract_number_text: CONTRACT, contract_id: 'K' },
      { index: 1, sale_type: 'spot', contract_number_text: 'SPOT', contract_id: null },
      { index: 2, sale_type: 'spot', contract_number_text: 'SPOT', contract_id: null },
    ])
  })

  it('"Keep ours" writes nothing for a contract-only load, but a spot row of ours still takes the settled price', () => {
    const plan = buildApplyPlan(groups, new Map([['502289', 'ours'], ['503084', 'ours']]), new Map([[2, 'sl-c']]))
    expect(plan.loadWrites.map((w) => w.loadId)).toEqual(['L084'])
    expect(plan.loadWrites[0].rows).toEqual([expect.objectContaining({ sale_type: 'spot', share: 1, spot_price: 13.38, spot_price_source: 'settlement', est_futures_symbol: 'ZSX26', settlement_line_id: 'sl-c' })])
    // Already at the settled price → nothing to write.
    const settled = saleAllocations([loads[1]], [sale('L084', { sale_type: 'spot', share: 1, spot_price: 13.38, spot_price_source: 'settlement' })])
    const again = buildSaleReview({ lines: [LINES[2]], loadIdForLine: () => 'L084', oursByLoad: settled, contracts: [K] })
    expect(again[0].spotPriceChange).toBeNull()
    expect(buildApplyPlan(again, new Map([['503084', 'ours']])).loadWrites).toEqual([])
  })

  it('a load with no sale yet always takes the buyer\'s version, whatever the choice', () => {
    const none = buildSaleReview({ lines: [LINES[2]], loadIdForLine: () => 'L084', oursByLoad: new Map([['L084', []]]), contracts: [K] })
    expect(none[0].differs).toBe(true)
    expect(buildApplyPlan(none, new Map([['503084', 'ours']])).loadWrites).toHaveLength(1)
  })

  it('an unmatched line updates its own columns and writes no load', () => {
    const g = buildSaleReview({ lines: [LINES[2]], loadIdForLine: () => null, oursByLoad: new Map(), contracts: [K] })
    expect(g[0].ours).toBeNull()
    const plan = buildApplyPlan(g)
    expect(plan.loadWrites).toEqual([])
    expect(plan.lineUpdates).toHaveLength(1)
  })
})

describe('unknown contract numbers and "S12"', () => {
  const oursK = new Map([['L1', [{ loadId: 'L1', saleType: 'contract' as const, contractId: 'K', share: 1, bushels: 900, sale: null }]]])

  it('a number not on file is unresolved: listed for the link select, the load is blocked, nothing is written', () => {
    const lines = [line('1', 'ZZ-1', 900, 12), line('2', 'ZZ-1', 850, 12), line('3', 'SPOT', 800, 13)]
    const groups = buildSaleReview({ lines, loadIdForLine: (i) => `L${i + 1}`, oursByLoad: oursK, contracts: [K] })
    expect(groups[0].unresolved).toEqual(['ZZ-1'])
    expect(groups[0].theirs).toEqual([])
    expect(unresolvedContractTexts(groups)).toEqual([{ key: 'ZZ-1', text: 'ZZ-1', lineCount: 2 }])
    const plan = buildApplyPlan(groups)
    expect(plan.blockedLoadIds).toEqual(['L1', 'L2'])
    expect(plan.loadWrites.map((w) => w.loadId)).toEqual(['L3'])
    expect(plan.lineUpdates[0]).toEqual({ index: 0, sale_type: 'contract', contract_number_text: 'ZZ-1', contract_id: null })
    // Linking it resolves every line printing it.
    const linked = buildSaleReview({ lines, loadIdForLine: (i) => `L${i + 1}`, oursByLoad: oursK, contracts: [K], links: new Map([['ZZ-1', 'K']]) })
    expect(linked[0].unresolved).toEqual([])
    expect(linked[0].differs).toBe(false)
    expect(buildApplyPlan(linked).loadWrites.map((w) => w.loadId)).toEqual(['L1', 'L2', 'L3'])
    expect(buildApplyPlan(linked).lineUpdates[1].contract_id).toBe('K')
  })

  it('"S12" is possibly spot: a contract until confirmed; the toggle makes the line spot', () => {
    const lines = [line('7', 'S12', 900, 13.5)]
    const groups = buildSaleReview({ lines, loadIdForLine: () => 'L1', oursByLoad: oursK, contracts: [K] })
    expect(possiblySpotLines(groups)).toEqual([{ index: 0, text: 'S12' }])
    expect(groups[0].unresolved).toEqual(['S12'])
    expect(saleChipLabel(groups[0].lines[0] as { sale_type: string | null; contract_number_text: string | null })).toBe('Contract S12')
    expect(saleChipLabel({ sale_type: null, contract_number_text: 'S12' })).toBe('S12 · possibly spot')
    const confirmed = buildSaleReview({ lines: withSaleType(lines, [0], 'spot'), loadIdForLine: () => 'L1', oursByLoad: oursK, contracts: [K] })
    expect(possiblySpotLines(confirmed)).toEqual([])
    expect(confirmed[0].theirs).toEqual([expect.objectContaining({ sale_type: 'spot', share: 1, spot_price: 13.5, spot_price_source: 'settlement' })])
    expect(confirmed[0].differs).toBe(true)
    expect(confirmed[0].lines[0]).toMatchObject({ sale_type: 'spot', contract_number_text: 'S12', contract_id: null })
  })

  it('a line with no contract text and no header contract has no sale to apply', () => {
    const groups = buildSaleReview({ lines: [line('9', null, 900, 12)], loadIdForLine: () => 'L1', oursByLoad: oursK, contracts: [K] })
    expect(groups[0].lines[0].sale_type).toBeNull()
    expect(groups[0].theirs).toEqual([])
    expect(groups[0].unresolved).toEqual([])
    expect(buildApplyPlan(groups).blockedLoadIds).toEqual(['L1'])
    expect(saleChipLabel({ sale_type: null, contract_number_text: null })).toBe('Sale not set')
    expect(saleChipLabel({ sale_type: null, contract_number_text: null }, '2002960604-10')).toBe('Contract 2002960604-10')
  })
})

describe('pairRereadLines — a re-read of the saved statement', () => {
  it('pairs by ticket and contract text, then by closest bushels; the split\'s second line pairs with nothing when the saved statement has one merged line', () => {
    const saved = [
      { id: 'a', ticket_number: '0502289', contract_number_text: null, net_bushels: 971.028 },
      { id: 'b', ticket_number: '0503084', contract_number_text: null, net_bushels: 944.23 },
      { id: 'c', ticket_number: '0509999', contract_number_text: null, net_bushels: 100 },
    ]
    const p = pairRereadLines(saved, LINES)
    expect(p.savedIdByIndex.get(1)).toBe('a') // the 912.744 line is nearer 971 than the 58.284 line
    expect(p.savedIdByIndex.get(0)).toBeUndefined()
    expect(p.savedIdByIndex.get(2)).toBe('b')
    expect(p.unpairedIndexes).toEqual([0])
    expect(p.unpairedSavedIds).toEqual(['c'])
  })
  it('saved lines that already carry contract text pair on it', () => {
    const saved = [
      { id: 'spot', ticket_number: '0502289', contract_number_text: 'SPOT', net_bushels: 912.744 },
      { id: 'k', ticket_number: '0502289', contract_number_text: '2002960604-000010', net_bushels: 58.284 },
    ]
    const p = pairRereadLines(saved, LINES.slice(0, 2))
    expect(p.savedIdByIndex.get(0)).toBe('k')
    expect(p.savedIdByIndex.get(1)).toBe('spot')
  })
})
