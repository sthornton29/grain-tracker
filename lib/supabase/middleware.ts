import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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

  // Gin-operator role guard: gin logins may reach ONLY the Cotton intake
  // pages — NOT /cotton/marketing (producer sales/loans/fees; 044 RLS blocks
  // the data too). Server-side redirect here; the nav hides everything else
  // and the RLS policies (042/044) are the real enforcement underneath.
  if (user && !isPublic) {
    const ginAllowed =
      (pathname.startsWith('/cotton') && !pathname.startsWith('/cotton/marketing')) ||
      pathname.startsWith('/logout') || pathname.startsWith('/api/parse-document')
    if (!ginAllowed) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle()
      if ((profile as { role?: string } | null)?.role === 'gin') {
        const url = request.nextUrl.clone()
        url.pathname = '/cotton/loads'
        url.search = ''
        return NextResponse.redirect(url)
      }
    }
  }

  return response
}
