'use client'

import { useState } from 'react'
import YieldsByLandowner from '@/components/reports/yields-by-landowner'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export default function YieldsByLandownerReport() {
  // The component sends up a fresh builder whenever filters or data change.
  // Default to an empty payload until the first build lands.
  const [buildPayload, setBuildPayload] = useState<() => ExportPayload>(
    () => () => ({ title: 'Yields by Landowner', sections: [{ columns: [], rows: [] }] }),
  )

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap no-print">
        <h1 className="text-2xl font-bold flex-1">Yields by Landowner</h1>
        <ExportBar buildPayload={() => buildPayload()} />
      </div>
      <YieldsByLandowner onPayloadChange={(fn) => setBuildPayload(() => fn)} />
    </div>
  )
}
