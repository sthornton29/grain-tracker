'use client'

import { useCallback, useState } from 'react'
import BuyerDiscountsReport from '@/components/reports/buyer-discounts-report'
import DiscountScheduleImport from '@/components/discount-schedule-import'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function BuyerDiscountsReportPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Buyer Discount Comparison', sections: [{ columns: [], rows: [] }] }),
  )
  const [refreshKey, setRefreshKey] = useState(0)
  const handlePayload = useCallback((fn: () => ExportPayload) => {
    setBuildPayload(() => fn)
  }, [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Buyer Discount Comparison</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <BuyerDiscountsReport key={refreshKey} onPayloadChange={handlePayload} />
      <DiscountScheduleImport onChanged={() => setRefreshKey((k) => k + 1)} />
    </div>
  )
}
