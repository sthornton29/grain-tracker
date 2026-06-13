'use client'

import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

// Thin client wrapper so the server-rendered load detail can hand a ready-built
// payload to <ExportBar> (which needs a () => payload function and the dynamic
// jsPDF/SheetJS imports). Gives the same Export PDF / Excel / Print buttons the
// reports use, so the load document exports exactly like the rest of the app.
export default function LoadPdfBar({ payload }: { payload: ExportPayload }) {
  return <ExportBar buildPayload={() => payload} />
}
