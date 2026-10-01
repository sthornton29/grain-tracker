'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { splitFieldLabel } from '@/lib/load-splits'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { truckDisplay, truckExportLabel } from '@/lib/trucks'
import { buildTareStatsIndex, lowTareWarning, truckTareKey } from '@/lib/truck-tare'
import { fmtDate } from '@/lib/format-date'
import { reportError } from '@/lib/friendly-error'
import ExportBar from '@/components/export-bar'
import { ConfirmDialog, NoticeDialog } from '@/components/app-dialog'
import { EmptyState, ReportFilterBar, fmtInt, fmtNum, theadCls } from '@/components/reports/report-kit'
import type { ExportPayload, ExportCell } from '@/lib/exports'
import type { Entity, Farm, Field, FieldPlanting, County, LoadSplit } from '@/lib/types'
import { loadTicketKeys } from '@/lib/ticket-matching'

type Row = {
  id: string
  date: string
  time: string | null
  ticket_number: string | null
  buyer_ticket_number?: string | null
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
  truck_id: string | null
  created_at: string | null
  /** Truck name snapshot at save time (071) — display prefers it. */
  truck_label: string | null
  /** Hauler's truck on a pickup-contract load (067) — shown with a badge. */
  hauler_truck: string | null
  crop_id: string | null
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
  id, date, time, ticket_number, buyer_ticket_number, crop_year,
  gross_weight, tare_weight, net_weight, moisture, test_weight,
  dry_bushels_override,
  from_type, to_type, from_field_id, to_buyer_id, contract_id, crop_id,
  hauler_truck, truck_label, truck_id, created_at,
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

function fromLabel(r: Row, splits: LoadSplit[] | undefined, fieldNameById: Map<string, string>) {
  if (r.from_type === 'field') {
    if (splits && splits.length > 0) return splitFieldLabel(splits, fieldNameById)
    return r.from_field?.name_or_number ?? ''
  }
  if (r.from_type === 'bin') return r.from_bin?.name_or_number ?? ''
  return ''
}
function toLabel(r: Row) {
  if (r.to_type === 'bin') return r.to_bin?.name_or_number ?? ''
  if (r.to_type === 'buyer') return r.to_buyer?.name ?? ''
  return ''
}

export default function LoadsPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>([])
  // Does the operation have ANY loads (ignoring every filter)? Decides
  // between the "nothing yet" and the "nothing matches" empty states.
  const [hasAnyLoads, setHasAnyLoads] = useState<boolean | null>(null)
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
  // Crop filter (086) — persisted like the Yields page's ('loads:cropId').
  const [cropId, setCropId] = usePersistentState<string>('loads:cropId', '')
  const [crops, setCrops] = useState<Array<{ id: string; name: string }>>([])
  const [paidTickets, setPaidTickets] = useState<Set<string>>(new Set())
  const [paidLoadIds, setPaidLoadIds] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [splitsByLoad, setSplitsByLoad] = useState<Map<string, LoadSplit[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [deleteAsk, setDeleteAsk] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  type SortKey = 'date' | 'ticket' | 'truck' | 'crop' | 'net' | 'dry' | 'moisture' | 'testwt'
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir(k === 'date' ? 'desc' : 'asc') }
  }

  async function refresh() {
    setLoading(true)
    // Paginated (lib/fetch-all-rows): a bare select caps at ~1,000 rows, which
    // silently truncated the log's OLDEST loads once the operation crossed it.
    // The id tiebreak keeps the date/time order stable across pages.
    const loadsQ = fetchAllRows((f, t) => {
      let query = supabase.from('loads').select(SELECT).order('date', { ascending: false }).order('time', { ascending: false }).order('id')
      if (from) query = query.gte('date', from)
      if (to) query = query.lte('date', to)
      return query.range(f, t)
    })
    const [loadsRes, anyRes, entitiesRes, farmsRes, fieldsRes, countiesRes, settlementLinesRes, plantingsRes, contractsRes, splitsRes, cropsRes] = await Promise.all([
      loadsQ,
      supabase.from('loads').select('id', { count: 'exact', head: true }),
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('*'),
      supabase.from('fields').select('*'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      fetchAllRows((f, t) => supabase.from('settlement_lines').select('ticket_number, load_id').order('id').range(f, t)),
      supabase.from('field_plantings').select('season_year'),
      supabase.from('contracts')
        .select('id, contract_number, buyer_id, crop_id, entity_id, crop_year, buyer:buyers(name), crop:crops(name)')
        .order('contract_number'),
      fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
      supabase.from('crops').select('id, name').order('name'),
    ])
    setRows((loadsRes.data as unknown as Row[]) || [])
    setHasAnyLoads((anyRes.count ?? 0) > 0)
    setCrops(((cropsRes.data as Array<{ id: string; name: string }>) ?? []))
    const splitMap = new Map<string, LoadSplit[]>()
    for (const s of ((splitsRes.data as LoadSplit[]) || [])) {
      const list = splitMap.get(s.load_id) ?? []
      list.push(s)
      splitMap.set(s.load_id, list)
    }
    setSplitsByLoad(splitMap)
    setEntities((entitiesRes.data as Entity[]) || [])
    setFarms((farmsRes.data as Farm[]) || [])
    setFields((fieldsRes.data as Field[]) || [])
    setCounties((countiesRes.data as County[]) || [])
    setPlantings((plantingsRes.data as FieldPlanting[]) || [])
    setContracts((contractsRes.data as unknown as ContractOption[]) || [])
    const tickets = new Set<string>()
    const paidLoads = new Set<string>()
    for (const l of (settlementLinesRes.data ?? []) as Array<{ ticket_number: string | null; load_id: string | null }>) {
      if (l.ticket_number) tickets.add(l.ticket_number.trim().toLowerCase())
      if (l.load_id) paidLoads.add(l.load_id)
    }
    setPaidTickets(tickets)
    setPaidLoadIds(paidLoads)
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

  const fieldNameById = useMemo(
    () => new Map(fields.map((f) => [f.id, f.name_or_number])),
    [fields],
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
    const rSplits = splitsByLoad.get(r.id)
    if (entityId) {
      // Split loads spread across multiple fields — match if ANY field maps
      // to the requested entity. For a single-field load this reduces to the
      // original from_field_id check.
      const fromFieldIds: string[] = []
      if (rSplits && rSplits.length > 0) {
        for (const s of rSplits) fromFieldIds.push(s.field_id)
      } else if (r.from_type === 'field' && r.from_field_id) {
        fromFieldIds.push(r.from_field_id)
      }
      const fromFieldMatches = fromFieldIds.some((id) => fieldEntityId.get(id) === entityId)
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
        fromFieldMatches
        || contractAttribution === entityId
        || buyerMatches
      if (!matchesEntity) return false
    }
    if (countyId) {
      if (r.from_type !== 'field') return false
      const fieldIds: string[] = []
      if (rSplits && rSplits.length > 0) {
        for (const s of rSplits) fieldIds.push(s.field_id)
      } else if (r.from_field_id) {
        fieldIds.push(r.from_field_id)
      }
      if (!fieldIds.some((id) => fieldCountyId.get(id) === countyId)) return false
    }
    if (contractId && r.contract_id !== contractId) return false
    if (cropYear !== '' && r.crop_year !== cropYear) return false
    if (cropId) {
      // Split loads carry several crops — match ANY split's crop.
      const cropIds = rSplits && rSplits.length > 0 ? rSplits.map((s) => s.crop_id) : [r.crop_id]
      if (!cropIds.includes(cropId)) return false
    }
    if (!q) return true
    const hay = [
      r.ticket_number, truckDisplay(r).name, r.crop?.name,
      fromLabel(r, rSplits, fieldNameById), toLabel(r), r.contract?.contract_number, r.date, fmtDate(r.date),
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
        // Hauler trucks sort by their text but stay a distinct list visually
        // (badge); own truck wins when both are somehow set (truckDisplay).
        case 'truck': av = truckDisplay(a).name || null; bv = truckDisplay(b).name || null; break
        case 'crop': av = a.crop?.name ?? null; bv = b.crop?.name ?? null; break
        case 'net': av = a.net_weight; bv = b.net_weight; break
        case 'dry': av = bushelsFor(a).dryBushels; bv = bushelsFor(b).dryBushels; break
        case 'moisture': av = a.moisture; bv = b.moisture; break
        case 'testwt': av = a.test_weight; bv = b.test_weight; break
      }
      return cmp(av, bv) * dir
    })
    return arr
  }, [filtered, sortKey, sortDir])

  // Low-tare badge on saved loads (lib/truck-tare): each truck's baseline is
  // the median tare across the loads currently listed, so past mistakes are
  // findable. Subtle and never an alert — the warning proper lives on the
  // forms at entry time.
  const tareStatsIndex = useMemo(() => buildTareStatsIndex(rows), [rows])
  const lowTareNote = (r: Row): string | null =>
    lowTareWarning(r.tare_weight, tareStatsIndex.get(truckTareKey(r) ?? ''))

  function toggleExpanded(id: string) {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

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
    setDeleting(true)
    const ids = [...selected]
    const CHUNK = 50
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK)
      const { error } = await supabase.from('loads').delete().in('id', batch)
      if (error) {
        setDeleting(false)
        setDeleteAsk(false)
        setNotice(`${i} of ${ids.length} loads were deleted before it stopped. ${reportError(error, { action: 'delete the rest', noun: 'load' })}`)
        setSelected(new Set())
        refresh()
        return
      }
    }
    setDeleting(false)
    setDeleteAsk(false)
    setSelected(new Set())
    refresh()
  }

  function paymentStatus(r: Row): 'paid' | 'unpaid' | null {
    if (r.to_type !== 'buyer') return null
    // Paid if a settlement line is linked to this load (manual match writes
    // load_id) OR its ticket appears on a settlement line. Manual matches only
    // set load_id, so ticket-only checking misses them — see settlement Review.
    if (paidLoadIds.has(r.id)) return 'paid'
    // Our ticket, or the buyer's ticket stored on the load after a match (091).
    return loadTicketKeys(r).some((k) => paidTickets.has(k)) ? 'paid' : 'unpaid'
  }

  const activeFilterCount = [q, from, to, entityId, countyId, cropYear !== '' ? 'y' : '', cropId, contractId].filter(Boolean).length
  function clearFilters() {
    setQ(''); setFrom(''); setTo(''); setEntityId(''); setCountyId(''); setCropYear(''); setCropId(''); setContractId('')
  }

  // Plain-English summary of the active filters (export sub-title + on screen).
  function filterSummary(count = filtered.length): string {
    const parts: string[] = []
    if (from || to) parts.push(`${from ? fmtDate(from) : '…'} to ${to ? fmtDate(to) : '…'}`)
    if (entityId) parts.push(entities.find((e) => e.id === entityId)?.name ?? 'Entity')
    if (countyId) { const c = counties.find((x) => x.id === countyId); if (c) parts.push(`${c.name}, ${c.state_code}`) }
    if (cropYear !== '') parts.push(`${cropYear} crop`)
    if (cropId) parts.push(crops.find((c) => c.id === cropId)?.name ?? 'Crop')
    if (contractId) parts.push(`#${contracts.find((c) => c.id === contractId)?.contract_number ?? contractId}`)
    if (q) parts.push(`“${q}”`)
    parts.push(`${count} load${count === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  // ONE export payload for the whole list, a selection, or any subset — Excel,
  // PDF, CSV and print all come from it (lib/exports). Mirrors the on-screen
  // list; Excel cells stay real numbers.
  function buildPayload(rowsToExport: Row[] = sorted, suffix = ''): ExportPayload {
    return {
      title: 'Load Log',
      filters: filterSummary(rowsToExport.length),
      filename: `loads${suffix}-${new Date().toISOString().slice(0, 10)}`,
      sections: [{
        columns: [
          { label: 'Date' }, { label: 'Time' }, { label: 'Ticket' }, { label: 'Truck' }, { label: 'Crop' },
          { label: 'From' }, { label: 'To' }, { label: 'Contract' }, { label: 'Payment' },
          { label: 'Gross lb', align: 'right', format: 'int' }, { label: 'Tare lb', align: 'right', format: 'int' }, { label: 'Net lb', align: 'right', format: 'int' },
          { label: 'Wet bu', align: 'right', format: 'bu' }, { label: 'Dry bu', align: 'right', format: 'bu' },
          { label: 'Moisture %', align: 'right', format: 'dec1' }, { label: 'Test wt', align: 'right', format: 'dec1' },
          { label: 'Split' }, { label: 'Split details' },
        ],
        rows: rowsToExport.map((r): ExportCell[] => {
          const { wetBushels, dryBushels } = bushelsFor(r)
          const rSplits = splitsByLoad.get(r.id)
          const isSplit = !!(rSplits && rSplits.length > 0)
          const splitDetails = isSplit
            ? [...rSplits!]
                .sort((a, b) => b.net_weight - a.net_weight)
                .map((s) => `${fieldNameById.get(s.field_id) ?? '?'}: ${s.dry_bushels != null ? fmtInt(s.dry_bushels) : ''} bu (${s.percentage.toFixed(1)}%)`)
                .join('; ')
            : ''
          // Paid/unpaid mirrors the on-screen badge (blank for stored/non-buyer loads).
          const pay = paymentStatus(r)
          const payCell: ExportCell =
            pay === 'paid' ? { v: 'Paid', tone: 'favorable' as const }
            : pay === 'unpaid' ? { v: 'Unpaid', tone: 'warning' as const }
            : ''
          return [
            fmtDate(r.date), r.time ? r.time.slice(0, 5) : '', r.ticket_number ?? '', truckExportLabel(r), r.crop?.name ?? '',
            fromLabel(r, rSplits, fieldNameById), toLabel(r), r.contract?.contract_number ?? '', payCell,
            r.gross_weight ?? '', r.tare_weight ?? '', r.net_weight ?? '',
            wetBushels ?? '', dryBushels ?? '', r.moisture ?? '', r.test_weight ?? '',
            isSplit ? 'Yes' : '', splitDetails,
          ]
        }),
      }],
    }
  }
  const selectedRows = () => sorted.filter((r) => selected.has(r.id))

  const filterSelect = 'rounded-lg border border-slate-300 px-3 min-h-11 bg-white text-base sm:text-sm'
  const filterLabel = 'flex flex-col gap-1 text-xs text-slate-600 min-w-[9rem] flex-1 sm:flex-none'
  const quietLink = 'inline-flex items-center rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm'

  const nothingYet = !loading && hasAnyLoads === false
  const nothingMatches = !loading && hasAnyLoads !== false && sorted.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <h1 className="text-2xl font-bold flex-1">Loads</h1>
        <Link href="/loads/new" className="inline-flex items-center rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold">
          + New Load
        </Link>
        <Link href="/loads/combine" className={quietLink}>Yield from combine</Link>
        <Link href="/loads/scan" className={quietLink}>Scan tickets</Link>
        <Link href="/loads/import" className={quietLink}>Import spreadsheet</Link>
        <Link href="/loads/unpaid" className={quietLink}>Unpaid</Link>
      </div>

      <ReportFilterBar activeCount={activeFilterCount}>
        <label className={`${filterLabel} sm:min-w-[16rem]`}>
          Search
          <input
            type="search"
            placeholder="Ticket, truck, crop, field, bin, buyer…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={filterSelect}
          />
        </label>
        <label className={filterLabel}>
          From date
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={filterSelect} />
        </label>
        <label className={filterLabel}>
          To date
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={filterSelect} />
        </label>
        <label className={filterLabel}>
          Entity
          <select
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            className={filterSelect}
            title="Loads from a field belonging to this entity"
          >
            <option value="">All entities</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className={filterLabel}>
          County
          <select
            value={countyId}
            onChange={(e) => setCountyId(e.target.value)}
            className={filterSelect}
            title="Loads from a field in this county"
          >
            <option value="">All counties</option>
            {countyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
          </select>
        </label>
        <label className={filterLabel}>
          Crop year
          <select
            value={cropYear}
            onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))}
            className={filterSelect}
          >
            <option value="">All crop years</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
        <label className={filterLabel}>
          Crop
          <select
            value={cropId}
            onChange={(e) => setCropId(e.target.value)}
            className={filterSelect}
            title="Loads of this crop (a split load matches any of its crops)"
          >
            <option value="">All crops</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className={`${filterLabel} sm:min-w-[14rem]`}>
          Contract
          <select
            value={contractId}
            onChange={(e) => setContractId(e.target.value)}
            className={filterSelect}
            title="Loads attached to this contract"
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
        </label>
        {activeFilterCount > 0 && (
          <button type="button" onClick={clearFilters} className={`${quietLink} self-end`}>
            Clear filters
          </button>
        )}
      </ReportFilterBar>

      {/* One export bar for the page: the filtered list, every format. */}
      {sorted.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-500 flex-1" title="Active filters — named on every export">{filterSummary()}</span>
          <ExportBar buildPayload={() => buildPayload()} formats={['xlsx', 'pdf', 'csv', 'print']} />
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <span className="font-semibold">{selected.size} selected</span>
          <ExportBar buildPayload={() => buildPayload(selectedRows(), '-selected')} formats={['xlsx', 'csv']} size="sm" />
          <button type="button" onClick={() => setDeleteAsk(true)} className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 min-h-11 text-sm font-semibold">Delete selected</button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-slate-600 min-h-11 px-2">Clear selection</button>
        </div>
      )}

      {nothingYet ? (
        <EmptyState
          message="No loads yet."
          hint="Record one at New Load, scan a stack of tickets, or import a spreadsheet."
          linkHref="/loads/new"
          linkLabel="Record your first load"
        />
      ) : nothingMatches ? (
        <div className="bg-white rounded-xl shadow p-8 text-center space-y-3">
          <p className="text-slate-600 font-medium">No loads match these filters.</p>
          <button type="button" onClick={clearFilters} className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm font-semibold text-brand-deep">
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-500">Tap any load to view details, edit, or delete.</p>

          <div className="overflow-x-auto bg-white rounded-xl shadow">
            <table className="min-w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className="px-2 py-1 w-11">
                    <label className="flex items-center justify-center min-h-11 min-w-11 cursor-pointer">
                      <input
                        type="checkbox"
                        aria-label="Select all loads shown"
                        className="h-5 w-5"
                        checked={sorted.length > 0 && sorted.every((r) => selected.has(r.id))}
                        onChange={toggleAllVisible}
                      />
                    </label>
                  </th>
                  <SortTh onClick={() => toggleSort('date')}     active={sortKey === 'date'}     dir={sortDir}>Date</SortTh>
                  <SortTh onClick={() => toggleSort('ticket')}   active={sortKey === 'ticket'}   dir={sortDir}>Ticket</SortTh>
                  <SortTh onClick={() => toggleSort('truck')}    active={sortKey === 'truck'}    dir={sortDir}>Truck</SortTh>
                  <SortTh onClick={() => toggleSort('crop')}     active={sortKey === 'crop'}     dir={sortDir}>Crop</SortTh>
                  <th className="text-left px-3 py-2 whitespace-nowrap">From</th>
                  <th className="text-left px-3 py-2 whitespace-nowrap">To</th>
                  <SortTh onClick={() => toggleSort('net')}      active={sortKey === 'net'}      dir={sortDir} align="right">Net (lb)</SortTh>
                  <th className="text-right px-3 py-2 whitespace-nowrap text-slate-500 hidden md:table-cell">Wet bu</th>
                  <SortTh onClick={() => toggleSort('dry')}      active={sortKey === 'dry'}      dir={sortDir} align="right">Dry bu</SortTh>
                  <SortTh onClick={() => toggleSort('moisture')} active={sortKey === 'moisture'} dir={sortDir} align="right" className="hidden md:table-cell">Moisture</SortTh>
                  <SortTh onClick={() => toggleSort('testwt')}   active={sortKey === 'testwt'}   dir={sortDir} align="right" className="hidden md:table-cell">Test wt</SortTh>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={12} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
                {sorted.map((r) => {
                  const { wetBushels, dryBushels } = bushelsFor(r)
                  const rSplits = splitsByLoad.get(r.id)
                  const isSplit = !!(rSplits && rSplits.length > 0)
                  const isExpanded = expanded.has(r.id)
                  const ticketLabel = r.ticket_number ? `ticket ${r.ticket_number}` : `load on ${fmtDate(r.date)}`
                  return (
                    <Fragment key={r.id}>
                    <tr
                      onClick={() => router.push(`/loads/${r.id}`)}
                      className={`border-t border-slate-100 cursor-pointer hover:bg-slate-50 ${selected.has(r.id) ? 'bg-sky-50 hover:bg-sky-100' : ''}`}
                    >
                      <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                        <label className="flex items-center justify-center min-h-11 min-w-11 cursor-pointer">
                          <input type="checkbox" aria-label={`Select ${ticketLabel}`} className="h-5 w-5" checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
                        </label>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">{fmtDate(r.date)}{r.time ? <span className="text-slate-500"> {r.time.slice(0,5)}</span> : ''}</td>
                      <td className="px-3 py-2">{r.ticket_number}</td>
                      <td className="px-3 py-2">
                        {(() => {
                          const t = truckDisplay(r)
                          return (
                            <>
                              {t.name}
                              {t.hauler && <span className="ml-1.5 text-xs uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">hauler</span>}
                            </>
                          )
                        })()}
                      </td>
                      <td className="px-3 py-2">{r.crop?.name}</td>
                      <td className="px-3 py-2">
                        <span>{fromLabel(r, rSplits, fieldNameById)}</span>
                        {isSplit && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleExpanded(r.id) }}
                            className="ml-2 inline-flex items-center gap-1 text-xs bg-sky-100 text-sky-800 rounded px-2 min-h-8 hover:bg-sky-200"
                            title="Show how the load splits across fields"
                            aria-expanded={isExpanded}
                          >
                            <span>{isExpanded ? '▾' : '▸'}</span>
                            <span>Split · {rSplits!.length}</span>
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {toLabel(r)}{r.contract?.contract_number ? ` (#${r.contract.contract_number})` : ''}
                        {(() => {
                          const s = paymentStatus(r)
                          if (s === 'paid') return <span className="ml-2 text-xs bg-green-100 text-green-800 rounded px-2 py-0.5">paid</span>
                          if (s === 'unpaid') return <span className="ml-2 text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">unpaid</span>
                          return null
                        })()}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                        {fmtInt(r.net_weight)}
                        {(() => {
                          const note = lowTareNote(r)
                          return note ? (
                            <span className="ml-2 text-xs bg-amber-50 text-amber-800 rounded px-1.5 py-0.5" title={note}>low tare?</span>
                          ) : null
                        })()}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-500 tabular-nums hidden md:table-cell">{fmtInt(wetBushels)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtInt(dryBushels)}</td>
                      <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{fmtNum(r.moisture, 1)}</td>
                      <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{fmtNum(r.test_weight, 1)}</td>
                    </tr>
                    {isSplit && isExpanded && (
                      <tr className="bg-slate-50 border-t border-slate-100">
                        <td></td>
                        <td colSpan={11} className="px-3 py-2">
                          <table className="text-xs">
                            <thead>
                              <tr className="text-slate-500">
                                <th className="text-left pr-6 font-medium">Field</th>
                                <th className="text-right pr-6 font-medium">Net lb</th>
                                <th className="text-right pr-6 font-medium">%</th>
                                <th className="text-right pr-6 font-medium">Wet bu</th>
                                <th className="text-right pr-6 font-medium">Dry bu</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...rSplits!].sort((a, b) => b.net_weight - a.net_weight).map((s) => (
                                <tr key={s.id}>
                                  <td className="pr-6 py-0.5">{fieldNameById.get(s.field_id) ?? '—'}</td>
                                  <td className="pr-6 py-0.5 text-right tabular-nums">{fmtInt(s.net_weight)}</td>
                                  <td className="pr-6 py-0.5 text-right tabular-nums">{s.percentage.toFixed(1)}%</td>
                                  <td className="pr-6 py-0.5 text-right tabular-nums">{fmtInt(s.wet_bushels)}</td>
                                  <td className="pr-6 py-0.5 text-right tabular-nums">{fmtInt(s.dry_bushels)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ConfirmDialog
        open={deleteAsk}
        title={`Delete ${selected.size} load${selected.size === 1 ? '' : 's'}?`}
        body="This can’t be undone. Bin inventory, contract deliveries, and yields will recalculate without them."
        confirmLabel={`Delete ${selected.size}`}
        danger
        busy={deleting}
        onConfirm={() => void bulkDelete()}
        onCancel={() => { if (!deleting) setDeleteAsk(false) }}
      />
      <NoticeDialog
        open={notice != null}
        title="Some loads weren’t deleted"
        body={notice}
        onClose={() => setNotice(null)}
      />
    </div>
  )
}

function SortTh({
  children, onClick, active, dir, align = 'left', className = '',
}: {
  children: React.ReactNode
  onClick: () => void
  active: boolean
  dir: 'asc' | 'desc'
  align?: 'left' | 'right'
  className?: string
}) {
  const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-1 py-0 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`w-full min-h-11 px-2 rounded hover:bg-slate-200 font-semibold ${align === 'right' ? 'text-right' : 'text-left'} ${active ? 'text-slate-900' : ''}`}
      >
        {children}{arrow}
      </button>
    </th>
  )
}
