'use client'

// Landowner Shares — the farmer side of the Turnrow Landowner integration.
// Create a share for one of your landowners, hand them the one-time code,
// and their landowner software connects read-only to the fields on their
// farms (plantings and harvest always; yields only if you opt in). Codes
// and tokens are stored hashed; the code is visible here exactly once.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Landowner = { id: string; name: string }
type Share = {
  id: string
  landowner_id: string
  label: string | null
  include_yields: boolean
  code_expires_at: string
  redeemed_at: string | null
  revoked_at: string | null
  created_at: string
}

// Unambiguous alphabet (no 0/O/1/I) for hand-typed codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateShareCode(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
  return `TRW-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export default function SharesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [shares, setShares] = useState<Share[]>([])
  const [landownerId, setLandownerId] = useState('')
  const [includeYields, setIncludeYields] = useState(true)
  const [label, setLabel] = useState('')
  const [freshCode, setFreshCode] = useState<{ code: string; landowner: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const [lo, sh] = await Promise.all([
      supabase.from('landowners').select('id, name').order('name'),
      supabase.from('partner_shares').select('*').order('created_at', { ascending: false }),
    ])
    setLandowners((lo.data as Landowner[]) || [])
    setShares((sh.data as Share[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const landownerName = useMemo(
    () => new Map(landowners.map((l) => [l.id, l.name])),
    [landowners],
  )

  async function createShare(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!landownerId) { setErr('Pick the landowner this share is for.'); return }
    const code = generateShareCode()
    const { error } = await supabase.from('partner_shares').insert({
      landowner_id: landownerId,
      label: label.trim() || null,
      include_yields: includeYields,
      share_code_sha256: await sha256Hex(code),
    })
    if (error) { setErr(error.message); return }
    setFreshCode({ code, landowner: landownerName.get(landownerId) ?? '' })
    setCopied(false)
    setLabel('')
    refresh()
  }

  async function revoke(s: Share) {
    if (!confirm(`End the share with ${landownerName.get(s.landowner_id) ?? 'this landowner'}? Their landowner software loses access immediately.`)) return
    const { error } = await supabase
      .from('partner_shares')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', s.id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  async function remove(s: Share) {
    if (!confirm('Delete this share entry?')) return
    const { error } = await supabase.from('partner_shares').delete().eq('id', s.id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  function statusOf(s: Share): { label: string; cls: string } {
    if (s.revoked_at) return { label: 'Revoked', cls: 'bg-red-50 text-red-700' }
    if (s.redeemed_at) return { label: 'Connected', cls: 'bg-green-50 text-green-800' }
    if (new Date(s.code_expires_at) < new Date()) {
      return { label: 'Code expired', cls: 'bg-amber-50 text-amber-800' }
    }
    return { label: `Code outstanding (expires ${s.code_expires_at.slice(0, 10)})`, cls: 'bg-slate-100 text-slate-600' }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Landowner Shares</h1>
      <p className="text-sm text-slate-600 max-w-2xl">
        Give a landowner read-only visibility into their own fields in Turnrow
        Landowner. You choose whether yields are included; plantings and
        harvest status always are. Hand them the one-time code; it connects
        their account and cannot be reused.
      </p>

      {freshCode && (
        <div className="bg-white rounded-xl shadow p-4 border-2 border-brand space-y-2">
          <p className="font-semibold">
            Share code for {freshCode.landowner} — visible only now, copy it before leaving this page:
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <code className="text-2xl font-mono font-bold tracking-wider">{freshCode.code}</code>
            <button
              onClick={async () => { await navigator.clipboard.writeText(freshCode.code); setCopied(true) }}
              className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1.5 text-sm font-semibold"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={() => setFreshCode(null)} className="text-sm text-slate-600">Done</button>
          </div>
          <p className="text-sm text-slate-500">
            The landowner enters it under Connect a Farm in Turnrow Landowner. It expires in 7 days if unused.
          </p>
        </div>
      )}

      <form onSubmit={createShare} className="bg-white p-4 rounded-xl shadow space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select value={landownerId} onChange={(e) => setLandownerId(e.target.value)} className={inputCls}>
            <option value="">Landowner…</option>
            {landowners.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" className={inputCls} />
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={includeYields}
              onChange={(e) => setIncludeYields(e.target.checked)}
              className="h-4 w-4 accent-brand"
            />
            Include yields
          </label>
        </div>
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">
          Create Share & Get Code
        </button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {shares.length === 0 && (
          <li className="px-4 py-6 text-center text-slate-400">No shares yet.</li>
        )}
        {shares.map((s) => {
          const status = statusOf(s)
          return (
            <li key={s.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-[12rem]">
                <p className="font-semibold">{landownerName.get(s.landowner_id) ?? 'Landowner'}</p>
                <p className="text-sm text-slate-500">
                  {s.label ? `${s.label} · ` : ''}
                  {s.include_yields ? 'Plantings, harvest & yields' : 'Plantings & harvest (no yields)'}
                  {' · created '}{s.created_at.slice(0, 10)}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>{status.label}</span>
              {!s.revoked_at && s.redeemed_at && (
                <button onClick={() => revoke(s)} className="text-sm font-semibold text-red-600 hover:underline">
                  End share
                </button>
              )}
              {!s.redeemed_at && (
                <button onClick={() => remove(s)} className="text-sm text-slate-500 hover:underline">
                  Delete
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
