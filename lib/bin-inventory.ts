// Bin inventory math shared by the Bin Inventory page and the transfer UI.
//
// A bin's on-hand dry bushels for a crop:
//   loadBacked + beginning − emptyAdj + transferIn − transferOut + combineRemainder
//
// Transfers move grain BETWEEN bins on a dry-bushel basis, so every transfer
// subtracts from the source and adds the same amount to the destination —
// operation totals are conserved by construction (a wet bin → dry bin move
// after drying nets zero; drying shrink is handled by the dry-bushel
// conversion on loads, not by transfers). Transfers are NOT loads: they never
// enter yield, production, contract-delivery, or marketing math, all of which
// aggregate loads only.
//
// combineRemainder (062) is the same kind of non-load component: the NETTED
// remainder of a combine yield entry with a destination bin — adjusted total
// minus the field's weighed loads. The weighed bin-bound loads from that field
// are already in loadBacked, so posting only the remainder keeps the bin from
// double-counting them. A negative remainder (weighed > combine entry) posts
// nothing here — it's warned on the entry and in the yields drill-down, never
// silently netted out of a bin.

export type BinInventoryCell = {
  loadBacked: number
  beginning: number
  emptyAdj: number
  transferIn: number
  transferOut: number
  /** Netted combine-entry remainders posted to this bin (062). */
  combineRemainder: number
}

/** bin_id → crop_id → cell */
export type OnHandBag = Map<string, Map<string, BinInventoryCell>>

export type TransferLike = {
  from_bin_id: string
  to_bin_id: string
  crop_id: string
  bushels: number
}

export function emptyCell(): BinInventoryCell {
  return { loadBacked: 0, beginning: 0, emptyAdj: 0, transferIn: 0, transferOut: 0, combineRemainder: 0 }
}

export function cellFor(bag: OnHandBag, binId: string, cropId: string): BinInventoryCell {
  let inner = bag.get(binId)
  if (!inner) { inner = new Map(); bag.set(binId, inner) }
  let cell = inner.get(cropId)
  if (!cell) { cell = emptyCell(); inner.set(cropId, cell) }
  return cell
}

export function cellTotal(c: BinInventoryCell): number {
  return c.loadBacked + c.beginning - c.emptyAdj + c.transferIn - c.transferOut + c.combineRemainder
}

/**
 * Post combine-entry remainders (062) to their destination bins. Each entry
 * with a destination bin adds its netted remainder — adjusted total minus the
 * field's weighed loads — as a non-load component. Only positive remainders
 * post (a negative net is a data problem warned on the yields side); only bins
 * already seeded in the bag are touched, like applyTransfers.
 */
export function applyCombineRemainders(
  bag: OnHandBag,
  entries: ReadonlyArray<{ crop_id: string; destinationBinId: string | null; remainderBu: number }>,
): void {
  for (const e of entries) {
    if (!e.destinationBinId || !(e.remainderBu > 0)) continue
    if (bag.has(e.destinationBinId)) cellFor(bag, e.destinationBinId, e.crop_id).combineRemainder += e.remainderBu
  }
}

/**
 * Apply bin-to-bin transfers to an on-hand bag. Only bins already seeded in
 * the bag are touched (mirrors how loads to deleted/unknown bins are skipped).
 */
export function applyTransfers(bag: OnHandBag, transfers: TransferLike[]): void {
  for (const t of transfers) {
    const bu = Number(t.bushels)
    if (!bu || bu <= 0) continue
    if (bag.has(t.from_bin_id)) cellFor(bag, t.from_bin_id, t.crop_id).transferOut += bu
    if (bag.has(t.to_bin_id)) cellFor(bag, t.to_bin_id, t.crop_id).transferIn += bu
  }
}

/** Total dry bushels across every bin and crop — the conservation invariant. */
export function orgTotal(bag: OnHandBag): number {
  let sum = 0
  for (const inner of bag.values()) for (const c of inner.values()) sum += cellTotal(c)
  return sum
}

// --- Transfer estimator ------------------------------------------------------

/** throughput (bu/hr) × hours run, rounded to 2 decimals. Null until both inputs are usable. */
export function estimateTransferBushels(
  throughputBuPerHr: number | null,
  hoursRun: number | null,
): number | null {
  if (throughputBuPerHr == null || hoursRun == null) return null
  if (!isFinite(throughputBuPerHr) || !isFinite(hoursRun)) return null
  if (throughputBuPerHr <= 0 || hoursRun <= 0) return null
  return Math.round(throughputBuPerHr * hoursRun * 100) / 100
}

/**
 * Warning (not a block) when a transfer moves more than the source bin shows
 * on hand for that crop — bin inventory is an estimate, so the user may know
 * better than the math.
 */
export function overInventoryMessage(args: {
  moving: number
  onHandBu: number
  fromBinName: string
  cropName: string
}): string | null {
  const { moving, onHandBu, fromBinName, cropName } = args
  if (!(moving > 0)) return null
  if (moving <= onHandBu + 0.005) return null
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return `Moving ${fmt(moving)} bu but ${fromBinName} shows ${fmt(Math.max(0, onHandBu))} bu of ${cropName} — inventory estimates may be imprecise. Continue?`
}

// --- Capacity / percent full -------------------------------------------------

export const NEAR_FULL_PCT = 90

export type CapacityStatus = 'ok' | 'near_full' | 'over'

/**
 * Percent full for a bin (all crops combined) against its rated capacity.
 * Null when no usable capacity is set; negative on-hand clamps to 0.
 * NOT capped at 100 — inventory is an estimate, so an over-full bin reports
 * its real percentage and the UI labels it ">100%".
 */
export function percentFull(totalBu: number, capacityBu: number | null): number | null {
  if (capacityBu == null || !(capacityBu > 0)) return null
  return (Math.max(0, totalBu) / capacityBu) * 100
}

export function capacityStatus(pct: number): CapacityStatus {
  if (pct >= 100) return 'over'
  if (pct >= NEAR_FULL_PCT) return 'near_full'
  return 'ok'
}

/** Label for the bar: whole percent, with ">100%" instead of a clipped number. */
export function percentFullLabel(pct: number): string {
  if (pct > 100) return '>100%'
  return `${Math.round(pct)}%`
}

/**
 * Site-level capacity rollup. Only bins WITH a capacity participate in the
 * site percent (their capacity and their bushels), so a full uncapacitied
 * bin can't push the site over 100% against a partial capacity sum. The
 * caller footnotes `binsWithoutCapacity` when it's non-zero.
 */
export function siteCapacitySummary(
  bins: { capacityBu: number | null; totalBu: number }[],
): { capacityBu: number; bushelsInCapacityBins: number; pct: number | null; binsWithCapacity: number; binsWithoutCapacity: number } {
  let capacityBu = 0
  let bushelsInCapacityBins = 0
  let withCap = 0
  let withoutCap = 0
  for (const b of bins) {
    if (b.capacityBu != null && b.capacityBu > 0) {
      capacityBu += b.capacityBu
      bushelsInCapacityBins += Math.max(0, b.totalBu)
      withCap++
    } else {
      withoutCap++
    }
  }
  return {
    capacityBu,
    bushelsInCapacityBins,
    pct: capacityBu > 0 ? (bushelsInCapacityBins / capacityBu) * 100 : null,
    binsWithCapacity: withCap,
    binsWithoutCapacity: withoutCap,
  }
}
