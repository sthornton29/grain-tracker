// Cotton harvest status from seed cotton loads + lint estimates (092).
//
// The cotton classifier is the GRAIN classifier: lib/yields analyzeYields fed
// through buildYieldInputs with the cotton adapter (lib/cotton.ts). These
// tests run the cotton rules through that shared engine, pin the turnout
// precedence and its weighted math, the Wheeler Pivot estimate, the hybrid
// field, the fully-ginned field (today's math, unchanged), the module-off
// invariance, and the partner /production lint_basis.

import { describe, expect, it } from 'vitest'
import {
  analyzeYields, buildYieldInputs, cropsWithCompleteHarvest, harvestStatusOf, inProgressPlantingsByCrop,
  IN_PROGRESS_STALE_DAYS, type FieldCropAgg,
} from '@/lib/yields'
import {
  cottonPlantingYield, cottonProductionTotals, cottonYieldAdapter, ginnedTotals, ginningStatusOf,
  resolveTurnout, seedCottonAggregates, turnoutResolver, DEFAULT_TURNOUT_PCT,
  type SeedCottonLoadLike, type TurnoutReceiptLike,
} from '@/lib/cotton'
import { buildCottonYieldModel, type CottonYieldSources } from '@/lib/cotton-yield-sources'
import { buildProductionRecords, type CropRow, type EntityRow, type FarmRow, type FieldRow, type PlantingRow } from '@/lib/partner-api'

// ---------------------------------------------------------------------------
// Fixtures — the Wheeler Pivot shape: 249.9 planted acres, 799,140 lbs of
// seed cotton picked and sitting on the yard.
// ---------------------------------------------------------------------------

const COTTON = 'c-cotton'
const CORN = 'c-corn'
const crops = [{ id: COTTON, name: 'Cotton' }, { id: CORN, name: 'Corn' }]
const cottonCropIds = new Set([COTTON])

type P = {
  id: string; field_id: string; crop_id: string; season_year: number
  planted_acres: number; irrigated_acres: number; dryland_acres: number
  yield_include_override?: boolean | null
}
const planting = (id: string, field_id: string, acres: number, over: Partial<P> = {}): P => ({
  id, field_id, crop_id: COTTON, season_year: 2026, planted_acres: acres, irrigated_acres: acres, dryland_acres: 0, ...over,
})
const WHEELER = planting('pW', 'fW', 249.9)
const SOUTH = planting('pS', 'fS', 200)

let seq = 0
const load = (field_id: string, picked: string | null, lbs: number, over: Partial<SeedCottonLoadLike> = {}): SeedCottonLoadLike => ({
  id: `cl${++seq}`, field_id, crop_year: 2026, net_weight: lbs, picked_date: picked, delivered_date: null, ...over,
})

const assumptions = [{ crop_id: COTTON, crop_year: 2026, expected_yield: 1200, expected_yield_irr: null, expected_yield_dry: null }]
const DEFAULT_TURNOUT = resolveTurnout({})
const adapterFor = (loads: SeedCottonLoadLike[], turnout = DEFAULT_TURNOUT) =>
  cottonYieldAdapter({ cottonCropIds, loads, turnoutFor: () => turnout })

const statusOf = (plantings: P[], loads: SeedCottonLoadLike[], now: Date, cropComplete = new Set<string>()) => {
  const analysis = analyzeYields(
    buildYieldInputs({ plantings, aggByKey: new Map(), assumptions, cotton: adapterFor(loads) }),
    undefined, now,
  )
  return (p: P) => harvestStatusOf(p, analysis.excluded, cropComplete)
}

// ---------------------------------------------------------------------------
// Part A — the classifier, through the shared engine
// ---------------------------------------------------------------------------

