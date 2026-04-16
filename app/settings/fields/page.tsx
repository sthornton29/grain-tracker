'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import { buildDoubleCropSoySet } from '@/lib/plantings'
import type { Crop, Farm, Field, FieldPlanting } from '@/lib/types'

export default function FieldsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [name, setName] = useState('')
  const [farmId, setFarmId] = useState('')
  const [totalAcres, setTotalAcres] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editFarmId, setEditFarmId] = useState('')
  const [editAcres, setEditAcres] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<'name' | 'farm' | 'acres'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  async function refresh() {
    const [fa, fi, cr, pl] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*').order('season_year', { ascending: false }),
    ])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  function parseAcres(v: string): number | null {
    if (v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    const { error } = await supabase.from('fields').insert({
      name_or_number: name.trim(),
      farm_id: farmId || null,
      total_acres: parseAcres(totalAcres),
    })
    if (error) { setErr(error.message); return }
    setName(''); setTotalAcres(''); setErr(null); refresh()
  }

  async function save(id: string) {
    const { error } = await supabase.from('fields').update({
      name_or_number: editName.trim(),
      farm_id: editFarmId || null,
      total_acres: parseAcres(editAcres),
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this field? All of its plantings will also be deleted.')) return
    const { error } = await supabase.from('fields').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const farmName = (id: string | null) => farms.find((f) => f.id === id)?.name ?? ''
  const cropName = (id: string) => crops.find((c) => c.id === id)?.name ?? '—'
  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const doubleCropSoyIds = useMemo(
    () => buildDoubleCropSoySet(plantings, cropById),
    [plantings, cropById],
  )
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Fields</h1>
        <Link href="/settings/plantings" className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
          Manage plantings →
        </Link>
      </div>

      <CsvImport
        config={{
          tableName: 'fields',
          uniqueKey: 'name_or_number',
          columns: [
            { key: 'name_or_number', label: 'name', required: true },
            { key: 'farm_id', label: 'farm', fk: { table: 'farms', matchColumn: 'name' } },
            { key: 'total_acres', type: 'number' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_120px_auto] gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Field name or number"
          className={inputCls}
        />
        <select value={farmId} onChange={(e) => setFarmId(e.target.value)} className={inputCls}>
          <option value="">— farm (optional) —</option>
          {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <input
          type="number"
          step="0.01"
          value={totalAcres}
          onChange={(e) => setTotalAcres(e.target.value)}
          placeholder="Acres"
          className={inputCls}
        />
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          placeholder="Search fields…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 flex-1 min-w-[12rem]"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as 'name' | 'farm' | 'acres')}
          className="text-sm rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="name">Sort: Name</option>
          <option value="farm">Sort: Farm</option>
          <option value="acres">Sort: Acres</option>
        </select>
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
        >
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {(() => {
        const visible = fields
          .filter((f) => {
            if (!q) return true
            const hay = [f.name_or_number, farmName(f.farm_id), f.total_acres != null ? String(f.total_acres) : ''].join(' ').toLowerCase()
            return hay.includes(q.toLowerCase())
          })
          .sort((a, b) => {
            const dir = sortDir === 'asc' ? 1 : -1
            if (sortKey === 'farm') return dir * (farmName(a.farm_id) || '').localeCompare(farmName(b.farm_id) || '')
            if (sortKey === 'acres') {
              const av = a.total_acres ?? -1; const bv = b.total_acres ?? -1
              return dir * (Number(av) - Number(bv))
            }
            return dir * a.name_or_number.localeCompare(b.name_or_number)
          })
        return (
      <ul className="bg-white rounded-xl shadow divide-y">
        {visible.length === 0 && <li className="px-4 py-6 text-center text-slate-400">{fields.length === 0 ? 'No fields yet.' : 'No fields match.'}</li>}
        {visible.map((f) => {
          const fieldPlantings = plantings.filter((p) => p.field_id === f.id)
          const isExpanded = expandedId === f.id
          return (
            <li key={f.id} className="px-4 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                {editingId === f.id ? (
                  <>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className={`flex-1 min-w-0 ${inputCls}`}
                    />
                    <select
                      value={editFarmId}
                      onChange={(e) => setEditFarmId(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">— no farm —</option>
                      {farms.map((fm) => <option key={fm.id} value={fm.id}>{fm.name}</option>)}
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      value={editAcres}
                      onChange={(e) => setEditAcres(e.target.value)}
                      placeholder="Acres"
                      className={`w-24 ${inputCls}`}
                    />
                    <button onClick={() => save(f.id)} className="text-green-700 font-semibold">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="flex-1">
                      {f.name_or_number}
                      {f.farm_id && <span className="text-slate-400 text-sm"> · {farmName(f.farm_id)}</span>}
                      {f.total_acres != null && <span className="text-slate-400 text-sm"> · {Number(f.total_acres)} ac</span>}
                    </span>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : f.id)}
                      className="text-slate-600 text-sm"
                    >
                      {isExpanded ? 'Hide' : `Plantings (${fieldPlantings.length})`}
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(f.id)
                        setEditName(f.name_or_number)
                        setEditFarmId(f.farm_id ?? '')
                        setEditAcres(f.total_acres != null ? String(f.total_acres) : '')
                      }}
                      className="text-sky-700"
                    >Edit</button>
                    <button onClick={() => remove(f.id)} className="text-red-600">Delete</button>
                  </>
                )}
              </div>

              {isExpanded && (
                <div className="mt-2 ml-2 border-l-2 border-slate-200 pl-3">
                  {fieldPlantings.length === 0 ? (
                    <p className="text-sm text-slate-400 py-2">
                      No plantings recorded.{' '}
                      <Link href="/settings/plantings" className="text-sky-700 underline">Add one</Link>.
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="text-slate-500">
                        <tr>
                          <th className="text-left py-1">Year</th>
                          <th className="text-left py-1">Crop</th>
                          <th className="text-right py-1">Acres</th>
                          <th className="text-left py-1">Planted</th>
                          <th className="text-left py-1"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {fieldPlantings.map((p) => (
                          <tr key={p.id} className="border-t border-slate-100">
                            <td className="py-1">{p.season_year}</td>
                            <td className="py-1">{cropName(p.crop_id)}</td>
                            <td className="py-1 text-right">{Number(p.planted_acres)}</td>
                            <td className="py-1">{p.planting_date ?? ''}</td>
                            <td className="py-1">
                              {doubleCropSoyIds.has(p.id) && (
                                <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">double-crop</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      ) })()}
    </div>
  )
}
