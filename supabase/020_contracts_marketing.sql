-- Grain Tracker — Physical contract pricing breakdown (forward / HTA / basis)
-- and per-crop-year marketing assumptions for the Marketing dashboard.
-- Idempotent.

create extension if not exists "pgcrypto";

-- 1. Contract pricing breakdown + contract month.
alter table public.contracts add column if not exists contract_month text;
alter table public.contracts add column if not exists contract_type text not null default 'forward'
  check (contract_type in ('forward', 'hta', 'basis'));
alter table public.contracts add column if not exists futures_price numeric(12,6);
alter table public.contracts add column if not exists basis numeric(12,6);
alter table public.contracts add column if not exists cash_price numeric(12,6);
alter table public.contracts add column if not exists service_fee numeric(12,6) not null default 0;
alter table public.contracts add column if not exists futures_set_date date;
alter table public.contracts add column if not exists basis_set_date date;
alter table public.contracts add column if not exists pricing_status text not null default 'fully_priced'
  check (pricing_status in ('fully_priced', 'awaiting_basis', 'awaiting_futures'));

-- Backfill: existing contracts are flat-price forwards. Their price_per_bushel
-- is the cash price. cash_price stays the canonical flat price going forward;
-- the app keeps price_per_bushel in sync so existing readers keep working.
update public.contracts set cash_price = price_per_bushel where cash_price is null and price_per_bushel is not null;

create index if not exists contracts_contract_type_idx   on public.contracts(contract_type);
create index if not exists contracts_pricing_status_idx   on public.contracts(pricing_status);

-- 2. Per-crop, per-year marketing assumptions (Marketing dashboard inputs).
create table if not exists public.crop_assumptions (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid not null references public.crops(id) on delete cascade,
  crop_year integer not null,
  expected_yield numeric(10,2),       -- bu/ac, estimate before/at harvest
  harvest_complete boolean not null default false,
  cost_per_acre numeric(12,2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (crop_id, crop_year)
);

create index if not exists crop_assumptions_crop_year_idx on public.crop_assumptions(crop_year);

alter table public.crop_assumptions enable row level security;

do $$
begin
  execute 'drop policy if exists "authed all" on public.crop_assumptions';
  execute 'create policy "authed all" on public.crop_assumptions for all to authenticated using (true) with check (true)';
end $$;
