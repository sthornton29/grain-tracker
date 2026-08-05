// Role → route matrix shared by the middleware guard (lib/supabase/middleware.ts)
// and the tests. Pure so the viewer/gin path rules are unit-testable — the
// middleware only wires it to the session.
//
//   owner  — everything.
//   gin    — Cotton intake only (not /cotton/marketing) + logout + doc parsing.
//   viewer — read-only stakeholder: the home tiles, Yields, every /reports
//            page, logout, and the read-only price/market API routes the
//            report pages call. Everything else redirects to roleHome.
//
// The nav (navLinksFor) hides the links and the RLS policies (042/044/052) are
// the real enforcement underneath — this is the server-side redirect layer.

import type { AppRole } from '@/lib/types'

// Read-only lookup routes the report pages fetch (market prices, harvest-price
// estimate, MYA estimates). No writes happen behind these.
const VIEWER_API_PATHS = [
  '/api/market-prices',
  '/api/harvest-price-estimate',
  '/api/mya-estimate',
  '/api/nass-monthly-prices',
  '/api/mya-monthly-lookup',
]

// Report pages with NO entity dimension to scope by — they show whole-
// operation data (every buyer settlement; the operation budget sandbox), so
// viewers don't get them at all. reportGroupsFor() hides them from the
// sidebar/landing via this same matrix.
const VIEWER_BLOCKED_REPORTS = ['/reports/settlement-pdfs', '/reports/crop-budget']

const startsAt = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(base + '/')

export function roleAllowsPath(role: AppRole, pathname: string): boolean {
  if (role === 'owner') return true
  if (startsAt(pathname, '/logout')) return true
  if (role === 'gin') {
    return (
      (startsAt(pathname, '/cotton') && !startsAt(pathname, '/cotton/marketing')) ||
      startsAt(pathname, '/api/parse-document')
    )
  }
  // viewer
  if (VIEWER_BLOCKED_REPORTS.some((p) => startsAt(pathname, p))) return false
  return (
    pathname === '/' ||
    startsAt(pathname, '/yields') ||
    startsAt(pathname, '/reports') ||
    VIEWER_API_PATHS.some((p) => startsAt(pathname, p))
  )
}

/** Where a role lands when redirected off a page it may not see. */
export function roleHome(role: AppRole): string {
  if (role === 'gin') return '/cotton/loads'
  if (role === 'viewer') return '/reports'
  return '/'
}
