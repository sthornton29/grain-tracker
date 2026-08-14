-- 069: Rent Settlement — org branding, lease terms, settlement records.
-- Idempotent: safe to re-run.
--
-- The Rent Settlement report generates a landowner settlement statement from
-- the account's production data, under the FARM'S OWN branding (no Turnrow
-- marks — the farm proudly mails this). Three pieces:
--
--   1. organizations branding columns — display name / logo / address /
--      contact rendered by the export layer's `branding: 'org'` mode
--      (lib/branding.ts). All nullable (admin_create_org and the verify
--      probes insert without them). Every member may READ them (the whole-
--      row member_read policy) — print headers and exports need that; only
--      owners write, and a new RESTRICTIVE policy scopes owner writes to
--      THEIR OWN org row (053's owner_write wasn't id-scoped — organizations
--      is the tenant root, so 054's org_id isolation never covered it).
--
--   2. lease_terms — the structured lease per landowner × farm set: type
--      (crop-share / cash / flex), share percentages (by crop where they
--      differ), expense sharing, how the landowner's grain is priced,
--      payment timing, flex clauses — extracted by AI from an uploaded lease
--      (document_type 'lease_agreement') or entered by hand for handshake
--      leases; the source document stays attached. jsonb columns carry the
--      typed shapes defined in lib/rent-settlement.ts (the pure math reads
--      ONLY those shapes; the settlement won't generate while required
--      inputs are missing — the gap interview).
--
--   3. rent_settlements — one generated settlement per landowner × crop
--      year: the full itemized statement snapshot (every line notes its
--      source: account / entered / reference), regenerable, listed on the
--      report page.
--
-- Multi-tenant conventions (053/054) on both new tables: org_id with the
-- current_org_id()/default_org_id() default, RESTRICTIVE org isolation, 042
-- gin block, 052 viewer blocks (WRITE AND SELECT — landowner finances are
-- not a stakeholder surface; the report route is viewer-blocked too), 061
-- agronomist blocks (write and select). Both added to the tenant arrays in
-- 053/054 and the verify scripts.

create extension if not exists "pgcrypto";

-- 1. Org branding -------------------------------------------------------------

alter table public.organizations add column if not exists branding_display_name text;
alter table public.organizations add column if not exists branding_logo_url text;
alter table public.organizations add column if not exists branding_logo_path text;
alter table public.organizations add column if not exists branding_address text;
alter table public.organizations add column if not exists branding_contact text;

do $$
begin
  -- Scope owner writes to the caller's own org row (restrictive, ANDs with
  -- 053's organizations_owner_write). Security-definer admin RPCs (055) run
  -- as the function owner and are unaffected.
  if not exists (select 1 from pg_policies where tablename = 'organizations' and policyname = 'organizations_write_own_org') then
    create policy organizations_write_own_org on public.organizations as restrictive for update to authenticated
      using (id = public.current_org_id()) with check (id = public.current_org_id());
  end if;
end $$;

-- 2. Lease terms --------------------------------------------------------------

create table if not exists public.lease_terms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  landowner_id uuid not null references public.landowners(id) on delete cascade,
  -- Farms this lease covers; empty = every farm linked to the landowner.
  farm_ids uuid[] not null default '{}',
  lease_type text not null check (lease_type in ('crop_share', 'cash', 'flex')),
  -- { defaultPct: 33.33 | null, byCrop: { "Corn": 33.33, ... } } — the
  -- LANDOWNER'S share % of production.
  share_terms jsonb,
  -- [{ category: 'drying'|'hauling'|'inputs'|'storage'|'other',
  --    landownerPct: 50, note }] — the landowner's % of each shared expense.
  expense_terms jsonb,
  -- { method: 'landowner_sells_own'|'operator_actual'|'reference',
  --   reference?: { description } } — how the landowner's grain is priced.
  pricing_method jsonb,
  -- { perAcre: number|null, totalAnnual: number|null } for cash / flex-base.
  cash_terms jsonb,
  -- [{ description }] — flex/bonus clauses; amounts entered at settlement.
  flex_terms jsonb,
  payment_timing text,
  notes text,
  -- The uploaded lease document (documents bucket, org-prefixed).
  source_file_url text,
  source_file_path text,
  source_file_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lease_terms_org_idx on public.lease_terms (org_id);
create index if not exists lease_terms_landowner_idx on public.lease_terms (landowner_id);

drop trigger if exists lease_terms_set_updated_at on public.lease_terms;
create trigger lease_terms_set_updated_at
  before update on public.lease_terms
  for each row execute function public.set_updated_at();

alter table public.lease_terms enable row level security;

-- 3. Settlement records -------------------------------------------------------

create table if not exists public.rent_settlements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  landowner_id uuid not null references public.landowners(id) on delete cascade,
  lease_term_id uuid references public.lease_terms(id) on delete set null,
  crop_year integer not null,
  -- The full itemized statement (lib/rent-settlement.ts SettlementStatement):
  -- sections, lines with per-figure source (account/entered/reference),
  -- totals, the branding display name used. Regenerating replaces it.
  statement jsonb not null,
  total_due numeric(14,2),
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists rent_settlements_org_idx on public.rent_settlements (org_id);
create index if not exists rent_settlements_landowner_year_idx on public.rent_settlements (landowner_id, crop_year);

alter table public.rent_settlements enable row level security;

-- 4. Policies (both tables) ---------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['lease_terms', 'rent_settlements'] loop
    -- Permissive base.
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed all') then
      execute format('create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
    -- 054 org isolation.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042 gin block (landowner finances are producer-only).
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    -- 052 viewer: no writes AND no reads (not a stakeholder surface).
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''viewer'') with check (public.app_role() <> ''viewer'')', t || '_viewer_block_all', t);
    end if;
    -- 061 agronomist: no writes AND no reads.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''agronomist'') with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_all', t);
    end if;
  end loop;
end $$;
