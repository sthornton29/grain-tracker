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
