-- 083: Position rolls as first-class linked events + the hedging event ledger.
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- A ROLL closes one futures leg and opens the next month's leg in the same
-- crop's hedge (DEC 26 → MAR 27). Until now the two halves were unrelated rows
-- and the new leg asked for its crop year again. Now:
--
--   1. futures_positions gains the linkage + provenance columns
--        roll_group_id            — shared by the closed leg(s) and the leg
--                                   they rolled into (one roll = one group)
--        rolled_from_position_id  — the new leg → the closed leg it came
--                                   from; chains DEC→MAR→MAY share a lineage
--        execution_code           — the statement's trade code on the fill
--                                   (E electronic, S spread, SE spread
--                                   electronic); display/detection only
--        partial_close_of         — a closed row spun off a larger open
--                                   position by a partial close → its parent
--        import_statement_date/ref — the brokerage statement that last
--                                   touched the row (import or close)
--      and 'roll_action' joins the source vocabulary.
--
--   2. hedge_position_events — the APPEND-ONLY ledger. One row per mutation
--      of a futures position: opened / closed / partial_close / roll_close /
--      roll_open / edited / deleted / crop_year_changed / imported, with the
--      trade date, when it was recorded, who did it, the source (statement
--      import + statement date/reference, manual, roll action, backfill),
--      quantity / price / fees / realized P&L where they apply, and full
--      before/after snapshots. Row-level security allows SELECT and INSERT
--      only — nothing updates or deletes a ledger row.
--
--   3. hedge_position_event_trigger — an AFTER INSERT/UPDATE/DELETE trigger
--      on futures_positions that classifies every change and appends the
--      event. EVERY mutation path appends — the app's forms, the statement
--      import, the roll RPC, the partner API, even a hand edit in this SQL
--      editor — because the database does it, not the caller. A no-op
--      UPDATE (nothing but updated_at changed) appends nothing.
--      Context the row can't carry (a roll executed from a statement vs by
--      hand, the statement reference) rides transaction-local settings the
--      roll RPC sets (turnrow.hedge_event_source / _statement_date / _ref).
--
--   4. hedge_execute_roll(payload) — ONE transaction for the close + the
--      open + the linkage (+ inherited crop year and entity). Used by the
--      manual "Roll…" action and the statement import's roll confirmation.
--      SECURITY INVOKER: the caller's RLS applies to every row it writes.
--
--   5. Backfill: every existing position gets an 'opened' event (and a
--      'closed' one when closed) dated from its own trade/close dates,
--      source 'backfill', so the history reads whole from day one.
--
-- Full 053/054/042/052/061 policy stack inline (082 template) on the new
-- table: org-isolated, gin blocked, viewers blocked from reading (the ledger
-- carries whole-book snapshots the viewer attribution cannot scale) and from
-- writing, agronomists blocked outright.

-- 1. futures_positions: roll linkage + provenance ------------------------------

alter table public.futures_positions
  add column if not exists roll_group_id uuid,
  add column if not exists rolled_from_position_id uuid references public.futures_positions(id) on delete set null,
  add column if not exists execution_code text,
  add column if not exists partial_close_of uuid references public.futures_positions(id) on delete set null,
  add column if not exists import_statement_date date,
  add column if not exists import_statement_ref text;

do $$ begin
  alter table public.futures_positions drop constraint if exists futures_positions_source_check;
  alter table public.futures_positions
    add constraint futures_positions_source_check check (source in ('manual', 'statement_import', 'roll_action'));
end $$;

create index if not exists futures_positions_roll_group_idx
  on public.futures_positions (roll_group_id) where roll_group_id is not null;
create index if not exists futures_positions_rolled_from_idx
  on public.futures_positions (rolled_from_position_id) where rolled_from_position_id is not null;

-- 2. hedge_position_events (append-only) ----------------------------------------

create table if not exists public.hedge_position_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  position_id uuid not null,                  -- no FK: a deleted position keeps its history
  related_position_id uuid,                   -- roll counterpart / partial-close parent
  roll_group_id uuid,
  event_type text not null check (event_type in (
    'opened', 'closed', 'partial_close', 'roll_close', 'roll_open',
    'edited', 'deleted', 'crop_year_changed', 'imported')),
  occurred_at date not null,                  -- the trade date the event is about
  recorded_at timestamptz not null default now(),
  source text not null check (source in ('statement_import', 'manual', 'roll_action', 'backfill')),
  statement_date date,
  statement_ref text,                         -- e.g. 'StoneX'
  actor_user_id uuid,
  actor_email text,
  -- Denormalized identity so the timeline filters and reads after a delete.
  entity_id uuid,
  commodity text,
  contract_month text,
  contract_symbol text,
  side text,
  crop_year integer,
  quantity integer,
  price numeric(12,6),                        -- entry price (open events) or the leg's entry
  close_price numeric(12,6),                  -- closing events
  fees numeric(12,2),
  realized_pnl numeric(14,2),                 -- closing events (gross, as the row stores it)
  before_snapshot jsonb,
  after_snapshot jsonb,
  note text
);

