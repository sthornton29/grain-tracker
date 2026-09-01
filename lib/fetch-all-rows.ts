// Paginated full read of a Supabase query — the guard against the project's
// silent ~1,000-row-per-request cap. A bare `.select()` LOOKS complete until
// the table crosses 1,000 rows, then quietly returns an arbitrary subset —
// the 2026-09-01 harvest bug: the Yields page dropped 8 of Blythe Big
// South's loads the week the operation crossed 1,000 total loads, and every
// unpaginated loads/splits/settlement-lines consumer degraded the same way.
//
// EVERY query that reads a whole growing table (loads, load_splits,
// settlement_lines, …) must page through it with `.range()` — and the query
// passed here MUST carry a stable `.order()` (usually `.order('id')`, or as
// the final tiebreak after a display order): without one, page boundaries
// can shift between requests and rows get skipped or doubled.
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
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) return { data: out, error }
    const batch = ((data as unknown) as T[]) ?? []
    out.push(...batch)
    if (batch.length < pageSize) break
  }
  return { data: out, error: null }
}
