'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// The interactive sign-in form. The post-login destination (`next`) is passed
// in from the server page's searchParams so this component doesn't need
// useSearchParams (which would otherwise require its own Suspense boundary).
export default function LoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
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

  return (
    <form onSubmit={onSubmit} className="w-full bg-white rounded-2xl shadow p-6 space-y-4">
      <h1 className="text-2xl font-bold text-slate-800">Grain Tracker</h1>
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
        className="w-full rounded-lg bg-green-700 text-white font-semibold py-3 disabled:opacity-60"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
