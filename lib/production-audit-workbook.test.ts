import { describe, it, expect } from 'vitest'
import { buildProductionReport, loadIdsOfPlantings, type ProductionReportInput } from '@/lib/production-report'
import { buildProductionAuditPayload, auditSection, auditFilename, disambiguateFieldNames, AUDIT, ESTIMATED_KIND, GINNED_KIND, type ProductionAuditInput } from '@/lib/production-audit-workbook'
import { buildProductionBalance, balanceFactors, factorLabel, type BalanceSettlementLine, type BalanceSettlement } from '@/lib/production-balance'
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
//   Wheeler     dryland    6 ac: no loads; combine entry 900 (to bin1).
// Colbert County, AL (entity ent2)
//   Moore       dryland    8 ac: L4's other 600 + L5 33,600 @ 15.5 → 600. 1,200 bu, 150.0
//   Tweedy      irrigated  5 ac: L7 dry_bushels_override 1,000 (blue, "manual override"). 200.0
// Left out: Cedar Lane (harvest in progress — the field the combine is in:
//   its L8 is the crop's latest-dated load), L8 28,000 @ 15.0 → 500.
// Summary (measured): Lawrence Irr 10 / 2,010 / 201.0; Lawrence Dry 18 / 2,600 / 144.4;
//   Colbert Dry 8 / 1,200 / 150.0; Colbert Irr 5 / 1,000 / 200.0;
//   Total 41 / 6,810 / 166.1 (6,810 ÷ 41, not an average of the yields).
// ---------------------------------------------------------------------------

const CORN: Crop = { id: 'corn', name: 'Corn', base_moisture_pct: 15.5, base_lb_per_bushel: 56, harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null, rma_type_override: null }
const COTTON: Crop = { id: 'cotton', name: 'Cotton', base_moisture_pct: null, base_lb_per_bushel: null, harvest_category: 'fall', double_crop: false, combine_adjustment_bu_per_acre: null, rma_type_override: null }
const LAWRENCE: County = { id: 'lawrence', name: 'Lawrence', state: 'Alabama', state_code: 'AL' }
const COLBERT: County = { id: 'colbert', name: 'Colbert', state: 'Alabama', state_code: 'AL' }

const farm = (id: string, name: string, county: string, fsa: string | null = null, entity = 'ent1'): Farm => ({
  id, name, entity_id: entity, fsa_number: fsa, county_id: county, landowner_id: null, is_share_rent: false, landlord_share_percentage: null, cash_rent_per_acre: null,
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
  to_type: 'buyer', to_bin_id: null, to_buyer_id: 'bunge', from_bin_id: null, ...over,
})
const split = (id: string, loadId: string, fieldId: string, net: number, pct: number, dry: number, practice: LoadSplit['practice'] = null): LoadSplit => ({
  id, load_id: loadId, field_id: fieldId, crop_id: 'corn', net_weight: net, percentage: pct, wet_bushels: null, dry_bushels: dry, practice, notes: null, created_at: '',
})

const farms = [farm('f-home', 'Home Place Farm', 'lawrence', '1234'), farm('f-pruitt', 'Pruitt Farm', 'lawrence'), farm('f-wheeler', 'Wheeler Farm', 'lawrence'), farm('f-moore', 'Moore Farm', 'colbert', null, 'ent2'), farm('f-tweedy', 'Tweedy Farm', 'colbert', null, 'ent2'), farm('f-cedar', 'Cedar Lane Farm', 'lawrence')]
const fields = [field('home', 'Home Place', 'f-home', 10, 0), field('pruitt', 'Pruitt', 'f-pruitt', 0, 12), field('wheeler', 'Wheeler', 'f-wheeler', 0, 6), field('moore', 'Moore', 'f-moore', 0, 8), field('tweedy', 'Tweedy', 'f-tweedy', 5, 0), field('cedar', 'Cedar Lane', 'f-cedar', 0, 20)]
const plantings = [planting('p-home', 'home', 10, 0), planting('p-pruitt', 'pruitt', 0, 12), planting('p-wheeler', 'wheeler', 0, 6), planting('p-moore', 'moore', 0, 8), planting('p-tweedy', 'tweedy', 5, 0), planting('p-cedar', 'cedar', 0, 20)]
const loads: AuditLoadRow[] = [
  load('l1', '2026-09-15', 'home', 56000, 15.0, { buyer_ticket_number: 'B-77' }),
  load('l2', '2026-09-15', 'home', 56560, 15.5),
  load('l3', '2026-09-16', 'pruitt', 61600, 14.0),
  load('l4', '2026-09-16', null, 67200, 15.0), // split 50/50 Pruitt / Moore
  load('l5', '2026-09-17', 'moore', 33600, 15.5),
  load('l7', '2026-09-18', 'tweedy', 60000, 20.0, { dry_bushels_override: 1000 }),
  load('l8', '2026-09-20', 'cedar', 28000, 15.0), // latest load of the crop → Cedar Lane is the active field
  load('bin1', '2026-09-21', null, 50000, 15.0, { from_type: 'bin', from_field_id: null, from_bin_id: 'b1', to_type: 'bin', to_bin_id: 'b2' }), // bin-to-bin: never listed
]
const splits = [split('s4a', 'l4', 'pruitt', 33600, 50, 600), split('s4b', 'l4', 'moore', 33600, 50, 600)]
const combineEntries: CombineEntryLike[] = [{
  id: 'ce1', field_id: 'wheeler', crop_id: 'corn', crop_year: 2026, stated_total_bushels: 930, adjusted_total_bushels: 900,
  adjustment_bu_per_acre: -5, destination_bin_id: 'b1', harvest_complete: true, entry_date: '2026-09-17',
}]
const NOW = new Date(2026, 8, 25) // Sep 25: the cohort is active (L8 five days old) — Cedar Lane is held in progress
const NO_COTTON = { on: false as const, cottonCropIds: new Set<string>(), adapter: null, yieldFor: () => null }

