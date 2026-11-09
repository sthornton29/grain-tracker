-- 0103: the ops actions log (2026-11-09).
-- Applied with `npx supabase db push --linked` (supabase/migrations/, like 0093 to 0102).
--
-- The write half of the shared ops API (turnrow-farm docs/OPS_ACTIONS.md): an
-- Assignment in Turnrow Farm previews a fix through Grain's actions
-- (lib/ops/actions.ts), a person confirms it in Farm, and Farm calls
-- POST /api/ops/actions/apply with the write token. Every apply (applied,
-- stale, refused or failed) leaves ONE row here: the idempotency key (Farm's
-- proposal id), the action and its normalized params, the preview's
-- fingerprint, who approved it, the outcome and what was written or why not.
-- A key already applied is answered from its row (replay) and changes nothing.
--
-- Written only by the server (service role, scoped to OPS_ORG). Owners may
-- read it; no client write path exists (the ctp_settings pattern of 0102).

create table if not exists public.ops_action_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  key text not null check (char_length(key) between 1 and 200),
  action text not null,
  params jsonb not null default '{}'::jsonb,
  fingerprint text,
  approved_by text,
  outcome text not null check (outcome in ('applied', 'stale', 'refused', 'failed')),
  result jsonb,
  error text,
  created_at timestamptz not null default now()
);
-- One APPLIED row per key: a stale, refused or failed key may be tried again.
create unique index if not exists ops_action_log_applied_key on public.ops_action_log (org_id, key) where outcome = 'applied';
create index if not exists ops_action_log_org_created_idx on public.ops_action_log (org_id, created_at desc);
comment on table public.ops_action_log is
  '0103: one row per ops action apply call from Turnrow Farm (docs/OPS_ACTIONS.md): key (Farm''s proposal id; one applied row per key), action, params, fingerprint, approved_by, outcome applied / stale / refused / failed, result or error. Written by the server only.';

alter table public.ops_action_log enable row level security;
revoke all on public.ops_action_log from anon, authenticated;
grant select on public.ops_action_log to authenticated;

do $$
declare t text := 'ops_action_log';
begin
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_select') then
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
  end if;
  -- 053/054: org isolation on every verb.
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
  end if;
  -- Owners only: the gin role, viewers and the agronomist never read it.
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (auth.uid() is not null and public.app_role() = ''owner'') with check (auth.uid() is not null and public.app_role() = ''owner'')', t || '_owner_only', t);
  end if;
end $$;

notify pgrst, 'reload schema';
