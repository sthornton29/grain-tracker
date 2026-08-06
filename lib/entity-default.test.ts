import { describe, it, expect } from 'vitest'
import { defaultEntityId } from './entity-default'

describe('defaultEntityId — the single-entity auto-assign seam', () => {
  it('returns the only entity of a single-entity operation', () => {
    expect(defaultEntityId([{ id: 'E1' }])).toBe('E1')
  })

  it('returns null with zero entities (nothing to assign)', () => {
    expect(defaultEntityId([])).toBeNull()
    expect(defaultEntityId(null)).toBeNull()
    expect(defaultEntityId(undefined)).toBeNull()
  })

  it('returns null with two or more entities (explicit selection required)', () => {
    expect(defaultEntityId([{ id: 'E1' }, { id: 'E2' }])).toBeNull()
    expect(defaultEntityId([{ id: 'E1' }, { id: 'E2' }, { id: 'E3' }])).toBeNull()
  })

  it('reverts the moment a second entity exists — pure over the passed list, nothing cached', () => {
    const entities = [{ id: 'E1' }]
    expect(defaultEntityId(entities)).toBe('E1')
    entities.push({ id: 'E2' })
    expect(defaultEntityId(entities)).toBeNull()
    // and back, if one is deleted
    entities.pop()
    expect(defaultEntityId(entities)).toBe('E1')
  })
})