function reportInput(over: Partial<ProductionReportInput> = {}): ProductionReportInput {
  return {
    cropYear: 2026, entityId: '', cropIds: [], plantings, fields, farms, counties: [LAWRENCE, COLBERT], crops: [CORN],
    loads, splits, combineEntries, assumptions: [], cotton: NO_COTTON, acceptedAsDryland: false, now: NOW, ...over,
  }
}
function auditInput(ri: ProductionReportInput, over: Partial<ProductionAuditInput> = {}): ProductionAuditInput {
  const report = over.report ?? buildProductionReport(ri)
  return {
    report, cropYear: 2026, entityName: '', cropFilterLabel: 'All crops', orgName: 'Turnrow Farm', generatedAt: new Date(2026, 9, 14, 8, 0, 0),
    appOrigin: 'https://app.turnrow.farm', crops: ri.crops, fields: ri.fields, farms: ri.farms, counties: ri.counties, loads: ri.loads, splits: ri.splits,
    combineEntries: ri.combineEntries, buyers: [{ id: 'bunge', name: 'Bunge' }], bins: [{ id: 'b1', name_or_number: 'Bin 1' }, { id: 'b2', name_or_number: 'Bin 2' }], trucks: [],
    loadSales: [{ id: 'ls1', load_id: 'l1', sale_type: 'contract', contract_id: 'c1', share: 1, buyer_net_bushels: 999.5, spot_price: null, spot_price_source: null, est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: 'line1' }],
    settlementLines: [{ id: 'line1', settlement_id: 'st1' }],
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
const near = (v: unknown, n: number, digits = 6) => expect(Number(v)).toBeCloseTo(n, digits)
/** The escaped "=" & cell criterion exactly as the workbook writes it. */
const esc = (ref: string) => `"="&SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(${ref},"~","~~"),"*","~*"),"?","~?")`

describe('audit workbook — the corn fixture (measured basis)', () => {
  const ri = reportInput()
  const report = buildProductionReport(ri)
  const payload = buildProductionAuditPayload(auditInput(ri))

  it('the engine leaves Cedar Lane out as in progress and keeps the five finished plantings', () => {
    expect(report.inProgress.map((p) => p.id)).toEqual(['p-cedar'])
    expect(report.resolved.map((r) => r.planting.id)).toEqual(['p-home', 'p-pruitt', 'p-wheeler', 'p-moore', 'p-tweedy'])
    expect(report.summaryTotals.get('corn')).toEqual({ acres: 41, bu: 6810 })
    expect(report.excludedLoads).toEqual([])
  })

  it('tabs are in order with no Not Included sheet; Load Data has 7 portions sorted county / farm / field / date', () => {
    expect(payload.sections.map((s) => s.title)).toEqual(['Summary', 'Field Production', 'Load Data', 'Combine Entries', 'Notes'])
    expect(payload.sections.some((s) => /not included/i.test(s.title ?? ''))).toBe(false)
    const ld = rowsOf(payload, AUDIT.loadData)
    expect(ld).toHaveLength(7)
    expect(ld.map((r) => [r.field, r.ticket])).toEqual([['Moore', 'L4'], ['Moore', 'L5'], ['Tweedy', 'L7'], ['Home Place', 'L1'], ['Home Place', 'L2'], ['Pruitt', 'L3'], ['Pruitt', 'L4']])
    expect(ld.every((r) => !('key' in r))).toBe(true)
    expect(rowsOf(payload, AUDIT.combine)).toHaveLength(1)
    for (const s of payload.sections) for (const row of s.rows) expect(JSON.stringify(row)).not.toContain('bin1')
    expect(payload.filename).toBe('Turnrow_Crop_Insurance_Production_2026_All_Measured_2026-10-14')
  })

  it('L4 split rows show 50% and 33,600 lb applied by formula; the override row is blue and noted', () => {
    const ld = rowsOf(payload, AUDIT.loadData)
    const l4 = ld.filter((r) => r.ticket === 'L4')
    expect(l4.map((r) => r.field)).toEqual(['Moore', 'Pruitt'])
    for (const r of l4) { expect(r.split_pct).toBe(50); near(r.net_applied, 33600); near(r.dry_bu, 600); expect(r.note).toContain('split portion') }
    expect(formulaTextOf(payload, AUDIT.loadData, 0, 'net_applied')).toBe('P5*Q5/100')
    expect(formulaTextOf(payload, AUDIT.loadData, 0, 'dry_bu')).toBe('ROUND(IF(S5<=T5,R5/U5,R5/U5*(100-S5)/(100-T5)),2)')
    const l7i = ld.findIndex((r) => r.ticket === 'L7')
    expect(ld[l7i].dry_bu).toBe(1000)
    expect(ld[l7i].override).toBe('manual override')
    expect(formulaTextOf(payload, AUDIT.loadData, l7i, 'dry_bu')).toBeNull()
    const l1 = ld.find((r) => r.ticket === 'L1')!
    expect(l1.settlement).toBe('0000205995'); expect(l1.buyer_ticket).toBe('B-77'); expect(l1.buyer_net_bu).toBe(999.5); expect(l1.destination).toBe('Bunge')
  })

  it('Field Production rows sort county / practice / farm / field and match Load Data on Farm + Field + Crop + Crop Year', () => {
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    expect(fp.map((r) => [r.field, r.practice])).toEqual([['Moore', 'Dryland'], ['Tweedy', 'Irrigated'], ['Pruitt', 'Dryland'], ['Wheeler', 'Dryland'], ['Home Place', 'Irrigated']])
    expect(fp.every((r) => !('key' in r))).toBe(true)
    const home = fp[4]
    near(home.scale_bu, 2010); near(home.production, 2010); near(home.yield, 201); expect(home.crop_year).toBe(2026); expect(home.fsa).toBe('1234')
    near(fp[2].scale_bu, 1700); near(fp[3].scale_bu, 0); near(fp[3].combine_bu, 900); near(fp[3].production, 900); expect(fp[3].source).toBe('combine monitor')
    near(fp[0].production, 1200); near(fp[1].production, 1000)
    // Home Place is the 5th row: Field Production data starts on row 5 (title, text, back link, header).
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 4, 'scale_bu')).toBe(
      `SUMIFS('Load Data'!$W$5:$W$11,'Load Data'!$F$5:$F$11,${esc('A9')},'Load Data'!$G$5:$G$11,${esc('B9')},'Load Data'!$J$5:$J$11,${esc('F9')},'Load Data'!$K$5:$K$11,${esc('G9')})`,
    )
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 3, 'combine_bu')).toBe(
      `SUMIFS('Combine Entries'!$J$5:$J$5,'Combine Entries'!$A$5:$A$5,${esc('A8')},'Combine Entries'!$B$5:$B$5,${esc('B8')},'Combine Entries'!$E$5:$E$5,${esc('F8')},'Combine Entries'!$F$5:$F$5,${esc('G8')})`,
    )
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 3, 'field_total')).toBe('O8')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 4, 'yield')).toBe('IFERROR(T9/M9,0)')
    const ce = rowsOf(payload, AUDIT.combine)[0]
    near(ce.netted_bu, 0); near(ce.remainder_bu, 900); expect(ce.complete).toBe('yes')
  })

  it('Summary: SUMIFS over Field Production with escaped criteria; totals are SUMs; yield = production / acres', () => {
    const sm = rowsOf(payload, AUDIT.summary)
    expect(sm.map((r) => [r.county, r.practice])).toEqual([
      ['Colbert County', 'Dryland'], ['Colbert County', 'Irrigated'], ['Lawrence County', 'Dryland'], ['Lawrence County', 'Irrigated'], ['Total', ''],
    ])
    const [cd, ci, ld, li, total] = sm
    near(li['acres:corn'], 10); near(li['prod:corn'], 2010); near(li['yield:corn'], 201)
    near(ld['acres:corn'], 18); near(ld['prod:corn'], 2600); expect(Number(ld['yield:corn'])).toBeCloseTo(144.4, 1)
    near(cd['acres:corn'], 8); near(cd['prod:corn'], 1200); near(cd['yield:corn'], 150)
    near(ci['acres:corn'], 5); near(ci['prod:corn'], 1000); near(ci['yield:corn'], 200)
    near(total['acres:corn'], 41); near(total['prod:corn'], 6810); expect(Number(total['yield:corn'])).toBeCloseTo(166.1, 1)
    // Summary data starts on row 16: title, subtitle, filters, three KPI rows, "Contents", five link rows, a blank, the group row, the header.
    expect(formulaTextOf(payload, AUDIT.summary, 3, 'prod:corn')).toBe(
      `SUMIFS('Field Production'!$T$5:$T$9,'Field Production'!$D$5:$D$9,${esc('A19')},'Field Production'!$E$5:$E$9,${esc('B19')},'Field Production'!$F$5:$F$9,"=Corn",'Field Production'!$I$5:$I$9,${esc('C19')})`,
    )
    expect(formulaTextOf(payload, AUDIT.summary, 3, 'yield:corn')).toBe('IFERROR(E19/D19,0)')
    expect(formulaTextOf(payload, AUDIT.summary, 4, 'acres:corn')).toBe('SUM($D$16:$D$19)')
    expect(formulaTextOf(payload, AUDIT.summary, 4, 'prod:corn')).toBe('SUM($E$16:$E$19)')
    expect(formulaTextOf(payload, AUDIT.summary, 4, 'yield:corn')).toBe('IFERROR(E20/D20,0)')
    // The KPI rows read the Total row; the Contents rows link every tab.
    const pre = auditSection(payload, AUDIT.summary).prelude!
    const kpis = pre.filter((p) => p.kind === 'kpi')
    expect(kpis.map((k) => [k.cells[0], (k.cells[1] as { v: number }).v])).toEqual([['Corn certified acres', 41], ['Corn production (bu)', 6810], ['Corn yield (bu/ac)', 6810 / 41]])
    expect(formulaTextOf(payload, AUDIT.summary, 4, 'prod:corn')).toBe('SUM($E$16:$E$19)')
    const links = pre.filter((p) => p.kind === 'links')
    expect(links.map((l) => (l.cells[0] as { link: string }).link)).toEqual(["#'Summary'!A1", "#'Field Production'!A1", "#'Load Data'!A1", "#'Combine Entries'!A1", "#'Notes'!A1"])
    // Each field row links to its first Load Data row.
    const fpField = auditSection(payload, AUDIT.fieldProduction).rows[4][1] as { v: string; link: string }
    expect(fpField).toEqual({ v: 'Home Place', link: "#'Load Data'!A8" })
  })

  it('every evaluated Summary number equals the on-screen report for the same fixture', () => {
    const sm = rowsOf(payload, AUDIT.summary)
    report.summaryRows.forEach((row, i) => {
      const cell = row.byCrop.get('corn')!
      near(sm[i]['acres:corn'], cell.acres); near(sm[i]['prod:corn'], cell.bu); near(sm[i]['yield:corn'], cell.bu / cell.acres)
    })
    near(sm[report.summaryRows.length]['prod:corn'], report.summaryTotals.get('corn')!.bu)
  })

  it('the Notes reconciliation reads OK, and CHECK when the on-screen total is perturbed', () => {
    const notes = rowsOf(payload, AUDIT.notes)
    const diff = notes.find((r) => r.item === 'Corn: Difference')!
    near(diff.value, 0); expect(diff.check).toBe('OK')
    expect(notes.find((r) => r.item === 'Production basis')!.value).toBe('Measured (scale tickets)')
    const sec = auditSection(payload, AUDIT.notes)
    const screenRow = sec.rows.findIndex((r) => r[0] === 'Corn: Turnrow on-screen total production (bu)')
    const original = sec.rows[screenRow][1] as { v: number }
    original.v = 6810 + 3
    expect(rowsOf(payload, AUDIT.notes).find((r) => r.item === 'Corn: Difference')!.check).toBe('CHECK')
    original.v = 6810
  })

  it('edit propagation: +5,600 lb on L1 moves Home Place, Lawrence Irrigated and the grand total by 100 bu', () => {
    const sec = auditSection(payload, AUDIT.loadData)
    const netIdx = sec.columns.findIndex((c) => c.key === 'net')
    const l1 = sec.rows[3][netIdx] as { v: number }
    expect(l1.v).toBe(56000)
    l1.v = 61600
    near(rowsOf(payload, AUDIT.fieldProduction)[4].production, 2110)
    const sm = rowsOf(payload, AUDIT.summary)
    near(sm[3]['prod:corn'], 2110); near(sm[4]['prod:corn'], 6910); near(sm[4]['yield:corn'], 6910 / 41)
    l1.v = 56000
    near(rowsOf(payload, AUDIT.summary)[4]['prod:corn'], 6810)
  })

  it('the written workbook: cached results, no merges, header notes, banding + check formats, print setup, properties, no error cells', async () => {
    const wb = await buildExcelWorkbook(payload)
    expect(wb.calcProperties.fullCalcOnLoad).toBe(true)
    expect(wb.title).toBe('Crop Insurance Production Report 2026')
    expect(wb.company).toBe('Turnrow Farm')
    expect(wb.created).toBeInstanceOf(Date)
    expect(wb.views[0].activeTab).toBe(0)
    let formulas = 0, blue = 0, notes = 0
    for (const ws of wb.worksheets) {
      expect(ws.model.merges ?? []).toEqual([])
      expect(ws.views[0].showGridLines).toBe(false)
      expect(ws.pageSetup.orientation).toBe('landscape')
      expect(ws.pageSetup.fitToWidth).toBe(1)
      expect(ws.pageSetup.printTitlesRow).toMatch(/^\d+:\d+$/)
      expect(ws.headerFooter.oddFooter).toContain('page &P of &N')
      const cfs = ws.conditionalFormattings ?? []
      expect(cfs.some((cf: any) => cf.rules.some((r: any) => r.type === 'expression' && r.formulae[0] === 'MOD(ROW(),2)=0'))).toBe(true) // eslint-disable-line @typescript-eslint/no-explicit-any
      ws.eachRow((row: any) => row.eachCell((c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const v = c.value
        if (v && typeof v === 'object' && 'formula' in v) {
          formulas++
          expect(c.model.result).not.toBeUndefined()
          expect(typeof c.model.result === 'object' && c.model.result && 'error' in c.model.result).toBe(false)
          expect(c.font?.color?.argb ?? 'FF000000').not.toBe('FF0000FF')
        }
        if (c.font?.color?.argb === 'FF0000FF') blue++
        if (c.note) notes++
        if (c.font) expect(c.font.name).toBe('Calibri')
      }))
    }
    expect(formulas).toBeGreaterThan(40); expect(blue).toBeGreaterThan(20); expect(notes).toBeGreaterThan(20)
    const ld = wb.getWorksheet('Load Data')
    expect(ld.getRow(4).getCell(1).value).toBe('Date')
    expect(ld.getRow(4).getCell(1).fill.fgColor.argb).toBe('FF0B4A24')
    expect(ld.getRow(4).height).toBe(30)
    expect(ld.rowCount - 4).toBe(7)
    expect(ld.autoFilter).toEqual({ from: { row: 4, column: 1 }, to: { row: 11, column: 28 } })
    expect(ld.views[0]).toMatchObject({ ySplit: 4, xSplit: 2 })
    const sm = wb.getWorksheet('Summary')
    expect(sm.properties.tabColor.argb).toBe('FF36B449')
    expect(sm.getCell('A1').value).toBe('Turnrow Farm')
    expect(sm.getCell('E19').value).toMatchObject({ result: 2010 })
    expect(sm.getCell('E19').numFmt).toBe('#,##0;(#,##0);"–"')
    expect(sm.getCell('D19').numFmt).toBe('#,##0.00;(#,##0.00);"–"')
    expect(sm.getCell('A15').value).toBe('County')
    expect(sm.getRow(14).height).toBe(45)
    const cfSm = sm.conditionalFormattings.find((cf: any) => cf.rules.some((r: any) => r.type === 'cellIs')) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cfSm).toBeUndefined() // no check column on Summary
    const notesWs = wb.getWorksheet('Notes')
    expect(notesWs.properties.tabColor.argb).toBe('FF9CA3AF')
    expect(notesWs.conditionalFormattings.some((cf: any) => cf.rules.some((r: any) => r.type === 'cellIs' && r.formulae[0] === '"CHECK"'))).toBe(true) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ld.getCell('D5').value).toMatchObject({ hyperlink: 'https://app.turnrow.farm/loads/l4' })
    expect(wb.getWorksheet('Field Production').getCell('B9').value).toMatchObject({ text: 'Home Place', hyperlink: "#'Load Data'!A8" })
  })
})

