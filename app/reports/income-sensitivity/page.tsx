'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import IncomeSensitivityReport from '@/components/reports/income-sensitivity-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function IncomeSensitivityPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Income Sensitivity', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => setBuildPayload(() => fn), [])
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Income Sensitivity</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        One futures-price × yield table per crop: revenue or net profit per acre in every scenario. Contracted bushels
        stay at their locked prices, harvested bushels are fixed facts, crop insurance re-runs net of premium in every
        cell, and government payments can be layered on as a flat $/acre.{' '}
        <Link href="/reports/crop-insurance-claims" className="text-brand-deep underline">Claims Monitor →</Link>
      </p>
      <IncomeSensitivityReport onPayloadChange={handlePayload} />
    </div>
  )
}
