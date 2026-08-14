// The row model behind the unified "Crop Insurance Price Discovery" window —
// one row per crop the org grows (plantings or policies for the year) × the
// state offers RMA returned. Pure: the component fetches, this assembles.
//
// Harvest shows THREE explicit phases (the status is RMA's, never a guessed
// calendar):
//   pre  — before the window: today's quote of the OFFER'S base contract
//          (the symbol_override estimate tier), "est. — ZCU26 today,
//          discovery starts 8/1/2026"
//   in   — RMA's own running average, "RMA discovery avg through … (day N of M)"
//   post — the RMA final, pinned.
// Projected rides resolveProjectedPrice (RMA released > manual-with-notice >
// seed-demoted). Resolution is untouched — this file is presentation math.

import {
  harvestPhase, type HarvestPhase, type RmaLookupResult,
} from '@/lib/rma-price-discovery'
import {
  resolveProjectedPrice, centsToInsuranceDollars, type ProjectedResolution,
} from '@/lib/crop-insurance'
import type { HarvestPriceEstimate } from '@/lib/types'

const fmtMDY = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${m}/${d}/${y}`
}
const windowLabel = (a: string | null, b: string | null) => (a && b ? `${fmtMDY(a)}–${fmtMDY(b)}` : null)

export type PriceDiscoveryRow = {
  cropId: string
  cropName: string
  stateCode: string | null
  noOffer: boolean
  offerIdentity: string | null
  baseContract: string | null
  exchange: string | null
  volatility: number | null
  projected: {
    resolution: ProjectedResolution | null
    /** RMA window dates + status, for the cell's sub-line. */
    windowLabel: string | null
    status: RmaLookupResult['projected_status']
  }
  harvest: {
    phase: HarvestPhase
    price: number | null
    label: string
    windowLabel: string | null
  }
}

export function buildPriceDiscoveryRows(args: {
  crops: ReadonlyArray<{ id: string; name: string }>
  plantings: ReadonlyArray<{ crop_id: string; season_year: number }>
  policies: ReadonlyArray<{ crop_id: string; crop_year: number }>
  cropYear: number
  rmaResults: readonly RmaLookupResult[]
  estimates: readonly HarvestPriceEstimate[]
  keepManualProjected: ReadonlySet<string>
  /** Live quotes of each crop's OFFER base contract (futures units — cotton
   *  ¢/lb converts here at display). Keyed by crop_id. */
  liveQuotes: ReadonlyMap<string, { price: number; priceDate: string | null }>
}): PriceDiscoveryRow[] {
  const grownCropIds = new Set<string>([
    ...args.plantings.filter((p) => p.season_year === args.cropYear).map((p) => p.crop_id),
    ...args.policies.filter((p) => p.crop_year === args.cropYear).map((p) => p.crop_id),
  ])
  const rows: PriceDiscoveryRow[] = []
  for (const crop of args.crops) {
    if (!grownCropIds.has(crop.id)) continue
    const rmaRows = args.rmaResults.filter((r) => r.crop_id === crop.id)
    const perState: Array<RmaLookupResult | null> = rmaRows.length > 0 ? rmaRows : [null]
    for (const r of perState) {
      const resolution = resolveProjectedPrice(args.estimates, crop.id, args.cropYear, {
        keepManual: args.keepManualProjected.has(crop.id),
      })
      const phase = r?.no_offer ? 'pre' : harvestPhase(r?.harvest_status)
      const live = args.liveQuotes.get(crop.id)
      let harvestPrice: number | null = null
      let harvestLabel: string
      if (r && !r.no_offer && phase === 'in') {
        harvestPrice = r.harvest_price
        harvestLabel = r.harvest_label ?? 'RMA discovery avg'
      } else if (r && !r.no_offer && phase === 'post') {
        harvestPrice = r.harvest_price
        harvestLabel = 'RMA final'
      } else {
        // Pre-window (or no offer): the estimate tier, quoted at the offer's
        // base contract when one is known.
        harvestPrice = live != null ? centsToInsuranceDollars(crop.name, live.price) : null
        const contract = r?.harvest_market_symbol
        const starts = r?.harvest_begin_date ? `discovery starts ${fmtMDY(r.harvest_begin_date)}` : null
        harvestLabel = live != null
          ? ['est.', contract ? `— ${contract} today` : null, starts ? `, ${starts}` : null].filter(Boolean).join(' ')
          : starts ?? (r?.no_offer ? 'no RMA offer' : 'no estimate yet')
      }
      rows.push({
        cropId: crop.id,
        cropName: crop.name,
        stateCode: r?.state_code ?? null,
        noOffer: r?.no_offer === true,
        offerIdentity: r?.offer_identity ?? null,
        baseContract: r?.harvest_market_symbol ?? null,
        exchange: r?.harvest_exchange_code ?? null,
        volatility: r?.volatility ?? null,
        projected: {
          resolution,
          windowLabel: r && !r.no_offer ? windowLabel(r.projected_begin_date, r.projected_end_date) : null,
          status: r?.projected_status ?? null,
        },
        harvest: {
          phase,
          price: harvestPrice,
          label: harvestLabel,
          windowLabel: r && !r.no_offer ? windowLabel(r.harvest_begin_date, r.harvest_end_date) : null,
        },
      })
    }
  }
  rows.sort((a, b) => a.cropName.localeCompare(b.cropName) || (a.stateCode ?? '').localeCompare(b.stateCode ?? ''))
  return rows
}
