-- 0104: which brokerage account holds a hedge (2026-11-10).
--
-- The statement import's reconciliation gate and its "possibly closed" step
-- used the hedge's ENTITY to decide whether a stored position belongs to the
-- account a statement covers. The entity is an attribution tag
-- (lib/entity-scope), not the brokerage account. On 10/31 the 10/30 StoneX
-- statement (account 490JP046) was imported with account entity "none"; the
-- NOV 26 soybean short (2 @ 12.035, tagged entity Turnrow) had been rolled to
-- JAN 27 on 10/29 — a statement never imported — and was no longer on the
-- statement. Because of its entity tag it was left out of BOTH checks, so the
-- import saved the JAN 27 leg as a plain new open and the app showed 4 short
-- soybeans against a statement showing 2. Nothing warned.
--
-- The statement prints its account number. This migration stores it on the
-- positions an import writes or matches, so the gate can tell "another
-- account" from "this account" by fact instead of by entity tag. A position
-- with no account recorded counts in every statement's check (unknown is
-- never proof that it lives elsewhere).
--
-- 1. futures_positions.broker_account / options_positions.broker_account.
-- 2. The ledger trigger ignores a broker_account-only update, so stamping the
--    account on already-recorded lots never adds history noise. The function
--    below is 0095's body with that one comparison changed.

alter table public.futures_positions add column if not exists broker_account text;
alter table public.options_positions add column if not exists broker_account text;

comment on column public.futures_positions.broker_account is
  'Brokerage account number as printed on the statement that recorded or matched this lot (e.g. 490JP046). Null = not known; counts in every statement''s reconciliation.';
comment on column public.options_positions.broker_account is
  'Brokerage account number as printed on the statement that recorded or matched this option. Null = not known.';

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
  -- 0104: the brokerage account a statement stamps on a lot is bookkeeping,
  -- not a hedge event — a broker_account-only update writes no ledger row.
  if (o - 'broker_account') = (n - 'broker_account') then
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
