// The Marketing export's contracted-by-type listing (094): the virtual spot
// contract is its own "Spot" line, never folded into "Forward".

import { describe, expect, it } from 'vitest'
import { buildCsv, buildExcelWorkbook, formatNumber, type ExportCell } from '@/lib/exports'
import { buildMarketingExport } from '@/lib/marketing-export'
import { computeMarketing, type Planting } from '@/lib/marketing'
import { buildSpotContracts, withSpotContracts, type SaleSourceLoad } from '@/lib/virtual-contracts'
import type { LoadSale } from '@/lib/load-sales'
import type { Contract, Crop, CropAssumption } from '@/lib/types'
import { dumpExport } from '@/lib/export-dump'

const crop: Crop = { id: 'soy', name: 'Soybean', base_moisture_pct: 13, base_lb_per_bushel: 60, harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null, rma_type_override: null }
const assumption: CropAssumption = {
  id: 'a', crop_id: 'soy', crop_year: 2026, expected_yield: 50, expected_yield_irr: null, expected_yield_dry: null, expected_yield_dc_irr: null, expected_yield_dc_dry: null,
  harvest_complete: false, assumed_basis: -0.4, assumed_futures: null, reference_contract_month: null, assumed_acres: null, assumed_acres_irr: null, assumed_acres_dry: null,
  assumed_acres_dc_irr: null, assumed_acres_dc_dry: null, cost_per_acre: 300, cost_per_acre_irr: null, cost_per_acre_dry: null, cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null,
  notes: null, created_at: '', updated_at: '',
}
const real: Contract = {
  id: 'K', contract_number: '2002960604-10', buyer_id: 'bunge', entity_id: 'TRW', crop_id: 'soy', crop_year: 2026, contracted_bushels: 2059.757, price_per_bushel: 12.71, notes: null,
  delivery_type: 'delivered', delivery_location_id: null, delivery_start_date: null, delivery_end_date: null, date_sold: null, completed_at: null, created_at: '',
  contract_month: null, contract_type: 'forward', futures_price: null, basis: null, cash_price: 12.71, service_fee: 0, futures_set_date: null, basis_set_date: null, pricing_status: 'fully_priced',
}
const SPOT = [
  { id: 'L289', bu: 912.744, price: 13.74 }, { id: 'L302', bu: 959.926, price: 13.74 }, { id: 'L508', bu: 1026, price: 13.74 },
  { id: 'L509', bu: 951, price: 13.74 }, { id: 'L084', bu: 944.23, price: 13.38 },
]
const loads: SaleSourceLoad[] = SPOT.map((s) => ({ id: s.id, dryBu: s.bu, to_type: 'buyer', crop_id: 'soy', crop_year: 2026, to_buyer_id: 'bunge', date: '2026-09-25' }))
const sales: LoadSale[] = SPOT.map((s) => ({ id: `s-${s.id}`, load_id: s.id, sale_type: 'spot', contract_id: null, share: 1, buyer_net_bushels: null, spot_price: s.price, spot_price_source: 'settlement', est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null }))

describe('buildMarketingExport — contracted by type', () => {
  const spots = buildSpotContracts({ loads, sales, marketingAgentEntityId: 'TRW' })
  const contracts = withSpotContracts([real], spots)
  const plantings: Planting[] = [{ crop_id: 'soy', season_year: 2026, planted_acres: 200 }]
  const rows = computeMarketing({ cropYear: 2026, crops: [crop], plantings, contracts, futures: [], options: [], assumptions: [assumption], actualProductionByCrop: new Map(), currentFuturesByCrop: new Map([['soy', 13.0]]) })
  const payload = buildMarketingExport({ year: 2026, rows, contracts, cropMeta: new Map([['soy', false]]), segByCrop: new Map(), combined: { acres: 200, profit: null } })
  const soy = payload.sections.find((s) => s.title === 'Soybean')!
  it('the finished workbook and PDF build (EXPORT_DUMP_DIR writes them out to look at)', async () => {
    const { xlsx, pdf } = await dumpExport('marketing-dashboard', payload)
    expect(xlsx.byteLength).toBeGreaterThan(1000)
    expect(pdf!.byteLength).toBeGreaterThan(1000)
  })
  // Item | Quantity | Unit | Price / amount — the quantity is a real number
  // carrying its own format, the unit sits in its own cell.
  const cellOf = (c: ExportCell | undefined) => (c != null && typeof c === 'object' ? c : { v: c ?? null, format: undefined })
  const line = (item: string) => {
    const row = soy.rows.find((r) => cellOf(r[0]).v === item)
    if (!row) throw new Error(`no "${item}" line`)
    const q = cellOf(row[1])
    return { qty: q.v, shown: typeof q.v === 'number' ? formatNumber(q.v, q.format) : null, unit: row[2], amount: cellOf(row[3]).v }
  }

  it('lists "Spot" (4,794 bu) beside "Forward" (2,060 bu) under Sales, and Contracted is their sum', () => {
    expect(line('Spot')).toMatchObject({ shown: '4,794', unit: 'bu' })
    expect(line('Forward')).toMatchObject({ shown: '2,060', unit: 'bu' })
    expect(line('Contracted')).toMatchObject({ shown: '6,854', unit: 'bu' })
    expect(Number(line('Spot').qty) + Number(line('Forward').qty)).toBeCloseTo(Number(line('Contracted').qty), 6)
  })

  it('the spot line never counts under Forward', () => {
    expect(Number(line('Forward').qty)).toBeCloseTo(2059.757, 3)
  })

  it('every figure is a number with a format — no "6,854 bu" or "$12.71" strings in a numeric cell', () => {
    for (const section of payload.sections) {
      section.rows.forEach((row, ri) => {
        if (section.rowMeta?.[ri] === 'subhead') return
        for (const ci of [1, 3]) {
          const c = cellOf(row[ci])
          if (c.v == null) continue
          expect(typeof c.v, `${section.title} · ${String(cellOf(row[0]).v)}`).toBe('number')
          expect(c.format, `${section.title} · ${String(cellOf(row[0]).v)}`).toBeTruthy()
        }
      })
      expect(section.rowMeta).toHaveLength(section.rows.length)
    }
  })

  it('opens as one sheet of stacked crop tables, the figures real numbers in Excel', async () => {
    const wb = await buildExcelWorkbook(payload)
    expect(wb.worksheets.map((w: { name: string }) => w.name)).toEqual(['Marketing Dashboard'])
    const ws = wb.worksheets[0]
    let contracted: { qty: unknown; fmt: unknown; unit: unknown } | null = null
    ws.eachRow((row: { getCell: (n: number) => { value: unknown; numFmt?: string } }) => {
      if (row.getCell(1).value === 'Contracted') contracted = { qty: row.getCell(2).value, fmt: row.getCell(2).numFmt, unit: row.getCell(3).value }
    })
    expect(contracted).not.toBeNull()
    expect(typeof contracted!.qty).toBe('number')
    expect(contracted!.fmt).toBe('#,##0;(#,##0)')
    expect(contracted!.unit).toBe('bu')
    // The CSV carries the same plain numbers.
    expect(buildCsv(payload)).toMatch(/^Contracted,6854,bu,$/m)
  })

  it('reads as the screen does: the report name, and the same filter line', () => {
    expect(payload.title).toBe('Marketing Dashboard')
    expect(payload.filters).toBe('2026 Crop Year · All Entities')
    // A label that starts with "=" opens as a formula from a CSV file.
    for (const section of payload.sections) for (const row of section.rows) expect(String(cellOf(row[0]).v ?? '')).not.toMatch(/^=/)
  })
})