create index if not exists hedge_position_events_org_time_idx
  on public.hedge_position_events (org_id, occurred_at desc, recorded_at desc);
create index if not exists hedge_position_events_position_idx
  on public.hedge_position_events (position_id);
create index if not exists hedge_position_events_roll_group_idx
  on public.hedge_position_events (roll_group_id) where roll_group_id is not null;

do $$
declare t text;
begin
  foreach t in array array['hedge_position_events'] loop
    execute format('alter table public.%I enable row level security', t);
    -- Append-only: SELECT + INSERT for the authenticated role, NO update/delete
    -- policy at all (RLS enabled + no policy = denied). Deliberately NOT the
    -- usual "authed all".
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed read') then
      execute format('create policy "authed read" on public.%I for select to authenticated using (true)', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'authed append') then
      execute format('create policy "authed append" on public.%I for insert to authenticated with check (true)', t);
    end if;
    -- 054 org isolation.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042: grain-operation table, gin users blocked.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    -- 052: viewers neither read (whole-book snapshots) nor write.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_sel') then
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_sel', t);
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

-- 3. The ledger trigger --------------------------------------------------------
--
-- Classification (TG_OP × what changed):
--   INSERT  rolled_from_position_id set → roll_open
--           partial_close_of set        → partial_close (the spun-off closed lot)
--           status closed               → imported (statement) / closed (other)
--           else                        → opened
--   UPDATE  open → closed               → roll_close when a roll group was just
--                                         attached, else closed
--           roll group just attached    → roll_open (new leg linked) / roll_close
--                                         (an already-closed leg linked)
--           crop_year changed           → crop_year_changed
--           anything else               → edited (note when contracts dropped
--                                         on an open row = a partial close)
--   DELETE                              → deleted
-- Source: the transaction-local setting turnrow.hedge_event_source when a
-- roll RPC set it; else 'statement_import' when the row carries a statement
-- date the change introduced; else the row's own source on INSERT; else
-- 'manual'. SECURITY DEFINER so the append never depends on the caller's
-- policies (the change it records was already permitted).

create or replace function public.hedge_position_event_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev text;
  occ date;
  src text;
  gsrc text := nullif(current_setting('turnrow.hedge_event_source', true), '');
  gdate date := nullif(current_setting('turnrow.hedge_statement_date', true), '')::date;
  gref text := nullif(current_setting('turnrow.hedge_statement_ref', true), '');
  sdate date;
  sref text;
  qty integer;
  px numeric;
  cpx numeric;
  fees numeric;
  rp numeric;
  rel uuid;
  nt text;
  actor uuid := auth.uid();
  actor_mail text := nullif(coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''), '');
  o jsonb;
  n jsonb;
