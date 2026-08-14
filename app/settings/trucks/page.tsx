'use client'

import { useState } from 'react'
import SimpleCrud from '@/components/simple-crud'
import CsvImport from '@/components/csv-import'
import { trucksImportConfig } from '@/lib/import-configs'
import SettingsDocImport from '@/components/settings-doc-import'

export default function Page() {
  const [nonce, setNonce] = useState(0)
  return (
    <div className="space-y-4">
      <SettingsDocImport primaryTarget="trucks" title="Upload a Truck List (AI)" onSaved={() => setNonce((n) => n + 1)} />
      <CsvImport config={trucksImportConfig()} onImported={() => setNonce((n) => n + 1)} />
      <SimpleCrud key={nonce} title="Trucks" table="trucks" labelColumn="name_or_number" placeholder="Truck name or number" />
      {/* Hauler trucks (067): OTHER PEOPLE'S trucks saved from pickup-contract
          loads — kept strictly separate from the operation's own trucks. */}
      <div className="space-y-1">
        <SimpleCrud title="Hauler Trucks" table="external_trucks" labelColumn="name" placeholder="Hauler truck name or number" />
        <p className="text-xs text-slate-500">
          Trucks that belong to buyers or hired haulers, saved from pickup-contract loads. They show up in the load form&rsquo;s
          &ldquo;Hauler trucks&rdquo; list, never in your own truck list. Renaming or deleting one here doesn&rsquo;t change loads already entered.
        </p>
      </div>
    </div>
  )
}
