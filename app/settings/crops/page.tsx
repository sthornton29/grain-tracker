'use client'

import { useState } from 'react'
import SimpleCrud from '@/components/simple-crud'
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
          ],
        }}
        onImported={() => setNonce((n) => n + 1)}
      />
      <SimpleCrud key={nonce} title="Crops" table="crops" labelColumn="name" placeholder="Crop name" />
    </div>
  )
}
