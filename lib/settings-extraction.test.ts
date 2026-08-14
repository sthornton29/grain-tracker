import { describe, it, expect } from 'vitest'
import {
  normalizeSettingsExtraction, mergeSettingsExtractions, buildSettingsReview,
  planSettingsSave, executeSettingsSave,
  type SettingsReviewContext, type RawSettingsExtraction,
} from '@/lib/settings-extraction'
import type { SupabaseClient } from '@supabase/supabase-js'

// The unified settings upload's pure layer: normalization, classification
// through the existing resolution seams, FK-ordered save planning with
// within-batch parent wiring, and the rollback contract.

const CTX: SettingsReviewContext = {
  entities: [{ id: 'ent1', name: 'Thornton Farms LLC' }],
  landowners: [{ id: 'lo1', name: 'Mary Smith', phone: null, email: null, address: null }],
  farms: [{
    id: 'farm1', name: 'Home Place', fsa_number: '1234', county_id: 'cty1',
    entity_id: 'ent1', landowner_id: 'lo1', is_share_rent: true, landlord_share_percentage: 25, cash_rent_per_acre: null,
  }],
  fields: [{ id: 'fld1', farm_id: 'farm1', name_or_number: 'North 80', total_acres: 80, irrigated_acres: 80, county_id: 'cty1' }],
  plantings: [{ id: 'pl1', field_id: 'fld1', crop_id: 'crop1', season_year: 2026, planted_acres: 80, irrigated_acres: 80 }],
  buyers: [{ id: 'buy1', name: 'ADM Valdosta' }],
  deliveryLocations: [{ id: 'dl1', buyer_id: 'buy1', name: 'Valdosta Elevator' }],
  binSites: [{ id: 'bs1', name: 'Home Site' }],
  bins: [{ id: 'bin1', bin_site_id: 'bs1', name_or_number: 'Bin 1', capacity_bushels: 20000 }],
  gins: [],
  trucks: [{ id: 'trk1', name_or_number: 'Truck 7' }],
  crops: [{ id: 'crop1', name: 'Corn' }],
  counties: [
    { id: 'cty1', name: 'Dooly', state: 'Georgia', state_code: 'GA' },
    { id: 'cty2', name: 'Worth', state: 'Georgia', state_code: 'GA' },
  ],
  existingVarietyNames: ['P2089'],
  dismissedVarietyPairs: new Set(),
}

describe('normalizeSettingsExtraction', () => {
  it('coerces numbers, drops nameless rows, and falls back to "Farm <FSA#>"', () => {
    const n = normalizeSettingsExtraction({
      farms: [
        { fsa_farm_number: '888', county: 'Worth', state: 'GA', landlord_share_percentage: '33.33' },
        { name: '  ' }, // nameless → dropped
      ],
      fields: [{ name: 'South 40', total_acres: '40.5' }],
    } as RawSettingsExtraction)
    expect(n.farms).toHaveLength(1)
    expect(n.farms[0].name).toBe('Farm 888')
    expect(n.farms[0].landlordSharePct).toBe(33.33)
    // A stated share % implies share rent even without the flag.
    expect(n.farms[0].shareRent).toBe(true)
    expect(n.fields[0].totalAcres).toBe(40.5)
  })

  it('merge dedupes across batches by section key', () => {
    const a = normalizeSettingsExtraction({ landowners: [{ name: 'Mary Smith' }], farms: [{ name: 'Home Place', fsa_farm_number: '1234' }] })
    const b = normalizeSettingsExtraction({ landowners: [{ name: 'mary smith' }], farms: [{ name: 'Home Place', fsa_farm_number: '1234' }, { name: 'New Farm' }] })
    const m = mergeSettingsExtractions([a, b])
    expect(m.landowners).toHaveLength(1)
    expect(m.farms.map((f) => f.name)).toEqual(['Home Place', 'New Farm'])
  })
})

