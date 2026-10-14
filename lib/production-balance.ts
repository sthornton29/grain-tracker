// "Balance to settlements" for the Crop Insurance Production Report — pure.
//
// An auditor compares reported production to the bushels the buyers paid
// for. Scale-ticket dry bushels never match buyer net bushels exactly (buyer
// shrink, FM, dockage), so the report can BALANCE production so the bushels
// paid for match our production records. Per grain crop × crop year,
// crop-wide across every entity (settlements and bins mix entities' grain):
//
//   settled      = Σ buyer net bushels on saved settlement lines whose matched
//                  load is this crop and crop year (field-direct AND bin-out
//                  loads; each line once; the line's net bu, not the sale split)
//   unsettled    = our dry bu on loads delivered to a buyer for the crop / year
//                  with no settlement line yet (price-later deliveries included)
//   bins         = the book inventory for the crop / year: loads hauled into
//                  bins minus loads hauled out, plus netted combine-entry
//                  remainders posted to a bin ("book inventory; measure bins to
//                  support farm-stored production")
//   balanced     = settled + unsettled + bins
//   measured     = the report's production for the crop (all entities)
//   factor       = balanced ÷ measured
//
// Every field's (and practice row's) balanced production = measured × factor;
// an entity filter still uses the crop-wide factor. When nothing is unsettled
// and the bins are empty, balanced = settled EXACTLY, so the balanced
// production sums to the bushels paid.
//
// A settlement line with no matched load has no crop, so it cannot count —
// it is reported so the user can match it. Balancing is a report option only:
// Yields, Marketing, the Claims Monitor and the partner API keep measured
// production. Cotton is never balanced (it already reports the gin's lint).

import { computeBushels } from '@/lib/shrink'

export type BalanceLoadRow = {
  id: string
  date: string
  ticket_number?: string | null
  crop_id: string | null
  crop_year: number | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
  from_type: string | null
  from_field_id: string | null
  from_bin_id?: string | null
  to_type?: string | null
  to_bin_id?: string | null
  to_buyer_id?: string | null
}

export type BalanceSettlementLine = {
  id: string
  settlement_id: string
  load_id: string | null
  net_bushels: number | string | null
  ticket_number?: string | null
  buyer_ticket_number?: string | null
}

export type BalanceSettlement = {
  id: string
  buyer_id: string | null
  settlement_date: string | null
  settlement_number: string | null
}

export type CropLike = { id: string; name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null }

export type ProductionBalanceInput = {
  cropYear: number
  crops: readonly CropLike[]
  cottonCropIds: ReadonlySet<string>
  loads: readonly BalanceLoadRow[]
  lines: readonly BalanceSettlementLine[]
  settlements: readonly BalanceSettlement[]
  /** Measured production per crop id, all entities (the report before any entity filter). */
  measuredByCrop: ReadonlyMap<string, number>
  /** Combine-entry remainders posted to bins (lib/yields FieldCropAgg.combine). */
  combineRemainders?: ReadonlyArray<{ crop_id: string; crop_year: number; destinationBinId: string | null; remainderBu: number }>
  /** Loads the report itself leaves out (a still-harvesting field's loads):
   *  their production is not measured, so they enter no side of the balance —
   *  not settled, not unsettled, not the bins. lib/production-report
   *  loadIdsOfPlantings builds the set. */
  excludeLoadIds?: ReadonlySet<string>
}

export type SettledLine = {
  line: BalanceSettlementLine
  settlement: BalanceSettlement | null
  load: BalanceLoadRow
  netBu: number
}

export type UnsettledLoad = { load: BalanceLoadRow; dryBu: number }

export type CropBalance = {
  cropId: string
  cropName: string
  measured: number
  settled: number
  settledLines: SettledLine[]
  /** Distinct settlements the counted lines came from. */
  settlementCount: number
  unsettled: number
  unsettledLoads: UnsettledLoad[]
  bins: number
  binsIn: number
  binsOut: number
  binsCombine: number
  balancedTotal: number
  /** balanced ÷ measured; 1 when measured is 0. */
  factor: number
  /** Nothing unsettled and the bins empty: balanced equals the bushels paid. */
  allPaid: boolean
  /** |factor − 1| beyond BALANCE_WARN: check for a missing settlement or load. */
  warn: boolean
  /** Unmatched lines on settlements that also carry this crop's matched lines. */
  unmatched: { lines: number; bu: number; settlementIds: string[] }
}

export type ProductionBalance = {
  byCrop: Map<string, CropBalance>
  /** Unmatched lines on settlements with NO matched line at all, dated in or
   *  after the crop year — they belong to no crop until matched. */
  orphanUnmatched: { lines: number; bu: number; settlementIds: string[] }
}

export const BALANCE_WARN = 0.05
export const BINS_NOTE = 'book inventory; measure bins to support farm-stored production'

