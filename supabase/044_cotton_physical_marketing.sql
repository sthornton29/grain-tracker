-- 044: Physical cotton marketing — sales contracts (spot / fixed / on-call /
-- pool), CCC marketing assistance loans with per-bale principal, LDP records,
-- bale dispositions ("where is my cotton"), fees (projected schedule +
-- actuals), and weekly AWP.
--
-- Units: every ¢-suffixed column is CENTS PER POUND (55.00 = 55¢/lb, the app's
-- cotton price convention); every *_total / amount column is DOLLARS.
--
-- Ownership/roles: these are PRODUCER marketing records, not gin intake — gin
-- role is fully blocked (RESTRICTIVE), unlike the 042 cotton intake tables.
--
-- Idempotent: safe to re-run.

-- 1) Sales contracts. Merchants/pools/co-ops are buyers (reuse the table).
create table if not exists public.cotton_sales_contracts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete set null,
  crop_year int not null,
  buyer_id uuid references public.buyers(id) on delete set null,
  contract_type text not null check (contract_type in ('spot','fixed_price','on_call','pool')),
  contract_number text,
  contract_date date,
  commitment_basis text not null default 'bales' check (commitment_basis in ('bales','acres')),
  committed_bales int,
  committed_acres numeric(10,2),
  price_cents_per_lb numeric(8,2),          -- fixed/spot price (¢/lb)
  basis_cents numeric(8,2),                 -- on-call basis vs the futures month (¢/lb, +/-)
  futures_month text,                       -- on-call reference, e.g. 'DEC 26'
  futures_fixed_cents numeric(8,2),         -- set when the on-call futures leg is fixed
  futures_fixed_date date,
  pricing_status text not null default 'fully_priced'
    check (pricing_status in ('fully_priced','awaiting_futures','pool_open')),
  delivery_start date,
  delivery_end date,
  notes text,
  created_at timestamptz not null default now()
);

-- 2) Pool payments ledger (advances / progress / final settlement).
create table if not exists public.cotton_pool_payments (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.cotton_sales_contracts(id) on delete cascade,
  payment_type text not null check (payment_type in ('initial_advance','progress','final_settlement')),
  amount numeric(12,2) not null,
  cents_per_lb_equivalent numeric(8,2),
  payment_date date,
  status text not null default 'received' check (status in ('projected','received')),
  notes text,
  created_at timestamptz not null default now()
);

-- 3) CCC marketing assistance loans — one loan = a bale group entered together.
create table if not exists public.ccc_loans (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete set null,
  crop_year int not null,
  loan_number text,
  entry_date date not null,
  maturity_date date,                       -- app defaults entry + 9 months
  loan_rate_base_cents numeric(8,2) not null, -- schedule base (55.00 for 2026)
  principal_total numeric(12,2) not null default 0, -- Σ per-bale loan values ($)
  -- Per-bale principal comes from cotton_bale_grades.loan_value_cents_per_lb ×
  -- net_weight_lbs. Bales entered before classing use the base rate and this
  -- flag; the app recomputes principal when grades import.
  pending_classing boolean not null default false,
  status text not null default 'open' check (status in ('open','redeemed','equity_sold','forfeited')),
  outcome_date date,
  awp_at_outcome_cents numeric(8,2),
  redemption_payoff_total numeric(12,2),
  equity_cents_per_lb numeric(8,2),
  equity_total numeric(12,2),
  mlg_total numeric(12,2),                  -- marketing loan gain (repay at AWP < loan rate)
  interest_paid numeric(12,2),
  storage_charges_paid numeric(12,2),
  buyer_id uuid references public.buyers(id) on delete set null, -- equity purchaser
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.ccc_loan_bales (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.ccc_loans(id) on delete cascade,
  bale_id uuid not null references public.cotton_bales(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (bale_id)                          -- a bale is on at most one loan, ever
);

-- 4) LDP records. LDP'd bales are loan-INELIGIBLE (and vice versa) — enforced
--    by triggers below plus the app.
create table if not exists public.cotton_ldp_records (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete set null,
  crop_year int not null,
  ldp_date date not null,
  awp_cents numeric(8,2) not null,
  ldp_rate_cents numeric(8,2) not null,     -- loan rate − AWP (zero-floored)
  total_payment numeric(12,2) not null default 0,
  status text not null default 'received' check (status in ('projected','received')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.cotton_ldp_bales (
  id uuid primary key default gen_random_uuid(),
  ldp_id uuid not null references public.cotton_ldp_records(id) on delete cascade,
  bale_id uuid not null references public.cotton_bales(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (bale_id)                          -- a bale takes at most one LDP
);

-- Mutual exclusion: a bale can never be on both a CCC loan and an LDP.
create or replace function public.check_bale_not_ldp() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.cotton_ldp_bales where bale_id = new.bale_id) then
    raise exception 'Bale % already took an LDP — LDP''d bales are loan-ineligible', new.bale_id;
  end if;
  return new;
end $$;

create or replace function public.check_bale_not_loaned() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.ccc_loan_bales where bale_id = new.bale_id) then
    raise exception 'Bale % is (or was) on a CCC loan — loan bales are LDP-ineligible', new.bale_id;
  end if;
  return new;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'ccc_loan_bales_no_ldp') then
    create trigger ccc_loan_bales_no_ldp before insert on public.ccc_loan_bales
      for each row execute function public.check_bale_not_ldp();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'cotton_ldp_bales_no_loan') then
    create trigger cotton_ldp_bales_no_loan before insert on public.cotton_ldp_bales
      for each row execute function public.check_bale_not_loaned();
  end if;