begin
  if tg_op = 'DELETE' then
    o := to_jsonb(OLD) - 'updated_at';
    insert into public.hedge_position_events
      (org_id, position_id, related_position_id, roll_group_id, event_type, occurred_at, source,
       statement_date, statement_ref, actor_user_id, actor_email,
       entity_id, commodity, contract_month, contract_symbol, side, crop_year,
       quantity, price, close_price, fees, realized_pnl, before_snapshot, after_snapshot, note)
    values
      (OLD.org_id, OLD.id, coalesce(OLD.partial_close_of, OLD.rolled_from_position_id), OLD.roll_group_id, 'deleted', current_date, coalesce(gsrc, 'manual'),
       gdate, gref, actor, actor_mail,
       OLD.entity_id, OLD.commodity, OLD.contract_month, OLD.contract_symbol, OLD.side, OLD.crop_year,
       OLD.num_contracts, OLD.trade_price, OLD.close_price, OLD.commission, OLD.realized_pnl, o, null, null);
    return OLD;
  end if;

  n := to_jsonb(NEW) - 'updated_at';

  if tg_op = 'INSERT' then
    if NEW.rolled_from_position_id is not null then
      ev := 'roll_open'; occ := NEW.trade_date; qty := NEW.num_contracts; px := NEW.trade_price; fees := NEW.commission; rel := NEW.rolled_from_position_id;
    elsif NEW.partial_close_of is not null then
      ev := 'partial_close'; occ := coalesce(NEW.close_date, NEW.trade_date); qty := NEW.num_contracts; px := NEW.trade_price; cpx := NEW.close_price; fees := NEW.commission; rp := NEW.realized_pnl; rel := NEW.partial_close_of;
    elsif NEW.status = 'closed' then
      ev := case when NEW.source = 'statement_import' then 'imported' else 'closed' end;
      occ := coalesce(NEW.close_date, NEW.trade_date); qty := NEW.num_contracts; px := NEW.trade_price; cpx := NEW.close_price; fees := NEW.commission; rp := NEW.realized_pnl;
    else
      ev := 'opened'; occ := NEW.trade_date; qty := NEW.num_contracts; px := NEW.trade_price; fees := NEW.commission;
    end if;
    src := coalesce(gsrc, case NEW.source when 'statement_import' then 'statement_import' when 'roll_action' then 'roll_action' else 'manual' end);
    sdate := coalesce(gdate, NEW.import_statement_date);
    sref := coalesce(gref, NEW.import_statement_ref);
    insert into public.hedge_position_events
      (org_id, position_id, related_position_id, roll_group_id, event_type, occurred_at, source,
       statement_date, statement_ref, actor_user_id, actor_email,
       entity_id, commodity, contract_month, contract_symbol, side, crop_year,
       quantity, price, close_price, fees, realized_pnl, before_snapshot, after_snapshot, note)
    values
      (NEW.org_id, NEW.id, rel, NEW.roll_group_id, ev, occ, src,
       sdate, sref, actor, actor_mail,
       NEW.entity_id, NEW.commodity, NEW.contract_month, NEW.contract_symbol, NEW.side, NEW.crop_year,
       qty, px, cpx, fees, rp, null, n, null);
    return NEW;
  end if;

  -- UPDATE
  o := to_jsonb(OLD) - 'updated_at';
  if o = n then
    return NEW; -- nothing changed: no event
  end if;

  -- "A roll group was just attached" — including a leg that was CREATED by an
  -- earlier roll (its group id moves from the roll that opened it to the roll
  -- that closes it: DEC→MAR→MAY chains).
  if OLD.status = 'open' and NEW.status = 'closed' then
    ev := case when NEW.roll_group_id is not null and NEW.roll_group_id is distinct from OLD.roll_group_id then 'roll_close' else 'closed' end;
    occ := coalesce(NEW.close_date, current_date); qty := NEW.num_contracts; px := NEW.trade_price; cpx := NEW.close_price; fees := NEW.commission; rp := NEW.realized_pnl;
  elsif NEW.roll_group_id is not null and NEW.roll_group_id is distinct from OLD.roll_group_id then
    if NEW.rolled_from_position_id is not null and OLD.rolled_from_position_id is null then
      ev := 'roll_open'; occ := NEW.trade_date; qty := NEW.num_contracts; px := NEW.trade_price; fees := NEW.commission; rel := NEW.rolled_from_position_id;
      nt := 'already-recorded position linked as the new leg of a roll';
    else
      ev := 'roll_close'; occ := coalesce(NEW.close_date, current_date); qty := NEW.num_contracts; px := NEW.trade_price; cpx := NEW.close_price; fees := NEW.commission; rp := NEW.realized_pnl;
      nt := 'already-closed position linked as the closed leg of a roll';
    end if;
  elsif NEW.crop_year is distinct from OLD.crop_year then
    ev := 'crop_year_changed'; occ := current_date; qty := NEW.num_contracts; px := NEW.trade_price; fees := NEW.commission;
  else
    ev := 'edited'; occ := current_date; qty := NEW.num_contracts; px := NEW.trade_price; cpx := NEW.close_price; fees := NEW.commission; rp := NEW.realized_pnl;
    if OLD.status = 'open' and NEW.status = 'open' and NEW.num_contracts < OLD.num_contracts then
      nt := 'contracts reduced by a partial close';
    end if;
  end if;

  if gsrc is not null then
    src := gsrc; sdate := gdate; sref := gref;
  elsif NEW.import_statement_date is not null and NEW.import_statement_date is distinct from OLD.import_statement_date then
    src := 'statement_import'; sdate := NEW.import_statement_date; sref := NEW.import_statement_ref;
  else
    src := 'manual';
  end if;

  insert into public.hedge_position_events
    (org_id, position_id, related_position_id, roll_group_id, event_type, occurred_at, source,
     statement_date, statement_ref, actor_user_id, actor_email,
     entity_id, commodity, contract_month, contract_symbol, side, crop_year,
     quantity, price, close_price, fees, realized_pnl, before_snapshot, after_snapshot, note)
  values
    (NEW.org_id, NEW.id, coalesce(rel, NEW.partial_close_of), NEW.roll_group_id, ev, occ, src,
     sdate, sref, actor, actor_mail,
     NEW.entity_id, NEW.commodity, NEW.contract_month, NEW.contract_symbol, NEW.side, NEW.crop_year,
     qty, px, cpx, fees, rp, o, n, nt);
  return NEW;
