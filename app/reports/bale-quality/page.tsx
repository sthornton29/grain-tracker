'use client'

import { useCallback, useState } from 'react'
import BaleQualityReport from '@/components/reports/bale-quality-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function BaleQualityPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Bale Quality Summary', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => { setBuildPayload(() => fn) }, [])
  return (
    <div className="space-y-4">
      <BaleQualityReport onPayloadChange={handlePayload} headerActions={<ExportBar buildPayload={() => buildPayload()} />} />
      <p className="text-sm text-slate-600 no-print max-w-2xl">
        The quality package per field: bales, lint pounds, weighted average loan value, and the color grade, staple,
        mic, and strength breakdowns — the sheet you show buyers.
      </p>
    </div>
  )
}
