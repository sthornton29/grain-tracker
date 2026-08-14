'use client'

import { useState } from 'react'
import SimpleCrud from '@/components/simple-crud'
import CsvImport from '@/components/csv-import'
import SettingsDocImport from '@/components/settings-doc-import'

export default function Page() {
  const [nonce, setNonce] = useState(0)
  return (
    <div className="space-y-4">
      <SettingsDocImport primaryTarget="trucks" title="Upload a Truck List (AI)" onSaved={() => setNonce((n) => n + 1)} />
      <CsvImport
        config={{
          tableName: 'trucks',
          uniqueKey: 'name_or_number',
          columns: [{ key: 'name_or_number', label: 'name', required: true }],
        }}
        onImported={() => setNonce((n) => n + 1)}
      />
      <SimpleCrud key={nonce} title="Trucks" table="trucks" labelColumn="name_or_number" placeholder="Truck name or number" />
    </div>
  )
}
