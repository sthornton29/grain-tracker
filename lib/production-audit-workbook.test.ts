import { describe, it, expect } from 'vitest'
import { buildProductionReport, type ProductionReportInput } from '@/lib/production-report'
import { buildProductionAuditPayload, auditSection, AUDIT, ESTIMATED_KIND, GINNED_KIND, type ProductionAuditInput } from '@/lib/production-audit-workbook'
import { buildExcelWorkbook, evaluatePayload, formulaTextOf, type ExportPayload } from '@/lib/exports'
import { computeBushels } from '@/lib/shrink'
import type { CombineEntryLike } from '@/lib/yields'
import type { County, Crop, Farm, Field, FieldPlanting, LoadSplit } from '@/lib/types'
import type { AuditLoadRow } from '@/lib/production-audit-workbook'

// ---------------------------------------------------------------------------
// Hand-verified fixture: Corn 2026, base moisture 15.5%, 56 lb/bu. Every load
// is at or below base, so dry = net / 56 exactly (independent of the shrink
// formula, which has its own parity test below).
//
// Lawrence County, AL
//   Home Place  irrigated 10 ac: L1 56,000 @ 15.0 → 1,000; L2 56,560 @ 15.5 → 1,010. 2,010 bu, 201.0
//   Pruitt      dryland   12 ac: L3 61,600 @ 14.0 → 1,100; L4 67,200 @ 15.0 split 50/50 → 600 here. 1,700
//   Wheeler     dryland    6 ac: no loads; combine entry 900.
// Colbert County, AL
//   Moore       dryland    8 ac: L4's other 600 + L5 33,600 @ 15.5 → 600. 1,200 bu, 150.0
//   Tweedy      irrigated  5 ac: L7 dry_bushels_override 1,000 (blue, "manual override"). 200.0
// Not included: Cedar Lane (harvest in progress — the field the combine is in:
//   its L8 is the crop's latest-dated load), L8 28,000 @ 15.0 → 500.
// Summary: Lawrence Irr 10 / 2,010 / 201.0; Lawrence Dry 18 / 2,600 / 144.4;
//   Colbert Dry 8 / 1,200 / 150.0; Colbert Irr 5 / 1,000 / 200.0;
//   Total 41 / 6,810 / 166.1 (6,810 ÷ 41, not an average of the yields).
// ---------------------------------------------------------------------------

const CORN: Crop = { id: 'corn', name: 'Corn', base_moisture_pct: 15.5, base_lb_per_bushel: 56, harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null, rma_type_override: null }
const COTTON: Crop = { id: 'cotton', name: 'Cotton', base_moisture_pct: null, base_lb_per_bushel: null, harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null, rma_type_override: null }
const LAWRENCE: County = { id: 'lawrence', name: 'Lawrence', state: 'Alabama', state_code: 'AL' }
const COLBERT: County = { id: 'colbert', name: 'Colbert', state: 'Alabama', state_code: 'AL' }

const farm = (id: string, name: string, county: string, fsa: string | null = null): Farm => ({
  id, name, entity_id: 'ent1', fsa_number: fsa, county_id: county, landowner_id: null, is_share_rent: false, landlord_share_percentage: null, cash_rent_per_acre: null,
})
const field = (id: string, name: string, farmId: string, irr: number, dry: number): Field => ({
  id, farm_id: farmId, name_or_number: name, total_acres: irr + dry, irrigated_acres: irr, dryland_acres: dry, county_id: null,
})
const planting = (id: string, fieldId: string, irr: number, dry: number, over: Partial<FieldPlanting> = {}, cropId = 'corn'): FieldPlanting => ({
  id, field_id: fieldId, crop_id: cropId, season_year: 2026, planted_acres: irr + dry, irrigated_acres: irr, dryland_acres: dry,
  irrigated_bushels: null, dryland_bushels: null, yield_breakout_entered: false, planting_date: null, paired_planting_id: null, notes: null,
  yield_include_override: null, ...over,
})
const load = (id: string, date: string, fieldId: string | null, net: number | null, moisture: number | null, over: Partial<AuditLoadRow> = {}): AuditLoadRow => ({
  id, date, time: null, net_weight: net, moisture, crop_id: 'corn', dry_bushels_override: null, crop_year: 2026,
  from_type: 'field', from_field_id: fieldId, practice: null, gross_weight: net == null ? null : net + 30000, tare_weight: 30000,
  test_weight: 56.5, ticket_number: id.toUpperCase(), truck_id: null, truck_label: 'Truck 7', hauler_truck: null,
  to_type: 'buyer', to_bin_id: null, to_buyer_id: 'bunge', ...over,
})
const split = (id: string, loadId: string, fieldId: string, net: number, pct: number, dry: number, practice: LoadSplit['practice'] = null): LoadSplit => ({
  id, load_id: loadId, field_id: fieldId, crop_id: 'corn', net_weight: net, percentage: pct, wet_bushels: null, dry_bushels: dry, practice, notes: null, created_at: '',
})

