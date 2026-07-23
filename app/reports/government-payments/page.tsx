'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import GovernmentPaymentsReport from '@/components/reports/government-payments-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function GovernmentPaymentsReportPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Government Payment Tracker', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => setBuildPayload(() => fn), [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Government Payment Tracker</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Projected ARC/PLC payments per farm and commodity plus other USDA payments, with per-entity payment-limit
        tracking.{' '}
        <Link href="/settings/government-payments" className="text-brand-deep underline">Manage base acres &amp; elections →</Link>
      </p>
      <GovernmentPaymentsReport onPayloadChange={handlePayload} />
    </div>
  )
}
