-- Grain Tracker — Hedging: commodity options positions (puts/calls on futures).
-- Rolls up with futures_positions for a combined hedging view.
-- Idempotent.

create extension if not exists "pgcrypto";

create table if not exists public.options_positions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete restrict,
  commodity text not null references public.commodity_specs(commodity) on delete restrict,
  option_type text not null check (option_type in ('call', 'put')),
  side text not null check (side in ('buy', 'sell')),            -- buy = purchased, sell = wrote
  underlying_contract_month text not null,                        -- e.g. 'DEC 26'
  underlying_symbol text not null,                                -- e.g. 'ZCZ26' (app-generated)
  strike_price numeric(12,6) not null,                            -- dollars per bushel, e.g. 4.80
  num_contracts integer not null check (num_contracts > 0),
  premium_cents numeric(10,4) not null,                           -- cents per bushel, e.g. 15.5
  -- premium_cents/100 ($/bu) * contracts * 5,000 bu/contract. All CBOT grains
  -- we trade are 5,000-bu, so the size is constant here.
  premium_total numeric(14,2) generated always as ((premium_cents / 100.0) * num_contracts * 5000) stored,
  trade_date date not null,
  expiration_date date,
  crop_year integer not null,
  status text not null default 'open'
    check (status in ('open', 'closed_offset', 'expired_worthless', 'exercised')),
  close_price_cents numeric(10,4),                                -- closing premium (offset)
  close_date date,
  realized_pnl numeric(14,2),                                     -- set when closed
  commission numeric(12,2) not null default 0,
  -- Manual fallback for current premium when live Barchart options pricing is
  -- unavailable (Part E). cents per bushel.
  manual_current_value_cents numeric(10,4),
  -- When exercised, the futures position this option converted into.
  exercised_position_id uuid references public.futures_positions(id) on delete set null,
  notes text,
  source text not null default 'manual' check (source in ('manual', 'statement_import')),
  created_at timestamptz not null default now()
);

create index if not exists options_positions_entity_idx     on public.options_positions(entity_id);
create index if not exists options_positions_status_idx     on public.options_positions(status);
create index if not exists options_positions_symbol_idx     on public.options_positions(underlying_symbol);
create index if not exists options_positions_crop_year_idx  on public.options_positions(crop_year);
create index if not exists options_positions_commodity_idx  on public.options_positions(commodity);
create index if not exists options_positions_cropyear_commodity_idx
  on public.options_positions(crop_year, commodity);

alter table public.options_positions enable row level security;

do $$
begin
  execute 'drop policy if exists "authed all" on public.options_positions';
  execute 'create policy "authed all" on public.options_positions for all to authenticated using (true) with check (true)';
end $$;
