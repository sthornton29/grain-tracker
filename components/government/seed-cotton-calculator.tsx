'use client'

// Seed cotton MYA entry. Two modes:
//   * Seed cotton ¢/lb directly — for when the operator already has the number
//     (e.g. the WASDE/NASS seed cotton price).
//   * Lint + cottonseed — seed cotton is ~43% lint / ~57% cottonseed by weight,
//     so SC price = lint_share × lint $/lb + seed_share × (cottonseed $/ton ÷ 2000).
//     The lint price can be prefilled from ICE cotton futures via Barchart; the
//     shares are editable as an advanced option.
// The computed price is shown live and stored as the seed cotton commodity's
// MYA estimate (with a derivation note) so the PLC/ARC engines and reports use
// it. Rendered in Settings → Price Data AND in the MYA panel on the reports.

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { LINT_SHARE, COTTONSEED_SHARE } from '@/lib/government-payments'
import type { CoveredCommodity, ArcPlcPriceData } from '@/lib/types'

type Props = {
  commodity: CoveredCommodity
  cropYear: number
  priceData: ArcPlcPriceData | null
  onSaved: () => void
  compact?: boolean
}

// ICE Cotton #2 delivery months: Mar, May, Jul, Oct, Dec.
const COTTON_CODE: Record<number, string> = { 3: 'H', 5: 'K', 7: 'N', 10: 'V', 12: 'Z' }
function nearbyCottonSymbol(): string {
  const now = new Date()
  const startM = now.getMonth() + 1
  const startY = now.getFullYear()
  for (let i = 0; i < 24; i++) {
    const m = ((startM - 1 + i) % 12) + 1
    const y = startY + Math.floor((startM - 1 + i) / 12)
    if (COTTON_CODE[m]) return `CT${COTTON_CODE[m]}${String(y % 100).padStart(2, '0')}`
  }
  return ''
}

