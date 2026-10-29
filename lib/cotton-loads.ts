// Seed cotton loads — the pure parts of the list and detail pages: pounds per
// roll, the year / yard roll summary, column sorting, the text search, and
// which page of an uploaded module list belongs to which load.

export type CottonLoadRow = {
  id: string
  load_number: string
  farm_id: string | null
  field_id: string | null
  gin_id: string | null
  picked_date: string | null
  delivered_date: string | null
  truck: string | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null
  rolls: number | null
  notes?: string | null
  source_pdf_url?: string | null
  created_at?: string
}

/** Pounds of seed cotton per roll; null when either side is missing. */
export function lbsPerRoll(net: number | null | undefined, rolls: number | null | undefined): number | null {
  if (net == null || rolls == null || !(Number(rolls) > 0)) return null
  return Number(net) / Number(rolls)
}

export type RollsSummary = {
  loads: number
  netLbs: number
  rolls: number
  /** Loads that recorded a roll count (the average is over these only). */
  loadsWithRolls: number
  netLbsWithRolls: number
  avgLbsPerRoll: number | null
}

/** Totals for a set of loads. The average is weight-weighted: total pounds
 *  on loads that recorded rolls ÷ their total rolls — never an average of
 *  per-load averages, so a heavy load counts for what it weighs. */
export function rollsSummary(loads: ReadonlyArray<Pick<CottonLoadRow, 'net_weight' | 'rolls'>>): RollsSummary {
  let netLbs = 0, rolls = 0, loadsWithRolls = 0, netLbsWithRolls = 0
  for (const l of loads) {
    const net = Number(l.net_weight ?? 0)
    netLbs += net
    if (l.rolls != null && Number(l.rolls) > 0) {
      rolls += Number(l.rolls)
      loadsWithRolls += 1
      netLbsWithRolls += net
    }
  }
  return {
    loads: loads.length, netLbs, rolls, loadsWithRolls, netLbsWithRolls,
    avgLbsPerRoll: rolls > 0 ? netLbsWithRolls / rolls : null,
  }
}

// ---------- the season flow: field → yard → gin ----------

export type SeasonFlowField = {
  fieldId: string | null
  loads: number
  netLbs: number
  yardLbs: number
  ginnedLbs: number
  yardRolls: number
  /** Every roll counted on the field's loads (ginned or not). */
  rolls: number
}

export type SeasonFlow = RollsSummary & {
  yardLbs: number
  ginnedLbs: number
  yardRolls: number
  loadsWithoutRolls: number
  /** Heaviest field first; loads without a field last (fieldId null). */
  fields: SeasonFlowField[]
}

/** The season at a glance: pounds ginned vs still on the yard, rolls waiting,
 *  and the same split per field. One pass over the year's loads. */
export function seasonFlow(loads: ReadonlyArray<Pick<CottonLoadRow, 'id' | 'field_id' | 'net_weight' | 'rolls'>>, ginned: (id: string) => boolean): SeasonFlow {
  const totals = rollsSummary(loads)
  let yardLbs = 0, ginnedLbs = 0, yardRolls = 0
  const byField = new Map<string | null, SeasonFlowField>()
  for (const l of loads) {
    const net = Number(l.net_weight ?? 0)
    const isGinned = ginned(l.id)
    const rolls = l.rolls != null && Number(l.rolls) > 0 ? Number(l.rolls) : 0
    if (isGinned) ginnedLbs += net
    else { yardLbs += net; yardRolls += rolls }
    const key = l.field_id ?? null
    const f = byField.get(key) ?? { fieldId: key, loads: 0, netLbs: 0, yardLbs: 0, ginnedLbs: 0, yardRolls: 0, rolls: 0 }
    f.loads += 1
    f.netLbs += net
    f.rolls += rolls
    if (isGinned) f.ginnedLbs += net
    else { f.yardLbs += net; f.yardRolls += rolls }
    byField.set(key, f)
  }
  const fields = [...byField.values()].sort((a, b) => {
    if ((a.fieldId == null) !== (b.fieldId == null)) return a.fieldId == null ? 1 : -1
    return b.netLbs - a.netLbs
  })
  return { ...totals, yardLbs, ginnedLbs, yardRolls, loadsWithoutRolls: totals.loads - totals.loadsWithRolls, fields }
}

