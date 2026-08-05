import { describe, it, expect } from 'vitest'
import { roleAllowsPath, roleHome } from '@/lib/route-guard'

// The role → route matrix behind the middleware redirect (052). The viewer is
// a read-only stakeholder: home tiles, Yields, every /reports page, logout,
// and the read-only price-lookup APIs — nothing else. Gin keeps its Cotton
// intake surface. Owners go everywhere.

describe('roleAllowsPath', () => {
  it('owner: everything', () => {
    for (const p of ['/', '/loads', '/settings/users', '/cotton/marketing', '/reports/marketing', '/api/parse-document']) {
      expect(roleAllowsPath('owner', p)).toBe(true)
    }
  })

  it('gin: cotton intake only (not marketing), plus logout and doc parsing', () => {
    expect(roleAllowsPath('gin', '/cotton/loads')).toBe(true)
    expect(roleAllowsPath('gin', '/cotton')).toBe(true)
    expect(roleAllowsPath('gin', '/cotton/marketing')).toBe(false)
    expect(roleAllowsPath('gin', '/logout')).toBe(true)
    expect(roleAllowsPath('gin', '/api/parse-document')).toBe(true)
    for (const p of ['/', '/loads', '/reports', '/yields', '/settings']) {
      expect(roleAllowsPath('gin', p)).toBe(false)
    }
  })

  it('viewer: home, Yields, all of Reports, logout', () => {
    for (const p of ['/', '/yields', '/reports', '/reports/marketing', '/reports/crop-insurance-claims', '/reports/season', '/logout']) {
      expect(roleAllowsPath('viewer', p)).toBe(true)
    }
  })

  it('viewer: every operational/settings/cotton/hedging path is denied', () => {
    for (const p of [
      '/loads', '/loads/new', '/loads/unpaid', '/inventory', '/contracts', '/settlements',
      '/hedging', '/settings', '/settings/users', '/cotton', '/cotton/loads', '/cotton/marketing',
      '/revenue-projections', '/api/parse-document',
    ]) {
      expect(roleAllowsPath('viewer', p)).toBe(false)
    }
  })

  it('viewer: only the read-only price-lookup APIs the reports call', () => {
    for (const p of ['/api/market-prices', '/api/harvest-price-estimate', '/api/mya-estimate', '/api/nass-monthly-prices', '/api/mya-monthly-lookup']) {
      expect(roleAllowsPath('viewer', p)).toBe(true)
    }
    expect(roleAllowsPath('viewer', '/api/options-prices')).toBe(false)
    expect(roleAllowsPath('viewer', '/api/awp-lookup')).toBe(false)
  })

  it('prefix matching respects path boundaries', () => {
    expect(roleAllowsPath('viewer', '/yieldsX')).toBe(false)
    expect(roleAllowsPath('viewer', '/reportsX')).toBe(false)
    expect(roleAllowsPath('viewer', '/reports/anything/nested')).toBe(true)
  })
})

describe('roleHome', () => {
  it('sends each role to its landing page', () => {
    expect(roleHome('owner')).toBe('/')
    expect(roleHome('gin')).toBe('/cotton/loads')
    expect(roleHome('viewer')).toBe('/reports')
  })
})
