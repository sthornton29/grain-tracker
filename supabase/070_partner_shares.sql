-- 070 — Landowner partner shares.
--
-- A farmer creates a share for one of their landowners and hands them a
-- one-time code. The landowner's software (Turnrow Landowner) redeems the
-- code at POST /api/partner/v1/shares/redeem, which mints a bearer token
-- scoped to that landowner's farms. Scope: fields/plantings/harvest always;
-- yields (the /production endpoint) only when include_yields is on.
--
-- Secrets at rest: both the one-time code and the minted bearer token are
-- stored as sha256 hex only (same posture as partner_api_tokens, 054).
-- Redemption runs with the service role (bypasses RLS); the farmer-facing
-- /settings/shares page reads and writes through the org-scoped policy.

create table if not exists public.partner_shares (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  landowner_id uuid not null references public.landowners(id) on delete cascade,
  label text,
  include_yields boolean not null default true,
  -- sha256 hex of the one-time share code; plaintext shown to the farmer once.
  share_code_sha256 text not null unique,
  code_expires_at timestamptz not null default now() + interval '7 days',
  redeemed_at timestamptz,
  -- sha256 hex of the bearer token minted at redemption; plaintext returned
  -- to the redeeming client once, never stored.
  token_sha256 text unique,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists partner_shares_org_idx on public.partner_shares (org_id);
create index if not exists partner_shares_landowner_idx on public.partner_shares (landowner_id);

alter table public.partner_shares enable row level security;

-- Org members manage their own org's shares (the same shape 054 applies to
-- tenant tables); the service role bypasses RLS for redemption and token
-- resolution in lib/partner-api-server.ts.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'partner_shares' and policyname = 'partner_shares_org'
  ) then
    create policy partner_shares_org on public.partner_shares
      for all to authenticated
      using (org_id = public.current_org_id())
      with check (org_id = public.current_org_id());
  end if;
end $$;
