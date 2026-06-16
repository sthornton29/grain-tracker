'use client'

import { useCallback, useState } from 'react'
import HedgingSummaryReport from '@/components/reports/hedging-summary-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function HedgingSummaryReportPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Hedging Summary', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => {
    setBuildPayload(() => fn)
  }, [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Hedging Summary</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-2xl">
        All futures positions (open and closed) with full P&amp;L detail, summarized by crop year. Export to Excel or PDF to
        share your hedging activity and performance with a lender or partner.
      </p>
      <HedgingSummaryReport onPayloadChange={handlePayload} />
    </div>
  )
}
