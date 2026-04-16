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
          tableName: 'buyers',
          uniqueKey: 'name',
          columns: [{ key: 'name', required: true }],
        }}
        onImported={() => setNonce((n) => n + 1)}
      />
      <SimpleCrud key={nonce} title="Buyers" table="buyers" labelColumn="name" placeholder="Buyer name" />
    </div>
  )
}