const farms = [farm('f-home', 'Home Place Farm', 'lawrence', '1234'), farm('f-pruitt', 'Pruitt Farm', 'lawrence'), farm('f-wheeler', 'Wheeler Farm', 'lawrence'), farm('f-moore', 'Moore Farm', 'colbert'), farm('f-tweedy', 'Tweedy Farm', 'colbert'), farm('f-cedar', 'Cedar Lane Farm', 'lawrence')]
const fields = [field('home', 'Home Place', 'f-home', 10, 0), field('pruitt', 'Pruitt', 'f-pruitt', 0, 12), field('wheeler', 'Wheeler', 'f-wheeler', 0, 6), field('moore', 'Moore', 'f-moore', 0, 8), field('tweedy', 'Tweedy', 'f-tweedy', 5, 0), field('cedar', 'Cedar Lane', 'f-cedar', 0, 20)]
const plantings = [planting('p-home', 'home', 10, 0), planting('p-pruitt', 'pruitt', 0, 12), planting('p-wheeler', 'wheeler', 0, 6), planting('p-moore', 'moore', 0, 8), planting('p-tweedy', 'tweedy', 5, 0), planting('p-cedar', 'cedar', 0, 20)]
const loads: AuditLoadRow[] = [
  load('l1', '2026-09-15', 'home', 56000, 15.0),
  load('l2', '2026-09-15', 'home', 56560, 15.5),
  load('l3', '2026-09-16', 'pruitt', 61600, 14.0),
  load('l4', '2026-09-16', null, 67200, 15.0), // split 50/50 Pruitt / Moore
  load('l5', '2026-09-17', 'moore', 33600, 15.5),
  load('l7', '2026-09-18', 'tweedy', 60000, 20.0, { dry_bushels_override: 1000 }),
  load('l8', '2026-09-20', 'cedar', 28000, 15.0), // latest load of the crop → Cedar Lane is the active field
  load('bin1', '2026-09-21', null, 50000, 15.0, { from_type: 'bin', from_field_id: null }), // bin-sourced: never listed
]
const splits = [split('s4a', 'l4', 'pruitt', 33600, 50, 600), split('s4b', 'l4', 'moore', 33600, 50, 600)]
const combineEntries: CombineEntryLike[] = [{
  id: 'ce1', field_id: 'wheeler', crop_id: 'corn', crop_year: 2026, stated_total_bushels: 930, adjusted_total_bushels: 900,
  adjustment_bu_per_acre: -5, destination_bin_id: null, harvest_complete: true, entry_date: '2026-09-17',
}]
const NOW = new Date(2026, 8, 25) // Sep 25: the cohort is active (L8 five days old) — Cedar Lane is held in progress

