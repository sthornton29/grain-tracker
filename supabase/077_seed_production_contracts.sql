-- 077: Seed production contracts (seed soybeans first).
-- Idempotent: safe to re-run.
--
-- Models an acreage-based seed grower agreement (the 2026 Bayer Soybean Seed
-- Grower Agreement, Southern Exhibit C, is the reference shape): the grower
-- commits ACRES (not bushels) to a seed company, prices the crop on the
-- grower's own timing against a named local market elevator, earns an
-- outcome-dependent premium stack on top of the elected price, and is paid
-- in stages (80% base after delivery/pricing, the final 20% plus premiums at
-- final settlement, storage pay monthly, a usage/tech fee netted out).
--
--   1. contracts.contract_kind — 'grain' (default, today's forward/HTA/basis
--      book) | 'seed_production'. A seed contract still lives in contracts
--      (buyer_id, crop_id, entity_id, crop_year, contract_number — 051
--      attribution applies unchanged); everything seed-specific hangs off it.
--
--   2. seed_contract_details — one row per seed contract (contract_id
--      unique): production site, brand/variety (resolved through the variety
--      pipeline at entry), contract_acres + forecast_bu_per_acre with
--      estimated_bushels GENERATED (acres × forecast), the named local
--      market elevator the pricing quotes come from, the pricing deadline
--      (the agreement's default Selection Date), premium cap $/bu, storage
--      pay terms, usage fee $/bu, the user-settable expected_outcome that
--      drives every projection (default 'accepted'), and an estimated
--      final-settlement date for cash-flow staging.
--
--   3. seed_contract_premiums — the premium schedule rows: outcome ×
--      component × $/bu, with applies_to 'all' | 'irrigated_only' (the
--      irrigated production premium pays on irrigated bushels only).
--
--   4. seed_pricing_elections — the grower-timed pricing ledger: each
--      election prices a 25/50/75/100% increment of the contract bushels at
--      the elected Market or Target price (cumulative ≤ 100% enforced in
--      the app; the DB pins the increment values).
--
--   5. seed_contract_payments — the staged-payment ledger: base_80 /
--      base_final / premium / storage / usage_fee (negative) / other, each
--      projected or received.
--
--   6. seed_contract_plantings — junction to field_plantings: the committed
--      acres are real fields, so committed production = those plantings'
--      production (estimated until harvest, actual after — the existing
--      production seams).
--
-- All five new tables are tenant tables with the full 053/054/042/052/061
-- policy stack inline (074 pattern: viewer WRITE-blocks only — marketing/
-- cash-flow reports are viewer surfaces, scoped in-app by entity grants like
-- contracts themselves; agronomists blocked from writes AND reads).

create extension if not exists "pgcrypto";

-- 1. contracts.contract_kind ---------------------------------------------------

alter table public.contracts add column if not exists contract_kind text not null default 'grain';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contracts_contract_kind_check') then
    alter table public.contracts add constraint contracts_contract_kind_check
      check (contract_kind in ('grain', 'seed_production'));
  end if;
end $$;

-- 2. seed_contract_details -----------------------------------------------------

create table if not exists public.seed_contract_details (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  -- "Hurt Seed Company, Halls TN" — the seed company's receiving/production site.
  production_site text,
  -- The seed product, e.g. 'AG55XF5'. Entered through the variety pipeline so
  -- the spelling matches the plantings' variety rows.
  brand text,
  variety text,
  contract_acres numeric not null check (contract_acres > 0),
  forecast_bu_per_acre numeric not null check (forecast_bu_per_acre > 0),
  -- The agreement's estimated quantity: acres × forecast.
  estimated_bushels numeric generated always as (contract_acres * forecast_bu_per_acre) stored,
  -- The named local market the elections quote against, e.g. 'Bunge Decatur AL'.
  local_market_elevator text,
  -- The agreement's default Selection Date — price everything by this date.
  pricing_deadline date,
  premium_cap_per_bu numeric check (premium_cap_per_bu >= 0),
  storage_pay_per_bu_month numeric check (storage_pay_per_bu_month >= 0),
  storage_pay_start_date date,
  -- Per-bushel usage/technology fee netted out of the settlement.
  usage_fee_per_bu numeric not null default 0 check (usage_fee_per_bu >= 0),
  -- The projection assumption: which outcome the premium stack is valued at.
  expected_outcome text not null default 'accepted' check (expected_outcome in
    ('accepted', 'released_post_harvest', 'released_pre_harvest', 'rejected')),
  -- Estimated final-settlement date (final 20% + premiums land here in the
  -- Cash Flow projection; the agreement pays "by ~March").
  final_settlement_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists seed_contract_details_org_idx on public.seed_contract_details (org_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'seed_contract_details_contract_unique') then
    alter table public.seed_contract_details add constraint seed_contract_details_contract_unique
      unique (org_id, contract_id);
  end if;
end $$;

drop trigger if exists seed_contract_details_set_updated_at on public.seed_contract_details;
create trigger seed_contract_details_set_updated_at
  before update on public.seed_contract_details
  for each row execute function public.set_updated_at();

-- 3. seed_contract_premiums ----------------------------------------------------

create table if not exists public.seed_contract_premiums (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  -- Which acceptance outcome this component pays under.
  outcome text not null check (outcome in
    ('accepted', 'released_post_harvest', 'released_pre_harvest', 'rejected')),
  component text not null,
  amount_per_bu numeric not null check (amount_per_bu >= 0),
  -- The irrigated production premium pays on irrigated bushels only.
  applies_to text not null default 'all' check (applies_to in ('all', 'irrigated_only')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists seed_contract_premiums_org_idx on public.seed_contract_premiums (org_id);
create index if not exists seed_contract_premiums_contract_idx on public.seed_contract_premiums (contract_id);

-- 4. seed_pricing_elections ----------------------------------------------------

create table if not exists public.seed_pricing_elections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  election_date date not null,
  -- The agreement prices in 25% increments; cumulative ≤ 100% is validated
  -- in the app (the sum is a cross-row rule).
  pct_of_bushels numeric not null check (pct_of_bushels in (25, 50, 75, 100)),
  price_per_bu numeric not null check (price_per_bu > 0),
  method text not null default 'market' check (method in ('market', 'target')),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists seed_pricing_elections_org_idx on public.seed_pricing_elections (org_id);
create index if not exists seed_pricing_elections_contract_idx on public.seed_pricing_elections (contract_id);

-- 5. seed_contract_payments ----------------------------------------------------

create table if not exists public.seed_contract_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  payment_type text not null check (payment_type in
    ('base_80', 'base_final', 'premium', 'storage', 'usage_fee', 'other')),
  -- Dollars. The usage fee is entered NEGATIVE (it nets out of the check).
  amount numeric not null,
  payment_date date,
  status text not null default 'projected' check (status in ('projected', 'received')),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists seed_contract_payments_org_idx on public.seed_contract_payments (org_id);
create index if not exists seed_contract_payments_contract_idx on public.seed_contract_payments (contract_id);

-- 6. seed_contract_plantings ---------------------------------------------------

create table if not exists public.seed_contract_plantings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  planting_id uuid not null references public.field_plantings(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists seed_contract_plantings_org_idx on public.seed_contract_plantings (org_id);
create index if not exists seed_contract_plantings_contract_idx on public.seed_contract_plantings (contract_id);
create index if not exists seed_contract_plantings_planting_idx on public.seed_contract_plantings (planting_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'seed_contract_plantings_unique') then
    alter table public.seed_contract_plantings add constraint seed_contract_plantings_unique
      unique (org_id, contract_id, planting_id);
  end if;
end $$;

-- 7. Policy stack (074 loop pattern) -------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'seed_contract_details', 'seed_contract_premiums', 'seed_pricing_elections',
    'seed_contract_payments', 'seed_contract_plantings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- Base permissive policy (mirrors every other tenant table).
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed all') then
      execute format('create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
    -- 054 org isolation.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042 pattern: grain-marketing tables are fully blocked for gin users.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    -- 052 pattern: viewers are write-blocked (marketing reports are viewer
    -- surfaces; reads are scoped in-app by entity grants like contracts).
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''viewer'')', t || '_viewer_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_del', t);
    end if;
    -- 061 agronomist: write-blocked AND select-blocked (money, not Yields).
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_del', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_sel') then
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.app_role() <> ''agronomist'')', t || '_agronomist_block_sel', t);
    end if;
  end loop;
end $$;
