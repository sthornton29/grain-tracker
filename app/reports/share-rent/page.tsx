'use client'

import { useCallback, useState } from 'react'
import ShareRentReport from '@/components/reports/share-rent-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function ShareRentReportPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Share Rent Report', sections: [{ columns: [], rows: [] }] }),
  )
  // Memoized: an inline arrow would change identity every render, and the
  // child component lists this in its effect deps — without useCallback the
  // child re-fires its effect, which calls back here, which triggers another
  // render, and so on (infinite render loop that locks up the tab).
  const handlePayload = useCallback((fn: () => ExportPayload) => {
    setBuildPayload(() => fn)
  }, [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap no-print">
        <h1 className="text-2xl font-bold flex-1">Share Rent Report</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <ShareRentReport onPayloadChange={handlePayload} />
    </div>
  )
}
