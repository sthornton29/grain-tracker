-- 055: Beta onboarding — super-admin org management + per-org partner tokens.
-- REQUIRES 054. Idempotent.
--
-- Beta-appropriate: manual, no self-serve signup, no billing.
--   * super_admins — the platform operator's user(s); seeded with
--     stuart@turnrow.farm. The /admin page and the admin_* RPCs are guarded
--     by is_super_admin(); everyone else sees nothing (route guard + RLS +
--     RPC guards).
--   * admin_list_orgs() — org METADATA only (name, member/entity/load
--     counts, latest activity). There is deliberately NO cross-org record
--     browsing and NO "support access" — not built, by choice.
--   * admin_create_org(name) — creates the org (slug from the name) and
--     seeds it (standard four crops + its own app_settings row, cotton off).
--   * admin_create_partner_token(org, label) — mints a per-org partner API
--     bearer token, returned ONCE in plaintext; only the sha256 is stored
--     (partner_api_tokens, 054). Needs pgcrypto (gen_random_bytes/digest —
--     enabled by default on Supabase).
--   * Invites happen in the app (/api/admin/invite → Supabase
--     auth.admin.inviteUserByEmail; the invite link lands on the existing
--     /reset-password set-a-password page). No SQL here — the service role
--     assigns profile/org/grants in that route.

-- 1. Super admins -------------------------------------------------------------

create table if not exists public.super_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.super_admins enable row level security;

do $$
begin
  -- A user may see only whether THEY are a super admin (the middleware and
  -- the /admin page check this). No client writes at all — rows are seeded
  -- here, by hand.
  if not exists (select 1 from pg_policies where tablename = 'super_admins' and policyname = 'super_admins_own_read') then
    create policy super_admins_own_read on public.super_admins for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

insert into public.super_admins (user_id)
select id from auth.users where lower(email) = 'stuart@turnrow.farm'
on conflict (user_id) do nothing;

create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from public.super_admins where user_id = auth.uid())
$$;

-- 2. Admin RPCs ---------------------------------------------------------------

-- Org metadata for the /admin list. Counts only — never record contents.
create or replace function public.admin_list_orgs()
returns table (
  id uuid, name text, slug text, created_at timestamptz,
  user_count bigint, entity_count bigint, load_count bigint,
  cotton_enabled boolean, last_activity timestamptz
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug, o.created_at,
    (select count(*) from public.organization_members m where m.org_id = o.id),
    (select count(*) from public.entities e where e.org_id = o.id),
    (select count(*) from public.loads l where l.org_id = o.id),
    coalesce((select s.cotton_module_enabled from public.app_settings s where s.org_id = o.id limit 1), false),
    greatest(
      (select max(l.created_at) from public.loads l where l.org_id = o.id),
      (select max(m.created_at) from public.organization_members m where m.org_id = o.id)
    )
  from public.organizations o
  where public.is_super_admin()
  order by o.created_at
$$;

-- Create an org + seed its defaults (crops + settings row, cotton OFF).
create or replace function public.admin_create_org(org_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_org uuid; base_slug text; final_slug text; n int := 0;
begin
  if not public.is_super_admin() then raise exception 'not allowed'; end if;
  if coalesce(trim(org_name), '') = '' then raise exception 'organization name required'; end if;
  base_slug := trim(both '-' from regexp_replace(lower(trim(org_name)), '[^a-z0-9]+', '-', 'g'));
  if base_slug = '' then raise exception 'organization name needs letters or digits'; end if;
  final_slug := base_slug;
  while exists (select 1 from public.organizations where slug = final_slug) loop
    n := n + 1;
    final_slug := base_slug || '-' || n;
  end loop;
  insert into public.organizations (name, slug) values (trim(org_name), final_slug)
  returning id into new_org;
  -- Inline seeding (seed_org_defaults guards on app_role(); super admin may
  -- not be an owner of THIS new org, so seed directly here).
  insert into public.crops (name, base_moisture_pct, base_lb_per_bushel, org_id) values
    ('Corn',          15.5, 56.0, new_org),
    ('Soybean',       13.0, 60.0, new_org),
    ('Wheat',         13.5, 60.0, new_org),
    ('Grain Sorghum', 14.0, 56.0, new_org)
  on conflict do nothing;
  insert into public.app_settings (id, org_id, cotton_module_enabled)
  select coalesce(max(id), 0) + 1, new_org, false from public.app_settings
  on conflict do nothing;
  return new_org;
end $$;

-- Mint a per-org partner API token. Returns the PLAINTEXT ONCE — only the
-- sha256 is stored. Copy it out of the result; it cannot be recovered.
create or replace function public.admin_create_partner_token(target_org uuid, token_label text default null)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare tok text;
begin
  if not public.is_super_admin() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.organizations where id = target_org) then raise exception 'no such organization'; end if;
  tok := 'ptk_' || encode(gen_random_bytes(24), 'hex');
  insert into public.partner_api_tokens (org_id, token_sha256, label)
  values (target_org, encode(digest(tok, 'sha256'), 'hex'), token_label);
  return tok;
end $$;

revoke execute on function public.admin_list_orgs() from public, anon;
revoke execute on function public.admin_create_org(text) from public, anon;
revoke execute on function public.admin_create_partner_token(uuid, text) from public, anon;
grant execute on function public.admin_list_orgs() to authenticated;
grant execute on function public.admin_create_org(text) to authenticated;
grant execute on function public.admin_create_partner_token(uuid, text) to authenticated;

-- 3. Role blocks on the new table (042/052 maintenance rule) ------------------

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'super_admins' and policyname = 'super_admins_viewer_block_ins') then
    create policy super_admins_viewer_block_ins on public.super_admins as restrictive for insert to authenticated with check (public.app_role() <> 'viewer');
    create policy super_admins_viewer_block_upd on public.super_admins as restrictive for update to authenticated using (public.app_role() <> 'viewer');
    create policy super_admins_viewer_block_del on public.super_admins as restrictive for delete to authenticated using (public.app_role() <> 'viewer');
  end if;
end $$;
