'use client'

// Contact Support — emails stuart via /api/support-request with the user's
// context auto-attached server-side. Optional screenshot (image only, ≤3 MB).
// When the chat escalates, the transcript arrives via the prop and rides
// along in the email body.

import { useState } from 'react'

const MAX_SHOT_BYTES = 3 * 1024 * 1024

export default function SupportForm({ route, transcript }: { route: string; transcript?: string }) {
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [shot, setShot] = useState<{ name: string; type: string; base64: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function pickShot(file: File | undefined) {
    setErr(null)
    if (!file) { setShot(null); return }
    if (!file.type.startsWith('image/')) { setErr('Screenshots must be an image file.'); return }
    if (file.size > MAX_SHOT_BYTES) { setErr('That image is over 3 MB — crop or resize it and try again.'); return }
    const buf = await file.arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    setShot({ name: file.name, type: file.type, base64: btoa(bin) })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!message.trim()) { setErr('Tell us what you need help with.'); return }
    setBusy(true)
    const res = await fetch('/api/support-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: subject.trim() || 'Support request',
        message: message.trim(),
        route,
        transcript: transcript || undefined,
        screenshot: shot ?? undefined,
      }),
    })
    const json = await res.json().catch(() => null)
    setBusy(false)
    if (!res.ok) { setErr(json?.error ?? 'Could not send — try again in a minute.'); return }
    setSent(true)
  }

  if (sent) {
    return (
      <div className="pt-8 text-center space-y-2">
        <div className="text-3xl" aria-hidden>✓</div>
        <p className="font-semibold">Message sent.</p>
        <p className="text-sm text-slate-500">Support will reply to your email address — usually the same day.</p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3 pt-2">
      <p className="text-xs text-slate-500">
        Goes straight to Turnrow support with your name, farm, and current page attached — no need to
        explain where you are.
      </p>
      {transcript && (
        <p className="text-xs rounded-lg bg-sky-50 border border-sky-200 px-2.5 py-1.5 text-sky-900">
          Your conversation with the assistant will be included.
        </p>
      )}
      <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5}
        placeholder="What do you need help with?"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      <label className="block text-xs text-slate-500">
        Screenshot (optional, image up to 3 MB)
        <input type="file" accept="image/*" onChange={(e) => pickShot(e.target.files?.[0])}
          className="mt-1 block w-full text-xs" />
      </label>
      {shot && <p className="text-xs text-slate-500">Attached: {shot.name}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button type="submit" disabled={busy}
        className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 text-sm font-semibold disabled:opacity-50">
        {busy ? 'Sending…' : 'Send to support'}
      </button>
    </form>
  )
}
