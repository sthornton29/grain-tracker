'use client'

// The tracker's filter row. The controls show what the user picked the moment
// they pick it (local state), the URL follows in a transition, and the server
// page re-renders the table from that URL. Several quick changes accumulate
// on the latest local values — never on stale props — so the last URL always
// carries every choice. Once the navigation settles the local state re-syncs
// from the URL, so the controls and the table are read from the same place.

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FilterField, ReportFilterBar, selectCls } from '@/components/reports/report-kit'
import {
  activeContractFilterCount, clearContractFilterCookie, serializeContractFilters, writeContractFilterCookie,
  type ContractFilterValues,
} from '@/lib/contract-filters'
import { CONTRACT_TYPE_LABEL } from '@/lib/contracts'

export type { ContractFilterValues }

export default function ContractFilters({
  values, entities, crops, cropYearOptions,
}: {
  values: ContractFilterValues
  entities: Array<{ id: string; name: string }>
  crops: Array<{ id: string; name: string }>
  cropYearOptions: number[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [local, setLocal] = useState<ContractFilterValues>(values)
  const latest = useRef<ContractFilterValues>(values)
  const urlKey = serializeContractFilters(values)

  // The URL is the truth once nothing is in flight (a finished navigation,
  // the back button, a restored bookmark).
  useEffect(() => {
    if (pending) return
    const fromUrl = values
    latest.current = fromUrl
    setLocal(fromUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey, pending])

  function navigate(v: ContractFilterValues) {
    latest.current = v
    setLocal(v)
    const qs = serializeContractFilters(v)
    // The cookie must be gone BEFORE a bare /contracts is requested, or the
    // server would restore the very filters being cleared.
    if (qs) writeContractFilterCookie(qs)
    else clearContractFilterCookie()
    startTransition(() => router.push(qs ? `/contracts?${qs}` : '/contracts', { scroll: false }))
  }

  function apply(patch: Partial<ContractFilterValues>) {
    navigate({ ...latest.current, ...patch })
  }

  const active = activeContractFilterCount(local)
  const toggleCls = (on: boolean) => `rounded-lg border px-3 min-h-10 text-sm font-semibold ${on ? 'border-slate-700 bg-slate-700 text-white' : 'border-slate-300 bg-white text-slate-500'}`

  return (
    <div aria-busy={pending}>
      <ReportFilterBar activeCount={active}>
        <FilterField label="Entity">
          <select value={local.entity} onChange={(e) => apply({ entity: e.target.value })} className={selectCls}>
            <option value="">All entities</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Crop">
          <select value={local.crop} onChange={(e) => apply({ crop: e.target.value })} className={selectCls}>
            <option value="">All crops</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Crop year">
          <select value={local.crop_year} onChange={(e) => apply({ crop_year: e.target.value })} className={selectCls}>
            <option value="">All crop years</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </FilterField>
        <FilterField label="Type">
          <select value={local.type} onChange={(e) => apply({ type: e.target.value })} className={selectCls}>
            <option value="">All types</option>
            <option value="forward">{CONTRACT_TYPE_LABEL.forward}</option>
            <option value="hta">{CONTRACT_TYPE_LABEL.hta}</option>
            <option value="basis">{CONTRACT_TYPE_LABEL.basis}</option>
            <option value="seed">Seed</option>
          </select>
        </FilterField>
        <FilterField label="Pricing">
          <select value={local.pricing} onChange={(e) => apply({ pricing: e.target.value })} className={selectCls}>
            <option value="">All pricing</option>
            <option value="fully_priced">Fully priced</option>
            <option value="awaiting_basis">Awaiting basis</option>
            <option value="awaiting_futures">Awaiting futures</option>
          </select>
        </FilterField>
        <div className="text-sm flex flex-col gap-1" role="group" aria-label="Show">
          <span className="text-slate-500">Show</span>
          <div className="flex gap-1 flex-wrap">
            <button type="button" onClick={() => apply({ hide_completed: !local.hide_completed })} aria-pressed={!local.hide_completed} className={toggleCls(!local.hide_completed)}>
              Completed
            </button>
            <button type="button" onClick={() => apply({ hide_future: !local.hide_future })} aria-pressed={!local.hide_future} className={toggleCls(!local.hide_future)}>
              Not open yet
            </button>
          </div>
        </div>
        {active > 0 && (
          <button
            type="button"
            onClick={() => navigate({ ...latest.current, entity: '', crop: '', crop_year: '', type: '', pricing: '', hide_completed: false, hide_future: false })}
            className="rounded-lg border border-slate-300 px-3 min-h-10 inline-flex items-center text-sm text-slate-600 hover:bg-slate-50"
          >
            Clear filters
          </button>
        )}
        {pending && (
          <span className="text-xs text-slate-500 self-center" role="status" aria-live="polite">Updating the list…</span>
        )}
      </ReportFilterBar>
    </div>
  )
}
