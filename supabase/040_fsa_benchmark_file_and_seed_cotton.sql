-- 040: FSA benchmark-file cache + unified seed cotton MYA.
--   1. fsa_benchmark_cache — parsed rows from FSA's annual "ARC-County
--      Benchmark Yields and Revenues" Excel workbook, keyed by the file's data
--      year × state × county × commodity × practice. The benchmark-yield
--      lookup reads this cache; fsa.usda.gov is only hit when a lookup misses
--      (and at most daily per year × state — see fsa_benchmark_fetches).
--   2. fsa_benchmark_fetches — a log of page/file checks so a missing county
--      or an unpublished year can't trigger repeated downloads.
--   3. covered_commodities.lint_share / cottonseed_share — configurable seed
--      cotton weight shares (defaults 0.43/0.57 live in code) used to blend
--      the NASS lint + cottonseed series into one seed cotton price.
--   4. mya_monthly_prices.note — component provenance for derived monthly
--      prices (e.g. "lint 68.2¢ + seed $205/ton → 35.17¢ SC").
-- Idempotent.

create extension if not exists "pgcrypto";

-- 1. Parsed FSA benchmark file rows ------------------------------------------
create table if not exists public.fsa_benchmark_cache (
  id uuid primary key default gen_random_uuid(),
  -- The crop year the FILE is for (may be earlier than the requested program
  -- year when FSA hasn't published the requested year yet).
  data_year integer not null,
  state_code text not null,
  -- Normalized: uppercase, no "COUNTY"/"PARISH" suffix, no punctuation.
  county text not null,
  -- Commodity as printed in the file (uppercased); matched fuzzily in code.
  commodity text not null,
  practice text not null default 'all' check (practice in ('irrigated', 'non_irrigated', 'all')),
  benchmark_yield numeric(12,2),
  -- The file also prints the national benchmark price on every row.
  benchmark_price numeric(12,6),
  benchmark_revenue numeric(14,2),
  source_url text,
  fetched_at timestamptz not null default now(),
  unique (data_year, state_code, county, commodity, practice)
);
create index if not exists fsa_benchmark_cache_lookup_idx
  on public.fsa_benchmark_cache(data_year, state_code, county);

-- 2. Fetch log ----------------------------------------------------------------
create table if not exists public.fsa_benchmark_fetches (
  id uuid primary key default gen_random_uuid(),
  requested_year integer not null,
  state_code text not null,
  -- The file year actually found on the FSA page (null = no benchmark file
  -- found for any year ≤ requested).
  file_year integer,
  file_url text,
  checked_at timestamptz not null default now()
);
create index if not exists fsa_benchmark_fetches_idx
  on public.fsa_benchmark_fetches(requested_year, state_code, checked_at desc);

-- 3. Seed cotton weight shares -------------------------------------------------
alter table public.covered_commodities
  add column if not exists lint_share       numeric(6,4),
  add column if not exists cottonseed_share numeric(6,4);

-- 4. Monthly-price component note ----------------------------------------------
alter table public.mya_monthly_prices
  add column if not exists note text;

-- RLS (single-tenant permissive, same as every other table) --------------------
alter table public.fsa_benchmark_cache   enable row level security;
alter table public.fsa_benchmark_fetches enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'fsa_benchmark_cache' and policyname = 'fsa_benchmark_cache_all') then
    create policy fsa_benchmark_cache_all on public.fsa_benchmark_cache
      for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'fsa_benchmark_fetches' and policyname = 'fsa_benchmark_fetches_all') then
    create policy fsa_benchmark_fetches_all on public.fsa_benchmark_fetches
      for all to authenticated using (true) with check (true);
  end if;
end $$;
