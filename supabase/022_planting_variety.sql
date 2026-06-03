-- Grain Tracker — multiple varieties per field planting.
-- Each variety tracks its own planted acres. Bushels are nullable; they're
-- populated only when the user manually allocates harvest bushels per variety
-- (the yields-by-variety report ignores multi-variety plantings until that
-- allocation is in). Single-variety plantings need no allocation — the parent
-- planting's dry bushels are attributed to the one variety.
-- Idempotent.

create table if not exists public.field_planting_varieties (
  id uuid primary key default gen_random_uuid(),
  planting_id uuid not null references public.field_plantings(id) on delete cascade,
  variety text not null,
  acres numeric(10,2) not null default 0,
  bushels numeric(12,2),
  created_at timestamptz not null default now()
);

create index if not exists field_planting_varieties_planting_idx
  on public.field_planting_varieties(planting_id);

alter table public.field_planting_varieties enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'field_planting_varieties'
      and policyname = 'authed all'
  ) then
    create policy "authed all" on public.field_planting_varieties
      for all to authenticated
      using (true) with check (true);
  end if;
end $$;
