import { describe, expect, it } from 'vitest'
import {
  buildPaidIndex, duplicateVerdict, findDuplicateSettlement, paidRefFor, paidRefLabel,
  type ExistingLine, type ExistingSettlement,
} from './settlement-duplicates'

const S1: ExistingSettlement = { id: 's1', buyer_id: 'bunge', settlement_date: '2026-09-14', settlement_number: 'SET-000123', check_number: '77801', payment_number: null }
const S2: ExistingSettlement = { id: 's2', buyer_id: 'adm', settlement_date: '2026-09-20', settlement_number: '123', check_number: null, payment_number: 'P-9' }
const LINES: ExistingLine[] = [
  { settlement_id: 's1', load_id: 'L1', ticket_number: '4401' },
  { settlement_id: 's1', load_id: null, ticket_number: '4402' },
  { settlement_id: 's2', load_id: 'L9', ticket_number: '4401' },
]

describe('findDuplicateSettlement', () => {
  it('matches the same buyer on the settlement number, ignoring prefixes and leading zeros', () => {
    const hit = findDuplicateSettlement({ buyerId: 'bunge', settlementNumber: '123' }, [S1, S2])
    expect(hit?.settlement.id).toBe('s1')
    expect(hit?.matchedOn).toBe('settlement number')
  })

  it('never matches another buyer once a buyer is picked', () => {
    expect(findDuplicateSettlement({ buyerId: 'cargill', settlementNumber: '123' }, [S1, S2])).toBeNull()
  })

  it('warns before the buyer is picked when the number is already saved', () => {
    expect(findDuplicateSettlement({ buyerId: null, settlementNumber: 'SET-123' }, [S1, S2])?.settlement.id).toBe('s1')
  })

  it('falls back to the check number and then the payment number', () => {
    expect(findDuplicateSettlement({ buyerId: 'bunge', settlementNumber: '999', checkNumber: '077801' }, [S1, S2])?.matchedOn).toBe('check number')
    expect(findDuplicateSettlement({ buyerId: 'adm', settlementNumber: null, paymentNumber: 'P-9' }, [S1, S2])?.matchedOn).toBe('payment number')
  })

  it('an empty number is never a match', () => {
    expect(findDuplicateSettlement({ buyerId: 'bunge', settlementNumber: '' }, [S1, S2])).toBeNull()
    expect(findDuplicateSettlement({ buyerId: 'bunge', settlementNumber: null }, [{ ...S1, settlement_number: null }])).toBeNull()
  })
})

describe('paidRefFor', () => {
  const index = buildPaidIndex(LINES, [S1, S2])

  it('finds a paid load by id regardless of buyer', () => {
    expect(paidRefFor({ loadId: 'L1', ticketNumber: null, buyerId: null }, index)?.settlementId).toBe('s1')
  })

  it('finds a paid ticket only for the same buyer', () => {
    expect(paidRefFor({ loadId: null, ticketNumber: '4402', buyerId: 'bunge' }, index)?.settlementId).toBe('s1')
    expect(paidRefFor({ loadId: null, ticketNumber: '4402', buyerId: 'adm' }, index)).toBeNull()
    expect(paidRefFor({ loadId: null, ticketNumber: '4402', buyerId: null }, index)).toBeNull()
  })

  it('a ticket shared by two buyers resolves to the right one', () => {
    expect(paidRefFor({ loadId: null, ticketNumber: '4401', buyerId: 'adm' }, index)?.settlementId).toBe('s2')
    expect(paidRefFor({ loadId: null, ticketNumber: '04401', buyerId: 'bunge' }, index)?.settlementId).toBe('s1')
  })

  it('ignores lines whose settlement is unknown', () => {
    const idx = buildPaidIndex([{ settlement_id: 'ghost', load_id: 'L5', ticket_number: '1' }], [S1])
    expect(paidRefFor({ loadId: 'L5', ticketNumber: '1', buyerId: 'bunge' }, idx)).toBeNull()
  })
})

describe('duplicateVerdict', () => {
  const ref = { settlementId: 's1', settlementNumber: 'SET-000123', settlementDate: '2026-09-14', buyerId: 'bunge' }

  it('calls the whole statement repeated when every counted line is on one saved settlement', () => {
    const v = duplicateVerdict([{ excluded: false, paid: ref }, { excluded: false, paid: ref }, { excluded: true, paid: null }])
    expect(v).toMatchObject({ included: 2, paid: 2, wholeStatementRepeated: true })
    expect(v.settlements).toHaveLength(1)
  })

  it('counts a partial repeat without calling it the whole statement', () => {
    const v = duplicateVerdict([{ excluded: false, paid: ref }, { excluded: false, paid: null }])
    expect(v).toMatchObject({ included: 2, paid: 1, wholeStatementRepeated: false })
  })

  it('two different saved settlements are not one repeated statement', () => {
    const other = { ...ref, settlementId: 's2' }
    const v = duplicateVerdict([{ excluded: false, paid: ref }, { excluded: false, paid: other }])
    expect(v.wholeStatementRepeated).toBe(false)
    expect(v.settlements.map((s) => s.settlementId)).toEqual(['s1', 's2'])
  })

  it('labels a settlement with or without a number', () => {
    const d = (iso: string) => iso
    expect(paidRefLabel(ref, d)).toBe('#SET-000123 (2026-09-14)')
    expect(paidRefLabel({ settlementNumber: null, settlementDate: '2026-09-14' }, d)).toBe('without a number (2026-09-14)')
  })
})
