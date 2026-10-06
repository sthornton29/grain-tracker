// Full-season vs double-crop cohorts in the yield engine (Parts C and D).
//
// Fixture — Soybean 2026 (designated double-crop), Wheat spring. Double-crop
// expected yield 42.0 bu/ac, full-season expected 58.0.
//   Full-season: F1 Home Place 100 ac 6,000 bu (9/10–9/14); F2 Pruitt 100 ac
//   5,800 bu (9/16–9/20); F4 Hail Bottom 100 ac 3,500 bu (9/21–9/23, hail);
//   F3 Moore 100 ac 6,200 bu (9/24–10/1).
//   Double-crop behind wheat: D1 Wheeler Grove 100 ac 4,200 bu (10/20–10/22);
//   D2 Cedar Lane 100 ac 2,000 bu so far (10/23–10/25, combine still there).
// Every as-of date is fixed; the clock is never read.
import { describe, expect, it } from 'vitest'
import {
  analyzeYields, buildYieldInputs, cohortKey, cropsWithCompleteHarvest, expectedYieldForPlanting,
  groupYieldAggregates, inProgressPlantingsByCrop, type ExpectedYieldAssumption, type FieldCropAgg, type GroupYieldPlanting,
} from '@/lib/yields'
import { buildDoubleCropSet, buildSpringCropByFieldYear, cropHasBothCroppings, croppingOf } from '@/lib/plantings'
import { segmentAcresByCrop } from '@/lib/marketing'
import { breakoutRowKeys, breakoutShowsSeason } from '@/lib/breakout-grid'
import { seasonCropRows, seasonYieldOf } from '@/lib/season-summary'

const cropsById = new Map([
  ['beans', { id: 'beans', name: 'Soybean', harvest_category: 'fall' as const, double_crop: true }],
  ['wheat', { id: 'wheat', name: 'Wheat', harvest_category: 'spring' as const, double_crop: false }],
])

type P = {
  id: string; field_id: string; crop_id: string; season_year: number
  planted_acres: number; irrigated_acres: number; dryland_acres: number
  yield_include_override?: boolean | null
}
const pl = (id: string, field_id: string, crop_id: string, acres = 100, irr = 0): P =>
  ({ id, field_id, crop_id, season_year: 2026, planted_acres: acres, irrigated_acres: irr, dryland_acres: acres - irr })

// F2 Pruitt is irrigated so the Practice filter composition is a real test.
const plantings: P[] = [
  pl('F1', 'home', 'beans'), pl('F2', 'pruitt', 'beans', 100, 100), pl('F4', 'hail', 'beans'), pl('F3', 'moore', 'beans'),
  pl('W1', 'wheeler', 'wheat'), pl('W2', 'cedar', 'wheat'),
  pl('D1', 'wheeler', 'beans'), pl('D2', 'cedar', 'beans'),
]
const doubleCropIds = buildDoubleCropSet(plantings, cropsById)

const agg = (over?: Partial<Record<string, FieldCropAgg>>) => {
  const m = new Map<string, FieldCropAgg>([
    ['home|beans|2026', { dryBu: 6000, lastLoadDate: '2026-09-14' }],
    ['pruitt|beans|2026', { dryBu: 5800, lastLoadDate: '2026-09-20' }],
    ['hail|beans|2026', { dryBu: 3500, lastLoadDate: '2026-09-23' }],
    ['moore|beans|2026', { dryBu: 6200, lastLoadDate: '2026-10-01' }],
    ['wheeler|wheat|2026', { dryBu: 7000, lastLoadDate: '2026-06-20' }],
    ['cedar|wheat|2026', { dryBu: 6500, lastLoadDate: '2026-06-22' }],
    ['wheeler|beans|2026', { dryBu: 4200, lastLoadDate: '2026-10-22' }],
    ['cedar|beans|2026', { dryBu: 2000, lastLoadDate: '2026-10-25' }],
  ])
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v) m.set(k, v)
    else m.delete(k)
  }
  return m
}
const assumptions: ExpectedYieldAssumption[] = [{ crop_id: 'beans', crop_year: 2026, expected_yield: 58, expected_yield_dc_irr: 42, expected_yield_dc_dry: 42 }]
const asOf = (d: string) => new Date(`${d}T12:00:00`)
const analyze = (aggByKey: Map<string, FieldCropAgg>, date: string, a = assumptions) =>
  analyzeYields(buildYieldInputs({ plantings, aggByKey, assumptions: a, doubleCropIds }), undefined, asOf(date))

