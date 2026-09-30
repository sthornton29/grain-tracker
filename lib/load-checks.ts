// Pre-save plausibility checks for a load — the ONE place that decides which
// weights and readings look wrong before the record lands. Pure: the form
// hands in parsed numbers and shows the sentences in a confirm dialog.
//
// Two tiers:
//   * blockers — the save must not proceed (a negative net weight).
//   * warnings — a real ticket CAN look like this (a dropped trailer, a
//     wet-corn load), so the user gets "Save anyway" / "Go back", never a
//     hard stop. Every sentence is plain farmer language.
//
// Ranges are deliberately loose: they catch swapped or fat-fingered entries
// (a moisture of 158, a test weight of 5,800), not marginal grain.

export type LoadCheckInput = {
  gross: number | null
  tare: number | null
  net: number | null
  moisture: number | null
  testWeight: number | null
  /** True when an own truck or a hauler truck is filled in. */
  truckPicked: boolean
  /** Optional crop context for the crop-aware checks. */
  crop?: {
    name?: string | null
    base_moisture_pct?: number | null
    base_lb_per_bushel?: number | null
  } | null
}

export type LoadCheckResult = {
  /** Save must not proceed. */
  blockers: string[]
  /** Save may proceed after the user confirms. */
  warnings: string[]
}

/** Net weight above this is more than a truck hauls — almost always a typo. */
export const MAX_PLAUSIBLE_NET_LB = 120_000
export const MOISTURE_MAX_PCT = 40
export const TEST_WEIGHT_MIN = 30
export const TEST_WEIGHT_MAX = 80

const lbs = (n: number) => Math.round(n).toLocaleString('en-US')
const pct = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 })

export function checkLoad(input: LoadCheckInput): LoadCheckResult {
  const blockers: string[] = []
  const warnings: string[] = []
  const { gross, tare, net, moisture, testWeight } = input

  if (net != null && net < 0) {
    blockers.push('Net weight is below zero — check the gross and tare.')
  }

  if (gross != null && tare != null && gross < tare) {
    warnings.push('Gross is less than tare — are they swapped?')
  }
  if (net == null) {
    warnings.push('No net weight — this load will save with no bushels.')
  } else if (net === 0) {
    warnings.push('Net weight is zero — this load will save with no bushels.')
  } else if (net > MAX_PLAUSIBLE_NET_LB) {
    warnings.push(`Net weight is ${lbs(net)} lb — more than a truck usually hauls. Check for an extra digit.`)
  }
  if (!input.truckPicked) {
    warnings.push('No truck picked.')
  }
  if (moisture != null) {
    if (moisture < 0 || moisture > MOISTURE_MAX_PCT) {
      warnings.push(`Moisture ${pct(moisture)}% is outside the usual range (0–${MOISTURE_MAX_PCT}%).`)
    } else {
      // Crop-aware: far above the crop's base is unusual even when under the cap.
      const base = input.crop?.base_moisture_pct
      if (base != null && Number.isFinite(base) && moisture > base + 20) {
        const cropName = input.crop?.name ? `${input.crop.name}'s` : "this crop's"
        warnings.push(`Moisture ${pct(moisture)}% is far above ${cropName} base of ${pct(base)}%.`)
      }
    }
  }
  if (testWeight != null && (testWeight < TEST_WEIGHT_MIN || testWeight > TEST_WEIGHT_MAX)) {
    warnings.push(`Test weight ${pct(testWeight)} is outside the usual ${TEST_WEIGHT_MIN}–${TEST_WEIGHT_MAX} lb/bu.`)
  }

  return { blockers, warnings }
}