describe('classification rides the existing seams', () => {
  it('farms: FSA number matches first (the 156EZ seam), then name; diffs → Update', () => {
    const review = buildSettingsReview(
      normalizeSettingsExtraction({
        farms: [
          // Different name, same FSA number → matched by number; share % differs → update.
          { name: 'Home Farm', fsa_farm_number: '1234', landlord_share_percentage: 30 },
          { name: 'Riverbend', fsa_farm_number: '999', county: 'Worth County', state: 'Georgia' },
        ],
      }),
      CTX,
    )
    const rows = review.sections.find((s) => s.section === 'farms')!.rows
    expect(rows[0].cls).toBe('update')
    expect(rows[0].matchedId).toBe('farm1')
    expect(rows[0].diffs.some((d) => d.label === 'Landlord share %' && d.incoming === '30')).toBe(true)
    expect(rows[1].cls).toBe('new')
    // County resolved via normalizeCountyName + state ("Worth County, Georgia" → Worth, GA).
    expect(rows[1].draft.county_id).toBe('cty2')
  })

  it('a new farm auto-assigns the single entity (defaultEntityFor seam)', () => {
    const review = buildSettingsReview(
      normalizeSettingsExtraction({ farms: [{ name: 'Riverbend' }] }), CTX,
    )
    const row = review.sections.find((s) => s.section === 'farms')!.rows[0]
    expect(row.draft.entityRef).toEqual({ id: 'ent1' })
  })

  it('buyers: case-insensitive guard → exists; a new location makes it an update', () => {
    const review = buildSettingsReview(
      normalizeSettingsExtraction({
        buyers: [
          { name: 'adm valdosta', locations: [{ name: 'Valdosta Elevator' }] }, // both known
          { name: 'ADM Valdosta', locations: [{ name: 'Moultrie Elevator' }] }, // new location
        ],
      }),
      { ...CTX },
    )
    const rows = review.sections.find((s) => s.section === 'buyers')!.rows
    expect(rows[0].cls).toBe('exists')
    expect(rows[1].cls).toBe('update')
    expect(rows[1].diffs[0].incoming).toBe('Moultrie Elevator')
  })

  it('possible matches demand a decision — undecided rows are skipped, never saved', () => {
    const review = buildSettingsReview(
      // "Mary Smith Trust" ⊃ "Mary Smith" → a fuzzy candidate, not an exact hit.
      normalizeSettingsExtraction({ landowners: [{ name: 'Mary Smith Trust' }] }), CTX,
    )
    const row = review.sections.find((s) => s.section === 'landowners')!.rows[0]
    expect(row.cls).toBe('possible')
    expect(row.candidate?.id).toBe('lo1')
    row.include = true
    const plan = planSettingsSave(review, {})
    expect(plan.steps).toHaveLength(0)
    expect(plan.skipped[0].reason).toContain('not decided')
    // Decided "new" → it plans.
    const plan2 = planSettingsSave(review, { possible: new Map([[row.key, 'new']]) })
    expect(plan2.steps).toHaveLength(1)
    expect(plan2.steps[0].table).toBe('landowners')
  })

  it('a possible-match variety blocks its planting until decided (strict pipeline)', () => {
    const review = buildSettingsReview(
      normalizeSettingsExtraction({
        // "Pioneer 2089" and "P2089" share the numeric core → possible match
        // (a differing trait letter would be a different product, never offered).
        plantings: [{ field_name: 'North 80', crop: 'Corn', crop_year: 2027, planted_acres: 80, varieties: [{ variety: 'Pioneer 2089', acres: 80 }] }],
      }),
      CTX,
    )
    const row = review.sections.find((s) => s.section === 'plantings')!.rows[0]
    expect(review.varietyPlan.possible).toBe(1)
    const plan = planSettingsSave(review, {})
    expect(plan.steps).toHaveLength(0)
    expect(plan.skipped[0].reason).toContain('variety')
    const item = review.varietyPlan.items[0]
    const plan2 = planSettingsSave(review, { varieties: new Map([[item.key, { useExisting: 'P2089' }]]) })
    const varStep = plan2.steps.find((s) => s.table === 'field_planting_varieties')!
    expect(varStep.payload.variety).toBe('P2089') // resolved to the canonical spelling
    expect(varStep.parentRefs).toEqual({ planting_id: row.key })
  })
})

// A lease names an entity, a landowner, a farm with share terms, and a field —
// the whole chain lands in FK order with in-batch references holding.
describe('lease fixture end-to-end', () => {
  const LEASE: RawSettingsExtraction = {
    document_kinds: ['lease'],
    entities: [{ name: 'Thornton Farms LLC', source: 'p1: "Tenant: Thornton Farms LLC"' }],
    landowners: [{ name: 'John Beasley', phone: '229-555-0101', source: 'p1: "Landlord: John Beasley"' }],
    farms: [{
      name: 'Beasley Place', county: 'Worth', state: 'GA', landowner_name: 'John Beasley',
      share_rent: true, landlord_share_percentage: 25, cash_rent_per_acre: null,
      source: 'p2: "Landlord shall receive 25%"',
    }],
    fields: [{ name: 'Beasley East', farm_name: 'Beasley Place', total_acres: 120, source: 'p3' }],
  }

  it('plans entities → landowners → farms → fields with in-batch parent refs', () => {
    const review = buildSettingsReview(normalizeSettingsExtraction(LEASE), CTX)
    const plan = planSettingsSave(review, {})
    expect(plan.steps.map((s) => s.table)).toEqual(['landowners', 'farms', 'fields'])
    // The entity matched the existing org entity → no entity step, id used directly.
    const farmStep = plan.steps.find((s) => s.table === 'farms')!
    expect(farmStep.payload.entity_id).toBe('ent1')
    expect(farmStep.payload.landlord_share_percentage).toBe(25)
    expect(farmStep.payload.is_share_rent).toBe(true)
    expect(farmStep.payload.county_id).toBe('cty2')
    // The landowner is created in this batch — the farm references its row key.
    const landownerStep = plan.steps.find((s) => s.table === 'landowners')!
    expect(farmStep.parentRefs).toEqual({ landowner_id: landownerStep.key })
    // The field references the farm being created two rows up.
    const fieldStep = plan.steps.find((s) => s.table === 'fields')!
    expect(fieldStep.parentRefs).toEqual({ farm_id: farmStep.key })
  })

  it('unchecking the farm skips its field with a human reason', () => {
    const review = buildSettingsReview(normalizeSettingsExtraction(LEASE), CTX)
    const farmRow = review.sections.find((s) => s.section === 'farms')!.rows[0]
    farmRow.include = false
    const plan = planSettingsSave(review, {})
    expect(plan.steps.some((s) => s.table === 'fields')).toBe(false)
    expect(plan.skipped.find((s) => s.label === 'Beasley East')?.reason).toContain('Beasley Place')
  })

  it('provenance rides every row', () => {
    const review = buildSettingsReview(normalizeSettingsExtraction(LEASE), CTX)
    const farmRow = review.sections.find((s) => s.section === 'farms')!.rows[0]
    expect(farmRow.source).toContain('Landlord shall receive 25%')
  })
})

