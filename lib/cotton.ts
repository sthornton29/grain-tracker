// Cotton module — pure math: lint turnout, lbs/acre yields, yard inventory
// (seed cotton delivered but not yet on a gin receipt), bale↔grade matching,
// and receipt bale-count reconciliation. No I/O; the /cotton pages and the
// reports pass already-fetched rows in. Cotton has NO moisture/shrink math —
// weights are plain lbs (seed cotton on loads, lint on bales).

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

/** Lint turnout: lint lbs ÷ seed cotton lbs, %. */
export function lintTurnoutPct(lintLbs: number, seedCottonLbs: number): number | null {
  if (!(seedCottonLbs > 0)) return null
  return round2((lintLbs / seedCottonLbs) * 100)
}

/** Loan value in ¢/lb from the classing sheet's Total Value $: 280.46 / 509 lb → 55.1¢. */
export function loanCentsPerLb(totalValueDollars: number, netWeightLbs: number): number | null {
  if (!(netWeightLbs > 0)) return null
  return round1((totalValueDollars / netWeightLbs) * 100)
}

/** Stated bales_count vs the bale rows actually captured. */
export function reconcileBaleCount(stated: number | null | undefined, actual: number): {
  ok: boolean
  message: string | null
} {
  if (stated == null) return { ok: true, message: null }
  if (stated === actual) return { ok: true, message: null }
  return {
    ok: false,
    message: `Receipt states ${stated} bale${stated === 1 ? '' : 's'} but ${actual} bale row${actual === 1 ? ' was' : 's were'} captured — review before saving.`,
  }
}

// ---------- Bale ↔ grade matching ----------

export type BaleLite = { id: string; pbi_number: string; net_weight_lbs: number }

const normPbi = (s: string) => s.trim().replace(/^0+(?=\d)/, '').toUpperCase()

export type GradeMatch<T> = {
  matched: Array<{ row: T; bale: BaleLite; weightMismatch: boolean }>
  unmatched: T[]
}

/**
 * Match grade rows to bales by PBI number (leading zeros ignored). NetWt is
 * cross-checked against the bale's receipt net weight — >1% difference flags
 * the pair (the classing office weighs independently). Farm/Field columns are
 * corroboration only, never the join key.
 */
export function matchGradesToBales<T extends { pbi_number: string; net_weight_lbs: number | null }>(
  rows: readonly T[],
  bales: readonly BaleLite[],
): GradeMatch<T> {
  const byPbi = new Map(bales.map((b) => [normPbi(b.pbi_number), b]))
  const matched: GradeMatch<T>['matched'] = []
  const unmatched: T[] = []
  for (const row of rows) {
    const bale = byPbi.get(normPbi(row.pbi_number))
    if (!bale) { unmatched.push(row); continue }
    const weightMismatch =
      row.net_weight_lbs != null && bale.net_weight_lbs > 0
        ? Math.abs(row.net_weight_lbs - bale.net_weight_lbs) / bale.net_weight_lbs > 0.01
        : false
    matched.push({ row, bale, weightMismatch })
  }
  return { matched, unmatched }
}

// ---------- Yard inventory + lbs/acre yields ----------

export type CottonLoadLite = { id: string; field_id: string | null; net_weight: number | null }
export type GinReceiptLite = {
  id: string
  field_id: string | null
  total_seed_cotton_weight: number | null
  total_bale_weight: number | null
  bales_count: number | null
}
export type CottonBaleLite = { gin_receipt_id: string; net_weight_lbs: number }

/** Seed cotton lbs delivered but not on any gin receipt, per field. */
export function yardInventoryByField(
  loads: readonly CottonLoadLite[],
  ginnedLoadIds: ReadonlySet<string>,
): Map<string | null, number> {
  const out = new Map<string | null, number>()
  for (const l of loads) {
    if (ginnedLoadIds.has(l.id)) continue
    const key = l.field_id ?? null
    out.set(key, (out.get(key) ?? 0) + Number(l.net_weight ?? 0))
  }
  return out
}

export type CottonFieldYield = {
  fieldId: string
  plantedAcres: number
  receipts: number
  bales: number
  lintLbs: number
  seedCottonLbs: number
  lintPerAcre: number | null // lbs lint / planted acre
  seedPerAcre: number | null
  turnoutPct: number | null
  /** Delivered but not yet ginned — the "on yard awaiting gin" figure. */
  yardSeedLbs: number
  /** complete = has receipts, nothing on the yard; in_progress = yard loads exist. */
  status: 'complete' | 'in_progress' | 'unharvested'
}

/**
 * Per-field cotton yields: lint lbs/acre = Σ bale net weights of the field's
 * receipts ÷ planted acres (falling back to a receipt's stated
 * total_bale_weight when its bale rows aren't captured), with seed cotton
 * lbs/ac and lint turnout % as companions. A field with receipts and an empty
 * yard is harvest-complete; loads on the yard mark it in-progress.
 */
export function cottonFieldYields(args: {
  fields: ReadonlyArray<{ fieldId: string; plantedAcres: number }>
  receipts: readonly GinReceiptLite[]
  bales: readonly CottonBaleLite[]
  loads: readonly CottonLoadLite[]
  ginnedLoadIds: ReadonlySet<string>
}): CottonFieldYield[] {
  const baleAgg = new Map<string, { lbs: number; count: number }>()
  for (const b of args.bales) {
    const a = baleAgg.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    a.lbs += Number(b.net_weight_lbs)
    a.count += 1
    baleAgg.set(b.gin_receipt_id, a)
  }
  const yard = yardInventoryByField(args.loads, args.ginnedLoadIds)
  return args.fields.map((f) => {
    const fieldReceipts = args.receipts.filter((r) => r.field_id === f.fieldId)
    let lintLbs = 0
    let seedCottonLbs = 0
    let bales = 0
    for (const r of fieldReceipts) {
      const agg = baleAgg.get(r.id)
      lintLbs += agg && agg.lbs > 0 ? agg.lbs : Number(r.total_bale_weight ?? 0)
      bales += agg && agg.count > 0 ? agg.count : Number(r.bales_count ?? 0)
      seedCottonLbs += Number(r.total_seed_cotton_weight ?? 0)
    }
    const yardSeedLbs = yard.get(f.fieldId) ?? 0
    const hasAnyLoads = args.loads.some((l) => l.field_id === f.fieldId)
    const status: CottonFieldYield['status'] =
      yardSeedLbs > 0 ? 'in_progress'
      : fieldReceipts.length > 0 ? 'complete'
      : hasAnyLoads ? 'complete' // all loads ginned even without a field-linked receipt shape
      : 'unharvested'
    return {
      fieldId: f.fieldId,
      plantedAcres: f.plantedAcres,
      receipts: fieldReceipts.length,
      bales,
      lintLbs: round1(lintLbs),
      seedCottonLbs: round1(seedCottonLbs),
      lintPerAcre: f.plantedAcres > 0 && lintLbs > 0 ? round1(lintLbs / f.plantedAcres) : null,
      seedPerAcre: f.plantedAcres > 0 && seedCottonLbs > 0 ? round1(seedCottonLbs / f.plantedAcres) : null,
      turnoutPct: lintTurnoutPct(lintLbs, seedCottonLbs),
      yardSeedLbs: round1(yardSeedLbs),
      status,
    }
  })
}