end $$;

drop trigger if exists futures_positions_hedge_event on public.futures_positions;
create trigger futures_positions_hedge_event
  after insert or update or delete on public.futures_positions
  for each row execute function public.hedge_position_event_trigger();

-- 4. hedge_execute_roll — close + open + linkage in ONE transaction ------------
--
-- payload:
-- {
--   "source": "roll_action" | "statement_import",
--   "statement_date": "2026-09-03" | null, "statement_ref": "StoneX" | null,
--   "execution_code": "SE" | null,
--   "close": { ...one closed leg... } | [ { ...leg... }, ... ]
--                                        -- an offset group of several opening
--                                        -- lots rolls into ONE new leg: pass
--                                        -- every lot; the first is the lineage
--                                        -- anchor (rolled_from) and the crop
--                                        -- year / entity source.
--   a closed leg:
--   {
--     "position_id": uuid | null,        -- an existing position (open → closed
--                                        -- here; already closed → linked only)
--     "quantity": 14,                    -- contracts closing (< held = partial)
--     "close_price": 5.435, "close_date": "2026-09-03",
--     "realized_pnl": -33775.00,         -- GROSS for the closing quantity
--                                        -- (computed by the app's one P&L seam)
--     "fees": 0,                         -- close-side commission
--     "row": { ... }                     -- when position_id is null: the closed
--                                        -- lot's own facts (entity_id, commodity,
--                                        -- contract_month, contract_symbol,
--                                        -- crop_year, side, trade_price,
--                                        -- trade_date, notes)
--   },
--   "open": {
--     "position_id": uuid | null,        -- an already-recorded new leg → linked
--     "row": { "contract_month", "contract_symbol", "num_contracts",
--              "trade_price", "trade_date", "commission", "notes" }
--   }
-- }
-- The new leg ALWAYS inherits the closed leg's crop year and entity.