function reportInput(over: Partial<ProductionReportInput> = {}): ProductionReportInput {
  return {
    cropYear: 2026, entityId: '', cropIds: [], plantings, fields, farms, counties: [LAWRENCE, COLBERT], crops: [CORN],
    loads, splits, combineEntries, assumptions: [], cotton: { on: false, cottonCropIds: new Set(), adapter: null, yieldFor: () => null },
    acceptedAsDryland: false, now: NOW, ...over,
  }
}
function auditInput(ri: ProductionReportInput, over: Partial<ProductionAuditInput> = {}): ProductionAuditInput {
  const report = buildProductionReport(ri)
  return {
    report, cropYear: 2026, entityName: '', cropFilterLabel: 'All crops', orgName: 'Turnrow Farm', generatedAt: new Date(2026, 9, 14, 8, 0, 0),
    appOrigin: 'https://app.turnrow.farm', crops: ri.crops, fields: ri.fields, farms: ri.farms, counties: ri.counties, loads: ri.loads, splits: ri.splits,
    combineEntries: ri.combineEntries, buyers: [{ id: 'bunge', name: 'Bunge' }], bins: [], trucks: [],
    loadSales: [{ id: 'ls1', load_id: 'l1', sale_type: 'contract', contract_id: 'c1', share: 1, buyer_net_bushels: 999.5, spot_price: null, spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: 'line1' }],
    settlementLines: [{ id: 'line1', settlement_id: 'st1', buyer_ticket_number: 'B-77' }],
    settlements: [{ id: 'st1', settlement_number: '0000205995' }],
    cotton: null, cropIds: ri.cropIds, entityId: ri.entityId, ...over,
  }
}

/** Evaluated rows of a section, as objects keyed by column key. */
function rowsOf(payload: ExportPayload, key: string): Array<Record<string, unknown>> {
  const grid = evaluatePayload(payload)[key]
  const cols = auditSection(payload, key).columns.map((c) => c.key ?? '')
  return grid.map((row) => Object.fromEntries(row.map((v, i) => [cols[i], v])))
}
const near = (v: unknown, n: number) => expect(Number(v)).toBeCloseTo(n, 6)

