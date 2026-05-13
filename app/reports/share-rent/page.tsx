'use client'

import { useState } from 'react'
import ShareRentReport from '@/components/reports/share-rent-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function ShareRentReportPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Share Rent Report', sections: [{ columns: [], rows: [] }] }),
  )
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap no-print">
        <h1 className="text-2xl font-bold flex-1">Share Rent Report</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <ShareRentReport onPayloadChange={(fn) => setBuildPayload(() => fn)} />
    </div>
  )
}
