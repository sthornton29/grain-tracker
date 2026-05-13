-- Grain Tracker — landowners + share rent on farms.
-- Idempotent: safe to re-run.
--
-- Adds:
--   * landowners table — separate from entities (which represent the
--     farming operation's own legal entities). A landowner is a third
--     party who owns ground the operation rents.
--   * farms.landowner_id      — optional pointer to a landowner
--   * farms.is_share_rent     — flag; default false for existing farms
--   * farms.landlord_share_percentage — required when is_share_rent
--                                       is true, 0–100 with two decimals

create table if not exists public.landowners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists landowners_name_idx on public.landowners(name);

alter table public.landowners enable row level security;
drop policy if exists "landowners authed all" on public.landowners;
create policy "landowners authed all" on public.landowners
  for all to authenticated using (true) with check (true);

alter table public.farms
  add column if not exists landowner_id uuid references public.landowners(id) on delete set null,
  add column if not exists is_share_rent boolean not null default false,
  add column if not exists landlord_share_percentage numeric(5,2);

create index if not exists farms_landowner_idx on public.farms(landowner_id);

-- Enforce 0–100 on the percentage when present, and require it whenever
-- share rent is on. Wrap in a guard so re-running doesn't error.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'farms_landlord_share_percentage_range'
  ) then
    alter table public.farms
      add constraint farms_landlord_share_percentage_range
      check (
        landlord_share_percentage is null
        or (landlord_share_percentage >= 0 and landlord_share_percentage <= 100)
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'farms_share_rent_requires_percentage'
  ) then
    alter table public.farms
      add constraint farms_share_rent_requires_percentage
      check (
        is_share_rent = false
        or (is_share_rent = true and landlord_share_percentage is not null)
      );
  end if;
end $$;
