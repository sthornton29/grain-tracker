'use client'

// Landowner Shares — the farmer side of the Turnrow Landowner integration.
// Create a share for one of your landowners, hand them the one-time code,
// and their landowner software connects read-only to the fields on their
// farms. Plantings and harvest progress are always included; actual yields,
// projected prices, and projected yields are each a separate opt-in that
// defaults OFF. Every share shows a live "What they see" preview rendered
// from the very same server code that answers the landowner's software, so
// what you see here is exactly what they get — and toggles apply on their
// next sync, instantly. Codes and tokens are stored hashed; the code is
// visible here exactly once.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Landowner = { id: string; name: string }
type Share = {
  id: string
  landowner_id: string
  label: string | null
  include_yields: boolean
  share_projected_prices: boolean | null
  share_projected_yields: boolean | null
  code_expires_at: string
  redeemed_at: string | null
  revoked_at: string | null
  created_at: string
}

type PriceRecord = {
  crop: string
  crop_year: number
  unit: 'usd_per_bu' | 'cents_per_lb'
  projected_avg_price: number | null
  is_final: boolean
}
type EntityPriceRecord = PriceRecord & { entity_id: string; entity_name: string }
type ShareEntity = { id: string; name: string; field_count: number }
type YieldRecord = {
  field_name: string
  crop: string
  planted_acres: number
  yield_per_acre: number
  unit: 'bu_per_ac' | 'lbs_per_ac'
  basis: 'expected' | 'actual'
  practices: Array<{ practice: string; acres: number; yield_per_acre: number }> | null
}
type Preview = {
  landowner_name: string | null
  field_count: number
  /** The farming entities behind the shared fields — how the share's entity
   *  structure presents to the landowner. */
  entities: ShareEntity[]
  scopes: { yields: boolean; projected_prices: boolean; projected_yields: boolean }
  marketing_prices: { records: PriceRecord[]; by_entity: EntityPriceRecord[] } | { denied: string }
  projected_yields: { records: YieldRecord[] } | { denied: string }
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

const PRICES_BLURB =
  'Share your projected average price per crop. One number per crop; never your contracts, hedges, or how much you have priced.'
const PROJ_YIELDS_BLURB = 'Share projected yields for the shared fields before harvest.'
const YIELDS_BLURB = 'Share actual yields for their fields as harvest is recorded.'

function fmtPrice(r: PriceRecord): string {
  if (r.projected_avg_price == null) return '—'
  return r.unit === 'cents_per_lb'
    ? `$${(r.projected_avg_price / 100).toFixed(4)}/lb`
    : `$${r.projected_avg_price.toFixed(2)}/bu`
}
function PriceValue({ r }: { r: PriceRecord }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="font-semibold tabular-nums">{fmtPrice(r)}</span>
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.is_final ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
        {r.is_final ? 'final' : 'projected'}
      </span>
    </span>
  )
}
function fmtYield(v: number, unit: YieldRecord['unit']): string {
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit === 'lbs_per_ac' ? 'lbs/ac' : 'bu/ac'}`
}

function ScopeChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${
        on ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-slate-50 text-slate-400 border border-slate-200'
      }`}
    >
      {on ? '✓ ' : ''}{label}
    </span>
  )
}