describe('croppingOf — the one rule', () => {
  it('beans behind wheat are double-crop; the rest full-season; wheat itself never is', () => {
    expect([...doubleCropIds].sort()).toEqual(['D1', 'D2'])
    expect(croppingOf(plantings[0], doubleCropIds)).toBe('full_season')
    expect(croppingOf({ id: 'D1' }, doubleCropIds)).toBe('double_crop')
    expect(croppingOf({ id: 'W1' }, doubleCropIds)).toBe('full_season')
  })
  it('names the spring crop a double-crop planting sits behind', () => {
    expect(buildSpringCropByFieldYear(plantings, cropsById).get('wheeler|2026')).toBe('wheat')
    expect(buildSpringCropByFieldYear(plantings, cropsById).get('home|2026')).toBeUndefined()
  })
  it('both croppings present → the Cropping control shows; wheat alone → it does not', () => {
    expect(cropHasBothCroppings(plantings, 'beans', 2026, doubleCropIds)).toBe(true)
    expect(cropHasBothCroppings(plantings, 'wheat', 2026, doubleCropIds)).toBe(false)
    expect(cropHasBothCroppings(plantings, 'beans', 2025, doubleCropIds)).toBe(false)
  })
  it('an archived spring planting no longer makes the field double-cropped; a spring crop flagged double-crop never classifies itself', () => {
    const archived = plantings.map((p) => (p.id === 'W1' ? { ...p, archived_at: '2026-07-01T00:00:00Z' } : p))
    expect([...buildDoubleCropSet(archived, cropsById)]).toEqual(['D2'])
    const flaggedWheat = new Map(cropsById)
    flaggedWheat.set('wheat', { ...cropsById.get('wheat')!, double_crop: true })
    expect([...buildDoubleCropSet(plantings, flaggedWheat)].sort()).toEqual(['D1', 'D2'])
  })
})

describe('expectedYieldForPlanting — the cohort bar', () => {
  const a = assumptions[0]
  it('full-season reads the overall / per-practice numbers; double-crop reads ONLY the double-crop breakout', () => {
    expect(expectedYieldForPlanting(a, { irrigated_acres: 0, dryland_acres: 100 })).toBe(58)
    expect(expectedYieldForPlanting(a, { irrigated_acres: 0, dryland_acres: 100 }, 'double_crop')).toBe(42)
  })
  it('with no double-crop number entered a double-crop planting has NO bar — never the overall 58', () => {
    const noDc = { crop_id: 'beans', crop_year: 2026, expected_yield: 58, expected_yield_irr: 60, expected_yield_dry: 56 }
    expect(expectedYieldForPlanting(noDc, { irrigated_acres: 0, dryland_acres: 100 }, 'double_crop')).toBeNull()
    expect(expectedYieldForPlanting(noDc, { irrigated_acres: 50, dryland_acres: 50 }, 'double_crop')).toBeNull()
  })
  it('a blank double-crop side falls back to the other double-crop side, not to full-season', () => {
    const oneSide = { crop_id: 'beans', crop_year: 2026, expected_yield: 58, expected_yield_dc_dry: 40 }
    expect(expectedYieldForPlanting(oneSide, { irrigated_acres: 100, dryland_acres: 0 }, 'double_crop')).toBe(40)
  })
})

describe('D1 — as of 10/26, each cohort judged on its own', () => {
  const an = analyze(agg(), '2026-10-26')
  it('F1, F2, F3 complete', () => {
    for (const id of ['F1', 'F2', 'F3']) expect(an.excluded.has(id)).toBe(false)
  })
  it('F4: 35.0 vs full-season peers 60.0 (41.7% low) but the full-season cohort is quiet since 10/1 → COMPLETE', () => {
    expect(an.excluded.has('F4')).toBe(false)
    expect(an.autoExcluded.has('F4')).toBe(false)
  })
  it('D1: 42.0 vs the double-crop expected 42.0 (one DC peer, so the assumption is the bar), moved on → COMPLETE', () => {
    expect(an.excluded.has('D1')).toBe(false)
    expect(an.noBaseline.has('D1')).toBe(false)
  })
  it('the OLD path is gone: D1 is not measured against the 60.0 full-season average (which would hold it 30% low)', () => {
    // Same fixture through the engine WITHOUT cohorts (no doubleCropIds) is
    // the old behavior — and it does flag D1. With cohorts it does not.
    const old = analyzeYields(buildYieldInputs({ plantings, aggByKey: agg(), assumptions }), undefined, asOf('2026-10-26'))
    expect(old.excluded.get('D1')).toBe('in_progress')
    expect(an.excluded.has('D1')).toBe(false)
  })
  it('D2: the active field (no later-dated load anywhere) → in progress', () => {
    expect(an.excluded.get('D2')).toBe('in_progress')
  })
})

