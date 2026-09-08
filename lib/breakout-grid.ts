// The assumptions breakout grid's ROW MODEL — which practice × season rows a
// crop's yield / cost / assumed-acres grid shows, and how they are labeled.
//
// Two sources of truth, one rule each:
//   * a PLANTED crop × year: rows come from the real plantings — a segment
//     appears iff it has acres (a double-crop segment can only exist for a
//     crop designated Double-crop in Settings → Crops, since that is what
//     buildDoubleCropSet keys on);
//   * an ASSUMED crop × year (no plantings yet, 081): every cell is on offer
//     so the split can be typed in — but ONLY the cells the crop's
//     designation allows: Irrigated + Dryland always, the two Double-crop
//     rows only when the crop is designated Double-crop.
//
// Labels carry the "Full-season ·" / "Double-crop ·" prefix only when both
// season kinds are actually in play; a crop with no double-crop counterpart
// reads plainly "Irrigated" / "Dryland".
//
// If a crop's designation changes later, the grid follows. Acres already
// entered in a now-hidden double-crop row are NOT silently dropped: the grid
// surfaces a notice so the user can re-enable Double-crop or clear them.

import type { SegmentAcres } from '@/lib/marketing'

export type BreakoutRowKey = 'irr' | 'dry' | 'dcIrr' | 'dcDry'
export type BreakoutMode = 'planted' | 'assumed'

const ALL_ROWS: readonly BreakoutRowKey[] = ['irr', 'dry', 'dcIrr', 'dcDry']
const SEG_FIELD: Record<BreakoutRowKey, keyof SegmentAcres> = { irr: 'fullIrr', dry: 'fullDry', dcIrr: 'dcIrr', dcDry: 'dcDry' }

export function isDoubleCropRow(key: BreakoutRowKey): boolean {
  return key === 'dcIrr' || key === 'dcDry'
}

/** The rows the grid renders, in display order. */
export function breakoutRowKeys(args: {
  mode: BreakoutMode
  /** The crop's Double-crop designation (crops.double_crop). */
  doubleCrop: boolean
  /** The segments in play (planted acres, or the assumed cells as typed). */
  seg: SegmentAcres
}): BreakoutRowKey[] {
  if (args.mode === 'planted') {
    return ALL_ROWS.filter((k) => (args.seg[SEG_FIELD[k]] ?? 0) > 0)
  }
  return args.doubleCrop ? [...ALL_ROWS] : ['irr', 'dry']
}

/** Whether labels need the season prefix: both full-season and double-crop
 *  rows are showing. */
export function breakoutShowsSeason(rows: readonly BreakoutRowKey[]): boolean {
  return rows.some(isDoubleCropRow) && rows.some((k) => !isDoubleCropRow(k))
}

export function breakoutRowLabel(key: BreakoutRowKey, showSeason: boolean): string {
  const practice = key === 'irr' || key === 'dcIrr' ? 'Irrigated' : 'Dryland'
  if (!showSeason) return practice
  return `${isDoubleCropRow(key) ? 'Double-crop' : 'Full-season'} · ${practice}`
}

/** Acres sitting in double-crop cells the grid no longer shows (the crop is
 *  not designated Double-crop). Null when nothing is hidden. */
export function hiddenDoubleCropAcres(args: {
  doubleCrop: boolean
  stored: { dcIrr: number | string | null | undefined; dcDry: number | string | null | undefined }
}): number | null {
  if (args.doubleCrop) return null
  const n = (v: number | string | null | undefined) => (v == null || v === '' ? 0 : Number(v) || 0)
  const total = n(args.stored.dcIrr) + n(args.stored.dcDry)
  return total > 0 ? total : null
}

/** The plain-language notice for hidden double-crop acres. */
export function hiddenDoubleCropNotice(args: { cropYear: number; cropName: string; hiddenAcres: number }): string {
  const ac = Math.round(args.hiddenAcres * 10) / 10
  return `${args.cropYear} had ${ac.toLocaleString()} double-crop acres entered for ${args.cropName} — re-enable Double-crop for it under Settings → Crops, or clear them.`
}
