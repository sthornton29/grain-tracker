-- Grain Tracker — Payments, settlements, crop year, delivery window.
-- Idempotent.

create extension if not exists "pgcrypto";

-- 1. Crop year on contracts + loads
alter table public.contracts
  add column if not exists crop_year integer;

alter table public.loads
  add column if not exists crop_year integer;

create index if not exists contracts_crop_year_idx on public.contracts(crop_year);
create index if not exists loads_crop_year_idx     on public.loads(crop_year);

-- 2. Delivery window on contracts
alter table public.contracts
  add column if not exists delivery_start_date date;
alter table public.contracts
  add column if not exists delivery_end_date date;

-- 3. Settlements
create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.buyers(id) on delete restrict,
  settlement_date date not null,
  settlement_number text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists settlements_buyer_idx on public.settlements(buyer_id);
create index if not exists settlements_date_idx  on public.settlements(settlement_date desc);

-- 4. Settlement lines — net_revenue and price_per_bushel are generated
create table if not exists public.settlement_lines (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.settlements(id) on delete cascade,
  ticket_number text,
  load_id uuid references public.loads(id) on delete set null,
  net_bushels numeric(12,2) not null default 0,
  gross_revenue numeric(14,2) not null default 0,
  discounts numeric(14,2) not null default 0,
  net_revenue numeric(14,2) generated always as (gross_revenue - coalesce(discounts, 0)) stored,
  price_per_bushel numeric(12,6) generated always as (
    case when net_bushels > 0 then (gross_revenue - coalesce(discounts, 0)) / net_bushels else null end
  ) stored,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists settlement_lines_settlement_idx on public.settlement_lines(settlement_id);
create index if not exists settlement_lines_ticket_idx     on public.settlement_lines(ticket_number);
create index if not exists settlement_lines_load_idx       on public.settlement_lines(load_id);

-- 5. RLS
alter table public.settlements      enable row level security;
alter table public.settlement_lines enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settlements','settlement_lines'] loop
    execute format('drop policy if exists "authed all" on public.%I', t);
    execute format(
      'create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
