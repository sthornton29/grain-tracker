-- 084: Ask Turnrow usage log — WHICH tool answered each question, and the
-- turns where a data question got no tool call at all, so coverage gaps
-- surface in usage rather than in screenshots. Idempotent.
--
-- assistant_usage (068) already holds one row per user message (the rate
-- limit). It gains the answer details, filled in by the route at the end of
-- the turn (own-row UPDATE policy added — still no delete: it is a log).
-- admin_assistant_log() lets the platform super-admin read the recent log
-- across orgs (metadata about the assistant, never farm records).

alter table public.assistant_usage
  add column if not exists role text,
  add column if not exists question text,                       -- first 500 chars of the user's message
  add column if not exists tools_used text[] not null default '{}',
  add column if not exists data_question boolean,               -- heuristic: looked like a question about their data
  add column if not exists no_tool_on_data_question boolean not null default false,
  add column if not exists redirect_retry boolean not null default false, -- the never-redirect guard had to re-ask
  add column if not exists answer_chars integer,
  add column if not exists error text,
  add column if not exists answered_at timestamptz;

create index if not exists assistant_usage_gap_idx
  on public.assistant_usage (created_at desc) where no_tool_on_data_question;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'assistant_usage' and policyname = 'assistant_usage_own_update') then
    create policy assistant_usage_own_update on public.assistant_usage for update to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- Super-admin read of the recent log (055 pattern: security definer, gated
-- by is_super_admin, and auth.uid() must be present).
create or replace function public.admin_assistant_log(max_rows integer default 200)
returns table (
  id uuid, created_at timestamptz, answered_at timestamptz, org_name text, user_email text, role text,
  question text, tools_used text[], data_question boolean, no_tool_on_data_question boolean,
  redirect_retry boolean, answer_chars integer, error text
)
language sql stable security definer set search_path = public as $$
  select u.id, u.created_at, u.answered_at, o.name, au.email::text, u.role,
         u.question, u.tools_used, u.data_question, u.no_tool_on_data_question,
         u.redirect_retry, u.answer_chars, u.error
    from public.assistant_usage u
    left join public.organizations o on o.id = u.org_id
    left join auth.users au on au.id = u.user_id
   where public.is_super_admin()
   order by u.created_at desc
   limit greatest(1, least(coalesce(max_rows, 200), 1000))
$$;

revoke all on function public.admin_assistant_log(integer) from public, anon;
grant execute on function public.admin_assistant_log(integer) to authenticated;
