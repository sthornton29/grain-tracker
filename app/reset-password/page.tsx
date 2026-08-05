'use client'

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// Landing page for the Supabase password-recovery email link. The browser
// client exchanges the link's code for a recovery session automatically on
// load; with a session in hand we show the new-password form (updateUser).
// Without one (expired/used link, direct visit) we point back to the request
// flow. Public path — see lib/supabase/middleware.ts.
export default function ResetPasswordPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [hasSession, setHasSession] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    // The code exchange can land just after mount — listen as well as check.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return
      if (session) { setHasSession(true); setChecking(false) }
      if (event === 'PASSWORD_RECOVERY') { setHasSession(true); setChecking(false) }
    })
    ;(async () => {
      // token_hash links (the invite/reset email templates and the admin
      // "Invite link" button) verify HERE, so they work in any browser —
      // the ?code= exchange only works in the browser that started a flow,
      // which an emailed link never has (incognito, phone, etc.).
      const params = new URLSearchParams(window.location.search)
      const tokenHash = params.get('token_hash')
      const otpType = params.get('type')
      if (tokenHash && otpType) {
        const { data, error } = await supabase.auth.verifyOtp({
          type: otpType as 'invite' | 'recovery' | 'magiclink' | 'email',
          token_hash: tokenHash,
        })
        if (cancelled) return
        if (!error && data.session) setHasSession(true)
        setChecking(false)
        return
      }
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      if (data.session) setHasSession(true)
      // Give a just-arrived recovery link a beat to finish its exchange.
      setTimeout(() => { if (!cancelled) setChecking(false) }, 1500)
    })()
    return () => { cancelled = true; sub.subscription.unsubscribe() }
  }, [supabase])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) { setError('Use at least 8 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) { setError(error.message); return }
    setDone(true)
  }

  return (
    <div className="min-h-[85vh] flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex justify-center pt-2">
          <img src="/brand/logo-lockup.png" alt="Turnrow" className="h-12 w-auto" />
        </div>

        {done ? (
          <div className="w-full bg-white rounded-2xl shadow p-6 space-y-4 text-center">
            <h1 className="text-xl font-bold text-slate-800">Password updated</h1>
            <p className="text-sm text-slate-500">You&apos;re signed in with your new password.</p>
            <button
              type="button"
              onClick={() => { router.push('/'); router.refresh() }}
              className="w-full rounded-lg bg-brand hover:bg-brand-deep text-white font-semibold py-3"
            >
              Continue
            </button>
          </div>
        ) : checking ? (
          <div className="w-full bg-white rounded-2xl shadow p-6 text-center text-slate-500 text-sm">Checking your reset link…</div>
        ) : !hasSession ? (
          <div className="w-full bg-white rounded-2xl shadow p-6 space-y-3 text-center">
            <h1 className="text-xl font-bold text-slate-800">Reset link invalid or expired</h1>
            <p className="text-sm text-slate-500">Request a new link from the sign-in page.</p>
            <Link href="/login" className="block text-sm text-brand-deep underline decoration-dotted">Back to sign in</Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="w-full bg-white rounded-2xl shadow p-6 space-y-4">
            <h1 className="text-xl font-bold text-slate-800">Choose a new password</h1>
            <label className="block">
              <span className="text-sm text-slate-700">New password</span>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base"
              />
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">Confirm password</span>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base"
              />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-brand hover:bg-brand-deep text-white font-semibold py-3 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