// ---------------------------------------------------------------------------
// Balanced to settlements
// ---------------------------------------------------------------------------
const ST: BalanceSettlement[] = [{ id: 'st1', buyer_id: 'bunge', settlement_date: '2026-10-01', settlement_number: '0000205995' }, { id: 'st2', buyer_id: 'bunge', settlement_date: '2026-10-08', settlement_number: '0000206001' }]
const lineFor = (id: string, loadId: string | null, bu: number, settlement = 'st1'): BalanceSettlementLine => ({ id, settlement_id: settlement, load_id: loadId, net_bushels: bu, ticket_number: loadId?.toUpperCase() ?? null })
// A bin-out load: 50,400 lb @ base → 900 bu hauled out of bin1 to Bunge (so bin1 nets to 0 with Wheeler's 900 combine remainder).
const L9 = load('l9', '2026-10-05', null, 50400, 15.5, { from_type: 'bin', from_field_id: null, from_bin_id: 'b1', to_type: 'buyer', to_buyer_id: 'bunge' })
const ALL_SOLD_LINES = [lineFor('n1', 'l1', 1000), lineFor('n2', 'l2', 1000), lineFor('n3', 'l3', 1100), lineFor('n4', 'l4', 1200), lineFor('n5', 'l5', 600), lineFor('n7', 'l7', 1000), lineFor('n9', 'l9', 800, 'st2')] // 6,700