describe('D2 — the flip-back bug is gone', () => {
  it('F4 is complete on 10/12 (11 quiet days), STAYS complete on 10/20 when D1 starts, and on 10/26', () => {
    // Before 10/20 the double-crop fields have no loads yet.
    const before = agg({ 'wheeler|beans|2026': undefined, 'cedar|beans|2026': undefined })
    expect(analyze(before, '2026-10-12').excluded.has('F4')).toBe(false)
    const d1Started = agg({ 'wheeler|beans|2026': { dryBu: 1400, lastLoadDate: '2026-10-20' }, 'cedar|beans|2026': undefined })
    const on1020 = analyze(d1Started, '2026-10-20')
    expect(on1020.excluded.has('F4')).toBe(false)
    expect(on1020.excluded.get('D1')).toBe('in_progress') // the combine is in D1
    expect(analyze(agg(), '2026-10-26').excluded.has('F4')).toBe(false)
  })
  it('under a crop-wide clock (the old engine) D1\'s first load WOULD have reopened F4', () => {
    const d1Started = agg({ 'wheeler|beans|2026': { dryBu: 1400, lastLoadDate: '2026-10-20' }, 'cedar|beans|2026': undefined })
    const old = analyzeYields(buildYieldInputs({ plantings, aggByKey: d1Started, assumptions }), undefined, asOf('2026-10-20'))
    expect(old.excluded.get('F4')).toBe('in_progress')
  })
})

describe('D3 — moved-on evidence crosses cohorts (where the combine IS, not what it made)', () => {
  // Alternate timeline: D1's first load lands 10/2, right after F3's last on 10/1.
  const alt = agg({ 'wheeler|beans|2026': { dryBu: 1300, lastLoadDate: '2026-10-02' }, 'cedar|beans|2026': undefined })
  it('as of 10/2 F3 counts as moved on; resting full-season peers F1 + F2 = 59.0; F3 at 62.0 → COMPLETE', () => {
    const an = analyze(alt, '2026-10-02')
    expect(an.excluded.has('F3')).toBe(false)
    expect(an.excluded.get('D1')).toBe('in_progress') // the active field now
  })
  it('a cohort-only moved-on rule would have held F3: without D1\'s load it is still the active field on 10/2', () => {
    const noDc = agg({ 'wheeler|beans|2026': undefined, 'cedar|beans|2026': undefined })
    expect(analyze(noDc, '2026-10-02').excluded.get('F3')).toBe('in_progress')
  })
  it('the peers that judged F3 were full-season only: F4 is not resting on 10/2 (9 days) and D1 is in the other cohort', () => {
    // Make F3 low enough to fail against 59.0 but pass against a bar that
    // included D1 (13.0) — the engine must use 59.0.
    const low = agg({ 'wheeler|beans|2026': { dryBu: 1300, lastLoadDate: '2026-10-02' }, 'cedar|beans|2026': undefined, 'moore|beans|2026': { dryBu: 4900, lastLoadDate: '2026-10-01' } })
    expect(analyze(low, '2026-10-02').excluded.get('F3')).toBe('in_progress') // 49.0 < 59.0 × 0.85 = 50.15
  })
})

describe('D4 — a double-crop planting with no double-crop assumption', () => {
  it('fewer than 2 DC peers and moved on → complete with the noBaseline note; never judged against the overall 58', () => {
    const noDc = [{ crop_id: 'beans', crop_year: 2026, expected_yield: 58 }]
    const an = analyze(agg(), '2026-10-26', noDc)
    expect(an.excluded.has('D1')).toBe(false)
    expect(an.noBaseline.has('D1')).toBe(true)
    expect(an.excluded.get('D2')).toBe('in_progress') // still the active field
  })
})

