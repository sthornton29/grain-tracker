-- 048 — Crop Budget Planner: pre-season budgeting scenarios.
--
-- budget_scenarios / budget_lines are a SANDBOX for "what should I plant next
-- year" — they never write to crop_assumptions or any actuals table. A
-- scenario is one whole-farm allocation for a budget crop year; its lines are
-- one crop each (label allows two lines of the same crop, e.g. "Soybeans (DC
-- behind wheat)"). Prices follow the app convention: grains $/bu; cotton
-- STORED ¢/lb, displayed $/lb.
--
-- Idempotent: safe to re-run.

create table if not exists public.budget_scenarios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  budget_crop_year int not null,
  entity_id uuid references public.entities(id) on delete set null, -- null = whole operation
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references public.budget_scenarios(id) on delete cascade,
  crop_id uuid not null references public.crops(id) on delete cascade,
  label text,                       -- optional qualifier ("DC behind wheat")
  acres numeric(12,2),
  yield_per_acre numeric(12,2),     -- bu/ac grains, lbs lint/ac cotton
  price_mode text not null default 'live' check (price_mode in ('live', 'manual')),
  manual_price numeric(12,4),       -- $/bu grains; ¢/lb cotton (stored), $/lb displayed
  basis numeric(12,4),              -- added to futures/manual; $/bu or ¢/lb (cotton stored ¢)
  cost_per_acre numeric(12,2),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists budget_lines_scenario_idx on public.budget_lines (scenario_id, sort_order);

alter table public.budget_scenarios enable row level security;
alter table public.budget_lines     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['budget_scenarios', 'budget_lines'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_all') then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_all', t);
    end if;
    -- Financial planning is producer-only, like the cotton marketing tables.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
  end loop;
end $$;
