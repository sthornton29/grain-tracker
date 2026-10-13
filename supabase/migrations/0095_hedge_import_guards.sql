-- 0095: statement-import guards for the hedge ledger (2026-10-13).
-- Applied with `npx supabase db push --linked` (supabase/migrations/).
--
-- The 10/12/2026 StoneX statement rolled 23 DEC 26 cotton shorts into MAR 27
-- as FIVE fills (3 @ 83.63, 12 @ 83.64, 3 @ 83.65, 3 @ 83.67, 2 @ 83.68).
-- hedge_execute_roll (083) took ONE open leg, so the roll opened only the
-- 12-lot and the other four fills were inserted as plain opens with no
-- lineage; the Purchase & Sale block, read with the offsetting buys as
-- "lots", showed 46 contracts to close. Three things change here:
--
--   * hedge_execute_roll accepts SEVERAL open legs (`open` may be an array,
--     or `opens`): every new-month fill of the roll links to the same roll
--     group with rolled_from = the anchor closed leg, so the effective-price
--     lineage (lib/hedge-lineage) weights all of them. One open leg still
--     works exactly as before. The result carries opened_position_ids.
--   * The ledger trigger reads one more transaction setting,
--     turnrow.hedge_event_note: the import's "Save anyway, I've checked"
--     override and the undo note land on every event the transaction writes.
--   * hedge_undo_import(statement_date, statement_ref, note) — ONE
--     transaction that reverses a statement import: deletes the positions it
--     created (the trigger logs 'deleted'), restores the positions it closed,
--     rolled or partially closed from the before_snapshot of their first
--     event in that import, and stamps every ledger row source 'manual' with
--     the note. It REFUSES, naming the positions, when any of them carries a
--     later event that is not part of that import (edited, closed, rolled
--     again by hand or by a later statement).
--
-- verify_migrations row 100 pins the three functions.

-- 1. Ledger trigger: the note setting ------------------------------------------

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
  gnote text := nullif(current_setting('turnrow.hedge_event_note', true), '');
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
       OLD.num_contracts, OLD.trade_price, OLD.close_price, OLD.commission, OLD.realized_pnl, o, null, gnote);
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
       qty, px, cpx, fees, rp, null, n, gnote);
    return NEW;
  end if;

  -- UPDATE
  o := to_jsonb(OLD) - 'updated_at';
  if o = n then
    return NEW; -- nothing changed: no event
  end if;

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
  if gnote is not null then
    nt := case when nt is null then gnote else nt || ' — ' || gnote end;
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

-- 2. hedge_execute_roll: several open legs ------------------------------------------
--
-- payload as in 083, plus: "open" may be an ARRAY of open legs (or "opens"),
-- each { position_id | row }. Every open leg links to the anchor closed leg.
-- "note" (optional) is stamped on every ledger row the roll writes.

