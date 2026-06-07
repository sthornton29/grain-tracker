-- Grain Tracker — Government payments: FSA base acres & PLC yields, ARC/PLC
-- elections and payment projections, MYA/reference price data, other USDA
-- payments, and per-entity payment-limit tracking.
-- Idempotent.

create extension if not exists "pgcrypto";

-- 1. Covered commodities — FSA program crops eligible for ARC/PLC. Separate from
--    the crops table because base acres can exist for commodities the producer
--    doesn't physically grow in the app.
create table if not exists public.covered_commodities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  crop_id uuid references public.crops(id) on delete set null,
  statutory_reference_price numeric(12,6) not null default 0,
  unit text not null default 'bushel' check (unit in ('bushel', 'pound')),
  national_loan_rate numeric(12,6) not null default 0,
  marketing_year_start_month integer not null default 9 check (marketing_year_start_month between 1 and 12),
  marketing_year_end_month integer not null default 8 check (marketing_year_end_month between 1 and 12),
  created_at timestamptz not null default now()
);

-- Seed the OBBBA reference prices. crop_id is linked to the app's crop by name
-- where one exists (Corn/Soybeans→Soybean/Wheat); other commodities stay null.
insert into public.covered_commodities
  (name, crop_id, statutory_reference_price, unit, national_loan_rate, marketing_year_start_month, marketing_year_end_month)
select v.name,
  (select c.id from public.crops c where lower(c.name) = lower(v.crop_match) limit 1),
  v.ref, v.unit, v.loan, v.mstart, v.mend
from (values
  ('Corn',          'Corn',    4.26::numeric,   'bushel', 2.20::numeric,   9, 8),
  ('Soybeans',      'Soybean', 9.26::numeric,   'bushel', 6.20::numeric,   9, 8),
  ('Wheat',         'Wheat',   5.50::numeric,   'bushel', 3.38::numeric,   6, 5),
  ('Seed Cotton',   '',        0.367::numeric,  'pound',  0.25::numeric,   8, 7),
  ('Grain Sorghum', '',        3.95::numeric,   'bushel', 2.20::numeric,   9, 8),
  ('Oats',          '',        2.40::numeric,   'bushel', 2.00::numeric,   6, 5),
  ('Barley',        '',        4.95::numeric,   'bushel', 2.50::numeric,   6, 5),
  ('Peanuts',       '',        0.2675::numeric, 'pound',  0.1775::numeric, 8, 7)
) as v(name, crop_match, ref, unit, loan, mstart, mend)
on conflict (name) do update set
  statutory_reference_price  = excluded.statutory_reference_price,
  unit                       = excluded.unit,
  national_loan_rate         = excluded.national_loan_rate,
  marketing_year_start_month = excluded.marketing_year_start_month,
  marketing_year_end_month   = excluded.marketing_year_end_month,
  crop_id                    = coalesce(public.covered_commodities.crop_id, excluded.crop_id);

-- 2. Base acres + PLC yields per farm per commodity.
create table if not exists public.farm_base_acres (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  commodity_id uuid not null references public.covered_commodities(id) on delete cascade,
  base_acres numeric(12,2) not null default 0,
  plc_yield numeric(12,2) not null default 0,
  source text not null default 'manual' check (source in ('manual', 'document_import')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, commodity_id)
);
create index if not exists farm_base_acres_farm_idx      on public.farm_base_acres(farm_id);
create index if not exists farm_base_acres_commodity_idx on public.farm_base_acres(commodity_id);

-- 3. ARC/PLC program election per farm per commodity per year.
create table if not exists public.arc_plc_elections (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  commodity_id uuid not null references public.covered_commodities(id) on delete cascade,
  crop_year integer not null,
  election text not null default 'PLC' check (election in ('PLC', 'ARC_CO', 'ARC_IC')),
  created_at timestamptz not null default now(),
  unique (farm_id, commodity_id, crop_year)
);
create index if not exists arc_plc_elections_year_idx on public.arc_plc_elections(crop_year);

-- 4. MYA + effective reference prices by commodity by year.
create table if not exists public.arc_plc_price_data (
  id uuid primary key default gen_random_uuid(),
  commodity_id uuid not null references public.covered_commodities(id) on delete cascade,
  crop_year integer not null,
  effective_reference_price numeric(12,6),
  mya_price_estimate numeric(12,6),
  mya_price_final numeric(12,6),
  source text not null default 'manual' check (source in ('manual', 'barchart', 'usda')),
  updated_at timestamptz not null default now(),
  unique (commodity_id, crop_year)
);
create index if not exists arc_plc_price_data_year_idx on public.arc_plc_price_data(crop_year);

-- 5. Projected / actual ARC/PLC payment amounts per farm per commodity per year.
create table if not exists public.arc_plc_payments (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  commodity_id uuid not null references public.covered_commodities(id) on delete cascade,
  crop_year integer not null,
  election text not null default 'PLC' check (election in ('PLC', 'ARC_CO', 'ARC_IC')),
  base_acres numeric(12,2) not null default 0,
  plc_yield numeric(12,2) not null default 0,
  payment_rate_per_unit numeric(12,6) not null default 0,
  gross_payment numeric(14,2) not null default 0,
  payment_factor numeric(5,4) not null default 0.85,
  sequestration_pct numeric(6,4) not null default 0.054,
  net_payment numeric(14,2) not null default 0,
  payment_status text not null default 'projected' check (payment_status in ('projected', 'confirmed', 'received')),
  expected_payment_date date,
  actual_payment_date date,
  actual_payment_amount numeric(14,2),
  notes text,
  created_at timestamptz not null default now(),
  unique (farm_id, commodity_id, crop_year)
);
create index if not exists arc_plc_payments_year_idx on public.arc_plc_payments(crop_year);
create index if not exists arc_plc_payments_farm_idx on public.arc_plc_payments(farm_id);

-- 6. Other USDA payments (conservation, disaster, ad-hoc) entered manually.
create table if not exists public.other_government_payments (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete set null,
  program_name text not null,
  crop_year integer not null,
  crop_id uuid references public.crops(id) on delete set null,
  farm_id uuid references public.farms(id) on delete set null,
  amount numeric(14,2) not null default 0,
  payment_date date,
  payment_status text not null default 'projected' check (payment_status in ('projected', 'confirmed', 'received')),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists other_gov_payments_year_idx   on public.other_government_payments(crop_year);
create index if not exists other_gov_payments_entity_idx on public.other_government_payments(entity_id);

-- 7. Per-entity, per-year payment-limit configuration.
create table if not exists public.payment_limit_config (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  crop_year integer not null,
  eligible_persons integer not null default 1,
  per_person_limit numeric(14,2) not null default 155000,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, crop_year)
);
create index if not exists payment_limit_config_year_idx on public.payment_limit_config(crop_year);

-- 8. RLS — same authed-all policy as the rest of the app.
alter table public.covered_commodities        enable row level security;
alter table public.farm_base_acres            enable row level security;
alter table public.arc_plc_elections          enable row level security;
alter table public.arc_plc_price_data         enable row level security;
alter table public.arc_plc_payments           enable row level security;
alter table public.other_government_payments  enable row level security;
alter table public.payment_limit_config        enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'covered_commodities', 'farm_base_acres', 'arc_plc_elections', 'arc_plc_price_data',
    'arc_plc_payments', 'other_government_payments', 'payment_limit_config'
  ] loop
    execute format('drop policy if exists "authed all" on public.%I', t);
    execute format(
      'create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
