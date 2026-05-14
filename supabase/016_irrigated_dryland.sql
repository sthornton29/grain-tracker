-- Grain Tracker — irrigated / dryland acre tracking.
-- Idempotent: safe to re-run.
--
-- Adds:
--   * fields.irrigated_acres, fields.dryland_acres
--   * field_plantings.irrigated_acres, field_plantings.dryland_acres
--   * field_plantings.irrigated_bushels, field_plantings.dryland_bushels,
--     field_plantings.yield_breakout_entered (mixed-practice yield breakout)
--
-- Backfill rule: every existing row counts as 100 % dryland. Stuart's
-- operation has been dryland-only until now, so this matches reality and
-- lets the new inputs default to 0 irrigated without losing acre totals.
-- The dryland column is denormalized (stored, not derived) because every
-- yield calc joins on it and writing it once at save time keeps queries
-- simple.

alter table public.fields
  add column if not exists irrigated_acres numeric(10,2) not null default 0,
  add column if not exists dryland_acres   numeric(10,2);

-- Backfill: existing fields are 100% dryland.
update public.fields
   set dryland_acres = coalesce(total_acres, 0)
 where dryland_acres is null;

alter table public.fields
  alter column dryland_acres set default 0,
  alter column dryland_acres set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'fields_irrigated_nonneg'
  ) then
    alter table public.fields
      add constraint fields_irrigated_nonneg check (irrigated_acres >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'fields_dryland_nonneg'
  ) then
    alter table public.fields
      add constraint fields_dryland_nonneg check (dryland_acres >= 0);
  end if;
end $$;

alter table public.field_plantings
  add column if not exists irrigated_acres numeric(10,2) not null default 0,
  add column if not exists dryland_acres   numeric(10,2),
  add column if not exists irrigated_bushels numeric(12,2),
  add column if not exists dryland_bushels   numeric(12,2),
  add column if not exists yield_breakout_entered boolean not null default false;

update public.field_plantings
   set dryland_acres = coalesce(planted_acres, 0)
 where dryland_acres is null;

alter table public.field_plantings
  alter column dryland_acres set default 0,
  alter column dryland_acres set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'field_plantings_irrigated_nonneg'
  ) then
    alter table public.field_plantings
      add constraint field_plantings_irrigated_nonneg check (irrigated_acres >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'field_plantings_dryland_nonneg'
  ) then
    alter table public.field_plantings
      add constraint field_plantings_dryland_nonneg check (dryland_acres >= 0);
  end if;
end $$;

-- Triggers keep dryland_acres = total/planted - irrigated regardless of how
-- the row was inserted (form, CSV import, raw SQL). Without this, a CSV
-- import that maps irrigated_acres would leave dryland_acres at its 0
-- default and break the yield breakouts.
create or replace function public.set_field_dryland_acres()
returns trigger language plpgsql as $$
begin
  new.dryland_acres := greatest(0, coalesce(new.total_acres, 0) - coalesce(new.irrigated_acres, 0));
  return new;
end $$;

drop trigger if exists fields_set_dryland on public.fields;
create trigger fields_set_dryland
  before insert or update on public.fields
  for each row execute function public.set_field_dryland_acres();

create or replace function public.set_field_planting_dryland_acres()
returns trigger language plpgsql as $$
begin
  new.dryland_acres := greatest(0, coalesce(new.planted_acres, 0) - coalesce(new.irrigated_acres, 0));
  return new;
end $$;

drop trigger if exists field_plantings_set_dryland on public.field_plantings;
create trigger field_plantings_set_dryland
  before insert or update on public.field_plantings
  for each row execute function public.set_field_planting_dryland_acres();
