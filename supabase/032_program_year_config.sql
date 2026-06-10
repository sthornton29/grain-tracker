-- 032_program_year_config.sql
-- Per-crop-year program parameters that were previously hard-coded in
-- lib/crop-insurance.ts and lib/government-payments.ts (the SCO trigger, the
-- per-person FSA payment limit, and the sequestration %). Moving them into the
-- DB lets the operator update each year's values from Settings without a code
-- change. When a year has no row, callers fall back to the most recent
-- configured year and show a non-blocking notice (see lib/program-config.ts).

create table if not exists public.program_year_config (
  id uuid primary key default gen_random_uuid(),
  crop_year integer not null unique,
  -- SCO area-endorsement upper trigger (0.86 for 2026, rises to 0.90 in 2027).
  sco_trigger numeric(4,3) not null default 0.860,
  -- Per-person FSA payment limit ($155k for 2025; indexed to inflation after).
  per_person_payment_limit numeric(14,2) not null default 155000,
  -- Federal sequestration reduction applied to ARC/PLC gross payments.
  sequestration_pct numeric(6,4) not null default 0.0540,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh (set_updated_at() defined in schema.sql).
drop trigger if exists program_year_config_set_updated_at on public.program_year_config;
create trigger program_year_config_set_updated_at
  before update on public.program_year_config
  for each row execute function public.set_updated_at();

-- RLS — same authed-all policy as the rest of the app.
alter table public.program_year_config enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'program_year_config'
      and policyname = 'program_year_config authed all'
  ) then
    create policy "program_year_config authed all" on public.program_year_config
      for all to authenticated using (true) with check (true);
  end if;
end $$;

-- Seed 2026 (current) and 2027 (known SCO change) values.
insert into public.program_year_config
  (crop_year, sco_trigger, per_person_payment_limit, sequestration_pct, notes)
values
  (2026, 0.860, 155000, 0.0540,
    'SCO trigger 0.86; per-person limit $155k (indexed to inflation starting 2026 crop).'),
  (2027, 0.900, 155000, 0.0540,
    'SCO trigger rises to 0.90 in 2027. Per-person limit is a placeholder pending inflation indexing.')
on conflict (crop_year) do nothing;
