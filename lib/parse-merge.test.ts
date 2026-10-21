// Chunk-merge invariants for the chunked AI parse (lib/parse-chunked.ts).
//
// Behavior pinned:
//   * a record extracted from TWO page batches (printed on, or straddling, a
//     chunk boundary) resolves ONCE — dedupe by natural key where one exists
//     (ticket number, load number, PBI), by exact-content otherwise;
//   * records that merely look similar (different values) are all kept;
//   * header/scalar fields take the FIRST non-null value (headers live on
//     page 1), later chunks only fill what earlier ones lacked.

import { describe, expect, it } from 'vitest'
import {
  firstValue,
  mergeBrokerage,
  mergeContracts,
  mergeCottonLoads,
  mergeCottonMarketing,
  mergeCropInsurance,
  mergeDiscountSchedules,
  mergeFsaBaseAcres,
  mergeGinReceipts,
  mergeList,
  mergeSettlements,
  mergeTickets,
} from './parse-merge'
import type {
  BrokerageStatementExtraction,
  ContractExtraction,
  GinReceiptExtraction,
  GinReceiptPage,
  TicketExtraction,
} from './pdf-upload'
import type { CottonMarketingExtraction } from './cotton-doc-import'

const ticket = (over: Partial<TicketExtraction> = {}): TicketExtraction => ({
  ticket_number: '1001', date_text: '8/01/26', year_printed: true, time: null, truck: null, crop: 'Corn',
  gross_weight: 80000, tare_weight: 30000, net_weight: 50000, moisture: 15.1,
  test_weight: null, from_type: 'field', from_name: 'North 40', to_type: 'buyer', to_name: 'ADM',
  ...over,
})

describe('mergeList', () => {
  it('drops an exact repeat across chunks but keeps distinct items', () => {
    const a = { x: 1, y: 'a' }
    const merged = mergeList([[a], [{ x: 1, y: 'a' }, { x: 2, y: 'a' }]])
    expect(merged).toEqual([{ x: 1, y: 'a' }, { x: 2, y: 'a' }])
  })

  it('always keeps items whose natural key is null', () => {
    const merged = mergeList([[{ n: null }], [{ n: null }]], (i) => i.n)
    expect(merged).toHaveLength(2)
  })
})

describe('firstValue', () => {
  it('takes the first non-null across chunks (headers are on page 1)', () => {
    expect(firstValue([{ v: null }, { v: 'B' }, { v: 'C' }], (p) => p.v)).toBe('B')
    expect(firstValue([{ v: null }], (p) => p.v)).toBeNull()
  })
})

describe('mergeTickets', () => {
  it('resolves a ticket appearing in two chunks once (same number + date)', () => {
    const merged = mergeTickets([
      { tickets: [ticket(), ticket({ ticket_number: '1002' })] },
      { tickets: [ticket(), ticket({ ticket_number: '1003' })] },
    ])
    expect(merged.tickets.map((t) => t.ticket_number)).toEqual(['1001', '1002', '1003'])
  })

  it('keeps unnumbered tickets from every chunk (no safe key)', () => {
    const merged = mergeTickets([
      { tickets: [ticket({ ticket_number: null })] },
      { tickets: [ticket({ ticket_number: null })] },
    ])
    expect(merged.tickets).toHaveLength(2)
  })
})

describe('mergeSettlements', () => {
  it('keeps the page-1 header and dedupes line items by ticket number', () => {
    const merged = mergeSettlements([
      {
        buyer_name: 'ADM', settlement_date: '2026-08-01', settlement_number: 'S-9',
        line_items: [{ ticket_number: '1001', net_bushels: 900, gross_revenue: 4000, discounts: 50 }],
      },
      {
        buyer_name: null, settlement_date: null, settlement_number: null,
        line_items: [
          { ticket_number: '1001', net_bushels: 900, gross_revenue: 4000, discounts: 50 },
          { ticket_number: '1002', net_bushels: 850, gross_revenue: 3800, discounts: 0 },
        ],
      },
    ])
    expect(merged.buyer_name).toBe('ADM')
    expect(merged.settlement_number).toBe('S-9')
    expect(merged.line_items.map((l) => l.ticket_number)).toEqual(['1001', '1002'])
  })

  it('discount items: exact boundary repeats drop, per-chunk partials sum', () => {
    const item = (category: string, description: string, amount: number, rate_note: string | null = null) =>
      ({ category, description, amount, rate_note, quantity_basis: null })
    const merged = mergeSettlements([
      {
        buyer_name: 'ADM', settlement_date: '2026-08-01', settlement_number: 'S-9',
        line_items: [],
        discount_items: [item('drying', 'DRYING CHG', 75, '2.5¢/half point'), item('test_weight', 'TW DISC', 40)],
      },
      {
        buyer_name: null, settlement_date: null, settlement_number: null,
        line_items: [],
        discount_items: [
          item('drying', 'DRYING CHG', 75, '2.5¢/half point'), // exact repeat → dropped
          item('test_weight', 'TW DISC', 12), // different amount → a partial, sums
        ],
      },
    ])
    const byCat = new Map(merged.discount_items!.map((i) => [i.category, i]))
    expect(byCat.get('drying')!.amount).toBe(75)
    expect(byCat.get('drying')!.rate_note).toBe('2.5¢/half point')
    expect(byCat.get('test_weight')!.amount).toBe(52)
    expect(merged.discount_items).toHaveLength(2)
  })
})