export default function SeedCottonCalculator({ commodity, cropYear, priceData, onSaved, compact }: Props) {
  const supabase = useState(() => createClient())[0]
  const [mode, setMode] = useState<'direct' | 'lint'>('lint')
  const [direct, setDirect] = useState('') // seed cotton ¢/lb
  const [lint, setLint] = useState('') // lint ¢/lb
  const [lintSymbol, setLintSymbol] = useState<string | null>(null)
  const [cottonseed, setCottonseed] = useState('') // $/ton
  const [showShares, setShowShares] = useState(false)
  const [lintShare, setLintShare] = useState(String(LINT_SHARE))
  const [seedShare, setSeedShare] = useState(String(COTTONSEED_SHARE))
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const lintShareNum = Number(lintShare)
  const seedShareNum = Number(seedShare)
  const sharesValid = Number.isFinite(lintShareNum) && Number.isFinite(seedShareNum) && lintShareNum > 0 && seedShareNum > 0

  const directNum = Number(direct)
  const lintNum = Number(lint)
  const seedNum = Number(cottonseed)

  // Computed seed cotton price, $/lb.
  const mya =
    mode === 'direct'
      ? (direct.trim() !== '' && Number.isFinite(directNum) && directNum > 0 ? Math.round((directNum / 100) * 1e6) / 1e6 : null)
      : Number.isFinite(lintNum) && lintNum > 0 && Number.isFinite(seedNum) && seedNum > 0 && sharesValid
        ? Math.round((lintShareNum * (lintNum / 100) + seedShareNum * (seedNum / 2000)) * 1e6) / 1e6
        : null

  const derivation =
    mode === 'direct'
      ? `Entered directly as seed cotton ${directNum}¢/lb`
      : `Derived from lint ${lintNum}¢/lb${lintSymbol ? ` (${lintSymbol})` : ''} + cottonseed $${seedNum}/ton, ${Math.round(lintShareNum * 100)}/${Math.round(seedShareNum * 100)} split`

  async function fetchLint() {
    setErr(null); setMsg(null); setFetching(true)
    try {
      const symbol = nearbyCottonSymbol()
      const res = await fetch('/api/market-prices', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbols: [symbol] }),
      })
      const json = await res.json().catch(() => null)
      const price = json?.prices?.[0]?.price // $/lb (Barchart cents ÷ 100)
      if (price != null && Number.isFinite(Number(price))) {
        setLint((Number(price) * 100).toFixed(2)) // display in ¢/lb
        setLintSymbol(symbol)
        setMsg(`Lint prefilled from ${symbol}: ${(Number(price) * 100).toFixed(2)}¢/lb.`)
      } else {
        setErr(`No Barchart price for ${symbol} — enter the lint price manually.`)
      }
    } catch {
      setErr('Could not reach Barchart — enter the lint price manually.')
    } finally {
      setFetching(false)
    }
  }

  async function save() {
    if (mya == null) return
    setErr(null); setMsg(null); setSaving(true)
    try {
      const payload = {
        commodity_id: commodity.id,
        crop_year: cropYear,
        mya_price_estimate: mya,
        mya_note: derivation,
        effective_reference_price: priceData?.effective_reference_price ?? null,
        mya_price_final: priceData?.mya_price_final ?? null,
        source: 'manual',
        updated_at: new Date().toISOString(),
      }
      const { error } = await supabase.from('arc_plc_price_data').upsert(payload, { onConflict: 'commodity_id,crop_year' })
      if (error) throw new Error(error.message)
      setMsg(`Saved seed cotton MYA estimate: ${(mya * 100).toFixed(2)}¢/lb ($${mya.toFixed(4)}/lb) for ${cropYear}.`)
      onSaved()
    } catch (e: any) {
      setErr(`Could not save: ${e?.message ?? 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 w-full bg-white'
  const modeBtn = (m: 'direct' | 'lint', label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={`px-2.5 py-1 text-xs ${mode === m ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
    >
      {label}
    </button>
  )

  return (
    <div className={`rounded-lg border border-slate-200 p-3 space-y-3 ${compact ? 'bg-slate-50' : ''}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="font-semibold text-sm">Seed Cotton MYA</div>
        <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
          {modeBtn('direct', 'Seed cotton ¢/lb')}
          {modeBtn('lint', 'Lint + cottonseed')}
        </span>
      </div>
      {mode === 'direct' ? (
        <label className="text-sm flex flex-col gap-1 max-w-xs">
          <span className="text-slate-500">Seed cotton price (¢/lb)</span>
          <input type="number" step="0.01" value={direct} onChange={(e) => setDirect(e.target.value)} className={inputCls} />
        </label>
      ) : (
        <>
          <p className="text-xs text-slate-500">
            SC price = {lintShareNum || LINT_SHARE} × lint + {seedShareNum || COTTONSEED_SHARE} × (cottonseed $/ton ÷ 2000).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm flex flex-col gap-1">
              <span className="text-slate-500">Lint price (¢/lb)</span>
              <div className="flex gap-2">
                <input type="number" step="0.01" value={lint} onChange={(e) => { setLint(e.target.value); setLintSymbol(null) }} className={inputCls} />
                <button type="button" onClick={fetchLint} disabled={fetching} className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm whitespace-nowrap disabled:opacity-50">
                  {fetching ? '…' : 'Barchart'}
                </button>
              </div>
            </label>
            <label className="text-sm flex flex-col gap-1">
              <span className="text-slate-500">Cottonseed price ($/ton)</span>
              <input type="number" step="1" value={cottonseed} onChange={(e) => setCottonseed(e.target.value)} className={inputCls} />
            </label>
          </div>
          <button type="button" onClick={() => setShowShares((s) => !s)} className="text-xs text-slate-500 underline">
            {showShares ? 'Hide' : 'Adjust'} lint/seed split (standard 43/57)
          </button>
          {showShares && (
            <div className="flex gap-3 items-end">
              <label className="text-sm flex flex-col gap-1">
                <span className="text-slate-500">Lint share</span>
                <input type="number" step="0.01" min="0" max="1" value={lintShare} onChange={(e) => setLintShare(e.target.value)} className={`${inputCls} w-24`} />
              </label>
              <label className="text-sm flex flex-col gap-1">
                <span className="text-slate-500">Seed share</span>
                <input type="number" step="0.01" min="0" max="1" value={seedShare} onChange={(e) => setSeedShare(e.target.value)} className={`${inputCls} w-24`} />
              </label>
              {sharesValid && Math.abs(lintShareNum + seedShareNum - 1) > 0.001 && (
                <span className="text-xs text-amber-700 pb-2">Shares don’t sum to 1.00 — check the split.</span>
              )}
            </div>
          )}
        </>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-sm">
          Seed cotton price: <strong>{mya != null ? `${(mya * 100).toFixed(2)}¢/lb ($${mya.toFixed(4)}/lb)` : '—'}</strong>
        </div>
        <button type="button" onClick={save} disabled={mya == null || saving} className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">
          {saving ? 'Saving…' : `Save as ${cropYear} MYA estimate`}
        </button>
      </div>
      {msg && <p className="text-xs text-green-700">{msg}</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  )
}
