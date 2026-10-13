-- 0094: how each grain load was SOLD — contract, spot, or price later (2026-10-13).
-- Applied with `npx supabase db push --linked` (supabase/migrations/, like 0093).
--
-- A truckload delivered to a buyer can be applied to a CONTRACT, sold SPOT
-- (priced at the buyer's posted bid the day it was delivered — usually only
-- known when the settlement arrives), or left PRICE LATER (delayed price /
-- stored at the elevator, no price until the farmer sets one). One load can be
-- split across any mix of these — Bunge settlement 0000205995 applied 58.284
-- bu of ticket 0502289 to the last of contract 2002960604-10 and bought the
-- other 912.744 bu spot. loads.contract_id (one contract, all or nothing)
-- cannot say that, so:
--
--   * load_sales — ONE row per (load, sale kind, contract). share is the
--     fraction of the load (a load's rows sum to exactly 1, like load_splits;
--     no rows = the load is UNASSIGNED and the Contracts / Loads pages say so).
--     Bushels per row are DERIVED (share × the load's dry bushels) so an
--     allocation always reconciles to its load. buyer_net_bushels is what the
--     settlement line said for that slice; spot_price + spot_price_source
--     ('settlement' > 'entered' > 'estimate') and the est_* audit trail are
--     the spot price (lib/spot-price.ts decides; the settlement always wins).
--   * load_sales_set(load, rows) / load_sales_set_many(items) — THE writer:
--     replaces a load's rows atomically (RLS applies; security invoker).
--   * loads.contract_id is now a TRIGGER-MAINTAINED MIRROR: the contract when
--     the load is 100% on one contract, else null. Writing contract_id
--     directly (older code paths, the CSV import's bulk insert) still works —
--     the loads trigger rewrites the sale rows to match — but the app reads
--     allocations through lib/load-sales.ts, never the mirror.
--   * A deferred constraint trigger refuses a load whose shares sum to
--     anything but 0 (unassigned) or 1.
--   * Backfill: every load with a contract_id gets one 'contract' row, share
--     1, so every contract's delivered total is identical before and after.
--   * settlement_lines gains the per-LINE sale facts the parser now reads
--     from the "Contract Number: X" block a ticket prints under:
--     sale_type / contract_number_text / contract_id.
--
-- Policy stack = the loads table's (permissive authed-all, RESTRICTIVE org
-- isolation, 042 gin block, 052 viewer write-block + a read scope through the
-- viewer's visible loads, 061 agronomist block on every verb — sale prices
-- are financial, never a Yields read).

-- 1. The table ----------------------------------------------------------------

create table if not exists public.load_sales (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  load_id uuid not null references public.loads(id) on delete cascade,
  sale_type text not null check (sale_type in ('contract', 'spot', 'price_later')),
  -- RESTRICT: a contract with sale rows cannot be deleted (Settings → Contracts
  -- already refuses with a count; a silent cascade would leave a split load's
  -- shares summing short).
  contract_id uuid references public.contracts(id) on delete restrict,
  share numeric(14,12) not null check (share > 0 and share <= 1),
  buyer_net_bushels numeric(12,3),
  spot_price numeric(12,6),
  spot_price_source text check (spot_price_source in ('settlement', 'entered', 'estimate')),
  est_futures_price numeric(12,6),
  est_futures_symbol text,
  est_basis numeric(12,6),
  settlement_line_id uuid references public.settlement_lines(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint load_sales_contract_when_contract check (
    (sale_type = 'contract' and contract_id is not null)
    or (sale_type <> 'contract' and contract_id is null)
  )
);

create index if not exists load_sales_org_load_idx on public.load_sales (org_id, load_id);
create index if not exists load_sales_load_idx on public.load_sales (load_id);
create index if not exists load_sales_contract_idx on public.load_sales (contract_id) where contract_id is not null;
create index if not exists load_sales_settlement_line_idx on public.load_sales (settlement_line_id) where settlement_line_id is not null;
-- One row per kind per load (one spot row, one price-later row, one row per contract).
create unique index if not exists load_sales_one_per_kind
  on public.load_sales (load_id, sale_type, coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid));

drop trigger if exists load_sales_set_updated_at on public.load_sales;
create trigger load_sales_set_updated_at
  before update on public.load_sales
  for each row execute function public.set_updated_at();

alter table public.load_sales enable row level security;

-- 2. Policies -----------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'load_sales' and policyname = 'authed all') then
    create policy "authed all" on public.load_sales for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'load_sales' and policyname = 'load_sales_org_isolation') then
    create policy load_sales_org_isolation on public.load_sales as restrictive for all to authenticated
      using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());
  end if;
  -- 042 gin block.
  if not exists (select 1 from pg_policies where tablename = 'load_sales' and policyname = 'load_sales_owner_only') then
    create policy load_sales_owner_only on public.load_sales as restrictive for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;
  -- 052 viewer: no writes; reads scoped to the loads the viewer can already see
  -- (the loads policy scopes by granted field, so the subquery inherits it).
  if not exists (select 1 from pg_policies where tablename = 'load_sales' and policyname = 'load_sales_viewer_block_ins') then
    create policy load_sales_viewer_block_ins on public.load_sales as restrictive for insert to authenticated with check (public.app_role() <> 'viewer');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'load_sales' and policyname = 'load_sales_viewer_block_upd') then
    create policy load_sales_viewer_block_upd on public.load_sales as restrictive for update to authenticated using (public.app_role() <> 'viewer');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'load_sales' and policyname = 'load_sales_viewer_block_del') then
    create policy load_sales_viewer_block_del on public.load_sales as restrictive for delete to authenticated using (public.app_role() <> 'viewer');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'load_sales' and policyname = 'load_sales_viewer_scope') then
    create policy load_sales_viewer_scope on public.load_sales as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or load_id in (select id from public.loads));
  end if;
  -- 061 agronomist: sale prices are financial — no reads, no writes.
  if not exists (select 1 from pg_policies where tablename = 'load_sales' and policyname = 'load_sales_agronomist_block_all') then
    create policy load_sales_agronomist_block_all on public.load_sales as restrictive for all to authenticated
      using (public.app_role() <> 'agronomist') with check (public.app_role() <> 'agronomist');
  end if;
