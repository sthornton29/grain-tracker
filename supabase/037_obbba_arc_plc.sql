-- 037_obbba_arc_plc.sql
-- Post-OBBBA ARC/PLC engine data (2025–2031 program rules):
--   1. program_year_config gains the parameters OBBBA changed so they're data,
--      not code: ARC guarantee % (86%→90%), ARC payment cap % (10%→12%), the
--      ERP Olympic factor (85%→88%), the ERP cap (115%), and the base-acre
--      payment factors (85% ARC-CO/PLC, 65% ARC-IC).
--   2. covered_commodities: OBBBA statutory reference prices (2025–2031 crop
--      years) and the raised national loan rates, plus per-commodity MYA
--      estimation defaults (futures→farm-price basis adjustment and monthly
--      marketing weights).
--   3. arc_benchmark_data — FSA-published ARC-CO benchmark price & county
--      benchmark yield per commodity × crop year (× county when county-level),
--      with the persisted "county yield vs benchmark %" expectation.
--   4. mya_monthly_prices — USDA/NASS monthly average farm prices as they're
--      published through the marketing year, feeding the MYA blend estimate.
--   5. arc_plc_price_data: WASDE midpoint override column, a derivation note,
--      and 'wasde' as a source; seed the FSA-published 2025/2026 effective
--      reference prices.
-- Idempotent.

create extension if not exists "pgcrypto";

-- 1. Per-year OBBBA program parameters -----------------------------------------

alter table public.program_year_config
  add column if not exists arc_guarantee_pct     numeric(4,3) not null default 0.900,
  add column if not exists arc_payment_cap_pct   numeric(4,3) not null default 0.120,
  add column if not exists erp_olympic_factor    numeric(4,3) not null default 0.880,
  add column if not exists erp_cap_pct           numeric(4,3) not null default 1.150,
  add column if not exists payment_factor        numeric(5,4) not null default 0.8500,
  add column if not exists arc_ic_payment_factor numeric(5,4) not null default 0.6500;

-- Seed 2025 (first OBBBA year). Existing 2026/2027 rows pick up the new columns'
-- post-OBBBA defaults automatically. Historical (pre-2025) years fall back to
-- pre-OBBBA built-ins in lib/program-config.ts unless a row is created.
insert into public.program_year_config
  (crop_year, sco_trigger, per_person_payment_limit, sequestration_pct, notes)
values
  (2025, 0.860, 155000, 0.0540,
    'First OBBBA crop year: ARC guarantee 90%, cap 12%, ERP factor 88%. FSA pays the higher of ARC/PLC automatically for 2025 only.')
on conflict (crop_year) do nothing;

-- 2. covered_commodities: OBBBA statutory reference prices & loan rates ---------
-- Reference prices are the OBBBA 2025–2031 statutory values (FSA reference
-- price file; corn $4.10, soybeans $10.00, wheat $6.35, seed cotton $0.42/lb).
-- Loan rates are the OBBBA-raised national loan rates effective 2026+
-- (corn $2.42, soybeans $6.82, wheat $3.72). Seed cotton keeps the $0.25
-- statutory value used in its effective-price floor.
update public.covered_commodities as cc
set statutory_reference_price = v.ref,
    national_loan_rate        = v.loan
from (values
  ('Corn',          4.10::numeric,   2.42::numeric),
  ('Soybeans',      10.00::numeric,  6.82::numeric),
  ('Wheat',         6.35::numeric,   3.72::numeric),
  ('Seed Cotton',   0.42::numeric,   0.25::numeric),
  ('Grain Sorghum', 4.40::numeric,   2.42::numeric),
  ('Oats',          2.65::numeric,   2.20::numeric),
  ('Barley',        5.45::numeric,   2.75::numeric),
  ('Peanuts',       0.315::numeric,  0.195::numeric)
) as v(name, ref, loan)
where cc.name = v.name;

-- Per-commodity MYA estimation defaults. mya_basis_adj is the typical national
-- futures-to-farm-price adjustment (added to the futures quote; negative =
-- farm price under futures). mya_month_weights is a 12-element JSON array of
-- marketing weights aligned to the marketing year's months (heavier Oct–Jan
-- for corn/soy harvest marketings); null = the built-in default in
-- lib/mya-estimate.ts. Both are user-editable in Settings.
alter table public.covered_commodities
  add column if not exists mya_basis_adj     numeric(8,4),
  add column if not exists mya_month_weights jsonb;

update public.covered_commodities as cc
set mya_basis_adj = v.adj
from (values
  ('Corn',     -0.35::numeric),
  ('Soybeans', -0.60::numeric),
  ('Wheat',    -0.45::numeric)
) as v(name, adj)
where cc.name = v.name and cc.mya_basis_adj is null;

