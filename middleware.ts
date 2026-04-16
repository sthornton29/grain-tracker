import { NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: [
    // Skip static assets, Next internals, PWA manifest, and the service worker.
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icons/|.*\\.(?:png|jpg|jpeg|svg|webp|ico)).*)',
  ],
}