describe('C1 — the partition, as of 10/26, complete fields only', () => {
  const an = analyze(agg(), '2026-10-26')
  const fs = an.cohortAverages.get(cohortKey('beans', 'full_season'))!
  const dc = an.cohortAverages.get(cohortKey('beans', 'double_crop'))!
  const all = an.averages.get('beans')!
  it('combined 25,700 bu / 500 ac = 51.40; full-season 21,500 / 400 = 53.75; double-crop 4,200 / 100 = 42.00', () => {
    expect(all.dryBu).toBe(25700); expect(all.acres).toBe(500); expect(all.yield).toBeCloseTo(51.4, 5)
    expect(fs.dryBu).toBe(21500); expect(fs.acres).toBe(400); expect(fs.yield).toBeCloseTo(53.75, 5)
    expect(dc.dryBu).toBe(4200); expect(dc.acres).toBe(100); expect(dc.yield).toBeCloseTo(42, 5)
  })
  it('invariants: FS + DC bushels, acres, and acre-weighted yields equal the combined figures', () => {
    expect(fs.dryBu + dc.dryBu).toBe(all.dryBu)
    expect(fs.acres + dc.acres).toBe(all.acres)
    expect((fs.yield * fs.acres + dc.yield * dc.acres) / (fs.acres + dc.acres)).toBeCloseTo(all.yield, 9)
  })
  it('harvest progress: full-season 400 of 400, double-crop 100 of 200, combined 500 of 600', () => {
    const pfs = an.cohortProgress.get(cohortKey('beans', 'full_season'))!
    const pdc = an.cohortProgress.get(cohortKey('beans', 'double_crop'))!
    const pall = an.progress.get('beans')!
    expect([pfs.completedAcres, pfs.totalAcres]).toEqual([400, 400])
    expect([pdc.completedAcres, pdc.inProgressAcres, pdc.totalAcres]).toEqual([100, 100, 200])
    expect([pall.completedAcres, pall.totalAcres]).toEqual([500, 600])
    expect(pfs.completedAcres + pdc.completedAcres).toBe(pall.completedAcres)
  })
  it('the same partition holds in every grouping — field, farm, entity, variety, landowner — and composed with Practice', () => {
    const aggByKey = agg()
    const included = plantings.filter((p) => p.crop_id === 'beans' && !an.excluded.has(p.id))
    const farmOf: Record<string, string> = { home: 'North', pruitt: 'North', hail: 'South', moore: 'South', wheeler: 'South', cedar: 'River' }
    const entityOf: Record<string, string> = { North: 'LLC', South: 'LLC', River: 'Partnership' }
    const landownerOf: Record<string, string> = { North: 'Smith', South: 'Owned', River: 'Jones' }
    const varietyOf: Record<string, string> = { F1: 'AG38', F2: 'AG38', F3: 'P48', F4: 'P48', D1: 'AG38', D2: 'P48' }
    const groupings: Array<(p: P) => string> = [
      (p) => p.field_id,
      (p) => farmOf[p.field_id],
      (p) => entityOf[farmOf[p.field_id]],
      (p) => varietyOf[p.id],
      (p) => landownerOf[farmOf[p.field_id]],
    ]
    const practiceFilters: Array<(p: P) => boolean> = [() => true, (p) => p.irrigated_acres > 0, (p) => p.dryland_acres > 0]
    for (const groupOf of groupings) {
      for (const practice of practiceFilters) {
        const rows: GroupYieldPlanting[] = []
        const cohortRows: Record<string, GroupYieldPlanting[]> = { full_season: [], double_crop: [] }
        for (const p of included.filter(practice)) {
          const row: GroupYieldPlanting = {
            groupId: groupOf(p), groupName: groupOf(p), cropId: 'beans', cropName: 'Soybean', seasonYear: 2026,
            acres: p.planted_acres, dryBu: aggByKey.get(`${p.field_id}|beans|2026`)!.dryBu,
            irrigatedAcres: p.irrigated_acres, drylandAcres: p.dryland_acres, yieldBreakoutEntered: false, irrigatedBushels: null, drylandBushels: null,
          }
          rows.push(row)
          cohortRows[croppingOf(p, doubleCropIds)].push(row)
        }
        const combined = groupYieldAggregates(rows)
        const fsRows = groupYieldAggregates(cohortRows.full_season)
        const dcRows = groupYieldAggregates(cohortRows.double_crop)
        for (const g of combined) {
          const f = fsRows.find((r) => r.groupId === g.groupId)
          const d = dcRows.find((r) => r.groupId === g.groupId)
          expect((f?.dryBu ?? 0) + (d?.dryBu ?? 0)).toBe(g.dryBu)
          expect((f?.acres ?? 0) + (d?.acres ?? 0)).toBe(g.acres)
        }
        // And the grand totals of the grouping foot to the engine's cohorts.
        const total = (xs: typeof combined) => xs.reduce((s, r) => s + r.dryBu, 0)
        if (practice === practiceFilters[0]) {
          expect(total(combined)).toBe(all.dryBu)
          expect(total(fsRows)).toBe(fs.dryBu)
          expect(total(dcRows)).toBe(dc.dryBu)
        }
      }
    }
  })
})

