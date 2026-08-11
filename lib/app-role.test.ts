import { describe, it, expect } from 'vitest'
import { coerceAppRole, roleCanEditYields } from '@/lib/app-role'

describe('coerceAppRole', () => {
  it('passes the known roles through', () => {
    expect(coerceAppRole('owner')).toBe('owner')
    expect(coerceAppRole('gin')).toBe('gin')
    expect(coerceAppRole('viewer')).toBe('viewer')
    expect(coerceAppRole('agronomist')).toBe('agronomist')
  })

  it('anything unknown (or missing) is owner — the 042 backward-compatible default', () => {
    expect(coerceAppRole(null)).toBe('owner')
    expect(coerceAppRole(undefined)).toBe('owner')
    expect(coerceAppRole('')).toBe('owner')
    expect(coerceAppRole('admin')).toBe('owner')
  })
})

describe('roleCanEditYields', () => {
  // The Yields write functions (irr/dry breakouts, per-variety allocations,
  // "count anyway" overrides) call this before touching Supabase; the
  // 052/061 RESTRICTIVE RLS write-blocks enforce the same thing server-side.
  it('owners may edit', () => {
    expect(roleCanEditYields('owner')).toBe(true)
  })

  it('viewers and agronomists are rejected (and gin, which cannot even reach the page)', () => {
    expect(roleCanEditYields('viewer')).toBe(false)
    expect(roleCanEditYields('agronomist')).toBe(false)
    expect(roleCanEditYields('gin')).toBe(false)
  })
})
