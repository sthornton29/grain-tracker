'use client'

// RMA Price Discovery status — one line per crop × state on the crop-insurance
// settings page: the discovery windows (from the CEPP-keyed data, never a
// hard-coded calendar), where each window stands (pre / in-discovery / final),
// the current value, and its source. The ↻ forces a refresh (the route
// otherwise refreshes lazily — daily in-window, weekly outside).

import { useEffect, useMemo, useState } from 'react'
import { fmtPrice } from '@/lib/hedging'
import type { RmaLookupResult } from '@/app/api/rma-price-discovery/route'
import type { County, Crop, CropInsurancePolicy } from '@/lib/types'

const fmtWindow = (a: string | null, b: string | null) => {
  const f = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return `${m}/${d}/${y}`
  }
  return a && b ? `${f(a)}–${f(b)}` : '—'
}

const statusChip = (status: RmaLookupResult['projected_status']) =>
  status === 'released' ? { text: 'final', cls: 'bg-green-100 text-green-800' }
  : status === 'in_discovery' ? { text: 'in discovery', cls: 'bg-sky-100 text-sky-800' }
  : { text: 'not started', cls: 'bg-slate-200 text-slate-600' }

export default function PriceDiscoveryStatus({
  cropYear,
  crops,
  policies,
  counties,
}: {
  cropYear: number
  crops: readonly Crop[]
  policies: readonly CropInsurancePolicy[]
  counties: readonly County[]
}) {
  const [results, setResults] = useState<RmaLookupResult[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  const insuredCropIds = useMemo(
    () => [...new Set(policies.filter((p) => p.crop_year === cropYear).map((p) => p.crop_id))],
    [policies, cropYear],
  )
  const states = useMemo(
    () => [...new Set(policies
      .filter((p) => p.crop_year === cropYear && p.county_id)
      .map((p) => countyById.get(p.county_id!)?.state_code)
      .filter((s): s is string => !!s))],
    [policies, cropYear, countyById],
  )

  useEffect(() => {
    if (insuredCropIds.length === 0 || states.length === 0) { setResults([]); return }
    const cropsPayload = insuredCropIds
      .map((id) => ({ crop_id: id, crop_name: crops.find((c) => c.id === id)?.name ?? '' }))
      .filter((c) => c.crop_name)
    let cancelled = false
    ;(async () => {
      setBusy(true)
      setNote(null)
      try {
        const res = await fetch('/api/rma-price-discovery', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ crop_year: cropYear, crops: cropsPayload, states, force: refresh > 0 }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled) return
        setResults((json?.data?.results ?? []) as RmaLookupResult[])
        if (typeof json?.data?.note === 'string') setNote(json.data.note)
      } catch {
        if (!cancelled) setNote('Could not reach RMA Price Discovery.')
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropYear, insuredCropIds.join('|'), states.join('|'), refresh])

  if (insuredCropIds.length === 0 || states.length === 0) return null

  const cropName = (id: string) => crops.find((c) => c.id === id)?.name ?? '—'

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-semibold flex-1">Price discovery (RMA)</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => setRefresh((n) => n + 1)}
          title="Refresh from RMA now"
          aria-label="Refresh RMA prices"
          className="text-brand-deep hover:text-brand disabled:text-slate-300"
        >
          <span className={busy ? 'inline-block animate-spin' : ''}>↻</span>
        </button>
      </div>
      <p className="text-sm text-slate-500">
        Projected and harvest insurance prices straight from RMA&rsquo;s published discovery data, keyed by your
        policies&rsquo; states — the windows differ by state and crop. Finals apply automatically.
      </p>
      {note && <p className="text-sm text-amber-700">{note}</p>}
      {busy && results.length === 0 && <p className="text-sm text-slate-400">Checking RMA…</p>}
      {results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-slate-500">
              <tr>{['Crop', 'State', 'Projected', 'Window', 'Harvest', 'Window', 'Volatility'].map((h, i) => (
                <th key={i} className={`px-2 py-1 ${i >= 2 ? 'text-left' : 'text-left'}`}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const pc = statusChip(r.projected_status)
                const hc = statusChip(r.harvest_status)
                return (
                  <tr key={`${r.crop_id}|${r.state_code}`} className="border-t border-slate-100">
                    <td className="px-2 py-1.5 font-medium whitespace-nowrap">{cropName(r.crop_id)}</td>
                    <td className="px-2 py-1.5">{r.state_code}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">
                      {r.projected_price != null ? fmtPrice(r.projected_price) : '—'}{' '}
                      <span className={`text-xs rounded-full px-2 py-0.5 ${pc.cls}`}>{pc.text}</span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-slate-500">{fmtWindow(r.projected_begin_date, r.projected_end_date)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">
                      {r.harvest_price != null ? fmtPrice(r.harvest_price) : '—'}{' '}
                      <span className={`text-xs rounded-full px-2 py-0.5 ${hc.cls}`}>{hc.text}</span>
                      {r.harvest_status === 'in_discovery' && r.harvest_label && (
                        <span className="block text-xs text-slate-400">{r.harvest_label}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-slate-500">{fmtWindow(r.harvest_begin_date, r.harvest_end_date)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{r.volatility != null ? r.volatility.toFixed(2) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
