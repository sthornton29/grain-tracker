'use client'

import { useRouter, usePathname } from 'next/navigation'

// The inventory page is server-rendered from its query string; these selects
// apply on change (no separate Apply tap) by pushing the new query. Labelled
// and 44px tall for the iPad in the truck.

type Option = { value: string; label: string }

export default function InventoryFilters({
  entityId, siteId, cropId, entities, sites, crops,
}: {
  entityId: string
  siteId: string
  cropId: string
  entities: Option[]
  sites: Option[]
  crops: Option[]
}) {
  const router = useRouter()
  const pathname = usePathname()

  function apply(next: { entity?: string; site?: string; crop?: string }) {
    const params = new URLSearchParams()
    const entity = next.entity ?? entityId
    // A site belongs to one entity; changing the entity clears a site that
    // would no longer be in the list.
    const site = next.entity != null && next.entity !== entityId ? '' : (next.site ?? siteId)
    const crop = next.crop ?? cropId
    if (entity) params.set('entity', entity)
    if (site) params.set('site', site)
    if (crop) params.set('crop', crop)
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const selectCls = 'rounded-lg border border-slate-300 px-3 min-h-11 bg-white text-base sm:text-sm'
  const labelCls = 'flex flex-col gap-1 text-xs text-slate-600 flex-1 sm:flex-none min-w-[9rem]'

  return (
    <div className="flex flex-wrap items-end gap-2 no-print">
      <label className={labelCls}>
        Entity
        <select value={entityId} onChange={(e) => apply({ entity: e.target.value })} className={selectCls}>
          <option value="">All entities</option>
          {entities.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className={labelCls}>
        Site
        <select value={siteId} onChange={(e) => apply({ site: e.target.value })} className={selectCls}>
          <option value="">All sites</option>
          {sites.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className={labelCls}>
        Crop
        <select value={cropId} onChange={(e) => apply({ crop: e.target.value })} className={selectCls}>
          <option value="">All crops</option>
          {crops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    </div>
  )
}
