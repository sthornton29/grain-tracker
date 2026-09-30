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
      <HedgingSummaryReport onPayloadChange={handlePayload} headerActions={<ExportBar buildPayload={() => buildPayload()} />} />
      <p className="text-sm text-slate-600 no-print max-w-2xl">
        Every futures and option position, open and closed, with realized and unrealized gains by crop year. Export to
        Excel or PDF to share your hedging activity with a lender or partner.
      </p>
    </div>
  )
}
