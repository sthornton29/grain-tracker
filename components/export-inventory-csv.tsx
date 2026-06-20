'use client'

import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'

export type InventoryCsvRow = {
  binName: string
  cropName: string
  loadBackedBu: number
  beginningBu: number
  totalBu: number
  beginningNotes: string
}

function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Formatted PDF/Excel mirroring the on-screen inventory (real bushel numbers).
function buildPayload(rows: InventoryCsvRow[]): ExportPayload {
  const total = rows.reduce(
    (a, r) => ({ load: a.load + r.loadBackedBu, beg: a.beg + r.beginningBu, tot: a.tot + r.totalBu }),
    { load: 0, beg: 0, tot: 0 },
  )
  return {
    title: 'Bin Inventory Summary',
    summary: [{ label: 'Total on hand', value: total.tot.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' bu' }],
    sections: [{
      columns: [
        { label: 'Bin' }, { label: 'Crop' },
        { label: 'Load-backed bu', align: 'right', format: 'bu' }, { label: 'Beginning inventory bu', align: 'right', format: 'bu' },
        { label: 'Total bu', align: 'right', format: 'bu' }, { label: 'Beginning inventory notes' },
      ],
      rows: [
        ...rows.map((r) => [r.binName, r.cropName, r.loadBackedBu, r.beginningBu, r.totalBu, r.beginningNotes]),
        ['Total', '', total.load, total.beg, total.tot, ''],
      ],
      rowMeta: [...rows.map(() => 'data' as const), 'total'],
    }],
  }
}

export default function ExportInventoryCsv({ rows }: { rows: InventoryCsvRow[] }) {
  function download() {
    const header = [
      'Bin', 'Crop',
      'Load-backed bu', 'Beginning inventory bu',
      'Total bu', 'Beginning inventory notes',
    ]
    const body = rows.map((r) => [
      r.binName,
      r.cropName,
      r.loadBackedBu.toFixed(2),
      r.beginningBu.toFixed(2),
      r.totalBu.toFixed(2),
      r.beginningNotes,
    ])
    const csv = [header, ...body].map((r) => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bin-inventory-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={download}
        disabled={rows.length === 0}
        className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-50"
      >
        Export CSV
      </button>
      {rows.length > 0 && <ExportBar buildPayload={() => buildPayload(rows)} />}
    </div>
  )
}
