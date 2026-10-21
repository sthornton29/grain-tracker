-- 0097: a cotton sales contract's quality requirements (2026-10-20).
-- Applied with `npx supabase db push --linked` (supabase/migrations/, like 0093 to 0096).
--
-- A merchant's purchase contract can say which bales it will take: "Color 41
-- and better, leaf 3 and better, staple 37 and longer, micronaire 4.0-4.7,
-- strength 29 g/tex and better, uniformity 80 and better", produced on the
-- farms in a schedule (FSA numbers), up to a cap, at a base-grade price
-- (VS&Co, March 31 2026 — 16 Lawrence County farms, 4,250 bales, $0.86 on
-- 41-3-37). cotton_contract_specs holds ONE spec per contract (contract_id
-- unique, cascade) so the Bale Quality report can show what portion of the
-- classed bales meets it, the Pareto of why bales fail, and the cap tracker.
--
--   * allowed_color_codes  text[]  the color codes a bale may carry (null = no rule);
--                                  "41 and better" is stored as {11,21,31,41} —
--                                  lib/cotton-contract-spec.ts turns wording into rules, never the model
--   * leaf_max / staple_min / mic_min / mic_max / strength_min / uniformity_min
--                                  inclusive at reported precision (tenths)
--   * extraneous_rule      any | none | level1_ok
--   * excluded_remarks     text[]  remarks codes that fail a bale (77 repacked…)
--   * eligible_fsa_farms   text[]  FSA numbers (digits) — a bale on another farm is "not eligible", not "fails"
--   * require_dryland      the practice requirement; modeled, off by default
--   * bale_cap / estimated_bales / base_grade / base_price_cents / off_spec_terms / other_terms
--   * source_clause        the quality clause verbatim
--   * schedule             jsonb — the contract's farm schedule rows (FSA #, county,
--                          planted acres, APH yield, APH est bales, trendline est bales)
--
-- Policy stack = cotton_sales_contracts' (044 producer-only: permissive
-- authed-all + RESTRICTIVE gin block; 053/054 RESTRICTIVE org isolation;
-- 052 viewer: read follows the parent contract the viewer can see, writes
-- blocked; 061 agronomist blocked on every verb — contract terms are
-- financial, never a Yields read).

-- 1. The table ----------------------------------------------------------------

create table if not exists public.cotton_contract_specs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  contract_id uuid not null references public.cotton_sales_contracts(id) on delete cascade,
  allowed_color_codes text[],
  leaf_max int check (leaf_max is null or (leaf_max between 1 and 8)),
  staple_min int check (staple_min is null or staple_min > 0),
  mic_min numeric(4,2),
  mic_max numeric(4,2),
  strength_min numeric(5,1),
  uniformity_min numeric(5,1),
  extraneous_rule text not null default 'any' check (extraneous_rule in ('any', 'none', 'level1_ok')),
  excluded_remarks text[],
  eligible_fsa_farms text[],
  require_dryland boolean not null default false,
  bale_cap int check (bale_cap is null or bale_cap >= 0),
  estimated_bales int check (estimated_bales is null or estimated_bales >= 0),
  base_grade text,
  base_price_cents numeric(8,2),
  off_spec_terms text,
  other_terms text,
  source_clause text,
  schedule jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cotton_contract_specs_mic_range check (mic_min is null or mic_max is null or mic_min <= mic_max),
  constraint cotton_contract_specs_one_per_contract unique (contract_id)
);

create index if not exists cotton_contract_specs_org_contract_idx on public.cotton_contract_specs (org_id, contract_id);

drop trigger if exists cotton_contract_specs_set_updated_at on public.cotton_contract_specs;
create trigger cotton_contract_specs_set_updated_at
  before update on public.cotton_contract_specs
  for each row execute function public.set_updated_at();

alter table public.cotton_contract_specs enable row level security;

-- 2. Policies -----------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_all') then
    create policy cotton_contract_specs_all on public.cotton_contract_specs for all to authenticated using (true) with check (true);
  end if;
  -- 053/054: org isolation on every verb.
  if not exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_org_isolation') then
    create policy cotton_contract_specs_org_isolation on public.cotton_contract_specs as restrictive for all to authenticated
      using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());
  end if;
  -- 042/044: producer-only — the gin role never sees marketing terms.
  if not exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_owner_only') then
    create policy cotton_contract_specs_owner_only on public.cotton_contract_specs as restrictive for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;
  -- 052: viewers read a spec only through a contract their scope shows; never write.
  if not exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_viewer_scope') then
    create policy cotton_contract_specs_viewer_scope on public.cotton_contract_specs as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or contract_id in (select id from public.cotton_sales_contracts));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_viewer_block_ins') then
    create policy cotton_contract_specs_viewer_block_ins on public.cotton_contract_specs as restrictive for insert to authenticated with check (public.app_role() <> 'viewer');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_viewer_block_upd') then
    create policy cotton_contract_specs_viewer_block_upd on public.cotton_contract_specs as restrictive for update to authenticated using (public.app_role() <> 'viewer');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_viewer_block_del') then
    create policy cotton_contract_specs_viewer_block_del on public.cotton_contract_specs as restrictive for delete to authenticated using (public.app_role() <> 'viewer');
  end if;
  -- 061: the agronomist never reads or writes contract terms.
  if not exists (select 1 from pg_policies where tablename = 'cotton_contract_specs' and policyname = 'cotton_contract_specs_agronomist_block_all') then
    create policy cotton_contract_specs_agronomist_block_all on public.cotton_contract_specs as restrictive for all to authenticated
      using (public.app_role() <> 'agronomist') with check (public.app_role() <> 'agronomist');
  end if;
end $$;
