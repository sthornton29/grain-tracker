'use client'

import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

// Adapts a SERVER-built ExportPayload (plain data) to the client ExportBar.
// Server components (Contract Tracker, Unpaid Loads, …) compute the payload —
// just data, fully serializable since cells are strings/numbers and column
// formats are enum strings — and hand it here for the same PDF/Excel/Print bar.
export default function StaticExportBar({ payload, className }: { payload: ExportPayload; className?: string }) {
  return <ExportBar buildPayload={() => payload} className={className} />
}
