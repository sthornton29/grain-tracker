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
      <DryerMathReport onPayloadChange={handlePayload} headerActions={<ExportBar buildPayload={() => buildPayload()} />} />
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Crop, fuel, fuel price — the table answers what drying to base costs per bushel at every incoming moisture
        (fuel, fan, and dryer wear) and what taking out one point too many gives away. Everything else lives behind
        the ⚙ Assumptions button.
      </p>
    </div>
  )
}
