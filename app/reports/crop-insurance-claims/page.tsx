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
      <CropInsuranceClaimsReport onPayloadChange={handlePayload} headerActions={<ExportBar buildPayload={() => buildPayload()} />} />
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        What each policy would pay at your current yields and the running harvest-price estimate, after the premium
        you paid. For price and yield what-ifs, use the{' '}
        <Link href="/reports/income-sensitivity" className="text-brand-deep underline">Income Sensitivity report →</Link>
      </p>
    </div>
  )
}
