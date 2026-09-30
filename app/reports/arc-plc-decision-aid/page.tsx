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
      <ArcPlcDecisionAid onPayloadChange={handlePayload} headerActions={<ExportBar buildPayload={() => buildPayload()} />} />
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Compare what PLC and ARC-CO would pay per farm and commodity before you elect. Slide the marketing-year price
        assumption to see how PLC moves, then set your election.{' '}
        <Link href="/settings/government-payments" className="text-brand-deep underline">Manage base acres &amp; prices →</Link>
      </p>
    </div>
  )
}
