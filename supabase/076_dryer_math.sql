-- 076: Grain Dryer Math — dryer model catalog + org dryers.
-- Idempotent: safe to re-run.
--
-- Two tables behind the /reports/dryer-math calculator:
--
--   1. dryer_models — a GLOBAL reference catalog (counties/commodity_specs
--      pattern: everyone reads, owner-only writes per the 054 rule) of the
--      major manufacturers' common dryer lines, each with a type-derived
--      efficiency PRESET in gal LP per bushel-point. Presets are typical
--      estimates ONLY — the UI labels them "typical estimate — calibrate
--      with your records" and the calculator's calibrate step replaces them
--      with the operation's own number. NG equivalents are derived in code
--      by BTU parity (propane 91,500 BTU/gal ÷ NG 1,020 BTU/cf).
--
--   2. org_dryers — the operation's own dryers (tenant table, full 053/054
--      policy stack): pick a catalog model or define a custom dryer; fuel
--      (LP or NG for now), consumption per bu-pt stored in the FUEL'S OWN
--      unit (gal for LP, ccf for NG), optional fan kWh per bu-pt. Editable
--      overrides on any preset; the calibrate-from-records flow saves here.
--
-- The report itself is a calculator, not a ledger — no per-load tracking.

create extension if not exists "pgcrypto";

-- 1. Global dryer model catalog -----------------------------------------------

