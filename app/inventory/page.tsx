import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import {
  type OnHandBag, type BinInventoryCell,
  cellFor, cellTotal, applyTransfers, applyCombineRemainders,
  percentFull, percentFullLabel, capacityStatus, siteCapacitySummary,
} from '@/lib/bin-inventory'
import { fieldCropAggregates, type CombineEntryLike } from '@/lib/yields'
import EmptyBinButton from '@/components/empty-bin-button'
import BeginningInventoryButton from '@/components/beginning-inventory-button'
import TransferGrainButton, { BinTransferHistory, type TransferBinOption } from '@/components/transfer-grain'
import ExportInventoryCsv, { type InventoryCsvRow } from '@/components/export-inventory-csv'
import type { BinInventoryAdjustment, BinTransfer, Crop } from '@/lib/types'

type LoadRow = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  crop_year: number | null
  dry_bushels_override: number | null
  from_type: string | null
  from_field_id: string | null
  from_bin_id: string | null
  to_type: string | null
  to_bin_id: string | null
}

type SplitRow = { load_id: string; field_id: string; crop_id: string; dry_bushels: number | null }

type EntityRow = { id: string; name: string }
type BinRow = { id: string; name_or_number: string; crop_id: string | null; bin_site_id: string | null; capacity_bushels: number | null }
type BinSiteRow = { id: string; name: string; entity_id: string }

