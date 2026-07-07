import { useEffect, useState } from 'react'
import { cropToCommodity } from '@/lib/contracts'
import type { CoveredCommodity } from '@/lib/types'

// Live MYA estimates (commodity_id → $/bu) for the tradeable commodities via
// /api/mya-estimate. ONE shared hook so the ARC/PLC Decision Aid, Government
// Payment Tracker, Revenue Projections, and Income Sensitivity all fetch (and
// fall back) identically. The map is RESET whenever the crop year or commodity
// list changes, so a failed refetch can never leave the previous year's prices
// silently feeding the new year's PLC projections.
export function useLiveMya(cropYear: number | '', commodities: CoveredCommodity[]): Map<string, number> {
  const [liveMya, setLiveMya] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    setLiveMya(new Map())
    if (cropYear === '' || commodities.length === 0) return
    const tradeable = commodities.filter((c) => cropToCommodity(c.name))
    if (tradeable.length === 0) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/mya-estimate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ crop_year: cropYear, commodities: tradeable.map((c) => ({ commodity_id: c.id, name: c.name })) }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled || !json) return
        const m = new Map<string, number>()
        for (const e of (json.estimates ?? []) as Array<{ commodity_id: string; price: number | null }>) {
          if (e.price != null) m.set(e.commodity_id, Number(e.price))
        }
        setLiveMya(m)
      } catch { /* fall back to stored price data */ }
    })()
    return () => { cancelled = true }
  }, [cropYear, commodities])
  return liveMya
}