describe('mergeDiscountSchedules', () => {
  it('header from the first chunk; one rule per factor (earliest wins)', () => {
    const rule = (factor: string, base: number | null) => ({
      factor, basis: 'cents_per_bu', base_value: base, direction: 'above' as const,
      rate_per_unit: 5, tiers: [], cumulative: false, rejection_at: null, note: null,
    })
    const merged = mergeDiscountSchedules([
      {
        buyer_name: 'Farmers Elevator', crop: 'Corn', effective_date: '2026-09-01',
        crop_year: 2026, schedule_text: 'p1 text',
        rules: [rule('drying', 15)],
      },
      {
        buyer_name: null, crop: null, effective_date: null, crop_year: null, schedule_text: null,
        rules: [rule('drying', 99), rule('test_weight', 54)], // drying repeat dropped
      },
    ])
    expect(merged.buyer_name).toBe('Farmers Elevator')
    expect(merged.effective_date).toBe('2026-09-01')
    expect(merged.rules.map((r) => [r.factor, r.base_value])).toEqual([
      ['drying', 15],
      ['test_weight', 54],
    ])
  })
})

describe('mergeContracts', () => {
  it('later chunks only fill fields page 1 lacked', () => {
    const p1 = {
      contract_number: 'C-1', buyer_name: 'ADM', crop: 'Corn', contract_type: 'forward',
      contract_month: null, crop_year: 2026, contracted_bushels: 10000, futures_price: null,
      basis: null, cash_price: 4.5, service_fee: null, delivery_type: 'pickup',
      delivery_start_date: null, delivery_end_date: null, notes: null,
    } as ContractExtraction
    const p2 = {
      ...p1, contract_number: 'WRONG', delivery_start_date: '2026-09-01', notes: 'terms on page 8',
    } as ContractExtraction
    const merged = mergeContracts([p1, p2])
    expect(merged.contract_number).toBe('C-1')
    expect(merged.delivery_start_date).toBe('2026-09-01')
    expect(merged.notes).toBe('terms on page 8')
  })
})

describe('mergeBrokerage', () => {
  const empty: BrokerageStatementExtraction = {
    statement_date: null, open_positions: [], closed_groups: [], closed_trades: [],
    open_options: [], closed_options: [], account_summary: null,
  }
  it('dedupes an identical position repeated across a boundary, keeps distinct lots', () => {
    const pos = { trade_date: '2026-07-01', side: 'short' as const, num_contracts: 2, commodity: 'Corn', contract_month: 'Dec 26', trade_price: 4.51, unrealized_pnl: 250 }
    const merged = mergeBrokerage([
      { ...empty, statement_date: '2026-08-01', open_positions: [pos] },
      { ...empty, open_positions: [{ ...pos }, { ...pos, num_contracts: 3 }] },
    ])
    expect(merged.statement_date).toBe('2026-08-01')
    expect(merged.open_positions).toHaveLength(2)
  })
  it('takes the first non-null account summary', () => {
    const summary = { beginning_balance: 1, ending_balance: 2, open_trade_equity: 3, total_equity: 4, margin_requirement: 5, excess_equity: 6 }
    const merged = mergeBrokerage([{ ...empty }, { ...empty, account_summary: summary }])
    expect(merged.account_summary).toEqual(summary)
  })
})