end $$;

-- 3. Shares sum to 1 (or the load has no rows) ---------------------------------

create or replace function public.load_sales_check_shares()
returns trigger language plpgsql as $$
declare
  v_load uuid := coalesce(new.load_id, old.load_id);
  v_sum numeric;
begin
  select coalesce(sum(share), 0) into v_sum from public.load_sales where load_id = v_load;
  if v_sum <> 0 and abs(v_sum - 1) > 0.000001 then
    raise exception 'load_sales: the sale shares of load % sum to % — they must sum to exactly 1', v_load, v_sum
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists load_sales_shares_sum_to_one on public.load_sales;
create constraint trigger load_sales_shares_sum_to_one
  after insert or update or delete on public.load_sales
  deferrable initially deferred
  for each row execute function public.load_sales_check_shares();

-- 4. loads.contract_id as a mirror ---------------------------------------------

-- The contract a load is 100% on (exactly one row, a contract row, share 1),
-- else null. STABLE: reads load_sales as the caller (RLS applies).
create or replace function public.load_sales_mirror_contract(p_load uuid)
returns uuid language sql stable as $$
  select case
    when count(*) = 1 and bool_and(sale_type = 'contract') and abs(sum(share) - 1) <= 0.000001
      then min(contract_id::text)::uuid
    else null end
  from public.load_sales where load_id = p_load;
$$;

-- load_sales → loads: keep the mirror column in step.
create or replace function public.load_sales_sync_load()
returns trigger language plpgsql as $$
declare
  v_load uuid := coalesce(new.load_id, old.load_id);
  v_mirror uuid;
begin
  v_mirror := public.load_sales_mirror_contract(v_load);
  perform set_config('load_sales.syncing', '1', true);
  update public.loads set contract_id = v_mirror
    where id = v_load and contract_id is distinct from v_mirror;
  perform set_config('load_sales.syncing', '0', true);
  return null;
end $$;

drop trigger if exists load_sales_sync_load on public.load_sales;
create trigger load_sales_sync_load
  after insert or update or delete on public.load_sales
  for each row execute function public.load_sales_sync_load();

