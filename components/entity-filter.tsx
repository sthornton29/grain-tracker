'use client'

// A compact entity selector. Crop insurance and government payments are both
// scoped to an entity, so multi-entity operations need to filter by entity.
// Renders nothing when there's one (or zero) entity — single-entity operations
// shouldn't see a pointless dropdown.

import type { Entity } from '@/lib/types'

export default function EntityFilter({
  entities, value, onChange, allLabel = 'All entities', className,
}: {
  entities: Entity[]
  value: string
  onChange: (v: string) => void
  allLabel?: string
  className?: string
}) {
  if (entities.length <= 1) return null
  return (
    <label className={`text-sm flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-slate-500">Entity</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 bg-white">
        <option value="">{allLabel}</option>
        {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
    </label>
  )
}