describe('mergeCropInsurance / mergeFsaBaseAcres', () => {
  it('drops only exact repeats (downstream screens dedupe on natural keys)', () => {
    const policy = { crop: 'Corn' } as never
    expect(mergeCropInsurance([{ policies: [policy] }, { policies: [policy] }]).policies).toHaveLength(1)
    const farm = { fsa_farm_number: '123', county: 'Lawrence', state: 'AL', commodities: [] }
    const merged = mergeFsaBaseAcres([{ farms: [farm] }, { farms: [{ ...farm }] }])
    expect(merged.farms).toHaveLength(1)
  })
})

describe('mergeCottonLoads', () => {
  it('a load number on pages 3 and 9 resolves once', () => {
    const load = { load_number: 'M-77', producer: null, farm_number: null, field: null, picked_date: null, delivered_date: null, truck: null, gross_weight: null, tare_weight: null, rolls: null, net_weight: 42000, crop_year: 2026 }
    const merged = mergeCottonLoads([
      { loads: [load] },
      { loads: [{ ...load }, { ...load, load_number: 'M-78' }] },
    ])
    expect(merged.loads.map((l) => l.load_number)).toEqual(['M-77', 'M-78'])
  })
})

describe('mergeGinReceipts', () => {
  const receipt = (over: Partial<GinReceiptExtraction> = {}): GinReceiptExtraction => ({ pages: [], ...over })
  const page = (n: number, over: Partial<GinReceiptPage> = {}): GinReceiptPage => ({
    page: n, statement_date: null, has_totals_block: false, gin_name: 'Valley Gin', gin_address: null, gin_phone: null, gin_code: '40614', statement_number: null,
    producer: null, farm_number: null, farm_name: null, field: null, crop_year: null, totals: null, farm_ytd: null, loads: [], bales: [], bale_row_first: null, bale_row_last: null, ...over,
  })
  it('pages concatenate in page order; the same page returned twice across a chunk boundary keeps the first; nothing folds statements together', () => {
    const merged = mergeGinReceipts([
      receipt({ pages: [page(2, { bales: [{ pbi_number: '123457', net_weight_lbs: 495 }] }), page(1, { statement_date: '2026-10-10', has_totals_block: true, loads: [{ load_number: '31633', rolls: 6, gross: 62_400, tare: 31_400, net: 31_000 }] })] }),
      receipt({ pages: [page(2, { bales: [{ pbi_number: '999999', net_weight_lbs: 1 }] }), page(3, { statement_date: '2026-10-07', has_totals_block: true })] }),
    ])
    expect(merged.pages.map((p) => p.page)).toEqual([1, 2, 3])
    expect(merged.pages[1].bales.map((b) => b.pbi_number)).toEqual(['123457'])
    expect(merged.pages[0].loads).toHaveLength(1)
    expect(merged.pages[2].statement_date).toBe('2026-10-07')
  })
})

describe('mergeCottonMarketing', () => {
  it('majority category wins and bale PBIs concatenate deduped', () => {
    const chunk = (pbis: string[], category = 'bale_list' as const): CottonMarketingExtraction => ({
      document_category: category, confidence: 'high', extracted: { bale_pbis: pbis },
    })
    const merged = mergeCottonMarketing([
      chunk(['0100200', '100300']),
      chunk(['100200', '100400']), // 100200 repeats across the boundary
      { document_category: 'storage_invoice', confidence: 'medium', extracted: null },
    ])
    expect(merged.document_category).toBe('bale_list')
    expect(merged.confidence).toBe('medium')
    expect((merged.extracted as { bale_pbis: string[] }).bale_pbis).toEqual(['0100200', '100300', '100400'])
  })

  it('a single chunk passes through untouched', () => {
    const one: CottonMarketingExtraction = { document_category: 'equity_sale', confidence: 'low', extracted: null }
    expect(mergeCottonMarketing([one])).toBe(one)
  })

  it('a sales contract’s quality terms merge across chunks: the clause from page 1, the farm schedule from page 4', () => {
    const blank = { contract_type: null, buyer: null, contract_number: null, contract_date: null, crop_year: null, committed_bales: null, committed_acres: null, price_cents_per_lb: null, basis_cents: null, futures_month: null, delivery_start: null, delivery_end: null, notes: null }
    const q = { quality_clause: null, color: null, leaf: null, staple: null, micronaire: null, strength: null, uniformity: null, extraneous_matter: null, eligible_farms: null, bale_cap: null, estimated_bales: null, base_grade: null, base_price_cents_per_lb: null, off_spec_terms: null, other_deliverables: null, practice_requirement: null }
    const page1: CottonMarketingExtraction = {
      document_category: 'sales_contract', confidence: 'high',
      extracted: { ...blank, contract_type: 'fixed_price', buyer: 'VS Service Company, LLC', contract_date: '2026-03-31', crop_year: 2026, committed_bales: 4250, price_cents_per_lb: 86,
        quality: { ...q, quality_clause: 'Color 41 and better, leaf 3 and better…', color: 'Color 41 and better', leaf: 'leaf 3 and better', bale_cap: 4250, estimated_bales: 6825, base_grade: '41-3-37', base_price_cents_per_lb: 86 } },
    }
    const page4: CottonMarketingExtraction = {
      document_category: 'sales_contract', confidence: 'medium',
      extracted: { ...blank, quality: { ...q, eligible_farms: [
        { fsa_number: '252', county: 'Lawrence', planted_acres: 80.6, aph_yield: 1369, aph_est_bales: 221, trendline_est_bales: 201 },
        { fsa_number: '0252', county: 'Lawrence', planted_acres: 80.6, aph_yield: 1369, aph_est_bales: 221, trendline_est_bales: 201 },
        { fsa_number: '5824', county: 'Lawrence', planted_acres: 255.6, aph_yield: 1259, aph_est_bales: 644, trendline_est_bales: 636 },
      ] } },
    }
    const merged = mergeCottonMarketing([page1, page4])
    const quality = (merged.extracted as { quality: { color: string; bale_cap: number; eligible_farms: Array<{ fsa_number: string }> } }).quality
    expect(quality.color).toBe('Color 41 and better')
    expect(quality.bale_cap).toBe(4250)
    expect(quality.eligible_farms.map((f) => f.fsa_number)).toEqual(['252', '5824'])
    expect(merged.confidence).toBe('medium')
  })
})

