import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { roleAllowsPath, roleHome } from '../route-guard'
import { coerceAppRole } from '../app-role'

// /api/partner does its own bearer-token auth (PARTNER_API_TOKEN) — no
// Supabase session, so it must skip the login redirect. Its routes 401 on
// their own; nothing under it is reachable without the token.
const PUBLIC_PATHS = ['/login', '/auth/callback', '/reset-password', '/api/partner']

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: any }>) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  // Cotton-module gate: the Bale Quality report exists only when the org's
  // Cotton module is on (per-org app_settings via RLS). Direct URLs bounce
  // to the reports landing; the sidebar/landing hide it too.
  if (user && (pathname === '/reports/bale-quality' || pathname.startsWith('/reports/bale-quality/'))) {
    const { data: settings } = await supabase
      .from('app_settings').select('cotton_module_enabled').limit(1).maybeSingle()
    if (!(settings as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled) {
      const url = request.nextUrl.clone()
      url.pathname = '/reports'
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  // Super-admin page (/admin): hidden from everyone but the platform
  // operator(s) in super_admins — others bounce home as if it didn't exist.
  // The admin_* RPCs re-check is_super_admin() server-side regardless.
  if (user && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
    const { data: sa } = await supabase
      .from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle()
    if (!sa) {
      const url = request.nextUrl.clone()
      url.pathname = '/'
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  // Role guards (lib/route-guard.ts): gin logins may reach ONLY the Cotton
  // intake pages; viewer logins ONLY Yields + Reports (and the read-only
  // price-lookup APIs). Server-side redirect here; the nav hides everything
  // else and the RLS policies (042/044/052) are the real enforcement
  // underneath. The profile lookup is skipped on paths every role may see.
  if (user && !isPublic) {
    if (!roleAllowsPath('gin', pathname) || !roleAllowsPath('viewer', pathname)) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle()
      const role = coerceAppRole((profile as { role?: string } | null)?.role)
      if (!roleAllowsPath(role, pathname)) {
        const url = request.nextUrl.clone()
        url.pathname = roleHome(role)
        url.search = ''
        return NextResponse.redirect(url)
      }
    }
  }

  return response
}
