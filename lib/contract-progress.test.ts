// Contract fill progress on the load form (lib/contract-progress).
//
// Behavior pinned:
//   * the delivered total is recomputed from the FULL set of saved loads —
//     loads saved earlier in the same Save & New session included, so the
//     displayed remaining never trails the session (the form refetches after
//     every save and runs the rows through contractDeliveredTotals);
//   * remaining = contracted − (delivered + this unsaved load), and the
//     over-delivery state (remaining < 0) flips on the load that actually
//     crosses the contracted total — not one load late;
//   * a dry-bushels override on a load replaces its computed figure;
//   * loads with no usable weight contribute nothing (and don't count).

import { describe, expect, it } from 'vitest'
import { contractDeliveredTotals, contractProgress, deliveredTotalsByContract, type ContractProgressLoad } from './contract-progress'
import type { LoadSale } from './load-sales'

// Corn-ish crop: 56 lb/bu, base 15% MC.
const cropById = new Map([['corn', { base_moisture_pct: 15, base_lb_per_bushel: 56 }]])

const load = (over: Partial<ContractProgressLoad> = {}): ContractProgressLoad => ({
  net_weight: 56_000, // 1,000 wet bu
  moisture: 15, // at base → dry = wet
  crop_id: 'corn',
  dry_bushels_override: null,
  ...over,
})

describe('contractDeliveredTotals', () => {
  it('sums dry bushels across prior AND same-session saved loads alike', () => {
    const prior = [load(), load()] // 2,000 bu delivered before this session
    const session = [load(), load(), load()] // 3 loads saved via Save & New
    const { dryBu, count } = contractDeliveredTotals([...prior, ...session], cropById)
    expect(dryBu).toBeCloseTo(5000, 5)
    expect(count).toBe(5)
  })

  it('a dry-bushels override replaces the computed figure for that load', () => {
    const { dryBu } = contractDeliveredTotals(
      [load(), load({ dry_bushels_override: 950 })],
      cropById,
    )
    expect(dryBu).toBeCloseTo(1950, 5)
  })

  it('shrinks wet loads above base moisture', () => {
    const { dryBu } = contractDeliveredTotals([load({ moisture: 20 })], cropById)
    // 1,000 wet bu × (100−20)/(100−15)
    expect(dryBu).toBeCloseTo((1000 * 80) / 85, 5)
  })

  it('loads with no usable weight contribute nothing and are not counted', () => {
    const { dryBu, count } = contractDeliveredTotals(
      [load(), load({ net_weight: null })],
      cropById,
    )
    expect(dryBu).toBeCloseTo(1000, 5)
    expect(count).toBe(1)
  })
})

describe('deliveredTotalsByContract — per contract through the sale rows (094)', () => {
  const sale = (over: Partial<LoadSale> & Pick<LoadSale, 'load_id' | 'sale_type' | 'share'>): LoadSale => ({
    id: `s-${over.load_id}-${over.contract_id ?? over.sale_type}`, contract_id: null, buyer_net_bushels: null, spot_price: null,
    spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null, ...over,
  })
  const L = (id: string, over: Partial<ContractProgressLoad> & { contract_id?: string | null } = {}) => ({ id, to_type: 'buyer' as const, ...load(), ...over })

  it('whole loads on one contract sum like before; a split load counts only its contract share', () => {
    const loads = [L('L1'), L('L2'), L('L3')]
    const sales = [
      sale({ load_id: 'L1', sale_type: 'contract', contract_id: 'A', share: 1 }),
      sale({ load_id: 'L2', sale_type: 'contract', contract_id: 'A', share: 1 }),
      // L3: 300 bu on A, the other 700 spot.
      sale({ load_id: 'L3', sale_type: 'contract', contract_id: 'A', share: 0.3 }),
      sale({ load_id: 'L3', sale_type: 'spot', share: 0.7 }),
    ]
    const d = deliveredTotalsByContract(loads, sales, cropById)
    expect(d.get('A')!.dryBu).toBeCloseTo(2300, 5)
    expect(d.get('A')!.count).toBe(3)
    expect(d.size).toBe(1) // spot never shows up as a contract
  })

  it('a load with no rows but a contract_id (pre-094 database) still counts in full', () => {
    const d = deliveredTotalsByContract([L('L1', { contract_id: 'B' })], [], cropById)
    expect(d.get('B')).toEqual({ dryBu: expect.closeTo(1000, 5), count: 1 })
  })

  it('two contracts on one load each get their share; weightless loads contribute nothing', () => {
    const loads = [L('L1'), L('L2', { net_weight: null })]
    const sales = [
      sale({ load_id: 'L1', sale_type: 'contract', contract_id: 'A', share: 0.25 }),
      sale({ load_id: 'L1', sale_type: 'contract', contract_id: 'B', share: 0.75 }),
      sale({ load_id: 'L2', sale_type: 'contract', contract_id: 'B', share: 1 }),
    ]
    const d = deliveredTotalsByContract(loads, sales, cropById)
    expect(d.get('A')!.dryBu).toBeCloseTo(250, 5)
    expect(d.get('B')!.dryBu).toBeCloseTo(750, 5)
    expect(d.get('B')!.count).toBe(1)
  })
})

describe('contractProgress — displayed remaining and the over-delivery flip', () => {
  it('remaining = contracted − (delivered incl. session loads + this load)', () => {
    // 10,000 bu contract; 4,000 delivered before + 3 × 1,000 saved this
    // session (all in the refetched delivered figure) + 1,000 on the form.
    const p = contractProgress({ contractedBu: 10_000, deliveredBu: 7000, thisLoadBu: 1000 })
    expect(p.projectedBu).toBe(8000)
    expect(p.remainingBu).toBe(2000)
  })

  it('the over notice fires on the crossing load, not one load late', () => {
    // 9,800 delivered AFTER the refetch counts the session's saves; the next
    // 1,000-bu load is the one that crosses the 10,000-bu line.
    const crossing = contractProgress({ contractedBu: 10_000, deliveredBu: 9800, thisLoadBu: 1000 })
    expect(crossing.remainingBu).toBe(-800) // over — warn NOW
    // With a stale delivered figure (missing the last 1,000-bu session save),
    // the same load would have looked fine — the bug this seam pins against.
    const stale = contractProgress({ contractedBu: 10_000, deliveredBu: 8800, thisLoadBu: 1000 })
    expect(stale.remainingBu).toBeGreaterThan(0)
  })

  it('bar percentages clamp: delivered ≤ 100, this-load fits the leftover', () => {
    const p = contractProgress({ contractedBu: 1000, deliveredBu: 950, thisLoadBu: 200 })
    expect(p.pctDelivered).toBe(95)
    expect(p.pctThisLoad).toBe(5)
    const over = contractProgress({ contractedBu: 1000, deliveredBu: 1200, thisLoadBu: 100 })
    expect(over.pctDelivered).toBe(100)
    expect(over.pctThisLoad).toBe(0)
  })

  it('no contracted total → zeroed percentages, no NaN', () => {
    const p = contractProgress({ contractedBu: 0, deliveredBu: 100, thisLoadBu: 10 })
    expect(p.pctDelivered).toBe(0)
    expect(p.pctThisLoad).toBe(0)
    expect(p.remainingBu).toBe(-110)
  })
})
