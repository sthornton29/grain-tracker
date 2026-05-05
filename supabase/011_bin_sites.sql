-- Grain Tracker — bin sites
-- Idempotent: safe to re-run.
--
-- Adds:
--   * bin_sites table — physical locations grouping bins under an entity
--   * bins.bin_site_id FK
--   * Backfill: a "Default Site" per entity that has any bins, with each
--     existing bin assigned via load history (most-loaded entity wins) or
--     an alphabetical fallback when a bin has no inflow loads.
--
-- bin_site_id is left nullable in the DB so re-running is safe and so the
-- migration doesn't fail if a tenant has zero entities. The UI enforces
-- required-site on save going forward.

-- 1) bin_sites -------------------------------------------------------------

create table if not exists public.bin_sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  entity_id uuid not null references public.entities(id) on delete cascade,
  county_id uuid references public.counties(id) on delete set null,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  constraint bin_sites_entity_name_unique unique (entity_id, name)
);

create index if not exists bin_sites_entity_idx on public.bin_sites(entity_id);
create index if not exists bin_sites_county_idx on public.bin_sites(county_id);

alter table public.bin_sites enable row level security;
drop policy if exists "bin_sites authed all" on public.bin_sites;
create policy "bin_sites authed all" on public.bin_sites
  for all to authenticated using (true) with check (true);

-- 2) bins.bin_site_id -----------------------------------------------------

alter table public.bins
  add column if not exists bin_site_id uuid references public.bin_sites(id) on delete set null;

create index if not exists bins_bin_site_idx on public.bins(bin_site_id);

-- 3) backfill -------------------------------------------------------------
--
-- For each entity create a "Default Site"; assign each unsited bin to the
-- default site of the entity that has loaded the most net weight INTO that
-- bin. Bins with no inflow loads fall back to the alphabetically-first
-- entity. Both lookups are idempotent: the unique constraint prevents
-- duplicate Default Sites, and the bin update is gated on bin_site_id IS NULL.

do $$
declare
  ent record;
  bn record;
  picked_entity_id uuid;
  picked_site_id uuid;
  fallback_entity_id uuid;
begin
  for ent in select id from public.entities loop
    insert into public.bin_sites (name, entity_id)
    values ('Default Site', ent.id)
    on conflict (entity_id, name) do nothing;
  end loop;

  select id into fallback_entity_id
  from public.entities
  order by name
  limit 1;

  for bn in select id from public.bins where bin_site_id is null loop
    select fa.entity_id into picked_entity_id
    from public.loads l
    join public.fields fi on fi.id = l.from_field_id
    join public.farms fa on fa.id = fi.farm_id
    where l.to_bin_id = bn.id and fa.entity_id is not null
    group by fa.entity_id
    order by sum(coalesce(l.net_weight, 0)) desc
    limit 1;

    if picked_entity_id is null then
      picked_entity_id := fallback_entity_id;
    end if;

    if picked_entity_id is not null then
      select id into picked_site_id
      from public.bin_sites
      where entity_id = picked_entity_id and name = 'Default Site'
      limit 1;

      if picked_site_id is not null then
        update public.bins set bin_site_id = picked_site_id where id = bn.id;
      end if;
    end if;
  end loop;
end$$;
