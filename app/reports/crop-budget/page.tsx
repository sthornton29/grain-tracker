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
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Crop Budget Planner</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        Pre-season budgeting for next crop year: build whole-farm allocation scenarios (acres × yield × price × cost →
        profit), duplicate a plan to explore alternatives, and open a simple price × yield matrix per crop. Budgets are
        a sandbox — nothing here touches your marketing assumptions or actuals. For the in-season picture with
        contracts and insurance, see{' '}
        <Link href="/reports/income-sensitivity" className="text-sky-700 underline">Income Sensitivity →</Link>
      </p>
      <CropBudgetReport onPayloadChange={handlePayload} />
    </div>
  )
}
