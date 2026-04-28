'use client'

export type InventoryCsvRow = {
  binName: string
  cropName: string
  loadBackedBu: number
  beginningBu: number
  emptyAdjBu: number
  totalBu: number
  beginningNotes: string
}

function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function ExportInventoryCsv({ rows }: { rows: InventoryCsvRow[] }) {
  function download() {
    const header = [
      'Bin', 'Crop',
      'Load-backed bu', 'Beginning inventory bu', 'Empty-bin adjustments bu',
      'Total bu', 'Beginning inventory notes',
    ]
    const body = rows.map((r) => [
      r.binName,
      r.cropName,
      r.loadBackedBu.toFixed(2),
      r.beginningBu.toFixed(2),
      r.emptyAdjBu.toFixed(2),
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
    <button
      type="button"
      onClick={download}
      disabled={rows.length === 0}
      className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
    >
      Export CSV
    </button>
  )
}
