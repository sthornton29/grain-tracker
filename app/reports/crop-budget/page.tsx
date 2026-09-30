'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import CropBudgetReport from '@/components/reports/crop-budget-report'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function CropBudgetPage() {
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Crop Budget Planner', sections: [{ columns: [], rows: [] }] }),
  )
  const handlePayload = useCallback((fn: () => ExportPayload) => setBuildPayload(() => fn), [])
  return (
    <div className="space-y-4">
      <CropBudgetReport onPayloadChange={handlePayload} headerActions={<ExportBar buildPayload={() => buildPayload()} />} />
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Plan next year: acres, yield, price, and cost per crop, with a price-by-yield table for each. Budgets are a
        sandbox — nothing here touches your marketing assumptions or actual numbers. For the in-season picture with
        contracts and insurance, see{' '}
        <Link href="/reports/income-sensitivity" className="text-brand-deep underline">Income Sensitivity →</Link>
      </p>
    </div>
  )
}
