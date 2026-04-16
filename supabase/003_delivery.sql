-- Grain Tracker — Delivery locations + contract delivery type
-- Idempotent: safe to re-run in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- 1. Delivery locations (one buyer can have many)
create table if not exists public.delivery_locations (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.buyers(id) on delete cascade,
  name text not null,
  address text,
  created_at timestamptz not null default now()
);

create index if not exists delivery_locations_buyer_idx on public.delivery_locations(buyer_id);

-- 2. Contracts: delivery type + optional delivery location
alter table public.contracts
  add column if not exists delivery_type text not null default 'pickup';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contracts_delivery_type_check') then
    alter table public.contracts
      add constraint contracts_delivery_type_check check (delivery_type in ('pickup','delivered'));
  end if;
end $$;

alter table public.contracts
  add column if not exists delivery_location_id uuid references public.delivery_locations(id) on delete set null;

create index if not exists contracts_delivery_location_idx on public.contracts(delivery_location_id);

-- 3. RLS
alter table public.delivery_locations enable row level security;

do $$ begin
  execute 'drop policy if exists "authed all" on public.delivery_locations';
  execute 'create policy "authed all" on public.delivery_locations for all to authenticated using (true) with check (true)';
end $$;