function balancedCase(lines: BalanceSettlementLine[], extraLoads: AuditLoadRow[] = [L9], riOver: Partial<ProductionReportInput> = {}) {
  const allLoads = [...loads, ...extraLoads]
  const measuredAll = buildProductionReport(reportInput({ loads: allLoads, entityId: '' }))
  const measuredByCrop = new Map([...measuredAll.summaryTotals].map(([id, c]) => [id, c.bu]))
  const combineRemainders = [...measuredAll.aggByKey.values()].filter((a) => a.combine).map((a) => ({ crop_id: 'corn', crop_year: 2026, destinationBinId: a.combine!.destinationBinId, remainderBu: a.combine!.remainderBu }))
  // Cedar Lane is still harvesting: its L8 is left out of the report, so it enters no side of the balance.
  const excludeLoadIds = loadIdsOfPlantings(allLoads, splits, measuredAll.inProgress)
  expect([...excludeLoadIds]).toEqual(['l8'])
  const balance = buildProductionBalance({ cropYear: 2026, crops: [CORN], cottonCropIds: new Set(), loads: allLoads, lines, settlements: ST, measuredByCrop, combineRemainders, excludeLoadIds })
  const ri = reportInput({ loads: allLoads, balanceFactorByCrop: balanceFactors(balance), ...riOver })
  const report = buildProductionReport(ri)
  const payload = buildProductionAuditPayload(auditInput(ri, { report, basis: 'balanced', balance, settlements: ST.map((s) => ({ id: s.id, settlement_number: s.settlement_number })) }))
  return { balance, report, payload }
}

