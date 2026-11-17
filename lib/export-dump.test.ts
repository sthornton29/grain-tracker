import { describe, it, expect } from 'vitest'
import { dumpExport } from '@/lib/export-dump'
import { buildProductionAuditPayload } from '@/lib/production-audit-workbook'
import { buildInventoryPayload } from '@/components/export-inventory-csv'
import { sampleAuditInput, sampleBalancedAuditInput, sampleCottonAuditInput, sampleReportPayload, sampleStackedPayload } from '@/lib/export-sample-fixtures'
import type { ExportPayload } from '@/lib/exports'

// Writes real .xlsx / .pdf files a person can open:
//   EXPORT_DUMP_DIR=<folder> npx vitest run lib/export-dump.test.ts
// Without the variable these only prove the sample files build. Other tests
// that build an export (rent settlement, bale quality, marketing) dump theirs
// through the same helper when the variable is set.

async function dump(name: string, payload: ExportPayload): Promise<void> {
  const { xlsx } = await dumpExport(name, payload)
  expect(xlsx.byteLength).toBeGreaterThan(1000)
}

describe('sample workbooks build', () => {
  it('crop insurance production (measured)', async () => {
    await dump('crop-insurance-production', buildProductionAuditPayload(sampleAuditInput()))
  })
  it('crop insurance production (balanced to settlements)', async () => {
    await dump('crop-insurance-production-balanced', buildProductionAuditPayload(sampleBalancedAuditInput()))
  })
  it('crop insurance production (with cotton: the Gin Data and Bales tabs)', async () => {
    await dump('crop-insurance-production-cotton', buildProductionAuditPayload(sampleCottonAuditInput()))
  })
  it('a titled multi-section report', async () => {
    await dump('titled-report', sampleReportPayload())
  })
  it('a stacked single-sheet document', async () => {
    await dump('stacked-document', sampleStackedPayload())
  })
  it('bin inventory', async () => {
    const row = (siteName: string, binName: string, cropName: string, totalBu: number, capacityBu: number | null) => ({
      siteName, binName, cropName, loadBackedBu: totalBu, transferNetBu: 0, beginningBu: 0, totalBu, capacityBu,
      pctFull: capacityBu ? (totalBu / capacityBu) * 100 : null, beginningNotes: '',
    })
    await dump('bin-inventory', buildInventoryPayload([
      row('Home Bins', 'Bin 1', 'Corn', 31250, 40000), row('Home Bins', 'Bin 2', 'Soybeans', 38400, 40000), row('Home Bins', 'Bin 3', 'Corn', 12800, 25000),
      row('River Bins', 'Bin 1', 'Corn', 41900, 40000), row('River Bins', 'Bin 2', 'Wheat', 9600, 20000),
      { ...row('', 'Old Crib', 'Corn', 1150, null), beginningBu: 1150, loadBackedBu: 0, beginningNotes: '1,150 bu as of 1/1/2026 — carried over from last year' },
    ], 'All Entities · All Bin Sites · All Crops · What is in the bins today, every crop year'))
  })
})
