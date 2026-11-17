// Paginated full read of a Supabase query — the guard against the project's
// silent ~1,000-row-per-request cap. A bare `.select()` LOOKS complete until
// the table crosses 1,000 rows, then quietly returns an arbitrary subset —
// the 2026-09-01 harvest bug: the Yields page dropped 8 of Blythe Big
// South's loads the week the operation crossed 1,000 total loads, and every
// unpaginated loads/splits/settlement-lines consumer degraded the same way.
//
// EVERY query that reads a whole growing table (loads, load_splits,
// settlement_lines, plantings, positions, the cotton per-bale tables, …)
// must page through it with `.range()` — enforced by the CI gate in
// lib/growing-table-reads.test.ts — and the query passed here MUST carry a
// stable `.order()` (usually `.order('id')`, or as the final tiebreak after
// a display order): without one, page boundaries can shift between requests
// and rows get skipped or doubled.
//
// TERMINATION IS CAP-AGNOSTIC: the loop never assumes the server's cap
// equals `pageSize`. A short page only proves the table is exhausted once
// the server has demonstrated it can return a full page; before that (small
// table, or a server cap LOWER than pageSize — e.g. someone tightening
// db-max-rows) the loop probes on from the next offset and stops only on an
// empty page. A lowered server cap therefore slows the read; it can never
// silently truncate it. Requests always resume at `out.length`, so the loop
// adapts to whatever batch size the server actually serves.
//
// The result is shaped like a Supabase response ({ data, error }) so call
// sites inside a Promise.all destructure exactly as before.

export const SUPABASE_PAGE_SIZE = 1000

type PageError = { message: string } | null
// The builder receives the inclusive range bounds and returns the query
// (Supabase builders are PromiseLike). Typed loosely because PostgREST's
// generated response types vary per select string.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageBuilder = (from: number, to: number) => PromiseLike<{ data: any; error: PageError }>

export async function fetchAllRows<T>(
  build: PageBuilder,
  pageSize = SUPABASE_PAGE_SIZE,
): Promise<{ data: T[]; error: PageError }> {
  const out: T[] = []
  let sawFullPage = false
  for (;;) {
    const from = out.length
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) return { data: out, error }
    const batch = ((data as unknown) as T[]) ?? []
    out.push(...batch)
    if (batch.length === 0) break
    if (batch.length >= pageSize) { sawFullPage = true; continue }
    // Short page: the genuine end only if the server has proven it can fill
    // a page — otherwise its cap may simply be lower than pageSize, so keep
    // probing until an empty page confirms exhaustion.
    if (sawFullPage) break
  }
  return { data: out, error: null }
}

/**
 * The same full read with the pages fetched TOGETHER — for a table known to
 * be big. The cotton per-bale tables are the case: 7,600 bales is eight
 * round trips one after another (about eight seconds on a phone), and every
 * cotton report has to wait for them before it can show a number.
 *
 * `count` asks the server how many rows the query matches (a head-only
 * count, same filters); the pages are then requested at once and stitched in
 * order.
 *
 * It never trusts itself. If the count fails, a page errors, or the rows that
 * come back do not add up to the count (a server cap lower than `pageSize`, a
 * row written between the count and the pages), it falls back to the
 * sequential, cap-agnostic fetchAllRows — slower, never truncated.
 */
export async function fetchAllRowsParallel<T>(
  count: () => PromiseLike<{ count: number | null; error: PageError }>,
  build: PageBuilder,
  pageSize = SUPABASE_PAGE_SIZE,
): Promise<{ data: T[]; error: PageError }> {
  let total: number | null = null
  try {
    const c = await count()
    total = c && !c.error && typeof c.count === 'number' ? c.count : null
  } catch {
    total = null
  }
  // No usable count, or nothing to fetch in parallel: the plain loop decides.
  if (total == null || total <= pageSize) return fetchAllRows<T>(build, pageSize)
  const pages = Math.ceil(total / pageSize)
  const results = await Promise.all(Array.from({ length: pages }, (_, i) => build(i * pageSize, (i + 1) * pageSize - 1)))
  const out: T[] = []
  for (const r of results) {
    if (r.error) return fetchAllRows<T>(build, pageSize)
    out.push(...(((r.data as unknown) as T[]) ?? []))
  }
  if (out.length !== total) return fetchAllRows<T>(build, pageSize)
  return { data: out, error: null }
}
