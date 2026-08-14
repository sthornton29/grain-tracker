-- 064: RMA Price Discovery cache — projected/harvest insurance prices pulled
-- from RMA's public Price Discovery OData service
-- (public-rma.fpac.usda.gov/apps/PriceDiscovery/Services/
--  RevenuePriceDataService.svc/RevenuePrices, CCZero data), cached per
-- commodity year × commodity × state × type × practice × sales-closing date.
-- The fsa_benchmark_cache pattern: a GLOBAL reference table (RMA prices are
-- national facts keyed by state, not tenant data) refreshed lazily on lookup
-- miss — daily while a discovery window is open, weekly otherwise.
-- Idempotent: safe to re-run.

create table if not exists public.rma_price_cache (
  id uuid primary key default gen_random_uuid(),
  commodity_year integer not null,
  -- RMA codes, exactly as the service reports them (corn '0041', soybeans
  -- '0081', wheat '0011', cotton '0021', grain sorghum '0051', …).
  commodity_code text not null,
  commodity_name text not null,
  state_code text not null, -- 2-digit FIPS, e.g. '01' Alabama, '13' Georgia
  state_name text not null,
  type_code integer not null,
  type_name text not null,
  practice_code integer not null,
  practice_name text not null,
  sales_closing_date date,
  projected_price numeric,
  -- RMA statuses verbatim: 'Yet To Start' | 'In Discovery' | 'Released'.
  projected_status text,
  projected_begin_date date,
  projected_end_date date,
  harvest_price numeric,
  harvest_status text,
  harvest_begin_date date,
  harvest_end_date date,
  volatility numeric,
  fetched_at timestamptz not null default now(),
  constraint rma_price_cache_key unique
    (commodity_year, commodity_code, state_code, type_code, practice_code, sales_closing_date)
);

create index if not exists rma_price_cache_lookup_idx
  on public.rma_price_cache (commodity_year, commodity_code, state_code);

alter table public.rma_price_cache enable row level security;

do $$
begin
  -- Global reference reads for everyone signed in; writes only by session'd
  -- owners (the 054 global-table rule — the refresh route runs on the
  -- caller's session, so viewer/agronomist lookups can read but never write).
  if not exists (select 1 from pg_policies where tablename = 'rma_price_cache' and policyname = 'rma_price_cache_read') then
    create policy rma_price_cache_read on public.rma_price_cache for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'rma_price_cache' and policyname = 'rma_price_cache_owner_write') then
    create policy rma_price_cache_owner_write on public.rma_price_cache for insert to authenticated
      with check (auth.uid() is not null and public.app_role() = 'owner');
    create policy rma_price_cache_owner_upd on public.rma_price_cache for update to authenticated
      using (auth.uid() is not null and public.app_role() = 'owner');
    create policy rma_price_cache_owner_del on public.rma_price_cache for delete to authenticated
      using (auth.uid() is not null and public.app_role() = 'owner');
  end if;
end $$;