describe('mergeBrokerage — natural keys (2026-10-13)', () => {
  const empty: BrokerageStatementExtraction = {
    statement_date: null, open_positions: [], closed_groups: [], closed_trades: [],
    open_options: [], closed_options: [], account_summary: null,
  }
  it('a closed group straddling a chunk boundary merges its lots instead of dropping the second half', () => {
    const head = { commodity: 'Cotton', contract_month: 'DEC 26', side: 'short' as const, close_date: '2026-10-12', close_price: 80.45739, statement_reported_total: null, close_execution_code: 'SE' }
    const merged = mergeBrokerage([
      { ...empty, closed_groups: [{ ...head, lots: [{ open_date: '2026-03-18', open_price: 72.65, contracts: 10 }] }] },
      { ...empty, closed_groups: [{ ...head, lots: [{ open_date: '2026-03-18', open_price: 72.65, contracts: 10 }, { open_date: '2026-08-10', open_price: 84.4, contracts: 13 }], statement_reported_total: -13410, statement_reported_contracts: 23, fees: 531.53 }] },
    ])
    expect(merged.closed_groups).toHaveLength(1)
    expect(merged.closed_groups![0].lots).toHaveLength(2)
    expect(merged.closed_groups![0].statement_reported_total).toBe(-13410)
    expect(merged.closed_groups![0].statement_reported_contracts).toBe(23)
    expect(merged.closed_groups![0].fees).toBe(531.53)
  })
  it('open rows key on commodity|month|side|date|price|qty|code; subtotals on commodity|month|side; confirmation fills on their full print', () => {
    const pos = { trade_date: '2026-10-12', side: 'short' as const, num_contracts: 3, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: 83.63, unrealized_pnl: -270, execution_code: 'SE' }
    const sub = { commodity: 'Cotton', contract_month: 'MAR 27', side: 'short' as const, contracts: 23, close_price: 83.81, open_trade_equity: -1870 }
    const fill = { trade_date: '2026-10-12', side: 'sell' as const, num_contracts: 3, commodity: 'Cotton', contract_month: 'MAR 27', trade_price: 83.63, execution_code: 'SE' }
    const merged = mergeBrokerage([
      { ...empty, open_positions: [pos], open_position_subtotals: [sub], confirmation_trades: [fill] },
      { ...empty, open_positions: [{ ...pos, unrealized_pnl: -271 }, { ...pos, trade_price: 83.64 }], open_position_subtotals: [{ ...sub, contracts: 24 }], confirmation_trades: [fill, { ...fill, num_contracts: 12 }] },
    ])
    expect(merged.open_positions).toHaveLength(2)
    expect(merged.open_position_subtotals).toHaveLength(1)
    expect(merged.confirmation_trades).toHaveLength(2)
  })
})
