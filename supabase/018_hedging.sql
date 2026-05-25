-- Grain Tracker — Hedging: commodity futures positions, contract specs, and
-- end-of-day market price cache (Barchart OnDemand).
-- Idempotent.

create extension if not exists "pgcrypto";

-- 1. Contract specifications (reference data). One row per tradeable commodity.
create table if not exists public.commodity_specs (
  id uuid primary key default gen_random_uuid(),
  commodity text not null unique,            -- 'Corn', 'Soybeans', 'Chicago Wheat'
  symbol text not null,                      -- root futures symbol, e.g. 'ZC'
  exchange text not null,                     -- e.g. 'CBOT'
  contract_size_bu integer not null,          -- bushels per contract, e.g. 5000
  tick_size_cents numeric(8,4) not null,      -- minimum price move in cents/bu, e.g. 0.25
  tick_value_usd numeric(10,2) not null,      -- $ value of one tick, e.g. 12.50
  contract_months text not null,              -- CSV of month codes, e.g. 'H,K,N,U,Z'
  created_at timestamptz not null default now()
);

-- Seed / refresh the three commodities we trade.
insert into public.commodity_specs
  (commodity, symbol, exchange, contract_size_bu, tick_size_cents, tick_value_usd, contract_months)
values
  ('Corn',          'ZC', 'CBOT', 5000, 0.25, 12.50, 'H,K,N,U,Z'),
  ('Soybeans',      'ZS', 'CBOT', 5000, 0.25, 12.50, 'F,H,K,N,Q,U,X'),
  ('Chicago Wheat', 'ZW', 'CBOT', 5000, 0.25, 12.50, 'H,K,N,U,Z')
on conflict (commodity) do update set
  symbol           = excluded.symbol,
  exchange         = excluded.exchange,
  contract_size_bu = excluded.contract_size_bu,
  tick_size_cents  = excluded.tick_size_cents,
  tick_value_usd   = excluded.tick_value_usd,
  contract_months  = excluded.contract_months;

-- 2. Individual futures position entries.
create table if not exists public.futures_positions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete restrict,
  commodity text not null references public.commodity_specs(commodity) on delete restrict,
  contract_month text not null,               -- e.g. 'DEC 26', 'JUL 27'
  contract_symbol text not null,              -- e.g. 'ZCZ26' (app-generated)
  crop_year integer not null,                 -- which crop year's production this hedges
  side text not null check (side in ('long', 'short')),
  num_contracts integer not null check (num_contracts > 0),
  trade_price numeric(12,6) not null,         -- dollars per bushel, e.g. 4.932500
  trade_date date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  close_price numeric(12,6),
  close_date date,
  realized_pnl numeric(14,2),                 -- net of commissions, set when closed
  commission numeric(12,2) not null default 0,
  notes text,
  source text not null default 'manual' check (source in ('manual', 'statement_import')),
  created_at timestamptz not null default now()
);

create index if not exists futures_positions_entity_idx    on public.futures_positions(entity_id);
create index if not exists futures_positions_status_idx    on public.futures_positions(status);
create index if not exists futures_positions_symbol_idx     on public.futures_positions(contract_symbol);
create index if not exists futures_positions_crop_year_idx  on public.futures_positions(crop_year);
create index if not exists futures_positions_commodity_idx  on public.futures_positions(commodity);
-- Phase-2 readiness (Part G): hedges link to physical grain contracts on
-- (crop_year, commodity). contracts carry crop_year + crop_id; the crops table
-- maps crop_id -> name, which corresponds to commodity here (Corn/Soybeans/
-- Wheat). This composite index makes that future join cheap. No FK is added
-- now because the match is by name through crops, not a direct column FK.
create index if not exists futures_positions_cropyear_commodity_idx
  on public.futures_positions(crop_year, commodity);

-- 3. End-of-day market price cache. One row per symbol per date so we never
-- re-fetch a price we already have for a given day.
create table if not exists public.market_prices (
  id uuid primary key default gen_random_uuid(),
  contract_symbol text not null,              -- e.g. 'ZCZ26'
  price numeric(12,6) not null,               -- dollars per bushel (converted from cents)
  price_date date not null,
  fetched_at timestamptz not null default now(),
  unique (contract_symbol, price_date)
);

create index if not exists market_prices_symbol_date_idx
  on public.market_prices(contract_symbol, price_date desc);

-- 4. RLS — same authed-all policy as the rest of the app.
alter table public.commodity_specs    enable row level security;
alter table public.futures_positions  enable row level security;
alter table public.market_prices       enable row level security;

do $$
declare t text;
begin
  foreach t in array array['commodity_specs', 'futures_positions', 'market_prices'] loop
    execute format('drop policy if exists "authed all" on public.%I', t);
    execute format(
      'create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