function ScopeToggle({
  checked, onChange, title, blurb, disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  blurb: string
  disabled?: boolean
}) {
  return (
    <label className={`flex items-start gap-3 rounded-lg border p-3 ${checked ? 'border-green-200 bg-green-50/40' : 'border-slate-200'} ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 accent-brand"
      />
      <span>
        <span className="block font-semibold text-sm">{title}</span>
        <span className="block text-sm text-slate-600">{blurb}</span>
      </span>
    </label>
  )
}

export default function SharesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [shares, setShares] = useState<Share[]>([])
  const [landownerId, setLandownerId] = useState('')
  const [includeYields, setIncludeYields] = useState(true)
  const [sharePrices, setSharePrices] = useState(false)
  const [shareProjYields, setShareProjYields] = useState(false)
  const [label, setLabel] = useState('')
  const [freshCode, setFreshCode] = useState<{ code: string; landowner: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [openShareId, setOpenShareId] = useState<string | null>(null)

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
      share_projected_prices: sharePrices,
      share_projected_yields: shareProjYields,
      share_code_sha256: await sha256Hex(code),
    })
    if (error) { setErr(error.message); return }
    setFreshCode({ code, landowner: landownerName.get(landownerId) ?? '' })
    setCopied(false)
    setLabel('')
    setSharePrices(false)
    setShareProjYields(false)
    refresh()
  }

  async function updateScopes(s: Share, patch: Partial<Pick<Share, 'include_yields' | 'share_projected_prices' | 'share_projected_yields'>>) {
    setErr(null)
    // Optimistic so the toggle and preview respond immediately.
    setShares((prev) => prev.map((x) => (x.id === s.id ? { ...x, ...patch } : x)))
    const { error } = await supabase.from('partner_shares').update(patch).eq('id', s.id)
    if (error) { setErr(error.message); refresh() }
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
        Landowner. Plantings and harvest progress are always included; actual
        yields, projected prices, and projected yields are each up to you and
        start OFF. Open a share&apos;s <span className="font-semibold">preview</span> any
        time to see exactly what they see — changes apply the next time their
        software syncs.
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

      <form onSubmit={createShare} className="bg-white p-4 rounded-xl shadow space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <select value={landownerId} onChange={(e) => setLandownerId(e.target.value)} className={inputCls}>
            <option value="">Landowner…</option>
            {landowners.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" className={inputCls} />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
          <ScopeToggle checked={includeYields} onChange={setIncludeYields} title="Actual yields" blurb={YIELDS_BLURB} />
          <ScopeToggle checked={sharePrices} onChange={setSharePrices} title="Projected prices" blurb={PRICES_BLURB} />
          <ScopeToggle checked={shareProjYields} onChange={setShareProjYields} title="Projected yields" blurb={PROJ_YIELDS_BLURB} />
        </div>
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">
          Create Share &amp; Get Code
        </button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="space-y-3">
        {shares.length === 0 && (
          <li className="bg-white rounded-xl shadow px-4 py-6 text-center text-slate-400">No shares yet.</li>
        )}
        {shares.map((s) => {
          const status = statusOf(s)
          const open = openShareId === s.id
          return (
            <li key={s.id} className="bg-white rounded-xl shadow">
              <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[12rem]">
                  <p className="font-semibold">{landownerName.get(s.landowner_id) ?? 'Landowner'}</p>
                  <p className="text-sm text-slate-500">
                    {s.label ? `${s.label} · ` : ''}created {s.created_at.slice(0, 10)}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    <ScopeChip label="Plantings" on />
                    <ScopeChip label="Harvest" on />
                    <ScopeChip label="Yields" on={s.include_yields} />
                    <ScopeChip label="Prices" on={s.share_projected_prices ?? false} />
                    <ScopeChip label="Proj. yields" on={s.share_projected_yields ?? false} />
                  </div>
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>{status.label}</span>
                {!s.revoked_at && (
                  <button
                    onClick={() => setOpenShareId(open ? null : s.id)}
                    className="rounded-lg border border-brand text-brand-deep hover:bg-green-50 px-3 py-1.5 text-sm font-semibold"
                  >
                    {open ? 'Close preview' : 'Sharing & preview'}
                  </button>
                )}
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
              </div>
              {open && !s.revoked_at && (
                <div className="border-t border-slate-100 px-4 py-4 space-y-4">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
                    <ScopeToggle
                      checked={s.include_yields}
                      onChange={(v) => updateScopes(s, { include_yields: v })}
                      title="Actual yields"
                      blurb={YIELDS_BLURB}
                    />
                    <ScopeToggle
                      checked={s.share_projected_prices ?? false}
                      onChange={(v) => updateScopes(s, { share_projected_prices: v })}
                      title="Projected prices"
                      blurb={PRICES_BLURB}
                    />
                    <ScopeToggle
                      checked={s.share_projected_yields ?? false}
                      onChange={(v) => updateScopes(s, { share_projected_yields: v })}
                      title="Projected yields"
                      blurb={PROJ_YIELDS_BLURB}
                    />
                  </div>
                  <SharePreview
                    shareId={s.id}
                    landowner={landownerName.get(s.landowner_id) ?? 'this landowner'}
                    scopesKey={`${s.include_yields}|${s.share_projected_prices}|${s.share_projected_yields}`}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// The live preview: rendered from the same server code that answers the
// landowner's software, so this panel IS their screen.
function SharePreview({ shareId, landowner, scopesKey }: { shareId: string; landowner: string; scopesKey: string }) {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/shares/${shareId}/preview?year=${year}`)
      const json = await res.json().catch(() => null)
      if (!res.ok || !json) {
        setError((json as { error?: string } | null)?.error ?? 'The preview could not load. Please try again, or contact support if it keeps happening.')
        setPreview(null)
      } else {
        setPreview(json as Preview)
      }
    } catch {
      setError('The preview could not load. Please try again, or contact support if it keeps happening.')
      setPreview(null)
    }
    setLoading(false)
  }, [shareId, year])

  // Refetch when the year changes or any scope toggle flips (scopesKey).
  useEffect(() => { load() }, [load, scopesKey])

  const prices = preview?.marketing_prices
  const yields = preview?.projected_yields

  return (
    <div className="rounded-xl border-2 border-brand/40 bg-green-50/30 p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="font-display font-bold text-brand-dark">What {landowner} sees</h3>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
        >
          {[currentYear + 1, currentYear, currentYear - 1, currentYear - 2].map((y) => (
            <option key={y} value={y}>{y} crop year</option>
          ))}
        </select>
        {preview && (
          <span className="text-xs text-slate-500">
            {preview.field_count} field{preview.field_count === 1 ? '' : 's'} shared · plantings &amp; harvest progress always included
          </span>
        )}
      </div>

      {!loading && !error && preview && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-slate-500">Farmed by</span>
          {preview.entities.length === 0 ? (
            <span className="text-slate-500 italic">no entity on these farms yet — set one on each farm under Settings</span>
          ) : (
            preview.entities.map((e) => (
              <span key={e.id} className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-slate-700">
                <span className="font-medium">{e.name}</span>
                <span className="text-slate-500"> · {e.field_count} field{e.field_count === 1 ? '' : 's'}</span>
              </span>
            ))
          )}
        </div>
      )}

      {loading && <p className="text-sm text-slate-500">Loading the live preview…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && !error && preview && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <p className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">Projected prices</p>
            {prices && 'denied' in prices ? (
              <p className="text-sm text-slate-500 italic">
                Not shared — their screen says: &ldquo;{prices.denied}&rdquo;
              </p>
            ) : prices && prices.records.length === 0 ? (
              <p className="text-sm text-slate-500">No crops on their shared fields this year.</p>
            ) : (
              <>
                <p className="text-xs text-slate-500 mb-1">Whole operation</p>
                <ul className="divide-y divide-slate-100">
                  {prices?.records.map((r) => (
                    <li key={r.crop} className="py-2 flex items-baseline justify-between gap-3">
                      <span className="font-medium text-sm">{r.crop}</span>
                      <PriceValue r={r} />
                    </li>
                  ))}
                </ul>
                {prices && 'by_entity' in prices && prices.by_entity.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {preview.entities.map((e) => {
                      const rows = prices.by_entity.filter((r) => r.entity_id === e.id)
                      return (
                        <div key={e.id}>
                          <p className="text-xs text-slate-500 mb-1">{e.name}</p>
                          {rows.length === 0 ? (
                            <p className="text-xs text-slate-400 italic">No price to show yet for this entity.</p>
                          ) : (
                            <ul className="divide-y divide-slate-100">
                              {rows.map((r) => (
                                <li key={r.crop} className="py-1.5 flex items-baseline justify-between gap-3">
                                  <span className="text-sm">{r.crop}</span>
                                  <PriceValue r={r} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <p className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">Projected yields</p>
            {yields && 'denied' in yields ? (
              <p className="text-sm text-slate-500 italic">
                Not shared — their screen says: &ldquo;{yields.denied}&rdquo;
              </p>
            ) : yields && yields.records.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing to project yet for their fields this year.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {yields?.records.map((r, i) => (
                  <li key={`${r.field_name}|${r.crop}|${i}`} className="py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm">
                        <span className="font-medium">{r.field_name}</span>
                        <span className="text-slate-500"> · {r.crop}</span>
                      </span>
                      <span className="flex items-baseline gap-2">
                        <span className="font-semibold tabular-nums">{fmtYield(r.yield_per_acre, r.unit)}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.basis === 'actual' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
                          {r.basis === 'actual' ? 'actual' : 'projected'}
                        </span>
                      </span>
                    </div>
                    {r.practices && (
                      <p className="text-xs text-slate-500 mt-0.5">
                        {r.practices.map((p) => `${p.practice} ${p.acres.toLocaleString(undefined, { maximumFractionDigits: 1 })} ac · ${fmtYield(p.yield_per_acre, r.unit)}`).join('  ·  ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
