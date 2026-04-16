import type { Metadata, Viewport } from 'next'
import './globals.css'
import Nav from '@/components/nav'
import PwaRegister from '@/components/pwa-register'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Turnrow Grain',
  description: 'Track grain truck loads',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Turnrow Grain',
  },
  icons: {
    apple: '/icons/icon-192.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#15803d',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <html lang="en">
      <body className="min-h-screen">
        <PwaRegister />
        {user ? <Nav email={user.email ?? ''} /> : null}
        <main className="max-w-6xl mx-auto p-4 pb-24">{children}</main>
      </body>
    </html>
  )
}
