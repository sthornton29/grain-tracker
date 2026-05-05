'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import type { Entity, Farm, Field, FieldPlanting, County } from '@/lib/types'

type Row = {
  id: string
  date: string
  time: string | null
  ticket_number: string | null
  crop_year: number | null
  to_buyer_id: string | null
  contract_id: string | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null
  moisture: number | null
  test_weight: number | null
  dry_bushels_override: number | null
  from_field_id: string | null
  truck: { name_or_number: string } | null
  crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
  from_field: { name_or_number: string } | null
  from_bin: { name_or_number: string } | null
  to_bin: { name_or_number: string } | null
  to_buyer: { name: string } | null
  contract: { contract_number: string } | null
  from_type: 'field' | 'bin' | null
  to_type: 'bin' | 'buyer' | null
}

type ContractOption = {
  id: string
  contract_number: string
  buyer_id: string | null
  crop_id: string | null
  entity_id: string | null
  crop_year: number | null
  buyer: { name: string } | null
  crop: { name: string } | null
}

const SELECT = `
  id, date, time, ticket_number, crop_year,
  gross_weight, tare_weight, net_weight, moisture, test_weight,
  dry_bushels_override,
  from_type, to_type, from_field_id, to_buyer_id, contract_id,
  truck:trucks(name_or_number),
  crop:crops(name, base_moisture_pct, base_lb_per_bushel),
  from_field:fields!loads_from_field_id_fkey(name_or_number),
  from_bin:bins!loads_from_bin_id_fkey(name_or_number),
  to_bin:bins!loads_to_bin_id_fkey(name_or_number),
  to_buyer:buyers(name),
  contract:contracts(contract_number)
`

function bushelsFor(r: Row) {
  return computeBushels({
    netWeightLb: r.net_weight,
    moisturePct: r.moisture,
    baseMoisturePct: r.crop?.base_moisture_pct ?? null,
    baseLbPerBushel: r.crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: r.dry_bushels_override,
  })
}

function fromLabel(r: Row) {
  if (r.from_type === 'field') return r.from_field?.name_or_number ?? ''
  if (r.from_type === 'bin') return r.from_bin?.name_or_number ?? ''
  return ''
}
function toLabel(r: Row) {
  if (r.to_type === 'bin') return r.to_bin?.name_or_number ?? ''
  if (r.to_type === 'buyer') return r.to_buyer?.name ?? ''
  return ''
}

