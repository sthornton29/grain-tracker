'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import type { Buyer, Contract, Crop, Entity } from '@/lib/types'

type LoadRow = {
  id: string
  contract_id: string | null
  ticket_number: string | null
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  from_type: string | null
  from_field_id: string | null
}

type LineRow = {
  load_id: string | null
  ticket_number: string | null
  net_bushels: number
  net_revenue: number | null
  settlement_id: string
}

type SettlementRow = { id: string; settlement_date: string }
type FieldRow = { id: string; farm_id: string | null }
type FarmRow = { id: string; entity_id: string | null }

const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d })

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}
function addMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
}
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

export default function CashFlowPage() {
  const supabase = useMemo(() => createClient(), [])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [lines, setLines] = useState<LineRow[]>([])
  const [settlements, setSettlements] = useState<SettlementRow[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [fields, setFields] = useState<FieldRow[]>([])
  const [farms, setFarms] = useState<FarmRow[]>([])
  const [loading, setLoading] = useState(true)

  const [cropYear, setCropYear] = useState<number | ''>('')
  const [cropId, setCropId] = useState('')
  const [buyerId, setBuyerId] = useState('')
  const [entityId, setEntityId] = useState('')

  useEffect(() => {
    ;(async () => {
      const [ct, ld, ln, st, cr, by, en, fi, fa] = await Promise.all([
        supabase.from('contracts').select('*'),
        supabase.from('loads').select('id, contract_id, ticket_number, net_weight, moisture, crop_id, dry_bushels_override, from_type, from_field_id'),
        supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue, settlement_id'),
        supabase.from('settlements').select('id, settlement_date'),
        supabase.from('crops').select('*'),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('fields').select('id, farm_id'),
        supabase.from('farms').select('id, entity_id'),
      ])
      setContracts((ct.data as Contract[]) || [])
      setLoads((ld.data as LoadRow[]) || [])
      setLines((ln.data as LineRow[]) || [])
      setSettlements((st.data as SettlementRow[]) || [])
      setCrops((cr.data as Crop[]) || [])
      setBuyers((by.data as Buyer[]) || [])
      setEntities((en.data as Entity[]) || [])
      setFields((fi.data as FieldRow[]) || [])
      setFarms((fa.data as FarmRow[]) || [])
      setLoading(false)
    })()
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const buyerById = useMemo(() => new Map(buyers.map((b) => [b.id, b])), [buyers])
  const settlementById = useMemo(() => new Map(settlements.map((s) => [s.id, s])), [settlements])
  const fieldEntity = useMemo(() => {
    const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
    return new Map(fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null]))
  }, [farms, fields])

  const lineByLoadId = useMemo(() => {
    const m = new Map<string, LineRow>()
    for (const l of lines) if (l.load_id) m.set(l.load_id, l)
    return m
  }, [lines])
  const lineByTicket = useMemo(() => {
    const m = new Map<string, LineRow>()
    for (const l of lines) if (l.ticket_number) m.set(l.ticket_number.trim().toLowerCase(), l)
    return m
  }, [lines])

  function lineFor(load: LoadRow): LineRow | null {
    if (lineByLoadId.has(load.id)) return lineByLoadId.get(load.id)!
    const t = load.ticket_number?.trim().toLowerCase()
    if (t && lineByTicket.has(t)) return lineByTicket.get(t)!
    return null
  }

  function dryBu(l: LoadRow): number {
    const crop = l.crop_id ? cropById.get(l.crop_id) : null
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    return dryBushels ?? 0
  }

  const cropYearOptions = useMemo(() => {
    const s = new Set<number>()
    contracts.forEach((c) => c.crop_year != null && s.add(c.crop_year))
    return [...s].sort((a, b) => b - a)
  }, [contracts])

  type Agg = {
    contract: Contract
    delivered: number
    deliveredUnpaid: number
    revenueReceived: number
    revenueByMonth: Map<string, number>  // from settlements
    entityIds: Set<string>
  }
  const aggByContract = useMemo(() => {
    const map = new Map<string, Agg>()
    for (const c of contracts) map.set(c.id, {
      contract: c, delivered: 0, deliveredUnpaid: 0, revenueReceived: 0,
      revenueByMonth: new Map(), entityIds: new Set(),
    })
    for (const load of loads) {
      if (!load.contract_id) continue
      const agg = map.get(load.contract_id)
      if (!agg) continue
      const bu = dryBu(load)
      agg.delivered += bu
      const line = lineFor(load)
      if (line) {
        const rev = Number(line.net_revenue ?? 0)
        agg.revenueReceived += rev
        const settlement = settlementById.get(line.settlement_id)
        if (settlement) {
          const key = monthKey(new Date(settlement.settlement_date + 'T00:00:00'))
          agg.revenueByMonth.set(key, (agg.revenueByMonth.get(key) ?? 0) + rev)
        }
      } else {
        agg.deliveredUnpaid += bu
      }
      if (load.from_type === 'field' && load.from_field_id) {
        const ent = fieldEntity.get(load.from_field_id) ?? null
        if (ent) agg.entityIds.add(ent)
      }
    }
    return map
  }, [contracts, loads, cropById, lineByLoadId, lineByTicket, settlementById, fieldEntity])

  const visibleContracts = contracts.filter((c) => {
    if (cropYear !== '' && c.crop_year !== cropYear) return false
    if (cropId && c.crop_id !== cropId) return false
    if (buyerId && c.buyer_id !== buyerId) return false
    if (entityId) {
      const agg = aggByContract.get(c.id)
      if (!agg || !agg.entityIds.has(entityId)) return false
    }
    return true
  })

  // Compute monthly cash flow buckets
  type Bucket = { received: number; outstanding: number; projected: number }
  const monthly = useMemo(() => {
    const buckets = new Map<string, Bucket>()
    const ensure = (k: string) => {
      let b = buckets.get(k)
      if (!b) { b = { received: 0, outstanding: 0, projected: 0 }; buckets.set(k, b) }
      return b
    }
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const thisMonth = monthKey(today)

    for (const c of visibleContracts) {
      const agg = aggByContract.get(c.id)
      if (!agg) continue
      const price = Number(c.price_per_bushel ?? 0)

      // received — by settlement month
      for (const [m, amount] of agg.revenueByMonth) {
        ensure(m).received += amount
      }

      // outstanding (delivered but unpaid) — receivable this month, valued at contract price
      const outstandingAmt = agg.deliveredUnpaid * price
      if (outstandingAmt > 0) ensure(thisMonth).outstanding += outstandingAmt

      // projected (not yet delivered) — spread across remaining months in delivery window
      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
      if (remainingBu > 0 && price > 0) {
        const totalProjected = remainingBu * price
        const months: string[] = []
        let cursor = startOfMonth(today)
        if (c.delivery_start_date) {
          const s = startOfMonth(new Date(c.delivery_start_date + 'T00:00:00'))
          if (s > cursor) cursor = s
        }
        const end = c.delivery_end_date ? new Date(c.delivery_end_date + 'T00:00:00') : null
        if (end && end >= cursor) {
          const endKey = monthKey(end)
          while (monthKey(cursor) <= endKey) {
            months.push(monthKey(cursor))
            cursor = addMonth(cursor)
          }
        }
        if (months.length === 0) {
          // No window (or end has passed) — put everything in current month
          ensure(thisMonth).projected += totalProjected
        } else {
          const per = totalProjected / months.length
          for (const m of months) ensure(m).projected += per
        }
      }
    }
    return buckets
  }, [visibleContracts, aggByContract])

  const monthlyRows = useMemo(() => {
    const keys = [...monthly.keys()].sort()
    let running = 0
    return keys.map((k) => {
      const b = monthly.get(k)!
      const total = b.received + b.outstanding + b.projected
      running += total
      return { key: k, label: monthLabel(k), ...b, total, cumulative: running }
    })
  }, [monthly])

  const summary = useMemo(() => {
    let value = 0, received = 0, outstanding = 0, remaining = 0
    for (const c of visibleContracts) {
      const agg = aggByContract.get(c.id)!
      const price = Number(c.price_per_bushel ?? 0)
      value += Number(c.contracted_bushels) * price
      received += agg.revenueReceived
      outstanding += agg.deliveredUnpaid * price
      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
      remaining += remainingBu * price
    }
    return { value, received, outstanding, remaining }
  }, [visibleContracts, aggByContract])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Cash Flow Forecast</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SumCard label="Contract value" value={`$${fmt(summary.value)}`} />
        <SumCard label="Received" value={`$${fmt(summary.received)}`} tone="green" />
        <SumCard label="Outstanding" value={`$${fmt(summary.outstanding)}`} tone="amber" />
        <SumCard label="Remaining" value={`$${fmt(summary.remaining)}`} tone="sky" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
          <option value="">All crop years</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
        </select>
        <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
          <option value="">All crops</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className={inputCls}>
          <option value="">All buyers</option>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
          <option value="">All entities</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>

      {loading ? <p className="text-slate-500">Loading…</p> : (
        <>
          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 font-semibold">Monthly forecast</div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    {['Month', 'Received', 'Outstanding', 'Projected', 'Month total', 'Cumulative']
                      .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {monthlyRows.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No forecast data.</td></tr>
                  )}
                  {monthlyRows.map((r) => (
                    <tr key={r.key} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-semibold">{r.label}</td>
                      <td className="px-3 py-2 text-right text-green-700 font-mono">${fmt(r.received)}</td>
                      <td className="px-3 py-2 text-right text-amber-700 font-mono">${fmt(r.outstanding)}</td>
                      <td className="px-3 py-2 text-right text-sky-700 font-mono">${fmt(r.projected)}</td>
                      <td className="px-3 py-2 text-right font-mono">${fmt(r.total)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">${fmt(r.cumulative)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 font-semibold">Contract detail</div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    {['Contract #', 'Buyer', 'Crop', 'Year', 'Window', 'Price/bu', 'Contracted', 'Delivered', 'Remaining', 'Value', 'Received', 'Outstanding', 'Unearned']
                      .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {visibleContracts.map((c) => {
                    const agg = aggByContract.get(c.id)!
                    const price = Number(c.price_per_bushel ?? 0)
                    const value = Number(c.contracted_bushels) * price
                    const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
                    const unearned = remainingBu * price
                    const outstanding = agg.deliveredUnpaid * price
                    return (
                      <tr key={c.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-semibold">{c.contract_number}</td>
                        <td className="px-3 py-2">{buyerById.get(c.buyer_id ?? '')?.name ?? ''}</td>
                        <td className="px-3 py-2">{cropById.get(c.crop_id ?? '')?.name ?? ''}</td>
                        <td className="px-3 py-2">{c.crop_year ?? ''}</td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap">
                          {(c.delivery_start_date || c.delivery_end_date)
                            ? <>{c.delivery_start_date ?? '?'} → {c.delivery_end_date ?? '?'}</>
                            : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{price ? price.toFixed(4) : ''}</td>
                        <td className="px-3 py-2 text-right">{fmt(Number(c.contracted_bushels))}</td>
                        <td className="px-3 py-2 text-right">{fmt(agg.delivered)}</td>
                        <td className="px-3 py-2 text-right">{fmt(remainingBu)}</td>
                        <td className="px-3 py-2 text-right font-mono">${fmt(value)}</td>
                        <td className="px-3 py-2 text-right font-mono text-green-700">${fmt(agg.revenueReceived)}</td>
                        <td className="px-3 py-2 text-right font-mono text-amber-700">${fmt(outstanding)}</td>
                        <td className="px-3 py-2 text-right font-mono text-sky-700">${fmt(unearned)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function SumCard({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'slate' | 'green' | 'amber' | 'sky' }) {
  const color =
    tone === 'green' ? 'text-green-700'
    : tone === 'amber' ? 'text-amber-700'
    : tone === 'sky' ? 'text-sky-700'
    : 'text-slate-700'
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
    </div>
  )
}
