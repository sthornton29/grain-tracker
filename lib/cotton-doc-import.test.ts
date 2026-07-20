import { describe, it, expect } from 'vitest'
import {
  normalizePbi, parseBaleNumberList, partitionBaleAssignment, baleConflictReason,
  type BaleForAssign,
} from '@/lib/cotton-doc-import'
import { dispositionBoard } from '@/lib/cotton-sales'
import type { CottonBale, CottonBaleDisposition, CottonDisposition } from '@/lib/types'

// ---------------------------------------------------------------------------
// parseBaleNumberList — headered CSVs, bare lists, dirty input
// ---------------------------------------------------------------------------

describe('parseBaleNumberList', () => {
  it('reads a headered CSV, using only the PBI column', () => {
    const csv = 'Farm,Field,Bale Wt,PBI\nHome,12,512,3210001\nHome,12,498,3210002\nHome,12,505,3210003\n'
    const r = parseBaleNumberList(csv)
    expect(r.usedHeaderColumn).toBe(true)
    expect(r.entries.map((e) => e.pbi)).toEqual(['3210001', '3210002', '3210003'])
  })

  it('never mistakes a "Bale Wt" column for the bale-number column', () => {
    const csv = 'Bale Wt,Bale #\n512,3210001\n498,3210002\n'
    const r = parseBaleNumberList(csv)
    expect(r.entries.map((e) => e.pbi)).toEqual(['3210001', '3210002'])
  })

  it('reads a bare list — one number per line, blank lines and stray spaces tolerated', () => {
    const r = parseBaleNumberList('  3210001 \n\n3210002\r\n 3210003\n')
    expect(r.usedHeaderColumn).toBe(false)
    expect(r.entries.map((e) => e.pbi)).toEqual(['3210001', '3210002', '3210003'])
  })

  it('reads a single headered column ("PBI" then values)', () => {
    const r = parseBaleNumberList('PBI\n0003210001\n3210002\n')
    expect(r.usedHeaderColumn).toBe(true)
    // Leading zeros normalize away.
    expect(r.entries.map((e) => e.pbi)).toEqual(['3210001', '3210002'])
  })

  it('folds duplicate rows and counts them', () => {
    const r = parseBaleNumberList('3210001\n3210002\n3210001\n0003210002\n')
    expect(r.entries.map((e) => e.pbi)).toEqual(['3210001', '3210002'])
    expect(r.duplicateCount).toBe(2)
  })

  it('handles dirty tokens ("PBI# 0123456") and skips short numerics like row indices', () => {
    const r = parseBaleNumberList('1, PBI# 0123456\n2, 0123457\n')
    // Row indices 1 and 2 (fewer than 4 digits) are not bale numbers.
    expect(r.entries.map((e) => e.pbi)).toEqual(['123456', '123457'])
  })

  it('empty input → empty result', () => {
    expect(parseBaleNumberList('')).toEqual({ entries: [], duplicateCount: 0, usedHeaderColumn: false })
  })
})