create or replace function public.hedge_execute_roll(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  gid uuid := gen_random_uuid();
  legs jsonb;
  opens jsonb;
  c jsonb;
  o jsonb;
  crow jsonb;
  orow jsonb;
  src text := coalesce(nullif(payload ->> 'source', ''), 'roll_action');
  sdate date := nullif(payload ->> 'statement_date', '')::date;
  sref text := nullif(payload ->> 'statement_ref', '');
  ecode text := nullif(payload ->> 'execution_code', '');
  gnote text := nullif(payload ->> 'note', '');
  parent public.futures_positions;
  closed_id uuid;
  leg_id uuid;
  opened_id uuid;
  opened_ids uuid[] := '{}';
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
  opens := coalesce(payload -> 'opens', payload -> 'open');
  if payload -> 'close' is null or opens is null then
    raise exception 'roll payload needs both a close and an open leg';
  end if;
  legs := case when jsonb_typeof(payload -> 'close') = 'array' then payload -> 'close' else jsonb_build_array(payload -> 'close') end;
  opens := case when jsonb_typeof(opens) = 'array' then opens else jsonb_build_array(opens) end;
  if jsonb_array_length(legs) = 0 then
    raise exception 'roll payload needs at least one closed leg';
  end if;
  if jsonb_array_length(opens) = 0 then
    raise exception 'roll payload needs at least one open leg';
  end if;
  row_source := src;

  perform set_config('turnrow.hedge_event_source', src, true);
  perform set_config('turnrow.hedge_statement_date', coalesce(sdate::text, ''), true);
  perform set_config('turnrow.hedge_statement_ref', coalesce(sref, ''), true);
  perform set_config('turnrow.hedge_event_note', coalesce(gnote, ''), true);

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

  -- Open leg(s): each inherits crop year + entity from the anchor ----------------
  for o in select * from jsonb_array_elements(opens) loop
    orow := coalesce(o -> 'row', '{}'::jsonb);
    opened_id := null;
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
         and status = 'open'
       returning id into opened_id;
      if opened_id is null then
        raise exception 'the new leg of the roll was not found or is not open';
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
         closed_id, gid, coalesce(nullif(orow ->> 'execution_code', ''), ecode), sdate, sref)
      returning id into opened_id;
    end if;
    opened_ids := opened_ids || opened_id;
  end loop;

  return jsonb_build_object(
    'roll_group_id', gid,
    'closed_position_id', closed_id,
    'opened_position_id', opened_ids[1],
    'opened_position_ids', to_jsonb(opened_ids));
end $$;

revoke all on function public.hedge_execute_roll(jsonb) from public, anon;
grant execute on function public.hedge_execute_roll(jsonb) to authenticated;

-- 3. hedge_undo_import ------------------------------------------------------------------
--
-- Reverses everything ONE statement import wrote, in one transaction:
--   created positions (first ledger event in this import is an insert-class
--   event: opened / imported / roll_open / partial_close with no before
--   snapshot) → deleted;
--   touched positions (first event in this import carries a before_snapshot:
--   roll_close / closed / edited / crop_year_changed) → restored to that
--   before_snapshot;
-- and refuses when any of those positions has a LATER event outside this
-- import (edited by hand, closed, rolled again, a later statement).
-- Runs as the caller (RLS applies); the caller must be signed in.