create table if not exists public.dryer_models (
  id uuid primary key default gen_random_uuid(),
  manufacturer text not null,
  model text not null,
  dryer_type text not null check (dryer_type in
    ('cross_flow', 'mixed_flow', 'tower', 'heat_recovery', 'in_bin_high_temp')),
  supports_lp boolean not null default true,
  supports_ng boolean not null default true,
  -- Typical gal LP per bushel-point, derived from the dryer TYPE:
  -- cross-flow ~0.020–0.022, mixed-flow/tower ~0.017–0.019,
  -- heat-recovery ~0.014–0.016, in-bin high-temp ~0.022.
  default_gal_lp_per_bu_pt numeric(6,4) not null,
  notes text,
  created_at timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dryer_models_mfr_model_unique') then
    alter table public.dryer_models add constraint dryer_models_mfr_model_unique unique (manufacturer, model);
  end if;
end $$;

alter table public.dryer_models enable row level security;

do $$ begin
  -- Reference-table pattern: every authenticated user reads the catalog.
  if not exists (select 1 from pg_policies where tablename = 'dryer_models' and policyname = 'authed all') then
    create policy "authed all" on public.dryer_models for all to authenticated using (true) with check (true);
  end if;
  -- 054 global-reference rule: owner-only writes.
  if not exists (select 1 from pg_policies where tablename = 'dryer_models' and policyname = 'dryer_models_global_owner_write') then
    create policy dryer_models_global_owner_write on public.dryer_models as restrictive for insert to authenticated
      with check (auth.uid() is not null and public.app_role() = 'owner');
    create policy dryer_models_global_owner_upd on public.dryer_models as restrictive for update to authenticated
      using (auth.uid() is not null and public.app_role() = 'owner');
    create policy dryer_models_global_owner_del on public.dryer_models as restrictive for delete to authenticated
      using (auth.uid() is not null and public.app_role() = 'owner');
  end if;
end $$;

-- Seed the common lines. Presets by type (typical estimates, NOT ratings):
-- cross-flow 0.021 · mixed-flow/tower 0.018 · heat-recovery 0.015 ·
-- in-bin high-temp 0.022.
insert into public.dryer_models (manufacturer, model, dryer_type, default_gal_lp_per_bu_pt, notes) values
  ('GSI',             'Portable 1100 Series',          'cross_flow',       0.0210, 'Typical estimate — calibrate with your records.'),
  ('GSI',             'Portable 2000/2600 Series',     'cross_flow',       0.0210, 'Typical estimate — calibrate with your records.'),
  ('GSI',             'TopDry (in-bin)',               'in_bin_high_temp', 0.0220, 'Typical estimate — calibrate with your records.'),
  ('Zimmerman',       'Tower (GSI)',                   'tower',            0.0180, 'Typical estimate — calibrate with your records.'),
  ('Sukup',           'Portable Single-Fan',           'cross_flow',       0.0210, 'Typical estimate — calibrate with your records.'),
  ('Sukup',           'Portable w/ Heat Reclaimer',    'heat_recovery',    0.0150, 'Typical estimate — calibrate with your records.'),
  ('Sukup',           'Tower',                         'tower',            0.0180, 'Typical estimate — calibrate with your records.'),
  ('Brock',           'SQ Series (Meyer Energy Miser)','cross_flow',       0.0210, 'Typical estimate — calibrate with your records.'),
  ('Brock',           'Tower',                         'tower',            0.0180, 'Typical estimate — calibrate with your records.'),
  ('Mathews Company', 'Legacy/Delta Series',           'mixed_flow',       0.0180, 'Typical estimate — calibrate with your records.'),
  ('Mathews Company', 'Tower',                         'tower',            0.0180, 'Typical estimate — calibrate with your records.'),
  ('NECO',            'Model 24260',                   'mixed_flow',       0.0180, 'Mixed-flow tower line. Typical estimate — calibrate with your records.'),
  ('NECO',            'Mixed-Flow Tower (D Series)',   'mixed_flow',       0.0180, 'Typical estimate — calibrate with your records.'),
  ('Grain Handler',   'Mixed-Flow',                    'mixed_flow',       0.0180, 'Typical estimate — calibrate with your records.'),
  ('Farm Fans',       'C / AB Series',                 'cross_flow',       0.0210, 'Typical estimate — calibrate with your records.'),
  ('GT (Farm Fans)',  'RA Recirculating Batch',        'cross_flow',       0.0220, 'Typical estimate — calibrate with your records.')
on conflict (manufacturer, model) do nothing;

-- 2. Org dryers ----------------------------------------------------------------

create table if not exists public.org_dryers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  name text not null,
  -- Null = a fully custom dryer.
  dryer_model_id uuid references public.dryer_models(id) on delete set null,
  fuel text not null default 'lp' check (fuel in ('lp', 'ng')),
  -- Consumption per bushel-point in the FUEL'S OWN unit: gal for LP, ccf
  -- (100 cf) for NG. lib/dryer-math.ts converts between them by BTU parity.
  fuel_per_bu_pt numeric(8,5) not null check (fuel_per_bu_pt > 0),
  -- Optional fan/auger electricity per bushel-point.
  fan_kwh_per_bu_pt numeric(8,5),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists org_dryers_org_idx on public.org_dryers (org_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'org_dryers_org_name_unique') then
    alter table public.org_dryers add constraint org_dryers_org_name_unique unique (org_id, name);
  end if;
end $$;

drop trigger if exists org_dryers_set_updated_at on public.org_dryers;
create trigger org_dryers_set_updated_at
  before update on public.org_dryers
  for each row execute function public.set_updated_at();

alter table public.org_dryers enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'org_dryers' and policyname = 'authed all') then
    create policy "authed all" on public.org_dryers for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'org_dryers' and policyname = 'org_dryers_org_isolation') then
    create policy org_dryers_org_isolation on public.org_dryers as restrictive for all to authenticated
      using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());
  end if;
  -- 042: grain-operation table, gin users blocked.
  if not exists (select 1 from pg_policies where tablename = 'org_dryers' and policyname = 'org_dryers_owner_only') then
    create policy org_dryers_owner_only on public.org_dryers as restrictive for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;
  -- 052: viewers write-blocked (the report route is viewer-blocked too —
  -- no entity dimension, same rationale as crop-budget).
  if not exists (select 1 from pg_policies where tablename = 'org_dryers' and policyname = 'org_dryers_viewer_block_ins') then
    create policy org_dryers_viewer_block_ins on public.org_dryers as restrictive for insert to authenticated
      with check (public.app_role() <> 'viewer');
    create policy org_dryers_viewer_block_upd on public.org_dryers as restrictive for update to authenticated
      using (public.app_role() <> 'viewer');
    create policy org_dryers_viewer_block_del on public.org_dryers as restrictive for delete to authenticated
      using (public.app_role() <> 'viewer');
  end if;
  -- 061: agronomist write- AND select-blocked (not the Yields surface).
  if not exists (select 1 from pg_policies where tablename = 'org_dryers' and policyname = 'org_dryers_agronomist_block_ins') then
    create policy org_dryers_agronomist_block_ins on public.org_dryers as restrictive for insert to authenticated
      with check (public.app_role() <> 'agronomist');
    create policy org_dryers_agronomist_block_upd on public.org_dryers as restrictive for update to authenticated
      using (public.app_role() <> 'agronomist');
    create policy org_dryers_agronomist_block_del on public.org_dryers as restrictive for delete to authenticated
      using (public.app_role() <> 'agronomist');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'org_dryers' and policyname = 'org_dryers_agronomist_block_sel') then
    create policy org_dryers_agronomist_block_sel on public.org_dryers as restrictive for select to authenticated
      using (public.app_role() <> 'agronomist');
  end if;
end $$;
