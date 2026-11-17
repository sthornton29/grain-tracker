// A realistic farm-sized sample for the Crop Insurance Production Report
// exports: three grain crops, three counties, eleven farms, both practices,
// a mixed planting with an entered breakout, a split load and a combine entry.
//
// TEST SUPPORT ONLY — used by the export layout tests and by the workbook dump
// (EXPORT_DUMP_DIR) that lets a person open the real files in Excel. Nothing
// in the app imports this.

import { buildProductionReport, type ProductionReportInput } from '@/lib/production-report'
import { buildProductionBalance, balanceFactors, type BalanceSettlement, type BalanceSettlementLine } from '@/lib/production-balance'
import { computeBushels } from '@/lib/shrink'
import type { AuditLoadRow, ProductionAuditInput } from '@/lib/production-audit-workbook'
import type { ExportPayload } from '@/lib/exports'
import type { CombineEntryLike } from '@/lib/yields'
import type { County, Crop, Farm, Field, FieldPlanting, LoadSplit } from '@/lib/types'

const crop = (id: string, name: string, base: number, lb: number, over: Partial<Crop> = {}): Crop => ({
  id, name, base_moisture_pct: base, base_lb_per_bushel: lb, harvest_category: 'fall', double_crop: false,
  combine_adjustment_bu_per_acre: null, rma_type_override: null, ...over,
} as Crop)

export const SAMPLE_CROPS: Crop[] = [
  crop('corn', 'Corn', 15.5, 56),
  crop('soy', 'Soybeans', 13, 60),
  crop('wheat', 'Wheat', 13.5, 60, { harvest_category: 'spring' }),
]

export const SAMPLE_COUNTIES: County[] = [
  { id: 'lawrence', name: 'Lawrence', state: 'Alabama', state_code: 'AL' },
  { id: 'colbert', name: 'Colbert', state: 'Alabama', state_code: 'AL' },
  { id: 'limestone', name: 'Limestone', state: 'Alabama', state_code: 'AL' },
]

type FarmSpec = { name: string; county: string; fsa: string; fields: Array<{ name: string; crop: string; irr: number; dry: number; yieldBu: number }> }

