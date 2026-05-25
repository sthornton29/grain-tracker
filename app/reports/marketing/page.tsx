'use client'

import { useCallback, useState } from 'react'
import MarketingReport from '@/components/reports/marketing-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function MarketingReportPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Marketing Dashboard', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => { setBuildPayload(() => fn) }, [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap no-print">
        <h1 className="text-2xl font-bold flex-1">Marketing Dashboard</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-2xl">
        Combined physical sales and hedging position by crop for a crop year. Pick a year, choose Base or Detailed,
        and export to Excel or PDF.
      </p>
      <MarketingReport onPayloadChange={handlePayload} />
    </div>
  )
}
