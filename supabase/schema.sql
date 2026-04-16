-- Grain Tracker schema
-- Run this in Supabase SQL editor.

create extension if not exists "pgcrypto";

-- Reference tables
create table if not exists public.farms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.fields (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid references public.farms(id) on delete cascade,
  name_or_number text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bins (
  id uuid primary key default gen_random_uuid(),
  name_or_number text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.trucks (
  id uuid primary key default gen_random_uuid(),
  name_or_number text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.buyers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.crops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_moisture_pct numeric(5,2),
  base_lb_per_bushel numeric(6,2),
  created_at timestamptz not null default now()
);

-- Additive for existing deployments.
alter table public.crops add column if not exists base_moisture_pct numeric(5,2);
alter table public.crops add column if not exists base_lb_per_bushel numeric(6,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crops_name_unique') then
    alter table public.crops add constraint crops_name_unique unique (name);
  end if;
end $$;

-- Seed base values per FSA1078 (U. of Arkansas Extension).
insert into public.crops (name, base_moisture_pct, base_lb_per_bushel) values
  ('Corn',    15.5, 56.0),
  ('Soybean', 13.0, 60.0),
  ('Wheat',   13.5, 60.0)
on conflict (name) do update set
  base_moisture_pct  = excluded.base_moisture_pct,
  base_lb_per_bushel = excluded.base_lb_per_bushel;

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  contract_number text not null,
  buyer_id uuid references public.buyers(id) on delete restrict,
  crop_id uuid references public.crops(id) on delete restrict,
  contracted_bushels numeric(12,2) not null default 0,
  price_per_bushel numeric(10,4),
  notes text,
  created_at timestamptz not null default now()
);

-- Loads
create table if not exists public.loads (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  time time,
  truck_id uuid references public.trucks(id) on delete set null,
  crop_id uuid references public.crops(id) on delete set null,
  gross_weight numeric(10,2),
  tare_weight numeric(10,2),
  net_weight numeric(10,2),
  moisture numeric(5,2),
  test_weight numeric(5,2),
  bushels numeric(12,2),
  from_type text check (from_type in ('field','bin')),
  from_field_id uuid references public.fields(id) on delete set null,
  from_bin_id uuid references public.bins(id) on delete set null,
  to_type text check (to_type in ('bin','buyer')),
  to_bin_id uuid references public.bins(id) on delete set null,
  to_buyer_id uuid references public.buyers(id) on delete set null,
  contract_id uuid references public.contracts(id) on delete set null,
  ticket_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists loads_date_idx on public.loads(date desc);
create index if not exists loads_crop_idx on public.loads(crop_id);
create index if not exists loads_contract_idx on public.loads(contract_id);
create index if not exists loads_from_bin_idx on public.loads(from_bin_id);
create index if not exists loads_to_bin_idx on public.loads(to_bin_id);

-- Trigger to keep updated_at fresh on loads
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists loads_set_updated_at on public.loads;
create trigger loads_set_updated_at
  before update on public.loads
  for each row execute function public.set_updated_at();

-- RLS: any authenticated user can read/write everything.
alter table public.farms     enable row level security;
alter table public.fields    enable row level security;
alter table public.bins      enable row level security;
alter table public.trucks    enable row level security;
alter table public.buyers    enable row level security;
alter table public.crops     enable row level security;
alter table public.contracts enable row level security;
alter table public.loads     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['farms','fields','bins','trucks','buyers','crops','contracts','loads'] loop
    execute format('drop policy if exists "authed all" on public.%I', t);
    execute format(
      'create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