const FARM_SPECS: FarmSpec[] = [
  { name: 'Home Place', county: 'lawrence', fsa: '1234', fields: [
    { name: 'Home Place North', crop: 'corn', irr: 82.4, dry: 0, yieldBu: 214 },
    { name: 'Home Place South', crop: 'corn', irr: 61.7, dry: 22.3, yieldBu: 188 },
    { name: 'Shop Field', crop: 'soy', irr: 0, dry: 44.1, yieldBu: 52 },
  ] },
  { name: 'Pruitt Farm', county: 'lawrence', fsa: '2218', fields: [
    { name: 'Pruitt Bottom', crop: 'corn', irr: 0, dry: 118.6, yieldBu: 156 },
    { name: 'Pruitt Hill', crop: 'soy', irr: 0, dry: 73.9, yieldBu: 47 },
  ] },
  { name: 'Wheeler Farm', county: 'lawrence', fsa: '3051', fields: [
    { name: 'Wheeler Pivot 1', crop: 'corn', irr: 124.0, dry: 0, yieldBu: 221 },
    { name: 'Wheeler Pivot 2', crop: 'soy', irr: 96.5, dry: 0, yieldBu: 68 },
    { name: 'Wheeler Corner', crop: 'wheat', irr: 0, dry: 31.2, yieldBu: 71 },
  ] },
  { name: 'Martin Farm', county: 'lawrence', fsa: '4410', fields: [
    { name: 'Martin East', crop: 'soy', irr: 0, dry: 88.0, yieldBu: 44 },
    { name: 'Martin West', crop: 'wheat', irr: 0, dry: 64.5, yieldBu: 78 },
  ] },
  { name: 'Moore Farm', county: 'colbert', fsa: '0871', fields: [
    { name: 'Moore River Bottom', crop: 'corn', irr: 0, dry: 142.3, yieldBu: 149 },
    { name: 'Moore Upland', crop: 'soy', irr: 0, dry: 57.8, yieldBu: 41 },
  ] },
  { name: 'Tweedy Farm', county: 'colbert', fsa: '0902', fields: [
    { name: 'Tweedy Pivot', crop: 'corn', irr: 109.2, dry: 0, yieldBu: 208 },
    { name: 'Tweedy Back 40', crop: 'soy', irr: 0, dry: 39.6, yieldBu: 49 },
  ] },
  { name: 'Barton Farm', county: 'colbert', fsa: '1177', fields: [
    { name: 'Barton Creek', crop: 'wheat', irr: 0, dry: 92.4, yieldBu: 74 },
    { name: 'Barton Road', crop: 'soy', irr: 0, dry: 66.1, yieldBu: 46 },
  ] },
  { name: 'Cedar Lane Farm', county: 'limestone', fsa: '5520', fields: [
    { name: 'Cedar Lane Front', crop: 'corn', irr: 0, dry: 97.5, yieldBu: 161 },
    { name: 'Cedar Lane Back', crop: 'soy', irr: 0, dry: 81.3, yieldBu: 50 },
  ] },
  { name: 'Elkmont Farm', county: 'limestone', fsa: '5533', fields: [
    { name: 'Elkmont Pivot A', crop: 'corn', irr: 131.8, dry: 0, yieldBu: 226 },
    { name: 'Elkmont Pivot B', crop: 'soy', irr: 118.4, dry: 0, yieldBu: 71 },
  ] },
  { name: 'Swan Creek Farm', county: 'limestone', fsa: '5610', fields: [
    { name: 'Swan Creek Bottom', crop: 'corn', irr: 0, dry: 76.2, yieldBu: 143 },
    { name: 'Swan Creek Ridge', crop: 'wheat', irr: 0, dry: 48.9, yieldBu: 69 },
  ] },
  { name: 'Tanner Crossroads', county: 'limestone', fsa: '5702', fields: [
    { name: 'Tanner North', crop: 'soy', irr: 0, dry: 104.7, yieldBu: 45 },
    { name: 'Tanner South', crop: 'corn', irr: 0, dry: 58.3, yieldBu: 152 },
  ] },
]

const HARVEST_START: Record<string, string> = { corn: '2026-09-0', soy: '2026-10-0', wheat: '2026-06-0' }