describe('audit workbook — the corn fixture', () => {
  const ri = reportInput()
  const report = buildProductionReport(ri)
  const payload = buildProductionAuditPayload(auditInput(ri))

  it('the engine leaves Cedar Lane out as in progress and keeps the five finished plantings', () => {
    expect(report.inProgress.map((p) => p.id)).toEqual(['p-cedar'])
    expect(report.resolved.map((r) => r.planting.id)).toEqual(['p-home', 'p-pruitt', 'p-wheeler', 'p-moore', 'p-tweedy'])
    expect(report.summaryTotals.get('corn')).toEqual({ acres: 41, bu: 6810 })
  })

  it('tabs are in order; Load Data has 7 portions, Combine Entries 1, Not Included 1', () => {
    expect(payload.sections.map((s) => s.title)).toEqual(['Summary', 'Field Production', 'Load Data', 'Combine Entries', 'Not Included', 'Notes'])
    const ld = rowsOf(payload, AUDIT.loadData)
    expect(ld).toHaveLength(7)
    expect(ld.map((r) => r.ticket)).toEqual(['L1', 'L2', 'L3', 'L4', 'L4', 'L5', 'L7'])
    expect(rowsOf(payload, AUDIT.combine)).toHaveLength(1)
    const ni = rowsOf(payload, AUDIT.notIncluded)
    expect(ni).toHaveLength(1)
    expect(ni[0].ticket).toBe('L8')
    expect(ni[0].reason).toBe('harvest in progress')
    near(ni[0].dry_bu, 500)
    // The bin-sourced load is nowhere in the workbook.
    for (const s of payload.sections) for (const row of s.rows) expect(JSON.stringify(row)).not.toContain('bin1')
  })

  it('L4 split rows show 50% and 33,600 lb applied by formula; the override row is blue and noted', () => {
    const ld = rowsOf(payload, AUDIT.loadData)
    const l4 = ld.filter((r) => r.ticket === 'L4')
    expect(l4.map((r) => r.field)).toEqual(['Pruitt', 'Moore'])
    for (const r of l4) {
      expect(r.split_pct).toBe(50)
      near(r.net_applied, 33600)
      near(r.dry_bu, 600)
      expect(r.note).toContain('split portion')
    }
    expect(formulaTextOf(payload, AUDIT.loadData, 3, 'net_applied')).toBe('P5*Q5/100')
    expect(formulaTextOf(payload, AUDIT.loadData, 3, 'dry_bu')).toBe('ROUND(IF(S5<=T5,R5/U5,R5/U5*(100-S5)/(100-T5)),2)')
    const l7 = ld.find((r) => r.ticket === 'L7')!
    expect(l7.dry_bu).toBe(1000)
    expect(l7.override).toBe('manual override')
    const sec = auditSection(payload, AUDIT.loadData)
    const dryIdx = sec.columns.findIndex((c) => c.key === 'dry_bu')
    const l7Row = sec.rows[ld.indexOf(l7)]
    expect(l7Row[dryIdx]).toMatchObject({ v: 1000, input: true })
    expect(formulaTextOf(payload, AUDIT.loadData, ld.indexOf(l7), 'dry_bu')).toBeNull()
    // Cross-check columns carry the settlement match, never summed anywhere.
    const l1 = ld.find((r) => r.ticket === 'L1')!
    expect(l1.settlement).toBe('0000205995')
    expect(l1.buyer_ticket).toBe('B-77')
    expect(l1.buyer_net_bu).toBe(999.5)
    expect(l1.destination).toBe('Bunge')
    expect(l1.truck).toBe('Truck 7')
  })

  it('Field Production: scale-ticket SUMIFS by planting key, the combine row, and the override field', () => {
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    expect(fp.map((r) => [r.field, r.practice])).toEqual([['Home Place', 'Irrigated'], ['Pruitt', 'Dryland'], ['Wheeler', 'Dryland'], ['Moore', 'Dryland'], ['Tweedy', 'Irrigated']])
    near(fp[0].scale_bu, 2010); near(fp[0].production, 2010); near(fp[0].yield, 201)
    near(fp[1].scale_bu, 1700); near(fp[1].production, 1700)
    near(fp[2].scale_bu, 0); near(fp[2].combine_bu, 900); near(fp[2].production, 900); expect(fp[2].source).toBe('combine monitor')
    near(fp[3].production, 1200); near(fp[3].yield, 150)
    near(fp[4].production, 1000); near(fp[4].yield, 200)
    expect(fp.every((r) => r.status === 'complete')).toBe(true)
    expect(fp[0].key).toBe('Home Place Farm / Home Place / Corn 2026')
    expect(fp[0].fsa).toBe('1234')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'scale_bu')).toBe("SUMIFS('Load Data'!$W$2:$W$8,'Load Data'!$AC$2:$AC$8,A2)")
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 2, 'combine_bu')).toBe("SUMIFS('Combine Entries'!$J$3:$J$3,'Combine Entries'!$A$3:$A$3,A4)")
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 2, 'field_total')).toBe('O4')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'yield')).toBe('IFERROR(T2/M2,0)')
    const ce = rowsOf(payload, AUDIT.combine)[0]
    near(ce.netted_bu, 0); near(ce.remainder_bu, 900); expect(ce.complete).toBe('yes')
  })

  it('Summary: SUMIFS over Field Production with bounded ranges; totals are SUMs; yield = production / acres', () => {
    const sm = rowsOf(payload, AUDIT.summary)
    expect(sm.map((r) => [r.county, r.practice])).toEqual([
      ['Colbert County', 'Dryland'], ['Colbert County', 'Irrigated'], ['Lawrence County', 'Dryland'], ['Lawrence County', 'Irrigated'], ['Total', ''],
    ])
    const [cd, ci, ld, li, total] = sm
    expect(ld.state).toBe('AL'); expect(li.state).toBe('AL')
    near(li['acres:corn'], 10); near(li['prod:corn'], 2010); near(li['yield:corn'], 201)
    near(ld['acres:corn'], 18); near(ld['prod:corn'], 2600); expect(Number(ld['yield:corn'])).toBeCloseTo(144.4, 1)
    near(cd['acres:corn'], 8); near(cd['prod:corn'], 1200); near(cd['yield:corn'], 150)
    near(ci['acres:corn'], 5); near(ci['prod:corn'], 1000); near(ci['yield:corn'], 200)
    near(total['acres:corn'], 41); near(total['prod:corn'], 6810); expect(Number(total['yield:corn'])).toBeCloseTo(166.1, 1)
    // Exact formula text, snapshotted by hand: Summary data sits on rows 3–6
    // (group row, header row); Field Production rows 2–6; Lawrence Irrigated
    // is the 4th row (row 6).
    expect(formulaTextOf(payload, AUDIT.summary, 3, 'prod:corn')).toBe(
      "SUMIFS('Field Production'!$T$2:$T$6,'Field Production'!$E$2:$E$6,A6,'Field Production'!$F$2:$F$6,B6,'Field Production'!$G$2:$G$6,\"Corn\",'Field Production'!$I$2:$I$6,C6)",
    )
    expect(formulaTextOf(payload, AUDIT.summary, 3, 'acres:corn')).toBe(
      "SUMIFS('Field Production'!$M$2:$M$6,'Field Production'!$E$2:$E$6,A6,'Field Production'!$F$2:$F$6,B6,'Field Production'!$G$2:$G$6,\"Corn\",'Field Production'!$I$2:$I$6,C6)",
    )
    expect(formulaTextOf(payload, AUDIT.summary, 3, 'yield:corn')).toBe('IFERROR(E6/D6,0)')
    expect(formulaTextOf(payload, AUDIT.summary, 4, 'acres:corn')).toBe('SUM($D$3:$D$6)')
    expect(formulaTextOf(payload, AUDIT.summary, 4, 'prod:corn')).toBe('SUM($E$3:$E$6)')
    expect(formulaTextOf(payload, AUDIT.summary, 4, 'yield:corn')).toBe('IFERROR(E7/D7,0)')
  })

  it('every evaluated Summary number equals the on-screen report for the same fixture', () => {
    const sm = rowsOf(payload, AUDIT.summary)
    report.summaryRows.forEach((row, i) => {
      const cell = row.byCrop.get('corn')!
      near(sm[i]['acres:corn'], cell.acres)
      near(sm[i]['prod:corn'], cell.bu)
      near(sm[i]['yield:corn'], cell.bu / cell.acres)
    })
    near(sm[report.summaryRows.length]['prod:corn'], report.summaryTotals.get('corn')!.bu)
  })

  it('the Notes reconciliation reads OK, and CHECK when the on-screen total is perturbed', () => {
    const notes = rowsOf(payload, AUDIT.notes)
    const diff = notes.find((r) => r.item === 'Corn: Difference')!
    near(diff.value, 0)
    expect(diff.check).toBe('OK')
    expect(notes.find((r) => r.item === 'Organization')!.value).toBe('Turnrow Farm')
    // Perturb the on-screen value (a blue input) and re-evaluate.
    const sec = auditSection(payload, AUDIT.notes)
    const screenRow = sec.rows.findIndex((r) => r[0] === 'Corn: Turnrow on-screen total production (bu)')
    const original = sec.rows[screenRow][1] as { v: number }
    original.v = 6810 + 3
    const again = rowsOf(payload, AUDIT.notes).find((r) => r.item === 'Corn: Difference')!
    near(again.value, -3)
    expect(again.check).toBe('CHECK')
    original.v = 6810
  })

  it('edit propagation: +5,600 lb on L1 moves Home Place, Lawrence Irrigated and the grand total by 100 bu', () => {
    const sec = auditSection(payload, AUDIT.loadData)
    const netIdx = sec.columns.findIndex((c) => c.key === 'net')
    const l1 = sec.rows[0][netIdx] as { v: number }
    expect(l1.v).toBe(56000)
    l1.v = 61600
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    const sm = rowsOf(payload, AUDIT.summary)
    near(fp[0].production, 2110)
    near(sm[3]['prod:corn'], 2110)
    near(sm[4]['prod:corn'], 6910)
    near(sm[4]['yield:corn'], 6910 / 41)
    l1.v = 56000
    near(rowsOf(payload, AUDIT.summary)[4]['prod:corn'], 6810)
  })

  it('the workbook opens with cached results on every formula cell, blue inputs, autofilters and full recalculation on load', async () => {
    const wb = await buildExcelWorkbook(payload)
    expect(wb.calcProperties.fullCalcOnLoad).toBe(true)
    let formulas = 0
    let blue = 0
    for (const ws of wb.worksheets) {
      ws.eachRow((row: any) => row.eachCell((c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const v = c.value
        if (v && typeof v === 'object' && 'formula' in v) {
          formulas++
          expect(c.model.result).not.toBeUndefined() // cell.value drops a 0 result; the written model keeps it
          expect(c.font?.color?.argb ?? 'FF000000').not.toBe('FF0000FF')
        }
        if (c.font?.color?.argb === 'FF0000FF') blue++
      }))
    }
    expect(formulas).toBeGreaterThan(40)
    expect(blue).toBeGreaterThan(20)
    const ld = wb.getWorksheet('Load Data')
    expect(ld.rowCount - 1).toBe(7)
    expect(ld.autoFilter).toBeTruthy()
    expect(ld.views[0].ySplit).toBe(1)
    const sm = wb.getWorksheet('Summary')
    // Lawrence Irrigated production, as Excel will read it.
    expect(sm.getCell('E6').value).toMatchObject({ result: 2010 })
    expect(sm.getCell('E6').value.formula).toContain("SUMIFS('Field Production'!$T$2:$T$6")
    expect(ld.getCell('A2').value).toMatchObject({ hyperlink: 'https://app.turnrow.farm/loads/l1' })
    expect(wb.getWorksheet('Notes').getCell('A1').value).toBe('How this workbook is built')
  })
})