describe('audit workbook — balanced to settlements', () => {
  it('all sold: factor 6,700 / 6,810 = 0.983847 (−1.62%); fields and summary scale; total = the settled bushels exactly; both checks OK', () => {
    const { balance, report, payload } = balancedCase(ALL_SOLD_LINES)
    const b = balance.byCrop.get('corn')!
    near(b.measured, 6810); near(b.settled, 6700); near(b.unsettled, 0); near(b.bins, 0); near(b.balancedTotal, 6700)
    expect(b.settlementCount).toBe(2); expect(b.settledLines).toHaveLength(7)
    expect(b.factor).toBeCloseTo(0.983847, 6); expect(factorLabel(b.factor)).toBe('0.9838 (−1.62%)')
    expect(b.allPaid).toBe(true); expect(b.warn).toBe(false); expect(b.unmatched.lines).toBe(0)
    // Screen (engine with the factor applied).
    const sm = report.summaryRows.map((r) => [r.countyLabel, r.practice, r.byCrop.get('corn')!.bu, r.byCrop.get('corn')!.bu / r.byCrop.get('corn')!.acres] as const)
    expect(sm.map(([c, p]) => `${c} ${p}`)).toEqual(['Colbert County dryland', 'Colbert County irrigated', 'Lawrence County dryland', 'Lawrence County irrigated'])
    near(sm[3][2], 1977.533, 2); near(sm[3][3], 197.8, 1)
    near(sm[2][2], 2558.003, 2); near(sm[2][3], 142.1, 1)
    near(sm[0][2], 1180.617, 2); near(sm[0][3], 147.6, 1)
    near(sm[1][2], 983.847, 2); near(sm[1][3], 196.8, 1)
    near(report.summaryTotals.get('corn')!.bu, 6700, 6); near(6700 / 41, 163.4, 1)
    const byField = Object.fromEntries(report.resolved.map((r) => [r.fieldDisplayName, r.totalBu]))
    near(byField['Home Place'], 1977.533, 2); near(byField.Pruitt, 1672.540, 2); near(byField.Wheeler, 885.463, 2); near(byField.Moore, 1180.617, 2); near(byField.Tweedy, 983.847, 2)
    // Workbook: the tabs, the live balance, the balanced columns.
    expect(payload.sections.map((s) => s.title)).toEqual(['Summary', 'Settlement Balance', 'Field Production', 'Load Data', 'Combine Entries', 'Settlements', 'Unsettled Deliveries', 'Notes'])
    expect(payload.filename).toBe('Turnrow_Crop_Insurance_Production_2026_All_Balanced_2026-10-14')
    const bal = rowsOf(payload, AUDIT.balance)
    const item = (s: string) => bal.find((r) => r.item === s)!
    near(item('Corn: Measured total (bu)').value, 6810); near(item('Corn: Settled (paid) bu').value, 6700)
    near(item('Corn: Delivered, not settled (bu)').value, 0); near(item('Corn: Still in bins (bu)').value, 0)
    near(item('Corn: Balanced total (bu)').value, 6700); near(item('Corn: Factor').value, 0.983847, 6); near(item('Corn: Factor').pct, -0.016153, 6)
    expect(item('Corn: Check').value).toBe('OK'); expect(item('Corn: Production equals bushels paid').value).toBe('OK')
    expect(formulaTextOf(payload, AUDIT.balance, 1, 'value')).toBe(`SUMIFS('Settlements'!$I$5:$I$11,'Settlements'!$G$5:$G$11,"=Corn")`)
    expect(formulaTextOf(payload, AUDIT.balance, 5, 'value')).toBe('IFERROR($B$9/$B$5,1)')
    expect(rowsOf(payload, AUDIT.settlements)).toHaveLength(7)
    expect(rowsOf(payload, AUDIT.settlements).map((r) => r.source)).toContain('bin: Bin 1')
    expect(rowsOf(payload, AUDIT.unsettled)).toHaveLength(0)
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    const home = fp.find((r) => r.field === 'Home Place')!
    near(home.production, 2010); near(home.balanced_production, 1977.533, 2); near(home.balanced_yield, 197.8, 1)
    expect(formulaTextOf(payload, AUDIT.fieldProduction, fp.indexOf(home), 'balanced_production')).toBe("T9*'Settlement Balance'!$B$10")
    const smw = rowsOf(payload, AUDIT.summary)
    near(smw[3]['prod:corn'], 1977.533, 2); near(smw[3]['mprod:corn'], 2010); near(smw[4]['prod:corn'], 6700, 6); near(smw[4]['mprod:corn'], 6810)
    expect(auditSection(payload, AUDIT.summary).groups!.map((g) => g.label)).toEqual(['', 'Certified Acres', 'Balanced production', 'Balanced yield/acre', 'Measured production', 'Measured yield/acre'])
    const notes = rowsOf(payload, AUDIT.notes)
    expect(notes.find((r) => r.item === 'Corn: Difference')!.check).toBe('OK')
    expect(notes.find((r) => r.item === 'Production basis')!.value).toBe('Balanced to settlements')
    const kpi = auditSection(payload, AUDIT.summary).prelude!.find((p) => p.kind === 'kpi' && p.cells[0] === 'Corn settlement factor')!
    expect((kpi.cells[1] as { v: number }).v).toBeCloseTo(0.983847, 6)
  })

  it('not all sold: settled 4,800 + unsettled 1,200 + bins 700 = 6,700 — same factor, same fields, no "equals bushels paid" check', () => {
    // L7 (1,000) and a 200-bu bin-out load have no line yet; bin1 = 900 remainder − 200 out = 700.
    const L10 = load('l10', '2026-10-06', null, 11200, 15.5, { from_type: 'bin', from_field_id: null, from_bin_id: 'b1', to_type: 'buyer', to_buyer_id: 'bunge' })
    const lines = [lineFor('n1', 'l1', 1000), lineFor('n2', 'l2', 1000), lineFor('n3', 'l3', 1100), lineFor('n4', 'l4', 1200), lineFor('n5', 'l5', 500)]
    const { balance, report, payload } = balancedCase(lines, [L10])
    const b = balance.byCrop.get('corn')!
    near(b.settled, 4800); near(b.unsettled, 1200); near(b.bins, 700); near(b.balancedTotal, 6700)
    expect(b.unsettledLoads.map((x) => x.load.id)).toEqual(['l7', 'l10'])
    expect(b.factor).toBeCloseTo(0.983847, 6); expect(b.allPaid).toBe(false)
    near(report.resolved.find((r) => r.fieldDisplayName === 'Home Place')!.totalBu, 1977.533, 2)
    const bal = rowsOf(payload, AUDIT.balance)
    expect(bal.find((r) => r.item === 'Corn: Check')!.value).toBe('OK')
    expect(bal.some((r) => r.item === 'Corn: Production equals bushels paid')).toBe(false)
    expect(rowsOf(payload, AUDIT.unsettled).map((r) => [r.ticket, r.source])).toEqual([['L7', 'Tweedy'], ['L10', 'bin: Bin 1']])
    near(rowsOf(payload, AUDIT.unsettled)[0].dry_bu, 1000)
  })

  it('an unmatched settlement line of 120 bu is not counted and raises the notice', () => {
    const { balance } = balancedCase([...ALL_SOLD_LINES, lineFor('nx', null, 120)])
    const b = balance.byCrop.get('corn')!
    near(b.settled, 6700)
    expect(b.unmatched).toEqual({ lines: 1, bu: 120, settlementIds: ['st1'] })
    expect(balance.orphanUnmatched.lines).toBe(0)
    // A settlement with no matched line at all is an orphan: no crop until matched.
    const orphan = buildProductionBalance({ cropYear: 2026, crops: [CORN], cottonCropIds: new Set(), loads, lines: [lineFor('o1', null, 50, 'st3')], settlements: [...ST, { id: 'st3', buyer_id: 'bunge', settlement_date: '2026-11-01', settlement_number: 'X' }], measuredByCrop: new Map([['corn', 6810]]) })
    expect(orphan.orphanUnmatched).toEqual({ lines: 1, bu: 50, settlementIds: ['st3'] })
  })

  it('an entity filter keeps the crop-wide factor: Home Place still shows 1,977.533', () => {
    const { balance, report } = balancedCase(ALL_SOLD_LINES, [L9], { entityId: 'ent1' })
    expect(balance.byCrop.get('corn')!.factor).toBeCloseTo(0.983847, 6)
    expect(report.resolved.map((r) => r.fieldDisplayName)).toEqual(['Home Place', 'Pruitt', 'Wheeler'])
    near(report.resolved[0].totalBu, 1977.533, 2)
    near(report.summaryTotals.get('corn')!.bu, (2010 + 1700 + 900) * balance.byCrop.get('corn')!.factor, 6)
  })

  it('a factor of 1.06 shows the amber warning', () => {
    const b = buildProductionBalance({ cropYear: 2026, crops: [CORN], cottonCropIds: new Set(), loads: [loads[0]], lines: [lineFor('n1', 'l1', 7218.6)], settlements: ST, measuredByCrop: new Map([['corn', 6810]]) }).byCrop.get('corn')!
    expect(b.factor).toBeCloseTo(1.06, 6)
    expect(b.warn).toBe(true)
    expect(factorLabel(b.factor)).toBe('1.0600 (+6.00%)')
  })

  it('cotton in the same export is unaffected by the basis', () => {
    const CF = field('cot', 'South 80', 'f-home', 0, 80)
    const cottonModel = { on: true as const, cottonCropIds: new Set(['cotton']), adapter: null, yieldFor: () => ({ lintLbs: 39000 }) }
    const base = reportInput({ crops: [CORN, COTTON], fields: [...fields, CF], plantings: [...plantings, planting('p-cot', 'cot', 0, 80, {}, 'cotton')], loads: [...loads, L9], cotton: cottonModel, assumptions: [{ crop_id: 'cotton', crop_year: 2026, expected_yield: null, harvest_complete: true }] })
    const measuredAll = buildProductionReport(base)
    const balance = buildProductionBalance({ cropYear: 2026, crops: [CORN, COTTON], cottonCropIds: new Set(['cotton']), loads: [...loads, L9], lines: ALL_SOLD_LINES, settlements: ST, measuredByCrop: new Map([...measuredAll.summaryTotals].map(([id, c]) => [id, c.bu])), combineRemainders: [{ crop_id: 'corn', crop_year: 2026, destinationBinId: 'b1', remainderBu: 900 }], excludeLoadIds: loadIdsOfPlantings([...loads, L9], splits, measuredAll.inProgress) })
    expect(balance.byCrop.has('cotton')).toBe(false)
    const report = buildProductionReport({ ...base, balanceFactorByCrop: balanceFactors(balance) })
    expect(report.summaryTotals.get('cotton')).toEqual({ acres: 80, bu: 39000 })
    near(report.summaryTotals.get('corn')!.bu, 6700, 6)
    const payload = buildProductionAuditPayload(auditInput(base, { report, basis: 'balanced', balance, cotton: { receipts: [{ id: 'rc1', gin_id: null, receipt_number: 'R-1', receipt_date: '2026-10-01', field_id: 'cot', crop_year: 2026, total_seed_cotton_weight: 90000, bales_count: 70, total_bale_weight: 35000 }], bales: [], gins: [], yieldFor: () => ({ yardSeedLbs: 10000, estimatedLintLbs: 4000, actualLintLbs: 35000, turnout: { fraction: 0.4, pct: 40, label: '40.0%' } }) } }))
    const sm = rowsOf(payload, AUDIT.summary)
    const total = sm[sm.length - 1]
    near(total['prod:cotton'], 39000); near(total['mprod:cotton'], 39000); near(total['prod:corn'], 6700, 6)
    expect(rowsOf(payload, AUDIT.balance).some((r) => String(r.item).startsWith('Cotton'))).toBe(false)
  })
})

