'use client'

import { useState } from 'react'
import CropsEditor from '@/components/crops-editor'
import CsvImport from '@/components/csv-import'

export default function Page() {
  const [nonce, setNonce] = useState(0)
  return (
    <div className="space-y-4">
      <CsvImport
        config={{
          tableName: 'crops',
          uniqueKey: 'name',
          columns: [
            { key: 'name', required: true },
            { key: 'base_moisture_pct', type: 'number' },
            { key: 'base_lb_per_bushel', type: 'number' },
            { key: 'harvest_category', enum: ['fall', 'spring'], default: 'fall' },
          ],
        }}
        onImported={() => setNonce((n) => n + 1)}
      />
      <CropsEditor key={nonce} />
    </div>
  )
}
