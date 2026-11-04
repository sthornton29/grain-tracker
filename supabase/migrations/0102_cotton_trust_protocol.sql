-- 0102: U.S. Cotton Trust Protocol bale registration (2026-11-04).
-- Applied with `npx supabase db push --linked` (supabase/migrations/, like 0093 to 0101).
--
-- The Trust Protocol's 2026 bale upload is live through The Seam's Partners
-- API (https://api.trustuscotton.org — X-API-KEY header; Tara Luckman's
-- "2026 U.S. Regen bale upload now live" email of 2026-10-28 with the
-- "Bale Upload (Registration) Format" and "Tutorial" PDFs). A Field Partner
-- registers each bale as producer Protocol ID + 5-digit USDA gin code +
-- 7-digit gin tag + crop year + weight (< 1,000 lb), optionally stamped with
-- the Regen program code. Turnrow already holds every bale (cotton_bales:
-- PBI + net weight, under a gin receipt that knows its gin code); the three
-- facts it lacked are stored here:
--
-- 1. entities.ctp_protocol_id — the producer's 8-character Protocol ID (an
--    entity IS the producer the Protocol enrolled).
-- 2. ctp_settings — one row per organization: the member's API key (server-
--    only: column privileges keep it off every client read; the app's own
--    server routes read it with the service role), a hint for the screen
--    (the last four characters) and the Regen program code.
-- 3. ctp_bale_uploads (one row per API call: register / correction) and
--    ctp_bale_registrations (ONE row per bale — what was sent, and what the
--    Protocol's bale inquiry says about it now). lib/ctp-bales.ts is the one
--    place a bale becomes a registration row; app/api/ctp/* makes the calls.
--
-- Policy stack (the 0101 template): permissive authed-all; RESTRICTIVE 053/054
-- org isolation; owner-only on every verb — the gin role, viewers (052) and the
-- agronomist (061) never read or write a registration (it is the producer's
-- program, and the key is a credential). ctp_settings additionally has NO
-- client write path at all: every write goes through /api/ctp/settings with
-- the service role. Added to the tenant arrays in 053/054 and verify_053/054.

-- 1. The producer's Protocol ID -------------------------------------------------

alter table public.entities
  add column if not exists ctp_protocol_id text
    check (ctp_protocol_id is null or ctp_protocol_id ~ '^[A-Za-z0-9]{8}$');
comment on column public.entities.ctp_protocol_id is
  '0102: the U.S. Cotton Trust Protocol producer ID (8 characters) this entity enrolled under. Null = not enrolled / not entered.';

-- 2. ctp_settings -------------------------------------------------------------------

create table if not exists public.ctp_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  -- The member's X-API-KEY. Never selectable by a client role (see the
  -- column privileges below); read by the server routes only.
  api_key text,
  -- The last four characters, for "a key ending in ••••1234 is saved".
  api_key_hint text,
  -- The Field Partner's Regen program code (up to 10 characters), stamped on
  -- every bale sent with the Regen option on.
  regen_program text check (regen_program is null or char_length(regen_program) between 1 and 10),
  updated_at timestamptz not null default now()
);
comment on table public.ctp_settings is
  '0102: one row per organization — the U.S. Cotton Trust Protocol API key (server-only column) and the Regen program code. Written only by /api/ctp/settings.';

drop trigger if exists ctp_settings_set_updated_at on public.ctp_settings;
create trigger ctp_settings_set_updated_at
  before update on public.ctp_settings
  for each row execute function public.set_updated_at();

alter table public.ctp_settings enable row level security;

-- The key itself is never readable from a client: table-level select comes
-- off every client role and goes back column by column without api_key.
-- (The service role keeps its full grant — it bypasses both.)
revoke all on public.ctp_settings from anon, authenticated;
grant select (org_id, api_key_hint, regen_program, updated_at) on public.ctp_settings to authenticated;

-- 3. ctp_bale_uploads ---------------------------------------------------------------

create table if not exists public.ctp_bale_uploads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  crop_year integer not null check (crop_year between 2000 and 2100),
  -- register = baleUpload; correct / remove = baleCorrection (C / R).
  action text not null check (action in ('register', 'correct', 'remove')),
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  bale_count integer not null default 0,
  regen_program text,
  -- The Protocol's answer: its upload id (0 = no record created), the error
  -- flag and message, and the bale count it accepted for processing.
  http_status integer,
  ctp_upload_id integer,
  ctp_bale_count integer,
  has_errors boolean,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ctp_bale_uploads_org_year_idx on public.ctp_bale_uploads (org_id, crop_year, uploaded_at desc);
comment on table public.ctp_bale_uploads is
  '0102: one row per call to the Trust Protocol bale API (register or correction): what was sent and what came back. The per-bale state lives in ctp_bale_registrations.';

alter table public.ctp_bale_uploads enable row level security;

-- 4. ctp_bale_registrations ---------------------------------------------------------

create table if not exists public.ctp_bale_registrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  bale_id uuid not null references public.cotton_bales(id) on delete cascade,
  upload_id uuid references public.ctp_bale_uploads(id) on delete set null,
  crop_year integer not null check (crop_year between 2000 and 2100),
  -- What Turnrow sent (register / correct / remove), or 'inquiry' when the
  -- row exists only because a status check found the bale already registered
  -- (by the gin or a merchant).
  action text not null check (action in ('register', 'correct', 'remove', 'inquiry')),
  gin_code text not null check (gin_code ~ '^[0-9]{5}$'),
  gin_tag text not null check (gin_tag ~ '^[0-9]{7}$'),
  protocol_id text,
  weight integer check (weight is null or (weight between 1 and 999)),
  regen_program text,
  sent_at timestamptz,
  -- The Protocol's view of the bale from the last inquiry.
  registration_status text,
  shipment_status text,
  ctp_weight integer,
  ctp_protocol_id text,
  ctp_regen_program text,
  ctp_upload_date timestamptz,
  inquiry_error text,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, bale_id)
);
create index if not exists ctp_bale_registrations_org_year_idx on public.ctp_bale_registrations (org_id, crop_year);
create index if not exists ctp_bale_registrations_upload_idx on public.ctp_bale_registrations (upload_id);
comment on table public.ctp_bale_registrations is
  '0102: ONE row per bale sent to (or found registered with) the U.S. Cotton Trust Protocol: the gin code / gin tag / producer ID / weight / Regen program as sent, and the registration status the Protocol last reported.';

drop trigger if exists ctp_bale_registrations_set_updated_at on public.ctp_bale_registrations;
create trigger ctp_bale_registrations_set_updated_at
  before update on public.ctp_bale_registrations
  for each row execute function public.set_updated_at();

alter table public.ctp_bale_registrations enable row level security;

-- 5. Policies -----------------------------------------------------------------------

-- ctp_settings: READ-ONLY for clients (the hint + program code columns), own
-- org, owners only. No insert / update / delete policy exists on purpose —
-- the server routes write with the service role.
do $$
declare t text := 'ctp_settings';
begin
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_select') then
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
  end if;
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
  end if;
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (auth.uid() is not null and public.app_role() = ''owner'') with check (auth.uid() is not null and public.app_role() = ''owner'')', t || '_owner_only', t);
  end if;
end $$;

-- The two bale tables: owners read them on the Trust Protocol page; writes
-- come from the server routes (service role), but an owner session may also
-- write (the stack allows it) so a future client path needs no migration.
do $$
declare t text;
begin
  foreach t in array array['ctp_bale_uploads', 'ctp_bale_registrations'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_all') then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_all', t);
    end if;
    -- 053/054: org isolation on every verb.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042/052/061 in one: the producer's program — owners only. The gin role,
    -- viewers and the agronomist neither read nor write.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (auth.uid() is not null and public.app_role() = ''owner'') with check (auth.uid() is not null and public.app_role() = ''owner'')', t || '_owner_only', t);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
