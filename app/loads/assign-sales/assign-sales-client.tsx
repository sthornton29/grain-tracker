'use client'

// Loads without a sale type — the bulk assign tool (094, 2026-10-13).
//
// Every buyer load with no sale rows, grouped by buyer × crop × crop year
// (a group shares one set of contracts), each with a checkbox. Per group:
// "Mark as spot" (one typed bid for all, else each load is estimated),
// "Mark as price later", or "Apply to contract" (that buyer + crop + year's
// contracts). Writes go through the seam's writeManyLoadSales; the page
// refetches so a fixed group disappears.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { fmtDate } from '@/lib/format-date'
import { reportError } from '@/lib/friendly-error'
import { EmptyState, fmtInt } from '@/components/reports/report-kit'
import { NoticeDialog } from '@/components/app-dialog'
import {
  deliveredBushelsByContract, fetchLoadSales, isMissingRelation, singleSaleRow, unassignedBuyerLoads, writeManyLoadSales,
  type LoadSale, type LoadSaleInput,
} from '@/lib/load-sales'
import { estimateSpotPrice, withSpotEstimate } from '@/lib/spot-estimate'
import { contractOptionLabel, partitionContracts, type PickerContract } from '@/lib/sale-picker'

type LoadRow = {
  id: string
  date: string
  ticket_number: string | null
  crop_id: string | null
  crop_year: number | null
  to_type: 'bin' | 'buyer' | null
  to_buyer_id: string | null
  contract_id: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
  crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
  to_buyer: { name: string } | null
}

type ContractRow = PickerContract & { buyer_id: string | null; crop_id: string | null; crop_year: number | null }

type Group = {
  key: string
  buyerId: string
  buyerName: string
  cropId: string
  cropName: string
  cropYear: number | null
  loads: Array<LoadRow & { dryBu: number }>
  contracts: ContractRow[]
}

function dryBuOf(l: LoadRow): number {
  return computeBushels({
    netWeightLb: l.net_weight,
    moisturePct: l.moisture,
    baseMoisturePct: l.crop?.base_moisture_pct ?? null,
    baseLbPerBushel: l.crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: l.dry_bushels_override,
  }).dryBushels ?? 0
}