export type CottonSortKey = 'load' | 'farm' | 'field' | 'picked' | 'delivered' | 'truck' | 'gin' | 'rolls' | 'net' | 'perRoll' | 'status'

export type CottonSortContext = {
  farmName: (id: string | null) => string
  fieldName: (id: string | null) => string
  ginName: (id: string | null) => string
  ginned: (id: string) => boolean
}

/** Natural order for load numbers: "M-9" before "M-10", plain digits numeric. */
export function compareLoadNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function cmpNullableNum(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0
  if (a == null) return 1  // blanks last, whichever direction
  if (b == null) return -1
  return a - b
}

export function sortCottonLoads<T extends CottonLoadRow>(rows: readonly T[], key: CottonSortKey, dir: 'asc' | 'desc', ctx: CottonSortContext): T[] {
  const m = dir === 'asc' ? 1 : -1
  const str = (a: string, b: string) => m * a.localeCompare(b, undefined, { sensitivity: 'base' })
  const num = (a: number | null, b: number | null) => {
    // Blanks stay last in both directions.
    if (a == null || b == null) return cmpNullableNum(a, b)
    return m * (a - b)
  }
  const date = (a: string | null, b: string | null) => {
    if (a == null || b == null) return cmpNullableNum(a == null ? null : 0, b == null ? null : 0)
    return m * a.localeCompare(b)
  }
  const out = [...rows]
  out.sort((a, b) => {
    let c = 0
    switch (key) {
      case 'load': c = m * compareLoadNumbers(a.load_number, b.load_number); break
      case 'farm': c = str(ctx.farmName(a.farm_id), ctx.farmName(b.farm_id)); break
      case 'field': c = str(ctx.fieldName(a.field_id), ctx.fieldName(b.field_id)); break
      case 'gin': c = str(ctx.ginName(a.gin_id), ctx.ginName(b.gin_id)); break
      case 'truck': c = str(a.truck ?? '', b.truck ?? ''); break
      case 'picked': c = date(a.picked_date, b.picked_date); break
      case 'delivered': c = date(a.delivered_date, b.delivered_date); break
      case 'rolls': c = num(a.rolls, b.rolls); break
      case 'net': c = num(a.net_weight, b.net_weight); break
      case 'perRoll': c = num(lbsPerRoll(a.net_weight, a.rolls), lbsPerRoll(b.net_weight, b.rolls)); break
      case 'status': c = m * (Number(ctx.ginned(a.id)) - Number(ctx.ginned(b.id))); break
    }
    // Stable tiebreak so equal keys keep a predictable order.
    return c !== 0 ? c : compareLoadNumbers(a.load_number, b.load_number)
  })
  return out
}

export type CottonLoadFilters = {
  q: string
  farmId: string
  fieldId: string
  ginId: string
  status: '' | 'yard' | 'ginned'
  from: string
  to: string
}

export const EMPTY_COTTON_FILTERS: CottonLoadFilters = { q: '', farmId: '', fieldId: '', ginId: '', status: '', from: '', to: '' }

export function filterCottonLoads<T extends CottonLoadRow>(rows: readonly T[], f: CottonLoadFilters, ctx: CottonSortContext): T[] {
  const q = f.q.trim().toLowerCase()
  return rows.filter((l) => {
    if (f.farmId && l.farm_id !== f.farmId) return false
    if (f.fieldId && l.field_id !== f.fieldId) return false
    if (f.ginId && l.gin_id !== f.ginId) return false
    if (f.status === 'yard' && ctx.ginned(l.id)) return false
    if (f.status === 'ginned' && !ctx.ginned(l.id)) return false
    if (f.from && (!l.delivered_date || l.delivered_date < f.from)) return false
    if (f.to && (!l.delivered_date || l.delivered_date > f.to)) return false
    if (q) {
      const hay = [l.load_number, l.truck, ctx.farmName(l.farm_id), ctx.fieldName(l.field_id), ctx.ginName(l.gin_id), l.notes]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** How an uploaded module list's pages map onto the loads read from it. The
 *  format is one load per page, so when the counts agree page i is load i's
 *  own ticket; otherwise every load gets the whole document rather than a
 *  guessed page. */
export function documentPagePlan(loadCount: number, pageCount: number): 'per-page' | 'whole' | 'none' {
  if (pageCount <= 0 || loadCount <= 0) return 'none'
  return loadCount === pageCount ? 'per-page' : 'whole'
}
