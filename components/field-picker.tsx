'use client'

// FieldPicker — the searchable field selector used everywhere a load-entry
// flow picks a field (New/Edit Load single field, split-load rows, Yield
// from Combine). Replaces the native <select>: with a few hundred fields a
// dropdown is unusable, so the trigger opens a panel with a SEARCH BOX
// visible at the top and the farm→field grouping underneath. Search matches
// field name AND farm name (lib/field-search): "saun" finds every field on
// Big Saunders, and a farm name narrows to that farm's fields. Group headers
// carry the farm name, so a match is never ambiguous between farms.
//
// AUTOFOCUS: desktop only (fine pointer). On an iPad the keyboard popping up
// unprompted covers half the list — there the search focuses on tap.
//
// MODAL PLACEMENT: like the truck-picker modals, the panel is PORTALED to
// document.body. These pickers sit inside the load form's <label>s — rendered
// in place, a tap on the panel's padding would forward a click to the label's
// control (label activation), and jsdom can't catch that regression. The
// portal removes it structurally.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { groupFieldsByFarm, type FieldSearchFarm, type FieldSearchField } from '@/lib/field-search'

export function FieldPicker({
  value,
  onChange,
  fields,
  farms,
  placeholder = '— select field —',
  className,
}: {
  value: string
  onChange: (id: string) => void
  /** Already filtered by the caller (crop/year plantings etc.). */
  fields: FieldSearchField[]
  farms: FieldSearchFarm[]
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // Portal target only exists client-side; the panel opens on interaction,
  // so the first client render is always in time.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const selected = fields.find((f) => f.id === value) ?? null
  const selectedFarmName = selected?.farm_id ? farmById.get(selected.farm_id)?.name ?? null : null

  const groups = useMemo(() => groupFieldsByFarm(fields, farms, query), [fields, farms, query])
  const matchCount = groups.reduce((a, g) => a + g.fields.length, 0)

  function openPanel() {
    setQuery('')
    setOpen(true)
  }
  function close() {
    setOpen(false)
    setQuery('')
  }
  function pick(id: string) {
    onChange(id)
    close()
  }

  // Desktop gets the cursor ready to type; on touch (coarse pointer) the
  // keyboard would pop up over the list, so focus waits for a tap.
  useEffect(() => {
    if (!open) return
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches) {
      searchRef.current?.focus()
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        className={`${className ?? 'w-full rounded-lg border border-slate-300 px-3 py-2 bg-white'} flex items-center justify-between gap-2 text-left`}
      >
        {selected ? (
          <span className="truncate">
            {selected.name_or_number}
            {selectedFarmName && <span className="text-slate-500"> · {selectedFarmName}</span>}
          </span>
        ) : (
          <span className="text-slate-500">{placeholder}</span>
        )}
        <span aria-hidden className="text-slate-400 shrink-0 text-xs">▾</span>
      </button>
      {open && mounted && createPortal(
        <div
          className="fixed inset-0 z-30 bg-black/40 flex items-end sm:items-center justify-center sm:p-4 no-print"
          onClick={close}
        >
          <div
            className="bg-white rounded-t-xl sm:rounded-xl shadow-xl w-full max-w-md flex flex-col max-h-[85vh] sm:max-h-[70vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 pb-2 border-b border-slate-200 flex items-center gap-2">
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') close() }}
                placeholder="Search fields or farms…"
                aria-label="Search fields or farms"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-base bg-white"
              />
              <button
                type="button"
                onClick={close}
                className="rounded-lg bg-white border border-slate-300 px-3 py-2.5 text-sm text-slate-600"
              >
                Cancel
              </button>
            </div>
            <div className="overflow-y-auto overscroll-contain p-2">
              {value && !query && (
                <button
                  type="button"
                  onClick={() => pick('')}
                  className="w-full text-left rounded-lg px-3 py-2.5 text-sm text-slate-500 hover:bg-slate-50"
                >
                  {placeholder} <span className="text-slate-400">(clear)</span>
                </button>
              )}
              {groups.map((g) => (
                <div key={g.farmId ?? 'none'}>
                  <div className="px-3 pt-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {g.farmName}
                  </div>
                  {g.fields.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => pick(f.id)}
                      className={`w-full text-left rounded-lg px-3 py-2.5 text-base flex items-center justify-between gap-2 ${
                        f.id === value ? 'bg-brand/10 text-brand-deep font-semibold' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className="truncate">{f.name_or_number}</span>
                      {f.id === value && <span aria-hidden className="shrink-0">✓</span>}
                    </button>
                  ))}
                </div>
              ))}
              {matchCount === 0 && (
                <p className="px-3 py-4 text-sm text-slate-500">
                  {query ? <>No fields or farms match “{query}”.</> : 'No fields to choose from.'}
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