/** The engine input for the sample farm (2026, every entity, every crop). */
export function sampleProductionInput(over: Partial<ProductionReportInput> = {}): ProductionReportInput & { loads: AuditLoadRow[] } {
  const farms: Farm[] = []
  const fields: Field[] = []
  const plantings: FieldPlanting[] = []
  const loads: AuditLoadRow[] = []
  const splits: LoadSplit[] = []
  const cropById = new Map(SAMPLE_CROPS.map((c) => [c.id, c]))
  let ticket = 48100
  FARM_SPECS.forEach((spec, fi) => {
    const farmId = `farm${fi + 1}`
    farms.push({ id: farmId, name: spec.name, entity_id: 'ent1', fsa_number: spec.fsa, county_id: spec.county, landowner_id: null, is_share_rent: false, landlord_share_percentage: null, cash_rent_per_acre: null })
    spec.fields.forEach((f, xi) => {
      const fieldId = `${farmId}-fld${xi + 1}`
      const acres = f.irr + f.dry
      const mixed = f.irr > 0 && f.dry > 0
      fields.push({ id: fieldId, farm_id: farmId, name_or_number: f.name, total_acres: acres, irrigated_acres: f.irr, dryland_acres: f.dry, county_id: null })
      const total = Math.round(acres * f.yieldBu)
      plantings.push({
        id: `p-${fieldId}`, field_id: fieldId, crop_id: f.crop, season_year: 2026, planted_acres: acres, irrigated_acres: f.irr, dryland_acres: f.dry,
        irrigated_bushels: mixed ? Math.round(total * 0.78) : null, dryland_bushels: mixed ? total - Math.round(total * 0.78) : null,
        yield_breakout_entered: mixed, planting_date: null, paired_planting_id: null, notes: null, yield_include_override: null,
      } as FieldPlanting)
      // Loads: ~950 bu a truck, every load at or below base moisture except
      // every fourth, which is two points wet (so the shrink formula shows).
      const c = cropById.get(f.crop)!
      const n = Math.max(2, Math.round(total / 950))
      const perLoadBu = total / n
      for (let i = 0; i < n; i++) {
        const wet = i % 4 === 3
        const moisture = wet ? (c.base_moisture_pct ?? 15) + 2 : (c.base_moisture_pct ?? 15) - 0.5
        // Net lbs that shrink back to exactly perLoadBu dry bushels.
        const wetBu = wet ? (perLoadBu * (100 - (c.base_moisture_pct ?? 15))) / (100 - moisture) : perLoadBu
        const net = Math.round(wetBu * (c.base_lb_per_bushel ?? 56))
        const day = String(1 + ((fi + xi + i) % 9)).padStart(1, '0')
        ticket++
        loads.push({
          id: `load-${ticket}`, date: `${HARVEST_START[f.crop]}${day}`, time: null, net_weight: net, moisture, crop_id: f.crop, dry_bushels_override: null,
          crop_year: 2026, from_type: 'field', from_field_id: fieldId, practice: null, gross_weight: net + 31200, tare_weight: 31200, test_weight: 57.2,
          ticket_number: String(ticket), buyer_ticket_number: i % 2 === 0 ? `B${ticket + 5000}` : null, truck_id: null, truck_label: `Truck ${1 + (i % 4)}`,
          hauler_truck: null, to_type: 'buyer', to_bin_id: null, to_buyer_id: i % 3 === 0 ? 'woodall' : 'bunge', from_bin_id: null,
        })
      }
    })
  })
  const combineEntries: CombineEntryLike[] = []
  return {
    cropYear: 2026, entityId: '', cropIds: [], plantings, fields, farms, counties: SAMPLE_COUNTIES, crops: SAMPLE_CROPS,
    loads, splits, combineEntries, assumptions: [],
    cotton: { on: false as const, cottonCropIds: new Set<string>(), adapter: null, yieldFor: () => null },
    acceptedAsDryland: false, now: new Date(2026, 10, 17), ...over,
  } as ProductionReportInput & { loads: AuditLoadRow[] }
}

/** The audit-workbook input for the sample farm. */
export function sampleAuditInput(over: Partial<ProductionAuditInput> = {}): ProductionAuditInput {
  const ri = sampleProductionInput()
  const report = buildProductionReport(ri)
  return {
    report, cropYear: 2026, entityName: '', cropFilterLabel: 'All crops', orgName: 'Sample Family Farms', generatedAt: new Date(2026, 10, 17, 8, 30, 0),
    appOrigin: 'https://app.turnrow.farm', crops: ri.crops, fields: ri.fields, farms: ri.farms, counties: ri.counties, loads: ri.loads, splits: ri.splits,
    combineEntries: ri.combineEntries, buyers: [{ id: 'bunge', name: 'Bunge' }, { id: 'woodall', name: 'Woodall Grain' }], bins: [], trucks: [],
    loadSales: [], settlementLines: [], settlements: [], cotton: null, cropIds: [], entityId: '', ...over,
  }
}

/** The same farm with the production basis "Balanced to settlements": every
 *  corn and wheat load settled a little under our own dry bushels (buyer
 *  shrink), the last few soybean loads delivered but not yet settled. */
