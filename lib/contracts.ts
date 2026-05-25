// Physical contract pricing helpers — forward / HTA / basis breakdown and the
// crop → futures-month mapping used by the contract month dropdown.

import { COMMODITY_SPECS, contractMonthOptions, type Commodity, type ContractMonthOption } from '@/lib/hedging'

export type ContractType = 'forward' | 'hta' | 'basis'
export type PricingStatus = 'fully_priced' | 'awaiting_basis' | 'awaiting_futures'

// Map a crops-table name to the futures commodity whose delivery cycle applies.
// Crops we don't trade futures on (e.g. Canola) return null.
export function cropToCommodity(cropName: string | null | undefined): Commodity | null {
  const s = (cropName ?? '').trim().toLowerCase()
  if (!s) return null
  if (s.includes('corn')) return 'Corn'
  if (s.includes('soybean') || s === 'beans' || s === 'soy') return 'Soybeans'
  if (s.includes('wheat')) return 'Chicago Wheat'
  return null
}

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

// Contract month options for a crop. Uses the commodity's delivery cycle when
// the crop maps to a traded future; otherwise every month for the next 2 years.
export function contractMonthOptionsForCrop(cropName: string | null | undefined, from: Date = new Date()): ContractMonthOption[] {
  const commodity = cropToCommodity(cropName)
  if (commodity && COMMODITY_SPECS[commodity]) return contractMonthOptions(commodity, from)
  const out: ContractMonthOption[] = []
  const start = new Date(from.getFullYear(), from.getMonth(), 1)
  for (let i = 0; i <= 24; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    const monthNum = d.getMonth() + 1
    out.push({ label: `${MONTH_ABBR[monthNum - 1]} ${String(d.getFullYear() % 100).padStart(2, '0')}`, monthNum, year: d.getFullYear(), code: '' })
  }
  return out
}

// Cash = Futures + Basis − Service fee. Inverses solve for the missing leg.
export function cashFromFuturesBasis(futures: number, basis: number, fee = 0): number {
  return round6(futures + basis - fee)
}
export function futuresFromCashBasis(cash: number, basis: number, fee = 0): number {
  return round6(cash - basis + fee)
}
export function basisFromCashFutures(cash: number, futures: number, fee = 0): number {
  return round6(cash - futures + fee)
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// Derive pricing_status from the contract type and which legs are filled in.
export function pricingStatusFor(
  contractType: ContractType,
  legs: { futures: number | null; basis: number | null },
): PricingStatus {
  if (contractType === 'hta') return legs.basis != null ? 'fully_priced' : 'awaiting_basis'
  if (contractType === 'basis') return legs.futures != null ? 'fully_priced' : 'awaiting_futures'
  return 'fully_priced' // forward
}

export const CONTRACT_TYPE_LABEL: Record<ContractType, string> = {
  forward: 'Forward',
  hta: 'HTA',
  basis: 'Basis',
}
export const PRICING_STATUS_LABEL: Record<PricingStatus, string> = {
  fully_priced: 'Fully priced',
  awaiting_basis: 'Awaiting basis',
  awaiting_futures: 'Awaiting futures',
}
