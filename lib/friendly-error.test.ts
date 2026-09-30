import { describe, it, expect } from 'vitest'
import { friendlyError, isConnectionError } from './friendly-error'

describe('friendlyError', () => {
  it('never echoes the raw database message', () => {
    const raw = 'duplicate key value violates unique constraint "trucks_org_id_name_key"'
    const out = friendlyError({ code: '23505', message: raw }, { noun: 'truck', name: 'KB Wild' })
    expect(out).toBe('A truck named “KB Wild” already exists.')
    expect(out).not.toContain('constraint')
  })

  it('maps a duplicate without a name to a generic sentence', () => {
    expect(friendlyError({ code: '23505', message: 'x' }, { noun: 'buyer' })).toContain('already exists')
  })

  it('maps a foreign-key delete failure to "still in use"', () => {
    const out = friendlyError({ code: '23503', message: 'update or delete on table "crops" violates foreign key constraint' }, { noun: 'crop' })
    expect(out).toContain("can't be deleted")
    expect(out).not.toContain('foreign key')
  })

  it('maps RLS / permission failures', () => {
    expect(friendlyError({ code: '42501', message: 'new row violates row-level security policy for table "loads"' })).toContain("don't have permission")
    expect(friendlyError({ message: 'permission denied for table loads' })).toContain("don't have permission")
  })

  it('maps a missing column or table to the not-set-up sentence', () => {
    expect(friendlyError({ code: '42703', message: 'column loads.foo does not exist' })).toContain('contact support')
    expect(friendlyError({ message: "Could not find the 'bar' column of 'loads' in the schema cache" })).toContain('contact support')
  })

  it('maps connection failures and keeps the typing', () => {
    expect(isConnectionError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isConnectionError({ name: 'AbortError', message: 'The user aborted a request.' } as Error)).toBe(true)
    expect(friendlyError(new TypeError('Failed to fetch'))).toContain('still here')
    expect(isConnectionError({ code: '23505', message: 'dup' })).toBe(false)
  })

  it('maps the auth wording', () => {
    expect(friendlyError({ message: 'Invalid login credentials' })).toBe("That email and password don't match.")
  })

  it('falls back to the action sentence', () => {
    const out = friendlyError({ message: 'something odd' }, { action: 'save this load' })
    expect(out).toContain("couldn't save this load")
    expect(out).toContain('contact support')
    expect(out).not.toContain('something odd')
  })

  it('tolerates null, strings and plain Errors', () => {
    expect(friendlyError(null)).toContain("couldn't save")
    expect(friendlyError('boom')).toContain("couldn't save")
    expect(friendlyError(new Error('boom'))).toContain("couldn't save")
  })
})
