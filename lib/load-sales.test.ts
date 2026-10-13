import { describe, expect, it } from 'vitest'
import {
  deliveredBushelsByContract, describeSale, isContractComplete, overfillSplit, saleAllocations, saleKind,
  sharesFromParts, singleSaleRow, unassignedBuyerLoads, validateSaleRows, allocationsOfType,
  type LoadSale, type SaleLoad,
} from '@/lib/load-sales'

// The ONE seam for "how was this load sold" (094). Hand-verified numbers from
// Bunge settlement 0000205995 and the spec's two-contract / price-later cases.

function sale(over: Partial<LoadSale> & Pick<LoadSale, 'load_id' | 'sale_type' | 'share'>): LoadSale {
  return {
    id: `s-${over.load_id}-${over.sale_type}-${over.contract_id ?? ''}`, contract_id: null, buyer_net_bushels: null, spot_price: null,
    spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null, ...over,
  }
}

describe('saleAllocations / deliveredBushelsByContract', () => {
  it('an unsplit load with one share-1 contract row delivers all its dry bushels to that contract (= the old per-load sum)', () => {
    const loads: SaleLoad[] = [
      { id: 'L1', to_type: 'buyer', dryBu: 894.14 },
      { id: 'L2', to_type: 'buyer', dryBu: 1107.333 },
    ]
    const sales = [sale({ load_id: 'L1', sale_type: 'contract', contract_id: 'A', share: 1 }), sale({ load_id: 'L2', sale_type: 'contract', contract_id: 'A', share: 1 })]
    const d = deliveredBushelsByContract(loads, sales)
    expect(d.get('A')!.dryBu).toBeCloseTo(894.14 + 1107.333, 6)
    expect(d.get('A')!.count).toBe(2)
  })

  it('a split load counts only each contract\'s share; shares × dryBu reconcile to the load', () => {
    // 0502289: our load is 975.0 dry bu; Bunge put 58.284 of 971.028 on the contract.
    const rows = sharesFromParts([
      { sale_type: 'contract', contract_id: 'A', bushels: 58.284 },
      { sale_type: 'spot', bushels: 912.744 },
    ])
    expect(rows[0].share).toBeCloseTo(0.0600230, 6)
    expect(rows[0].share + rows[1].share).toBe(1)
    const loads: SaleLoad[] = [{ id: 'L', to_type: 'buyer', dryBu: 975 }]
    const sales = rows.map((r, i) => sale({ id: `r${i}`, load_id: 'L', sale_type: r.sale_type, contract_id: r.contract_id ?? null, share: r.share }))
    const allocs = saleAllocations(loads, sales).get('L')!
    expect(allocs.map((a) => Math.round(a.bushels * 1000) / 1000)).toEqual([58.522, 916.478])
    expect(allocs[0].bushels + allocs[1].bushels).toBeCloseTo(975, 9)
    expect(deliveredBushelsByContract(loads, sales).get('A')!.dryBu).toBeCloseTo(58.522, 3)
    expect(allocationsOfType(loads, sales, 'spot')[0].bushels).toBeCloseTo(916.478, 3)
  })

  it('pre-094 fallback: no rows + a contract_id reads as one full contract allocation; no rows and no contract = unassigned', () => {
    const loads: SaleLoad[] = [
      { id: 'old', contract_id: 'A', to_type: 'buyer', dryBu: 100 },
      { id: 'none', contract_id: null, to_type: 'buyer', dryBu: 50 },
      { id: 'bin', contract_id: null, to_type: 'bin', dryBu: 50 },
    ]
    const allocs = saleAllocations(loads, [])
    expect(allocs.get('old')).toMatchObject([{ saleType: 'contract', contractId: 'A', share: 1, bushels: 100, sale: null }])
    expect(allocs.get('none')).toEqual([])
    expect(unassignedBuyerLoads(loads, []).map((l) => l.id)).toEqual(['none'])
    expect(saleKind([], loads[1])).toBe('unassigned')
    expect(saleKind([], loads[2])).toBe('none')
  })

  it('spot and price-later loads are never unassigned', () => {
    const loads: SaleLoad[] = [{ id: 'S', to_type: 'buyer', dryBu: 10 }, { id: 'P', to_type: 'buyer', dryBu: 10 }]
    const sales = [sale({ load_id: 'S', sale_type: 'spot', share: 1 }), sale({ load_id: 'P', sale_type: 'price_later', share: 1 })]
    expect(unassignedBuyerLoads(loads, sales)).toEqual([])
  })

  it('BACKFILL REGRESSION: delivered totals are identical before (contract_id sum) and after (share-1 rows) for every contract', () => {
    const loads: SaleLoad[] = Array.from({ length: 40 }, (_, i) => ({ id: `L${i}`, contract_id: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : null, to_type: 'buyer', dryBu: 900 + i * 7.25 }))
    const before = new Map<string, number>()
    for (const l of loads) if (l.contract_id) before.set(l.contract_id, (before.get(l.contract_id) ?? 0) + l.dryBu)
    const backfilled = loads.filter((l) => l.contract_id).map((l) => sale({ load_id: l.id, sale_type: 'contract', contract_id: l.contract_id, share: 1 }))
    const after = deliveredBushelsByContract(loads, backfilled)
    for (const [id, bu] of before) expect(after.get(id)!.dryBu).toBeCloseTo(bu, 9)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    // And the fallback path (rows not yet written) agrees too.
    const fallback = deliveredBushelsByContract(loads, [])
    for (const [id, bu] of before) expect(fallback.get(id)!.dryBu).toBeCloseTo(bu, 9)
  })
})

