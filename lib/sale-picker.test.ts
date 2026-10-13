import { describe, expect, it } from 'vitest'
import {
  choiceOfRow, choiceToValue, contractOptionLabel, isContractOpen, overfillFor, overfillPromptText, overfillRows,
  parseChoiceValue, partitionContracts, remainingBushels, rowsToSplitDraft, splitDraftError, splitDraftToRows, splitRemainder,
  type SplitDraftRow,
} from '@/lib/sale-picker'

// The sale picker's pure parts (094): option wording, the overfill prompt
// sentence and split, and the split rows' remainder math.

const A = { id: 'A', contract_number: '2002960604-10', contracted_bushels: 45000, completed_at: null }
const B = { id: 'B', contract_number: '2002960605-10', contracted_bushels: 10000, completed_at: null }
const DONE = { id: 'D', contract_number: '2002960000-10', contracted_bushels: 5000, completed_at: '2026-09-01' }

describe('choice values', () => {
  it('round-trips the three kinds and nothing', () => {
    expect(choiceToValue({ kind: 'contract', contractId: 'A' })).toBe('contract:A')
    expect(parseChoiceValue('contract:A')).toEqual({ kind: 'contract', contractId: 'A' })
    expect(parseChoiceValue('spot')).toEqual({ kind: 'spot' })
    expect(parseChoiceValue('price_later')).toEqual({ kind: 'price_later' })
    expect(parseChoiceValue('')).toBeNull()
    expect(parseChoiceValue('contract:')).toBeNull()
    expect(choiceToValue(null)).toBe('')
  })
  it('reads the choice off a sale row', () => {
    expect(choiceOfRow({ sale_type: 'contract', contract_id: 'A' })).toEqual({ kind: 'contract', contractId: 'A' })
    expect(choiceOfRow({ sale_type: 'spot', contract_id: null })).toEqual({ kind: 'spot' })
    expect(choiceOfRow(null)).toBeNull()
  })
})

describe('contract options', () => {
  it('"#number · contracted bu · N bu left" with commas', () => {
    expect(contractOptionLabel(A, 43766)).toBe('#2002960604-10 · 45,000 bu · 1,234 bu left')
  })
  it('a filled or marked-complete contract reads "complete"', () => {
    expect(contractOptionLabel(A, 45000)).toBe('#2002960604-10 · 45,000 bu · complete')
    expect(contractOptionLabel(DONE, 0)).toBe('#2002960000-10 · 5,000 bu · complete')
    expect(isContractOpen(A, 44999.5)).toBe(true)
    expect(isContractOpen(A, 45000)).toBe(false)
    expect(isContractOpen(DONE, 0)).toBe(false)
  })
  it('remaining never goes negative', () => {
    expect(remainingBushels(1000, 1200)).toBe(0)
    expect(remainingBushels(1000, 300)).toBe(700)
  })
  it('open contracts first, completed after, order kept within each', () => {
    const { open, completed } = partitionContracts([DONE, A, B], new Map([['A', 100], ['B', 10000]]))
    expect(open.map((c) => c.id)).toEqual(['A'])
    expect(completed.map((c) => c.id)).toEqual(['D', 'B'])
  })
})

describe('overfill', () => {
  it('the prompt sentence', () => {
    expect(overfillPromptText('2002960604-10', 58.284, 912.744)).toBe('Contract 2002960604-10 has 58 bu left. Send the other 913 bu to:')
  })
  it('fires only when the load is bigger than what is left (and both are known)', () => {
    expect(overfillFor(971, 45000, 44941.716)).toEqual({ remaining: expect.closeTo(58.284, 3), overflow: expect.closeTo(912.716, 3) })
    expect(overfillFor(500, 45000, 44000)).toBeNull()
    expect(overfillFor(0, 45000, 44000)).toBeNull()
    expect(overfillFor(500, 45000, 45000)).toBeNull() // complete: picked on purpose
  })
  it('a 1,000 bu load onto a contract with 300 left → 300 / 700, shares .3 / .7', () => {
    const rows = overfillRows(1000, 300, 'A', { kind: 'spot' })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ sale_type: 'contract', contract_id: 'A', share: 0.3 })
    expect(rows[1]).toMatchObject({ sale_type: 'spot', contract_id: null, share: 0.7 })
    expect(rows[0].share + rows[1].share).toBe(1)
  })
  it('the overflow can go to another contract or price later', () => {
    expect(overfillRows(1000, 300, 'A', { kind: 'contract', contractId: 'B' })[1]).toMatchObject({ sale_type: 'contract', contract_id: 'B', share: 0.7 })
    expect(overfillRows(1000, 300, 'A', { kind: 'price_later' })[1]).toMatchObject({ sale_type: 'price_later', share: 0.7 })
  })
})

describe('split rows', () => {
  const rows: SplitDraftRow[] = [
    { choice: { kind: 'contract', contractId: 'A' }, bushels: '58', bid: '' },
    { choice: { kind: 'spot' }, bushels: '', bid: '13.74' },
  ]
  it('the last row takes the remainder', () => {
    expect(splitRemainder(rows, 971)).toBe(913)
    expect(splitRemainder([{ bushels: '100' }, { bushels: '200' }, { bushels: '999' }], 1000)).toBe(700)
  })
  it('builds rows whose shares sum to exactly 1, with the spot bid as an entered price', () => {
    const out = splitDraftToRows(rows, 971)
    expect(out[0]).toMatchObject({ sale_type: 'contract', contract_id: 'A' })
    expect(out[0].share).toBeCloseTo(58 / 971, 9)
    expect(out[1]).toMatchObject({ sale_type: 'spot', spot_price: 13.74, spot_price_source: 'entered' })
    expect(out[0].share + out[1].share).toBe(1)
    expect(splitDraftError(rows, 971)).toBeNull()
  })
  it('names what is missing before it can save', () => {
    expect(splitDraftError(rows, 0)).toMatch(/weight first/)
    expect(splitDraftError([rows[0], { choice: null, bushels: '', bid: '' }], 971)).toBe('Pick a sale for every part of the load.')
    expect(splitDraftError([{ ...rows[0], bushels: '' }, rows[1]], 971)).toBe('Every part of the load needs bushels.')
    expect(splitDraftError([{ ...rows[0], bushels: '1000' }, rows[1]], 971)).toMatch(/more than the load/)
    expect(splitDraftError([rows[0], { ...rows[1], choice: { kind: 'contract', contractId: 'A' } }], 971)).toBe('The same sale appears twice — combine those parts.')
    expect(splitDraftError([rows[0]], 971)).toBe('A split needs at least two parts.')
  })
  it('saved rows come back as editable rows with bushels = share × the load', () => {
    const draft = rowsToSplitDraft(splitDraftToRows(rows, 971), 971)
    expect(draft[0]).toEqual({ choice: { kind: 'contract', contractId: 'A' }, bushels: '58', bid: '' })
    expect(draft[1]).toEqual({ choice: { kind: 'spot' }, bushels: '913', bid: '13.74' })
    // A single row pads to two so the split editor always has a second part.
    expect(rowsToSplitDraft([{ sale_type: 'spot', share: 1 }], 500)).toHaveLength(2)
  })
})
