-- 074: Settlement discount itemization + buyer discount schedules.
-- Idempotent: safe to re-run.
--
-- Three tables behind the settlement Discounts block and the Buyer Discount
-- Comparison report:
--
--   1. settlement_discount_items — the statement's own discount/deduction
--      lines, itemized per settlement into a fixed category set (moisture
--      shrink, drying, test weight, damage, …). AI-extracted from the
--      settlement upload or entered by hand on the settlement detail page.
--      The settlement_lines.discounts totals stay authoritative — items are
--      the breakdown, checked against that sum in the UI.
--
--   2. buyer_discount_schedules — one uploaded/confirmed discount sheet per
--      buyer × crop × effective date (document_type 'discount_schedule'),
--      with the schedule's own text preserved. Effective dates matter:
--      schedules change with conditions, and the expected-vs-actual audit
--      uses the schedule in force at each settlement's date.
--
--   3. buyer_discount_schedule_rules — the structured per-factor rules of a
--      schedule: basis (weight-shrink % | ¢/bu | % of price), base/threshold,
--      direction, linear rate or tier brackets (jsonb), cumulative flag,
--      rejection point. lib/discount-schedules.ts applies them to a load's
--      moisture/test weight.
--
-- Multi-tenant conventions (053/054): org_id NOT NULL with the
-- current_org_id()/default_org_id() default, RESTRICTIVE org isolation,
-- gin block (042 — grain tables), viewer WRITE-blocks only (052 — the
-- Buyer Discount Comparison report is a viewer surface, scoped in-app via
-- entity grants, so viewers keep SELECT like settlements/settlement_lines),
-- agronomist write-blocks AND select-block (061 — financial, not Yields).
-- All three tables are added to the tenant arrays in 053/054 and the verify
-- scripts.

create extension if not exists "pgcrypto";

-- 1. Itemized settlement discounts --------------------------------------------

create table if not exists public.settlement_discount_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  settlement_id uuid not null references public.settlements(id) on delete cascade,
  category text not null check (category in (
    'moisture_shrink', 'drying', 'test_weight', 'damage', 'heat_damage',
    'foreign_material', 'dockage', 'splits', 'sprout', 'musty_sour', 'other')),
  -- The statement's own wording for the line ("DRYING CHG", "TW DISC").
  description text,
  -- Total dollars deducted for this item (positive = a deduction).
  amount numeric(14,2) not null default 0,
  -- The rate as printed, e.g. "4¢/lb under 54" — display only.
  rate_note text,
  -- What the rate applied to, e.g. "1,024.5 bu at 17.2%" — display only.
  quantity_basis text,
  created_at timestamptz not null default now()
);

create index if not exists settlement_discount_items_org_idx
  on public.settlement_discount_items (org_id);
create index if not exists settlement_discount_items_settlement_idx
  on public.settlement_discount_items (settlement_id);

alter table public.settlement_discount_items enable row level security;

-- 2. Buyer discount schedules -------------------------------------------------

create table if not exists public.buyer_discount_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  buyer_id uuid not null references public.buyers(id) on delete cascade,
  crop_id uuid not null references public.crops(id) on delete cascade,
  -- The date the schedule takes effect; the audit picks, per settlement, the
  -- newest schedule dated on/before the settlement date.
  effective_date date not null,
  -- Faithful transcription of the printed discount terms (the review screen
  -- shows it; the audit's "per their own sheet" claim traces back to it).
  schedule_text text,
  source_pdf_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists buyer_discount_schedules_org_idx
  on public.buyer_discount_schedules (org_id);
create index if not exists buyer_discount_schedules_buyer_idx
  on public.buyer_discount_schedules (buyer_id, crop_id, effective_date desc);

drop trigger if exists buyer_discount_schedules_set_updated_at on public.buyer_discount_schedules;
create trigger buyer_discount_schedules_set_updated_at
  before update on public.buyer_discount_schedules
  for each row execute function public.set_updated_at();

alter table public.buyer_discount_schedules enable row level security;

-- 3. Per-factor rules ---------------------------------------------------------

create table if not exists public.buyer_discount_schedule_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  schedule_id uuid not null references public.buyer_discount_schedules(id) on delete cascade,
  factor text not null check (factor in (
    'moisture_shrink', 'drying', 'test_weight', 'damage', 'heat_damage',
    'foreign_material', 'dockage', 'splits', 'sprout', 'musty_sour', 'other')),
  -- How the charge is expressed: a % of weight shrunk off, a ¢/bu price
  -- discount, or a % of the price.
  basis text not null check (basis in ('weight_shrink_pct', 'cents_per_bu', 'pct_of_price')),
  -- Threshold where charges begin (15 for 15% moisture, 54 for 54 lb TW).
  base_value numeric(8,3),
  -- 'above': charges as the measurement rises past base (moisture, damage).
  -- 'below': charges as it falls (test weight).
  direction text not null default 'above' check (direction in ('above', 'below')),
  -- Linear rules: charge per unit past base, in the basis units per POINT/LB
  -- (a printed "2.5¢ per half point" is stored as 5 per point). Null = tiered.
  rate_per_unit numeric(10,4),
  -- Tier brackets: [{ "from": 54.0, "to": 54.9, "rate": 4 }] in measurement
  -- order; rate in basis units. lib/discount-schedules.ts walks them.
  tiers jsonb not null default '[]',
  -- True when bracket charges STACK as grain passes through successive tiers;
  -- false when a bracket's printed rate is the whole charge.
  cumulative boolean not null default false,
  -- Measurement at/past which the buyer rejects (null = none stated).
  rejection_at numeric(8,3),
  -- The schedule's own wording for this factor.
  note text,
  created_at timestamptz not null default now()
);

create index if not exists buyer_discount_schedule_rules_org_idx
  on public.buyer_discount_schedule_rules (org_id);
create index if not exists buyer_discount_schedule_rules_schedule_idx
  on public.buyer_discount_schedule_rules (schedule_id);

alter table public.buyer_discount_schedule_rules enable row level security;

-- 4. Policies (all three tables) ----------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['settlement_discount_items', 'buyer_discount_schedules', 'buyer_discount_schedule_rules'] loop
    -- Base permissive policy (mirrors every other tenant table).
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed all') then
      execute format('create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
    -- 054 org isolation.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042 pattern: grain tables are fully blocked for gin users.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    -- 052 pattern: viewers are write-blocked (reads stay — the Buyer Discount
    -- Comparison report is viewer-included, scoped in-app by entity grants,
    -- matching settlements/settlement_lines which carry no viewer block).
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
