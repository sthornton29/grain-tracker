// Who was PAID for a farm's government payments in a program year (0099).
//
// Payments used to roll up through farms.entity_id — the farm's CURRENT
// entity — so a program year earned under a previous operator (Martin Farm
// was the payee for program year 2025; View Celeste / Two Seasons took the
// same farms over for 2026) landed on the wrong entity in every report.
// farm_program_payees holds the explicit payee per farm × program year;
// payeeEntityFor is the ONE rule: an explicit row wins, else the farm's
// entity. Every consumer — the Tracker (matrix, per-farm Entity column,
// payment limits, entity filter), Cash Flow, Revenue Projections, Income
// Sensitivity, Ask Turnrow, the partner API and the exports — resolves the
// entity through here, never through farms.entity_id directly.
//
// Pure (no I/O): callers pass the fetched payee rows in.

export type PayeeRowLike = { farm_id: string; program_year: number; entity_id: string }
export type PayeeFarmLike = { id: string; entity_id: string | null }

/** Fast lookups over the payee rows: `${farmId}|${programYear}` → entity id. */
export type PayeeIndex = {
  byKey: ReadonlyMap<string, string>
  /** The program years that have at least one explicit row. */
  years: ReadonlySet<number>
}

export function indexPayees(rows: ReadonlyArray<PayeeRowLike>): PayeeIndex {
  const byKey = new Map<string, string>()
  const years = new Set<number>()
  for (const r of rows) {
    byKey.set(`${r.farm_id}|${r.program_year}`, r.entity_id)
    years.add(r.program_year)
  }
  return { byKey, years }
}

/**
 * The entity paid for `farm` in `programYear`: the explicit payee row when
 * one exists, else the farm's current entity (null when the farm has none).
 */
export function payeeEntityFor(
  farm: PayeeFarmLike | null | undefined,
  programYear: number,
  payees: PayeeIndex | ReadonlyArray<PayeeRowLike>,
): string | null {
  if (!farm) return null
  const idx = Array.isArray(payees) ? indexPayees(payees as PayeeRowLike[]) : (payees as PayeeIndex)
  return idx.byKey.get(`${farm.id}|${programYear}`) ?? farm.entity_id ?? null
}

/** True when the program year's payee is an explicit row (not the farm's entity). */
export function hasExplicitPayee(farmId: string, programYear: number, payees: PayeeIndex): boolean {
  return payees.byKey.has(`${farmId}|${programYear}`)
}

/**
 * The farms re-keyed to their program-year payee — the shape
 * lib/entity-scope buildEntityScope takes, so an entity filter / viewer
 * grant on ARC/PLC rows follows the payee for THAT program year.
 */
export function farmsAsPayees<T extends PayeeFarmLike>(
  farms: ReadonlyArray<T>,
  programYear: number,
  payees: PayeeIndex,
): Array<Omit<T, 'entity_id'> & { entity_id: string | null }> {
  return farms.map((f) => ({ ...f, entity_id: payeeEntityFor(f, programYear, payees) }))
}

/**
 * The statement-vs-Turnrow payee notice behind the upload review: for every
 * paid farm × program year, the entity Turnrow has (through payeeEntityFor)
 * against the entity the statement names. Returns the farms whose payee
 * differs, grouped by program year, so the review can say "This statement
 * paid MARTIN FARM for program year 2025 on 23 farms. Turnrow has View
 * Celeste / Two Seasons." and offer the one-click fix.
 */
export type PayeeMismatch = {
  programYear: number
  farmIds: string[]
  /** Distinct Turnrow entity ids currently resolved for those farms (null = none). */
  turnrowEntityIds: Array<string | null>
}

export function payeeMismatches(args: {
  lines: ReadonlyArray<{ farm_id: string | null; program_year: number | null }>
  statementEntityId: string | null
  farms: ReadonlyArray<PayeeFarmLike>
  payees: PayeeIndex
}): PayeeMismatch[] {
  if (!args.statementEntityId) return []
  const farmById = new Map(args.farms.map((f) => [f.id, f]))
  const byYear = new Map<number, Map<string, string | null>>()
  for (const l of args.lines) {
    if (!l.farm_id || l.program_year == null) continue
    const farm = farmById.get(l.farm_id)
    if (!farm) continue
    const current = payeeEntityFor(farm, l.program_year, args.payees)
    if (current === args.statementEntityId) continue
    let m = byYear.get(l.program_year)
    if (!m) { m = new Map(); byYear.set(l.program_year, m) }
    m.set(l.farm_id, current)
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([programYear, m]) => ({
      programYear,
      farmIds: [...m.keys()],
      turnrowEntityIds: [...new Set(m.values())],
    }))
}
