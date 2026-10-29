import { describe, expect, it } from 'vitest'
import { farmsAsPayees, hasExplicitPayee, indexPayees, payeeEntityFor, payeeMismatches } from './program-payee'

const farms = [
  { id: 'f260', entity_id: 'tsf' },
  { id: 'f5563', entity_id: 'vcf' },
  { id: 'f-none', entity_id: null },
]
const payees = indexPayees([
  { farm_id: 'f260', program_year: 2025, entity_id: 'martin' },
  { farm_id: 'f5563', program_year: 2025, entity_id: 'martin' },
])

describe('payeeEntityFor — explicit row wins, else the farm entity', () => {
  it('program year 2025 is Martin Farm; 2026 stays on the farm entity', () => {
    expect(payeeEntityFor(farms[0], 2025, payees)).toBe('martin')
    expect(payeeEntityFor(farms[0], 2026, payees)).toBe('tsf')
    expect(payeeEntityFor(farms[1], 2025, payees)).toBe('martin')
    expect(payeeEntityFor(farms[1], 2026, payees)).toBe('vcf')
    expect(payeeEntityFor(farms[2], 2025, payees)).toBeNull()
    expect(payeeEntityFor(null, 2025, payees)).toBeNull()
  })
  it('accepts the raw rows too, and reports which years are explicit', () => {
    expect(payeeEntityFor(farms[0], 2025, [{ farm_id: 'f260', program_year: 2025, entity_id: 'x' }])).toBe('x')
    expect(hasExplicitPayee('f260', 2025, payees)).toBe(true)
    expect(hasExplicitPayee('f260', 2026, payees)).toBe(false)
    expect([...payees.years]).toEqual([2025])
  })
  it('farmsAsPayees re-keys the farms for the entity scope', () => {
    expect(farmsAsPayees(farms, 2025, payees).map((f) => f.entity_id)).toEqual(['martin', 'martin', null])
    expect(farmsAsPayees(farms, 2026, payees).map((f) => f.entity_id)).toEqual(['tsf', 'vcf', null])
  })
})

describe('payeeMismatches — the statement payee vs what Turnrow has', () => {
  it('lines for program year 2025 on farms whose payee is TSF / VCF raise the notice; nothing once the payee is set', () => {
    const lines = [
      { farm_id: 'f260', program_year: 2025 }, { farm_id: 'f260', program_year: 2025 },
      { farm_id: 'f5563', program_year: 2025 }, { farm_id: 'f-none', program_year: 2025 },
      { farm_id: null, program_year: 2025 }, { farm_id: 'f260', program_year: null },
    ]
    const before = payeeMismatches({ lines, statementEntityId: 'martin', farms, payees: indexPayees([]) })
    expect(before).toEqual([{ programYear: 2025, farmIds: ['f260', 'f5563', 'f-none'], turnrowEntityIds: ['tsf', 'vcf', null] }])
    const after = payeeMismatches({ lines, statementEntityId: 'martin', farms, payees })
    expect(after).toEqual([{ programYear: 2025, farmIds: ['f-none'], turnrowEntityIds: [null] }])
    expect(payeeMismatches({ lines, statementEntityId: null, farms, payees })).toEqual([])
  })
})