describe('audit workbook — shrink parity with the app', () => {
  it.each([13.0, 15.5, 18.0, 22.5, 25.0])('a 56,000 lb load at %s%% moisture evaluates to exactly computeBushels', (mc) => {
    const ri = reportInput({
      plantings: [planting('p-home', 'home', 10, 0)], fields: [fields[0]], farms: [farms[0]],
      loads: [load('lx', '2026-09-01', 'home', 56000, mc)], splits: [], combineEntries: [],
      assumptions: [{ crop_id: 'corn', crop_year: 2026, expected_yield: null, harvest_complete: true }],
    })
    const payload = buildProductionAuditPayload(auditInput(ri))
    const row = rowsOf(payload, AUDIT.loadData)[0]
    const app = computeBushels({ netWeightLb: 56000, moisturePct: mc, baseMoisturePct: 15.5, baseLbPerBushel: 56 }).dryBushels
    expect(row.dry_bu).toBe(app)
    expect(formulaTextOf(payload, AUDIT.loadData, 0, 'dry_bu')).toBe('IF(S5<=T5,R5/U5,R5/U5*(100-S5)/(100-T5))')
    near(rowsOf(payload, AUDIT.summary)[0]['prod:corn'], app!)
  })
})

describe('audit workbook — mixed-practice plantings', () => {
  const RIVER = field('river', 'Riverbend', 'f-home', 10, 10)
  const complete = [{ crop_id: 'corn', crop_year: 2026, expected_yield: null, harvest_complete: true }]
  it('an entered breakout: each practice takes its share of the field total; the check reads OK', () => {
    const ri = reportInput({
      fields: [RIVER], farms: [farms[0]], plantings: [planting('p-river', 'river', 10, 10, { yield_breakout_entered: true, irrigated_bushels: 1200, dryland_bushels: 800 })],
      loads: [load('r1', '2026-09-01', 'river', 56000, 15.0), load('r2', '2026-09-02', 'river', 56000, 15.0)], splits: [], combineEntries: [], assumptions: complete,
    })
    const payload = buildProductionAuditPayload(auditInput(ri))
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    expect(fp.map((r) => r.practice)).toEqual(['Dryland', 'Irrigated'])
    const irr = fp[1], dry = fp[0]
    near(irr.entered_irr, 1200); near(irr.share, 0.6); near(irr.production, 1200); near(irr.yield, 120); near(dry.share, 0.4); near(dry.production, 800)
    expect(irr.check).toBe('OK')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 1, 'share')).toBe('IFERROR(P6/(P6+Q6),0)')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 1, 'production')).toBe('R6*S6')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 1, 'check')).toBe('IF(ABS(P6+Q6-R6)<0.5,"OK","CHECK")')
    const sec = auditSection(payload, AUDIT.fieldProduction)
    const idx = sec.columns.findIndex((c) => c.key === 'entered_irr')
    for (const r of sec.rows) (r[idx] as { v: number }).v = 1100
    expect(rowsOf(payload, AUDIT.fieldProduction)[0].check).toBe('CHECK')
  })
  it('a breakout derived from load tags: practice-filtered SUMIFS, the two rows sum to the field total', () => {
    const ri = reportInput({
      fields: [RIVER], farms: [farms[0]], plantings: [planting('p-river', 'river', 10, 10)],
      loads: [load('r1', '2026-09-01', 'river', 56000, 15.0, { practice: 'irrigated' }), load('r2', '2026-09-02', 'river', 28000, 15.0, { practice: 'dryland' })], splits: [], combineEntries: [], assumptions: complete,
    })
    expect(buildProductionReport(ri).resolved[0].breakout).toBe('loads')
    const payload = buildProductionAuditPayload(auditInput(ri))
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    near(fp[1].production, 1000); near(fp[0].production, 500); near(fp[0].field_total, 1500); expect(fp[0].check).toBe('OK')
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'scale_bu')).toBe(
      `SUMIFS('Load Data'!$W$5:$W$6,'Load Data'!$F$5:$F$6,${esc('A5')},'Load Data'!$G$5:$G$6,${esc('B5')},'Load Data'!$J$5:$J$6,${esc('F5')},'Load Data'!$K$5:$K$6,${esc('G5')},'Load Data'!$L$5:$L$6,${esc('I5')})`,
    )
  })
  it('a mixed planting with no breakout, generated as dryland: everything on the dryland row', () => {
    const ri = reportInput({ fields: [RIVER], farms: [farms[0]], plantings: [planting('p-river', 'river', 10, 10)], loads: [load('r1', '2026-09-01', 'river', 56000, 15.0)], splits: [], combineEntries: [], assumptions: complete, acceptedAsDryland: true })
    expect(buildProductionReport({ ...ri, acceptedAsDryland: false }).isBlocked).toBe(true)
    const fp = rowsOf(buildProductionAuditPayload(auditInput(ri)), AUDIT.fieldProduction)
    expect(fp.map((r) => [r.practice, r.breakout])).toEqual([['Dryland', 'rolled into dryland'], ['Irrigated', 'rolled into dryland']])
    near(fp[0].production, 1000); near(fp[1].production, 0)
  })
})

