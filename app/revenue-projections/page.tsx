'use client'

import { useCallback, useState } from 'react'
import RevenueProjectionsReport from '@/components/reports/revenue-projections-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function RevenueProjectionsPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Revenue Projections', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => setBuildPayload(() => fn), [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap no-print">
        <h1 className="text-2xl font-bold flex-1">Revenue Projections</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Every revenue source for a crop year in one view — crop sales, crop insurance proceeds, and government payments
        (coming soon) — with cost, profit, and breakeven. Updates as loads, contracts, insurance, and futures prices change.
      </p>
      <RevenueProjectionsReport onPayloadChange={handlePayload} />
    </div>
  )
}