describe('seedCottonAggregates — the cotton adapter input', () => {
  it('sums seed cotton lbs per field × crop year and keeps the latest picked date (delivered as the fallback)', () => {
    const agg = seedCottonAggregates([
      load('fW', '2026-10-10', 300_000),
      load('fW', '2026-10-12', 499_140),
      load('fW', null, 10, { delivered_date: '2026-10-14' }),
      load('fS', '2026-10-01', 50_000, { crop_year: 2025 }),
      load(null as unknown as string, '2026-10-01', 999),
    ])
    expect(agg.get('fW|2026')).toMatchObject({ dryBu: 799_150, lastLoadDate: '2026-10-14', totalLoads: 3 })
    expect(agg.get('fS|2025')).toMatchObject({ dryBu: 50_000, lastLoadDate: '2026-10-01' })
    expect(agg.size).toBe(2)
  })

  it('a planting of a cotton crop reads its seed cotton aggregate; grain plantings keep the grain aggregate', () => {
    const grainAgg = new Map<string, FieldCropAgg>([[`fC|${CORN}|2026`, { dryBu: 9000, lastLoadDate: '2026-09-01', lastLoadTime: null }]])
    const inputs = buildYieldInputs({
      plantings: [WHEELER, planting('pC', 'fC', 50, { crop_id: CORN })],
      aggByKey: grainAgg,
      assumptions,
      cotton: adapterFor([load('fW', '2026-10-10', 799_140)]),
    })
    const w = inputs.find((i) => i.id === 'pW')!
    const c = inputs.find((i) => i.id === 'pC')!
    expect(w.dryBu).toBe(799_140)
    expect(w.lastLoadDate).toBe('2026-10-10')
    // Expected LINT lbs/ac ÷ turnout → the seed cotton bar.
    expect(w.expectedYield).toBeCloseTo(1200 / 0.4, 6)
    expect(c.dryBu).toBe(9000)
  })
})

describe('cotton harvest status — the active field is never complete', () => {
  it('a normal-yielding field with no later-picked load on any other cotton field stays in progress', () => {
    const loads = [load('fW', '2026-10-10', 799_140)]
    const st = statusOf([WHEELER, SOUTH], loads, new Date('2026-10-13T12:00:00Z'))
    expect(st(WHEELER)).toBe('in_progress')
    expect(st(SOUTH)).toBe('unharvested')
  })

  it('a later-picked load from another cotton field releases it (normal yield → complete); that field is now the active one', () => {
    const loads = [load('fW', '2026-10-10', 799_140), load('fS', '2026-10-12', 150_000)]
    const st = statusOf([WHEELER, SOUTH], loads, new Date('2026-10-13T12:00:00Z'))
    expect(st(WHEELER)).toBe('complete')
    expect(st(SOUTH)).toBe('in_progress')
  })
})