describe('audit workbook — identity without a key', () => {
  const complete = [{ crop_id: 'corn', crop_year: 2026, expected_yield: null, harvest_complete: true }]
  it('two fields that read alike are disambiguated identically on both tabs and sum separately', () => {
    const fa = field('n40a', 'North 40', 'f-home', 10, 0), fb = field('n40b', 'North 40', 'f-home', 0, 10)
    const ri = reportInput({
      fields: [fa, fb], farms: [farms[0]], plantings: [planting('p-a', 'n40a', 10, 0), planting('p-b', 'n40b', 0, 10)],
      loads: [load('a1', '2026-09-01', 'n40a', 56000, 15.0), load('b1', '2026-09-02', 'n40b', 28000, 15.0), load('b2', '2026-09-03', 'n40b', 28000, 15.0)], splits: [], combineEntries: [], assumptions: complete,
    })
    const payload = buildProductionAuditPayload(auditInput(ri))
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    expect(fp.map((r) => [r.field, r.practice])).toEqual([['North 40 (2)', 'Dryland'], ['North 40', 'Irrigated']])
    near(fp[1].production, 1000); near(fp[0].production, 1000)
    expect(rowsOf(payload, AUDIT.loadData).map((r) => r.field)).toEqual(['North 40', 'North 40 (2)', 'North 40 (2)'])
    expect(rowsOf(payload, AUDIT.notes).some((r) => String(r.item).includes('North 40 (2)'))).toBe(true)
    expect(disambiguateFieldNames([{ id: 'x', farmName: 'F', fieldName: 'A', cropName: 'Corn', year: 2026 }, { id: 'y', farmName: 'F', fieldName: 'a', cropName: 'Corn', year: 2026 }]).byId.get('y')).toBe('a (2)')
  })
  it('criteria are "=" & the cell with wildcards escaped: "<40" and "Pivot*" match only themselves', () => {
    const f1 = field('lt', '<40', 'f-home', 10, 0), f2 = field('piv', 'Pivot*', 'f-home', 10, 0), f3 = field('pivn', 'Pivot North', 'f-home', 10, 0), f4 = field('p40', '40', 'f-home', 10, 0)
    const ri = reportInput({
      fields: [f1, f2, f3, f4], farms: [farms[0]], plantings: [planting('p1', 'lt', 10, 0), planting('p2', 'piv', 10, 0), planting('p3', 'pivn', 10, 0), planting('p4', 'p40', 10, 0)],
      loads: [load('x1', '2026-09-01', 'lt', 56000, 15.0), load('x2', '2026-09-01', 'piv', 112000, 15.0), load('x3', '2026-09-01', 'pivn', 168000, 15.0), load('x4', '2026-09-01', 'p40', 224000, 15.0)],
      splits: [], combineEntries: [], assumptions: complete,
    })
    const payload = buildProductionAuditPayload(auditInput(ri))
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    expect(Object.fromEntries(fp.map((r) => [r.field, r.production]))).toEqual({ '<40': 1000, 'Pivot*': 2000, 'Pivot North': 3000, '40': 4000 })
    expect(formulaTextOf(payload, AUDIT.fieldProduction, 0, 'scale_bu')).toContain('"="&SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(B5,"~","~~"),"*","~*"),"?","~?")')
  })
  it('the screen notices replace the Not Included tab: other calendar year, no planting, no crop year', () => {
    const ri = reportInput({
      plantings: [planting('p-home', 'home', 10, 0)], fields: [fields[0], fields[1]], farms: [farms[0], farms[1]],
      loads: [load('ok', '2026-09-01', 'home', 56000, 15.0), load('nop', '2026-09-02', 'pruitt', 56000, 15.0), load('noyr', '2026-09-03', 'home', 56000, 15.0, { crop_year: null }), load('jan', '2027-01-10', 'home', 56000, 15.0), load('other', '2025-09-03', 'home', 56000, 15.0, { crop_year: 2025 })],
      splits: [], combineEntries: [], assumptions: complete,
    })
    const report = buildProductionReport(ri)
    expect(report.excludedLoads.map((x) => [x.ticket, x.reason])).toEqual([['NOP', 'no_planting'], ['NOYR', 'no_crop_year'], ['JAN', 'other_calendar_year']])
    const payload = buildProductionAuditPayload(auditInput(ri, { report }))
    expect(rowsOf(payload, AUDIT.loadData).map((r) => r.ticket)).toEqual(['OK'])
    expect(payload.sections.some((s) => s.key === 'not_included')).toBe(false)
  })
  it('the file name carries year, crops and basis', () => {
    expect(auditFilename(2026, ['Corn', 'Soybeans'], 'balanced', new Date(2026, 9, 14))).toBe('Turnrow_Crop_Insurance_Production_2026_Corn-Soybeans_Balanced_2026-10-14')
  })
})