function csvEscape(v: unknown) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function LoadsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Row[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [contracts, setContracts] = useState<ContractOption[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [entityId, setEntityId] = useState('')
  const [countyId, setCountyId] = useState('')
  const [cropYear, setCropYear] = useState<number | ''>('')
  const [contractId, setContractId] = useState('')
  const [paidTickets, setPaidTickets] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  type SortKey = 'date' | 'ticket' | 'truck' | 'crop' | 'net' | 'dry' | 'moisture'
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir(k === 'date' ? 'desc' : 'asc') }
  }

  async function refresh() {
    setLoading(true)
    let query = supabase.from('loads').select(SELECT).order('date', { ascending: false }).order('time', { ascending: false })
    if (from) query = query.gte('date', from)
    if (to) query = query.lte('date', to)
    const [loadsRes, entitiesRes, farmsRes, fieldsRes, countiesRes, settlementLinesRes, plantingsRes, contractsRes] = await Promise.all([
      query,
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('*'),
      supabase.from('fields').select('*'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('settlement_lines').select('ticket_number'),
      supabase.from('field_plantings').select('season_year'),
      supabase.from('contracts')
        .select('id, contract_number, buyer_id, crop_id, entity_id, crop_year, buyer:buyers(name), crop:crops(name)')
        .order('contract_number'),
    ])
    setRows((loadsRes.data as unknown as Row[]) || [])
    setEntities((entitiesRes.data as Entity[]) || [])
    setFarms((farmsRes.data as Farm[]) || [])
    setFields((fieldsRes.data as Field[]) || [])
    setCounties((countiesRes.data as County[]) || [])
    setPlantings((plantingsRes.data as FieldPlanting[]) || [])
    setContracts((contractsRes.data as unknown as ContractOption[]) || [])
    const tickets = new Set<string>()
    for (const l of (settlementLinesRes.data ?? []) as Array<{ ticket_number: string | null }>) {
      if (l.ticket_number) tickets.add(l.ticket_number.trim().toLowerCase())
    }
    setPaidTickets(tickets)
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [from, to])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

  const fieldEntityId = useMemo(() => {
    const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
    return new Map(fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null]))
  }, [farms, fields])

  const fieldCountyId = useMemo(() => {
    const farmCounty = new Map(farms.map((f) => [f.id, f.county_id]))
    return new Map(
      fields.map((f) => [f.id, f.county_id ?? (f.farm_id ? farmCounty.get(f.farm_id) ?? null : null)]),
    )
  }, [farms, fields])

  // Only counties that actually have at least one farm pointed at them — keeps
  // the filter dropdown focused on the user's operating footprint.
  const countyOptions = useMemo(() => {
    const used = new Set<string>()
    for (const f of farms) if (f.county_id) used.add(f.county_id)
    return counties.filter((c) => used.has(c.id))
  }, [farms, counties])

  // Maps used by the expanded entity filter: a load can match an entity via its
  // field's farm OR via the attached contract's entity OR via any contract that
  // ties the to-buyer to that entity (covers loads that haven't been linked to
  // a specific contract yet).
  const contractEntityById = useMemo(
    () => new Map(contracts.map((c) => [c.id, c.entity_id])),
    [contracts],
  )
  const buyerEntityIds = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const c of contracts) {
      if (!c.buyer_id || !c.entity_id) continue
      const set = m.get(c.buyer_id) ?? new Set<string>()
      set.add(c.entity_id)
      m.set(c.buyer_id, set)
    }
    return m
  }, [contracts])

  // Contract dropdown cascades: respect crop_year (and entity if set) so the
  // list stays manageable. The buyer-filter rule is conditional — there is no
  // buyer filter on this page today, so it's a no-op until one is added.
  const contractOptions = useMemo(() => {
    return contracts.filter((c) => {
      if (cropYear !== '' && c.crop_year !== cropYear) return false
      if (entityId && c.entity_id && c.entity_id !== entityId) return false
      return true
    })
  }, [contracts, cropYear, entityId])

  // If the active contract drops out of the cascade (e.g. user changed crop year),
  // clear the contract filter so we don't silently show zero results.
  useEffect(() => {
    if (contractId && !contractOptions.some((c) => c.id === contractId)) setContractId('')
  }, [contractOptions, contractId])

  const filtered = rows.filter((r) => {
    if (entityId) {
      const fromFieldEntity = r.from_type === 'field' && r.from_field_id
        ? fieldEntityId.get(r.from_field_id) ?? null
        : null
      // If the load has a contract attached, that contract's entity is
      // authoritative — don't fall back to "this buyer also sells to entity X".
      // The buyer fallback only applies to loads not yet linked to a contract.
      let contractAttribution: string | null = null
      let buyerMatches = false
      if (r.contract_id) {
        contractAttribution = contractEntityById.get(r.contract_id) ?? null
      } else if (r.to_buyer_id) {
        const set = buyerEntityIds.get(r.to_buyer_id)
        if (set) buyerMatches = set.has(entityId)
      }
      const matchesEntity =
        fromFieldEntity === entityId
        || contractAttribution === entityId
        || buyerMatches
      if (!matchesEntity) return false
    }
    if (countyId) {
      if (r.from_type !== 'field' || !r.from_field_id) return false
      if (fieldCountyId.get(r.from_field_id) !== countyId) return false
    }
    if (contractId && r.contract_id !== contractId) return false
    if (cropYear !== '' && r.crop_year !== cropYear) return false
    if (!q) return true
    const hay = [
      r.ticket_number, r.truck?.name_or_number, r.crop?.name,
      fromLabel(r), toLabel(r), r.contract?.contract_number, r.date,
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q.toLowerCase())
  })

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const dir = sortDir === 'asc' ? 1 : -1
    const cmp = (a: number | string | null | undefined, b: number | string | null | undefined): number => {
      if (a == null && b == null) return 0
      if (a == null) return 1
      if (b == null) return -1
      if (typeof a === 'number' && typeof b === 'number') return a - b
      return String(a).localeCompare(String(b))
    }
    arr.sort((a, b) => {
      let av: number | string | null, bv: number | string | null
      switch (sortKey) {
        case 'date': av = a.date + ' ' + (a.time ?? ''); bv = b.date + ' ' + (b.time ?? ''); break
        case 'ticket': av = a.ticket_number; bv = b.ticket_number; break
        case 'truck': av = a.truck?.name_or_number ?? null; bv = b.truck?.name_or_number ?? null; break
        case 'crop': av = a.crop?.name ?? null; bv = b.crop?.name ?? null; break
        case 'net': av = a.net_weight; bv = b.net_weight; break
        case 'dry': av = bushelsFor(a).dryBushels; bv = bushelsFor(b).dryBushels; break
        case 'moisture': av = a.moisture; bv = b.moisture; break
      }
      return cmp(av, bv) * dir
    })
    return arr
  }, [filtered, sortKey, sortDir])

  function toggleRow(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleAllVisible() {
    setSelected((s) => {
      const ids = sorted.map((r) => r.id)
      const allOn = ids.every((id) => s.has(id))
      if (allOn) return new Set([...s].filter((id) => !ids.includes(id)))
      const next = new Set(s)
      ids.forEach((id) => next.add(id))
      return next
    })
  }
  async function bulkDelete() {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} load${selected.size === 1 ? '' : 's'}? This cannot be undone.`)) return
    const ids = [...selected]
    const CHUNK = 50
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK)
      const { error } = await supabase.from('loads').delete().in('id', batch)
      if (error) { alert(`Failed after ${i} of ${ids.length}: ${error.message}`); refresh(); return }
    }
    setSelected(new Set())
    refresh()
  }

  function paymentStatus(r: Row): 'paid' | 'unpaid' | null {
    if (r.to_type !== 'buyer') return null
    const t = r.ticket_number?.trim().toLowerCase()
    if (!t) return 'unpaid'
    return paidTickets.has(t) ? 'paid' : 'unpaid'
  }

  async function onDelete(id: string) {
    if (!confirm('Delete this load? This cannot be undone.')) return
    const { error } = await supabase.from('loads').delete().eq('id', id)
    if (error) { alert(error.message); return }
    refresh()
  }

  function exportCsv() {
    const headers = [
      'date','time','ticket','truck','crop','from','to','contract',
      'gross_lb','tare_lb','net_lb','wet_bu','dry_bu','moisture','test_weight',
    ]
    const lines = [headers.join(',')]
    for (const r of filtered) {
      const { wetBushels, dryBushels } = bushelsFor(r)
      lines.push([
        r.date, r.time ?? '', r.ticket_number ?? '',
        r.truck?.name_or_number ?? '', r.crop?.name ?? '',
        fromLabel(r), toLabel(r), r.contract?.contract_number ?? '',
        r.gross_weight ?? '', r.tare_weight ?? '', r.net_weight ?? '',
        wetBushels != null ? wetBushels.toFixed(2) : '',
        dryBushels != null ? dryBushels.toFixed(2) : '',
        r.moisture ?? '', r.test_weight ?? '',
      ].map(csvEscape).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `loads-${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <h1 className="text-2xl font-bold flex-1">Loads</h1>
        <Link href="/loads/unpaid" className="rounded-lg bg-white border border-slate-300 px-4 py-2 text-sm">Unpaid</Link>
        <Link href="/loads/import" className="rounded-lg bg-white border border-slate-300 px-4 py-2 text-sm">Import CSV</Link>
        <Link href="/loads/new" className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">+ New Load</Link>
        <button onClick={exportCsv} className="rounded-lg bg-white border border-slate-300 px-4 py-2">Export CSV</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <input
          type="search"
          placeholder="Search ticket, truck, crop, field, bin, buyer…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2"
        />
        <label className="text-sm text-slate-600 flex items-center gap-2">
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 flex-1" />
        </label>
        <label className="text-sm text-slate-600 flex items-center gap-2">
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 flex-1" />
        </label>
        <select
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2"
          title="Filter to loads sourced from a field belonging to this entity"
        >
          <option value="">All entities</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select
          value={countyId}
          onChange={(e) => setCountyId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2"
          title="Filter to loads sourced from a field in this county"
        >
          <option value="">All counties</option>
          {countyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
        </select>
        <select
          value={cropYear}
          onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))}
          className="rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="">All crop years</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
        </select>
        <select
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2"
          title="Filter to loads attached to this contract"
        >
          <option value="">All contracts</option>
          {contractOptions.map((c) => {
            const parts = [
              `#${c.contract_number}`,
              c.buyer?.name,
              c.crop?.name,
              c.crop_year != null ? `${c.crop_year} crop` : null,
            ].filter(Boolean)
            return <option key={c.id} value={c.id}>{parts.join(' · ')}</option>
          })}
        </select>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <span className="font-semibold">{selected.size} selected</span>
          <button onClick={bulkDelete} className="rounded-lg bg-red-600 text-white px-3 py-1.5 text-sm font-semibold">Delete selected</button>
          <button onClick={() => setSelected(new Set())} className="text-slate-600">Clear</button>
        </div>
      )}

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700 cursor-default">
            <tr>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={sorted.length > 0 && sorted.every((r) => selected.has(r.id))}
                  onChange={toggleAllVisible}
                />
              </th>
              <SortTh onClick={() => toggleSort('date')}     active={sortKey === 'date'}     dir={sortDir}>Date</SortTh>
              <SortTh onClick={() => toggleSort('ticket')}   active={sortKey === 'ticket'}   dir={sortDir}>Ticket</SortTh>
              <SortTh onClick={() => toggleSort('truck')}    active={sortKey === 'truck'}    dir={sortDir}>Truck</SortTh>
              <SortTh onClick={() => toggleSort('crop')}     active={sortKey === 'crop'}     dir={sortDir}>Crop</SortTh>
              <th className="text-left px-3 py-2 whitespace-nowrap">From</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">To</th>
              <SortTh onClick={() => toggleSort('net')}      active={sortKey === 'net'}      dir={sortDir} align="right">Net (lb)</SortTh>
              <th className="text-right px-3 py-2 whitespace-nowrap text-slate-500">Wet bu</th>
              <SortTh onClick={() => toggleSort('dry')}      active={sortKey === 'dry'}      dir={sortDir} align="right">Dry bu</SortTh>
              <SortTh onClick={() => toggleSort('moisture')} active={sortKey === 'moisture'} dir={sortDir} align="right">Moist</SortTh>
              <th className="px-3 py-2"></th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={13} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={13} className="px-3 py-6 text-center text-slate-400">No loads found.</td></tr>
            )}
            {sorted.map((r) => {
              const { wetBushels, dryBushels } = bushelsFor(r)
              const fmt = (n: number | null) => n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ''
              return (
                <tr key={r.id} className={`border-t border-slate-100 ${selected.has(r.id) ? 'bg-sky-50' : ''}`}>
                  <td className="px-3 py-2"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} /></td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.date}{r.time ? ` ${r.time.slice(0,5)}` : ''}</td>
                  <td className="px-3 py-2">{r.ticket_number}</td>
                  <td className="px-3 py-2">{r.truck?.name_or_number}</td>
                  <td className="px-3 py-2">{r.crop?.name}</td>
                  <td className="px-3 py-2">{fromLabel(r)}</td>
                  <td className="px-3 py-2">
                    {toLabel(r)}{r.contract?.contract_number ? ` (#${r.contract.contract_number})` : ''}
                    {(() => {
                      const s = paymentStatus(r)
                      if (s === 'paid') return <span className="ml-2 text-xs bg-green-100 text-green-800 rounded px-2 py-0.5">paid</span>
                      if (s === 'unpaid') return <span className="ml-2 text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">unpaid</span>
                      return null
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right">{r.net_weight?.toLocaleString() ?? ''}</td>
                  <td className="px-3 py-2 text-right text-slate-500">{fmt(wetBushels)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{fmt(dryBushels)}</td>
                  <td className="px-3 py-2 text-right">{r.moisture ?? ''}</td>
                  <td className="px-3 py-2"><Link href={`/loads/${r.id}/edit`} className="text-sky-700">Edit</Link></td>
                  <td className="px-3 py-2"><button onClick={() => onDelete(r.id)} className="text-red-600">Delete</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortTh({
  children, onClick, active, dir, align = 'left',
}: {
  children: React.ReactNode
  onClick: () => void
  active: boolean
  dir: 'asc' | 'desc'
  align?: 'left' | 'right'
}) {
  const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 whitespace-nowrap cursor-pointer select-none hover:bg-slate-200 ${align === 'right' ? 'text-right' : 'text-left'} ${active ? 'text-slate-900' : ''}`}
    >
      {children}{arrow}
    </th>
  )
}