create or replace function public.hedge_undo_import(p_statement_date date, p_statement_ref text, p_note text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_first timestamptz;
  v_last timestamptz;
  r record;
  snap jsonb;
  blockers text[] := '{}';
  created_ids uuid[] := '{}';
  touched_ids uuid[] := '{}';
  n_deleted integer := 0;
  n_restored integer := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if p_statement_date is null then
    raise exception 'a statement date is required';
  end if;

  select min(recorded_at), max(recorded_at) into v_first, v_last
    from public.hedge_position_events e
   where e.org_id = v_org and e.source = 'statement_import'
     and e.statement_date = p_statement_date
     and coalesce(e.statement_ref, '') = coalesce(p_statement_ref, '');
  if v_first is null then
    raise exception 'no import found for that statement';
  end if;

  -- The first event of this import per position decides created vs touched.
  for r in
    select distinct on (e.position_id) e.position_id, e.event_type, e.before_snapshot
      from public.hedge_position_events e
     where e.org_id = v_org and e.source = 'statement_import'
       and e.statement_date = p_statement_date
       and coalesce(e.statement_ref, '') = coalesce(p_statement_ref, '')
     order by e.position_id, e.recorded_at, e.id
  loop
    if r.before_snapshot is null and r.event_type in ('opened', 'imported', 'roll_open', 'partial_close') then
      created_ids := created_ids || r.position_id;
    elsif r.before_snapshot is not null then
      touched_ids := touched_ids || r.position_id;
    end if;
  end loop;

  -- Anything that moved after the import, outside the import, blocks the undo.
  for r in
    select p.id, p.commodity, p.contract_month, p.side, p.num_contracts, p.status
      from public.futures_positions p
     where p.id = any(created_ids || touched_ids)
       and exists (
         select 1 from public.hedge_position_events e2
          where e2.position_id = p.id
            and e2.recorded_at > v_last
            and not (e2.source = 'statement_import'
                     and e2.statement_date = p_statement_date
                     and coalesce(e2.statement_ref, '') = coalesce(p_statement_ref, '')))
  loop
    blockers := blockers || format('%s %s %s %s (%s)', r.side, r.num_contracts, r.contract_month, r.commodity, r.status);
  end loop;
  if array_length(blockers, 1) > 0 then
    raise exception 'these positions changed after the import, so it cannot be undone: %', array_to_string(blockers, '; ')
      using errcode = 'check_violation';
  end if;

  perform set_config('turnrow.hedge_event_source', 'manual', true);
  perform set_config('turnrow.hedge_statement_date', coalesce(p_statement_date::text, ''), true);
  perform set_config('turnrow.hedge_statement_ref', coalesce(p_statement_ref, ''), true);
  perform set_config('turnrow.hedge_event_note', coalesce(p_note, 'undid import of ' || coalesce(p_statement_ref, 'statement') || ' ' || to_char(p_statement_date, 'FMMM/FMDD/YYYY')), true);

  -- Restore touched positions from the before_snapshot of their FIRST event in the import.
  for r in
    select distinct on (e.position_id) e.position_id, e.before_snapshot
      from public.hedge_position_events e
     where e.position_id = any(touched_ids)
       and e.org_id = v_org and e.source = 'statement_import'
       and e.statement_date = p_statement_date
       and coalesce(e.statement_ref, '') = coalesce(p_statement_ref, '')
       and e.before_snapshot is not null
     order by e.position_id, e.recorded_at, e.id
  loop
    snap := r.before_snapshot;
    update public.futures_positions p
       set entity_id = nullif(snap ->> 'entity_id', '')::uuid,
           commodity = snap ->> 'commodity',
           contract_month = snap ->> 'contract_month',
           contract_symbol = snap ->> 'contract_symbol',
           crop_year = (snap ->> 'crop_year')::integer,
           side = snap ->> 'side',
           num_contracts = (snap ->> 'num_contracts')::integer,
           trade_price = (snap ->> 'trade_price')::numeric,
           trade_date = (snap ->> 'trade_date')::date,
           status = snap ->> 'status',
           close_price = nullif(snap ->> 'close_price', '')::numeric,
           close_date = nullif(snap ->> 'close_date', '')::date,
           realized_pnl = nullif(snap ->> 'realized_pnl', '')::numeric,
           commission = coalesce(nullif(snap ->> 'commission', '')::numeric, 0),
           notes = snap ->> 'notes',
           source = snap ->> 'source',
           roll_group_id = nullif(snap ->> 'roll_group_id', '')::uuid,
           rolled_from_position_id = nullif(snap ->> 'rolled_from_position_id', '')::uuid,
           execution_code = snap ->> 'execution_code',
           partial_close_of = nullif(snap ->> 'partial_close_of', '')::uuid,
           import_statement_date = nullif(snap ->> 'import_statement_date', '')::date,
           import_statement_ref = snap ->> 'import_statement_ref'
     where p.id = r.position_id;
    if found then n_restored := n_restored + 1; end if;
  end loop;

  -- Delete what the import created (children before parents: rolled/partial rows first).
  delete from public.futures_positions p
   where p.id = any(created_ids) and (p.rolled_from_position_id is not null or p.partial_close_of is not null);
  get diagnostics n_deleted = row_count;
  delete from public.futures_positions p where p.id = any(created_ids);
  n_deleted := n_deleted + (select count(*) from unnest(created_ids))::integer - n_deleted;

  return jsonb_build_object('deleted', (select count(*) from unnest(created_ids)), 'restored', n_restored);
end $$;

revoke all on function public.hedge_undo_import(date, text, text) from public, anon;
grant execute on function public.hedge_undo_import(date, text, text) to authenticated;
