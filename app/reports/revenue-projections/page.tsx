'use client'

import { useCallback, useState } from 'react'
import RevenueProjectionsReport from '@/components/reports/revenue-projections-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function RevenueProjectionsReportPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Revenue Projections', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => setBuildPayload(() => fn), [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Revenue Projections</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Every revenue source for a crop year in one view — crop sales, crop insurance proceeds, and government payments
        (ARC/PLC + other USDA) — with cost, profit, and breakeven. A one-page financial summary for a lender or farm meeting.
      </p>
      <RevenueProjectionsReport onPayloadChange={handlePayload} />
    </div>
  )
}
