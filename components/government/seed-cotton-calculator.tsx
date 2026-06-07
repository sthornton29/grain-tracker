'use client'

// Seed cotton MYA calculator. Seed cotton is ~43% lint, ~57% cottonseed by
// weight, so its MYA price blends a cotton-lint price ($/lb, optionally pulled
// from ICE cotton futures via Barchart) with a cottonseed price (entered as
// $/ton). The result is stored as the seed cotton commodity's MYA estimate so
// the PLC engine and reports can use it.

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { seedCottonMya, LINT_SHARE, COTTONSEED_SHARE } from '@/lib/government-payments'
import type { CoveredCommodity, ArcPlcPriceData } from '@/lib/types'

type Props = {
  commodity: CoveredCommodity
  cropYear: number
  priceData: ArcPlcPriceData | null
  onSaved: () => void
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

export default function SeedCottonCalculator({ commodity, cropYear, priceData, onSaved }: Props) {
  const supabase = useState(() => createClient())[0]
  const [lint, setLint] = useState('') // $/lb
  const [cottonseed, setCottonseed] = useState('') // $/ton
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const lintNum = Number(lint)
  const seedNum = Number(cottonseed)
  const valid = Number.isFinite(lintNum) && lintNum > 0 && Number.isFinite(seedNum) && seedNum > 0
  const mya = valid ? seedCottonMya(lintNum, seedNum) : null

  async function fetchLint() {
    setErr(null); setMsg(null); setFetching(true)
    try {
      const symbol = nearbyCottonSymbol()
      const res = await fetch('/api/market-prices', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbols: [symbol] }),
      })
      const json = await res.json().catch(() => null)
      const price = json?.prices?.[0]?.price // $/lb (cents/100)
      if (price != null && Number.isFinite(Number(price))) {
        setLint(String(Number(price)))
        setMsg(`Lint price pulled from ${symbol} (${Number(price).toFixed(4)} $/lb).`)
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
        effective_reference_price: priceData?.effective_reference_price ?? null,
        mya_price_final: priceData?.mya_price_final ?? null,
        source: 'manual',
        updated_at: new Date().toISOString(),
      }
      const { error } = await supabase.from('arc_plc_price_data').upsert(payload, { onConflict: 'commodity_id,crop_year' })
      if (error) throw new Error(error.message)
      setMsg(`Saved seed cotton MYA estimate: $${mya.toFixed(4)}/lb for ${cropYear}.`)
      onSaved()
    } catch (e: any) {
      setErr(`Could not save: ${e?.message ?? 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 w-full bg-white'

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-3">
      <div className="font-semibold text-sm">Seed Cotton MYA Calculator</div>
      <p className="text-xs text-slate-500">
        Seed cotton MYA = {LINT_SHARE} × lint $/lb + {COTTONSEED_SHARE} × (cottonseed $/ton ÷ 2000).
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Lint price ($/lb)</span>
          <div className="flex gap-2">
            <input type="number" step="0.0001" value={lint} onChange={(e) => setLint(e.target.value)} className={inputCls} />
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
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-sm">
          Seed cotton MYA: <strong>{mya != null ? `$${mya.toFixed(4)}/lb` : '—'}</strong>
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
