-- 045: Unified county-yield variance assumption + expanded area-based plans
-- (STAX, ARP/AYP, MCO alongside SCO/ECO).
--
-- county_yield_assumptions is the ONE source for every county-triggered
-- insurance calculation: variance_pct is "my county vs its expected/benchmark
-- yield this year" (−10 = typically runs 10% below), the SAME semantic as the
-- old per-endorsement crop_insurance_sco/eco.county_yield_assumption_pct
-- (which stay as deprecated fallbacks for one release). This is deliberately
-- SEPARATE from the ARC-CO expectation on arc_benchmark_data — insurance uses
-- RMA expected county yields, ARC uses FSA benchmarks; never merged.
--
-- Idempotent: safe to re-run.

create table if not exists public.county_yield_assumptions (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid not null references public.crops(id) on delete cascade,
  county_id uuid references public.counties(id) on delete cascade, -- null = the crop's default (no-county policies)
  crop_year int not null,
  variance_pct numeric(6,2) not null default 0, -- −10 = county runs 10% below expected
  county_yield_override numeric(10,2),          -- absolute estimated county yield (wins over variance)
  rma_final_county_yield numeric(10,2),         -- published RMA final: PINS every consumer, disables scenario modes
  notes text,
  created_at timestamptz not null default now()
);

-- Unique per crop × county × year (null county collapses to one default row).
create unique index if not exists county_yield_assumptions_key
  on public.county_yield_assumptions (crop_id, crop_year, coalesce(county_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Seed from existing per-endorsement assumptions (SCO first, ECO fills gaps).
do $$
begin
  insert into public.county_yield_assumptions (crop_id, county_id, crop_year, variance_pct, notes)
  select distinct on (p.crop_id, p.county_id, p.crop_year)
    p.crop_id, p.county_id, p.crop_year, s.county_yield_assumption_pct,
    'Seeded from SCO endorsement assumption (045)'
  from public.crop_insurance_sco s
  join public.crop_insurance_policies p on p.id = s.policy_id
  where s.county_yield_assumption_pct is not null and s.county_yield_assumption_pct <> 0
  on conflict do nothing;

  insert into public.county_yield_assumptions (crop_id, county_id, crop_year, variance_pct, notes)
  select distinct on (p.crop_id, p.county_id, p.crop_year)
    p.crop_id, p.county_id, p.crop_year, e.county_yield_assumption_pct,
    'Seeded from ECO endorsement assumption (045)'
  from public.crop_insurance_eco e
  join public.crop_insurance_policies p on p.id = e.policy_id
  where e.county_yield_assumption_pct is not null and e.county_yield_assumption_pct <> 0
  on conflict do nothing;
exception when undefined_column then null; -- older schema without the columns
end $$;

-- ARP / AYP as standalone plan types (county-triggered; the farm's own yield
-- plays no role) + per-policy RMA expected county figures and the area-plan
-- protection factor.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'crop_insurance_policies' and column_name = 'expected_county_yield') then
    alter table public.crop_insurance_policies add column expected_county_yield numeric(10,2);
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'crop_insurance_policies' and column_name = 'expected_county_revenue') then
    alter table public.crop_insurance_policies add column expected_county_revenue numeric(12,2);
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'crop_insurance_policies' and column_name = 'protection_factor') then
    alter table public.crop_insurance_policies add column protection_factor numeric(6,3); -- ARP/AYP 0.8–1.2
  end if;
end $$;

-- Widen the plan_type check to include ARP and AYP.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.crop_insurance_policies'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%plan_type%'
  loop
    execute format('alter table public.crop_insurance_policies drop constraint %I', c.conname);
  end loop;
  alter table public.crop_insurance_policies
    add constraint crop_insurance_policies_plan_type_check
    check (plan_type in ('RP','RP_HPE','YP','ARP','AYP'));
end $$;

-- RMA expected county yield per SCO/ECO endorsement already exists as
-- expected_county_yield; county_yield_assumption_pct on both tables is now
-- DEPRECATED (fallback only — the shared table wins).

-- STAX (cotton-only, endorsement on a policy): band from coverage_range_top
-- down coverage_pct (5% increments to 20%), × protection factor.
create table if not exists public.crop_insurance_stax (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.crop_insurance_policies(id) on delete cascade,
  coverage_range_top numeric(4,3) not null default 0.90,
  coverage_pct numeric(4,3) not null default 0.20 check (coverage_pct > 0 and coverage_pct <= 0.20),
  protection_factor numeric(6,3) not null default 1.0, -- 0.8–1.2
  expected_county_revenue numeric(12,2),
  premium_per_acre numeric(10,2),
  total_premium numeric(12,2),
  notes text,
  created_at timestamptz not null default now(),
  unique (policy_id)
);

-- MCO (margin coverage option, endorsement): margin-triggered band 86% → top
-- (90 or 95). Expected margin + input-cost adjustment come from the policy
-- documents/user entry (RMA publishes them); the county-yield side reads the
-- shared assumption like SCO/ECO.
create table if not exists public.crop_insurance_mco (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.crop_insurance_policies(id) on delete cascade,
  trigger_level numeric(4,3) not null default 0.90, -- band top: 0.90 or 0.95
  expected_margin numeric(12,2),      -- $/acre
  input_cost_adjustment numeric(12,2) not null default 0, -- $/acre vs expectation
  expected_county_yield numeric(10,2),
  premium_per_acre numeric(10,2),
  total_premium numeric(12,2),
  notes text,
  created_at timestamptz not null default now(),
  unique (policy_id)
);

-- RLS: authenticated permissive + RESTRICTIVE gin block (grain/insurance data).
alter table public.county_yield_assumptions enable row level security;
alter table public.crop_insurance_stax      enable row level security;
alter table public.crop_insurance_mco       enable row level security;

do $$
declare t text;
begin
  foreach t in array array['county_yield_assumptions','crop_insurance_stax','crop_insurance_mco'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_all') then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_all', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
  end loop;
end $$;
