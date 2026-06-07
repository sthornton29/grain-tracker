-- Grain Tracker — Crop Insurance: individual MPCI policies (RP / RP-HPE / YP),
-- SCO and ECO area endorsements, and a harvest-price discovery cache (projected
-- price, running Barchart estimate, and the RMA-final harvest price).
-- Idempotent.

create extension if not exists "pgcrypto";

-- 1. Individual crop insurance policies. One row per crop × county × crop year
--    (a producer typically carries one plan per crop in a county).
create table if not exists public.crop_insurance_policies (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete set null,
  crop_id uuid not null references public.crops(id) on delete cascade,
  crop_year integer not null,
  county_id uuid references public.counties(id) on delete set null,
  policy_number text,
  plan_type text not null default 'RP'
    check (plan_type in ('RP', 'RP_HPE', 'YP')),
  coverage_level numeric(4,3) not null default 0.800
    check (coverage_level >= 0.500 and coverage_level <= 0.850),
  unit_structure text not null default 'enterprise'
    check (unit_structure in ('enterprise', 'basic', 'optional')),
  aph_yield numeric(10,2) not null default 0,        -- bu/ac
  projected_price numeric(12,6) not null default 0,  -- $/bu (Feb price discovery)
  harvest_price numeric(12,6),                        -- $/bu (Oct final, nullable)
  volatility_factor numeric(6,3),
  insured_acres numeric(12,2) not null default 0,
  premium_per_acre numeric(12,2),                     -- producer-paid, after subsidy
  total_premium numeric(14,2),                         -- premium_per_acre * insured_acres
  premium_subsidy_pct numeric(6,2),                    -- federal subsidy %, reference
  notes text,
  source text not null default 'manual'
    check (source in ('manual', 'document_import')),
  created_at timestamptz not null default now()
);

create index if not exists crop_insurance_policies_crop_year_idx on public.crop_insurance_policies(crop_year);
create index if not exists crop_insurance_policies_crop_idx       on public.crop_insurance_policies(crop_id);
create index if not exists crop_insurance_policies_county_idx     on public.crop_insurance_policies(county_id);
create index if not exists crop_insurance_policies_entity_idx     on public.crop_insurance_policies(entity_id);

-- 2. Supplemental Coverage Option endorsement on an underlying policy. Covers
--    the county-revenue band from the policy's coverage level up to the SCO
--    trigger (0.86 for 2026, rising to 0.90 in 2027).
create table if not exists public.crop_insurance_sco (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.crop_insurance_policies(id) on delete cascade,
  coverage_trigger numeric(4,3) not null default 0.860,
  expected_county_yield numeric(10,2) not null default 0,   -- RMA expected county yield, bu/ac
  county_yield_assumption_pct numeric(6,2) default 0,        -- county vs producer yield, e.g. -10
  premium_per_acre numeric(12,2),
  total_premium numeric(14,2),
  notes text,
  created_at timestamptz not null default now(),
  unique (policy_id)
);

create index if not exists crop_insurance_sco_policy_idx on public.crop_insurance_sco(policy_id);

-- 3. Enhanced Coverage Option endorsement. Covers the band from 0.86 up to the
--    ECO trigger level (0.90 or 0.95).
create table if not exists public.crop_insurance_eco (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.crop_insurance_policies(id) on delete cascade,
  eco_trigger_level numeric(4,3) not null default 0.900
    check (eco_trigger_level in (0.900, 0.950)),
  expected_county_yield numeric(10,2) not null default 0,
  county_yield_assumption_pct numeric(6,2) default 0,
  premium_per_acre numeric(12,2),
  total_premium numeric(14,2),
  notes text,
  created_at timestamptz not null default now(),
  unique (policy_id)
);

create index if not exists crop_insurance_eco_policy_idx on public.crop_insurance_eco(policy_id);

-- 4. Harvest-price discovery cache. Holds the Feb projected price, a running
--    Barchart estimate of the harvest price (refreshed during the season), and
--    the RMA-final harvest price once it's published in late October. One row
--    per (crop, year, price_type, date) so a same-day re-fetch updates in place.
create table if not exists public.harvest_price_estimates (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid not null references public.crops(id) on delete cascade,
  crop_year integer not null,
  price_type text not null
    check (price_type in ('projected', 'harvest_final', 'harvest_estimate')),
  price numeric(12,6) not null,
  source text,                                  -- e.g. 'RMA final', 'Barchart estimate'
  price_date date not null,
  created_at timestamptz not null default now(),
  unique (crop_id, crop_year, price_type, price_date)
);

create index if not exists harvest_price_estimates_lookup_idx
  on public.harvest_price_estimates(crop_id, crop_year, price_type, price_date desc);

-- 5. Seed the 2026 February projected prices (Dec 26 corn, Nov 26 soybeans,
--    Sep 26 Chicago wheat averages). Keyed to the seeded crop rows by name.
insert into public.harvest_price_estimates (crop_id, crop_year, price_type, price, source, price_date)
select c.id, 2026, 'projected', v.price, 'RMA projected', date '2026-02-28'
from (values
  ('Corn',    4.62::numeric),
  ('Soybean', 11.09::numeric),
  ('Wheat',   6.19::numeric)
) as v(name, price)
join public.crops c on c.name = v.name
on conflict (crop_id, crop_year, price_type, price_date)
  do update set price = excluded.price, source = excluded.source;

-- 6. RLS — same authed-all policy as the rest of the app.
alter table public.crop_insurance_policies   enable row level security;
alter table public.crop_insurance_sco         enable row level security;
alter table public.crop_insurance_eco         enable row level security;
alter table public.harvest_price_estimates    enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'crop_insurance_policies', 'crop_insurance_sco', 'crop_insurance_eco', 'harvest_price_estimates'
  ] loop
    execute format('drop policy if exists "authed all" on public.%I', t);
    execute format(
      'create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
