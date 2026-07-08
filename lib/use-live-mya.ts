import { useEffect, useState } from 'react'
import type { CoveredCommodity } from '@/lib/types'
import type { MyaBlendResult } from '@/lib/mya-estimate'

// Per-commodity detail behind a live MYA estimate: the month-by-month blend
// composition returned by /api/mya-estimate (published vs futures-implied
// months, the basis adjustment applied, quote freshness).
export type LiveMyaDetail = {
  commodity_id: string
  name: string
  price: number | null
  price_date: string | null
  stale: boolean
  tradeable: boolean
  composition: {
    publishedCount: number
    futuresCount: number
    missingCount: number
    basisAdj: number
    months: MyaBlendResult['months']
  } | null
}

export type LiveMya = {
  // commodity_id → blended MYA estimate. The shape every projection consumes.
  prices: Map<string, number>
  // commodity_id → full blend composition, for the MYA panel display.
  details: Map<string, LiveMyaDetail>
  // Re-run the estimate (e.g. after editing monthly prices).
  refresh: () => void
}

// Live MYA estimates for the commodities via /api/mya-estimate (a
// month-by-month marketing-year blend — see lib/mya-estimate.ts). ONE shared
// hook so the ARC/PLC Decision Aid, Government Payment Tracker, Revenue
// Projections, and Income Sensitivity all fetch (and fall back) identically.
// The maps are RESET whenever the crop year or commodity list changes, so a
// failed refetch can never leave the previous year's prices silently feeding
// the new year's projections. Untraded commodities are included: they get a
// blend when monthly prices have been entered for them.
export function useLiveMyaDetailed(cropYear: number | '', commodities: CoveredCommodity[]): LiveMya {
  const [prices, setPrices] = useState<Map<string, number>>(new Map())
  const [details, setDetails] = useState<Map<string, LiveMyaDetail>>(new Map())
  const [tick, setTick] = useState(0)
  useEffect(() => {
    setPrices(new Map())
    setDetails(new Map())
    if (cropYear === '' || commodities.length === 0) return
    // Traded commodities always participate; untraded ones can still blend
    // from entered monthly prices, so send them all.
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/mya-estimate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ crop_year: cropYear, commodities: commodities.map((c) => ({ commodity_id: c.id, name: c.name })) }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled || !json) return
        const m = new Map<string, number>()
        const d = new Map<string, LiveMyaDetail>()
        for (const e of (json.estimates ?? []) as LiveMyaDetail[]) {
          d.set(e.commodity_id, e)
          if (e.price != null) m.set(e.commodity_id, Number(e.price))
        }
        setPrices(m)
        setDetails(d)
      } catch { /* fall back to stored price data */ }
    })()
    return () => { cancelled = true }
  }, [cropYear, commodities, tick])
  return { prices, details, refresh: () => setTick((t) => t + 1) }
}

// Back-compatible shape: commodity_id → price. Existing pages keep working
// unchanged; note resolveMyaPrice still ignores the live estimate for
// commodities with no traded futures unless they have published months (the
// blend for those rides the STORED estimate the route persists).
export function useLiveMya(cropYear: number | '', commodities: CoveredCommodity[]): Map<string, number> {
  return useLiveMyaDetailed(cropYear, commodities).prices
}