describe('normalizePbi', () => {
  it('digits only, leading zeros ignored', () => {
    expect(normalizePbi(' 000123456 ')).toBe('123456')
    expect(normalizePbi('PBI-123456')).toBe('123456')
    expect(normalizePbi('no digits')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// partitionBaleAssignment — matched / conflicts / unmatched with the loan⊕LDP
// mutual exclusion and disposition state
// ---------------------------------------------------------------------------

const mkBale = (id: string, pbi: string, lbs = 500): BaleForAssign => ({ id, pbi_number: pbi, net_weight_lbs: lbs })

const BALES: BaleForAssign[] = [
  mkBale('b1', '1000001', 510),
  mkBale('b2', '1000002', 490),
  mkBale('b3', '1000003', 505), // sold spot
  mkBale('b4', '1000004', 500), // on a loan (disposition ccc_loan)
  mkBale('b5', '1000005', 495), // took an LDP, still held
  mkBale('b6', '0001000006', 505), // stored with leading zeros
]
const DISPOSITIONS = new Map<string, CottonDisposition>([
  ['b3', 'sold_spot'],
  ['b4', 'ccc_loan'],
])
const LOANED = new Set(['b4'])
const LDPD = new Set(['b5'])

const baseInput = {
  bales: BALES, dispositionByBale: DISPOSITIONS, loanedBaleIds: LOANED, ldpBaleIds: LDPD,
}

describe('partitionBaleAssignment', () => {
  it('loan target: clean held bales match; loaned, LDP’d, and sold bales conflict with reasons; unknown numbers are unmatched verbatim', () => {
    const p = partitionBaleAssignment({
      ...baseInput,
      tokens: ['1000001', '1000002', '1000003', '1000004', '1000005', '9999999'],
      target: 'loan',
    })
    expect(p.matched.map((m) => m.baleId)).toEqual(['b1', 'b2'])
    expect(p.matchedLbs).toBe(1000)
    expect(p.matchedCount).toBe(2)
    const reasonBy = new Map(p.conflicts.map((c) => [c.baleId, c.reason]))
    expect(reasonBy.get('b3')).toMatch(/sold/)
    expect(reasonBy.get('b4')).toMatch(/pledged|loan/)
    expect(reasonBy.get('b5')).toMatch(/LDP.*loan-ineligible/)
    expect(p.unmatched).toEqual(['9999999'])
  })

  it('ldp target: the exclusion runs the other way', () => {
    const p = partitionBaleAssignment({
      ...baseInput,
      tokens: ['1000001', '1000004', '1000005'],
      target: 'ldp',
    })
    expect(p.matched.map((m) => m.baleId)).toEqual(['b1'])
    const reasonBy = new Map(p.conflicts.map((c) => [c.baleId, c.reason]))
    expect(reasonBy.get('b4')).toMatch(/LDP-ineligible/)
    expect(reasonBy.get('b5')).toMatch(/already took an LDP/)
  })

  it('contract target: LDP’d-but-held bales ARE deliverable; in-loan and sold bales are not', () => {
    const p = partitionBaleAssignment({
      ...baseInput,
      tokens: ['1000001', '1000003', '1000004', '1000005'],
      target: 'contract',
    })
    expect(p.matched.map((m) => m.baleId)).toEqual(['b1', 'b5'])
    const reasonBy = new Map(p.conflicts.map((c) => [c.baleId, c.reason]))
    expect(reasonBy.get('b3')).toMatch(/sold/)
    expect(reasonBy.get('b4')).toMatch(/CCC loan/)
  })

  it('matches with leading zeros ignored on both sides and folds duplicate tokens', () => {
    const p = partitionBaleAssignment({
      ...baseInput,
      tokens: ['0001000001', '1000001', '1000006'],
      target: 'loan',
    })
    expect(p.matched.map((m) => m.baleId)).toEqual(['b1', 'b6'])
  })
})

describe('baleConflictReason', () => {
  it('a held, never-programmed bale is clean for every target', () => {
    for (const target of ['loan', 'ldp', 'contract'] as const) {
      expect(baleConflictReason({ disposition: 'held', everLoaned: false, tookLdp: false, target })).toBeNull()
    }
  })
  it('a redeemed-loan bale (held again, junction row permanent) cannot re-enter a loan or take an LDP but can be delivered', () => {
    expect(baleConflictReason({ disposition: 'held', everLoaned: true, tookLdp: false, target: 'loan' })).toMatch(/pledged/)
    expect(baleConflictReason({ disposition: 'held', everLoaned: true, tookLdp: false, target: 'ldp' })).toMatch(/LDP-ineligible/)
    expect(baleConflictReason({ disposition: 'held', everLoaned: true, tookLdp: false, target: 'contract' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Batch assignment conserves the disposition board — bales move between
// buckets, never appear or vanish
// ---------------------------------------------------------------------------

describe('batch assignment conservation on the disposition board', () => {
  const asCottonBale = (b: BaleForAssign): CottonBale => ({
    id: b.id, gin_receipt_id: 'r1', crop_year: 2026, pbi_number: String(b.pbi_number),
    net_weight_lbs: Number(b.net_weight_lbs), created_at: '',
  } as CottonBale)
  const asDispositionRows = (m: Map<string, CottonDisposition>): CottonBaleDisposition[] =>
    [...m].map(([bale_id, disposition], i) => ({
      id: `d${i}`, bale_id, disposition, contract_id: null, loan_id: null, disposition_date: null, created_at: '',
    } as CottonBaleDisposition))

  it('assigning the clean matches to a loan moves exactly those bales held → ccc_loan', () => {
    const cottonBales = BALES.map(asCottonBale)
    const before = dispositionBoard(cottonBales, asDispositionRows(DISPOSITIONS))

    const p = partitionBaleAssignment({
      ...baseInput,
      tokens: BALES.map((b) => String(b.pbi_number)),
      target: 'loan',
    })
    // Simulate the one confirmed batch: upsert a ccc_loan disposition per match.
    const after = new Map(DISPOSITIONS)
    for (const m of p.matched) after.set(m.baleId, 'ccc_loan')
    const boardAfter = dispositionBoard(cottonBales, asDispositionRows(after))

    // Conservation: totals unchanged.
    expect(boardAfter.totalBales).toBe(before.totalBales)
    expect(boardAfter.totalLbs).toBeCloseTo(before.totalLbs, 6)
    // Movement: exactly the matched bales left Held for the loan bucket.
    expect(boardAfter.byDisposition.held.bales).toBe(before.byDisposition.held.bales - p.matchedCount)
    expect(boardAfter.byDisposition.ccc_loan.bales).toBe(before.byDisposition.ccc_loan.bales + p.matchedCount)
    expect(boardAfter.byDisposition.ccc_loan.lbs).toBeCloseTo(before.byDisposition.ccc_loan.lbs + p.matchedLbs, 6)
    // Untouched buckets stay put.
    expect(boardAfter.byDisposition.sold_spot).toEqual(before.byDisposition.sold_spot)
  })
})
