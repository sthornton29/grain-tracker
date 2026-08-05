import { describe, it, expect } from 'vitest'
import { navLinksFor, navLinkActive, GRAIN_LINKS, COTTON_TAB } from '@/lib/nav-links'

// navLinksFor is the single source of truth for BOTH the top nav and the
// landing tiles — this matrix locks in each role's exact link set.

describe('navLinksFor', () => {
  it('owner without cotton: the 9 grain links', () => {
    expect(navLinksFor({ cottonEnabled: false, role: 'owner' })).toEqual(GRAIN_LINKS)
  })

  it('owner with cotton: Cotton tab inserted right after Hedging', () => {
    const links = navLinksFor({ cottonEnabled: true, role: 'owner' })
    const labels = links.map((l) => l.label)
    expect(labels[labels.indexOf('Hedging') + 1]).toBe('Cotton')
    expect(links).toHaveLength(GRAIN_LINKS.length + 1)
  })

  it('gin: ONLY the Cotton tab', () => {
    expect(navLinksFor({ cottonEnabled: true, role: 'gin' })).toEqual([COTTON_TAB])
    expect(navLinksFor({ cottonEnabled: false, role: 'gin' })).toEqual([COTTON_TAB])
  })

  it('viewer: ONLY Yields and Reports, cotton module or not', () => {
    for (const cottonEnabled of [true, false]) {
      expect(navLinksFor({ cottonEnabled, role: 'viewer' }).map((l) => l.label)).toEqual(['Yields', 'Reports'])
    }
  })
})

describe('navLinkActive', () => {
  it('matches exact and nested paths, and Cotton by prefix', () => {
    const reports = GRAIN_LINKS.find((l) => l.label === 'Reports')!
    expect(navLinkActive(reports, '/reports')).toBe(true)
    expect(navLinkActive(reports, '/reports/marketing')).toBe(true)
    expect(navLinkActive(reports, '/yields')).toBe(false)
    expect(navLinkActive(COTTON_TAB, '/cotton/marketing')).toBe(true)
  })
})