describe('audit workbook — shrink parity with the app', () => {
  it.each([13.0, 15.5, 18.0, 22.5, 25.0])('a 56,000 lb load at %s%% moisture evaluates to exactly computeBushels', (mc) => {
    const ri = reportInput({
      plantings: [planting('p-home', 'home', 10, 0)],
      fields: [fields[0]], farms: [farms[0]],
      loads: [load('lx', '2026-09-01', 'home', 56000, mc)], splits: [], combineEntries: [],
      assumptions: [{ crop_id: 'corn', crop_year: 2026, expected_yield: null, harvest_complete: true }],
    })
    const payload = buildProductionAuditPayload(auditInput(ri))
    const row = rowsOf(payload, AUDIT.loadData)[0]
    const app = computeBushels({ netWeightLb: 56000, moisturePct: mc, baseMoisturePct: 15.5, baseLbPerBushel: 56 }).dryBushels
    expect(row.dry_bu).toBe(app)
    expect(formulaTextOf(payload, AUDIT.loadData, 0, 'dry_bu')).toBe('IF(S2<=T2,R2/U2,R2/U2*(100-S2)/(100-T2))')
    near(rowsOf(payload, AUDIT.summary)[0]['prod:corn'], app!)
  })
})

describe('audit workbook — mixed-practice plantings', () => {
  const RIVER = field('river', 'Riverbend', 'f-home', 10, 10)
  it('an entered breakout: each practice takes its share of the field total; the check reads OK', () => {
    const ri = reportInput({
      fields: [RIVER], farms: [farms[0]],
      plantings: [planting('p-river', 'river', 10, 10, { yield_breakout_entered: true, irrigated_bushels: 1200, dryland_bushels: 800 })],
      loads: [load('r1', '2026-09-01', 'river', 56000, 15.0), load('r2', '2026-09-02', 'river', 56000, 15.0)], // 2,000 bu
      splits: [], combineEntries: [],
      assumptions: [{ crop_id: 'corn', crop_year: 2026, expected_yield: null, harvest_complete: true }],
    })
    const payload = buildProductionAuditPayload(auditInput(ri))
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    expect(fp.map((r) => r.practice)).toEqual(['Irrigated', 'Dryland'])
    expect(fp[0].breakout).toBe('entered breakout')
    near(fp[0].entered_irr, 1200); near(fp[0].entered_dry, 800)
    near(fp[0].share, 0.6); near(fp[0].production, 1200); near(fp[0].yield, 120)
    near(fp[1].share, 0.4); near(fp[1].production, 800)
    near(Number(fp[0].production) + Number(fp[1].production), Number(fp[0].field_total))
    expect(fp[0].check).toBe('OK')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'share')).toBe('IFERROR(P2/(P2+Q2),0)')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'production')).toBe('R2*S2')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'check')).toBe('IF(ABS(P2+Q2-R2)<0.5,"OK","CHECK")')
    const sm = rowsOf(payload, AUDIT.summary)
    near(sm[0]['prod:corn'], 800); near(sm[1]['prod:corn'], 1200); near(sm[2]['prod:corn'], 2000)
    // A stale breakout (loads changed after it was entered) flags CHECK.
    const sec = auditSection(payload, AUDIT.fieldProduction)
    const idx = sec.columns.findIndex((c) => c.key === 'entered_irr')
    ;(sec.rows[0][idx] as { v: number }).v = 1100
    ;(sec.rows[1][idx] as { v: number }).v = 1100
    expect(rowsOf(payload, AUDIT.fieldProduction)[0].check).toBe('CHECK')
  })

  it('a breakout derived from load tags: practice-filtered SUMIFS, the two rows sum to the field total', () => {
    const ri = reportInput({
      fields: [RIVER], farms: [farms[0]],
      plantings: [planting('p-river', 'river', 10, 10)],
      loads: [load('r1', '2026-09-01', 'river', 56000, 15.0, { practice: 'irrigated' }), load('r2', '2026-09-02', 'river', 28000, 15.0, { practice: 'dryland' })],
      splits: [], combineEntries: [],
      assumptions: [{ crop_id: 'corn', crop_year: 2026, expected_yield: null, harvest_complete: true }],
    })
    const report = buildProductionReport(ri)
    expect(report.resolved[0].breakout).toBe('loads')
    expect(report.isBlocked).toBe(false)
    const payload = buildProductionAuditPayload(auditInput(ri))
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    expect(fp[0].breakout).toBe('from load tags')
    near(fp[0].production, 1000); near(fp[1].production, 500); near(fp[0].field_total, 1500)
    expect(fp[0].check).toBe('OK')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'scale_bu')).toBe("SUMIFS('Load Data'!$W$2:$W$3,'Load Data'!$AC$2:$AC$3,A2,'Load Data'!$L$2:$L$3,I2)")
    expect(rowsOf(payload, AUDIT.loadData).map((r) => r.practice)).toEqual(['Irrigated', 'Dryland'])
  })

  it('a mixed planting with no breakout, generated as dryland: everything on the dryland row', () => {
    const ri = reportInput({
      fields: [RIVER], farms: [farms[0]],
      plantings: [planting('p-river', 'river', 10, 10)],
      loads: [load('r1', '2026-09-01', 'river', 56000, 15.0)], splits: [], combineEntries: [],
      assumptions: [{ crop_id: 'corn', crop_year: 2026, expected_yield: null, harvest_complete: true }],
      acceptedAsDryland: true,
    })
    expect(buildProductionReport({ ...ri, acceptedAsDryland: false }).isBlocked).toBe(true)
    const payload = buildProductionAuditPayload(auditInput(ri))
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    expect(fp.map((r) => [r.practice, r.breakout])).toEqual([['Irrigated', 'rolled into dryland'], ['Dryland', 'rolled into dryland']])
    near(fp[0].production, 0); near(fp[1].production, 1000)
    near(fp[0].acres, 10); near(fp[1].acres, 10)
  })
})

