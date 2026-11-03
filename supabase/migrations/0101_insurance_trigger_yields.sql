-- 0101: crop insurance trigger yields + the approved yield (2026-11-03).
-- Applied with `npx supabase db push --linked` (supabase/migrations/, like 0093 to 0100).
--
-- An agent's "Trigger Yield Summary Report" (Silveus, Nov 2 2026) asks one
-- question per insurance unit — entity × county × crop × practice: is your
-- harvested yield below the RP trigger, and do you need a claim opened? The
-- app could not answer it per unit, and two facts behind the answer were not
-- stored anywhere:
--
-- 1. THE APPROVED YIELD. crop_insurance_policies.aph_yield holds the APH; the
--    guarantee is figured on the APPROVED yield (APH after yield adjustment,
--    trend adjustment and yield exclusions — Two Seasons corn: APH 169.1,
--    approved 193.8). approved_yield is nullable; lib/crop-insurance
--    guaranteeYieldOf (approved when set, else APH) is the ONE rule every
--    guarantee reads through.
--
-- 2. THE AGENT'S TRIGGER REPORT. insurance_trigger_yields holds one row per
--    unit the agent printed: the insured (an entity — or a LANDOWNER, for a
--    share-rent landlord who insures their own share, e.g. AF Rebman
--    Residuary Trust's 25% of three Two Seasons farms), crop, county,
--    practice, the acres / APH / approved yield / RP trigger the agent used,
--    and the county-product figures (expected county yield, ECO/SCO triggers).
--    lib/trigger-yield-check.ts compares it to the harvested yield per unit
--    and to the policy on file. A re-import replaces the insured × crop year ×
--    crop rows it covers (a December soybean report never wipes November's
--    corn and cotton).
--
-- Policy stack (the 0099 template): permissive authed-all; RESTRICTIVE 053/054
-- org isolation; 042/044 producer-only (gin blocked on every verb); 052 viewer
-- write-blocked + read scoped to granted entities (a landowner-insured row has
-- no entity and stays hidden from viewers); 061 agronomist blocked on every
-- verb (insurance is financial, never a Yields read). Added to the tenant
-- arrays in 053/054 and verify_053/054.

-- 1. The approved yield -------------------------------------------------------

alter table public.crop_insurance_policies
  add column if not exists approved_yield numeric(10,2)
    check (approved_yield is null or approved_yield > 0);
comment on column public.crop_insurance_policies.approved_yield is
  '0101: the agent''s APPROVED yield (APH after yield adjustment / trend / exclusions). Null = use aph_yield. lib/crop-insurance guaranteeYieldOf is the one rule.';

-- 2. insurance_trigger_yields --------------------------------------------------

create table if not exists public.insurance_trigger_yields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  crop_year integer not null check (crop_year between 2000 and 2100),
  -- The insured as printed, and who it is in Turnrow: an entity, or a
  -- landowner insuring their own share. Exactly one of the two.
  insured_name text not null,
  entity_id uuid references public.entities(id) on delete cascade,
  landowner_id uuid references public.landowners(id) on delete cascade,
  crop_id uuid not null references public.crops(id) on delete cascade,
  county_id uuid references public.counties(id) on delete set null,
  practice text not null default 'non_irrigated' check (practice in ('irrigated', 'non_irrigated')),
  -- "Enterprise Unit", "BU-0002" … as printed.
  unit_label text,
  plan_type text not null default 'RP' check (plan_type in ('RP', 'RP_HPE', 'YP')),
  reported_acres numeric(12,3),
  aph_yield numeric(10,2),
  approved_yield numeric(10,2),
  -- The farm-level trigger yield for the individual plan (RP/YP).
  trigger_yield numeric(10,2) not null check (trigger_yield > 0),
  expected_county_yield numeric(10,2),
  eco_trigger_yield numeric(10,2),
  sco_trigger_yield numeric(10,2),
  projected_price numeric(12,6),
  harvest_price numeric(12,6),
  report_date date,
  agency text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint insurance_trigger_yields_one_insured check ((entity_id is null) <> (landowner_id is null))
);
create index if not exists insurance_trigger_yields_org_year_idx on public.insurance_trigger_yields (org_id, crop_year);
create unique index if not exists insurance_trigger_yields_unit_uidx on public.insurance_trigger_yields (
  org_id, crop_year, coalesce(entity_id, landowner_id), crop_id,
  coalesce(county_id, '00000000-0000-0000-0000-000000000000'::uuid), practice
);

comment on table public.insurance_trigger_yields is
  'One unit of an agent''s Trigger Yield Summary Report: insured (entity, or a landowner insuring their own share), crop, county, practice, the agent''s acres / APH / approved yield / RP trigger yield, and the county-product figures. Read by lib/trigger-yield-check.ts (the Claim Check report).';

drop trigger if exists insurance_trigger_yields_set_updated_at on public.insurance_trigger_yields;
create trigger insurance_trigger_yields_set_updated_at
  before update on public.insurance_trigger_yields
  for each row execute function public.set_updated_at();

alter table public.insurance_trigger_yields enable row level security;

-- 3. Policies -----------------------------------------------------------------

do $$
declare t text := 'insurance_trigger_yields';
begin
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_all') then
    execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_all', t);
  end if;
  -- 053/054: org isolation on every verb.
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
  end if;
  -- 042/044: producer-only — the gin role never sees insurance.
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
  end if;
  -- 052: viewers never write; they read only their granted entities' rows.
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_ins') then
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''viewer'')', t || '_viewer_block_ins', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_upd', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_del', t);
  end if;
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_scope') then
    execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.app_role() <> ''viewer'' or entity_id in (select public.viewer_entity_ids()))', t || '_viewer_scope', t);
  end if;
  -- 061: the agronomist never reads or writes insurance.
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_all') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''agronomist'') with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_all', t);
  end if;
end $$;

notify pgrst, 'reload schema';
