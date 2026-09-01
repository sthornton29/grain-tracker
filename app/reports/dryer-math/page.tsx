'use client'

import { useCallback, useState } from 'react'
import DryerMathReport from '@/components/reports/dryer-math-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function DryerMathPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Grain Dryer Math', sections: [{ columns: [], rows: [] }] }),
  )
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
        Crop, fuel, fuel price — the table answers what a point of moisture costs to take out, and what taking out
        one too many gives away. Everything else lives behind the ⚙ Assumptions panel.
      </p>
      <DryerMathReport onPayloadChange={handlePayload} />
    </div>
  )
}