export function sampleBalancedAuditInput(): ProductionAuditInput {
  const ri = sampleProductionInput()
  const cropById = new Map(SAMPLE_CROPS.map((c) => [c.id, c]))
  const settlements: BalanceSettlement[] = [
    { id: 'st-bunge', buyer_id: 'bunge', settlement_date: '2026-10-20', settlement_number: '0000205995' },
    { id: 'st-woodall', buyer_id: 'woodall', settlement_date: '2026-10-27', settlement_number: '77232' },
  ]
  const lines: BalanceSettlementLine[] = []
  const soy = ri.loads.filter((l) => l.crop_id === 'soy')
  const unsettled = new Set(soy.slice(-4).map((l) => l.id))
  for (const l of ri.loads) {
    if (unsettled.has(l.id)) continue
    const c = cropById.get(l.crop_id ?? '')
    const dry = computeBushels({ netWeightLb: l.net_weight, moisturePct: l.moisture, baseMoisturePct: c?.base_moisture_pct ?? null, baseLbPerBushel: c?.base_lb_per_bushel ?? null, dryBushelsOverride: null }).dryBushels ?? 0
    lines.push({ id: `line-${l.id}`, settlement_id: l.to_buyer_id === 'woodall' ? 'st-woodall' : 'st-bunge', load_id: l.id, net_bushels: Math.round(dry * 0.988 * 100) / 100, ticket_number: l.ticket_number ?? null })
  }
  const measuredAll = buildProductionReport({ ...ri, acceptedAsDryland: true })
  const balance = buildProductionBalance({
    cropYear: 2026, crops: ri.crops, cottonCropIds: new Set<string>(), loads: ri.loads, lines, settlements,
    measuredByCrop: new Map([...measuredAll.summaryTotals].map(([id, c]) => [id, c.bu])),
  })
  const report = buildProductionReport({ ...ri, balanceFactorByCrop: balanceFactors(balance) })
  return sampleAuditInput({ report, basis: 'balanced', balance, settlements: settlements.map((x) => ({ id: x.id, settlement_number: x.settlement_number })) })
}

// ---------------------------------------------------------------------------
// Generic report shapes
// ---------------------------------------------------------------------------

