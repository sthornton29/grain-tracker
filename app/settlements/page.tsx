'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import ExportBar from '@/components/export-bar'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import type { Entity, Farm, Field, FieldPlanting, LoadSplit, Buyer } from '@/lib/types'

type Row = {
  id: string
  settlement_date: string
  settlement_number: string | null
  notes: string | null
  source_pdf_url: string | null
  buyer_id: string | null
  buyer: { name: string } | null
  settlement_lines: Array<{
    net_bushels: number | null
    net_revenue: number | null
    load_id: string | null
    ticket_number: string | null
  }>
}

// Buyer-delivered loads, with just the fields the entity/crop-year/contract
// filters need. A settlement matches such a filter when ANY of its matched
// loads matches, so we resolve each line to a load and test the set.
type BuyerLoad = {
  id: string
  to_buyer_id: string | null
  ticket_number: string | null
  crop_year: number | null
  contract_id: string | null
  from_type: 'field' | 'bin' | null
  from_field_id: string | null
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

const EMPTY_COUNTS: Map<string, number> = new Map()

export default function SettlementsListPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>([])
  const [buyerLoads, setBuyerLoads] = useState<BuyerLoad[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [contracts, setContracts] = useState<ContractOption[]>([])
  const [splitsByLoad, setSplitsByLoad] = useState<Map<string, LoadSplit[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [buyerId, setBuyerId] = useState('')
  const [entityId, setEntityId] = useState('')
  const [cropYear, setCropYear] = useState<number | ''>('')
  const [contractId, setContractId] = useState('')

  async function refresh() {
    setLoading(true)
    let sq = supabase
      .from('settlements')
      .select('id, settlement_date, settlement_number, notes, source_pdf_url, buyer_id, buyer:buyers(name), settlement_lines(net_bushels, net_revenue, load_id, ticket_number)')
      .order('settlement_date', { ascending: false })
    if (from) sq = sq.gte('settlement_date', from)
    if (to) sq = sq.lte('settlement_date', to)
    const [settRes, entitiesRes, farmsRes, fieldsRes, buyersRes, plantingsRes, contractsRes, splitsRes, buyerLoadsRes] = await Promise.all([
      sq,
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('*'),
      supabase.from('fields').select('*'),
      supabase.from('buyers').select('*').order('name'),
      supabase.from('field_plantings').select('season_year'),
      supabase.from('contracts')
        .select('id, contract_number, buyer_id, crop_id, entity_id, crop_year, buyer:buyers(name), crop:crops(name)')
        .order('contract_number'),
      supabase.from('load_splits').select('*'),
      supabase.from('loads')
        .select('id, to_buyer_id, ticket_number, crop_year, contract_id, from_type, from_field_id')
        .eq('to_type', 'buyer'),
    ])
    setRows((settRes.data as unknown as Row[]) || [])
    setBuyerLoads((buyerLoadsRes.data as unknown as BuyerLoad[]) || [])
    setEntities((entitiesRes.data as Entity[]) || [])
    setFarms((farmsRes.data as Farm[]) || [])
    setFields((fieldsRes.data as Field[]) || [])
    setBuyers((buyersRes.data as Buyer[]) || [])
    setPlantings((plantingsRes.data as FieldPlanting[]) || [])
    setContracts((contractsRes.data as unknown as ContractOption[]) || [])
    const splitMap = new Map<string, LoadSplit[]>()
    for (const s of ((splitsRes.data as LoadSplit[]) || [])) {
      const list = splitMap.get(s.load_id) ?? []
      list.push(s)
      splitMap.set(s.load_id, list)
    }
    setSplitsByLoad(splitMap)
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

  // field → entity (via its farm), mirroring the Loads page entity resolution.
  const fieldEntityId = useMemo(() => {
    const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
    return new Map(fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null]))
  }, [farms, fields])

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

  // Per-buyer ticket → count, and lookups to resolve a settlement line to a load.
  const ticketCountsByBuyer = useMemo(() => {
    const m = new Map<string, Map<string, number>>()
    for (const l of buyerLoads) {
      if (!l.to_buyer_id) continue
      const t = (l.ticket_number ?? '').trim().toLowerCase()
      if (!t) continue
      let inner = m.get(l.to_buyer_id)
      if (!inner) { inner = new Map(); m.set(l.to_buyer_id, inner) }
      inner.set(t, (inner.get(t) ?? 0) + 1)
    }
    return m
  }, [buyerLoads])
  const loadById = useMemo(() => new Map(buyerLoads.map((l) => [l.id, l])), [buyerLoads])
  const buyerLoadsByTicket = useMemo(() => {
    const m = new Map<string, BuyerLoad[]>()
    for (const l of buyerLoads) {
      if (!l.to_buyer_id) continue
      const t = (l.ticket_number ?? '').trim().toLowerCase()
      if (!t) continue
      const key = `${l.to_buyer_id}|${t}`
      const arr = m.get(key)
      if (arr) arr.push(l); else m.set(key, [l])
    }
    return m
  }, [buyerLoads])

  // The loads matched to each settlement — a line's load_id when set, otherwise
  // the single buyer load its ticket maps to (same rule as the Unmatched count
  // and the Review screen). Used to apply the load-level filters.
  const matchedLoadsByRow = useMemo(() => {
    const m = new Map<string, BuyerLoad[]>()
    for (const r of rows) {
      const out: BuyerLoad[] = []
      for (const l of r.settlement_lines ?? []) {
        if (l.load_id) { const ld = loadById.get(l.load_id); if (ld) out.push(ld); continue }
        const t = (l.ticket_number ?? '').trim().toLowerCase()
        if (!t || !r.buyer_id) continue
        const cands = buyerLoadsByTicket.get(`${r.buyer_id}|${t}`) ?? []
        if (cands.length === 1) out.push(cands[0])
      }
      m.set(r.id, out)
    }
    return m
  }, [rows, loadById, buyerLoadsByTicket])

  // Contract dropdown cascades on crop year (and entity) so the list stays short.
  const contractOptions = useMemo(() => {
    return contracts.filter((c) => {
      if (cropYear !== '' && c.crop_year !== cropYear) return false
      if (entityId && c.entity_id && c.entity_id !== entityId) return false
      return true
    })
  }, [contracts, cropYear, entityId])
  useEffect(() => {
    if (contractId && !contractOptions.some((c) => c.id === contractId)) setContractId('')
  }, [contractOptions, contractId])

  function loadMatchesEntity(ld: BuyerLoad, ent: string): boolean {
    const fromFieldIds: string[] = []
    const s = splitsByLoad.get(ld.id)
    if (s && s.length > 0) for (const x of s) fromFieldIds.push(x.field_id)
    else if (ld.from_type === 'field' && ld.from_field_id) fromFieldIds.push(ld.from_field_id)
    if (fromFieldIds.some((id) => fieldEntityId.get(id) === ent)) return true
    // A contract attached to the load is authoritative — don't fall back to the
    // buyer's other entities. Buyer fallback only for loads with no contract.
    if (ld.contract_id) return (contractEntityById.get(ld.contract_id) ?? null) === ent
    if (ld.to_buyer_id) return buyerEntityIds.get(ld.to_buyer_id)?.has(ent) ?? false
    return false
  }

  const filtered = rows.filter((r) => {
    if (buyerId && r.buyer_id !== buyerId) return false
    const matched = matchedLoadsByRow.get(r.id) ?? []
    if (entityId && !matched.some((ld) => loadMatchesEntity(ld, entityId))) return false
    if (cropYear !== '' && !matched.some((ld) => ld.crop_year === cropYear)) return false
    if (contractId && !matched.some((ld) => ld.contract_id === contractId)) return false
    if (!q) return true
    const hay = [
      r.settlement_number, r.buyer?.name, r.notes, r.settlement_date,
      ...(r.settlement_lines ?? []).map((l) => l.ticket_number),
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q.toLowerCase())
  })

  function rowStats(r: Row) {
    const lines = r.settlement_lines ?? []
    const buyerCounts = (r.buyer_id && ticketCountsByBuyer.get(r.buyer_id)) || EMPTY_COUNTS
    const unmatched = lines.filter((l) => {
      if (l.load_id) return false
      const t = (l.ticket_number ?? '').trim().toLowerCase()
      if (t && buyerCounts.get(t) === 1) return false
      return true
    }).length
    const netBu = lines.reduce((s, l) => s + Number(l.net_bushels ?? 0), 0)
    const netRev = lines.reduce((s, l) => s + Number(l.net_revenue ?? 0), 0)
    return { count: lines.length, unmatched, netBu, netRev }
  }

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  // Plain-English summary of the active filters, shown at the top of the export.
  function filterSummary(): string {
    const parts: string[] = []
    if (from || to) parts.push(`${from || '…'} to ${to || '…'}`)
    parts.push(buyerId ? buyers.find((b) => b.id === buyerId)?.name ?? 'Buyer' : 'All buyers')
    parts.push(entityId ? entities.find((e) => e.id === entityId)?.name ?? 'Entity' : 'All entities')
    parts.push(cropYear !== '' ? `${cropYear} crop` : 'All crop years')
    parts.push(contractId ? `#${contracts.find((c) => c.id === contractId)?.contract_number ?? contractId}` : 'All contracts')
    if (q) parts.push(`“${q}”`)
    parts.push(`${filtered.length} settlement${filtered.length === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  // Formatted PDF/Excel of the filtered settlements (mirrors the on-screen list).
  function buildPayload(): ExportPayload {
    const stats = filtered.map(rowStats)
    const totals = stats.reduce(
      (a, s) => ({ count: a.count + s.count, unmatched: a.unmatched + s.unmatched, netBu: a.netBu + s.netBu, netRev: a.netRev + s.netRev }),
      { count: 0, unmatched: 0, netBu: 0, netRev: 0 },
    )
    return {
      title: 'Settlements',
      filters: filterSummary(),
      summary: [
        { label: 'Settlements', value: formatNumber(filtered.length, 'int') },
        { label: 'Net bushels', value: formatNumber(totals.netBu, 'bu') },
        { label: 'Net revenue', value: formatNumber(totals.netRev, 'usd0') },
      ],
      sections: [{
        columns: [
          { label: 'Date' },
          { label: 'Settlement #' },
          { label: 'Buyer' },
          { label: 'Lines', align: 'right', format: 'int' },
          { label: 'Unmatched', align: 'right', format: 'int' },
          { label: 'Net bu', align: 'right', format: 'bu' },
          { label: 'Net revenue', align: 'right', format: 'usd0' },
        ],
        rows: [
          ...filtered.map((r, i) => [
            r.settlement_date, r.settlement_number ?? '—', r.buyer?.name ?? '',
            stats[i].count, stats[i].unmatched, stats[i].netBu, stats[i].netRev,
          ]),
          ['Total', '', '', totals.count, totals.unmatched, totals.netBu, totals.netRev],
        ],
        rowMeta: [...filtered.map(() => 'data' as const), 'total'],
      }],
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Settlements</h1>
        {filtered.length > 0 && <ExportBar buildPayload={buildPayload} />}
        <Link href="/settlements/new" className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">+ New Settlement</Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <input
          type="search"
          placeholder="Search settlement #, buyer, ticket, notes…"
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
          value={buyerId}
          onChange={(e) => setBuyerId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2"
          title="Filter to settlements from this buyer"
        >
          <option value="">All buyers</option>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2"
          title="Filter to settlements with a matched load belonging to this entity"
        >
          <option value="">All entities</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select
          value={cropYear}
          onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))}
          className="rounded-lg border border-slate-300 px-3 py-2"
          title="Filter to settlements with a matched load from this crop year"
        >
          <option value="">All crop years</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
        </select>
        <select
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2"
          title="Filter to settlements with a matched load on this contract"
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

      <p className="text-xs text-slate-500">
        Tap a settlement to open it — the reconciliation, itemized discounts, and edit/delete live on its page.
      </p>

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Date', 'Settlement #', 'Buyer', 'Lines', 'Unmatched', 'Net bu', 'Net revenue', 'PDF']
                .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No settlements found.</td></tr>
            )}
            {!loading && filtered.map((r) => {
              const { count, unmatched, netBu, netRev } = rowStats(r)
              return (
                <tr
                  key={r.id}
                  onClick={() => router.push(`/settlements/${r.id}`)}
                  className="border-t border-slate-100 cursor-pointer hover:bg-slate-50"
                >
                  <td className="px-3 py-2">{r.settlement_date}</td>
                  <td className="px-3 py-2 font-semibold">{r.settlement_number ?? '—'}</td>
                  <td className="px-3 py-2">{r.buyer?.name ?? ''}</td>
                  <td className="px-3 py-2 text-right">{count}</td>
                  <td className="px-3 py-2 text-right">
                    {unmatched > 0
                      ? <span className="text-amber-700 font-semibold">{unmatched}</span>
                      : <span className="text-slate-400">0</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{fmt(netBu)}</td>
                  <td className="px-3 py-2 text-right">${fmt(netRev)}</td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {r.source_pdf_url ? (
                      <a
                        href={r.source_pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand-deep"
                      >
                        View ↗
                      </a>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
