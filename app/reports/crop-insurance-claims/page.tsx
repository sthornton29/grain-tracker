'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import CropInsuranceClaimsReport from '@/components/reports/crop-insurance-claims-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function CropInsuranceClaimsPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Crop Insurance Claims Monitor', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => setBuildPayload(() => fn), [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Crop Insurance Claims Monitor</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Estimated indemnity for each RP / RP-HPE / YP policy (with SCO and ECO endorsements) at your current
        per-practice yields and the running harvest-price estimate, netted against premium paid. For price and yield
        scenarios, use the{' '}
        <Link href="/reports/income-sensitivity" className="text-brand-deep underline">Income Sensitivity Report →</Link>{' '}
        <Link href="/settings/crop-insurance" className="text-brand-deep underline">Manage policies →</Link>
      </p>
      <CropInsuranceClaimsReport onPayloadChange={handlePayload} />
    </div>
  )
}