export const dynamic = 'force-dynamic'

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${m}/${d}/${y}`
}

function fmtBu(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// A beginning inventory is still the live baseline only if it was entered and
// the bin hasn't been emptied for that crop since (an empty resets the bin, so
// the beginning no longer applies and the inventory is purely load-backed).
function hasActiveBeginning(adjs: BinInventoryAdjustment[], cropId: string): boolean {
  const beginnings = adjs.filter((a) => a.crop_id === cropId && a.adjustment_type === 'beginning_inventory')
  if (beginnings.length === 0) return false
  const latest = beginnings.reduce((m, a) => (a.created_at > m.created_at ? a : m))
  return !adjs.some(
    (a) => a.crop_id === cropId && a.adjustment_type === 'empty_bin' && a.created_at > latest.created_at,
  )
}

// Percent-full bar shared by bin cards and site headers. Same visual language
// as the contract tracker's delivery-progress bars; amber near full, red when
// the estimate says the bin is at/over capacity (inventory is an estimate, so
// over 100% is shown as ">100%" rather than clipped).
function CapacityBar({ totalBu, capacityBu }: { totalBu: number; capacityBu: number }) {
  const pct = percentFull(totalBu, capacityBu)
  if (pct == null) return null
  const status = capacityStatus(pct)
  const fill = status === 'over' ? 'bg-red-600' : status === 'near_full' ? 'bg-amber-500' : 'bg-brand'
  return (
    <div>
      <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-2 ${fill}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className={`text-xs mt-0.5 ${status === 'over' ? 'text-red-700 font-semibold' : status === 'near_full' ? 'text-amber-700' : 'text-slate-500'}`}>
        {percentFullLabel(pct)} full · {fmtBu(Math.max(0, totalBu))} of {fmtBu(capacityBu)} bu
      </div>
    </div>
  )
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: { entity?: string; crop?: string; site?: string }
}) {
  const supabase = createClient()
  const entityId = searchParams.entity ?? ''
  const cropFilter = searchParams.crop ?? ''
  const siteFilter = searchParams.site ?? ''
  const today = todayISO()

  const [binsRes, sitesRes, cropsRes, loadsRes, splitsRes, combineRes, entitiesRes, adjsRes, transfersRes] = await Promise.all([
    supabase.from('bins').select('id, name_or_number, crop_id, bin_site_id, capacity_bushels').order('name_or_number'),
    supabase.from('bin_sites').select('id, name, entity_id').order('name'),
    supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').order('name'),
    fetchAllRows((f, t) => supabase.from('loads').select('id, date, net_weight, moisture, crop_id, crop_year, dry_bushels_override, from_type, from_field_id, from_bin_id, to_type, to_bin_id').order('id').range(f, t)),
    fetchAllRows((f, t) => supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels').order('id').range(f, t)),
    // Combine yield entries (062) — tolerate the table not existing yet
    // (migration pending): error → no entries, the page still renders.
    fetchAllRows((f, t) => supabase.from('combine_yield_entries')
      .select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date')
      .order('id').range(f, t)),
    supabase.from('entities').select('id, name').order('name'),
    fetchAllRows((f, t) => supabase.from('bin_inventory_adjustments')
      .select('id, bin_id, crop_id, adjustment_type, bushels, moisture, as_of_date, notes, created_at')
      .lte('as_of_date', today)
      .order('as_of_date', { ascending: true })
      .order('id').range(f, t)),
    fetchAllRows((f, t) => supabase.from('bin_transfers')
      .select('id, from_bin_id, to_bin_id, crop_id, bushels, transfer_date, method, throughput_bu_per_hr, hours_run, notes, created_at')
      .lte('transfer_date', today)
      .order('transfer_date', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id').range(f, t)),
  ])

  const allBins = (binsRes.data ?? []) as BinRow[]
  const sites = (sitesRes.data ?? []) as BinSiteRow[]
  const crops = (cropsRes.data ?? []) as Crop[]
  const loads = (loadsRes.data ?? []) as LoadRow[]
  const splits = (splitsRes.data ?? []) as SplitRow[]
  const combineEntries = (combineRes.data ?? []) as CombineEntryLike[]
  const entities = (entitiesRes.data ?? []) as EntityRow[]
  const adjustments = (adjsRes.data ?? []) as BinInventoryAdjustment[]
  const transfers = (transfersRes.data ?? []) as BinTransfer[]

  const cropById = new Map(crops.map((c) => [c.id, c]))
  const siteById = new Map(sites.map((s) => [s.id, s]))

  // Per-bin × per-crop totals from loads + adjustments + bin-to-bin transfers —
  // bin inventory is a live snapshot, so we don't try to attribute inflow by
  // entity/county/year. Transfers move grain between bins without ever
  // touching yields, production, or contract math (they aren't loads).
  const onHand: OnHandBag = new Map()
  for (const b of allBins) onHand.set(b.id, new Map())

  for (const l of loads) {
    if (!l.crop_id) continue
    const crop = cropById.get(l.crop_id)
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (!dryBushels) continue
    if (l.to_type === 'bin' && l.to_bin_id && onHand.has(l.to_bin_id)) {
      cellFor(onHand, l.to_bin_id, l.crop_id).loadBacked += dryBushels
    }
    if (l.from_type === 'bin' && l.from_bin_id && onHand.has(l.from_bin_id)) {
      cellFor(onHand, l.from_bin_id, l.crop_id).loadBacked -= dryBushels
    }
  }

  const adjustmentsForBin = new Map<string, BinInventoryAdjustment[]>()
  for (const a of adjustments) {
    if (!onHand.has(a.bin_id)) continue
    const cell = cellFor(onHand, a.bin_id, a.crop_id)
    if (a.adjustment_type === 'beginning_inventory') cell.beginning += Number(a.bushels)
    else cell.emptyAdj += Number(a.bushels)
    const list = adjustmentsForBin.get(a.bin_id) ?? []
    list.push(a)
    adjustmentsForBin.set(a.bin_id, list)
  }

  applyTransfers(onHand, transfers)

  // Combine-entry remainders (062): a combine-tracked field's NETTED remainder
  // (adjusted total − its weighed loads, via the shared yield engine) posts to
  // the entry's destination bin as a non-load component — the field's weighed
  // bin-bound loads are already in loadBacked, so only the remainder adds.
  if (combineEntries.length > 0) {
    const aggByKey = fieldCropAggregates(loads, splits, cropById, { combineEntries })
    applyCombineRemainders(
      onHand,
      combineEntries.map((e) => ({
        crop_id: e.crop_id,
        destinationBinId: e.destination_bin_id,
        remainderBu: aggByKey.get(`${e.field_id}|${e.crop_id}|${e.crop_year}`)?.combine?.remainderBu ?? 0,
      })),
    )
  }

  const transfersForBin = new Map<string, BinTransfer[]>()
  for (const t of transfers) {
    for (const binId of [t.from_bin_id, t.to_bin_id]) {
      if (!onHand.has(binId)) continue
      const list = transfersForBin.get(binId) ?? []
      list.push(t)
      transfersForBin.set(binId, list)
    }
  }

  const cropName = (id: string) => cropById.get(id)?.name ?? '—'

  // Apply visibility filters — entity scopes by the bin's site, site scopes
  // directly, crop scopes which crop rows render.
  const visibleSites = sites.filter((s) => {
    if (entityId && s.entity_id !== entityId) return false
    if (siteFilter && s.id !== siteFilter) return false
    return true
  })
  const visibleSiteIds = new Set(visibleSites.map((s) => s.id))

  type BinView = {
    bin: BinRow
    rows: { cid: string; cell: BinInventoryCell; total: number }[]
    total: number
    /** Total across ALL crops (ignores the crop filter) — what's physically in the bin, for the capacity bar. */
    physicalTotal: number
  }
  function viewFor(b: BinRow): BinView {
    const inner = onHand.get(b.id) ?? new Map<string, BinInventoryCell>()
    const allRows = [...inner.entries()]
      .map(([cid, cell]) => ({ cid, cell, total: cellTotal(cell) }))
      .filter((r) => Math.abs(r.total) >= 0.005)
    const physicalTotal = allRows.reduce((s, r) => s + r.total, 0)
    const rows = allRows
      .filter((r) => !cropFilter || r.cid === cropFilter)
      .sort((a, b) => cropName(a.cid).localeCompare(cropName(b.cid)))
    const total = rows.reduce((s, r) => s + r.total, 0)
    return { bin: b, rows, total, physicalTotal }
  }

  const binsBySite = new Map<string, BinView[]>()
  for (const b of allBins) {
    if (!b.bin_site_id || !visibleSiteIds.has(b.bin_site_id)) continue
    const v = viewFor(b)
    const list = binsBySite.get(b.bin_site_id) ?? []
    list.push(v)
    binsBySite.set(b.bin_site_id, list)
  }
  for (const [, list] of binsBySite) list.sort((a, b) => a.bin.name_or_number.localeCompare(b.bin.name_or_number))

  // Unsited bins still need to show up so users can fix them.
  const unsited: BinView[] = []
  if (!siteFilter && !entityId) {
    for (const b of allBins) if (!b.bin_site_id) unsited.push(viewFor(b))
    unsited.sort((a, b) => a.bin.name_or_number.localeCompare(b.bin.name_or_number))
  }

  // Per-site subtotals by crop.
  const siteTotalsByCrop = new Map<string, Map<string, number>>()
  const siteTotal = new Map<string, number>()
  for (const [siteId, list] of binsBySite.entries()) {
    const m = new Map<string, number>()
    let t = 0
    for (const v of list) {
      for (const r of v.rows) {
        m.set(r.cid, (m.get(r.cid) ?? 0) + r.total)
        t += r.total
      }
    }
    siteTotalsByCrop.set(siteId, m)
    siteTotal.set(siteId, t)
  }

  const entityNameById = new Map(entities.map((e) => [e.id, e.name]))

  // Sites available in the dropdown: filtered by entity if active.
  const siteOptions = entityId ? sites.filter((s) => s.entity_id === entityId) : sites

  // Serializable props for the transfer UI (client components).
  const transferBins: TransferBinOption[] = allBins.map((b) => ({
    id: b.id,
    name: b.name_or_number,
    siteName: b.bin_site_id ? siteById.get(b.bin_site_id)?.name ?? null : null,
    cropId: b.crop_id,
  }))
  const transferCrops = crops.map((c) => ({ id: c.id, name: c.name }))
  const onHandRecord: Record<string, Record<string, number>> = {}
  for (const [binId, inner] of onHand.entries()) {
    const rec: Record<string, number> = {}
    for (const [cid, cell] of inner.entries()) rec[cid] = cellTotal(cell)
    onHandRecord[binId] = rec
  }

  // CSV mirrors the page: break out load-backed vs. beginning only when a
  // beginning inventory is still active; otherwise it's a single total.
  // Transfer net is its own column so load-backed stays honest, and each row
  // carries its bin's capacity/% full when a capacity is set.
  const csvRows: InventoryCsvRow[] = []
  for (const list of binsBySite.values()) {
    for (const v of list) {
      const adjs = adjustmentsForBin.get(v.bin.id) ?? []
      const pct = percentFull(v.physicalTotal, v.bin.capacity_bushels)
      for (const r of v.rows) {
        const active = hasActiveBeginning(adjs, r.cid)
        const beginningBu = active ? r.cell.beginning : 0
        const transferNetBu = r.cell.transferIn - r.cell.transferOut
        const loadBackedBu = r.total - beginningBu - transferNetBu
        const beginningNotes = active
          ? adjs
              .filter((a) => a.crop_id === r.cid && a.adjustment_type === 'beginning_inventory')
              .map((a) => `${fmtBu(Number(a.bushels))} bu as of ${fmtDate(a.as_of_date)}${a.notes ? ` — ${a.notes}` : ''}`)
              .join('; ')
          : ''
        csvRows.push({
          binName: v.bin.name_or_number,
          cropName: cropName(r.cid),
          loadBackedBu,
          transferNetBu,
          beginningBu,
          totalBu: r.total,
          capacityBu: v.bin.capacity_bushels,
          pctFull: pct != null ? percentFullLabel(pct) : '',
          beginningNotes,
        })
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Bin Inventory</h1>
        <form className="flex items-center gap-2 flex-wrap">
          <select
            name="entity"
            defaultValue={entityId}
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All entities</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <select
            name="site"
            defaultValue={siteFilter}
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All sites</option>
            {siteOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{!entityId ? ` · ${entityNameById.get(s.entity_id) ?? ''}` : ''}
              </option>
            ))}
          </select>
          <select
            name="crop"
            defaultValue={cropFilter}
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All crops</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm">Apply</button>
        </form>
        {allBins.length > 1 && (
          <TransferGrainButton bins={transferBins} crops={transferCrops} onHand={onHandRecord} prominent />
        )}
        <ExportInventoryCsv rows={csvRows} />
      </div>
      <p className="text-sm text-slate-500">
        Live snapshot of dry bushels on hand: bushels delivered to bin − bushels pulled from bin + beginning inventory − empty-bin adjustments ± bin-to-bin transfers.
        Loads from any source/crop year are counted; this view shows what is physically in the bins right now.
      </p>

      {visibleSites.length === 0 && unsited.length === 0 && (
        <p className="text-slate-500">No bin sites match. Add sites under Settings → Bin Sites and assign bins to them.</p>
      )}

      {visibleSites.map((site) => {
        const list = binsBySite.get(site.id) ?? []
        const cropTotals = siteTotalsByCrop.get(site.id) ?? new Map<string, number>()
        const cropEntries = [...cropTotals.entries()]
          .filter(([, t]) => Math.abs(t) >= 0.005)
          .sort(([a], [b]) => cropName(a).localeCompare(cropName(b)))
        const total = siteTotal.get(site.id) ?? 0
        const ent = entityNameById.get(site.entity_id) ?? ''
        const capacity = siteCapacitySummary(
          list.map((v) => ({ capacityBu: v.bin.capacity_bushels, totalBu: v.physicalTotal })),
        )
        return (
          <section key={site.id} className="space-y-3">
            <div className="bg-slate-100 rounded-xl px-4 py-3">
              <div className="flex justify-between items-baseline gap-3 flex-wrap">
                <h2 className="text-lg font-bold">{site.name}</h2>
                <span className="text-sm text-slate-600">{ent}</span>
              </div>
              <div className="text-sm text-slate-600 mt-1">
                {list.length} bin{list.length === 1 ? '' : 's'} · <strong>{fmtBu(total)} bu total</strong>
              </div>
              {cropEntries.length > 0 && (
                <div className="mt-1 text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                  {cropEntries.map(([cid, t]) => (
                    <span key={cid}>{cropName(cid)}: <span className="font-mono">{fmtBu(t)}</span></span>
                  ))}
                </div>
              )}
              {capacity.pct != null && (
                <div className="mt-2 max-w-sm">
                  <CapacityBar totalBu={capacity.bushelsInCapacityBins} capacityBu={capacity.capacityBu} />
                  {capacity.binsWithoutCapacity > 0 && (
                    <p className="text-xs text-slate-400 mt-0.5">
                      {capacity.binsWithoutCapacity} bin{capacity.binsWithoutCapacity === 1 ? ' at this site has' : 's at this site have'} no
                      capacity set and {capacity.binsWithoutCapacity === 1 ? 'isn’t' : 'aren’t'} included in the site percentage.
                    </p>
                  )}
                </div>
              )}
            </div>
            {list.length === 0 ? (
              <p className="text-sm text-slate-400 ml-2">No bins at this site{cropFilter ? ' for the selected crop' : ''}.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {list.map((v) => (
                  <BinCard
                    key={v.bin.id}
                    v={v}
                    crops={crops}
                    adjustmentsForBin={adjustmentsForBin}
                    cropName={cropName}
                    transferBins={transferBins}
                    transferCrops={transferCrops}
                    onHandRecord={onHandRecord}
                    transfers={transfersForBin.get(v.bin.id) ?? []}
                    canTransfer={allBins.length > 1}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}

      {unsited.length > 0 && (
        <section className="space-y-3">
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-800">
            <h2 className="text-lg font-bold">Unsited bins</h2>
            <div className="text-sm mt-1">
              {unsited.length} bin{unsited.length === 1 ? '' : 's'} have no bin site assigned. Edit them under Settings → Bins to fix.
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {unsited.map((v) => (
              <BinCard
                key={v.bin.id}
                v={v}
                crops={crops}
                adjustmentsForBin={adjustmentsForBin}
                cropName={cropName}
                transferBins={transferBins}
                transferCrops={transferCrops}
                onHandRecord={onHandRecord}
                transfers={transfersForBin.get(v.bin.id) ?? []}
                canTransfer={allBins.length > 1}
              />
            ))}
          </div>
        </section>
      )}

      {allBins.length === 0 && (
        <p className="text-slate-500">No bins configured. Add them under Settings → Bins.</p>
      )}
    </div>
  )
}

function BinCard({
  v, crops, adjustmentsForBin, cropName, transferBins, transferCrops, onHandRecord, transfers, canTransfer,
}: {
  v: { bin: BinRow; rows: { cid: string; cell: BinInventoryCell; total: number }[]; total: number; physicalTotal: number }
  crops: Crop[]
  adjustmentsForBin: Map<string, BinInventoryAdjustment[]>
  cropName: (id: string) => string
  transferBins: TransferBinOption[]
  transferCrops: { id: string; name: string }[]
  onHandRecord: Record<string, Record<string, number>>
  transfers: BinTransfer[]
  canTransfer: boolean
}) {
  const adjs = adjustmentsForBin.get(v.bin.id) ?? []

  const rows = v.rows.map((r) => ({ ...r, active: hasActiveBeginning(adjs, r.cid) }))
  // Only break out load-backed vs. beginning when a beginning inventory is
  // actually in play; otherwise the inventory is just one number.
  const showBreakout = rows.some((r) => r.active)
  const showTransferCol = rows.some((r) => Math.abs(r.cell.transferIn - r.cell.transferOut) >= 0.005)
  const beginningNotes = adjs.filter(
    (a) => a.adjustment_type === 'beginning_inventory' && hasActiveBeginning(adjs, a.crop_id),
  )

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex justify-between items-baseline gap-2 flex-wrap">
        <h3 className="text-base font-semibold">{v.bin.name_or_number}</h3>
        <span className="text-sm text-slate-500">{fmtBu(v.total)} bu total</span>
      </div>
      {v.bin.capacity_bushels != null && v.bin.capacity_bushels > 0 && (
        <div className="mt-2">
          <CapacityBar totalBu={v.physicalTotal} capacityBu={v.bin.capacity_bushels} />
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 mt-2">Empty.</p>
      ) : showBreakout ? (
        <table className="w-full text-sm mt-2">
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="text-left py-1">Crop</th>
              <th className="text-right py-1">Load-backed</th>
              {showTransferCol && <th className="text-right py-1">Transfers</th>}
              <th className="text-right py-1">Beginning</th>
              <th className="text-right py-1">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const beginning = r.active ? r.cell.beginning : 0
              const transferNet = r.cell.transferIn - r.cell.transferOut
              const loadBacked = r.total - beginning - transferNet
              return (
                <tr key={r.cid} className="border-t border-slate-100">
                  <td className="py-1">{cropName(r.cid)}</td>
                  <td className="py-1 text-right font-mono">{fmtBu(loadBacked)}</td>
                  {showTransferCol && (
                    <td className="py-1 text-right font-mono text-slate-500">
                      {Math.abs(transferNet) >= 0.005 ? `${transferNet > 0 ? '+' : ''}${fmtBu(transferNet)}` : '—'}
                    </td>
                  )}
                  <td className="py-1 text-right font-mono text-slate-500">
                    {beginning > 0 ? fmtBu(beginning) : '—'}
                  </td>
                  <td className="py-1 text-right font-mono font-semibold">{fmtBu(r.total)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <table className="w-full text-sm mt-2">
          <tbody>
            {rows.map((r) => (
              <tr key={r.cid} className="border-t border-slate-100">
                <td className="py-1">{cropName(r.cid)}</td>
                <td className="py-1 text-right font-mono font-semibold">{fmtBu(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {beginningNotes.length > 0 && Math.abs(v.total) >= 0.005 && (
        <ul className="mt-3 space-y-1 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
          {beginningNotes.map((a) => (
            <li key={a.id}>
              Includes beginning inventory: {fmtBu(Number(a.bushels))} bu {cropName(a.crop_id)} (added {fmtDate(a.as_of_date)})
              {a.notes ? ` — ${a.notes}` : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <EmptyBinButton binId={v.bin.id} binName={v.bin.name_or_number} />
        <BeginningInventoryButton
          binId={v.bin.id}
          binName={v.bin.name_or_number}
          crops={crops}
          defaultCropId={v.bin.crop_id}
        />
        {canTransfer && (
          <TransferGrainButton
            bins={transferBins}
            crops={transferCrops}
            onHand={onHandRecord}
            defaultFromBinId={v.bin.id}
          />
        )}
      </div>
      <BinTransferHistory
        binId={v.bin.id}
        transfers={transfers}
        bins={transferBins}
        crops={transferCrops}
        onHand={onHandRecord}
      />
    </div>
  )
}
