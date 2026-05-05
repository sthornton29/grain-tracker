import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'
import EmptyBinButton from '@/components/empty-bin-button'
import BeginningInventoryButton from '@/components/beginning-inventory-button'
import ExportInventoryCsv, { type InventoryCsvRow } from '@/components/export-inventory-csv'
import type { BinInventoryAdjustment, Crop } from '@/lib/types'

type LoadRow = {
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  from_type: string | null
  from_bin_id: string | null
  to_type: string | null
  to_bin_id: string | null
}

type EntityRow = { id: string; name: string }
type BinRow = { id: string; name_or_number: string; crop_id: string | null; bin_site_id: string | null }
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

  const [binsRes, sitesRes, cropsRes, loadsRes, entitiesRes, adjsRes] = await Promise.all([
    supabase.from('bins').select('id, name_or_number, crop_id, bin_site_id').order('name_or_number'),
    supabase.from('bin_sites').select('id, name, entity_id').order('name'),
    supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').order('name'),
    supabase.from('loads').select('net_weight, moisture, crop_id, dry_bushels_override, from_type, from_bin_id, to_type, to_bin_id'),
    supabase.from('entities').select('id, name').order('name'),
    supabase.from('bin_inventory_adjustments')
      .select('id, bin_id, crop_id, adjustment_type, bushels, moisture, as_of_date, notes, created_at')
      .lte('as_of_date', today)
      .order('as_of_date', { ascending: true }),
  ])

  const allBins = (binsRes.data ?? []) as BinRow[]
  const sites = (sitesRes.data ?? []) as BinSiteRow[]
  const crops = (cropsRes.data ?? []) as Crop[]
  const loads = (loadsRes.data ?? []) as LoadRow[]
  const entities = (entitiesRes.data ?? []) as EntityRow[]
  const adjustments = (adjsRes.data ?? []) as BinInventoryAdjustment[]

  const cropById = new Map(crops.map((c) => [c.id, c]))
  const siteById = new Map(sites.map((s) => [s.id, s]))

  // Per-bin × per-crop totals from all loads + adjustments — bin inventory is a
  // live snapshot, so we don't try to attribute inflow by entity/county/year.
  type Cell = { loadBacked: number; beginning: number; emptyAdj: number }
  const cellFor = (bag: Map<string, Map<string, Cell>>, binId: string, cropId: string): Cell => {
    let inner = bag.get(binId)
    if (!inner) { inner = new Map(); bag.set(binId, inner) }
    let cell = inner.get(cropId)
    if (!cell) { cell = { loadBacked: 0, beginning: 0, emptyAdj: 0 }; inner.set(cropId, cell) }
    return cell
  }
  const onHand = new Map<string, Map<string, Cell>>()
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
    rows: { cid: string; cell: Cell; total: number }[]
    total: number
  }
  function viewFor(b: BinRow): BinView {
    const inner = onHand.get(b.id) ?? new Map<string, Cell>()
    const rows = [...inner.entries()]
      .map(([cid, cell]) => ({ cid, cell, total: cell.loadBacked + cell.beginning - cell.emptyAdj }))
      .filter((r) => Math.abs(r.total) >= 0.005)
      .filter((r) => !cropFilter || r.cid === cropFilter)
      .sort((a, b) => cropName(a.cid).localeCompare(cropName(b.cid)))
    const total = rows.reduce((s, r) => s + r.total, 0)
    return { bin: b, rows, total }
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

  const csvRows: InventoryCsvRow[] = []
  for (const list of binsBySite.values()) {
    for (const v of list) {
      for (const r of v.rows) {
        const beginningNotes = (adjustmentsForBin.get(v.bin.id) ?? [])
          .filter((a) => a.crop_id === r.cid && a.adjustment_type === 'beginning_inventory')
          .map((a) => `${fmtBu(Number(a.bushels))} bu as of ${fmtDate(a.as_of_date)}${a.notes ? ` — ${a.notes}` : ''}`)
          .join('; ')
        csvRows.push({
          binName: v.bin.name_or_number,
          cropName: cropName(r.cid),
          loadBackedBu: r.cell.loadBacked,
          beginningBu: r.cell.beginning,
          emptyAdjBu: r.cell.emptyAdj,
          totalBu: r.total,
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
        <ExportInventoryCsv rows={csvRows} />
      </div>
      <p className="text-sm text-slate-500">
        Live snapshot of dry bushels on hand: bushels delivered to bin − bushels pulled from bin + beginning inventory − empty-bin adjustments.
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
            </div>
            {list.length === 0 ? (
              <p className="text-sm text-slate-400 ml-2">No bins at this site{cropFilter ? ' for the selected crop' : ''}.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {list.map((v) => <BinCard key={v.bin.id} v={v} crops={crops} adjustmentsForBin={adjustmentsForBin} cropName={cropName} />)}
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
            {unsited.map((v) => <BinCard key={v.bin.id} v={v} crops={crops} adjustmentsForBin={adjustmentsForBin} cropName={cropName} />)}
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
  v, crops, adjustmentsForBin, cropName,
}: {
  v: { bin: BinRow; rows: { cid: string; cell: { loadBacked: number; beginning: number; emptyAdj: number }; total: number }[]; total: number }
  crops: Crop[]
  adjustmentsForBin: Map<string, BinInventoryAdjustment[]>
  cropName: (id: string) => string
}) {
  const beginningRows = (adjustmentsForBin.get(v.bin.id) ?? [])
    .filter((a) => a.adjustment_type === 'beginning_inventory')
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex justify-between items-baseline gap-2 flex-wrap">
        <h3 className="text-base font-semibold">Bin {v.bin.name_or_number}</h3>
        <span className="text-sm text-slate-500">{fmtBu(v.total)} bu total</span>
      </div>
      {v.rows.length === 0 ? (
        <p className="text-sm text-slate-400 mt-2">Empty.</p>
      ) : (
        <table className="w-full text-sm mt-2">
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="text-left py-1">Crop</th>
              <th className="text-right py-1">Load-backed</th>
              <th className="text-right py-1">Beginning</th>
              <th className="text-right py-1">Total</th>
            </tr>
          </thead>
          <tbody>
            {v.rows.map((r) => (
              <tr key={r.cid} className="border-t border-slate-100">
                <td className="py-1">{cropName(r.cid)}</td>
                <td className="py-1 text-right font-mono">{fmtBu(r.cell.loadBacked - r.cell.emptyAdj)}</td>
                <td className="py-1 text-right font-mono text-slate-500">
                  {r.cell.beginning > 0 ? fmtBu(r.cell.beginning) : '—'}
                </td>
                <td className="py-1 text-right font-mono font-semibold">{fmtBu(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {beginningRows.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
          {beginningRows.map((a) => (
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
      </div>
    </div>
  )
}