// A 156EZ packet: one farm already in Turnrow (by FSA number), one not — the
// missing one cross-fills as a create.
describe('156EZ fixture end-to-end', () => {
  const EZ: RawSettingsExtraction = {
    document_kinds: ['fsa_farm_record'],
    farms: [
      { name: 'Farm 1234', fsa_farm_number: '1234', county: 'Dooly', state: 'GA', source: 'p1' },
      { name: 'Farm 4321', fsa_farm_number: '4321', county: 'Worth', state: 'GA', source: 'p2' },
    ],
    fields: [{ name: 'T4321 F1', fsa_farm_number: '4321', total_acres: 55, source: 'p2' }],
  }

  it('matches by FSA number; the unknown farm becomes a create with its field wired', () => {
    const review = buildSettingsReview(normalizeSettingsExtraction(EZ), CTX)
    const farmRows = review.sections.find((s) => s.section === 'farms')!.rows
    expect(farmRows[0].cls).toBe('exists')
    expect(farmRows[0].matchedId).toBe('farm1')
    expect(farmRows[1].cls).toBe('new')
    const plan = planSettingsSave(review, {})
    expect(plan.steps.map((s) => s.table)).toEqual(['farms', 'fields'])
    expect(plan.steps[0].payload.fsa_number).toBe('4321')
    expect(plan.steps[1].parentRefs).toEqual({ farm_id: plan.steps[0].key })
  })
})

// Rollback: a failure mid-batch deletes everything created, children first.
describe('executeSettingsSave rollback', () => {
  function stubClient(failOnTable: string) {
    const log: string[] = []
    let n = 0
    const client = {
      from(table: string) {
        return {
          insert(payload: Record<string, unknown>) {
            return {
              select: () => ({
                single: async () => {
                  if (table === failOnTable) return { data: null, error: { message: 'boom' } }
                  n++
                  log.push(`insert ${table} ${JSON.stringify(payload)}`)
                  return { data: { id: `id${n}` }, error: null }
                },
              }),
            }
          },
          update: () => ({ eq: async () => ({ error: null }) }),
          delete: () => ({ eq: async (_c: string, id: string) => { log.push(`delete ${table} ${id}`); return { error: null } } }),
        }
      },
    }
    return { client: client as unknown as SupabaseClient, log }
  }

  it('deletes created rows in reverse order and reports a clean message', async () => {
    const review = buildSettingsReview(normalizeSettingsExtraction({
      landowners: [{ name: 'John Beasley' }],
      farms: [{ name: 'Beasley Place', landowner_name: 'John Beasley' }],
      fields: [{ name: 'Beasley East', farm_name: 'Beasley Place', total_acres: 120 }],
    }), CTX)
    const plan = planSettingsSave(review, {})
    const { client, log } = stubClient('fields')
    await expect(executeSettingsSave(client, plan)).rejects.toThrow(/Nothing from this batch was kept/)
    // landowner (id1) and farm (id2) created, then the field failed → farm
    // deleted before landowner.
    expect(log.filter((l) => l.startsWith('insert')).length).toBe(2)
    expect(log.filter((l) => l.startsWith('delete'))).toEqual(['delete farms id2', 'delete landowners id1'])
    // The created farm was wired to the created landowner's real id.
    expect(log[1]).toContain('"landowner_id":"id1"')
  })

  it('a clean run reports inserted/updated counts', async () => {
    const review = buildSettingsReview(normalizeSettingsExtraction({
      landowners: [{ name: 'John Beasley' }],
    }), CTX)
    const plan = planSettingsSave(review, {})
    const { client } = stubClient('never')
    await expect(executeSettingsSave(client, plan)).resolves.toEqual({ inserted: 1, updated: 0 })
  })
})