create or replace function public.hedge_execute_roll(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  gid uuid := gen_random_uuid();
  legs jsonb;
  c jsonb;
  o jsonb := payload -> 'open';
  crow jsonb;
  orow jsonb := coalesce(o -> 'row', '{}'::jsonb);
  src text := coalesce(nullif(payload ->> 'source', ''), 'roll_action');
  sdate date := nullif(payload ->> 'statement_date', '')::date;
  sref text := nullif(payload ->> 'statement_ref', '');
  ecode text := nullif(payload ->> 'execution_code', '');
  parent public.futures_positions;
  closed_id uuid;      -- the anchor: the first closed leg (lineage + inheritance source)
  leg_id uuid;
  opened_id uuid;
  inherit_year integer;
  inherit_entity uuid;
  close_qty integer;
  cprice numeric;
  cdate date;
  cfees numeric;
  crealized numeric;
  prorated numeric;
  row_source text;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if src not in ('roll_action', 'statement_import') then
    raise exception 'unknown roll source %', src;
  end if;
  if payload -> 'close' is null or o is null then
    raise exception 'roll payload needs both a close and an open leg';
  end if;
  legs := case when jsonb_typeof(payload -> 'close') = 'array' then payload -> 'close' else jsonb_build_array(payload -> 'close') end;
  if jsonb_array_length(legs) = 0 then
    raise exception 'roll payload needs at least one closed leg';
  end if;
  row_source := src; -- 'statement_import' | 'roll_action' — both allowed on futures_positions.source

  perform set_config('turnrow.hedge_event_source', src, true);
  perform set_config('turnrow.hedge_statement_date', coalesce(sdate::text, ''), true);
  perform set_config('turnrow.hedge_statement_ref', coalesce(sref, ''), true);

  -- Closed leg(s) -------------------------------------------------------------
  for c in select * from jsonb_array_elements(legs) loop
    crow := coalesce(c -> 'row', '{}'::jsonb);
    cprice := (c ->> 'close_price')::numeric;
    cdate := (c ->> 'close_date')::date;
    cfees := coalesce((c ->> 'fees')::numeric, 0);
    crealized := (c ->> 'realized_pnl')::numeric;
    leg_id := null;

    if nullif(c ->> 'position_id', '') is not null then
      select * into parent from public.futures_positions where id = (c ->> 'position_id')::uuid for update;
      if not found then
        raise exception 'the position being rolled was not found';
      end if;
      if closed_id is null then
        inherit_year := parent.crop_year;
        inherit_entity := parent.entity_id;
      end if;

      if parent.status = 'closed' then
        -- Already recorded as closed (e.g. closed by hand before the statement
        -- was re-imported): link it into the roll, nothing else changes.
        update public.futures_positions
           set roll_group_id = gid,
               import_statement_date = coalesce(import_statement_date, sdate),
               import_statement_ref = coalesce(import_statement_ref, sref)
         where id = parent.id;
        leg_id := parent.id;
      else
        if cprice is null or cdate is null or crealized is null then
          raise exception 'close price, close date and realized P&L are required';
        end if;
        close_qty := coalesce((c ->> 'quantity')::integer, parent.num_contracts);
        if close_qty <= 0 or close_qty > parent.num_contracts then
          raise exception 'cannot roll % of % contracts', close_qty, parent.num_contracts;
        end if;
        if close_qty = parent.num_contracts then
          update public.futures_positions
             set status = 'closed',
                 close_price = cprice,
                 close_date = cdate,
                 realized_pnl = crealized,
                 commission = round(coalesce(commission, 0) + cfees, 2),
                 roll_group_id = gid,
                 import_statement_date = coalesce(sdate, import_statement_date),
                 import_statement_ref = coalesce(sref, import_statement_ref)
           where id = parent.id;
          leg_id := parent.id;
        else
          -- Partial roll: spin the rolled lots off as their own closed row (the
          -- same shape the Close dialog's partial close writes), leave the rest open.
          prorated := round(coalesce(parent.commission, 0) * close_qty / parent.num_contracts, 2);
          insert into public.futures_positions
            (entity_id, commodity, contract_month, contract_symbol, crop_year, side, num_contracts,
             trade_price, trade_date, status, close_price, close_date, realized_pnl, commission, notes, source,
             roll_group_id, partial_close_of, execution_code, import_statement_date, import_statement_ref)
          values
            (parent.entity_id, parent.commodity, parent.contract_month, parent.contract_symbol, parent.crop_year, parent.side, close_qty,
             parent.trade_price, parent.trade_date, 'closed', cprice, cdate, crealized, round(prorated + cfees, 2), parent.notes, parent.source,
             gid, parent.id, parent.execution_code, sdate, sref)
          returning id into leg_id;
          update public.futures_positions
             set num_contracts = parent.num_contracts - close_qty,
                 commission = round(coalesce(parent.commission, 0) - prorated, 2)
           where id = parent.id;
        end if;
      end if;
    else
      -- No stored position for the closed leg (the statement is the first we
      -- hear of it): record the closed lot itself, linked.
      if cprice is null or cdate is null or crealized is null then
        raise exception 'close price, close date and realized P&L are required';
      end if;
      if closed_id is null then
        inherit_year := (crow ->> 'crop_year')::integer;
        inherit_entity := nullif(crow ->> 'entity_id', '')::uuid;
        if inherit_year is null then
          raise exception 'the closed leg needs a crop year';
        end if;
      end if;
      insert into public.futures_positions
        (entity_id, commodity, contract_month, contract_symbol, crop_year, side, num_contracts,
         trade_price, trade_date, status, close_price, close_date, realized_pnl, commission, notes, source,
         roll_group_id, execution_code, import_statement_date, import_statement_ref)
      values
        (coalesce(nullif(crow ->> 'entity_id', '')::uuid, inherit_entity), crow ->> 'commodity', crow ->> 'contract_month', crow ->> 'contract_symbol',
         coalesce((crow ->> 'crop_year')::integer, inherit_year), crow ->> 'side',
         coalesce((c ->> 'quantity')::integer, (crow ->> 'num_contracts')::integer),
         (crow ->> 'trade_price')::numeric, (crow ->> 'trade_date')::date, 'closed', cprice, cdate, crealized, cfees,
         nullif(crow ->> 'notes', ''), row_source,
         gid, nullif(crow ->> 'execution_code', ''), sdate, sref)
      returning id into leg_id;
    end if;

    if closed_id is null then closed_id := leg_id; end if;
  end loop;

  -- Open leg (inherits crop year + entity from the first closed leg) ---------
  if nullif(o ->> 'position_id', '') is not null then
    update public.futures_positions
       set rolled_from_position_id = closed_id,
           roll_group_id = gid,
           crop_year = inherit_year,
           entity_id = coalesce(entity_id, inherit_entity),
           execution_code = coalesce(ecode, execution_code),
           import_statement_date = coalesce(sdate, import_statement_date),
           import_statement_ref = coalesce(sref, import_statement_ref)
     where id = (o ->> 'position_id')::uuid
     returning id into opened_id;
    if opened_id is null then
      raise exception 'the new leg of the roll was not found';
    end if;
  else
    insert into public.futures_positions
      (entity_id, commodity, contract_month, contract_symbol, crop_year, side, num_contracts,
       trade_price, trade_date, status, commission, notes, source,
       rolled_from_position_id, roll_group_id, execution_code, import_statement_date, import_statement_ref)
    values
      (inherit_entity,
       coalesce(nullif(orow ->> 'commodity', ''), (select commodity from public.futures_positions where id = closed_id)),
       orow ->> 'contract_month', orow ->> 'contract_symbol', inherit_year,
       coalesce(nullif(orow ->> 'side', ''), (select side from public.futures_positions where id = closed_id)),
       (orow ->> 'num_contracts')::integer,
       (orow ->> 'trade_price')::numeric, (orow ->> 'trade_date')::date, 'open',
       coalesce((orow ->> 'commission')::numeric, 0), nullif(orow ->> 'notes', ''), row_source,
       closed_id, gid, ecode, sdate, sref)
    returning id into opened_id;
  end if;

  return jsonb_build_object('roll_group_id', gid, 'closed_position_id', closed_id, 'opened_position_id', opened_id);
end $$;

revoke all on function public.hedge_execute_roll(jsonb) from public, anon;
grant execute on function public.hedge_execute_roll(jsonb) to authenticated;

-- 5. Backfill the ledger from the positions that already exist -----------------
-- Idempotent: a position with any opening-class event is skipped; a closed
-- position with any closing-class event is skipped.

insert into public.hedge_position_events
  (org_id, position_id, related_position_id, roll_group_id, event_type, occurred_at, source,
   statement_date, statement_ref, entity_id, commodity, contract_month, contract_symbol, side, crop_year,
   quantity, price, fees, after_snapshot, note)
select p.org_id, p.id, coalesce(p.partial_close_of, p.rolled_from_position_id), p.roll_group_id,
       case when p.rolled_from_position_id is not null then 'roll_open' else 'opened' end,
       p.trade_date, 'backfill',
       p.import_statement_date, p.import_statement_ref, p.entity_id, p.commodity, p.contract_month, p.contract_symbol, p.side, p.crop_year,
       p.num_contracts, p.trade_price, case when p.status = 'open' then p.commission else null end,
       to_jsonb(p) - 'updated_at', 'backfilled from the position record (' || p.source || ')'
  from public.futures_positions p
 where not exists (
   select 1 from public.hedge_position_events e
    where e.position_id = p.id and e.event_type in ('opened', 'roll_open', 'imported', 'partial_close'));

insert into public.hedge_position_events
  (org_id, position_id, related_position_id, roll_group_id, event_type, occurred_at, source,
   statement_date, statement_ref, entity_id, commodity, contract_month, contract_symbol, side, crop_year,
   quantity, price, close_price, fees, realized_pnl, after_snapshot, note)
select p.org_id, p.id, coalesce(p.partial_close_of, p.rolled_from_position_id), p.roll_group_id,
       case when p.roll_group_id is not null
                  and exists (select 1 from public.futures_positions q where q.rolled_from_position_id = p.id)
            then 'roll_close' else 'closed' end,
       coalesce(p.close_date, p.trade_date), 'backfill',
       p.import_statement_date, p.import_statement_ref, p.entity_id, p.commodity, p.contract_month, p.contract_symbol, p.side, p.crop_year,
       p.num_contracts, p.trade_price, p.close_price, p.commission, p.realized_pnl,
       to_jsonb(p) - 'updated_at', 'backfilled from the position record (' || p.source || ')'
  from public.futures_positions p
 where p.status = 'closed'
   and not exists (
   select 1 from public.hedge_position_events e
    where e.position_id = p.id and e.event_type in ('closed', 'roll_close', 'imported', 'partial_close'));
