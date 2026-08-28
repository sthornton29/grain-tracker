'use client'

import { useCallback, useState } from 'react'
import DryerMathReport from '@/components/reports/dryer-math-report'
import DiscountScheduleImport from '@/components/discount-schedule-import'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function DryerMathPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Grain Dryer Math', sections: [{ columns: [], rows: [] }] }),
  )
  const [schedulesVersion, setSchedulesVersion] = useState(0)
  const handlePayload = useCallback((fn: () => ExportPayload) => {
    setBuildPayload(() => fn)
  }, [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Grain Dryer Math</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        What it costs to take a point of moisture out — and what it costs to take out one too many. Pick your dryer,
        set fuel and grain prices, and read the answer per bushel; attach a buyer&rsquo;s discount schedule to see
        whether drying beats hauling it wet.
      </p>
      <DryerMathReport onPayloadChange={handlePayload} schedulesVersion={schedulesVersion} />
      <DiscountScheduleImport onChanged={() => setSchedulesVersion((v) => v + 1)} />
    </div>
  )
}
