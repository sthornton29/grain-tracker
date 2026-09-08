-- 082: Manual price quotes — the fallback for contracts without live coverage.
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- The Barchart CME Ag package quotes corn, soybeans, and wheat live but NOT
-- ICE Cotton No. 2 (CT), so every cotton surface — the price board, marketing
-- valuation of unpriced lint, the Income Sensitivity axis, hedge P&L — has had
-- nothing to price against. A manual quote fills that hole: ONE per contract
-- symbol per organization, entered where the missing price shows, and read
-- through the same seam every live quote already rides (/api/market-prices →
-- lib/quote-resolution.ts): live quote if the fetch succeeds → else the
-- stored manual quote → else no quote. Live coverage returning for a symbol
-- outranks the manual row automatically; the manual row stays as fallback.
--
--   1. market_prices (the GLOBAL end-of-day cache, 018/054) gains provenance:
--        source     — 'live' (Barchart) for every row it has ever held
--        entered_at — when a human typed a price (null on live rows)
--      Manual quotes do NOT live in this table: it is global and keyed by
--      (symbol, date), while a manual quote is per ORGANIZATION per symbol
--      (two farms may type different CTZ26 prices on the same day). They get
--      their own tenant table:
--   2. manual_market_quotes — org_id, contract_symbol (unique per org: editing
--      replaces), price in the commodity's NATIVE unit exactly as market_prices
--      stores it ($/bu grains; ¢/lb cotton — the app's one cotton unit
--      boundary, lib/hedging.ts normalizeBarchartPrice/parseCottonPriceInput),
--      entered_at (the date the chip shows: "manual · 9/2"; > 7 days amber,
--      > 30 red), source always 'manual'.
--
-- Full 053/054/042/052/061 policy stack inline (079 template): org-isolated,
-- gin blocked, viewers write-blocked (viewers may READ — the reports they see
-- price off these quotes), agronomists blocked outright.

-- 1. Provenance on the live cache ---------------------------------------------

alter table public.market_prices
  add column if not exists source text not null default 'live' check (source in ('live', 'manual')),
  add column if not exists entered_at timestamptz;

-- 2. manual_market_quotes ------------------------------------------------------

create table if not exists public.manual_market_quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  contract_symbol text not null,                  -- e.g. 'CTZ26'
  price numeric(12,6) not null check (price > 0), -- native unit: $/bu grains, ¢/lb cotton
  source text not null default 'manual' check (source = 'manual'),
  entered_at timestamptz not null default now(),
  entered_by uuid,                                -- auth.users.id (informational)
  note text,                                      -- e.g. 'statement close 9/1'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists manual_market_quotes_org_symbol_idx on public.manual_market_quotes (org_id, contract_symbol);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'manual_market_quotes_org_symbol_unique') then
    alter table public.manual_market_quotes add constraint manual_market_quotes_org_symbol_unique unique (org_id, contract_symbol);
  end if;
end $$;

drop trigger if exists manual_market_quotes_set_updated_at on public.manual_market_quotes;
create trigger manual_market_quotes_set_updated_at
  before update on public.manual_market_quotes
  for each row execute function public.set_updated_at();

-- 3. Policy stack (079 loop pattern) -------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['manual_market_quotes'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed all') then
      execute format('create policy "authed all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
    -- 054 org isolation.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042: grain-operation table, gin users blocked.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    -- 052: viewers read (their reports price off these), never write.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''viewer'')', t || '_viewer_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_del', t);
    end if;
    -- 061 agronomist: not a Yields surface — blocked entirely.
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
