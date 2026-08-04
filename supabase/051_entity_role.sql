-- 051: Entity role — marketing agent vs farming entity.
-- Turnrow markets in its own name on behalf of the farming entities: the
-- contracts and hedge positions are held by the MARKETING AGENT, then the
-- income shifts down to the farming entities. In the reports' entity filter,
-- rows held by a marketing-agent entity therefore flow DOWN pro-rata to the
-- farming entities (by each entity's acre share of the contract's crop —
-- lib/entity-scope.ts attribution), exactly like rows with no entity at all.
-- A farming entity can also market in its OWN name (more common with multiple
-- customers) — those rows stay wholly its own.
-- Idempotent.

alter table public.entities
  add column if not exists entity_role text not null default 'farming';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'entities_entity_role_check') then
    alter table public.entities
      add constraint entities_entity_role_check check (entity_role in ('farming', 'marketing_agent'));
  end if;
end $$;

comment on column public.entities.entity_role is
  'farming (default) = operates farms, keeps its own-name marketing. marketing_agent = markets on behalf of the farming entities: its contracts/hedges flow down pro-rata by acre share in the entity-filtered reports (income shifted down).';