describe('cotton harvest status — persistent low yield (seed cotton vs expected lint ÷ turnout)', () => {
  // Bar: 1,200 lbs lint/ac ÷ 40% = 3,000 lbs seed/ac; 15% below = 2,550.
  it('a field more than 15% below the bar stays in progress even after a later load lands elsewhere', () => {
    const loads = [load('fW', '2026-10-10', 400_000) /* 1,600 lbs/ac */, load('fS', '2026-10-12', 150_000)]
    const st = statusOf([WHEELER, SOUTH], loads, new Date('2026-10-13T12:00:00Z'))
    expect(st(WHEELER)).toBe('in_progress')
  })

  it('crop-wide silence past the window completes it — no cotton loads anywhere for 10+ days', () => {
    const loads = [load('fW', '2026-10-10', 400_000), load('fS', '2026-10-12', 150_000)]
    const quiet = new Date(`2026-10-${12 + IN_PROGRESS_STALE_DAYS + 1}T12:00:00Z`)
    const st = statusOf([WHEELER, SOUTH], loads, quiet)
    expect(st(WHEELER)).toBe('complete')
    expect(st(SOUTH)).toBe('complete')
  })

  it('"Count anyway" (yield_include_override) completes a low field from any state', () => {
    const loads = [load('fW', '2026-10-10', 400_000), load('fS', '2026-10-12', 150_000)]
    const st = statusOf([{ ...WHEELER, yield_include_override: true }, SOUTH], loads, new Date('2026-10-13T12:00:00Z'))
    expect(st(WHEELER)).toBe('complete')
  })

  it('the crop-level harvest-complete flag completes every cotton field', () => {
    const loads = [load('fW', '2026-10-10', 400_000)]
    const st = statusOf([WHEELER, SOUTH], loads, new Date('2026-10-13T12:00:00Z'), new Set([`${COTTON}|2026`]))
    expect(st(WHEELER)).toBe('complete')
    expect(st(SOUTH)).toBe('complete')
  })

  it('the baseline is the expected LINT yield converted to seed cotton by the resolved turnout', () => {
    // At 40% turnout the bar is 3,000 seed lbs/ac: 2,700 lbs/ac (−10%) is fine
    // once the combine moves on; at a 50% turnout the bar drops to 2,400 and
    // the same field reads well above it; at 30% the bar is 4,000 and 2,700
    // (−32%) is low.
    const loads = [load('fW', '2026-10-10', 2700 * 249.9), load('fS', '2026-10-12', 150_000)]
    const now = new Date('2026-10-13T12:00:00Z')
    const run = (turnoutPct: number) => {
      const t = resolveTurnout({ manualPct: turnoutPct })
      const analysis = analyzeYields(buildYieldInputs({ plantings: [WHEELER, SOUTH], aggByKey: new Map(), assumptions, cotton: adapterFor(loads, t) }), undefined, now)
      return harvestStatusOf(WHEELER, analysis.excluded, new Set())
    }
    expect(run(40)).toBe('complete')
    expect(run(50)).toBe('complete')
    expect(run(30)).toBe('in_progress')
  })

  it('the season-level helpers take the same adapter: cropsWithCompleteHarvest / inProgressPlantingsByCrop', () => {
    const loads = [load('fW', '2026-10-10', 799_140), load('fS', '2026-10-12', 600_000)]
    const base = { plantings: [WHEELER, SOUTH], aggByKey: new Map<string, FieldCropAgg>(), cropYear: 2026, cropCompleteKeys: new Set<string>(), assumptions }
    // Active: South is the field being picked → the crop is not complete.
    const active = new Date('2026-10-13T12:00:00Z')
    expect(cropsWithCompleteHarvest({ ...base, cotton: adapterFor(loads), now: active }).has(COTTON)).toBe(false)
    expect(inProgressPlantingsByCrop({ ...base, cotton: adapterFor(loads), now: active }).get(COTTON)?.map((p) => p.id)).toEqual(['pS'])
    // Quiet past the window: complete.
    const quiet = new Date('2026-10-30T12:00:00Z')
    expect(cropsWithCompleteHarvest({ ...base, cotton: adapterFor(loads), now: quiet }).has(COTTON)).toBe(true)
    // Without the adapter (module off) cotton plantings have no loads → unharvested, never complete.
    expect(cropsWithCompleteHarvest({ ...base, now: quiet }).has(COTTON)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Part C — turnout resolution + the estimate
// ---------------------------------------------------------------------------

describe('resolveTurnout — precedence and the weighted math', () => {
  it('100,000 lint ÷ 250,000 seed = 40.0% from your ginned cotton', () => {
    const t = resolveTurnout({ thisYear: { lintLbs: 100_000, seedLbs: 250_000 } })
    expect(t).toMatchObject({ pct: 40, fraction: 0.4, source: 'ginned_this_year', assumed: false })
    expect(t.label).toBe('40% from your ginned cotton')
  })

  it('manual > this year > last year > the 40% default (flagged assumed)', () => {
    const thisYear = { lintLbs: 41_500, seedLbs: 100_000 }
    const priorYear = { lintLbs: 38_000, seedLbs: 100_000 }
    expect(resolveTurnout({ manualPct: 42.5, thisYear, priorYear }).source).toBe('manual')
    expect(resolveTurnout({ manualPct: 42.5, thisYear, priorYear }).label).toBe('42.5% set by you')
    expect(resolveTurnout({ thisYear, priorYear })).toMatchObject({ pct: 41.5, source: 'ginned_this_year' })
    expect(resolveTurnout({ priorYear, cropYear: 2026 })).toMatchObject({ pct: 38, source: 'ginned_prior_year', label: '38% from your 2025 ginned cotton' })
    expect(resolveTurnout({})).toMatchObject({ pct: DEFAULT_TURNOUT_PCT, fraction: 0.4, source: 'default', assumed: true, label: '40% assumed' })
    // Empty totals fall through; an out-of-range manual figure is ignored.
    expect(resolveTurnout({ thisYear: { lintLbs: 0, seedLbs: 0 }, manualPct: 150 }).source).toBe('default')
  })

  it('ginnedTotals weights by receipt: bale rows win over the stated lint total; receipts without a seed weight drop out', () => {
    const receipts = [
      { id: 'g1', total_seed_cotton_weight: 150_000, total_bale_weight: 60_000 },
      { id: 'g2', total_seed_cotton_weight: 100_000, total_bale_weight: 99 }, // bale rows override the stated 99
      { id: 'g3', total_seed_cotton_weight: null, total_bale_weight: 500_000 }, // no seed weight → not a turnout fact
    ]
    const bales = [{ gin_receipt_id: 'g2', net_weight_lbs: 20_000 }, { gin_receipt_id: 'g2', net_weight_lbs: 20_000 }]
    expect(ginnedTotals(receipts, bales)).toEqual({ lintLbs: 100_000, seedLbs: 250_000 })
  })

  it('turnoutResolver: per crop year, the manual tier per crop × year, memoized', () => {
    const receipts: TurnoutReceiptLike[] = [
      { id: 'g25', field_id: 'fW', crop_year: 2025, bales_count: 100, total_bale_weight: 38_000, total_seed_cotton_weight: 100_000 },
      { id: 'g26', field_id: 'fW', crop_year: 2026, bales_count: 100, total_bale_weight: 41_500, total_seed_cotton_weight: 100_000 },
    ]
    const resolve = turnoutResolver({ assumptions: [{ crop_id: COTTON, crop_year: 2027, assumed_turnout_pct: 39 }], receipts, bales: [] })
    expect(resolve(COTTON, 2026)).toMatchObject({ pct: 41.5, source: 'ginned_this_year' })
    expect(resolve(COTTON, 2027)).toMatchObject({ pct: 39, source: 'manual' })
    // 2025 has its own receipts; 2024 has nothing this year or last → default.
    expect(resolve(COTTON, 2025)).toMatchObject({ pct: 38, source: 'ginned_this_year' })
    expect(resolve(COTTON, 2024).source).toBe('default')
    expect(resolve(COTTON, 2026)).toBe(resolve(COTTON, 2026))
  })
})

describe('cottonPlantingYield — the lint estimate', () => {
  const wheelerLoads = [load('fW', '2026-10-08', 400_000), load('fW', '2026-10-10', 399_140)]

  it('Wheeler Pivot: 799,140 lbs on the yard × 40% = 319,656 lbs est. ÷ 249.9 ac = 1,279 lbs/ac, est.-flagged', () => {
    const y = cottonPlantingYield({ plantedAcres: 249.9, loads: wheelerLoads, receipts: [], bales: [], ginnedLoadIds: new Set(), turnout: DEFAULT_TURNOUT })
    expect(y.seedLbs).toBe(799_140)
    expect(y.yardSeedLbs).toBe(799_140)
    expect(y.actualLintLbs).toBe(0)
    expect(y.estimatedLintLbs).toBeCloseTo(319_656, 6)
    expect(y.lintLbs).toBeCloseTo(319_656, 6)
    expect(Math.round(y.lintPerAcre!)).toBe(1279)
    expect(y.lintBasis).toBe('estimated_turnout')
    expect(y.turnoutBasis).toBe('estimated')
    expect(y.turnoutPct).toBe(40)
    expect(y.turnout.assumed).toBe(true)
    expect(y.ginning).toBe('on_yard')
    expect(y.bales).toBe(0)
  })

  it('the hybrid field: one load ginned (receipt lint), one still on the yard (estimate) → a labeled mix', () => {
    const receipts: TurnoutReceiptLike[] = [{ id: 'g1', field_id: 'fW', crop_year: 2026, bales_count: 100, total_bale_weight: 50_000, total_seed_cotton_weight: 120_000 }]
    const loads = [load('fW', '2026-10-08', 120_000), load('fW', '2026-10-10', 100_000)]
    const turnout = resolveTurnout({ thisYear: ginnedTotals(receipts, []) }) // 41.7% from the ginned load
    const y = cottonPlantingYield({ plantedAcres: 100, loads, receipts, bales: [], ginnedLoadIds: new Set([loads[0].id]), turnout })
    expect(y.actualLintLbs).toBe(50_000)
    expect(y.yardSeedLbs).toBe(100_000)
    expect(y.estimatedLintLbs).toBeCloseTo(100_000 * (50_000 / 120_000), 6)
    expect(y.lintLbs).toBeCloseTo(50_000 + 41_666.67, 0)
    expect(y.lintBasis).toBe('mixed')
    expect(y.turnoutBasis).toBe('estimated')
    expect(y.turnoutPct).toBe(41.7)
    expect(y.ginning).toBe('partly_ginned')
    expect(y.bales).toBe(100)
  })

  it('a fully ginned field is pure actual — today’s math, unchanged: receipts’ lint, the field’s own turnout, no estimate', () => {
    const receipts: TurnoutReceiptLike[] = [
      { id: 'g1', field_id: 'fW', crop_year: 2026, bales_count: 300, total_bale_weight: 150_000, total_seed_cotton_weight: 400_000 },
      { id: 'g2', field_id: 'fW', crop_year: 2026, bales_count: 1, total_bale_weight: 1, total_seed_cotton_weight: 399_140 }, // bale rows override
    ]
    const bales = Array.from({ length: 320 }, () => ({ gin_receipt_id: 'g2', net_weight_lbs: 500 }))
    const y = cottonPlantingYield({
      plantedAcres: 249.9, loads: wheelerLoads, receipts, bales,
      ginnedLoadIds: new Set(wheelerLoads.map((l) => l.id)),
      turnout: resolveTurnout({ manualPct: 99 }), // never consulted
    })
    expect(y.yardSeedLbs).toBe(0)
    expect(y.estimatedLintLbs).toBe(0)
    expect(y.actualLintLbs).toBe(150_000 + 160_000)
    expect(y.lintLbs).toBe(310_000)
    expect(y.lintBasis).toBe('actual')
    expect(y.bales).toBe(300 + 320)
    expect(y.turnoutBasis).toBe('actual')
    expect(y.turnoutPct).toBe(Math.round((310_000 / 799_140) * 1000) / 10)
    expect(y.ginning).toBe('ginned')
    expect(y.lintPerAcre).toBeCloseTo(310_000 / 249.9, 6)
  })

  it('nothing picked → null basis, no yield', () => {
    const y = cottonPlantingYield({ plantedAcres: 100, loads: [], receipts: [], bales: [], ginnedLoadIds: new Set(), turnout: DEFAULT_TURNOUT })
    expect(y).toMatchObject({ lintBasis: null, lintPerAcre: null, turnoutPct: null, turnoutBasis: null, ginning: 'none' })
  })

  it('ginningStatusOf: none / on_yard / partly_ginned / ginned', () => {
    const ls = [{ id: 'a' }, { id: 'b' }]
    expect(ginningStatusOf([], new Set())).toBe('none')
    expect(ginningStatusOf(ls, new Set())).toBe('on_yard')
    expect(ginningStatusOf(ls, new Set(['a']))).toBe('partly_ginned')
    expect(ginningStatusOf(ls, new Set(['a', 'b']))).toBe('ginned')
  })
})

describe('cottonProductionTotals — the crop-level figure Marketing prices', () => {
  const receipts = [{ id: 'g1', total_bale_weight: 100_000, bales_count: 200 }]
  it('receipts only without loads (module off) — exactly the old dashboard total', () => {
    const t = cottonProductionTotals({ receipts, bales: [] })
    expect(t).toMatchObject({ lintLbs: 100_000, bales: 200, actualLintLbs: 100_000, estimatedLintLbs: 0, lintBasis: 'actual', turnout: null })
  })
  it('with unginned loads and a turnout: actual + estimate, the bale count stays actual', () => {
    const loads = [load('fW', '2026-10-10', 250_000), load('fS', '2026-10-10', 50_000)]
    const t = cottonProductionTotals({ receipts, bales: [], loads, ginnedLoadIds: new Set([loads[1].id]), turnout: DEFAULT_TURNOUT })
    expect(t.estimatedLintLbs).toBe(100_000)
    expect(t.lintLbs).toBe(200_000)
    expect(t.bales).toBe(200)
    expect(t.lintBasis).toBe('mixed')
    expect(t.turnout?.label).toBe('40% assumed')
  })
})

// ---------------------------------------------------------------------------
// Part D — the module flag: off → inert, byte-identical to before
// ---------------------------------------------------------------------------

const sourcesFor = (loads: SeedCottonLoadLike[], receipts: TurnoutReceiptLike[] = [], ginned: string[] = []): CottonYieldSources => ({
  loads: loads.map((l) => ({ ...l, load_number: l.id, entity_id: null, farm_id: 'fa1', truck: null, gin_id: null, updated_at: '2026-10-12T00:00:00Z' })),
  receipts: receipts.map((r) => ({ ...r, entity_id: null, farm_id: 'fa1', receipt_number: r.id, receipt_date: null, gin_id: null })),
  bales: [], baleGrades: [], gins: [],
  receiptByLoadId: new Map(ginned.map((id) => [id, 'g1'])),
  ginnedLoadIds: new Set(ginned),
})

describe('the Cotton module flag gates everything', () => {
  it('module off (null sources): no adapter, yieldFor null, productionFor = receipts only, turnout still resolves', () => {
    const m = buildCottonYieldModel({ sources: null, crops, assumptions: [{ crop_id: COTTON, crop_year: 2026, assumed_turnout_pct: 43 }] })
    expect(m.on).toBe(false)
    expect(m.adapter).toBeNull()
    expect(m.yieldFor(WHEELER)).toBeNull()
    expect(m.loadsFor('fW', 2026)).toEqual([])
    const receipts = [{ id: 'g1', total_bale_weight: 100_000, bales_count: 200 }]
    expect(m.productionFor({ cropId: COTTON, cropYear: 2026, receipts, bales: [] })).toEqual(cottonProductionTotals({ receipts, bales: [] }))
    expect(m.turnoutFor(COTTON, 2026).pct).toBe(43)
  })

  it('module on: the adapter classifies, yieldFor estimates, productionFor adds the yard', () => {
    const loads = [load('fW', '2026-10-08', 400_000), load('fW', '2026-10-10', 399_140)]
    const m = buildCottonYieldModel({ sources: sourcesFor(loads), crops, assumptions: [] })
    expect(m.on).toBe(true)
    expect(m.cottonCropIds.has(COTTON)).toBe(true)
    expect(m.adapter?.aggFor(WHEELER)?.dryBu).toBe(799_140)
    expect(Math.round(m.yieldFor(WHEELER)!.lintPerAcre!)).toBe(1279)
    expect(m.productionFor({ cropId: COTTON, cropYear: 2026, receipts: [], bales: [] }).lintLbs).toBeCloseTo(319_656, 6)
    expect(m.yieldFor(planting('pC', 'fC', 50, { crop_id: CORN }))).toBeNull()
  })

  it('buildYieldInputs without an adapter is the grain mapping, cotton plantings included (no loads → unharvested)', () => {
    const inputs = buildYieldInputs({ plantings: [WHEELER], aggByKey: new Map(), assumptions })
    expect(inputs[0]).toMatchObject({ id: 'pW', dryBu: 0, lastLoadDate: null, expectedYield: 1200 })
    const analysis = analyzeYields(inputs)
    expect(analysis.excluded.get('pW')).toBe('unharvested')
  })
})

// ---------------------------------------------------------------------------
// Part E — partner /production: lint_basis + turnout_pct (additive, gated)
// ---------------------------------------------------------------------------

describe('buildProductionRecords — cotton rows with the module on', () => {
  const entities: EntityRow[] = [{ id: 'e1', name: 'Turnrow Farms' }]
  const farms: FarmRow[] = [{ id: 'fa1', name: 'Home', fsa_number: null, entity_id: 'e1' }]
  const fields: FieldRow[] = [
    { id: 'fW', farm_id: 'fa1', name_or_number: 'Wheeler Pivot', total_acres: 249.9, irrigated_acres: 249.9, dryland_acres: 0 },
    { id: 'fS', farm_id: 'fa1', name_or_number: 'South', total_acres: 200, irrigated_acres: 200, dryland_acres: 0 },
  ]
  const cropRows: CropRow[] = [{ id: COTTON, name: 'Cotton', base_moisture_pct: null, base_lb_per_bushel: null }]
  const plantings: PlantingRow[] = [WHEELER, SOUTH].map((p) => ({ ...p, updated_at: '2026-04-01T00:00:00Z' }))
  const loads = [load('fW', '2026-10-08', 400_000), load('fW', '2026-10-10', 399_140), load('fS', '2026-10-12', 600_000)]
  const base = { plantings, loads: [], splits: [], ginReceipts: [], fields, farms, entities, crops: cropRows, year: 2026 }

  it('module off: cotton reads unharvested off receipts alone and the record shape is exactly the old one', () => {
    const out = buildProductionRecords({ ...base, now: new Date('2026-10-13T12:00:00Z') })
    const w = out.find((r) => r.field_id === 'fW')!
    expect(w).toMatchObject({ harvest_status: 'unharvested', production_units: 0, unit: 'lbs' })
    expect('lint_basis' in w).toBe(false)
    expect('turnout_pct' in w).toBe(false)
  })

  it('module on: status from the seed cotton loads, lint = the turnout estimate, lint_basis + turnout_pct ride along', () => {
    const cotton = buildCottonYieldModel({ sources: sourcesFor(loads), crops, assumptions: [] })
    const out = buildProductionRecords({ ...base, cotton, now: new Date('2026-10-13T12:00:00Z') })
    const w = out.find((r) => r.field_id === 'fW')!
    const s = out.find((r) => r.field_id === 'fS')!
    // Wheeler: a later load on South released it; normal yield → complete.
    expect(w).toMatchObject({ harvest_status: 'complete', harvested_acres: 249.9, unit: 'lbs', lint_basis: 'estimated_turnout', turnout_pct: 40 })
    expect(w.production_units).toBeCloseTo(319_656, 1)
    // The newest cotton load's updated_at counts toward the record's.
    expect(w.updated_at).toBe('2026-10-12T00:00:00Z')
    // South: the field being picked right now.
    expect(s).toMatchObject({ harvest_status: 'in_progress', harvested_acres: 0, lint_basis: 'estimated_turnout' })
    expect(s.production_units).toBeCloseTo(240_000, 1)
  })

  it('module on, fully ginned: lint_basis actual and no turnout', () => {
    const receipts: TurnoutReceiptLike[] = [{ id: 'g1', field_id: 'fW', crop_year: 2026, bales_count: 640, total_bale_weight: 320_000, total_seed_cotton_weight: 799_140 }]
    const cotton = buildCottonYieldModel({ sources: sourcesFor(loads, receipts, [loads[0].id, loads[1].id]), crops, assumptions: [] })
    const out = buildProductionRecords({
      ...base, cotton, now: new Date('2026-11-01T12:00:00Z'),
      ginReceipts: [{ id: 'g1', field_id: 'fW', crop_year: 2026, total_bale_weight: 320_000 }],
    })
    const w = out.find((r) => r.field_id === 'fW')!
    expect(w).toMatchObject({ harvest_status: 'complete', production_units: 320_000, lint_basis: 'actual', turnout_pct: null })
  })
})