/** A typical titled report: summary cards, grouped headers, subheads, subtotals, a grand total. */
export function sampleReportPayload(): ExportPayload {
  const crops = ['Corn', 'Soybeans', 'Wheat']
  const farms = ['Home Place', 'Pruitt Farm', 'Wheeler Farm', 'Martin Farm', 'Moore Farm', 'Tweedy Farm', 'Barton Farm', 'Cedar Lane Farm', 'Elkmont Farm', 'Swan Creek Farm', 'Tanner Crossroads']
  const rows: ExportPayload['sections'][number]['rows'] = []
  const meta: NonNullable<ExportPayload['sections'][number]['rowMeta']> = []
  let gAcres = 0, gBu = 0, gRev = 0, gCost = 0
  crops.forEach((crop, ci) => {
    rows.push([`${crop} — 2026`]); meta.push('subhead')
    let acres = 0, bu = 0, rev = 0, cost = 0
    farms.forEach((farm, fi) => {
      const a = 60 + ((fi * 37 + ci * 11) % 90) + 0.4
      const y = [185, 52, 71][ci] + ((fi * 7) % 23)
      const b = a * y
      const price = [4.62, 11.08, 5.91][ci]
      const r = b * price
      const c = a * [742, 418, 366][ci]
      acres += a; bu += b; rev += r; cost += c
      rows.push([farm, 'Sample Family Farms', a, y, b, b * 0.62, b * 0.38, price, r, c, r - c, (r - c) / a, { v: ((r - c) / r) * 100, tone: r - c < 0 ? 'unfavorable' : 'favorable' }, fi % 3 === 0 ? 'Landlord share 25%' : ''])
      meta.push('data')
    })
    rows.push([`${crop} subtotal`, '', acres, bu / acres, bu, bu * 0.62, bu * 0.38, rev / bu, rev, cost, rev - cost, (rev - cost) / acres, ((rev - cost) / rev) * 100, ''])
    meta.push('subtotal')
    gAcres += acres; gBu += bu; gRev += rev; gCost += cost
  })
  rows.push(['Total', '', gAcres, '', '', '', '', '', gRev, gCost, gRev - gCost, (gRev - gCost) / gAcres, ((gRev - gCost) / gRev) * 100, ''])
  meta.push('total')
  return {
    title: 'Revenue Projections',
    filters: '2026 Crop Year · All Entities · All Crops',
    summary: [
      { label: 'Projected revenue', value: '$1,482,300', tone: 'neutral' },
      { label: 'Projected cost', value: '$1,210,450' },
      { label: 'Projected profit', value: '$271,850', sub: '$134 / ac', tone: 'favorable' },
      { label: 'Unpriced bushels', value: '92,400', tone: 'warning' },
    ],
    sections: [
      {
        title: 'By Farm',
        columns: [
          { label: 'Farm' }, { label: 'Entity' }, { label: 'Acres', format: 'acres' }, { label: 'Yield (bu/ac)', format: 'yield' }, { label: 'Production (bu)', format: 'bu' },
          { label: 'Sold (bu)', format: 'bu' }, { label: 'Unpriced (bu)', format: 'bu' }, { label: 'Avg price ($/bu)', format: 'price' },
          { label: 'Revenue', format: 'usd0' }, { label: 'Cost', format: 'usd0' }, { label: 'Profit', format: 'usd0' }, { label: 'Profit / ac', format: 'usd0' }, { label: 'Margin', format: 'pct1' }, { label: 'Notes' },
        ],
        groups: [{ label: '', span: 2 }, { label: 'Production', span: 3 }, { label: 'Sales', span: 3 }, { label: 'Profitability', span: 5 }, { label: '', span: 1 }],
        rows, rowMeta: meta,
      },
      {
        title: 'By Crop',
        columns: [{ label: 'Crop' }, { label: 'Acres', format: 'acres' }, { label: 'Production (bu)', format: 'bu' }, { label: 'Revenue', format: 'usd0' }, { label: 'Profit', format: 'usd0' }],
        rows: [['Corn', 1024.3, 188493, 870837, 110812], ['Soybeans', 770.4, 40734, 451333, 129306], ['Wheat', 237, 17458, 103177, 16435], ['Total', 2031.7, '', 1425347, 256553]],
        rowMeta: ['data', 'data', 'data', 'total'],
      },
    ],
  }
}

/** A stacked single-sheet document (a load ticket / statement shape). */
export function sampleStackedPayload(): ExportPayload {
  return {
    title: 'Load 48262 — Wheat',
    filters: 'Barton Creek · Barton Farm · 6/1/2026',
    singleSheet: true,
    sections: [
      { title: 'Ticket', columns: [{ label: 'Item' }, { label: 'Value' }], rows: [['Ticket #', '48262'], ['Date', '6/1/2026'], ['Truck', 'Truck 4'], ['Destination', 'Woodall Grain'], ['Gross (lb)', 88320], ['Tare (lb)', 31200], ['Net (lb)', 57120], ['Moisture', 13.0]] },
      { title: 'Field split', columns: [{ label: 'Farm' }, { label: 'Field' }, { label: 'Share', format: 'pct1' }, { label: 'Net (lb)', format: 'lbs' }, { label: 'Dry bu', format: 'bu2' }], rows: [['Barton Farm', 'Barton Creek — the long bottom along the creek', 60, 34272, 571.2], ['Barton Farm', 'Barton Road', 40, 22848, 380.8], ['Total', '', 100, 57120, 952]], rowMeta: ['data', 'data', 'total'] },
      { title: 'Sale', columns: [{ label: 'Contract' }, { label: 'Buyer' }, { label: 'Bushels', format: 'bu2' }, { label: 'Price', format: 'price' }, { label: 'Amount', format: 'usd2' }], rows: [['90894', 'Woodall Grain', 952, 5.91, 5626.32]] },
    ],
  }
}
