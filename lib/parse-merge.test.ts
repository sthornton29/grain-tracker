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
  TicketExtraction,
} from './pdf-upload'
import type { CottonMarketingExtraction } from './cotton-doc-import'

const ticket = (over: Partial<TicketExtraction> = {}): TicketExtraction => ({
  ticket_number: '1001', date: '2026-08-01', time: null, truck: null, crop: 'Corn',
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
    const load = { load_number: 'M-77', producer: null, farm_number: null, field: null, picked_date: null, delivered_date: null, truck: null, gross_weight: null, tare_weight: null, net_weight: 42000, crop_year: 2026 }
    const merged = mergeCottonLoads([
      { loads: [load] },
      { loads: [{ ...load }, { ...load, load_number: 'M-78' }] },
    ])
    expect(merged.loads.map((l) => l.load_number)).toEqual(['M-77', 'M-78'])
  })
})

describe('mergeGinReceipts', () => {
  const receipt = (over: Partial<GinReceiptExtraction> = {}): GinReceiptExtraction => ({
    gin_name: null, gin_address: null, gin_phone: null, receipt_number: null,
    receipt_date: null, producer: null, farm_number: null, farm_name: null, field: null,
    crop_year: null, modules_count: null, total_seed_cotton_weight: null, bales_count: null,
    total_bale_weight: null, avg_bale_weight: null, seed_lbs: null, lint_turnout_pct: null,
    lint_lbs_per_bale: null, loads: [], bales: [], ...over,
  })
  it('header from chunk 1, bales deduped on the PBI rule (digits, no leading zeros)', () => {
    const merged = mergeGinReceipts([
      receipt({
        gin_name: 'Valley Gin', receipt_number: 'G-42', bales_count: 3,
        bales: [{ pbi_number: '0123456', net_weight_lbs: 480 }],
        loads: [{ load_number: 'L-1', rolls: null, gross: null, tare: null, net: 40000 }],
      }),
      receipt({
        bales: [
          { pbi_number: '123456', net_weight_lbs: 480 }, // same bale, zeros stripped
          { pbi_number: '123457', net_weight_lbs: 495 },
        ],
        loads: [{ load_number: 'L-1', rolls: null, gross: null, tare: null, net: 40000 }],
      }),
    ])
    expect(merged.gin_name).toBe('Valley Gin')
    expect(merged.receipt_number).toBe('G-42')
    expect(merged.bales_count).toBe(3)
    expect(merged.bales.map((b) => b.pbi_number)).toEqual(['0123456', '123457'])
    expect(merged.loads).toHaveLength(1)
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
})
