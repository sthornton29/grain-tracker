-- Grain Tracker — Season + entity migration
-- Idempotent: safe to re-run in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- 1. Entities (LLCs, partnerships, etc. that own/operate the farms)
create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  notes text,
  created_at timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'entities_name_unique') then
    alter table public.entities add constraint entities_name_unique unique (name);
  end if;
end $$;

-- 2. farms.entity_id
alter table public.farms
  add column if not exists entity_id uuid references public.entities(id) on delete set null;

create index if not exists farms_entity_idx on public.farms(entity_id);

-- 3. fields.total_acres
alter table public.fields
  add column if not exists total_acres numeric(10,2);

-- 4. Field plantings (per field, per season, per crop)
create table if not exists public.field_plantings (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references public.fields(id) on delete cascade,
  crop_id uuid not null references public.crops(id) on delete restrict,
  season_year integer not null,
  planted_acres numeric(10,2) not null default 0,
  planting_date date,
  paired_planting_id uuid references public.field_plantings(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists field_plantings_field_idx   on public.field_plantings(field_id);
create index if not exists field_plantings_crop_idx    on public.field_plantings(crop_id);
create index if not exists field_plantings_season_idx  on public.field_plantings(season_year);
create index if not exists field_plantings_paired_idx  on public.field_plantings(paired_planting_id);

-- 5. Canola seed (USDA FSA: 50 lb/bu at 10% moisture, same standard as rapeseed)
insert into public.crops (name, base_moisture_pct, base_lb_per_bushel) values
  ('Canola', 10.0, 50.0)
on conflict (name) do update set
  base_moisture_pct  = excluded.base_moisture_pct,
  base_lb_per_bushel = excluded.base_lb_per_bushel;

-- 6. Contracts intentionally have no entity_id; the contract tracker filters by
-- entity via each delivery's source field (load → field → farm → entity).
-- Drop the column if a prior version of this migration added it.
alter table public.contracts drop column if exists entity_id;

-- 7. RLS for new tables (mirror the "authed all" policy used elsewhere)
alter table public.entities        enable row level security;
alter table public.field_plantings enable row level security;

do $$
declare t text;
begin
  foreach t in array array['entities','field_plantings'] loop
    execute format('drop policy if exists "authed all" on public.%I', t);
    execute format(
      'create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
