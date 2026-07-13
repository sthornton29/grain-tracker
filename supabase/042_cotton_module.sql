-- 042: Cotton module — seed cotton loads, gin receipts, bale-level classing
-- data, plus the app's first role system (gin operator) and a module flag.
--   * app_settings — single-row org-level settings (cotton_module_enabled).
--     Designed so the multi-tenant conversion can re-key it per organization.
--   * gins, cotton_loads (module/weight tickets — yard inventory until
--     ginned), gin_receipts (+ gin_receipt_loads junction), cotton_bales,
--     cotton_bale_grades (HVI classing, keyed by PBI match).
--   * user_profiles — user_id → role ('owner' | 'gin'). Gin users may READ
--     the reference tables their intake needs and WRITE only cotton tables;
--     everything else is blocked by RESTRICTIVE policies that AND with the
--     existing permissive ones. This is the single-operation version ("my gin
--     enters my cotton into my instance"); TRUE multi-producer gin access
--     needs the multi-tenant conversion, which extends exactly this
--     role/RLS foundation.
-- Idempotent.

create extension if not exists "pgcrypto";

-- 1. Org-level app settings (single row) ---------------------------------------
create table if not exists public.app_settings (
  id integer primary key default 1 check (id = 1),
  cotton_module_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict do nothing;

-- 2. Roles ----------------------------------------------------------------------
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'gin')),
  created_at timestamptz not null default now()
);

-- The caller's role; no profile row = full owner (backward compatible).
-- SECURITY DEFINER so policies can call it without RLS recursion.
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.user_profiles where user_id = auth.uid()), 'owner')
$$;

