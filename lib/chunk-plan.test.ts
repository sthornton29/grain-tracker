import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGES_PER_BATCH,
  DENSITY,
  expectedOutputTokens,
  outputBudget,
  planChunks,
  planPagesPerBatch,
  rangeLabel,
} from '@/lib/chunk-plan'

// Measured 2026-10-13 (claude-sonnet-4-6, max_tokens 8192, the old verbose
// settlement shape): ≈235 output tokens a ticket + ≈500 fixed; 6 Woodall
// pages (81 tickets) hit max_tokens. The trimmed shape (nulls omitted, block
// constants once) is planned at 130 a ticket.

describe('planPagesPerBatch — conservative defaults (no text layer)', () => {
  it('settlement: 14 rows a page at 130 tokens → 2 pages under 60% of 8192', () => {
    // (4915 − 500) / (130 × 14 = 1820) = 2.43 → 2
    expect(planPagesPerBatch({ documentType: 'settlement', maxTokens: 8192 })).toBe(2)
  })

  it('gin receipt: 45 bales a page at 25 + 300 a page → 3 pages', () => {
    // 4915 / (25 × 45 + 300 = 1425) = 3.45 → 3
    expect(planPagesPerBatch({ documentType: 'gin_receipt', maxTokens: 8192 })).toBe(3)
  })

  it('brokerage: 20 rows a page at 130 → 1 page (the measured StoneX statement is far lighter — see the report)', () => {
    // (4915 − 300) / 2600 = 1.77 → 1
    expect(planPagesPerBatch({ documentType: 'brokerage_statement', maxTokens: 8192 })).toBe(1)
    // With a measured 7 rows a page (≈560 tokens a page on the 10/12 statement) → 5.
    expect(planPagesPerBatch({ documentType: 'brokerage_statement', maxTokens: 8192, rowsPerPage: 7 })).toBe(5)
  })

  it('cotton weight tickets (one load a page) and tickets (4 a page) clamp at 6', () => {
    expect(planPagesPerBatch({ documentType: 'cotton_weight_ticket', maxTokens: 8192 })).toBe(6)
    expect(planPagesPerBatch({ documentType: 'tickets', maxTokens: 8192 })).toBe(6)
  })

  it('clamps to 1..6 and keeps the legacy 6 for types without a profile', () => {
    expect(planPagesPerBatch({ documentType: 'settlement', maxTokens: 1024 })).toBe(1)
    expect(planPagesPerBatch({ documentType: 'settlement', maxTokens: 24000 })).toBe(6)
    expect(planPagesPerBatch({ documentType: 'contract', maxTokens: 8192 })).toBe(DEFAULT_PAGES_PER_BATCH)
    expect(planPagesPerBatch({ documentType: 'cotton_marketing_document', maxTokens: 8192 })).toBe(6)
  })

  it('a bigger cap after a truncation allows more pages', () => {
    // (0.6 × 16384 = 9830 − 500) / 1820 = 5.1 → 5
    expect(planPagesPerBatch({ documentType: 'settlement', maxTokens: 16384 })).toBe(5)
  })
})

describe('expectedOutputTokens — the Woodall density', () => {
  it('a 2-page chunk of 14-row pages expects 4,140 tokens: under 60% of 8192; a 6-page chunk would not', () => {
    const two = expectedOutputTokens({ documentType: 'settlement', maxTokens: 8192, rowsByPage: [14, 14] })
    const six = expectedOutputTokens({ documentType: 'settlement', maxTokens: 8192, rowsByPage: [14, 14, 14, 14, 14, 14] })
    expect(two).toBe(500 + 28 * 130)
    expect(two).toBeLessThan(outputBudget(8192))
    expect(outputBudget(8192)).toBe(4915)
    expect(six).toBe(500 + 84 * 130)
    expect(six).toBeGreaterThan(outputBudget(8192))
    expect(six).toBeGreaterThan(8192)
  })

  it('counts per-page tokens for gin receipts and nothing for unknown types', () => {
    expect(expectedOutputTokens({ documentType: 'gin_receipt', maxTokens: 8192, rowsByPage: [45, 10] })).toBe(2 * 300 + 55 * 25)
    expect(expectedOutputTokens({ documentType: 'contract', maxTokens: 8192, rowsByPage: [1] })).toBe(0)
  })
})

describe('planChunks', () => {
  it('without counts: fixed batches of the plan (settlement 8 pages → 2,2,2,2)', () => {
    expect(planChunks({ documentType: 'settlement', maxTokens: 8192, from: 1, to: 8 })).toEqual([
      { from: 1, to: 2 }, { from: 3, to: 4 }, { from: 5, to: 6 }, { from: 7, to: 8 },
    ])
  })

  it('without counts: an explicit maxPages is the batch size (the legacy 6)', () => {
    expect(planChunks({ documentType: 'settlement', maxTokens: 8192, from: 1, to: 8, maxPages: 6 })).toEqual([
      { from: 1, to: 6 }, { from: 7, to: 8 },
    ])
  })

  it('with the Woodall 77232 counts (11/14/14/14/14/14/13/0): greedy 2-page chunks, the summary page rides with page 7', () => {
    const rows = [11, 14, 14, 14, 14, 14, 13, 0]
    const chunks = planChunks({ documentType: 'settlement', maxTokens: 8192, from: 1, to: 8, rowsByPage: rows })
    expect(chunks).toEqual([{ from: 1, to: 2 }, { from: 3, to: 4 }, { from: 5, to: 6 }, { from: 7, to: 8 }])
    for (const c of chunks) {
      const exp = expectedOutputTokens({ documentType: 'settlement', maxTokens: 8192, rowsByPage: rows.slice(c.from - 1, c.to) })
      expect(exp).toBeLessThanOrEqual(outputBudget(8192))
    }
  })

  it('with counts: light pages pack up to the cap, a page that alone exceeds the budget still gets its own chunk', () => {
    expect(planChunks({ documentType: 'settlement', maxTokens: 8192, from: 1, to: 9, rowsByPage: [2, 2, 2, 2, 2, 2, 2, 2, 2] })).toEqual([
      { from: 1, to: 6 }, { from: 7, to: 9 },
    ])
    expect(planChunks({ documentType: 'settlement', maxTokens: 8192, from: 1, to: 3, rowsByPage: [60, 1, 1] })).toEqual([
      { from: 1, to: 1 }, { from: 2, to: 3 },
    ])
  })

  it('plans a sub-range (the re-read path) and an empty range', () => {
    expect(planChunks({ documentType: 'settlement', maxTokens: 8192, from: 5, to: 8, rowsByPage: [11, 14, 14, 14, 14, 14, 13, 0] })).toEqual([
      { from: 5, to: 6 }, { from: 7, to: 8 },
    ])
    expect(planChunks({ documentType: 'settlement', maxTokens: 8192, from: 3, to: 2 })).toEqual([])
  })

  it('rangeLabel and the profile table', () => {
    expect(rangeLabel({ from: 1, to: 6 })).toBe('1–6')
    expect(rangeLabel({ from: 8, to: 8 })).toBe('8')
    expect(DENSITY.settlement).toEqual({ tokensPerItem: 130, perPage: 0, fixed: 500, defaultRowsPerPage: 14 })
  })
})
