'use client'

import ExportBar from '@/components/export-bar'
import { capacityStatus } from '@/lib/bin-inventory'
import { formatNumber, type ExportCell, type ExportPayload, type RowKind } from '@/lib/exports'

export type InventoryCsvRow = {
  /** The bin site the bin sits at, as the page groups it ('' = no site assigned). */
  siteName: string
  binName: string
  cropName: string
  loadBackedBu: number
  transferNetBu: number
  beginningBu: number
  totalBu: number
  capacityBu: number | null
  /** What is physically in the bin (every crop) as a percent of its capacity; null with no capacity set. */
  pctFull: number | null
  beginningNotes: string
}

export const NO_SITE_LABEL = 'No bin site'

// ONE payload for Excel / PDF / CSV / print, mirroring the on-screen
// inventory: bins in the page's order under their bin site (two sites can each
// have a "Bin 1", so the site is its own column), a subtotal per site when
// there are several, real bushel numbers. The CSV rides the same lib/exports
// renderer as every other report — no bespoke file writer here.
export function buildInventoryPayload(rows: InventoryCsvRow[], filters?: string): ExportPayload {
  type Sum = { load: number; xfer: number; beg: number; tot: number }
  const zero = (): Sum => ({ load: 0, xfer: 0, beg: 0, tot: 0 })
  const add = (a: Sum, r: InventoryCsvRow) => { a.load += r.loadBackedBu; a.xfer += r.transferNetBu; a.beg += r.beginningBu; a.tot += r.totalBu }
  // No transfers / no beginning inventory is a blank, as on the bin's card — not a 0.
  const orBlank = (n: number): ExportCell => (Math.abs(n) >= 0.005 ? n : '')

  const sites: string[] = []
  for (const r of rows) if (!sites.includes(r.siteName)) sites.push(r.siteName)
  const out: ExportCell[][] = []
  const meta: RowKind[] = []
  const total = zero()
  const byCrop = new Map<string, number>()
  for (const site of sites) {
    const siteRows = rows.filter((r) => r.siteName === site)
    const sum = zero()
    for (const r of siteRows) {
      add(sum, r); add(total, r)
      byCrop.set(r.cropName, (byCrop.get(r.cropName) ?? 0) + r.totalBu)
      out.push([
        site || NO_SITE_LABEL, r.binName, r.cropName, r.loadBackedBu, orBlank(r.transferNetBu), r.beginningBu > 0 ? r.beginningBu : '',
        r.totalBu, r.capacityBu ?? '', pctFullCell(r.pctFull), r.beginningNotes,
      ])
      meta.push('data')
    }
    if (sites.length > 1) {
      out.push([`${site || NO_SITE_LABEL} total`, '', '', sum.load, orBlank(sum.xfer), orBlank(sum.beg), sum.tot, '', '', ''])
      meta.push('subtotal')
    }
  }
  out.push(['Total', '', '', total.load, orBlank(total.xfer), orBlank(total.beg), total.tot, '', '', ''])
  meta.push('total')

  // On hand per crop (bushels of different crops are never one figure).
  const crops = [...byCrop.entries()].sort(([a], [b]) => a.localeCompare(b))
  return {
    title: 'Bin Inventory',
    filters,
    filename: `bin-inventory-${new Date().toISOString().slice(0, 10)}`,
    summary: crops.map(([crop, bu]) => ({ label: `${crop} on hand`, value: `${formatNumber(bu, 'bu')} bu` })),
    sections: [{
      // The sheet tab.
      title: 'By Bin',
      columns: [
        { label: 'Bin site' }, { label: 'Bin' }, { label: 'Crop' },
        { label: 'From loads (bu)', align: 'right', format: 'bu' },
        { label: 'Net transfers (bu)', align: 'right', format: 'bu' },
        { label: 'Beginning inventory (bu)', align: 'right', format: 'bu' },
        { label: 'Total (bu)', align: 'right', format: 'bu' },
        { label: 'Capacity (bu)', align: 'right', format: 'bu' },
        { label: '% full', align: 'right', format: 'pct0' },
        { label: 'Beginning inventory notes' },
      ],
      rows: out,
      rowMeta: meta,
    }],
  }
}

/** The bin's percent full as a real number: amber from 90%, red when the bin
 *  holds more than its capacity (the capacity bar's own thresholds). */
function pctFullCell(pct: number | null): ExportCell {
  if (pct == null) return ''
  const status = capacityStatus(pct)
  return status === 'ok' ? pct : { v: pct, tone: status === 'over' ? 'unfavorable' : 'warning' }
}

export default function ExportInventoryCsv({ rows, filters }: { rows: InventoryCsvRow[]; filters?: string }) {
  if (rows.length === 0) return null
  return <ExportBar buildPayload={() => buildInventoryPayload(rows, filters)} formats={['xlsx', 'pdf', 'csv', 'print']} />
}
