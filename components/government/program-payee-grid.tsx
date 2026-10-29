'use client'

// Payee by program year (0099): farms × program years, each cell the entity
// PAID for that farm's government payments that year. A blank cell means
// "the farm's entity" (farms.entity_id); choosing another entity writes an
// explicit farm_program_payees row, choosing the farm's own entity again
// removes it. The bulk bar sets one program year's payee on every ticked
// farm at once — the 23-farm case the October 2026 statements raised.
// lib/program-payee.ts payeeEntityFor is what every report reads through.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/friendly-error'
import { indexPayees, payeeEntityFor } from '@/lib/program-payee'
import { theadCls, stickyColCls, stickyColHeadCls } from '@/components/reports/report-kit'
import type { Entity, Farm, FarmProgramPayee } from '@/lib/types'

export default function ProgramPayeeGrid({
  farms, entities, payees, years, onChanged,
}: {
  farms: Farm[]
  entities: Entity[]
  payees: FarmProgramPayee[]
  /** The program years to show as columns (descending). */
  years: number[]
  onChanged: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkYear, setBulkYear] = useState<number>(years[0] ?? new Date().getFullYear())
  const [bulkEntity, setBulkEntity] = useState('')
  const idx = useMemo(() => indexPayees(payees), [payees])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  // Historical (archived) entities stay pickable HERE — a past program year's
  // payee is exactly the kind of entity that gets archived.
  const pickable = useMemo(() => [...entities].sort((a, b) => a.name.localeCompare(b.name)), [entities])
  const shownFarms = useMemo(() => farms.filter((f) => !f.archived_at).sort((a, b) => a.name.localeCompare(b.name)), [farms])

  async function setPayee(farmId: string, year: number, entityId: string) {
    setErr(null)
    const farm = farms.find((f) => f.id === farmId)
    const isDefault = !entityId || entityId === (farm?.entity_id ?? '')
    const { error } = isDefault
      ? await supabase.from('farm_program_payees').delete().eq('farm_id', farmId).eq('program_year', year)
      : await supabase.from('farm_program_payees').upsert({ farm_id: farmId, program_year: year, entity_id: entityId, updated_at: new Date().toISOString() }, { onConflict: 'org_id,farm_id,program_year' })
    if (error) { setErr(reportError(error, { action: 'save the payee', noun: 'payee' })); return }
    onChanged()
  }

  async function applyBulk() {
    if (selected.size === 0 || !bulkEntity) return
    setBusy(true); setErr(null)
    try {
      const ids = [...selected]
      const defaults = ids.filter((id) => farms.find((f) => f.id === id)?.entity_id === bulkEntity)
      const explicit = ids.filter((id) => !defaults.includes(id))
      if (defaults.length > 0) {
        const { error } = await supabase.from('farm_program_payees').delete().eq('program_year', bulkYear).in('farm_id', defaults)
        if (error) throw error
      }
      if (explicit.length > 0) {
        const now = new Date().toISOString()
        const { error } = await supabase.from('farm_program_payees').upsert(
          explicit.map((farm_id) => ({ farm_id, program_year: bulkYear, entity_id: bulkEntity, updated_at: now })),
          { onConflict: 'org_id,farm_id,program_year' },
        )
        if (error) throw error
      }
      setSelected(new Set())
      onChanged()
    } catch (e) {
      setErr(reportError(e as Error, { action: 'save the payees', noun: 'payee' }))
    } finally {
      setBusy(false)
    }
  }

  const allSelected = shownFarms.length > 0 && shownFarms.every((f) => selected.has(f.id))
  const selectCls = 'rounded-lg border border-slate-300 px-2 min-h-10 bg-white text-sm max-w-[14rem]'

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Who was paid for each farm, by program year. A program year&apos;s ARC/PLC lands the following October, and the payee
        is whoever operated the farm that year — the reports, payment limits and entity filters follow this grid, year by
        year. A blank cell means the farm&apos;s own entity.
      </p>
      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <span className="text-sm font-semibold text-slate-700">Set program year</span>
        <select value={bulkYear} onChange={(e) => setBulkYear(Number(e.target.value))} className={selectCls} aria-label="Program year">
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="text-sm font-semibold text-slate-700">payee to</span>
        <select value={bulkEntity} onChange={(e) => setBulkEntity(e.target.value)} className={selectCls} aria-label="Payee entity">
          <option value="">— choose an entity —</option>
          {pickable.map((e) => <option key={e.id} value={e.id}>{e.name}{e.archived_at ? ' (archived)' : ''}</option>)}
        </select>
        <button
          type="button"
          onClick={applyBulk}
          disabled={busy || selected.size === 0 || !bulkEntity}
          className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold disabled:opacity-50"
        >
          Apply to {selected.size} selected farm{selected.size === 1 ? '' : 's'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead className={theadCls}>
            <tr>
              <th className="px-2 py-1 text-left">
                <input type="checkbox" aria-label="Select every farm" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(shownFarms.map((f) => f.id)))} className="h-5 w-5" />
              </th>
              <th className={`text-left px-2 py-1 ${stickyColHeadCls}`}>Farm</th>
              <th className="text-left px-2 py-1">FSA #</th>
              <th className="text-left px-2 py-1">Farm&apos;s entity</th>
              {years.map((y) => <th key={y} className="text-left px-2 py-1 whitespace-nowrap">{y} payee</th>)}
            </tr>
          </thead>
          <tbody>
            {shownFarms.length === 0 && <tr><td colSpan={4 + years.length} className="px-3 py-6 text-center text-slate-400">No farms yet.</td></tr>}
            {shownFarms.map((f) => (
              <tr key={f.id} className="border-t border-slate-100">
                <td className="px-2 py-1">
                  <input type="checkbox" aria-label={`Select ${f.name}`} checked={selected.has(f.id)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n })} className="h-5 w-5" />
                </td>
                <td className={`px-2 py-1 font-semibold ${stickyColCls}`}>{f.name}</td>
                <td className="px-2 py-1 tabular-nums text-xs">{f.fsa_number ?? ''}</td>
                <td className="px-2 py-1 text-slate-600">{f.entity_id ? entityById.get(f.entity_id)?.name ?? '—' : <span className="text-amber-700">none</span>}</td>
                {years.map((y) => {
                  const explicit = idx.byKey.get(`${f.id}|${y}`) ?? ''
                  const resolved = payeeEntityFor(f, y, idx)
                  return (
                    <td key={y} className="px-2 py-1">
                      <select
                        value={explicit}
                        onChange={(e) => setPayee(f.id, y, e.target.value)}
                        className={`${selectCls} ${explicit ? 'border-brand font-semibold' : 'text-slate-500'}`}
                        aria-label={`${f.name} payee for program year ${y}`}
                        title={resolved ? `${y}: ${entityById.get(resolved)?.name ?? ''}` : undefined}
                      >
                        <option value="">{f.entity_id ? `${entityById.get(f.entity_id)?.name ?? 'farm entity'} (farm's entity)` : '— none —'}</option>
                        {pickable.filter((e) => e.id !== f.entity_id).map((e) => <option key={e.id} value={e.id}>{e.name}{e.archived_at ? ' (archived)' : ''}</option>)}
                      </select>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
