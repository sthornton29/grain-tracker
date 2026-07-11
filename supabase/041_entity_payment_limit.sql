-- 041: Payment-limit configuration moves to the entity.
-- Eligible persons is a property of the ENTITY's structure (members/persons
-- who qualify for FSA payment limits) — set once, edited only when the
-- structure changes, never re-entered annually. The per-person $ cap remains
-- a per-program-year statutory value (program_year_config.per_person_payment_
-- limit). Total limit = entities.payment_limit_persons × that year's
-- per-person limit. payment_limit_config is DEPRECATED: kept for history,
-- no longer read or written by the app.
-- Idempotent.

alter table public.entities
  add column if not exists payment_limit_persons integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'entities_payment_limit_persons_check') then
    alter table public.entities
      add constraint entities_payment_limit_persons_check check (payment_limit_persons >= 1);
  end if;
end $$;

-- Backfill from the most recent payment_limit_config row per entity, only
-- for entities still at the default (safe to re-run).
update public.entities e
set payment_limit_persons = greatest(1, plc.eligible_persons)
from (
  select distinct on (entity_id) entity_id, eligible_persons
  from public.payment_limit_config
  order by entity_id, crop_year desc
) plc
where plc.entity_id = e.id
  and e.payment_limit_persons = 1;

comment on column public.entities.payment_limit_persons is
  'Eligible persons for FSA payment limits — total ARC/PLC limit = this × the program year''s per-person limit (program_year_config). Entity-level: set once, edit on structure changes.';
comment on table public.payment_limit_config is
  'DEPRECATED (041): eligible persons moved to entities.payment_limit_persons; the per-person limit lives in program_year_config. Not read by the app.';
