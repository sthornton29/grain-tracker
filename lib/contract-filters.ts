// The contract tracker's filters: ONE definition of the query string that
// both the server page (which reads it) and the filter bar (which writes it)
// use, so the URL, the controls, and the table can never disagree about what
// a filter means.
//
// Memory lives in a cookie (CONTRACT_FILTER_COOKIE) rather than localStorage:
// the server sees a cookie on the very first request, so a bare /contracts
// (nav link, bookmark, tomorrow morning) redirects straight to the remembered
// filters instead of rendering everything and then flipping a second later.
// The client owns the cookie: it writes it on every filtered view and clears
// it BEFORE navigating to a bare /contracts (Clear filters, or deselecting the
// last one), so a bare URL from the filter bar means "show everything".

export type ContractFilterValues = {
  entity: string
  crop: string
  crop_year: string
  type: string
  pricing: string
  hide_completed: boolean
  hide_future: boolean
  sort: string
  dir: 'asc' | 'desc'
}

export const EMPTY_CONTRACT_FILTERS: ContractFilterValues = {
  entity: '', crop: '', crop_year: '', type: '', pricing: '', hide_completed: false, hide_future: false, sort: '', dir: 'asc',
}

export const CONTRACT_FILTER_KEYS = ['entity', 'crop', 'crop_year', 'type', 'pricing', 'hide_completed', 'hide_future', 'sort', 'dir'] as const
export type ContractFilterKey = (typeof CONTRACT_FILTER_KEYS)[number]

export const CONTRACT_TYPE_FILTERS = ['forward', 'hta', 'basis', 'seed'] as const
export const CONTRACT_PRICING_FILTERS = ['fully_priced', 'awaiting_basis', 'awaiting_futures'] as const
const SORT_KEYS = ['crop'] as const

export const CONTRACT_FILTER_COOKIE = 'turnrow_contract_filters'

type ParamSource = Record<string, string | string[] | undefined> | URLSearchParams

function read(src: ParamSource, key: string): string {
  if (src instanceof URLSearchParams) return src.get(key) ?? ''
  const v = src[key]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

/** Tolerant parse: unknown values fall back to "all" rather than filtering
 *  to nothing (a stale bookmark with a deleted crop id still filters by that
 *  id — that is the user's choice — but a nonsense type or year is dropped). */
export function parseContractFilters(src: ParamSource): ContractFilterValues {
  const type = read(src, 'type')
  const pricing = read(src, 'pricing')
  const year = read(src, 'crop_year')
  const sort = read(src, 'sort')
  return {
    entity: read(src, 'entity'),
    crop: read(src, 'crop'),
    crop_year: /^\d{4}$/.test(year) ? year : '',
    type: (CONTRACT_TYPE_FILTERS as readonly string[]).includes(type) ? type : '',
    pricing: (CONTRACT_PRICING_FILTERS as readonly string[]).includes(pricing) ? pricing : '',
    hide_completed: read(src, 'hide_completed') === '1',
    hide_future: read(src, 'hide_future') === '1',
    sort: (SORT_KEYS as readonly string[]).includes(sort) ? sort : '',
    dir: read(src, 'dir') === 'desc' ? 'desc' : 'asc',
  }
}

/** The canonical query string (no leading "?"); empty when nothing is set. */
export function serializeContractFilters(v: ContractFilterValues): string {
  const p = new URLSearchParams()
  if (v.entity) p.set('entity', v.entity)
  if (v.crop_year) p.set('crop_year', v.crop_year)
  if (v.crop) p.set('crop', v.crop)
  if (v.type) p.set('type', v.type)
  if (v.pricing) p.set('pricing', v.pricing)
  if (v.hide_completed) p.set('hide_completed', '1')
  if (v.hide_future) p.set('hide_future', '1')
  if (v.sort) { p.set('sort', v.sort); p.set('dir', v.dir) }
  return p.toString()
}

/** Whether the request carries ANY tracker parameter — even one that parses
 *  to "all". A request with none is a bare arrival that may be restored from
 *  the cookie; a request with any is the user's explicit choice. */
export function hasAnyContractFilterParam(src: ParamSource): boolean {
  return read(src, 'all') !== '' || CONTRACT_FILTER_KEYS.some((k) => read(src, k) !== '')
}

/** A link that means "show every contract" even when filters are remembered:
 *  the marker makes it an explicit choice, so the server does not restore the
 *  cookie and the filter bar clears the memory. */
export const CONTRACTS_ALL_HREF = '/contracts?all=1'

/** How many filters are narrowing the list (the badge on the collapsed bar). */
export function activeContractFilterCount(v: ContractFilterValues): number {
  return [v.entity, v.crop, v.crop_year, v.type, v.pricing].filter(Boolean).length
    + (v.hide_completed ? 1 : 0) + (v.hide_future ? 1 : 0)
}

/** The remembered query string from a cookie value, re-serialized through
 *  the parser so a tampered or stale cookie can only ever yield valid
 *  filters; null when there is nothing worth restoring. */
export function savedContractFilters(cookieValue: string | null | undefined): string | null {
  if (!cookieValue) return null
  let raw = cookieValue
  try { raw = decodeURIComponent(cookieValue) } catch { /* keep as-is */ }
  const qs = serializeContractFilters(parseContractFilters(new URLSearchParams(raw)))
  return qs || null
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** Browser-side cookie writes (no-ops when `document` is unavailable). */
export function writeContractFilterCookie(qs: string): void {
  if (typeof document === 'undefined') return
  try {
    if (qs) document.cookie = `${CONTRACT_FILTER_COOKIE}=${encodeURIComponent(qs)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`
    else document.cookie = `${CONTRACT_FILTER_COOKIE}=; path=/; max-age=0; SameSite=Lax`
  } catch { /* cookies blocked — the filters still work, they just aren't remembered */ }
}

export function clearContractFilterCookie(): void {
  writeContractFilterCookie('')
}
