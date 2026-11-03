import { describe, expect, it } from 'vitest'
import { cropYearOf, groupTriggerReport, matchInsured, rowsForGroup } from '@/lib/trigger-report-import'
import type { InsuranceTriggerReportExtraction, InsuranceTriggerUnitExtraction } from '@/lib/pdf-upload'

const entities = [{ id: 'ts', name: 'Two Seasons Farm, LLC' }, { id: 'vc', name: 'View Celeste Farm, LLC' }, { id: 'tr', name: 'Turnrow' }]
const landowners = [{ id: 'reb', name: 'AF Rebman Residuary Trust' }, { id: 'mary', name: 'Mary Smith' }]
const crops = [{ id: 'corn', name: 'Corn' }, { id: 'cotton', name: 'Cotton' }, { id: 'soy', name: 'Soybean' }]
const counties = [{ id: 'law', name: 'Lawrence', state: 'Alabama', state_code: 'AL' }, { id: 'col', name: 'Colbert', state: 'Alabama', state_code: 'AL' }]

function unit(over: Partial<InsuranceTriggerUnitExtraction>): InsuranceTriggerUnitExtraction {
  return {
    page: 1, insured_name: 'Two Seasons Farm LLC', county: 'Lawrence', state: 'AL', crop: 'CORN', practice: 'non_irrigated',
    unit_label: 'Enterprise Unit', plan_type: 'RP', trigger_yield: 155, aph_yield: 169.1, approved_yield: 193.8, acres: 1340.725,
    expected_county_yield: 165.8, eco_trigger_yield: 157.5, sco_trigger_yield: 142.6, spring_price: 4.42, fall_price: 4.69,
    ...over,
  }
}

describe('matchInsured', () => {
  it('matches entities through the legal-form-blind name key', () => {
    expect(matchInsured('Two Seasons Farm LLC', entities, landowners)).toEqual({ kind: 'entity', id: 'ts' })
    expect(matchInsured('VIEW CELESTE FARM LLC', entities, landowners)).toEqual({ kind: 'entity', id: 'vc' })
  })
  it('matches a landlord insuring their own share to the landowner', () => {
    expect(matchInsured('AF REBMAN RESIDUARY TRUST', entities, landowners)).toEqual({ kind: 'landowner', id: 'reb' })
  })
  it('never matches a trust to the person (different legal payee)', () => {
    expect(matchInsured('Mary Smith Trust', entities, landowners)).not.toEqual({ kind: 'landowner', id: 'mary' })
  })
})

describe('groupTriggerReport', () => {
  const extraction: InsuranceTriggerReportExtraction = {
    report_date: '2026-11-02', agency: 'Silveus', crop_year: null,
    units: [
      unit({}),
      unit({ page: 2, crop: 'COTTON', trigger_yield: 939.1, approved_yield: 1252.1 }),
      unit({ page: 3, crop: 'COTTON', practice: 'irrigated', trigger_yield: null }), // the empty page
      unit({ page: 1, insured_name: 'AF REBMAN RESIDUARY TRUST', trigger_yield: 154.2, acres: 15.805 }),
      unit({ page: 1, insured_name: 'VIEW CELESTE FARM LLC', county: 'Colbert', trigger_yield: 141 }),
    ],
  }
  const groups = groupTriggerReport({ extraction, entities, landowners, crops, counties })

  it('one group per insured; pages with no trigger are dropped', () => {
    expect(groups.map((g) => g.insuredName)).toEqual(['Two Seasons Farm LLC', 'AF REBMAN RESIDUARY TRUST', 'VIEW CELESTE FARM LLC'])
    expect(groups[0].units).toHaveLength(2)
  })
  it('matches crop, county and practice', () => {
    expect(groups[0].units.map((u) => [u.cropId, u.countyId, u.practice])).toEqual([['corn', 'law', 'non_irrigated'], ['cotton', 'law', 'non_irrigated']])
    expect(groups[2].units[0].countyId).toBe('col')
  })
  it('builds rows for the matched insured — landowner rows carry no entity', () => {
    const rows = rowsForGroup(groups[1], cropYearOf(extraction, 2025), extraction)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ crop_year: 2026, entity_id: null, landowner_id: 'reb', trigger_yield: 154.2, reported_acres: 15.805, projected_price: 4.42, harvest_price: 4.69, agency: 'Silveus' })
  })
  it('no insured chosen → nothing to save; an excluded unit is skipped', () => {
    expect(rowsForGroup({ ...groups[0], insured: null }, 2026, extraction)).toEqual([])
    const g = { ...groups[0], units: groups[0].units.map((u, i) => ({ ...u, include: i === 0 })) }
    expect(rowsForGroup(g, 2026, extraction).map((r) => r.crop_id)).toEqual(['corn'])
  })
})

describe('cropYearOf', () => {
  it('printed crop year, else the report date year, else the fallback', () => {
    expect(cropYearOf({ report_date: null, agency: null, crop_year: 2025, units: [] }, 2020)).toBe(2025)
    expect(cropYearOf({ report_date: '2026-11-02', agency: null, crop_year: null, units: [] }, 2020)).toBe(2026)
    expect(cropYearOf({ report_date: null, agency: null, crop_year: null, units: [] }, 2020)).toBe(2020)
  })
})
