import LoginForm from '@/components/login-form'
import MarketBoard from '@/components/market-board'
import { fetchPublicQuotes } from '@/lib/barchart-quotes'

// Server component: renders the sign-in form plus a server-fetched grain-futures
// board (market-data display required at the login screen). The quote fetch is
// cached 5 minutes and falls back to blanks, so it never blocks sign-in.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string | string[] }
}) {
  const rawNext = searchParams?.next
  const next = typeof rawNext === 'string' && rawNext.startsWith('/') ? rawNext : '/'
  const board = await fetchPublicQuotes()

  return (
    <div className="min-h-[85vh] flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4">
        {/* Brand lockup: mark + spaced-caps wordmark, centered above the card. */}
        <div className="flex flex-col items-center gap-2 pt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-mark.svg" alt="Turnrow" className="h-16 w-16" />
          <div className="font-display font-bold tracking-[0.3em] text-brand-dark text-xl">TURNROW</div>
        </div>
        <LoginForm next={next} />
        <MarketBoard quotes={board.quotes} asOf={board.asOf} available={board.available} />
      </div>
    </div>
  )
}
