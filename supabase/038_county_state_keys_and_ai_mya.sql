-- 038: ARC-CO benchmarks key on county + state, and AI-filled monthly MYA prices.

-- 1. arc_benchmark_data.county_id ---------------------------------------------
-- County names repeat across states (30+ Washington Counties), so benchmark
-- rows key on counties.id — which carries the state — instead of the bare
-- name. The legacy county text column stays for display and for old rows that
-- cannot be backfilled unambiguously.
alter table public.arc_benchmark_data
  add column if not exists county_id uuid references public.counties(id);

-- Backfill county_id from the stored name where that name is unambiguous
-- nationwide; ambiguous names stay legacy (county_id null) until re-picked.
update public.arc_benchmark_data b
set county_id = c.id
from public.counties c
where b.county_id is null
  and b.county is not null
  and lower(trim(b.county)) = lower(c.name)
  and (select count(*) from public.counties c2 where lower(c2.name) = lower(trim(b.county))) = 1;

-- Re-key uniqueness on commodity × year × county_id. Rows without a county_id
-- (the county-null default row and un-backfilled legacy rows) keep the old
-- name-based key so they can't collide with each other or with keyed rows.
drop index if exists arc_benchmark_data_key_idx;
create unique index if not exists arc_benchmark_data_county_key_idx
  on public.arc_benchmark_data(commodity_id, crop_year, county_id)
  where county_id is not null;
create unique index if not exists arc_benchmark_data_legacy_key_idx
  on public.arc_benchmark_data(commodity_id, crop_year, coalesce(county, ''))
  where county_id is null;

-- 2. mya_monthly_prices.source gains 'ai' --------------------------------------
-- 'ai' = confirmed from the USDA monthly-price AI lookup; 'manual' = typed by
-- the operator (including an AI value the operator edited before confirming);
-- 'usda' remains valid for rows saved before this migration.
alter table public.mya_monthly_prices
  drop constraint if exists mya_monthly_prices_source_check;
alter table public.mya_monthly_prices
  add constraint mya_monthly_prices_source_check check (source in ('usda', 'manual', 'ai'));