-- Owner-run role assignment / listing by email (auth.users is not readable
-- from the client). Gin users cannot call these.
create or replace function public.assign_user_role(user_email text, new_role text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if public.app_role() = 'gin' then raise exception 'not allowed'; end if;
  if new_role not in ('owner', 'gin') then raise exception 'invalid role'; end if;
  select id into uid from auth.users where lower(email) = lower(user_email);
  if uid is null then raise exception 'no auth user with email %', user_email; end if;
  insert into public.user_profiles (user_id, role) values (uid, new_role)
  on conflict (user_id) do update set role = excluded.role;
end $$;

create or replace function public.list_user_roles()
returns table (user_id uuid, email text, role text)
language sql stable security definer set search_path = public as $$
  select u.id, u.email::text, coalesce(p.role, 'owner')
  from auth.users u left join public.user_profiles p on p.user_id = u.id
  where public.app_role() <> 'gin'
  order by u.email
$$;

-- 3. Cotton tables ----------------------------------------------------------------
create table if not exists public.gins (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  address text,
  phone text,
  notes text,
  created_at timestamptz not null default now()
);

-- Seed cotton module/weight tickets — structurally parallel to grain loads.
-- Yard inventory until they appear on a gin receipt.
create table if not exists public.cotton_loads (
  id uuid primary key default gen_random_uuid(),
  load_number text not null,
  entity_id uuid references public.entities(id) on delete set null,
  farm_id uuid references public.farms(id) on delete set null,
  field_id uuid references public.fields(id) on delete set null,
  crop_year integer not null,
  picked_date date,
  delivered_date date,
  truck text,
  gross_weight numeric(12,2),
  tare_weight numeric(12,2),
  net_weight numeric(12,2), -- lbs SEED COTTON
  gin_id uuid references public.gins(id) on delete set null,
  location text,
  notes text,
  source text not null default 'manual' check (source in ('manual', 'document_import')),
  source_pdf_url text,
  created_at timestamptz not null default now(),
  unique (crop_year, load_number)
);
create index if not exists cotton_loads_field_idx on public.cotton_loads(field_id);
create index if not exists cotton_loads_year_idx on public.cotton_loads(crop_year);

-- One Statement of Ginning; multiple receipts per field allowed.
create table if not exists public.gin_receipts (
  id uuid primary key default gen_random_uuid(),
  gin_id uuid references public.gins(id) on delete set null,
  receipt_number text not null,
  receipt_date date,
  entity_id uuid references public.entities(id) on delete set null,
  farm_id uuid references public.farms(id) on delete set null,
  field_id uuid references public.fields(id) on delete set null,
  crop_year integer not null,
  modules_count integer,
  total_seed_cotton_weight numeric(14,2), -- lbs
  bales_count integer,
  total_bale_weight numeric(14,2), -- lbs LINT
  avg_bale_weight numeric(10,2),
  seed_lbs numeric(14,2), -- cottonseed produced
  lint_turnout_pct numeric(6,2),
  lint_lbs_per_bale numeric(10,2),
  notes text,
  source text not null default 'manual' check (source in ('manual', 'document_import')),
  source_pdf_url text,
  created_at timestamptz not null default now(),
  unique (crop_year, receipt_number)
);
create index if not exists gin_receipts_field_idx on public.gin_receipts(field_id);
create index if not exists gin_receipts_year_idx on public.gin_receipts(crop_year);

-- The receipt's load table lines, matched to cotton_loads by load_number.
create table if not exists public.gin_receipt_loads (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.gin_receipts(id) on delete cascade,
  cotton_load_id uuid not null references public.cotton_loads(id) on delete cascade,
  unique (receipt_id, cotton_load_id)
);
create index if not exists gin_receipt_loads_load_idx on public.gin_receipt_loads(cotton_load_id);

-- One row per bale, from the receipt's bale list. PBI # unique per crop year
-- (crop_year denormalized from the receipt to carry the constraint).
create table if not exists public.cotton_bales (
  id uuid primary key default gen_random_uuid(),
  gin_receipt_id uuid not null references public.gin_receipts(id) on delete cascade,
  crop_year integer not null,
  pbi_number text not null,
  net_weight_lbs numeric(10,2) not null,
  created_at timestamptz not null default now(),
  unique (crop_year, pbi_number)
);
create index if not exists cotton_bales_receipt_idx on public.cotton_bales(gin_receipt_id);

-- HVI classing data per bale (one classing row per bale).
create table if not exists public.cotton_bale_grades (
  id uuid primary key default gen_random_uuid(),
  bale_id uuid not null references public.cotton_bales(id) on delete cascade unique,
  class_date date,
  color_grade text,            -- Gr (e.g. 31)
  leaf_grade text,             -- Lf
  staple_32nds numeric(6,1),   -- St
  micronaire numeric(5,2),     -- Mic
  strength_g_tex numeric(6,2), -- Str
  composite_grade text,        -- Cgr (e.g. "31-1")
  rd numeric(6,2),
  plus_b numeric(6,2),         -- +B
  trash_pct numeric(6,2),      -- Tr
  uniformity_pct numeric(6,2), -- Unif
  length_100ths numeric(6,2),  -- Len
  extraneous text,             -- Ex
  remarks text,                -- Rm
  loan_value_total numeric(12,2),      -- the "Total Value" $ column
  loan_value_cents_per_lb numeric(8,2), -- derived: total ÷ net wt × 100
  source text not null default 'csv_import' check (source in ('csv_import', 'manual')),
  created_at timestamptz not null default now()
);

-- Cotton commodity for hedging: ICE Cotton No. 2, 50,000 lbs, prices in ¢/lb
-- (contract_size_bu holds LBS for cotton — P&L divides by 100 in code).
insert into public.commodity_specs (commodity, symbol, exchange, contract_size_bu, tick_size, tick_value, contract_months)
select 'Cotton', 'CT', 'ICE', 50000, 0.01, 5, 'H,K,N,V,Z'
where not exists (select 1 from public.commodity_specs where commodity = 'Cotton');

-- 4. RLS ------------------------------------------------------------------------
alter table public.app_settings       enable row level security;
alter table public.user_profiles      enable row level security;
alter table public.gins               enable row level security;
alter table public.cotton_loads       enable row level security;
alter table public.gin_receipts       enable row level security;
alter table public.gin_receipt_loads  enable row level security;
alter table public.cotton_bales       enable row level security;
alter table public.cotton_bale_grades enable row level security;

do $$
declare t text;
begin
  -- Cotton tables: full access for every authenticated user (both roles).
  foreach t in array array['gins','cotton_loads','gin_receipts','gin_receipt_loads','cotton_bales','cotton_bale_grades'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_all') then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_all', t);
    end if;
  end loop;

  -- app_settings: readable by all (nav needs the flag), writable by owners.
  if not exists (select 1 from pg_policies where tablename = 'app_settings' and policyname = 'app_settings_read') then
    create policy app_settings_read on public.app_settings for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'app_settings' and policyname = 'app_settings_write') then
    create policy app_settings_write on public.app_settings for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;

  -- user_profiles: a user may read their own row (role lookup); owners manage all.
  if not exists (select 1 from pg_policies where tablename = 'user_profiles' and policyname = 'user_profiles_own') then
    create policy user_profiles_own on public.user_profiles for select to authenticated
      using (user_id = auth.uid() or public.app_role() <> 'gin');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'user_profiles' and policyname = 'user_profiles_admin') then
    create policy user_profiles_admin on public.user_profiles for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;

  -- Reference tables the gin intake NEEDS to read (link loads to farm/field/
  -- entity, county display): gin may SELECT, never write. RESTRICTIVE
  -- policies AND with the existing permissive ones.
  foreach t in array array['farms','fields','entities','counties'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_gin_readonly_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''gin'')', t || '_gin_readonly_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''gin'')', t || '_gin_readonly_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''gin'')', t || '_gin_readonly_del', t);
    end if;
  end loop;

  -- Everything else (grain, contracts, hedging, financials, settings…):
  -- fully blocked for gin users.
  for t in
    select tablename from pg_tables where schemaname = 'public'
      and tablename not in (
        'gins','cotton_loads','gin_receipts','gin_receipt_loads','cotton_bales','cotton_bale_grades',
        'app_settings','user_profiles','farms','fields','entities','counties'
      )
  loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
  end loop;
end $$;