export default function AssignSalesClient() {
  const supabase = useMemo(() => createClient(), [])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [sales, setSales] = useState<LoadSale[]>([])
  const [contracts, setContracts] = useState<ContractRow[]>([])
  const [delivered, setDelivered] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [cropYear, setCropYear] = useState<number | ''>('')
  const [yearPicked, setYearPicked] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bidByGroup, setBidByGroup] = useState<Record<string, string>>({})
  const [contractByGroup, setContractByGroup] = useState<Record<string, string>>({})
  const [busyGroup, setBusyGroup] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [loadsRes, contractsRes] = await Promise.all([
      fetchAllRows((f, t) =>
        supabase
          .from('loads')
          .select('id, date, ticket_number, crop_id, crop_year, to_type, to_buyer_id, contract_id, net_weight, moisture, dry_bushels_override, crop:crops(name, base_moisture_pct, base_lb_per_bushel), to_buyer:buyers(name)')
          .eq('to_type', 'buyer')
          .order('date', { ascending: false })
          .order('id')
          .range(f, t),
      ),
      fetchAllRows((f, t) =>
        supabase
          .from('contracts')
          .select('id, contract_number, buyer_id, crop_id, crop_year, contracted_bushels, completed_at')
          .order('contract_number')
          .order('id')
          .range(f, t),
      ),
    ])
    const rows = (loadsRes.data as unknown as LoadRow[]) ?? []
    let saleRows: LoadSale[] = []
    try { saleRows = await fetchLoadSales(supabase, { loadIds: rows.map((r) => r.id) }) } catch { saleRows = [] }
    setLoads(rows)
    setSales(saleRows)
    setContracts((contractsRes.data as unknown as ContractRow[]) ?? [])
    // Delivered per contract (for the "N bu left" labels): every buyer load's
    // contract parts, through the seam.
    const d = new Map<string, number>()
    for (const [id, x] of deliveredBushelsByContract(rows.map((r) => ({ id: r.id, contract_id: r.contract_id, to_type: r.to_type, dryBu: dryBuOf(r) })), saleRows)) d.set(id, x.dryBu)
    setDelivered(d)
    setLoading(false)
  }, [supabase])
  useEffect(() => { void refresh() }, [refresh])

  const unassigned = useMemo(
    () => unassignedBuyerLoads(loads.map((l) => ({ ...l, dryBu: dryBuOf(l) })), sales),
    [loads, sales],
  )
  const years = useMemo(() => {
    const ys = new Set<number>()
    for (const l of unassigned) if (l.crop_year != null) ys.add(l.crop_year)
    return [...ys].sort((a, b) => b - a)
  }, [unassigned])
  // Crop year filter: the current year when it has loads, else the newest.
  useEffect(() => {
    if (yearPicked || years.length === 0) return
    const current = new Date().getFullYear()
    setCropYear(years.includes(current) ? current : years[0])
  }, [years, yearPicked])

  const groups: Group[] = useMemo(() => {
    const m = new Map<string, Group>()
    for (const l of unassigned) {
      if (cropYear !== '' && l.crop_year !== cropYear) continue
      const buyerId = l.to_buyer_id ?? ''
      const cropId = l.crop_id ?? ''
      const key = `${buyerId}|${cropId}|${l.crop_year ?? ''}`
      let g = m.get(key)
      if (!g) {
        g = {
          key, buyerId, cropId, cropYear: l.crop_year,
          buyerName: l.to_buyer?.name ?? 'Unknown buyer',
          cropName: l.crop?.name ?? 'Unknown crop',
          loads: [],
          contracts: contracts.filter((c) => c.buyer_id === buyerId && c.crop_id === cropId && c.crop_year === l.crop_year),
        }
        m.set(key, g)
      }
      g.loads.push(l)
    }
    return [...m.values()].sort((a, b) => a.buyerName.localeCompare(b.buyerName) || a.cropName.localeCompare(b.cropName))
  }, [unassigned, contracts, cropYear])

  // Everything starts selected: the usual case is "all of these were spot".
  useEffect(() => {
    setSelected(new Set(groups.flatMap((g) => g.loads.map((l) => l.id))))
  }, [groups])

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function toggleGroup(g: Group) {
    setSelected((s) => {
      const n = new Set(s)
      const all = g.loads.every((l) => n.has(l.id))
      for (const l of g.loads) { if (all) n.delete(l.id); else n.add(l.id) }
      return n
    })
  }

  async function apply(g: Group, kind: 'spot' | 'price_later' | 'contract') {
    const picked = g.loads.filter((l) => selected.has(l.id))
    if (picked.length === 0) return
    const contractId = contractByGroup[g.key] ?? ''
    if (kind === 'contract' && !contractId) {
      setNotice({ title: 'Pick a contract', body: 'Choose which contract these loads go on first.' })
      return
    }
    const bidRaw = Number(bidByGroup[g.key] ?? '')
    const bid = Number.isFinite(bidRaw) && bidRaw > 0 ? bidRaw : null
    setBusyGroup(g.key)
    try {
      const items: Array<{ loadId: string; rows: LoadSaleInput[] }> = []
      for (const l of picked) {
        let rows: LoadSaleInput[]
        if (kind === 'contract') rows = singleSaleRow({ sale_type: 'contract', contract_id: contractId })
        else if (kind === 'price_later') rows = singleSaleRow({ sale_type: 'price_later' })
        else {
          rows = singleSaleRow({ sale_type: 'spot', spot_price: bid, spot_price_source: bid != null ? 'entered' : null })
          if (bid == null) {
            try {
              const d = await estimateSpotPrice(supabase, {
                cropName: g.cropName, cropId: g.cropId || null, cropYear: g.cropYear, buyerId: g.buyerId || null, buyerName: g.buyerName, deliveryDate: l.date,
              })
              rows = rows.map((r) => withSpotEstimate(r, d))
            } catch { /* unpriced until the settlement */ }
          }
        }
        items.push({ loadId: l.id, rows })
      }
      await writeManyLoadSales(supabase, items)
      await refresh()
    } catch (e) {
      const msg = (e as Error)?.message ?? ''
      setNotice({
        title: 'Couldn’t save the sale type',
        body: isMissingRelation(msg)
          ? 'Sale types aren’t available yet on this account — contact support.'
          : reportError(e as Error, { action: 'save how these loads were sold', noun: 'sale' }),
      })
    } finally {
      setBusyGroup(null)
    }
  }

  const selectCls = 'rounded-lg border border-slate-300 px-3 min-h-11 bg-white text-base sm:text-sm'
  const btn = 'inline-flex items-center justify-center rounded-lg px-3 min-h-11 text-sm font-semibold disabled:opacity-50'
  const totalShown = groups.reduce((s, g) => s + g.loads.length, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold flex-1">Loads without a sale type</h1>
        <Link href="/loads" className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm">Back to loads</Link>
      </div>
      <p className="text-sm text-slate-600">
        These loads went to a buyer, but Turnrow doesn’t know yet whether each was on a contract, sold spot, or left to price later. Tick the loads, then pick how they were sold.
      </p>

      {years.length > 1 && (
        <label className="flex flex-col gap-1 text-xs text-slate-600 w-48">
          Crop year
          <select value={cropYear} onChange={(e) => { setYearPicked(true); setCropYear(e.target.value === '' ? '' : Number(e.target.value)) }} className={selectCls}>
            <option value="">All crop years</option>
            {years.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : totalShown === 0 ? (
        <EmptyState
          message={unassigned.length === 0 ? 'Every buyer load has a sale type.' : 'No loads in this crop year are missing a sale type.'}
          hint={unassigned.length === 0 ? 'New loads ask for it as you enter them.' : 'Try another crop year.'}
          linkHref="/loads"
          linkLabel="Back to loads"
        />
      ) : (
        groups.map((g) => {
          const { open, completed } = partitionContracts(g.contracts, delivered)
          const pickedCount = g.loads.filter((l) => selected.has(l.id)).length
          const pickedBu = g.loads.filter((l) => selected.has(l.id)).reduce((s, l) => s + l.dryBu, 0)
          const busy = busyGroup === g.key
          const allOn = g.loads.every((l) => selected.has(l.id))
          return (
            <div key={g.key} className="bg-white rounded-xl shadow overflow-hidden">
              <div className="px-4 pt-3 pb-2 border-b border-slate-100 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="font-semibold flex-1">
                  {g.buyerName} · {g.cropName}{g.cropYear != null ? ` · ${g.cropYear} crop` : ''}
                </h2>
                <span className="text-sm text-slate-500 tabular-nums">
                  {g.loads.length} load{g.loads.length === 1 ? '' : 's'} · {fmtInt(g.loads.reduce((s, l) => s + l.dryBu, 0))} bu
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-2 py-1 w-11">
                        <label className="flex items-center justify-center min-h-11 min-w-11 cursor-pointer">
                          <input type="checkbox" className="h-5 w-5" aria-label={`Select every load for ${g.buyerName}`} checked={allOn} onChange={() => toggleGroup(g)} />
                        </label>
                      </th>
                      <th className="text-left px-3 py-2">Date</th>
                      <th className="text-left px-3 py-2">Ticket</th>
                      <th className="text-right px-3 py-2">Dry bu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.loads.map((l) => (
                      <tr key={l.id} className="border-t border-slate-100">
                        <td className="px-2 py-1">
                          <label className="flex items-center justify-center min-h-11 min-w-11 cursor-pointer">
                            <input type="checkbox" className="h-5 w-5" aria-label={`Select ${l.ticket_number ? `ticket ${l.ticket_number}` : `load on ${fmtDate(l.date)}`}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                          </label>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">{fmtDate(l.date)}</td>
                        <td className="px-3 py-2">
                          <Link href={`/loads/${l.id}`} className="text-brand-deep hover:underline">{l.ticket_number ?? 'no ticket'}</Link>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtInt(l.dryBu)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-slate-100 space-y-2 bg-slate-50">
                <div className="text-sm text-slate-700">
                  <span className="font-semibold">{pickedCount}</span> of {g.loads.length} selected · <span className="tabular-nums">{fmtInt(pickedBu)}</span> bu
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs text-slate-600">
                    Bid $/bu <span className="text-slate-400">(optional, same for all)</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.0001"
                      min="0"
                      value={bidByGroup[g.key] ?? ''}
                      onChange={(e) => setBidByGroup((m) => ({ ...m, [g.key]: e.target.value }))}
                      className={`${selectCls} min-h-12 w-36 tabular-nums`}
                      placeholder="estimate"
                    />
                  </label>
                  <button type="button" disabled={busy || pickedCount === 0} onClick={() => void apply(g, 'spot')} className={`${btn} bg-brand hover:bg-brand-deep text-white`}>
                    {busy ? 'Saving…' : 'Mark as spot'}
                  </button>
                  <button type="button" disabled={busy || pickedCount === 0} onClick={() => void apply(g, 'price_later')} className={`${btn} bg-white border border-slate-300`}>
                    Mark as price later
                  </button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs text-slate-600 flex-1 min-w-[14rem]">
                    Contract
                    <select
                      value={contractByGroup[g.key] ?? ''}
                      onChange={(e) => setContractByGroup((m) => ({ ...m, [g.key]: e.target.value }))}
                      className={selectCls}
                      disabled={g.contracts.length === 0}
                    >
                      <option value="">{g.contracts.length === 0 ? `No ${g.cropName} contracts with ${g.buyerName} for this year` : '— pick a contract —'}</option>
                      {open.length > 0 && (
                        <optgroup label="Open contracts">
                          {open.map((c) => <option key={c.id} value={c.id}>{contractOptionLabel(c, delivered.get(c.id) ?? 0)}</option>)}
                        </optgroup>
                      )}
                      {completed.length > 0 && (
                        <optgroup label="Completed">
                          {completed.map((c) => <option key={c.id} value={c.id}>{contractOptionLabel(c, delivered.get(c.id) ?? 0)}</option>)}
                        </optgroup>
                      )}
                    </select>
                  </label>
                  <button type="button" disabled={busy || pickedCount === 0 || !contractByGroup[g.key]} onClick={() => void apply(g, 'contract')} className={`${btn} bg-white border-2 border-brand text-brand-deep`}>
                    Apply to contract
                  </button>
                </div>
              </div>
            </div>
          )
        })
      )}

      <NoticeDialog open={notice != null} title={notice?.title ?? ''} body={notice?.body} onClose={() => setNotice(null)} />
    </div>
  )
}