describe('audit workbook — cotton', () => {
  it('two receipts flow to Summary lint lbs via SUMIFS; the turnout estimate is its own labeled row', () => {
    const CF = field('cot', 'South 80', 'f-home', 0, 80)
    const ri = reportInput({
      crops: [CORN, COTTON], fields: [CF], farms: [farms[0]],
      plantings: [planting('p-cot', 'cot', 0, 80, {}, 'cotton')],
      loads: [], splits: [], combineEntries: [],
      assumptions: [{ crop_id: 'cotton', crop_year: 2026, expected_yield: null, harvest_complete: true }],
      cotton: { on: true, cottonCropIds: new Set(['cotton']), adapter: null, yieldFor: () => ({ lintLbs: 39000 }) },
    })
    const report = buildProductionReport(ri)
    expect(report.summaryTotals.get('cotton')).toEqual({ acres: 80, bu: 39000 })
    const payload = buildProductionAuditPayload(auditInput(ri, {
      cotton: {
        receipts: [
          { id: 'rc1', gin_id: 'g1', receipt_number: 'R-1', statement_number: 'S-1001', receipt_date: '2026-10-01', field_id: 'cot', crop_year: 2026, modules_count: 4, total_seed_cotton_weight: 50000, bales_count: 40, total_bale_weight: 20000 },
          { id: 'rc2', gin_id: 'g1', receipt_number: 'R-2', statement_number: null, receipt_date: '2026-10-05', field_id: 'cot', crop_year: 2026, modules_count: 3, total_seed_cotton_weight: 37500, bales_count: 30, total_bale_weight: 15000 },
        ],
        bales: [],
        gins: [{ id: 'g1', name: 'Town Creek Gin' }],
        yieldFor: () => ({ yardSeedLbs: 10000, estimatedLintLbs: 4000, actualLintLbs: 35000, turnout: { fraction: 0.4, pct: 40, label: '40.0% from your ginned cotton' } }),
      },
    }))
    expect(payload.sections.map((s) => s.title)).toEqual(['Summary', 'Field Production', 'Load Data', 'Gin Receipts', 'Not Included', 'Notes'])
    const gr = rowsOf(payload, AUDIT.ginReceipts)
    expect(gr.map((r) => r.kind)).toEqual([GINNED_KIND, GINNED_KIND, ESTIMATED_KIND])
    expect(gr[0].receipt).toBe('S-1001'); expect(gr[1].receipt).toBe('R-2'); expect(gr[0].gin).toBe('Town Creek Gin')
    near(gr[0].lint_lbs, 20000); near(gr[1].lint_lbs, 15000); near(gr[2].lint_lbs, 4000)
    near(gr[0].turnout, 40); near(gr[2].turnout, 40)
    expect(gr[2].basis).toContain('estimated, not ginned')
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    near(fp[0].ginned_lint, 35000); near(fp[0].est_lint, 4000); near(fp[0].production, 39000); near(fp[0].yield, 487.5)
    expect(fp[0].unit).toBe('lbs')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'ginned_lint')).toBe("SUMIFS('Gin Receipts'!$Q$3:$Q$5,'Gin Receipts'!$S$3:$S$5,A2,'Gin Receipts'!$A$3:$A$5,\"ginned\")")
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'est_lint')).toBe("SUMIFS('Gin Receipts'!$Q$3:$Q$5,'Gin Receipts'!$S$3:$S$5,A2,'Gin Receipts'!$A$3:$A$5,\"estimated, not ginned\")")
    const sm = rowsOf(payload, AUDIT.summary)
    near(sm[0]['prod:cotton'], 39000); near(sm[0]['acres:cotton'], 80); near(sm[1]['prod:cotton'], 39000)
    const notes = rowsOf(payload, AUDIT.notes)
    expect(notes.find((r) => r.item === 'Cotton: Difference')!.check).toBe('OK')
  })
})