const num = (v: number | string | null | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** A load's dry bushels exactly as the app computes them (null when it has none). */
export function loadDryBushels(l: BalanceLoadRow, crop: CropLike | undefined): number | null {
  return computeBushels({
    netWeightLb: l.net_weight, moisturePct: l.moisture,
    baseMoisturePct: crop?.base_moisture_pct ?? null, baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: l.dry_bushels_override,
  }).dryBushels
}

export function buildProductionBalance(input: ProductionBalanceInput): ProductionBalance {
  const cropById = new Map(input.crops.map((c) => [c.id, c]))
  const loadById = new Map(input.loads.map((l) => [l.id, l]))
  const settlementById = new Map(input.settlements.map((s) => [s.id, s]))
  const grainCrops = input.crops.filter((c) => !input.cottonCropIds.has(c.id))
  const excluded = input.excludeLoadIds ?? new Set<string>()
  const yearLoads = input.loads.filter((l) => l.crop_year === input.cropYear && l.crop_id != null && !excluded.has(l.id))

  // Lines by the matched load's crop; which loads carry a line at all.
  const settledByCrop = new Map<string, SettledLine[]>()
  const settledLoadIds = new Set<string>()
  const matchedCropBySettlement = new Map<string, Set<string>>()
  const unmatchedBySettlement = new Map<string, { lines: number; bu: number }>()
  for (const line of input.lines) {
    if (!line.load_id) {
      const u = unmatchedBySettlement.get(line.settlement_id) ?? { lines: 0, bu: 0 }
      u.lines += 1
      u.bu += num(line.net_bushels)
      unmatchedBySettlement.set(line.settlement_id, u)
      continue
    }
    const load = loadById.get(line.load_id)
    if (!load) continue
    settledLoadIds.add(load.id)
    if (excluded.has(load.id)) continue
    if (load.crop_year !== input.cropYear || !load.crop_id || input.cottonCropIds.has(load.crop_id)) continue
    const arr = settledByCrop.get(load.crop_id) ?? []
    arr.push({ line, settlement: settlementById.get(line.settlement_id) ?? null, load, netBu: num(line.net_bushels) })
    settledByCrop.set(load.crop_id, arr)
    const set = matchedCropBySettlement.get(line.settlement_id) ?? new Set<string>()
    set.add(load.crop_id)
    matchedCropBySettlement.set(line.settlement_id, set)
  }

  const byCrop = new Map<string, CropBalance>()
  for (const crop of grainCrops) {
    const settledLines = (settledByCrop.get(crop.id) ?? []).sort((a, b) =>
      (a.settlement?.settlement_date ?? '').localeCompare(b.settlement?.settlement_date ?? '') ||
      (a.settlement?.settlement_number ?? '').localeCompare(b.settlement?.settlement_number ?? '') ||
      a.load.date.localeCompare(b.load.date) || a.line.id.localeCompare(b.line.id))
    const settled = settledLines.reduce((a, x) => a + x.netBu, 0)
    const settlementCount = new Set(settledLines.map((x) => x.line.settlement_id)).size

    const unsettledLoads: UnsettledLoad[] = []
    let binsIn = 0
    let binsOut = 0
    for (const l of yearLoads) {
      if (l.crop_id !== crop.id) continue
      const dry = loadDryBushels(l, crop)
      if (dry == null) continue
      if (l.to_type === 'buyer' && !settledLoadIds.has(l.id)) unsettledLoads.push({ load: l, dryBu: dry })
      if (l.to_type === 'bin' && l.to_bin_id) binsIn += dry
      if (l.from_type === 'bin' && l.from_bin_id) binsOut += dry
    }
    unsettledLoads.sort((a, b) => a.load.date.localeCompare(b.load.date) || a.load.id.localeCompare(b.load.id))
    const unsettled = unsettledLoads.reduce((a, x) => a + x.dryBu, 0)
    const binsCombine = (input.combineRemainders ?? [])
      .filter((r) => r.crop_id === crop.id && r.crop_year === input.cropYear && r.destinationBinId && r.remainderBu > 0)
      .reduce((a, r) => a + r.remainderBu, 0)
    const bins = binsIn - binsOut + binsCombine
    const measured = input.measuredByCrop.get(crop.id) ?? 0
    const balancedTotal = settled + unsettled + bins
    const factor = measured > 0 ? balancedTotal / measured : 1

    const unmatched = { lines: 0, bu: 0, settlementIds: [] as string[] }
    for (const [sid, u] of unmatchedBySettlement) {
      if (!matchedCropBySettlement.get(sid)?.has(crop.id)) continue
      unmatched.lines += u.lines
      unmatched.bu += u.bu
      unmatched.settlementIds.push(sid)
    }

    byCrop.set(crop.id, {
      cropId: crop.id, cropName: crop.name, measured, settled, settledLines, settlementCount,
      unsettled, unsettledLoads, bins, binsIn, binsOut, binsCombine, balancedTotal, factor,
      allPaid: Math.abs(unsettled) < 0.0005 && Math.abs(bins) < 0.0005,
      warn: measured > 0 && Math.abs(factor - 1) > BALANCE_WARN,
      unmatched,
    })
  }

  const orphanUnmatched = { lines: 0, bu: 0, settlementIds: [] as string[] }
  const floor = `${input.cropYear}-01-01`
  for (const [sid, u] of unmatchedBySettlement) {
    if (matchedCropBySettlement.has(sid)) continue
    const s = settlementById.get(sid)
    if (!s || !s.settlement_date || s.settlement_date < floor) continue
    orphanUnmatched.lines += u.lines
    orphanUnmatched.bu += u.bu
    orphanUnmatched.settlementIds.push(sid)
  }
  return { byCrop, orphanUnmatched }
}

/** The factor per crop id (1 for crops with no balance — cotton). */
export function balanceFactors(balance: ProductionBalance | null | undefined): Map<string, number> {
  const m = new Map<string, number>()
  if (!balance) return m
  for (const [id, b] of balance.byCrop) m.set(id, b.factor)
  return m
}

/** "0.9838 (−1.62%)" — the factor both ways, for the panel and the notes. */
export function factorLabel(factor: number): string {
  const pct = (factor - 1) * 100
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
  return `${factor.toFixed(4)} (${sign}${Math.abs(pct).toFixed(2)}%)`
}
