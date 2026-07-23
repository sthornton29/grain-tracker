'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import ArcPlcDecisionAid from '@/components/reports/arc-plc-decision-aid'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function ArcPlcDecisionAidPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'ARC/PLC Decision Aid', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => setBuildPayload(() => fn), [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">ARC/PLC Decision Aid</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Compare projected PLC vs ARC-CO payments per farm and commodity before electing. Slide the MYA assumption to
        see how PLC moves, then set your election.{' '}
        <Link href="/settings/government-payments" className="text-brand-deep underline">Manage base acres &amp; prices →</Link>
      </p>
      <ArcPlcDecisionAid onPayloadChange={handlePayload} />
    </div>
  )
}