describe('C2 — one helper, one answer across marketing, the breakout grid, and yields', () => {
  it('the marketing acre segments, the planted-mode grid rows, and the yield inputs agree on which plantings are double-crop', () => {
    const seg = segmentAcresByCrop(plantings, 2026, doubleCropIds).get('beans')!
    expect(seg.fullIrr + seg.fullDry).toBe(400)
    expect(seg.dcIrr + seg.dcDry).toBe(200)
    const rows = breakoutRowKeys({ mode: 'planted', doubleCrop: true, seg })
    expect(breakoutShowsSeason(rows)).toBe(true)
    const inputs = buildYieldInputs({ plantings, aggByKey: agg(), assumptions, doubleCropIds })
    const dcAcres = inputs.filter((r) => r.cropId === 'beans' && r.cropping === 'double_crop').reduce((s, r) => s + r.acres, 0)
    expect(dcAcres).toBe(seg.dcIrr + seg.dcDry)
    expect(inputs.find((r) => r.id === 'D1')!.expectedYield).toBe(42)
    expect(inputs.find((r) => r.id === 'F1')!.expectedYield).toBe(58)
  })
  it('cropsWithCompleteHarvest needs EVERY cohort complete; the holdouts name their cohort', () => {
    const base = { plantings, aggByKey: agg(), cropYear: 2026, cropCompleteKeys: new Set<string>(), assumptions, doubleCropIds, now: asOf('2026-10-26') }
    expect(cropsWithCompleteHarvest(base).has('beans')).toBe(false) // D2 still going
    expect(cropsWithCompleteHarvest(base).has('wheat')).toBe(true)
    const holdouts = inProgressPlantingsByCrop(base)
    expect(holdouts.get('beans')?.map((p) => `${p.field_id} · ${p.cropping}`)).toEqual(['cedar · double_crop'])
    // D2 finished (count anyway) → the crop is complete.
    const counted = plantings.map((p) => (p.id === 'D2' ? { ...p, yield_include_override: true } : p))
    expect(cropsWithCompleteHarvest({ ...base, plantings: counted }).has('beans')).toBe(true)
  })
})

describe('C3 — Season Summary rows: combined plus Full-season / Double-crop sub-rows', () => {
  it('combined 51.40 with sub-rows 53.75 and 42.00; wheat has no sub-rows', () => {
    const an = analyze(agg(), '2026-10-26')
    const aggByKey = agg()
    const rows = seasonCropRows({
      plantings, cropName: (id) => cropsById.get(id)!.name, isCotton: () => false,
      dryBuFor: (f, c, y) => aggByKey.get(`${f}|${c}|${y}`)?.dryBu ?? 0,
      excluded: an.excluded, doubleCropIds,
    })
    const beans = rows.find((r) => r.cropId === 'beans')!
    expect(seasonYieldOf(beans)).toBeCloseTo(51.4, 5)
    expect(beans.fullSeasonAcres).toBe(400)
    expect(beans.doubleCropAcres).toBe(200)
    expect(beans.cohorts!.map((c) => [c.label, c.acres, c.dryBu, seasonYieldOf(c)!.toFixed(2)])).toEqual([
      ['Full-season', 400, 21500, '53.75'],
      ['Double-crop', 200, 4200, '42.00'],
    ])
    expect(beans.cohorts![0].dryBu + beans.cohorts![1].dryBu).toBe(beans.dryBu)
    expect(rows.find((r) => r.cropId === 'wheat')!.cohorts).toBeNull()
  })
})
