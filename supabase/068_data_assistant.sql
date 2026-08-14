-- 068: "Ask Turnrow" data assistant — the read-only query seam + rate-limit
-- log. Idempotent: safe to re-run.
--
-- THE ISOLATION GUARANTEE IS POSTGRES RLS, NOT PROMPT LANGUAGE. The
-- assistant's /api/data-assistant route runs every data access through the
-- USER'S OWN session (their JWT), never the service role:
--   * curated tools call the report engines with the session client — every
--     select goes through PostgREST as `authenticated`, so the 054 org
--     isolation and the 042/052/061 role policies apply row by row;
--   * the long-tail query tool calls assistant_query() below — SECURITY
--     INVOKER, so the dynamic SQL ALSO executes as the calling user with
--     their JWT claims, and RLS filters exactly as it would in the app.
-- A prompt-injected or model-invented query can therefore never see another
-- org's rows or rows the user's role hides: the database refuses, not the
-- prompt.
--
-- assistant_query defense layers (belt and braces; the route ALSO validates
-- in JS before calling — lib/assistant-sql.ts):
--   1. single-statement SELECT/WITH only (semicolons rejected, first keyword
--      checked here AND in JS);
--   2. write keywords rejected as whole words (blocks data-modifying CTEs —
--      `with x as (insert …) select` — plus SELECT INTO and FOR UPDATE);
--   3. `set local transaction_read_only = on` — any write that slips past
--      the lexical checks errors at execution;
--   4. `set local statement_timeout` (~5s) bounds runaway queries;
--   5. results wrapped in a subselect with LIMIT 500 — a row cap, not a page.

-- 1. The guarded read-only query RPC ------------------------------------------

create or replace function public.assistant_query(q text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  trimmed text := ltrim(q);
  lowered text := lower(trimmed);
  result jsonb;
begin
  -- Single statement only: no semicolons anywhere (a trailing one is the
  -- model being tidy — strip it rather than fail).
  trimmed := regexp_replace(trimmed, ';\s*$', '');
  lowered := lower(trimmed);
  if position(';' in trimmed) > 0 then
    raise exception 'assistant_query: one SELECT statement only';
  end if;
  if lowered !~ '^(select|with)\M' then
    raise exception 'assistant_query: only SELECT queries are allowed';
  end if;
  -- Whole-word write/DDL/lock keywords (catches data-modifying CTEs).
  if lowered ~ '\m(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|copy|vacuum|analyze|comment|refresh|listen|notify|lock|call|do|into)\M'
     or lowered ~ '\mfor\s+(update|share|no\s+key\s+update|key\s+share)\M' then
    raise exception 'assistant_query: read-only — that keyword is not allowed';
  end if;

  -- Hard guarantees regardless of the lexical checks above.
  set local transaction_read_only = on;
  set local statement_timeout = '5000';

  execute format(
    'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) from (%s limit 500) t',
    trimmed
  ) into result;
  return result;
end $$;

-- Session required: assistant_query runs as the CALLER (security invoker),
-- so anon gets nothing useful — but revoke anyway per the 052 standing rule.
revoke execute on function public.assistant_query(text) from public, anon;
grant execute on function public.assistant_query(text) to authenticated;

-- 2. Rate-limit log -----------------------------------------------------------

-- One row per user message to the assistant; the route counts the last hour
-- through the SESSION client (own-row RLS) before answering. Tenant table
-- per 053/054 conventions; also added to the tenant arrays + verify scripts.
create table if not exists public.assistant_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  user_id uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists assistant_usage_user_time_idx on public.assistant_usage (user_id, created_at);
create index if not exists assistant_usage_org_idx on public.assistant_usage (org_id);

alter table public.assistant_usage enable row level security;

do $$
begin
  -- Own rows only — read and insert; never update/delete (it's a log).
  if not exists (select 1 from pg_policies where tablename = 'assistant_usage' and policyname = 'assistant_usage_own_select') then
    create policy assistant_usage_own_select on public.assistant_usage for select to authenticated
      using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'assistant_usage' and policyname = 'assistant_usage_own_insert') then
    create policy assistant_usage_own_insert on public.assistant_usage for insert to authenticated
      with check (user_id = auth.uid());
  end if;

  -- 054 org isolation.
  if not exists (select 1 from pg_policies where tablename = 'assistant_usage' and policyname = 'assistant_usage_org_isolation') then
    create policy assistant_usage_org_isolation on public.assistant_usage as restrictive for all to authenticated
      using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());
  end if;
end $$;
