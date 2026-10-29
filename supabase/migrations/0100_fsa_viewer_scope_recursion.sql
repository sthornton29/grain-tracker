-- 0100: break the viewer-scope policy cycle between fsa_payment_statements and
-- fsa_payment_lines (0099). The lines policy looked up statements, whose policy
-- looked up lines — Postgres refused every insert with "infinite recursion
-- detected in policy for relation fsa_payment_statements", for owners too.
-- Fix: one security-definer helper reads the statements a viewer may see
-- (paid to a granted entity, or carrying a line on a granted farm) without
-- RLS; both policies go through it. The helper is stable and search_path-pinned
-- like 052's viewer_farm_ids / viewer_entity_ids.

create or replace function public.viewer_fsa_statement_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.id from public.fsa_payment_statements s
  where s.payee_entity_id in (select public.viewer_entity_ids())
  union
  select l.statement_id from public.fsa_payment_lines l
  where l.farm_id in (select public.viewer_farm_ids())
$$;

drop policy if exists fsa_payment_lines_viewer_scope on public.fsa_payment_lines;
create policy fsa_payment_lines_viewer_scope on public.fsa_payment_lines as restrictive for select to authenticated
  using (public.app_role() <> 'viewer'
         or farm_id in (select public.viewer_farm_ids())
         or statement_id in (select public.viewer_fsa_statement_ids()));

drop policy if exists fsa_payment_statements_viewer_scope on public.fsa_payment_statements;
create policy fsa_payment_statements_viewer_scope on public.fsa_payment_statements as restrictive for select to authenticated
  using (public.app_role() <> 'viewer'
         or id in (select public.viewer_fsa_statement_ids()));