describe('audit workbook — Not Included reasons', () => {
  it('a load with no planting for its field, a load with no crop year, and a January haul credited to the next year', () => {
    const ri = reportInput({
      plantings: [planting('p-home', 'home', 10, 0)], fields: [fields[0], fields[1]], farms: [farms[0], farms[1]],
      loads: [
        load('ok', '2026-09-01', 'home', 56000, 15.0),
        load('nop', '2026-09-02', 'pruitt', 56000, 15.0),
        load('noyr', '2026-09-03', 'home', 56000, 15.0, { crop_year: null }),
        load('jan', '2027-01-10', 'home', 56000, 15.0),
        load('other', '2025-09-03', 'home', 56000, 15.0, { crop_year: 2025 }),
      ],
      splits: [], combineEntries: [],
      assumptions: [{ crop_id: 'corn', crop_year: 2026, expected_yield: null, harvest_complete: true }],
    })
    const payload = buildProductionAuditPayload(auditInput(ri))
    expect(rowsOf(payload, AUDIT.loadData).map((r) => r.ticket)).toEqual(['OK'])
    const ni = rowsOf(payload, AUDIT.notIncluded)
    expect(ni.map((r) => [r.ticket, r.reason])).toEqual([
      ['NOP', 'no 2026 planting for this field and crop'],
      ['NOYR', 'no crop year on the load'],
      ['JAN', 'hauled in 2027: credited to a 2027 planting of this field, not the 2026 one'],
    ])
  })
})