describe('two-contract split (the overfill prompt)', () => {
  it('1,000 bu onto A with 300 left → 300 to A, 700 to B; shares .3/.7; A reads complete when it hits its quantity', () => {
    const { onContract, overflow } = overfillSplit(1000, 300)
    expect(onContract).toBe(300)
    expect(overflow).toBe(700)
    const rows = sharesFromParts([
      { sale_type: 'contract', contract_id: 'A', bushels: onContract },
      { sale_type: 'contract', contract_id: 'B', bushels: overflow },
    ])
    expect(rows.map((r) => r.share)).toEqual([0.3, 0.7])
    expect(validateSaleRows(rows)).toBeNull()
    const loads: SaleLoad[] = [{ id: 'L', to_type: 'buyer', dryBu: 1000 }, { id: 'prior', to_type: 'buyer', dryBu: 9700 }]
    const sales = [
      ...rows.map((r, i) => sale({ id: `r${i}`, load_id: 'L', sale_type: 'contract', contract_id: r.contract_id, share: r.share })),
      sale({ load_id: 'prior', sale_type: 'contract', contract_id: 'A', share: 1 }),
    ]
    const d = deliveredBushelsByContract(loads, sales)
    expect(d.get('A')!.dryBu).toBeCloseTo(10000, 9)
    expect(d.get('B')!.dryBu).toBeCloseTo(700, 9)
    expect(isContractComplete(null, 10000, d.get('A')!.dryBu)).toBe(true)
    expect(isContractComplete(null, 5000, d.get('B')!.dryBu)).toBe(false)
    expect(isContractComplete('2026-10-01', 5000, 0)).toBe(true)
  })

  it('overfill: a load that fits, or a contract with no target, is not split', () => {
    expect(overfillSplit(500, 1200)).toEqual({ onContract: 500, overflow: 0 })
    expect(overfillSplit(500, null)).toEqual({ onContract: 500, overflow: 0 })
  })
})

describe('sharesFromParts / validateSaleRows / singleSaleRow', () => {
  it('shares always sum to exactly 1 — the last row takes the remainder', () => {
    const rows = sharesFromParts([{ sale_type: 'contract', contract_id: 'A', bushels: 1 }, { sale_type: 'spot', bushels: 1 }, { sale_type: 'price_later', bushels: 1 }])
    expect(rows.reduce((s, r) => s + r.share, 0)).toBe(1)
    expect(rows[2].share).toBeCloseTo(1 / 3, 9)
  })
  it('zero parts drop; one part is share 1; an explicit total allocates "58 to the contract, the rest spot"', () => {
    expect(sharesFromParts([{ sale_type: 'spot', bushels: 0 }, { sale_type: 'contract', contract_id: 'A', bushels: 40 }])).toMatchObject([{ sale_type: 'contract', share: 1 }])
    const rows = sharesFromParts([{ sale_type: 'contract', contract_id: 'A', bushels: 58 }, { sale_type: 'spot', bushels: 917 }], 975)
    expect(rows[0].share).toBeCloseTo(58 / 975, 10)
    expect(rows[0].share + rows[1].share).toBe(1)
  })
  it('validation: contract rows need a contract, kinds cannot repeat, shares must sum to 1', () => {
    expect(validateSaleRows([{ sale_type: 'contract', share: 1 }])).toMatch(/Pick a contract/)
    expect(validateSaleRows([{ sale_type: 'spot', contract_id: 'A', share: 1 }])).toMatch(/Only a contract part/)
    expect(validateSaleRows([{ sale_type: 'spot', share: 0.5 }, { sale_type: 'spot', share: 0.5 }])).toMatch(/twice/)
    expect(validateSaleRows([{ sale_type: 'spot', share: 0.5 }])).toMatch(/add up/)
    expect(validateSaleRows([])).toBeNull()
  })
  it('singleSaleRow: a typed bid becomes an entered spot price; a contract choice carries no price', () => {
    expect(singleSaleRow({ sale_type: 'spot', spot_price: 13.74 })).toMatchObject([{ sale_type: 'spot', share: 1, spot_price: 13.74, spot_price_source: 'entered' }])
    expect(singleSaleRow({ sale_type: 'contract', contract_id: 'A' })).toMatchObject([{ sale_type: 'contract', contract_id: 'A', share: 1, spot_price: null }])
    expect(singleSaleRow({ sale_type: 'price_later' })).toMatchObject([{ sale_type: 'price_later', contract_id: null, share: 1 }])
  })
})

describe('describeSale', () => {
  const num = (id: string) => ({ A: '2002960604-10', B: '93115' } as Record<string, string>)[id]
  it('one kind reads plainly; a split lists bushels per part', () => {
    const load: SaleLoad = { id: 'L', to_type: 'buyer', dryBu: 975 }
    const rows = sharesFromParts([{ sale_type: 'contract', contract_id: 'A', bushels: 58.284 }, { sale_type: 'spot', bushels: 912.744 }])
    const sales = rows.map((r, i) => sale({ id: `r${i}`, load_id: 'L', sale_type: r.sale_type, contract_id: r.contract_id ?? null, share: r.share }))
    const allocs = saleAllocations([load], sales).get('L')!
    expect(describeSale(allocs, num, load)).toBe('split: 59 bu contract 2002960604-10 · 916 bu spot')
    expect(describeSale([allocs[1]], num)).toBe('Spot')
    expect(describeSale([{ ...allocs[0], share: 1 }], num)).toBe('Contract 2002960604-10')
    expect(describeSale([], num, load)).toBe('Unassigned')
    expect(describeSale([], num, { to_type: 'bin' })).toBe('')
  })
})
