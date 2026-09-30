import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONTRACT_FILTERS, activeContractFilterCount, hasAnyContractFilterParam,
  parseContractFilters, savedContractFilters, serializeContractFilters,
} from './contract-filters'

describe('contract filters — one definition of the query string', () => {
  it('round-trips every filter through serialize → parse', () => {
    const v = { entity: 'e1', crop: 'c1', crop_year: '2026', type: 'hta', pricing: 'awaiting_basis', hide_completed: true, hide_future: true, sort: 'crop', dir: 'desc' as const }
    expect(parseContractFilters(new URLSearchParams(serializeContractFilters(v)))).toEqual(v)
  })

  it('parses the server page\'s searchParams object the same as URLSearchParams', () => {
    const qs = 'crop_year=2026&type=forward&hide_completed=1'
    expect(parseContractFilters({ crop_year: '2026', type: 'forward', hide_completed: '1' })).toEqual(parseContractFilters(new URLSearchParams(qs)))
  })

  it('drops values that mean nothing instead of filtering to an empty table', () => {
    const v = parseContractFilters(new URLSearchParams('type=bogus&pricing=nope&crop_year=abc&sort=buyer&dir=sideways&hide_completed=yes'))
    expect(v).toEqual(EMPTY_CONTRACT_FILTERS)
  })

  it('serializes nothing when nothing is set, and never writes dir without sort', () => {
    expect(serializeContractFilters(EMPTY_CONTRACT_FILTERS)).toBe('')
    expect(serializeContractFilters({ ...EMPTY_CONTRACT_FILTERS, dir: 'desc' })).toBe('')
    expect(serializeContractFilters({ ...EMPTY_CONTRACT_FILTERS, sort: 'crop' })).toBe('sort=crop&dir=asc')
  })

  it('tells a bare arrival from an explicit "all" choice', () => {
    expect(hasAnyContractFilterParam({})).toBe(false)
    expect(hasAnyContractFilterParam({ crop: '' })).toBe(false)
    expect(hasAnyContractFilterParam({ crop: 'c1' })).toBe(true)
    expect(hasAnyContractFilterParam(new URLSearchParams('sort=crop'))).toBe(true)
    expect(hasAnyContractFilterParam(new URLSearchParams('all=1'))).toBe(true)
  })

  it('counts only the filters that narrow the list (sort is not one)', () => {
    expect(activeContractFilterCount(EMPTY_CONTRACT_FILTERS)).toBe(0)
    expect(activeContractFilterCount({ ...EMPTY_CONTRACT_FILTERS, crop: 'c', hide_future: true, sort: 'crop' })).toBe(2)
  })

  it('restores a cookie only when it yields valid filters', () => {
    expect(savedContractFilters(null)).toBeNull()
    expect(savedContractFilters('')).toBeNull()
    expect(savedContractFilters('type=bogus')).toBeNull()
    expect(savedContractFilters(encodeURIComponent('crop_year=2026&crop=c1'))).toBe('crop_year=2026&crop=c1')
    expect(savedContractFilters('crop_year=2026')).toBe('crop_year=2026')
  })
})
