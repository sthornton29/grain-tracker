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
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Bale Quality Summary</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-2xl">
        The HVI quality package per field: bales, lint pounds, weighted average loan value, and the color grade /
        staple / mic / strength distributions — the sheet a producer shows buyers. Cotton module.
      </p>
      <BaleQualityReport onPayloadChange={handlePayload} />
    </div>
  )
}