end $$;

-- 5) Bale dispositions — every bale's marketing fate. One row per bale; the
--    app defaults new bales to 'held'. A redeemed loan returns its bales to
--    'held'; an equity-sold loan's bales stay final (merchant owns them).
create table if not exists public.cotton_bale_dispositions (
  id uuid primary key default gen_random_uuid(),
  bale_id uuid not null references public.cotton_bales(id) on delete cascade,
  disposition text not null default 'held'
    check (disposition in ('sold_spot','contract_delivery','pool','ccc_loan','held')),
  contract_id uuid references public.cotton_sales_contracts(id) on delete set null,
  loan_id uuid references public.ccc_loans(id) on delete set null,
  disposition_date date,
  created_at timestamptz not null default now(),
  unique (bale_id)
);

-- 6) Fees — projected (from the schedule below) and actuals.
create table if not exists public.cotton_fees (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete set null,
  crop_year int not null,
  fee_type text not null check (fee_type in
    ('warehouse_receiving','storage_monthly','classing','checkoff','loan_interest',
     'loan_servicing','pool_deduction','merchant_fee','other')),
  basis text not null check (basis in ('per_bale','per_bale_month','pct_of_value','flat')),
  rate numeric(10,4),
  loan_id uuid references public.ccc_loans(id) on delete cascade,
  contract_id uuid references public.cotton_sales_contracts(id) on delete cascade,
  amount_total numeric(12,2) not null,
  status text not null default 'actual' check (status in ('projected','actual')),
  fee_date date,
  notes text,
  created_at timestamptz not null default now()
);

-- Fee schedule (defaults for projected fees; per crop year, single row each).
create table if not exists public.cotton_fee_schedule (
  id uuid primary key default gen_random_uuid(),
  crop_year int not null unique,
  storage_per_bale_month numeric(8,2) not null default 2.85,
  receiving_per_bale numeric(8,2) not null default 6.00,
  classing_per_bale numeric(8,2) not null default 2.20,
  checkoff_per_bale numeric(8,2) not null default 1.00,
  checkoff_supplemental_pct numeric(6,4) not null default 0.005, -- % of value
  loan_interest_apr numeric(6,4) not null default 0.05,
  updated_at timestamptz not null default now()
);

-- 7) Weekly Adjusted World Price (announced Thursdays, effective Fri–Thu).
create table if not exists public.awp_weekly (
  id uuid primary key default gen_random_uuid(),
  week_effective date not null unique,      -- first effective day (Friday)
  awp_cents numeric(8,2) not null,
  source text not null default 'manual' check (source in ('manual','ai')),
  created_at timestamptz not null default now()
);

-- RLS: producer-only (gin blocked entirely), permissive for authenticated.
alter table public.cotton_sales_contracts   enable row level security;
alter table public.cotton_pool_payments     enable row level security;
alter table public.ccc_loans                enable row level security;
alter table public.ccc_loan_bales           enable row level security;
alter table public.cotton_ldp_records       enable row level security;
alter table public.cotton_ldp_bales         enable row level security;
alter table public.cotton_bale_dispositions enable row level security;
alter table public.cotton_fees              enable row level security;
alter table public.cotton_fee_schedule      enable row level security;
alter table public.awp_weekly               enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'cotton_sales_contracts','cotton_pool_payments','ccc_loans','ccc_loan_bales',
    'cotton_ldp_records','cotton_ldp_bales','cotton_bale_dispositions',
    'cotton_fees','cotton_fee_schedule','awp_weekly'
  ] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_all') then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_all', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
  end loop;
end $$;
