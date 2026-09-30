'use client'

import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export type InventoryCsvRow = {
  binName: string
  cropName: string
  loadBackedBu: number
  transferNetBu: number
  beginningBu: number
  totalBu: number
  capacityBu: number | null
  pctFull: string
  beginningNotes: string
}

// ONE payload for Excel / PDF / CSV / print, mirroring the on-screen
// inventory (real bushel numbers, whole bushels). The CSV rides the same
// lib/exports renderer as every other report — no bespoke file writer here.
function buildPayload(rows: InventoryCsvRow[]): ExportPayload {
  const total = rows.reduce(
    (a, r) => ({
      load: a.load + r.loadBackedBu,
      xfer: a.xfer + r.transferNetBu,
      beg: a.beg + r.beginningBu,
      tot: a.tot + r.totalBu,
    }),
    { load: 0, xfer: 0, beg: 0, tot: 0 },
  )
  return {
    title: 'Bin Inventory',
    filename: `bin-inventory-${new Date().toISOString().slice(0, 10)}`,
    summary: [{ label: 'Total on hand', value: total.tot.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' bu' }],
    sections: [{
      columns: [
        { label: 'Bin' }, { label: 'Crop' },
        { label: 'From loads bu', align: 'right', format: 'bu' },
        { label: 'Transfers net bu', align: 'right', format: 'bu' },
        { label: 'Beginning inventory bu', align: 'right', format: 'bu' },
        { label: 'Total bu', align: 'right', format: 'bu' },
        { label: 'Capacity bu', align: 'right', format: 'bu' },
        { label: '% full', align: 'right', format: 'text' },
        { label: 'Beginning inventory notes' },
      ],
      rows: [
        ...rows.map((r) => [
          r.binName, r.cropName, r.loadBackedBu, r.transferNetBu, r.beginningBu, r.totalBu,
          r.capacityBu ?? '', r.pctFull, r.beginningNotes,
        ]),
        ['Total', '', total.load, total.xfer, total.beg, total.tot, '', '', ''],
      ],
      rowMeta: [...rows.map(() => 'data' as const), 'total'],
    }],
  }
}

export default function ExportInventoryCsv({ rows }: { rows: InventoryCsvRow[] }) {
  if (rows.length === 0) return null
  return <ExportBar buildPayload={() => buildPayload(rows)} formats={['xlsx', 'pdf', 'csv', 'print']} />
}