-- 3. ARC-CO benchmark data ------------------------------------------------------
-- One row per commodity × crop year, optionally per county (county null = the
-- default row used when no county-specific row exists). benchmark_price and
-- benchmark_yield are the FSA-published values (or manual/AI-filled);
-- county_yield_vs_benchmark_pct persists the user's mid-season expectation of
-- the county's actual yield relative to benchmark (−30..+30, 0 = at benchmark).
create table if not exists public.arc_benchmark_data (
  id uuid primary key default gen_random_uuid(),
  commodity_id uuid not null references public.covered_commodities(id) on delete cascade,
  crop_year integer not null,
  county text,
  benchmark_price numeric(12,6),
  benchmark_yield numeric(12,2),
  price_source text not null default 'manual' check (price_source in ('usda', 'manual', 'ai')),
  yield_source text not null default 'manual' check (yield_source in ('usda', 'manual', 'ai')),
  county_yield_vs_benchmark_pct numeric(6,2) not null default 0,
  -- For AI-filled rows: where the AI said the numbers came from.
  source_description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Unique per commodity × year × county, treating null county as its own key.
create unique index if not exists arc_benchmark_data_key_idx
  on public.arc_benchmark_data(commodity_id, crop_year, coalesce(county, ''));
create index if not exists arc_benchmark_data_year_idx on public.arc_benchmark_data(crop_year);

drop trigger if exists arc_benchmark_data_set_updated_at on public.arc_benchmark_data;
create trigger arc_benchmark_data_set_updated_at
  before update on public.arc_benchmark_data
  for each row execute function public.set_updated_at();

-- Seed the FSA-published national ARC benchmark prices for 2025 and 2026
-- (identical both years): corn $5.03, soybeans $12.17, wheat $6.98. County
-- benchmark yields are county-specific — entered in Settings or AI-filled.
insert into public.arc_benchmark_data (commodity_id, crop_year, county, benchmark_price, price_source)
select cc.id, v.yr, null, v.price, 'usda'
from (values
  ('Corn',     2025, 5.03::numeric),
  ('Corn',     2026, 5.03::numeric),
  ('Soybeans', 2025, 12.17::numeric),
  ('Soybeans', 2026, 12.17::numeric),
  ('Wheat',    2025, 6.98::numeric),
  ('Wheat',    2026, 6.98::numeric)
) as v(name, yr, price)
join public.covered_commodities cc on cc.name = v.name
on conflict do nothing;

-- 4. Monthly MYA prices ----------------------------------------------------------
-- USDA/NASS monthly national average farm prices, entered as published through
-- the marketing year. month is the CALENDAR month (1–12); crop_year labels the
-- marketing year (2026 corn = Sep 2026 – Aug 2027).
create table if not exists public.mya_monthly_prices (
  id uuid primary key default gen_random_uuid(),
  commodity_id uuid not null references public.covered_commodities(id) on delete cascade,
  crop_year integer not null,
  month integer not null check (month between 1 and 12),
  price numeric(12,6) not null,
  source text not null default 'manual' check (source in ('usda', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (commodity_id, crop_year, month)
);
create index if not exists mya_monthly_prices_year_idx on public.mya_monthly_prices(crop_year);

drop trigger if exists mya_monthly_prices_set_updated_at on public.mya_monthly_prices;
create trigger mya_monthly_prices_set_updated_at
  before update on public.mya_monthly_prices
  for each row execute function public.set_updated_at();

-- 5. arc_plc_price_data: WASDE override + derivation note + published ERPs ------

alter table public.arc_plc_price_data
  add column if not exists wasde_midpoint numeric(12,6),
  add column if not exists mya_note text;

-- Allow 'wasde' as a source (the check constraint predates it).
alter table public.arc_plc_price_data drop constraint if exists arc_plc_price_data_source_check;
alter table public.arc_plc_price_data
  add constraint arc_plc_price_data_source_check
  check (source in ('manual', 'barchart', 'usda', 'wasde'));

-- Seed the FSA-published effective reference prices for 2025/2026 (identical
-- both years): corn $4.42, soybeans $10.71, wheat $6.35. Published values are
-- authoritative, so an existing ERP is overwritten; MYA fields are untouched.
insert into public.arc_plc_price_data (commodity_id, crop_year, effective_reference_price, source)
select cc.id, v.yr, v.erp, 'usda'
from (values
  ('Corn',     2025, 4.42::numeric),
  ('Corn',     2026, 4.42::numeric),
  ('Soybeans', 2025, 10.71::numeric),
  ('Soybeans', 2026, 10.71::numeric),
  ('Wheat',    2025, 6.35::numeric),
  ('Wheat',    2026, 6.35::numeric)
) as v(name, yr, erp)
join public.covered_commodities cc on cc.name = v.name
on conflict (commodity_id, crop_year) do update
  set effective_reference_price = excluded.effective_reference_price;

-- 6. RLS ------------------------------------------------------------------------

alter table public.arc_benchmark_data enable row level security;
alter table public.mya_monthly_prices enable row level security;

do $$
declare t text;
begin
  foreach t in array array['arc_benchmark_data', 'mya_monthly_prices'] loop
    execute format('drop policy if exists "authed all" on public.%I', t);
    execute format(
      'create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
