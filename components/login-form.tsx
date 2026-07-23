'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// The interactive sign-in form. The post-login destination (`next`) is passed
// in from the server page's searchParams so this component doesn't need
// useSearchParams (which would otherwise require its own Suspense boundary).
//
// "Forgot password?" swaps the card to a reset-request form:
// resetPasswordForEmail with a redirect to /reset-password (where the emailed
// recovery link lands and the new password is set). The response is always the
// same neutral sentence — no account enumeration.
export default function LoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    router.push(next)
    router.refresh()
  }

  async function onForgot(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const supabase = createClient()
    // Errors are deliberately not surfaced per-account (enumeration); a
    // config-level failure still shows the same neutral message.
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    }).catch(() => null)
    setBusy(false)
    setNotice('If an account exists for that email, a reset link has been sent.')
  }

  if (mode === 'forgot') {
    return (
      <form onSubmit={onForgot} className="w-full bg-white rounded-2xl shadow p-6 space-y-4">
        <h1 className="text-xl font-bold text-slate-800">Reset password</h1>
        <p className="text-slate-500 text-sm">Enter your email and we&apos;ll send a reset link.</p>

        <label className="block">
          <span className="text-sm text-slate-700">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base"
          />
        </label>

        {notice && <p className="text-sm text-brand-deep">{notice}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand hover:bg-brand-deep text-white font-semibold py-3 disabled:opacity-60"
        >
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
        <button
          type="button"
          onClick={() => { setMode('signin'); setNotice(null); setError(null) }}
          className="w-full text-sm text-brand-deep underline decoration-dotted"
        >
          Back to sign in
        </button>
      </form>
    )
  }

  return (
    <form onSubmit={onSubmit} className="w-full bg-white rounded-2xl shadow p-6 space-y-4">
      <p className="text-slate-500 text-sm">Sign in to continue.</p>

      <label className="block">
        <span className="text-sm text-slate-700">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm text-slate-700">Password</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base"
        />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-brand hover:bg-brand-deep text-white font-semibold py-3 disabled:opacity-60"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <button
        type="button"
        onClick={() => { setMode('forgot'); setError(null) }}
        className="w-full text-sm text-brand-deep underline decoration-dotted"
      >
        Forgot password?
      </button>
    </form>
  )
}