describe('audit workbook — cotton', () => {
  it('two receipts flow to Summary lint lbs via SUMIFS; the turnout estimate is its own labeled row', () => {
    const CF = field('cot', 'South 80', 'f-home', 0, 80)
    const ri = reportInput({
      crops: [CORN, COTTON], fields: [CF], farms: [farms[0]], plantings: [planting('p-cot', 'cot', 0, 80, {}, 'cotton')], loads: [], splits: [], combineEntries: [],
      assumptions: [{ crop_id: 'cotton', crop_year: 2026, expected_yield: null, harvest_complete: true }],
      cotton: { on: true, cottonCropIds: new Set(['cotton']), adapter: null, yieldFor: () => ({ lintLbs: 39000 }) },
    })
    const payload = buildProductionAuditPayload(auditInput(ri, {
      cotton: {
        receipts: [
          { id: 'rc1', gin_id: 'g1', receipt_number: 'R-1', statement_number: 'S-1001', receipt_date: '2026-10-01', field_id: 'cot', crop_year: 2026, modules_count: 4, total_seed_cotton_weight: 50000, bales_count: 40, total_bale_weight: 20000 },
          { id: 'rc2', gin_id: 'g1', receipt_number: 'R-2', statement_number: null, receipt_date: '2026-10-05', field_id: 'cot', crop_year: 2026, modules_count: 3, total_seed_cotton_weight: 37500, bales_count: 30, total_bale_weight: 15000 },
        ],
        bales: [], gins: [{ id: 'g1', name: 'Town Creek Gin' }],
        yieldFor: () => ({ yardSeedLbs: 10000, estimatedLintLbs: 4000, actualLintLbs: 35000, turnout: { fraction: 0.4, pct: 40, label: '40.0% from your ginned cotton' } }),
      },
    }))
    expect(payload.sections.map((s) => s.title)).toEqual(['Summary', 'Field Production', 'Load Data', 'Gin Receipts', 'Notes'])
    const gr = rowsOf(payload, AUDIT.ginReceipts)
    expect(gr.map((r) => r.kind)).toEqual([GINNED_KIND, GINNED_KIND, ESTIMATED_KIND])
    near(gr[0].lint_lbs, 20000); near(gr[1].lint_lbs, 15000); near(gr[2].lint_lbs, 4000); near(gr[2].turnout, 40)
    const fp = rowsOf(payload, AUDIT.fieldProduction)
    near(fp[0].ginned_lint, 35000); near(fp[0].est_lint, 4000); near(fp[0].production, 39000); near(fp[0].yield, 487.5)
    near(rowsOf(payload, AUDIT.summary)[1]['prod:cotton'], 39000)
    expect(rowsOf(payload, AUDIT.notes).find((r) => r.item === 'Cotton: Difference')!.check).toBe('OK')
  })
})