-- loads → load_sales: a direct write of contract_id (older code, the CSV
-- import's bulk insert, the assistant) rewrites the sale rows to match —
-- a contract means "all of this load on that one contract"; null means the
-- load is unassigned (a split with a null mirror is left alone).
create or replace function public.loads_sync_sales()
returns trigger language plpgsql as $$
declare
  v_mirror uuid;
begin
  if coalesce(current_setting('load_sales.syncing', true), '0') = '1' then return null; end if;
  v_mirror := public.load_sales_mirror_contract(new.id);
  if new.contract_id is not distinct from v_mirror then return null; end if;
  if new.contract_id is not null then
    delete from public.load_sales where load_id = new.id;
    insert into public.load_sales (org_id, load_id, sale_type, contract_id, share)
      values (new.org_id, new.id, 'contract', new.contract_id, 1);
  elsif v_mirror is not null then
    -- Was fully on one contract; the caller cleared it → unassigned.
    delete from public.load_sales where load_id = new.id;
  end if;
  return null;
end $$;

drop trigger if exists loads_sync_sales on public.loads;
create trigger loads_sync_sales
  after insert or update of contract_id on public.loads
  for each row execute function public.loads_sync_sales();

-- 5. THE writer ----------------------------------------------------------------

-- Replace a load's sale rows in one transaction. p_rows: a JSON array of
-- { sale_type, contract_id?, share, buyer_net_bushels?, spot_price?,
--   spot_price_source?, est_futures_price?, est_futures_symbol?, est_basis?,
--   settlement_line_id? }. An empty array makes the load unassigned.
-- Security invoker: RLS on load_sales / loads applies to the caller.
create or replace function public.load_sales_set(p_load_id uuid, p_rows jsonb)
returns setof public.load_sales language plpgsql as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.loads where id = p_load_id;
  if v_org is null then
    raise exception 'load_sales_set: load % not found', p_load_id using errcode = 'no_data_found';
  end if;
  delete from public.load_sales where load_id = p_load_id;
  insert into public.load_sales (
    org_id, load_id, sale_type, contract_id, share, buyer_net_bushels,
    spot_price, spot_price_source, est_futures_price, est_futures_symbol, est_basis, settlement_line_id
  )
  select
    v_org, p_load_id,
    r->>'sale_type',
    nullif(r->>'contract_id', '')::uuid,
    (r->>'share')::numeric,
    nullif(r->>'buyer_net_bushels', '')::numeric,
    nullif(r->>'spot_price', '')::numeric,
    nullif(r->>'spot_price_source', ''),
    nullif(r->>'est_futures_price', '')::numeric,
    nullif(r->>'est_futures_symbol', ''),
    nullif(r->>'est_basis', '')::numeric,
    nullif(r->>'settlement_line_id', '')::uuid
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r;
  return query select * from public.load_sales where load_id = p_load_id order by sale_type, contract_id;
end $$;

-- Many loads at once: p_items = [{ "load_id": uuid, "rows": [...] }, ...].
create or replace function public.load_sales_set_many(p_items jsonb)
returns integer language plpgsql as $$
declare
  it jsonb;
  n integer := 0;
begin
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    perform public.load_sales_set((it->>'load_id')::uuid, coalesce(it->'rows', '[]'::jsonb));
    n := n + 1;
  end loop;
  return n;
end $$;

grant execute on function public.load_sales_set(uuid, jsonb) to authenticated;
grant execute on function public.load_sales_set_many(jsonb) to authenticated;
grant execute on function public.load_sales_mirror_contract(uuid) to authenticated;

-- 6. Backfill: every load on a contract gets one full-share contract row -----------

insert into public.load_sales (org_id, load_id, sale_type, contract_id, share)
select l.org_id, l.id, 'contract', l.contract_id, 1
from public.loads l
where l.contract_id is not null
  and not exists (select 1 from public.load_sales s where s.load_id = l.id);

-- 7. settlement_lines: the per-line sale facts -------------------------------------

alter table public.settlement_lines add column if not exists sale_type text
  check (sale_type is null or sale_type in ('contract', 'spot', 'price_later'));
alter table public.settlement_lines add column if not exists contract_number_text text;
alter table public.settlement_lines add column if not exists contract_id uuid references public.contracts(id) on delete set null;
create index if not exists settlement_lines_contract_idx on public.settlement_lines (contract_id) where contract_id is not null;

-- 8. Tenant bookkeeping: 053/054's arrays + verify_053/054 list load_sales in the
-- repo; the digest (scripts/build-assistant-schema.mjs) reads this file for the
-- table's columns.
