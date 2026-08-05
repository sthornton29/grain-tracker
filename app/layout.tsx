import type { Metadata, Viewport } from 'next'
import { Montserrat } from 'next/font/google'
import './globals.css'
import Nav from '@/components/nav'
import PwaRegister from '@/components/pwa-register'
import { createClient } from '@/lib/supabase/server'
import type { AppRole } from '@/lib/types'
import { coerceAppRole } from '@/lib/app-role'

// Turnrow display face: a clean geometric sans in the spirit of the wordmark
// (headings + nav wordmark; the body stays on the system stack for
// readability). Exposed as --font-display; globals.css applies it to
// headings, Tailwind as `font-display`.
const display = Montserrat({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-display' })

export const metadata: Metadata = {
  title: 'Turnrow',
  description: 'Turnrow — farm operations for Turnrow Farm',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Turnrow',
  },
  icons: {
    apple: '/icons/icon-192.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0B4A24',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Module flag + role drive what the nav shows (gin operators see only the
  // cotton intake pages; RLS + middleware enforce beyond the UI).
  let cottonEnabled = false
  let role: AppRole = 'owner'
  if (user) {
    const [settings, profile] = await Promise.all([
      supabase.from('app_settings').select('cotton_module_enabled').eq('id', 1).maybeSingle(),
      supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle(),
    ])
    cottonEnabled = Boolean((settings.data as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled)
    role = coerceAppRole((profile.data as { role?: string } | null)?.role)
  }

  return (
    <html lang="en" className={display.variable}>
      <body className="min-h-screen">
        <PwaRegister />
        {user ? <Nav cottonEnabled={cottonEnabled || role === 'gin'} role={role} /> : null}
        <main className="max-w-6xl mx-auto p-4 pb-24">{children}</main>
      </body>
    </html>
  )
}
